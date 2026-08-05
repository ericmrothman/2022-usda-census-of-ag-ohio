#!/usr/bin/env python3
"""
Parse the USDA 2022 Census of Agriculture fixed-width report
(Ohio, Volume 1 - Geographic Area Series, Part 35, AC-22-A-35) into tidy CSV.

The report has two chapters:
  Chapter 1  state-level tables  (Ohio totals broken out by class/size/etc.)
  Chapter 2  county-level tables (88 counties plus an "Ohio" total)

Each table is printed as a run of fixed-width "panels" delimited by rule lines
of dashes.  The last line of a panel's header block carries the column labels,
and the byte offsets of its ':' characters define the field boundaries for
every data row in that panel -- so nothing here hard-codes a column width.

Two panel layouts occur, distinguished by the header's stub (top-left) cell:

  "Item"             rows are measures, columns are geographies (or classes)
  "Geographic area"  rows are geographies, columns are measures

Both are transposed into one shape: (geo, metric, unit, year) -> value.

Outputs (in data/):
  county_long.csv          geo x metric x year, chapter 2
  state_history.csv        Ohio time series 1992-2022, chapter 1 table 1
  state_breakdown.csv      Ohio totals by class, remaining chapter 1 tables
  counties.json            canonical county list
  metrics.json             metric catalogue with coverage counts
"""

import csv
import json
import os
import re
import sys
from collections import OrderedDict, defaultdict

SRC = "ohv1.txt"
OUTDIR = "data"

RULE = re.compile(r"^-{40,}\s*$")
TITLE = re.compile(r"^Table (\d+|[A-Z])\.\s+(.*?)\s*$")
FOOTNOTE = re.compile(r"^\s*\d+/\s")
LEADER = re.compile(r"^(?P<name>.*?)\s*\.{2,}\s*(?P<tail>.*)$")
CONT = re.compile(r"\s*-\s*Con\.?\s*$")
YEAR = re.compile(r"\b((?:19|20)\d\d)\b")

STUB_ITEM = "item"
STUB_GEO = "geographic area"
KNOWN_STUBS = {STUB_ITEM, STUB_GEO, "characteristics", "crop", ""}

FLAGS = {
    "(D)": "withheld",        # withheld to avoid disclosing individual operations
    "(NA)": "not_available",
    "(X)": "not_applicable",
    "(Z)": "rounds_to_zero",
    "(L)": "low_reliability",
    "(H)": "high_cv",
    "-": "zero",
}

# Units that appear as a bare column label in "Geographic area" panels.
UNIT_FROM_LABEL = {
    "farms": "farms", "number": "number", "acres": "acres", "pounds": "pounds",
    "dollars": "dollars", "percent": "percent", "bushels": "bushels",
    "tons": "tons", "cwt": "cwt", "operations": "operations", "head": "head",
    "colonies": "colonies", "gallons": "gallons", "workers": "workers",
    "producers": "producers", "trees": "trees", "square feet": "square feet",
}


# ----------------------------------------------------------------- file input

def read_lines(path):
    text = open(path, "rb").read().decode("cp1252", errors="replace")
    for bad, good in (("’", "'"), ("–", "-"), ("—", "-"),
                      ("•", "-"), ("\x95", "-"), ("“", '"'),
                      ("”", '"')):
        text = text.replace(bad, good)
    return text.replace("\r\n", "\n").split("\n")


# ------------------------------------------------------------- header parsing

def colon_positions(line):
    return [i for i, ch in enumerate(line) if ch == ":"]


def slice_fields(line, cols):
    """Split a line at the ':' offsets recorded from the panel header."""
    out = []
    for i, start in enumerate(cols):
        end = cols[i + 1] if i + 1 < len(cols) else len(line)
        out.append(line[start + 1:end])
    return out


def segments(line):
    """(start, end, text) runs of a header line, split on its own colons."""
    out, prev = [], 0
    for pos in colon_positions(line) + [len(line)]:
        out.append((prev, pos, line[prev:pos].strip()))
        prev = pos + 1
    return out


def build_columns(hdr_lines):
    """
    Merge a multi-line header block into one label per field.

    Spanner rows sit above the leaf row and cover several leaf fields; each
    spanner segment is attributed to every leaf field it encloses, so
    "Inventory" over "Farms" becomes "Inventory > Farms".
    """
    leaf = hdr_lines[-1]
    cols = colon_positions(leaf)
    if len(cols) < 2:
        return None, None
    bounds = []
    for i, start in enumerate(cols):
        end = cols[i + 1] if i + 1 < len(cols) else len(leaf) + 200
        bounds.append((start + 1, end))
    labels = [c.strip() for c in slice_fields(leaf, cols)]

    # Collect each field's fragments top-down, then join once. Prepending line
    # by line would reverse a header that wrapped over three lines
    # ("Sq. ft. under" / "glass or other" / "protection").
    wraps = [[] for _ in bounds]      # same-field continuations, in reading order
    spans = [[] for _ in bounds]      # group headings above several fields

    for up in hdr_lines[:-1]:
        if RULE.match(up) or not up.strip():
            continue
        segs = [s for s in segments(up) if s[2] and not set(s[2]) <= {"-"}]
        if not segs:
            continue
        for i, (fs, fe) in enumerate(bounds):
            mid = (fs + min(fe, len(leaf) + 1)) / 2
            for ss, se, txt in segs:
                if not (ss <= mid < se) or not txt:
                    continue
                # A segment sitting above exactly one leaf field is that label
                # wrapping onto an earlier line; one straddling several is a
                # spanner naming the group.
                covered = sum(1 for bs, be in bounds
                              if ss <= (bs + min(be, len(leaf) + 1)) / 2 < se)
                (wraps if covered <= 1 else spans)[i].append(txt)
                break

    for i, leaf_txt in enumerate(labels):
        parts = [p for p in wraps[i] + ([leaf_txt] if leaf_txt else []) if p]
        # drop a fragment already contained in another, e.g. a repeated unit
        merged = " ".join(dict.fromkeys(parts))
        groups = [g for g in dict.fromkeys(spans[i]) if g and g not in merged]
        labels[i] = " > ".join(groups + ([merged] if merged else [])) or leaf_txt
    return cols, labels


def valid_header(hdr_lines):
    """Reject dashed underlines and body text that merely look like headers."""
    leaf = hdr_lines[-1]
    k = leaf.find(":")
    if k < 8:
        return False
    stub = leaf[:k].strip()
    if ".." in stub:
        return False
    if stub.lower() in KNOWN_STUBS:
        return True
    cells = [c.strip() for c in slice_fields(leaf, colon_positions(leaf))]
    filled = [c for c in cells if c]
    return len(filled) >= 2 and not any(".." in c for c in filled)


# -------------------------------------------------------------- cell decoding

def parse_value(cell):
    """Return (number|None, flag)."""
    s = cell.strip()
    if not s:
        return None, ""
    if s in FLAGS:
        return (0.0, "zero") if s == "-" else (None, FLAGS[s])
    neg = s.startswith("-") and len(s) > 1
    t = re.sub(r"\s+\d+/$", "", s.lstrip("-").replace(",", "").replace("$", "").strip())
    if re.fullmatch(r"\d+(\.\d+)?", t):
        v = float(t)
        return (-v if neg else v), ""
    return None, "unparsed"


def split_unit_year(tail):
    """'number, 2022' -> ('number','2022');  '2017' -> ('','2017')."""
    tail = tail.strip().rstrip(":").strip()
    if not tail:
        return "", ""
    m = re.match(r"^(?P<u>.*?),\s*(?P<y>(?:19|20)\d\d)$", tail)
    if m:
        return m.group("u").strip(), m.group("y")
    if re.fullmatch(r"(?:19|20)\d\d", tail):
        return "", tail
    return tail, ""


def clean(name):
    return CONT.sub("", name.rstrip()).rstrip(" .:")


def norm(text):
    """Collapse the padding that survives when a wrapped label is rejoined."""
    return re.sub(r"\s+", " ", text).strip()


def unit_from_column(label):
    leaf = label.split(" > ")[-1].strip()
    m = re.search(r"\(([^)]*)\)", leaf)
    if m:
        return m.group(1).strip()
    return UNIT_FROM_LABEL.get(leaf.lower(), leaf.lower())


# ------------------------------------------------------------------- the walk

class Table:
    def __init__(self, chapter, number, title):
        self.chapter, self.number, self.title = chapter, number, title
        self.key = f"c{chapter}t{number}"
        self.obs = []
        self.years = YEAR.findall(title)
        self.columns = OrderedDict()

    @property
    def default_year(self):
        return self.years[0] if self.years else ""


def parse(lines):
    tables = OrderedDict()
    chapter, seen, cur = 1, set(), None
    i, n = 0, len(lines)

    while i < n:
        line = lines[i]
        m = TITLE.match(line)
        if m:
            ident = m.group(1)
            title = re.sub(r"\s*\(continued\)\s*$", "", CONT.sub("", m.group(2))).strip()
            if ident.isdigit():
                num = int(ident)
                # Chapter 2 begins where the numbering genuinely restarts at 1.
                if num == 1 and chapter == 1 and seen and max(seen) > 10:
                    chapter, seen = 2, set()
                seen.add(num)
                tbl_chapter, key = chapter, f"c{chapter}t{num}"
            else:
                # Lettered tables live in the appendix; keeping them separate
                # stops their panels being attributed to the last numbered table.
                num, tbl_chapter, key = ident, 3, f"appx{ident}"
            if key not in tables:
                tables[key] = Table(tbl_chapter, num, title)
            elif len(title) > len(tables[key].title):
                tables[key].title = title
            cur = tables[key]
            i += 1
            continue

        if cur is not None and RULE.match(line):
            j, hdr = i + 1, []
            while j < n and not RULE.match(lines[j]) and (j - i) <= 12:
                hdr.append(lines[j])
                j += 1
            if j >= n or not hdr or not any(h.strip() for h in hdr):
                i += 1
                continue
            if not valid_header(hdr):
                i += 1
                continue

            body_start = j + 1
            k = body_start
            while k < n and not (RULE.match(lines[k]) or TITLE.match(lines[k])
                                 or FOOTNOTE.match(lines[k])):
                k += 1
            body = lines[body_start:k]

            # Narrow tables are printed two-up, the halves divided by "::".
            for xs, xe in split_windows(hdr[-1]):
                sub_hdr = [h[xs:xe].rstrip() for h in hdr]
                if not any(s.strip() for s in sub_hdr):
                    continue
                cols, labels = build_columns(sub_hdr)
                if cols is None:
                    continue
                stub = sub_hdr[-1][:cols[0]].strip().lower()
                labels = dedupe([lab or f"col{c+1}" for c, lab in enumerate(labels)])
                for lab in labels:
                    cur.columns[lab] = True
                read_panel([b[xs:xe].rstrip() for b in body], cols, labels, stub, cur)

            i = k
            continue

        i += 1

    return tables


def split_windows(leaf):
    """Character windows of a header line, one per side-by-side sub-table."""
    seps = [m.start() for m in re.finditer(r"::", leaf)]
    if not seps:
        return [(0, len(leaf) + 400)]
    out, prev = [], 0
    for p in seps:
        out.append((prev, p))
        prev = p + 2
    out.append((prev, len(leaf) + 400))
    return out


def dedupe(names):
    seen, out = {}, []
    for nm in names:
        if nm in seen:
            seen[nm] += 1
            out.append(f"{nm} #{seen[nm]}")
        else:
            seen[nm] = 1
            out.append(nm)
    return out


def read_panel(body, cols, labels, stub, table):
    """Read the data rows of one panel (or one side-by-side half of one)."""
    width = cols[0]
    # The stack holds every ancestor of the current row keyed by indentation.
    # Rows that carry values are ancestors too: a parent line prints its own
    # total and its children are simply indented beneath it, so "Total sales"
    # must sit on the stack for "Corn" to resolve to the same path in the
    # first panel and in a "- Con." reprint after a page break.
    stack = []            # (indent, text, is_caps_banner)
    last_name, last_indent, last_unit = "", 0, ""
    wrap, wrap_indent = [], 0   # long item labels wrap onto extra lines
    prev_caps = False           # previous line was an all-caps banner
    banner = ""                 # current all-caps block, e.g. "HORSES AND PONIES"
    is_geo_rows = stub.startswith("geographic")

    def push(indent, text, caps=False):
        while stack and stack[-1][0] >= indent:
            stack.pop()
        stack.append((indent, text, caps))

    def path(indent):
        return " > ".join(t for ind, t, _ in stack if ind < indent)

    for line in body:
        s = line.strip()
        if not s or s.startswith("See footnote") or s.startswith("--continued"):
            continue

        if len(line) <= width or line[width] != ":":
            continue

        cells = slice_fields(line, cols)
        lab = line[:width].rstrip()
        has_values = any(c.strip() for c in cells)

        if not has_values:
            txt = lab.strip()
            if txt:
                indent = len(lab) - len(lab.lstrip())
                # A section heading ends with ':' or '-', is a "- Con." reprint
                # of one, or is set in full caps.  Anything else is the first
                # line of an item label that wrapped.
                is_heading = (
                    is_geo_rows
                    or txt.endswith(":") or txt.endswith("-")
                    or bool(CONT.search(txt))
                    or (txt.upper() == txt and any(c.isalpha() for c in txt))
                )
                if is_heading:
                    # A heading can wrap too; its first line arrives here as a
                    # pending fragment because only the last line carries the
                    # ':' or '- Con.' that marks it as a heading.
                    head = norm(clean(lab))
                    if wrap:
                        head = norm(" ".join(wrap + [head]))
                        indent = wrap_indent
                    wrap = []
                    caps = head.upper() == head and any(c.isalpha() for c in head)
                    if head and caps and prev_caps:
                        banner = f"{banner} {head}".strip()   # banner wrapped
                        if stack and stack[-1][2]:
                            ind0, t0, _ = stack[-1]
                            stack[-1] = (ind0, f"{t0} {head}", True)
                    elif head:
                        if caps:
                            banner = head
                        push(indent, head, caps)
                    prev_caps = caps
                else:
                    if not wrap:
                        wrap_indent = indent
                    wrap.append(txt)
                    prev_caps = False
            continue

        prev_caps = False
        m = LEADER.match(lab)
        new_item = False
        if m:
            raw_name = m.group("name")
            unit, year = split_unit_year(m.group("tail"))
            indent = len(raw_name) - len(raw_name.lstrip())
            name = norm(clean(raw_name))
            if wrap and name:
                name = norm(" ".join(wrap + [name]))
                indent = wrap_indent
            wrap = []
            if name:
                last_name, last_indent, new_item = name, indent, True
            else:
                name, indent = last_name, last_indent
        else:
            unit, year = split_unit_year(lab)
            name, indent = last_name, last_indent
            if not unit and not year:
                continue

        # A bare "2017" continuation row repeats the previous row's unit.
        if unit:
            last_unit = unit
        elif year:
            unit = last_unit

        section = path(indent)
        if new_item:
            push(indent, name)

        if not year:
            ys = YEAR.findall(section)
            year = ys[-1] if ys else table.default_year

        for col_label, cell in zip(labels, cells):
            val, flag = parse_value(cell)
            if val is None and not flag:
                continue
            if is_geo_rows:
                # Rows are places; the only section that carries meaning is the
                # all-caps block banner ("HORSES AND PONIES").  "State Total" and
                # "Counties, 2022" merely announce which places follow.
                geo, metric = name, col_label
                m_unit = unit or unit_from_column(col_label)
                m_section = banner
            else:
                geo, metric = col_label, name
                m_unit = unit
                m_section = section
            table.obs.append({
                "chapter": table.chapter, "table": table.number,
                "table_key": table.key, "table_title": table.title,
                "section": m_section, "geo": geo.strip(), "metric": metric.strip(),
                "unit": m_unit, "year": year, "value": val, "flag": flag,
                "layout": "geo_rows" if is_geo_rows else "item_rows",
            })


# --------------------------------------------------------------------- output

def main():
    if not os.path.exists(SRC):
        sys.exit(f"missing {SRC}")
    os.makedirs(OUTDIR, exist_ok=True)
    tables = parse(read_lines(SRC))

    # Canonical county list: the column headings of chapter 2, Table 1
    # ("County Summary Highlights"), which prints every county exactly once.
    NOT_A_COUNTY = {"Ohio", "Item", "Total", "State Total", "Counties"}
    counties = [c for c in tables["c2t1"].columns
                if c not in NOT_A_COUNTY and re.fullmatch(r"[A-Z][A-Za-z .'-]+", c)]
    if len(counties) != 88:
        print(f"warning: expected 88 counties, found {len(counties)}", file=sys.stderr)

    county_set = set(counties) | {"Ohio"}

    county_rows, state_hist, state_break = [], [], []
    for t in tables.values():
        if t.chapter == 2:
            for o in t.obs:
                if o["geo"] in county_set:
                    county_rows.append(o)
        elif t.number == 1:
            # Historical Highlights: the columns are census years.
            for o in t.obs:
                yr = YEAR.findall(o["geo"])
                if yr:
                    r = dict(o)
                    r["year"] = yr[0]
                    r["adjusted"] = "no" if "#" in o["geo"] or "Not adjusted" in o["geo"] else "yes"
                    r["geo"] = "Ohio"
                    state_hist.append(r)
        else:
            state_break.append(o if False else o)

    def write(path, rows, fields):
        with open(os.path.join(OUTDIR, path), "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
            w.writeheader()
            w.writerows(rows)
        return len(rows)

    base = ["chapter", "table", "table_key", "table_title", "section", "geo",
            "metric", "unit", "year", "value", "flag", "layout"]
    n1 = write("county_long.csv", county_rows, base)
    n2 = write("state_history.csv", state_hist, base + ["adjusted"])
    n3 = write("state_breakdown.csv",
               [o for t in tables.values() if t.chapter == 1 and t.number != 1 for o in t.obs],
               base + ["layout"])

    # metric catalogue
    cat = defaultdict(lambda: {"n": 0, "geos": set(), "years": set(), "flags": 0})
    for r in county_rows:
        k = (r["table_key"], r["table_title"], r["section"], r["metric"], r["unit"])
        e = cat[k]
        e["n"] += 1
        e["geos"].add(r["geo"])
        e["years"].add(r["year"])
        if r["flag"]:
            e["flags"] += 1
    metrics = [{
        "table_key": k[0], "table_title": k[1], "section": k[2],
        "metric": k[3], "unit": k[4], "n": v["n"],
        "counties": len(v["geos"] - {"Ohio"}),
        "years": sorted(v["years"]), "suppressed": v["flags"],
    } for k, v in cat.items()]
    metrics.sort(key=lambda m: (-m["counties"], m["table_key"]))

    json.dump(counties, open(os.path.join(OUTDIR, "counties.json"), "w"), indent=1)
    json.dump(metrics, open(os.path.join(OUTDIR, "metrics.json"), "w"), indent=1)

    print(f"tables parsed      : {len(tables)}")
    print(f"counties           : {len(counties)}")
    print(f"county obs         : {n1:,}  -> data/county_long.csv")
    print(f"state history obs  : {n2:,}  -> data/state_history.csv")
    print(f"state breakdown obs: {n3:,}  -> data/state_breakdown.csv")
    print(f"distinct metrics   : {len(metrics)}")
    full = [m for m in metrics if m["counties"] >= 80]
    print(f"metrics w/ >=80 cty: {len(full)}")


if __name__ == "__main__":
    main()

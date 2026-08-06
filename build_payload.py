#!/usr/bin/env python3
"""
Turn the parsed census tables into the single payload the explorer loads.

Produces build/payload.json.gz containing:
  counties   name, FIPS, projected centroid, land area
  geo        GeoJSON of the 88 county polygons (coordinates rounded)
  metrics    catalogue: id, label, topic, unit, table provenance, years
  values     {metric_id: {year: [v x 88]}}, aligned to the county order
  ohio       {metric_id: {year: v}} statewide totals
  history    Ohio time series 1992-2022 from chapter 1, table 1
"""

import csv
import gzip
import json
import math
import os
import re
from collections import OrderedDict, defaultdict

DATA = "data"
BUILD = "build"
MIN_COUNTIES = 25          # a metric must be reported for at least this many

# Topic for each county table, by table number.  The titles overlap too much
# for keyword matching to be trustworthy ("Market Value ... Including Food
# Marketing Practices" is about sales, not practices).
TOPIC_BY_TABLE = {
    "Overview":         [1],
    "Money":            [2, 3, 4, 5, 6, 7],
    "Land":             [8, 9, 10, 28, 30, 32, 41],
    "Livestock":        [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
    "Crops":            [24, 25, 26, 27, 29, 31, 33, 34, 35, 36, 37],
    "Operations":       [38, 39, 40, 42, 43, 44],
    "Producers":        [45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57],
}
TOPICS = {n: name for name, nums in TOPIC_BY_TABLE.items() for n in nums}

# The 32 Ohio counties in the Appalachian Regional Commission's service area.
ARC_APPALACHIA = [
    "Adams", "Ashtabula", "Athens", "Belmont", "Brown", "Carroll", "Clermont",
    "Columbiana", "Coshocton", "Gallia", "Guernsey", "Harrison", "Highland",
    "Hocking", "Holmes", "Jackson", "Jefferson", "Lawrence", "Mahoning",
    "Meigs", "Monroe", "Morgan", "Muskingum", "Noble", "Perry", "Pike",
    "Ross", "Scioto", "Trumbull", "Tuscarawas", "Vinton", "Washington",
]


def topic_for(table_num):
    return TOPICS.get(int(table_num), "Other")


FOOTNOTE_REF = re.compile(r"\s*\d+/")

SMALL_WORDS = {"and", "or", "of", "for", "the", "in", "on", "by", "with",
               "to", "a", "an", "per", "from", "under", "other", "all"}


def tidy(text):
    """Strip footnote markers and de-shout the report's all-caps banners."""
    text = FOOTNOTE_REF.sub("", text or "")
    text = re.sub(r"\s+", " ", text).strip(" ,;:-")
    letters = [c for c in text if c.isalpha()]
    if letters and all(c.isupper() for c in letters) and len(text) > 3:
        words = []
        for i, w in enumerate(text.lower().split()):
            core = w.strip("(),")
            words.append(w if (core in SMALL_WORDS and i) else w[:1].upper() + w[1:])
        text = " ".join(words)
    return text


def dedupe_parts(parts):
    """
    Drop exact repeats only.

    Substring matching is tempting here and wrong: in "All Goats - Inventory
    and Sales > Inventory > Farms" both "Inventory" and "Sales" appear inside
    the table's own title, so dropping contained parts collapsed the inventory
    and the sales columns onto one indistinguishable label.
    """
    out, seen = [], set()
    for p in parts:
        if not p:
            continue
        low = p.lower()
        if low in seen:
            continue
        seen.add(low)
        out.append(p)
    return out


def short_label(section, metric, unit):
    """A readable label: the deepest level of the item path plus the leaf."""
    # "2022 size of farm" is a section about farm size, not about 2022 --
    # strip the leading year rather than discarding the whole level.
    parts = [tidy(re.sub(r"^(19|20)\d\d\s+", "", p)) for p in (section or "").split(" > ") if p]
    parts = [p[:1].upper() + p[1:] if p else p for p in parts]
    parts = [p for p in parts if p and not re.fullmatch(r"(19|20)\d\d", p)]
    metric = tidy(metric).replace(" > ", " · ")
    # Two levels, because the deepest one is often a generic breakdown
    # ("Farms by acres harvested") shared by every crop in the table.
    tail = parts[-2:] if parts else []
    label = " · ".join(dedupe_parts(tail + metric.split(" · ")))
    label = re.sub(r"\s+", " ", label).strip()
    # Append the unit unless the label already ends with it. Testing for the
    # unit anywhere in the label is too eager: "Farms by number sold" contains
    # both "farms" and "number", which would leave the farms and the head-count
    # versions of the same breakdown sharing one name.
    low = label.lower()
    if unit and f"({unit})".lower() not in low and not low.endswith(unit.lower()):
        label = f"{label} ({unit})"
    return label


def subject_of(title):
    """The table's subject: its title without the trailing year list."""
    t = re.split(r":\s*\d{4}", title)[0]
    return tidy(re.sub(r"\s*:\s*$", "", t))


# ------------------------------------------------------- Quick Stats source

QS_FILE = os.path.join(DATA, "qs_ohio_county.tsv.gz")
QS_YEARS = ["2002", "2007", "2012", "2017", "2022"]
QS_MIN_COUNTIES = 40      # a five-census trend needs a real base
QS_CV_YEARS = {"2012", "2017", "2022"}   # earlier censuses publish no CV

# Quick Stats' own sector names, mapped onto the topics already used for the
# report so both sources browse the same way.
QS_TOPIC = {
    "CROPS": "Crops",
    "ANIMALS & PRODUCTS": "Livestock",
    "ECONOMICS": "Money",
    "DEMOGRAPHICS": "Producers",
    "ENVIRONMENTAL": "Operations",
}


def qs_domain_label(domain, domaincat):
    """
    'FARM SALES: (100,000 TO 249,999 $)' -> 'Farm sales: 100,000 to 249,999 $'.

    DOMAINCAT_DESC already repeats the domain name, so the domain itself is
    only used when the category is empty.
    """
    if not domaincat or domaincat == "NOT SPECIFIED":
        return ""
    text = domaincat.replace("(", "").replace(")", "")
    return tidy(text)


MATCH_MIN_OVERLAP = 20    # counties both sources report
MATCH_MIN_DISTINCT = 5    # distinct values among them


def merge_quickstats(metrics, values, qs_metrics, qs_values, qs_cv):
    """
    Fold each Quick Stats series into the report metric it duplicates.

    96% of the Quick Stats series are a measure the report already carries --
    same figures, different name. Listing both doubled the catalogue without
    adding anything to explore. What Quick Stats genuinely adds is *years*
    (2002-2012) and USDA's CV, so those get attached to the existing metric and
    the duplicate entry is dropped.

    Two series are judged the same measure when every county value they both
    report is equal, in every census year they share. That is agreement on the
    data itself, which is why this is safe where matching 2,325 reconstructed
    labels against 1,470 official ones would not have been.
    """
    def vec(store, mid, year, scale=1):
        v = store.get(mid, {}).get(year)
        if not v:
            return None
        return [None if x is None else round(x * scale, 3) for x in v]

    # Index report metrics by their first non-null value so each Quick Stats
    # series compares against a handful of candidates, not all 2,325.
    probe = defaultdict(set)
    for m in metrics:
        for y in ("2022", "2017"):
            for sc in (1, 1000):
                v = vec(values, m["id"], y, sc)
                if not v:
                    continue
                for x in v:
                    if x is not None and x > 0:
                        probe[x].add(m["id"])
                        break

    by_id = {m["id"]: m for m in metrics}

    def agreement(qid, rid):
        """Scale factor and distinct-value count if they agree, else None."""
        shared = [y for y in ("2017", "2022")
                  if qs_values.get(qid, {}).get(y) and values.get(rid, {}).get(y)]
        if not shared:
            return None
        for sc in (1, 1000):
            ok, total, distinct = True, 0, set()
            for y in shared:
                a, b = vec(qs_values, qid, y), vec(values, rid, y, sc)
                both = [(x, z) for x, z in zip(a, b)
                        if x is not None and z is not None]
                if len(both) < MATCH_MIN_OVERLAP:
                    ok = False
                    break
                total += len(both)
                distinct |= {x for x, _ in both}
                if any(x != z for x, z in both):
                    ok = False
                    break
            if ok and total >= MATCH_MIN_OVERLAP:
                return sc, len(distinct)
        return None

    # --- pass one: find every (quickstats, report) pair that agrees
    pairs = defaultdict(list)      # report id -> [(distinct, years, scale, qs metric)]
    kept, weak, matched, cv_out = [], [], set(), {}
    for qm in qs_metrics:
        qid = qm["id"]
        cands = set()
        for y in ("2022", "2017"):
            v = vec(qs_values, qid, y)
            if not v:
                continue
            for x in v:
                if x is not None and x > 0:
                    cands |= probe.get(x, set())
                    break

        hits, thin = [], []
        for rid in cands:
            got = agreement(qid, rid)
            if not got:
                continue
            (hits if got[1] >= MATCH_MIN_DISTINCT else thin).append((rid, got[0], got[1]))

        # Equal values only evidence being the same measure when there are
        # enough different values to make the coincidence unlikely. Sorghum
        # silage is 24 counties reading 1, 2, 3 or 5 -- that matches a farm
        # count and a tonnage equally well, so it matches neither.
        if thin and not hits:
            weak.append((qm["label"], by_id[thin[0][0]]["label"], thin[0][2]))
        if not hits:
            kept.append(qm)
            continue

        matched.add(qid)
        for rid, scale, distinct in hits:
            pairs[rid].append((distinct, len(qm["years"]), scale, qm))

    # --- pass two: fill each report metric from exactly one series
    #
    # Several Quick Stats series can legitimately agree with the same report
    # metric on the overlap and still differ in the earlier censuses. Letting each
    # write in turn meant the last one won, silently, and put 2002 figures in
    # that disagreed with Quick Stats itself. Pick the best-evidenced match --
    # most distinct values, then the longest series -- and use only that one.
    ambiguous = 0
    for rid, cands in pairs.items():
        distinct, _, scale, qm = max(cands, key=lambda t: (t[0], t[1]))
        r = by_id[rid]
        # Fill only what the printed table lacks. Where the report publishes a
        # year it is kept, because those are the figures checked against the
        # PDFs; where it doesn't -- Table 24 is 2022-only -- Quick Stats
        # completes the series.
        extra = [y for y in qm["years"] if y not in r["years"]]
        if not extra:
            continue

        # Agreeing on 2017 and 2022 does not make two series the same measure.
        # Every farm has sales in a census year, so "operations with sales" and
        # "number of operations" match exactly on the overlap and then diverge
        # in 2002. When the candidates disagree about the years being filled,
        # nothing here can say which is right -- so fill neither.
        def fill_from(cand):
            _, _, sc, cqm = cand
            return {y: tuple(None if x is None else round(x / sc, 6)
                             for x in qs_values[cqm["id"]][y])
                    for y in extra if y in qs_values[cqm["id"]]}
        proposals = {tuple(sorted(fill_from(c).items())) for c in cands}
        if len(proposals) > 1:
            ambiguous += 1
            continue
        # Into the report's units, not Quick Stats': the census prints money in
        # thousands and Quick Stats in dollars, so copying verbatim would leave
        # 2002-2012 a thousand times larger than 2017 in the same series.
        # `scale` is the factor agreement() already proved.
        for y in extra:
            values[rid][y] = [None if x is None else x / scale
                              for x in qs_values[qm["id"]][y]]
        r["years"] = sorted(set(r["years"]) | set(extra))
        r["official"] = qm.get("official")
        r["qsYears"] = extra
        if qs_cv.get(qm["id"]):
            cv_out[rid] = qs_cv[qm["id"]]
            r["hasCV"] = True
        r["suppressed"] = sum(1 for y in r["years"]
                              for v in values[rid][y] if v is None)
        r["coverage"] = max(sum(1 for v in values[rid][y] if v is not None)
                            for y in r["years"])
    merged = len(matched)
    if ambiguous:
        print(f"  {ambiguous} measure(s) left at 2017/2022 only: two or more "
              f"Quick Stats series matched the overlap but disagreed on the "
              f"earlier censuses")

    # The genuine additions keep their own values and CV.
    for qm in kept:
        values[qm["id"]] = qs_values[qm["id"]]
        if qs_cv.get(qm["id"]):
            cv_out[qm["id"]] = qs_cv[qm["id"]]

    if weak:
        print(f"  {len(weak)} series left unmerged: their only candidate matched "
              f"on fewer than {MATCH_MIN_DISTINCT} distinct values")
        for a, b, d in weak[:5]:
            print(f"    {d} distinct — {a[:42]} ~ {b[:42]}")

    return merged, kept, cv_out


def load_quickstats(counties):
    """
    Ohio county series from USDA's machine-readable release.

    Only series present in every census year are kept: a Quick Stats metric
    exists here to carry a 20-year trend, and one that appears in a single
    census does that no better than the parsed report already does.
    """
    if not os.path.exists(QS_FILE):
        print(f"note: {QS_FILE} absent — run fetch_quickstats.py to add "
              "the 2002-2022 series")
        return [], {}, {}

    idx = {c.upper(): i for i, c in enumerate(counties)}
    n = len(counties)
    series = defaultdict(lambda: {"vals": {}, "cv": {}, "meta": None})

    with gzip.open(QS_FILE, "rt", encoding="utf-8", newline="") as fh:
        for r in csv.DictReader(fh, delimiter="\t"):
            i = idx.get(r["COUNTY_NAME"].strip().upper())
            if i is None:
                continue
            key = (r["SHORT_DESC"], r["DOMAINCAT_DESC"])
            year = r["YEAR"]
            e = series[key]
            if e["meta"] is None:
                e["meta"] = r
            e["vals"].setdefault(year, [None] * n)
            e["cv"].setdefault(year, [None] * n)

            raw = r["VALUE"].replace(",", "").strip()
            if raw == "-":
                e["vals"][year][i] = 0.0
            else:
                try:
                    e["vals"][year][i] = float(raw)
                except ValueError:
                    pass          # (D) withheld, (Z), (NA): leave blank
            cv = r.get("CV_%", "").strip()
            try:
                e["cv"][year][i] = round(float(cv), 1)
            except ValueError:
                pass

    metrics, values, cvs = [], {}, {}
    for (short, domaincat), e in series.items():
        years = [y for y in QS_YEARS if y in e["vals"]
                 and any(v is not None for v in e["vals"][y])]
        if len(years) < len(QS_YEARS):
            continue                       # not a full-span trend

        m = e["meta"]
        cov = max(sum(1 for v in e["vals"][y] if v is not None) for y in years)
        # A higher bar than the report set: these exist to carry a 20-year
        # trend, and a trend drawn from under half the counties -- with
        # suppression moving between censuses -- is noise wearing a line.
        if cov < QS_MIN_COUNTIES:
            continue

        mid = f"q{len(metrics)}"
        dom = qs_domain_label(m["DOMAIN_DESC"], domaincat)
        label = tidy(short)
        if dom:
            label = f"{label} · {dom}"
        tree = [tidy(m[k]) for k in
                ("SECTOR_DESC", "GROUP_DESC", "COMMODITY_DESC", "CLASS_DESC")]
        tree = [t for t in tree if t and t.lower() != "all classes"]

        cv_by_year = {y: e["cv"][y] for y in years
                      if y in QS_CV_YEARS and any(v is not None for v in e["cv"][y])}

        metrics.append({
            "id": mid,
            "source": "quickstats",
            "label": label,
            "official": short,
            "context": " › ".join(tree[1:]) or tree[0] if tree else short,
            "unit": tidy(m["UNIT_DESC"]),
            "topic": QS_TOPIC.get(m["SECTOR_DESC"], "Other"),
            "tree": tree,
            "domain": dom,
            "table": "Quick Stats",
            "table_title": f"USDA Quick Stats · {tidy(m['SECTOR_DESC'])}",
            "years": years,
            "coverage": cov,
            "suppressed": sum(1 for y in years
                              for v in e["vals"][y] if v is None),
            "hasCV": bool(cv_by_year),
        })
        values[mid] = {y: e["vals"][y] for y in years}
        if cv_by_year:
            cvs[mid] = cv_by_year

    metrics.sort(key=lambda m: (m["topic"], m["label"]))
    return metrics, values, cvs


# ---------------------------------------------------------------- county maps

def load_geo(counties):
    """Extract Ohio's counties from the us-atlas TopoJSON as plain GeoJSON."""
    topo = json.load(open(os.path.join(BUILD, "counties-10m.json")))
    obj = topo["objects"]["counties"]
    tr = topo["transform"]
    sx, sy = tr["scale"]
    tx, ty = tr["translate"]
    arcs_raw = topo["arcs"]

    def decode(arc):
        x = y = 0
        out = []
        for dx, dy in arc:
            x += dx
            y += dy
            out.append([round(x * sx + tx, 4), round(y * sy + ty, 4)])
        return out

    arcs = [decode(a) for a in arcs_raw]

    def stitch(idxs):
        line = []
        for k in idxs:
            seg = arcs[~k][::-1] if k < 0 else arcs[k]
            line.extend(seg if not line else seg[1:])
        return line

    want = {c.lower(): c for c in counties}
    feats = []
    for g in obj["geometries"]:
        fips = str(g["id"])
        if not fips.startswith("39"):
            continue
        name = g["properties"]["name"]
        if name.lower() not in want:
            continue
        if g["type"] == "Polygon":
            coords = [stitch(r) for r in g["arcs"]]
        else:
            coords = [[stitch(r) for r in poly] for poly in g["arcs"]]
        feats.append({
            "type": "Feature", "id": fips,
            "properties": {"name": want[name.lower()], "fips": fips},
            "geometry": {"type": g["type"], "coordinates": coords},
        })
    missing = set(counties) - {f["properties"]["name"] for f in feats}
    if missing:
        print(f"warning: no geometry for {sorted(missing)}")
    return {"type": "FeatureCollection", "features": feats}


def tile_grid(points, cols=12, rows=12):
    """
    Lay the counties out on a square grid that keeps their relative positions.

    Each county aims for the cell its centroid falls in; when two want the same
    cell the later one spirals outward to the nearest free one.  Assigning the
    most crowded areas first keeps the displacement small.
    """
    xs = [p[0] for p in points.values()]
    ys = [p[1] for p in points.values()]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)

    ideal = {}
    for name, (lon, lat) in points.items():
        cx = (lon - x0) / (x1 - x0) * (cols - 1)
        cy = (y1 - lat) / (y1 - y0) * (rows - 1)   # north at the top
        ideal[name] = (cx, cy)

    # Counties competing for the busiest cells get first pick.
    density = {}
    for a, (ax, ay) in ideal.items():
        density[a] = sum(1 for b, (bx, by) in ideal.items()
                         if (ax - bx) ** 2 + (ay - by) ** 2 < 1.5)
    order = sorted(ideal, key=lambda n: -density[n])

    taken, out = {}, {}
    for name in order:
        cx, cy = ideal[name]
        best, best_d = None, None
        for r in range(rows):
            for c in range(cols):
                if (c, r) in taken:
                    continue
                d = (c - cx) ** 2 + (r - cy) ** 2
                if best_d is None or d < best_d:
                    best, best_d = (c, r), d
        taken[best] = name
        out[name] = best
    return out, cols, rows


def centroid(feature):
    """Area-weighted centroid of the largest ring, in lon/lat."""
    geom = feature["geometry"]
    rings = geom["coordinates"] if geom["type"] == "Polygon" else \
        [p[0] for p in geom["coordinates"]]
    best, best_a = None, -1
    for r in rings:
        a = abs(sum(r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]
                    for i in range(len(r) - 1))) / 2
        if a > best_a:
            best, best_a = r, a
    cx = sum(p[0] for p in best) / len(best)
    cy = sum(p[1] for p in best) / len(best)
    return round(cx, 4), round(cy, 4)


# --------------------------------------------------------------------- build

def main():
    counties = json.load(open(os.path.join(DATA, "counties.json")))
    idx = {c: i for i, c in enumerate(counties)}

    rows = list(csv.DictReader(open(os.path.join(DATA, "county_long.csv"))))

    # group observations by metric identity
    groups = defaultdict(lambda: defaultdict(dict))   # key -> year -> geo -> value
    meta = {}
    for r in rows:
        key = (r["table_key"], r["section"], r["metric"], r["unit"])
        val = None if r["flag"] and r["flag"] != "zero" else (
            float(r["value"]) if r["value"] else None)
        if r["flag"] == "zero":
            val = 0.0
        groups[key][r["year"]][r["geo"]] = val
        meta[key] = (r["table_title"], r["table"], r["layout"])

    metrics, values, ohio = [], {}, {}
    for key, byyear in groups.items():
        table_key, section, metric, unit = key
        title, tnum, layout = meta[key]
        cov = max((sum(1 for c in counties if byyear[y].get(c) is not None)
                   for y in byyear), default=0)
        if cov < MIN_COUNTIES:
            continue
        mid = f"m{len(metrics)}"
        vals, oh = {}, {}
        for y in sorted(y for y in byyear if y):
            g = byyear[y]
            col = [g.get(c) for c in counties]
            # A year with a state total but no county figures is not a year this
            # measure has: the livestock tables print 2017 for Ohio only, and
            # offering it in the year picker just yields an empty map.
            if not any(v is not None for v in col):
                continue
            vals[y] = col
            if g.get("Ohio") is not None:
                oh[y] = g["Ohio"]
        years = sorted(vals)
        if not years:
            continue

        subject = subject_of(title)
        label = short_label(section, metric, unit)
        # Where the report puts places down the side, the column heading alone
        # ("Inventory · Farms") says nothing -- the table's subject is the noun.
        if layout == "geo_rows":
            banner = tidy(section) or subject
            label = " · ".join(dedupe_parts([banner] + label.split(" · ")))
        metrics.append({
            "id": mid,
            "source": "report",
            "label": label,
            "context": subject,
            "metric": metric, "section": section, "unit": unit,
            "topic": topic_for(tnum),
            "table": f"Table {tnum}", "table_title": title,
            "years": years, "coverage": cov,
            "suppressed": sum(1 for y in years
                              for v in vals[y] if v is None),
        })
        values[mid] = vals
        ohio[mid] = oh

    # The report sometimes files the two census years under separate headings
    # ("2022 size of farm" / "2017 size of farm").  Those are one measure
    # observed twice, so fold them back together where the years don't clash.
    by_label = defaultdict(list)
    for m in metrics:
        by_label[(m["label"], m["context"], m["unit"])].append(m)
    merged, drop = [], set()
    for group in by_label.values():
        if len(group) < 2:
            continue
        keep = group[0]
        for other in group[1:]:
            if set(keep["years"]) & set(other["years"]):
                continue
            for y in other["years"]:
                values[keep["id"]][y] = values[other["id"]][y]
                if y in ohio[other["id"]]:
                    ohio[keep["id"]][y] = ohio[other["id"]][y]
            keep["years"] = sorted(set(keep["years"]) | set(other["years"]))
            keep["suppressed"] += other["suppressed"]
            drop.add(other["id"])
    metrics = [m for m in metrics if m["id"] not in drop]
    for mid in drop:
        values.pop(mid, None)
        ohio.pop(mid, None)

    metrics.sort(key=lambda m: (m["topic"], m["table_title"], m["label"]))

    geo = load_geo(counties)
    cents = {f["properties"]["name"]: centroid(f) for f in geo["features"]}
    fips = {f["properties"]["name"]: f["properties"]["fips"] for f in geo["features"]}

    # Approximate land area comes straight from the census (Table 8).
    area_metric = next((m for m in metrics
                        if m["metric"] == "Approximate land area"), None)
    areas = values[area_metric["id"]]["2022"] if area_metric else [None] * len(counties)

    grid, gcols, grows = tile_grid(cents)
    county_recs = []
    for i, c in enumerate(counties):
        lon, lat = cents.get(c, (None, None))
        col, row = grid.get(c, (None, None))
        county_recs.append({
            "name": c, "fips": fips.get(c), "lon": lon, "lat": lat,
            "area": areas[i], "col": col, "row": row,
        })

    hist = defaultdict(lambda: defaultdict(dict))
    for r in csv.DictReader(open(os.path.join(DATA, "state_history.csv"))):
        if r.get("adjusted") == "no" or not r["value"]:
            continue
        lab = short_label(r["section"], r["metric"], r["unit"])
        hist[lab][r["year"]] = float(r["value"])
    history = [{"label": k, "points": dict(sorted(v.items()))}
               for k, v in hist.items() if len(v) >= 4]

    qs_metrics, qs_values, qs_cv = load_quickstats(counties)
    n_merged, qs_kept, qs_cv = merge_quickstats(
        metrics, values, qs_metrics, qs_values, qs_cv)
    metrics = metrics + qs_kept
    metrics.sort(key=lambda m: (m["topic"], m.get("table_title", ""), m["label"]))
    if qs_metrics:
        deep = sum(1 for m in metrics if len(m["years"]) > 2)
        print(f"quickstats: {n_merged} of {len(qs_metrics)} series folded into "
              f"an existing measure, {len(qs_kept)} kept as new")
        print(f"            {deep} measures now carry 3+ censuses")

    payload = {
        "source": "USDA NASS, 2022 Census of Agriculture - Ohio, "
                  "Volume 1, Geographic Area Series, Part 35 (AC-22-A-35)",
        "qsSource": "USDA NASS Quick Stats bulk files, 2002-2022 "
                    "(nass.usda.gov/datasets)",
        "cv": qs_cv,
        "counties": county_recs,
        "geo": geo,
        "metrics": metrics,
        "values": values,
        "ohio": ohio,
        "history": history,
        "grid": {"cols": gcols, "rows": grows},
        "presets": {"Appalachian Ohio (ARC)": ARC_APPALACHIA},
    }

    os.makedirs(BUILD, exist_ok=True)
    out = os.path.join(BUILD, "payload.json")
    raw = json.dumps(payload, separators=(",", ":"))
    open(out, "w").write(raw)
    with gzip.open(out + ".gz", "wb", compresslevel=9) as fh:
        fh.write(raw.encode())

    print(f"counties : {len(county_recs)} ({sum(1 for c in county_recs if c['lon'])} with geometry)")
    print(f"metrics  : {len(metrics)}")
    print(f"history  : {len(history)} state series")
    print(f"payload  : {len(raw)/1e6:.2f} MB raw, "
          f"{os.path.getsize(out + '.gz')/1e6:.2f} MB gzipped")
    tc = defaultdict(int)
    for m in metrics:
        tc[m["topic"]] += 1
    for k, v in sorted(tc.items(), key=lambda x: -x[1]):
        print(f"   {k:16s} {v}")


if __name__ == "__main__":
    main()

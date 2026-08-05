#!/usr/bin/env python3
"""
Check the fixed-width parser against USDA's own machine-readable release.

parse_ohv1.py reconstructs the county tables from a print report. That is the
kind of thing that can be subtly wrong in ways an internal consistency check
never catches -- a column read one field to the left still sums correctly.

So this compares the parsed figures, county by county, against the Quick Stats
bulk files, which carry the same census in tabular form. Any disagreement is a
parser bug and fails the run.

    python3 fetch_quickstats.py && python3 validate_quickstats.py
"""

import csv
import gzip
import json
import os
import sys
from collections import defaultdict

QS = os.path.join("data", "qs_ohio_county.tsv.gz")
PAYLOAD = os.path.join("build", "payload.json")

# Parsed metric -> Quick Stats SHORT_DESC. `scale` converts the report's units
# to Quick Stats': the census prints money in thousands, Quick Stats in dollars.
#
# Deliberately hand-written. Fuzzy-matching 2,325 labels against 1,470
# SHORT_DESCs would be the single most likely place to introduce the error this
# script exists to catch.
PAIRS = [
    ("Farms (number)", "County Summary",
     "FARM OPERATIONS - NUMBER OF OPERATIONS", 1),
    ("Land in farms (acres)", "County Summary",
     "FARM OPERATIONS - ACRES OPERATED", 1),
    ("Land in farms · Average size of farm (acres)", "County Summary",
     "FARM OPERATIONS - AREA OPERATED, MEASURED IN ACRES / OPERATION", 1),
    ("Market value of agricultural products sold ($1,000)", "County Summary",
     "COMMODITY TOTALS - SALES, MEASURED IN $", 1000),
    ("Market value of agricultural products sold · Crops, including nursery "
     "and greenhouse crops ($1,000)", None,
     "CROP TOTALS - SALES, MEASURED IN $", 1000),
    ("Market value of agricultural products sold · Livestock, poultry, and "
     "their products ($1,000)", None,
     "ANIMAL TOTALS, INCL PRODUCTS - SALES, MEASURED IN $", 1000),
    ("Total cropland (acres)", "County Summary",
     "AG LAND, CROPLAND - ACRES", 1),
    ("Total cropland (farms)", "County Summary",
     "AG LAND, CROPLAND - NUMBER OF OPERATIONS", 1),
    ("Total cropland · Harvested cropland (acres)", "County Summary",
     "AG LAND, CROPLAND, HARVESTED - ACRES", 1),
    ("Total cropland · Harvested cropland (farms)", "County Summary",
     "AG LAND, CROPLAND, HARVESTED - NUMBER OF OPERATIONS", 1),
    ("Total farm production expenses ($1,000)", "County Summary",
     "EXPENSE TOTALS, OPERATING - EXPENSE, MEASURED IN $", 1000),
    ("Government payments ($1,000)", "County Summary",
     "GOVT PROGRAMS, FEDERAL - RECEIPTS, MEASURED IN $", 1000),
    ("Government payments (farms)", "County Summary",
     "GOVT PROGRAMS, FEDERAL - OPERATIONS WITH RECEIPTS", 1),
    ("Cattle and calves (number)", "Cattle and Calves",
     "CATTLE, INCL CALVES - INVENTORY", 1),
    ("Selected crops harvested · Corn for grain (acres)", "County Summary",
     "CORN, GRAIN - ACRES HARVESTED", 1),
    ("Selected crops harvested · Soybeans for beans (acres)", "County Summary",
     "SOYBEANS - ACRES HARVESTED", 1),
    ("Selected crops harvested · Wheat for grain, all (acres)", "County Summary",
     "WHEAT - ACRES HARVESTED", 1),
]

MIN_MAPPED = 12          # fewer than this means the labels drifted
MIN_COMPARED = 400       # fewer than this means the test stopped testing


def load_quickstats():
    """(SHORT_DESC, year, COUNTY_NAME upper) -> float, TOTAL domain only."""
    if not os.path.exists(QS):
        sys.exit(f"missing {QS} — run: python3 fetch_quickstats.py")
    out = {}
    with gzip.open(QS, "rt", encoding="utf-8", newline="") as fh:
        for r in csv.DictReader(fh, delimiter="\t"):
            if r["DOMAIN_DESC"] != "TOTAL":
                continue
            v = r["VALUE"].replace(",", "").strip()
            try:
                val = float(v)
            except ValueError:
                continue          # (D) withheld, (Z), (NA) — nothing to compare
            out[(r["SHORT_DESC"], r["YEAR"], r["COUNTY_NAME"].strip().upper())] = val
    return out


def main():
    if not os.path.exists(PAYLOAD):
        sys.exit(f"missing {PAYLOAD} — run: python3 build_payload.py")
    qs = load_quickstats()
    pay = json.load(open(PAYLOAD))
    counties = [c["name"] for c in pay["counties"]]

    def find(label, ctx):
        for m in pay["metrics"]:
            if m.get("source", "report") != "report":
                continue
            if m["label"] == label and (not ctx or m["context"].startswith(ctx)):
                return m
        return None

    print(f"{'measure':52s} {'year':>5} {'n':>4} {'agree':>6} {'differ':>7}")
    print("-" * 78)

    mapped = compared = agreed = 0
    failures = []

    for label, ctx, short, scale in PAIRS:
        m = find(label, ctx)
        if not m:
            print(f"{label[:52]:52s}   -- not found in the payload")
            continue
        mapped += 1
        for year in m["years"]:
            vals = pay["values"][m["id"]].get(year)
            if not vals:
                continue
            n = ok = bad = 0
            for i, county in enumerate(counties):
                theirs = qs.get((short, year, county.upper()))
                mine = vals[i]
                if theirs is None or mine is None:
                    continue
                n += 1
                # Both sides are integers in the source; allow only float noise.
                if abs(theirs - mine * scale) <= max(0.5, abs(theirs) * 1e-9):
                    ok += 1
                else:
                    bad += 1
                    if len(failures) < 12:
                        failures.append((short, year, county, theirs, mine * scale))
            if n:
                compared += n
                agreed += ok
                flag = "" if bad == 0 else "  <-- MISMATCH"
                print(f"{short[:52]:52s} {year:>5} {n:4d} {ok:6d} {bad:7d}{flag}")

    print("-" * 78)
    pct = agreed / compared * 100 if compared else 0
    print(f"{mapped} measures mapped · {compared:,} county figures compared · "
          f"{agreed:,} agree ({pct:.2f}%)")

    problems = []
    if agreed != compared:
        problems.append(f"{compared - agreed} value(s) disagree with Quick Stats")
        print("\nfirst disagreements:")
        for short, year, county, theirs, mine in failures:
            print(f"  {short[:46]:46s} {year} {county:12s} "
                  f"USDA={theirs:,.0f}  parsed={mine:,.0f}")
    if mapped < MIN_MAPPED:
        problems.append(f"only {mapped} of {len(PAIRS)} measures resolved — "
                        "labels have drifted, the check is not testing much")
    if compared < MIN_COMPARED:
        problems.append(f"only {compared} figures compared — expected "
                        f"at least {MIN_COMPARED}")

    if problems:
        print("\nFAILED:")
        for p in problems:
            print("  -", p)
        sys.exit(1)
    print("\nthe parser agrees with USDA's machine-readable release on every "
          "figure checked")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Fetch USDA's machine-readable release of the Census of Agriculture.

`ohv1.txt` is a print report; NASS also publishes the same census as tab-
separated bulk files at nass.usda.gov/datasets, with no API key and proper
dimensional fields. Those files serve two purposes here:

  1. an independent check on the fixed-width parser (see validate_quickstats.py)
  2. county data for every census year 2002-2022, which the printed Ohio volume
     only carries for 2017 and 2022

Each national file is ~300 MB gzipped, so this streams them and keeps only the
Ohio county rows -- never holding a whole file in memory or on disk.

    python3 fetch_quickstats.py            # use the cache if present
    python3 fetch_quickstats.py --refresh  # re-download everything

Writes data/qs_ohio_county.tsv.gz
"""

import argparse
import csv
import gzip
import io
import os
import sys
import urllib.request

YEARS = ["2002", "2007", "2012", "2017", "2022"]
URL = "https://www.nass.usda.gov/datasets/qs.census{year}.txt.gz"
OUT = os.path.join("data", "qs_ohio_county.tsv.gz")

# Only the columns the explorer actually uses. The bulk files carry 39; most
# describe geographies (watershed, congressional district, zip) that are empty
# for county-level census rows.
KEEP = [
    "YEAR", "COUNTY_NAME", "COUNTY_ANSI",
    "SECTOR_DESC", "GROUP_DESC", "COMMODITY_DESC", "CLASS_DESC",
    "STATISTICCAT_DESC", "UNIT_DESC", "SHORT_DESC",
    "DOMAIN_DESC", "DOMAINCAT_DESC",
    "VALUE", "CV_%",
]


def stream_year(year, writer, seen_header):
    """Pull one census year, keeping Ohio county rows only."""
    url = URL.format(year=year)
    req = urllib.request.Request(url, headers={"User-Agent": "ohio-ag-explorer"})
    kept = scanned = 0

    with urllib.request.urlopen(req, timeout=600) as resp:
        with gzip.GzipFile(fileobj=resp) as gz:
            text = io.TextIOWrapper(gz, encoding="utf-8", errors="replace",
                                    newline="")
            reader = csv.reader(text, delimiter="\t")
            header = next(reader)
            idx = {name: i for i, name in enumerate(header)}
            need = [idx[c] for c in KEEP]
            i_level, i_state = idx["AGG_LEVEL_DESC"], idx["STATE_NAME"]

            if not seen_header:
                writer.writerow(KEEP)

            for row in reader:
                scanned += 1
                # Rows are ragged in a few places; guard rather than crash.
                if len(row) <= i_state:
                    continue
                if row[i_level] != "COUNTY" or row[i_state] != "OHIO":
                    continue
                writer.writerow([row[j] if j < len(row) else "" for j in need])
                kept += 1

    return kept, scanned


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true",
                    help="re-download even if the cache exists")
    args = ap.parse_args()

    os.makedirs("data", exist_ok=True)
    if os.path.exists(OUT) and not args.refresh:
        size = os.path.getsize(OUT) / 1e6
        print(f"{OUT} already present ({size:.1f} MB) — pass --refresh to rebuild")
        return

    total = 0
    tmp = OUT + ".part"
    try:
        with gzip.open(tmp, "wt", encoding="utf-8", newline="", compresslevel=9) as fh:
            writer = csv.writer(fh, delimiter="\t", lineterminator="\n")
            for n, year in enumerate(YEARS):
                print(f"  {year} … ", end="", flush=True)
                kept, scanned = stream_year(year, writer, seen_header=n > 0)
                total += kept
                print(f"{kept:>7,} Ohio county rows (of {scanned:,} nationally)")
        os.replace(tmp, OUT)
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise

    print(f"\n{total:,} rows -> {OUT} ({os.path.getsize(OUT)/1e6:.1f} MB)")
    print("source: USDA NASS Quick Stats, nass.usda.gov/datasets")


if __name__ == "__main__":
    main()

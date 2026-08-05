#!/usr/bin/env python3
"""
Assemble the explorer into one self-contained HTML file.

Everything is inlined -- d3, the stylesheet, the application sources, and the
gzipped payload as base64 -- so the result opens straight from the filesystem
with no server and no network.
"""

import base64
import os

BUILD = "build"
APP = "app"
VENDOR = "vendor"
OUT = "ohio_ag_explorer.html"

SOURCES = [
    "10_data.js",
    "20_scales.js",
    "30_state.js",
    "40_views_geo.js",
    "41_views_rank.js",
    "42_views_parts.js",
    "43_views_analysis.js",
    "44_views_table.js",
    "45_views_stories.js",
    "46_views_browse.js",
    "50_sidebar.js",
    "90_main.js",
]

HEAD = """<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ohio Agriculture Explorer — 2022 Census of Agriculture</title>
<meta name="description" content="An interactive explorer for the USDA 2022 Census
of Agriculture, Ohio: 2,300 measures across all 88 counties, as maps, rankings,
treemaps, waffles and more.">
<style>
{css}
</style>
</head>
<body>
<noscript><p style="padding:24px;font:14px system-ui">
This explorer needs JavaScript — every chart is drawn in the browser from data
embedded in this file.</p></noscript>
<script type="application/octet-stream" id="payload">
{payload}
</script>
<script>
{d3}
</script>
<script>
{app}
</script>
</body>
</html>
"""


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def main():
    css = read(os.path.join(APP, "style.css"))
    d3 = read(os.path.join(VENDOR, "d3.min.js"))
    app = "\n\n".join(read(os.path.join(APP, f)) for f in SOURCES)

    with open(os.path.join(BUILD, "payload.json.gz"), "rb") as fh:
        gz = fh.read()
    b64 = base64.b64encode(gz).decode()
    # Wrap so no single line is absurdly long; the reader strips whitespace.
    payload = "\n".join(b64[i:i + 120] for i in range(0, len(b64), 120))

    html = HEAD.format(css=css, d3=d3, app=app, payload=payload)
    for path in (OUT, "index.html"):
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(html)

    size = os.path.getsize(OUT)
    print(f"{OUT}  {size/1e6:.2f} MB")
    print("index.html            (identical copy — what GitHub Pages serves)")
    print(f"  css     {len(css)/1e3:7.1f} KB")
    print(f"  d3      {len(d3)/1e3:7.1f} KB")
    print(f"  app     {len(app)/1e3:7.1f} KB")
    print(f"  payload {len(payload)/1e3:7.1f} KB (base64 of {len(gz)/1e3:.1f} KB gzip)")


if __name__ == "__main__":
    main()

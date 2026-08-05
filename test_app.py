#!/usr/bin/env python3
"""Drive every view of the bundled explorer and report console errors."""

import os
import sys
from playwright.sync_api import sync_playwright

HTML = os.path.abspath("ohio_ag_explorer.html")
SHOTS = "build/shots"

VIEWS = ["stories", "browse", "map", "grid", "bivariate", "rank", "change", "small", "treemap",
         "waffle", "donut", "dist", "scatter", "heatmap", "conc", "trend", "history",
         "discover", "table"]


def main():
    os.makedirs(SHOTS, exist_ok=True)
    problems = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1500, "height": 1000},
                                device_scale_factor=2)
        errors = []
        page.on("console", lambda m: errors.append(f"{m.type}: {m.text}")
                if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

        page.goto(f"file://{HTML}")
        page.wait_for_selector("#viewbar button", timeout=20000)
        page.wait_for_timeout(900)

        n_metrics = page.evaluate("DB.metrics.length")
        n_counties = page.evaluate("DB.counties.length")
        print(f"loaded: {n_metrics} metrics, {n_counties} counties")
        if n_counties != 88:
            problems.append(f"expected 88 counties, got {n_counties}")

        # A measure with two years and a breakdown group, so every view has data.
        page.evaluate("""() => {
            const m = DB.metrics.find(x =>
                x.label === 'Total sales ($1,000)' && x.years.length > 1);
            if (m) { STATE.metric = m.id; STATE.year = m.years[m.years.length-1]; }
            const m2 = DB.metrics.find(x => x.label === 'Land in farms (acres)' && x.years.length > 1);
            if (m2) STATE.metric2 = m2.id;
            render();
        }""")
        page.wait_for_timeout(500)

        for v in VIEWS:
            errors.clear()
            # The trend view needs a measure that spans more than two censuses;
            # only the Quick Stats series do.
            if v == "trend":
                page.evaluate('''() => {
                    const m = DB.metrics.find(x => x.source === 'quickstats'
                                              && x.coverage === 88);
                    if (m) { STATE.metric = m.id; STATE.year = '2022'; }
                }''')
            page.evaluate(f"() => {{ STATE.view = '{v}'; render(); }}")
            page.wait_for_timeout(700)
            marks = page.evaluate("""() => {
                const c = document.querySelector('#canvas');
                return {
                    svgs: c.querySelectorAll('svg').length,
                    shapes: c.querySelectorAll('svg path, svg rect, svg circle, svg line').length,
                    rows: c.querySelectorAll('table.data tbody tr').length,
                    empty: c.querySelectorAll('.empty').length,
                    text: (c.textContent || '').slice(0, 60).replace(/\\s+/g, ' '),
                };
            }""")
            page.screenshot(path=f"{SHOTS}/{v}.png", full_page=False)
            status = "ok"
            if marks["empty"] and not marks["shapes"] and not marks["rows"]:
                status = "EMPTY"
                problems.append(f"{v}: rendered an empty state")
            if errors:
                status = "ERRORS"
                problems.append(f"{v}: {errors[:3]}")
            print(f"  {v:11s} {status:7s} svg={marks['svgs']} marks={marks['shapes']:5d} "
                  f"rows={marks['rows']:3d}  {marks['text'][:44]}")

        page.evaluate('''() => {
            const m = DB.metrics.find(x => x.label === 'Total sales ($1,000)'
                                      && x.years.length > 1);
            if (m) { STATE.metric = m.id; STATE.year = '2022'; }
        }''')

        # Exercise the controls that change how values are computed.
        print("\nnormalisation modes:")
        page.evaluate("() => { STATE.view = 'map'; render(); }")
        for mode in ["raw", "share", "perFarm", "perAcre", "density", "z", "rank", "lq"]:
            errors.clear()
            page.evaluate(f"() => {{ STATE.mode = '{mode}'; render(); }}")
            page.wait_for_timeout(280)
            n = page.evaluate("document.querySelectorAll('#canvas svg path').length")
            bad = " ERRORS " + str(errors[:2]) if errors else ""
            print(f"  {mode:9s} paths={n}{bad}")
            if errors:
                problems.append(f"mode {mode}: {errors[:2]}")

        # Change mode, county filtering, theme, and export.
        errors.clear()
        page.evaluate("""() => {
            STATE.mode = 'raw'; STATE.delta = true; STATE.view = 'change'; render();
        }""")
        page.wait_for_timeout(600)
        print(f"\nchange view marks: {page.evaluate('document.querySelectorAll(\"#canvas svg circle\").length')}")

        page.evaluate("""() => {
            STATE.delta = false;
            STATE.selected = new Set(DB.presets['Appalachian Ohio (ARC)']);
            STATE.view = 'rank'; render();
        }""")
        page.wait_for_timeout(600)
        n = page.evaluate("document.querySelectorAll('#canvas svg rect').length")
        print(f"ARC preset ranked bars: {n} rects (expect ~32 + gridlines)")
        page.screenshot(path=f"{SHOTS}/filtered.png")

        page.evaluate("""() => {
            document.documentElement.dataset.theme = 'dark';
            STATE.selected = null; STATE.view = 'map'; render();
        }""")
        page.wait_for_timeout(700)
        page.screenshot(path=f"{SHOTS}/dark.png")
        print("dark mode captured")

        svg_ok = page.evaluate("""() => {
            const svg = document.querySelector('#canvas svg.chart');
            if (!svg) return 'no chart';
            const {markup} = standaloneSVG(svg);
            return markup.includes('var(--') ? 'LEAKED CSS VARS' : `ok ${markup.length} bytes`;
        }""")
        print(f"svg export: {svg_ok}")
        if "LEAK" in svg_ok or svg_ok == "no chart":
            problems.append(f"svg export: {svg_ok}")

        if errors:
            problems.append(f"late errors: {errors[:4]}")
        browser.close()

    print("\n" + ("=" * 60))
    if problems:
        print(f"{len(problems)} PROBLEM(S):")
        for p_ in problems:
            print("  -", p_)
        sys.exit(1)
    print("all views rendered cleanly")


if __name__ == "__main__":
    main()

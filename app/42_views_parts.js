/* ============================================================================
   Part-to-whole: treemap, waffle, donut — plus small multiples.

   All three answer "how is this total divided up?", so they share one data
   preparation step and differ only in how they draw it.
   ========================================================================== */

/**
 * Slices for a part-to-whole chart.
 *  - by 'county': the current measure split across counties
 *  - by 'metric': the current county (or all of Ohio) split across the
 *                 sibling measures that sit under the same heading
 */
function parts(by) {
  const ser = currentSeries();
  if (!ser || ser.isDelta) return null;

  if (by === 'metric') {
    const sibs = siblingMetrics(STATE.metric);
    if (sibs.length < 2) return null;
    const keep = activeCounties();
    const out = sibs.map(m => {
      const v = series(m.id, STATE.year, 'raw').values;
      const total = keep.reduce((acc, i) => acc + (v[i] ?? 0), 0);
      return {key: m.label.replace(/\s*\([^)]*\)$/, ''), v: total, metric: m};
    }).filter(d => d.v > 0);
    return {slices: out.sort((a, b) => b.v - a.v),
            unit: sibs[0].unit,
            title: `${DB.metricById.get(STATE.metric).context}`,
            caption: `The measures reported alongside “${ser.label}”, summed over ` +
                     `${describeSelection()} for ${STATE.year}.`};
  }

  const keep = activeCounties();
  const out = keep.map(i => ({key: DB.counties[i].name, v: ser.values[i], i}))
    .filter(d => d.v != null && d.v > 0)
    .sort((a, b) => b.v - a.v);
  return {slices: out, unit: ser.unit, title: ser.label,
          caption: `${subtitleFor(ser)}. Counties with no published figure, or a ` +
                   `value of zero, are not drawn.`};
}

/** Measures printed under the same heading of the same table. */
function siblingMetrics(metricId) {
  const m = DB.metricById.get(metricId);
  if (!m) return [];
  return DB.metrics.filter(o =>
    o.table_title === m.table_title && o.section === m.section &&
    o.unit === m.unit && o.years.includes(STATE.year));
}

/** Group the tail so no chart ever carries more than eight colour classes. */
function foldTail(slices, maxSlices) {
  if (slices.length <= maxSlices) return {shown: slices, folded: null};
  const shown = slices.slice(0, maxSlices - 1);
  const rest = slices.slice(maxSlices - 1);
  const folded = {key: `Other (${rest.length})`, v: rest.reduce((a, b) => a + b.v, 0), rest};
  return {shown: [...shown, folded], folded};
}

/* ------------------------------------------------------------------ treemap */

function viewTreemap(root) {
  const p = parts(STATE.partsBy || 'county');
  if (!p) return root.append(partsUnavailable());

  const c = card(`${p.title} — treemap`, p.caption +
    ' Each rectangle is sized by its share of the total.');
  root.append(c.el);

  const W = Math.max(520, Math.min(1060, root.clientWidth - 72));
  const H = Math.round(W * 0.58);
  c.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  c.svg.setAttribute('height', H);

  const total = p.slices.reduce((a, b) => a + b.v, 0);
  const rootNode = d3.hierarchy({children: p.slices})
    .sum(d => d.v)
    .sort((a, b) => b.value - a.value);
  d3.treemap().size([W, H]).paddingInner(2).round(true)(rootNode);

  // Sequential shading by share: the areas already encode magnitude, so the
  // ramp is here to bind the map and the treemap to one visual language.
  const scale = makeClassScale(p.slices.map(d => d.v), {
    nClasses: STATE.nClasses, method: STATE.breakMode, ramp: STATE.ramp,
    reverse: STATE.reverse,
  });

  for (const leaf of rootNode.leaves()) {
    const d = leaf.data;
    const w = leaf.x1 - leaf.x0, hgt = leaf.y1 - leaf.y0;
    if (w < 1 || hgt < 1) continue;
    const k = scale.classOf(d.v);
    const fill = scale.colors[Math.max(0, k)];
    const g = s('g', {style: {cursor: 'pointer'}});
    g.append(s('rect', {x: leaf.x0, y: leaf.y0, width: w, height: hgt,
      fill, rx: 3}));
    // Only label where the text actually fits — a clipped label is worse
    // than none, and the tooltip carries the value either way.
    const room = w - 12;
    if (room > 42 && hgt > 26) {
      const ink = inkOn(fill);
      g.append(s('text', {x: leaf.x0 + 6, y: leaf.y0 + 15, 'font-size': 11,
        'font-weight': 600, fill: ink, 'pointer-events': 'none',
        text: truncate(d.key, Math.floor(room / 6.2))}));
      const val = `${fmtNumber(d.v, p.unit)} · ${(d.v / total * 100).toFixed(1)}%`;
      if (hgt > 40 && val.length * 5.6 <= room)
        g.append(s('text', {x: leaf.x0 + 6, y: leaf.y0 + 29, 'font-size': 10,
          fill: ink, opacity: 0.85, 'pointer-events': 'none', text: val}));
    }
    hoverable(g, () => tipHTML(d.key, [
      ['Value', fmtFull(d.v, p.unit)],
      ['Share', `${(d.v / total * 100).toFixed(2)}%`],
    ]));
    if (d.i != null) g.addEventListener('click', () => spotlight(d.key));
    c.svg.append(g);
  }

  legendClasses(c.legend, scale, p.unit);
}

/* ------------------------------------------------------------------- waffle */

function viewWaffle(root) {
  const p = parts(STATE.partsBy || 'county');
  if (!p) return root.append(partsUnavailable());

  const {shown} = foldTail(p.slices, 8);
  const total = p.slices.reduce((a, b) => a + b.v, 0);
  const cols = 25, rowsN = 20, cells = cols * rowsN;   // 500 squares = 0.2% each

  const c = card(`${p.title} — waffle`, p.caption +
    ` Each of the ${cells} squares is ${(100 / cells).toFixed(1)}% of the total.`);
  root.append(c.el);

  const cell = 15, gap = 2;
  const W = cols * cell, H = rowsN * cell;
  c.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  c.svg.setAttribute('width', Math.min(W * 1.6, root.clientWidth - 60));

  const colors = categorical(shown.length);
  // Largest-remainder allocation so the squares always sum to exactly `cells`.
  const exact = shown.map(d => d.v / total * cells);
  const counts = exact.map(Math.floor);
  let left = cells - counts.reduce((a, b) => a + b, 0);
  exact.map((e, i) => [e - counts[i], i]).sort((a, b) => b[0] - a[0])
    .forEach(([, i]) => { if (left-- > 0) counts[i]++; });

  let k = 0;
  shown.forEach((d, si) => {
    for (let n = 0; n < counts[si]; n++, k++) {
      const cx = k % cols, cy = Math.floor(k / cols);
      const rect = s('rect', {
        x: cx * cell + gap / 2, y: cy * cell + gap / 2,
        width: cell - gap, height: cell - gap, rx: 2,
        fill: colors[si % colors.length], style: {cursor: 'pointer'},
      });
      hoverable(rect, () => tipHTML(d.key, [
        ['Value', fmtFull(d.v, p.unit)],
        ['Share', `${(d.v / total * 100).toFixed(2)}%`],
        ['Squares', String(counts[si])],
      ]));
      c.svg.append(rect);
    }
  });

  legendSwatches(c.legend, shown.map((d, i) =>
    [colors[i % colors.length],
     `${truncate(d.key, 22)} — ${(d.v / total * 100).toFixed(1)}%`]));
}

/* -------------------------------------------------------------------- donut */

function viewDonut(root) {
  const p = parts(STATE.partsBy || 'county');
  if (!p) return root.append(partsUnavailable());

  const {shown} = foldTail(p.slices, 7);
  const total = p.slices.reduce((a, b) => a + b.v, 0);

  const c = card(`${p.title} — share of the total`, p.caption +
    ' A donut is only honest for a handful of parts, so everything past the ' +
    'seventh is folded into “Other”. For close comparisons use the ranked bars.');
  root.append(c.el);

  const W = Math.max(420, Math.min(720, root.clientWidth - 60));
  const H = 380;
  c.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  c.svg.setAttribute('height', H);

  const R = Math.min(W, H) / 2 - 66, r0 = R * 0.58;
  const g = s('g', {transform: `translate(${W / 2},${H / 2})`});
  c.svg.append(g);

  const colors = categorical(shown.length);
  const pie = d3.pie().sort(null).value(d => d.v).padAngle(0.008)(shown);
  const arc = d3.arc().innerRadius(r0).outerRadius(R).cornerRadius(2);
  const label = d3.arc().innerRadius(R + 16).outerRadius(R + 16);

  pie.forEach((slice, i) => {
    const fill = colors[i % colors.length];
    const path = s('path', {d: arc(slice), fill,
      stroke: cssVar('--surface-1'), 'stroke-width': 2, style: {cursor: 'pointer'}});
    hoverable(path, () => tipHTML(slice.data.key, [
      ['Value', fmtFull(slice.data.v, p.unit)],
      ['Share', `${(slice.data.v / total * 100).toFixed(2)}%`],
    ]));
    g.append(path);
    const pct = slice.data.v / total * 100;
    if (pct >= 4) {
      const [lx, ly] = label.centroid(slice);
      g.append(s('text', {x: lx, y: ly, class: 'mark-label',
        'text-anchor': lx > 0 ? 'start' : 'end', 'dominant-baseline': 'middle',
        text: `${truncate(slice.data.key, 14)} ${pct.toFixed(0)}%`}));
    }
  });

  g.append(s('text', {y: -6, 'text-anchor': 'middle', class: 'title-text',
    'font-size': 20, text: fmtNumber(total, p.unit)}));
  g.append(s('text', {y: 13, 'text-anchor': 'middle', class: 'tick-text',
    text: p.unit || 'total'}));

  legendSwatches(c.legend, shown.map((d, i) =>
    [colors[i % colors.length],
     `${truncate(d.key, 20)} — ${(d.v / total * 100).toFixed(1)}%`]));
}

/* ---------------------------------------------------------- small multiples */

function viewSmallMultiples(root) {
  const sibs = siblingMetrics(STATE.metric).slice(0, 12);
  const useSibs = sibs.length >= 2;
  const items = useSibs ? sibs : [DB.metricById.get(STATE.metric)];

  const c = card(useSibs
      ? `${DB.metricById.get(STATE.metric).context} — one map per measure`
      : `${DB.metricById.get(STATE.metric).label} — by county`,
    useSibs
      ? `Every measure reported under the same heading, ${STATE.year}, each on ` +
        `its own scale so the pattern is comparable even when the totals aren't.`
      : `This measure has no siblings in its table, so there is only one map to draw. ` +
        `Pick a measure from a breakdown (a "by size" or "by value" group) to see a grid.`);
  root.append(c.el);

  const cols = items.length <= 2 ? 2 : items.length <= 6 ? 3 : 4;
  const cw = Math.max(170, Math.min(260, (root.clientWidth - 100) / cols));
  const chH = Math.round(cw * 0.66) + 34;
  const W = cols * cw, H = Math.ceil(items.length / cols) * chH;
  c.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  c.svg.setAttribute('width', Math.min(W, root.clientWidth - 60));

  const active = new Set(activeNames());
  const {path} = ohioPath(cw - 12, chH - 42);

  items.forEach((m, k) => {
    const gx = (k % cols) * cw, gy = Math.floor(k / cols) * chH;
    const ser = series(m.id, STATE.year, STATE.mode);
    const vals = scopedValues(ser.values);
    const scale = makeClassScale(vals, {
      nClasses: 5, method: STATE.breakMode, ramp: STATE.ramp, reverse: STATE.reverse,
    });
    const g = s('g', {transform: `translate(${gx},${gy})`});
    g.append(s('text', {x: 6, y: 13, class: 'mark-label', 'font-weight': 600,
      text: truncate(m.label.replace(/\s*\([^)]*\)$/, ''), Math.floor(cw / 6.4))}));
    const inner = s('g', {transform: 'translate(6,20)'});
    for (const f of DB.geo.features) {
      const nm = f.properties.name, i = DB.byName.get(nm);
      const kk = scale.classOf(vals[i]);
      inner.append(hoverable(s('path', {
        d: path(f), fill: kk < 0 ? 'var(--grid)' : scale.colors[kk],
        stroke: cssVar('--surface-1'), 'stroke-width': 0.6,
        opacity: active.has(nm) ? 1 : 0.15,
      }), () => tipHTML(nm, [[m.label, fmtFull(vals[i], ser.unit)]])));
    }
    g.append(inner);
    g.append(s('text', {x: 6, y: chH - 8, class: 'tick-text',
      text: `${fmtNumber(scale.min, ser.unit)} – ${fmtNumber(scale.max, ser.unit)}`}));
    c.svg.append(g);
  });

  clear(c.legend).append(h('span', {class: 'hint',
    text: 'Each panel is scaled to its own range — read the pattern, not the shade, ' +
          'across panels. The range under each map gives its extremes.'}));
}

function partsUnavailable() {
  return h('div', {class: 'card'}, h('div', {class: 'empty'},
    STATE.delta
      ? 'Part-to-whole charts need levels, not changes. Turn off “Change 2017 → 2022”.'
      : 'This measure has no positive values to divide up in the current selection.'));
}

function describeSelection() {
  const n = activeCounties().length;
  return n === DB.counties.length ? 'all 88 counties' : `${n} selected counties`;
}

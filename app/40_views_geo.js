/* ============================================================================
   Geographic views: choropleth, bivariate choropleth, and the tile cartogram.
   ========================================================================== */

/** Ohio-tuned equal-area conic — areas stay comparable, which a choropleth needs. */
function ohioPath(width, height) {
  const proj = d3.geoConicEqualArea()
    .parallels([39, 41.7])
    .rotate([82.7, 0])
    .fitSize([width, height], DB.geo);
  return {path: d3.geoPath(proj), proj};
}

/**
 * A hairline over the county edges. Without it the state loses its silhouette
 * wherever a class sits close to the surface colour — the palest classes on
 * light, the darkest on dark.
 */
function drawOutline(g, path) {
  for (const f of DB.geo.features) {
    g.append(s('path', {d: path(f), fill: 'none', stroke: cssVar('--axis'),
      'stroke-width': 0.5, opacity: 0.55, 'pointer-events': 'none'}));
  }
  // The spotlighted county gets a ring rather than a colour change, so the
  // value it encodes still reads correctly.
  if (STATE.focus) {
    const f = DB.geo.features.find(x => x.properties.name === STATE.focus);
    if (f) {
      g.append(s('path', {d: path(f), fill: 'none', stroke: cssVar('--surface-1'),
        'stroke-width': 4, 'pointer-events': 'none'}));
      g.append(s('path', {d: path(f), fill: 'none', stroke: cssVar('--text-primary'),
        'stroke-width': 2, 'pointer-events': 'none'}));
    }
  }
}

function currentSeries() {
  if (STATE.delta) {
    const ch = changeSeries(STATE.metric, STATE.mode, STATE.deltaPct);
    if (!ch) return null;
    const m = DB.metricById.get(STATE.metric);
    return {
      values: ch.values,
      unit: ch.pct ? '% change' : (STATE.mode === 'raw' ? m.unit : ''),
      label: m.label, context: m.context, metric: m,
      year: `${ch.from} → ${ch.to}`,
      note: `Change between the ${ch.from} and ${ch.to} censuses.`,
      isDelta: true,
    };
  }
  return series(STATE.metric, STATE.year, STATE.mode);
}

/** Values restricted to the active county set, others nulled out. */
function scopedValues(vals) {
  const keep = new Set(activeCounties());
  return vals.map((v, i) => (keep.has(i) ? v : null));
}

function scaleFor(vals) {
  const diverging = STATE.diverging || STATE.delta ||
    STATE.mode === 'z' || STATE.mode === 'lq';
  const center = STATE.mode === 'lq' && !STATE.delta ? 1 : 0;
  return makeClassScale(vals, {
    nClasses: STATE.nClasses, method: STATE.breakMode, ramp: STATE.ramp,
    diverging, divKey: STATE.divKey, reverse: STATE.reverse, center,
  });
}

function subtitleFor(ser) {
  const bits = [ser.context];
  if (ser.year) bits.push(ser.year);
  const m = MODE_BY_ID.get(STATE.mode);
  if (m && STATE.mode !== 'raw') bits.push(m.label);
  const un = unitNote(ser.metric ? ser.metric.unit : '');
  if (un && STATE.mode === 'raw') bits.push(un);
  return bits.filter(Boolean).join(' · ');
}

/* ------------------------------------------------------------------- choropleth */

function viewMap(root) {
  const ser = currentSeries();
  if (!ser) return root.append(noDeltaNotice());
  const vals = scopedValues(ser.values);
  const scale = scaleFor(vals);

  const c = card(ser.label, subtitleFor(ser) +
    (ser.note ? ' — ' + ser.note : ''));
  root.append(c.el);

  const W = Math.max(520, Math.min(1060, root.clientWidth - 72));
  const H = Math.round(W * 0.62);
  c.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  c.svg.setAttribute('width', W);
  c.svg.setAttribute('height', H);

  const {path} = ohioPath(W - 8, H - 8);
  const g = s('g', {transform: 'translate(4,4)'});
  c.svg.append(g);

  const active = new Set(activeCounties().map(i => DB.counties[i].name));

  for (const f of DB.geo.features) {
    const name = f.properties.name;
    const i = DB.byName.get(name);
    const v = vals[i];
    const inScope = active.has(name);
    const k = scale.classOf(v);
    const fill = k < 0 ? 'var(--grid)' : scale.colors[k];
    const shape = s('path', {
      d: path(f), fill,
      class: 'geo-stroke',
      opacity: inScope ? 1 : 0.14,
      style: {cursor: 'pointer'},
    });
    hoverable(shape, () => tipHTML(name, [
      [ser.label, fmtFull(v, ser.unit)],
      ...(v != null && !ser.isDelta && STATE.mode !== 'raw'
        ? [['Raw', fmtFull(rawSeries(STATE.metric, ser.year)[i], ser.metric.unit)]] : []),
    ], v == null ? 'No figure published for this county.' : ''));
    shape.addEventListener('click', () => spotlight(name));
    g.append(shape);
  }

  drawOutline(g, path);

  if (STATE.showLabels) {
    const {proj} = ohioPath(W - 8, H - 8);
    for (const cty of DB.counties) {
      if (!active.has(cty.name)) continue;
      const v = vals[DB.byName.get(cty.name)];
      if (v == null) continue;
      const p = proj([cty.lon, cty.lat]);
      if (!p) continue;
      const k = scale.classOf(v);
      g.append(s('text', {
        x: p[0], y: p[1] + 3, 'text-anchor': 'middle',
        'font-size': 9, 'font-weight': 600,
        fill: inkOn(k < 0 ? '#cccccc' : scale.colors[k]),
        'pointer-events': 'none',
        text: fmtNumber(v, ser.unit),
      }));
    }
  }

  legendClasses(c.legend, scale, ser.unit);
  root.append(statsCard(vals, ser));
}

/* --------------------------------------------------------- bivariate choropleth */

function viewBivariate(root) {
  if (!STATE.metric2) {
    root.append(h('div', {class: 'card'},
      h('div', {class: 'empty'},
        'Pick a second measure in the sidebar to compare two maps at once. ',
        h('br'),
        'Each county is shaded by where it falls on both — the 3×3 key shows how.')));
    return;
  }
  const a = series(STATE.metric, STATE.year, STATE.mode);
  const b = series(STATE.metric2, STATE.year, STATE.mode);
  const av = scopedValues(a.values), bv = scopedValues(b.values);

  const terc = arr => {
    const f = finite(arr).sort((x, y) => x - y);
    return [quantileSorted(f, 1 / 3), quantileSorted(f, 2 / 3)];
  };
  const [a1, a2] = terc(av), [b1, b2] = terc(bv);
  const cls = (v, t1, t2) => v == null ? -1 : v < t1 ? 0 : v < t2 ? 1 : 2;

  const grid = BIVARIATE[isDark() ? 'dark' : 'light'];

  const c = card(`${a.label}  ×  ${b.label}`,
    `Two measures on one map, ${STATE.year}. Each county is sorted into a third ` +
    `along each scale, and the 3×3 key names the nine combinations. Colour is ` +
    `doing two jobs here, so read it with the key — the ranked bars and the ` +
    `scatter carry the same pair of measures with one job each.`);
  root.append(c.el);
  c.el.insertBefore(h('div', {class: 'row', style: {margin: '0 0 12px'}},
    h('button', {class: 'btn sm', text: '⇄ Swap which measure is which axis',
      onclick: () => {
        const t = STATE.metric; STATE.metric = STATE.metric2; STATE.metric2 = t; render();
      }})), c.svg);

  const W = Math.max(520, Math.min(1060, root.clientWidth - 72));
  const H = Math.round(W * 0.62);
  c.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  c.svg.setAttribute('height', H);
  const {path} = ohioPath(W - 8, H - 8);
  const g = s('g', {transform: 'translate(4,4)'});
  c.svg.append(g);

  for (const f of DB.geo.features) {
    const name = f.properties.name, i = DB.byName.get(name);
    const ia = cls(av[i], a1, a2), ib = cls(bv[i], b1, b2);
    const fill = (ia < 0 || ib < 0) ? 'var(--grid)' : grid[ib][ia];
    const shape = s('path', {d: path(f), fill, class: 'geo-stroke', style: {cursor: 'pointer'}});
    const band = ['low', 'middle', 'high'];
    hoverable(shape, () => tipHTML(name, [
      [a.label, fmtFull(av[i], a.unit) + (ia >= 0 ? ` (${band[ia]})` : '')],
      [b.label, fmtFull(bv[i], b.unit) + (ib >= 0 ? ` (${band[ib]})` : '')],
    ]));
    shape.addEventListener('click', () => spotlight(name));
    g.append(shape);
  }
  drawOutline(g, path);

  // 3×3 key in the corner of the plot. The axes are named by short arrows;
  // the legend below the chart spells out the four corners in full.
  const cell = 26, side = 3 * (cell + 2);
  const kx = W - side - 30, ky = H - side - 34;
  const key = s('g', {transform: `translate(${kx},${ky})`});
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
    key.append(s('rect', {
      x: i * (cell + 2), y: (2 - j) * (cell + 2), width: cell, height: cell,
      fill: grid[j][i], rx: 2,
    }));
  }
  key.append(s('text', {
    x: 0, y: side + 14, class: 'tick-text',
    text: `${truncate(a.label.replace(/\s*\([^)]*\)$/, ''), 18)} →`,
  }));
  key.append(s('text', {
    x: -8, y: side, class: 'tick-text', 'text-anchor': 'start',
    transform: `rotate(-90,-8,${side})`,
    text: `${truncate(b.label.replace(/\s*\([^)]*\)$/, ''), 18)} →`,
  }));
  c.svg.append(key);

  legendSwatches(c.legend, [
    [grid[2][2], 'high on both'],
    [grid[0][2], `high ${truncate(a.label, 18)} only`],
    [grid[2][0], `high ${truncate(b.label, 18)} only`],
    [grid[0][0], 'low on both'],
  ]);
}

/* ---------------------------------------------------------- tile cartogram */

function viewGrid(root) {
  const ser = currentSeries();
  if (!ser) return root.append(noDeltaNotice());
  const vals = scopedValues(ser.values);
  const scale = scaleFor(vals);

  const c = card(`${ser.label} — every county the same size`,
    `${subtitleFor(ser)}. A choropleth lets big rural counties shout and small ` +
    `urban ones disappear; here each county is one equal tile, laid out to keep ` +
    `Ohio's rough geography.`);
  root.append(c.el);

  const cols = DB.grid.cols, rows = DB.grid.rows;
  const cell = 58, gap = 3;
  const W = cols * cell, H = rows * cell;
  c.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  c.svg.setAttribute('width', Math.min(W, root.clientWidth - 60));

  const active = new Set(activeNames());
  for (const cty of DB.counties) {
    if (cty.col == null) continue;
    const i = DB.byName.get(cty.name), v = vals[i];
    const k = scale.classOf(v);
    const fill = k < 0 ? 'var(--grid)' : scale.colors[k];
    const x = cty.col * cell, y = cty.row * cell;
    const g = s('g', {style: {cursor: 'pointer'}, opacity: active.has(cty.name) ? 1 : 0.16});
    g.append(s('rect', {
      x: x + gap / 2, y: y + gap / 2, width: cell - gap, height: cell - gap,
      rx: 5, fill,
      stroke: STATE.focus === cty.name ? cssVar('--text-primary') : 'none',
      'stroke-width': 2,
    }));
    const ink = inkOn(k < 0 ? (isDark() ? '#2c2c2a' : '#e1e0d9') : scale.colors[k]);
    g.append(s('text', {
      x: x + cell / 2, y: y + cell / 2 - 3, 'text-anchor': 'middle',
      'font-size': 10, 'font-weight': 600, fill: ink, 'pointer-events': 'none',
      text: cty.name.length > 8 ? cty.name.slice(0, 7) + '…' : cty.name,
    }));
    g.append(s('text', {
      x: x + cell / 2, y: y + cell / 2 + 11, 'text-anchor': 'middle',
      'font-size': 10, fill: ink, opacity: 0.8, 'pointer-events': 'none',
      style: {fontVariantNumeric: 'tabular-nums'},
      text: fmtNumber(v, ser.unit),
    }));
    hoverable(g, () => tipHTML(cty.name, [[ser.label, fmtFull(v, ser.unit)]],
      v == null ? 'No figure published for this county.' : ''));
    g.addEventListener('click', () => spotlight(cty.name));
    c.svg.append(g);
  }
  legendClasses(c.legend, scale, ser.unit);
}

/* ------------------------------------------------------------------ helpers */

function truncate(str, n) {
  return str.length <= n ? str : str.slice(0, n - 1) + '…';
}

function noDeltaNotice() {
  const m = DB.metricById.get(STATE.metric);
  return h('div', {class: 'card'}, h('div', {class: 'empty'},
    `“${m ? m.label : 'This measure'}” was only collected for ` +
    `${m ? m.years.join(' and ') : 'one year'}, so there is no change to draw. ` +
    'Turn off "Change 2017 → 2022", or pick a measure the census ran twice.'));
}

/** Headline numbers for the current slice — the "is it even a chart" case. */
function statsCard(vals, ser) {
  const f = finite(vals);
  const sorted = [...f].sort((a, b) => a - b);
  const idx = vals.map((v, i) => [v, i]).filter(d => d[0] != null)
    .sort((a, b) => b[0] - a[0]);
  const top = idx[0], bot = idx[idx.length - 1];
  const g = gini(vals);

  const stat = (k, v, sub) => h('div', {class: 'stat'},
    h('span', {class: 'k', text: k}),
    h('span', {class: 'v'}, v, sub ? h('small', {text: ' ' + sub}) : null));

  const rows = [
    stat('Counties shown', String(f.length)),
    stat('Total', ser.isDelta || STATE.mode === 'rank' ? '—'
      : fmtNumber(f.reduce((a, b) => a + b, 0), ser.unit)),
    stat('Median', fmtNumber(quantileSorted(sorted, 0.5), ser.unit)),
    top ? stat('Highest', fmtNumber(top[0], ser.unit), DB.counties[top[1]].name) : null,
    bot ? stat('Lowest', fmtNumber(bot[0], ser.unit), DB.counties[bot[1]].name) : null,
  ];
  if (g != null && !ser.isDelta && STATE.mode === 'raw') {
    rows.push(stat('Concentration', g.toFixed(2), 'Gini'));
  }
  return h('div', {class: 'card'},
    h('div', {class: 'stat-row'}, rows.filter(Boolean)),
    g != null && !ser.isDelta && STATE.mode === 'raw'
      ? h('p', {class: 'caption', style: {margin: '10px 0 0'},
          text: `A Gini of ${g.toFixed(2)} means ${g < 0.3 ? 'this is spread fairly evenly across Ohio'
            : g < 0.6 ? 'this is moderately concentrated in some counties'
            : 'this is heavily concentrated in a handful of counties'}. ` +
            'See the Concentration view for the full curve.'})
      : null);
}

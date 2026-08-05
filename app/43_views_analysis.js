/* ============================================================================
   Analytical views: scatter (and its change-arrow form), concentration curve,
   county × measure heatmap, the Ohio time series, and the discovery tools.
   ========================================================================== */

/* ------------------------------------------------------------------ scatter */

function viewScatter(root) {
  if (!STATE.metric2) {
    root.append(h('div', {class: 'card'}, h('div', {class: 'empty'},
      'Pick a second measure in the sidebar to plot one against the other.')));
    return;
  }
  const a = series(STATE.metric, STATE.year, STATE.mode);
  const b = series(STATE.metric2, STATE.year, STATE.mode);
  const keep = activeCounties();
  const pts = keep.map(i => ({i, name: DB.counties[i].name, x: a.values[i], y: b.values[i]}))
    .filter(d => d.x != null && d.y != null);
  if (pts.length < 3) return root.append(emptySelection());

  const bothYears = DB.metricById.get(STATE.metric).years.length > 1 &&
                    DB.metricById.get(STATE.metric2).years.length > 1;
  const arrows = STATE.delta && bothYears;

  const r = correlation(pts.map(d => d.x), pts.map(d => d.y));
  const c = card(`${b.label}  vs  ${a.label}`,
    `${STATE.year}${arrows ? ' — with 2017 → 2022 movement' : ''}. ` +
    (r != null
      ? `Correlation r = ${r.toFixed(2)} across ${pts.length} counties — ` +
        `${Math.abs(r) > 0.7 ? 'a strong' : Math.abs(r) > 0.4 ? 'a moderate' : 'a weak'} ` +
        `${r < 0 ? 'inverse ' : ''}relationship. Correlation is not causation; both may ` +
        `simply track how much farmland a county has.`
      : 'Too few overlapping counties to compute a correlation.'));
  root.append(c.el);

  const W = Math.max(520, Math.min(940, root.clientWidth - 72));
  const H = Math.round(W * 0.66);
  const padL = 68, padR = 24, padT = 22, padB = 56;
  c.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  c.svg.setAttribute('height', H);

  const xs = pts.map(d => d.x), ys = pts.map(d => d.y);
  const x = linScale(Math.min(0, ...xs), Math.max(...xs), padL, W - padR);
  const y = linScale(Math.min(0, ...ys), Math.max(...ys), H - padB, padT);

  for (const t of niceTicks(x.domain[0], x.domain[1], 6)) {
    c.svg.append(s('line', {x1: x(t), x2: x(t), y1: padT, y2: H - padB, class: 'grid-line'}));
    c.svg.append(s('text', {x: x(t), y: H - padB + 16, class: 'tick-text',
      'text-anchor': 'middle', text: fmtNumber(t, a.unit)}));
  }
  for (const t of niceTicks(y.domain[0], y.domain[1], 5)) {
    c.svg.append(s('line', {x1: padL, x2: W - padR, y1: y(t), y2: y(t), class: 'grid-line'}));
    c.svg.append(s('text', {x: padL - 8, y: y(t) + 4, class: 'tick-text',
      'text-anchor': 'end', text: fmtNumber(t, b.unit)}));
  }
  c.svg.append(s('text', {x: (padL + W - padR) / 2, y: H - 12, class: 'mark-label',
    'text-anchor': 'middle', text: `${a.label} →`}));
  c.svg.append(s('text', {x: 14, y: (padT + H - padB) / 2, class: 'mark-label',
    'text-anchor': 'middle', transform: `rotate(-90,14,${(padT + H - padB) / 2})`,
    text: `${b.label} →`}));

  if (arrows) {
    const y0 = DB.metricById.get(STATE.metric).years[0];
    const a0 = series(STATE.metric, y0, STATE.mode).values;
    const b0 = series(STATE.metric2, y0, STATE.mode).values;
    const defs = s('defs');
    defs.append(s('marker', {id: 'arrow', viewBox: '0 0 8 8', refX: 6, refY: 4,
      markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse'},
      s('path', {d: 'M0,0 L8,4 L0,8 z', fill: cssVar('--series-1')})));
    c.svg.append(defs);
    for (const d of pts) {
      if (a0[d.i] == null || b0[d.i] == null) continue;
      c.svg.append(s('line', {
        x1: x(a0[d.i]), y1: y(b0[d.i]), x2: x(d.x), y2: y(d.y),
        stroke: cssVar('--series-1'), 'stroke-width': 1.4, opacity: 0.45,
        'marker-end': 'url(#arrow)',
      }));
    }
  }

  const col = cssVar('--series-1');
  for (const d of pts) {
    const dot = s('circle', {
      cx: x(d.x), cy: y(d.y), r: 5.5, fill: col,
      stroke: cssVar('--surface-1'), 'stroke-width': 2,
      opacity: STATE.focus && STATE.focus !== d.name ? 0.25 : 0.9,
      style: {cursor: 'pointer'},
    });
    hoverable(dot, () => tipHTML(d.name, [
      [a.label, fmtFull(d.x, a.unit)],
      [b.label, fmtFull(d.y, b.unit)],
    ]));
    dot.addEventListener('click', () => spotlight(d.name));
    c.svg.append(dot);
    if (STATE.showLabels)
      c.svg.append(s('text', {x: x(d.x) + 8, y: y(d.y) + 3, class: 'tick-text',
        'pointer-events': 'none', text: d.name}));
  }

  clear(c.legend).append(h('span', {class: 'hint',
    text: arrows ? 'Each arrow runs from the county’s 2017 position to its 2022 position.'
                 : 'Turn on “Change 2017 → 2022” to draw each county’s movement as an arrow.'}));
}

/* ------------------------------------------------------------ concentration */

function viewConcentration(root) {
  const ser = currentSeries();
  if (!ser || ser.isDelta)
    return root.append(h('div', {class: 'card'}, h('div', {class: 'empty'},
      'Concentration is measured on levels, not changes. Turn off “Change 2017 → 2022”.')));

  const keep = activeCounties();
  const vals = keep.map(i => ser.values[i]).filter(v => v != null && v >= 0)
    .sort((a, b) => a - b);
  if (vals.length < 4) return root.append(emptySelection());

  const total = vals.reduce((a, b) => a + b, 0);
  const g = gini(vals);
  const n = vals.length;

  const c = card(`How concentrated is ${ser.label}?`,
    `${subtitleFor(ser)}. The curve plots the share of the state total held by ` +
    `the smallest counties. The straight line is perfect equality — every county ` +
    `the same. The further the curve sags, the more of Ohio's total sits in a few places.`);
  root.append(c.el);

  const W = Math.max(420, Math.min(620, root.clientWidth - 60));
  const H = W, padL = 58, padR = 20, padT = 18, padB = 52;
  c.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  c.svg.setAttribute('height', H);

  const x = linScale(0, 1, padL, W - padR);
  const y = linScale(0, 1, H - padB, padT);

  for (let t = 0; t <= 1.0001; t += 0.25) {
    c.svg.append(s('line', {x1: x(t), x2: x(t), y1: padT, y2: H - padB, class: 'grid-line'}));
    c.svg.append(s('line', {x1: padL, x2: W - padR, y1: y(t), y2: y(t), class: 'grid-line'}));
    c.svg.append(s('text', {x: x(t), y: H - padB + 16, class: 'tick-text',
      'text-anchor': 'middle', text: `${Math.round(t * 100)}%`}));
    c.svg.append(s('text', {x: padL - 8, y: y(t) + 4, class: 'tick-text',
      'text-anchor': 'end', text: `${Math.round(t * 100)}%`}));
  }

  c.svg.append(s('line', {x1: x(0), y1: y(0), x2: x(1), y2: y(1),
    stroke: cssVar('--axis'), 'stroke-width': 2}));

  const pts = [[0, 0]];
  let cum = 0;
  vals.forEach((v, i) => { cum += v; pts.push([(i + 1) / n, cum / total]); });

  const area = `M${x(0)},${y(0)} ` +
    pts.map(p => `L${x(p[0])},${y(p[1])}`).join(' ') +
    ` L${x(1)},${y(0)} Z`;
  c.svg.append(s('path', {d: area, fill: cssVar('--series-1'), opacity: 0.12}));
  c.svg.append(s('path', {
    d: 'M' + pts.map(p => `${x(p[0])},${y(p[1])}`).join(' L'),
    fill: 'none', stroke: cssVar('--series-1'), 'stroke-width': 2,
    'stroke-linejoin': 'round',
  }));

  // A few readable checkpoints instead of a dot on every county.
  for (const q of [0.5, 0.8, 0.9]) {
    const k = Math.round(q * n);
    const share = pts[k][1];
    const dot = s('circle', {cx: x(q), cy: y(share), r: 5,
      fill: cssVar('--series-1'), stroke: cssVar('--surface-1'), 'stroke-width': 2});
    hoverable(dot, () => tipHTML(`Smallest ${Math.round(q * 100)}% of counties`,
      [['Share of Ohio total', `${(share * 100).toFixed(1)}%`]]));
    c.svg.append(dot);
    c.svg.append(s('text', {x: x(q) + 8, y: y(share) + 14, class: 'tick-text',
      text: `${(share * 100).toFixed(0)}%`}));
  }

  c.svg.append(s('text', {x: (padL + W - padR) / 2, y: H - 12, class: 'mark-label',
    'text-anchor': 'middle', text: 'counties, smallest first →'}));
  c.svg.append(s('text', {x: 14, y: (padT + H - padB) / 2, class: 'mark-label',
    'text-anchor': 'middle', transform: `rotate(-90,14,${(padT + H - padB) / 2})`,
    text: 'share of the total →'}));

  const top10 = vals.slice(-Math.max(1, Math.round(n * 0.1)))
    .reduce((a, b) => a + b, 0) / total;
  root.append(h('div', {class: 'card'},
    h('div', {class: 'stat-row'},
      h('div', {class: 'stat'},
        h('span', {class: 'k', text: 'Gini coefficient'}),
        h('span', {class: 'v', text: g.toFixed(3)})),
      h('div', {class: 'stat'},
        h('span', {class: 'k', text: 'Held by the top 10% of counties'}),
        h('span', {class: 'v', text: `${(top10 * 100).toFixed(1)}%`})),
      h('div', {class: 'stat'},
        h('span', {class: 'k', text: 'Counties counted'}),
        h('span', {class: 'v', text: String(n)}))),
    h('p', {class: 'caption', style: {margin: '10px 0 0'},
      text: '0 would mean every county holds an identical amount; 1 would mean a ' +
            'single county holds all of it. Counties where the figure was withheld ' +
            'are left out, which nudges the measure down slightly.'})));

  clear(c.legend);
}

/* ------------------------------------------------------------------ heatmap */

function viewHeatmap(root) {
  const sibs = siblingMetrics(STATE.metric).slice(0, 16);
  if (sibs.length < 2)
    return root.append(h('div', {class: 'card'}, h('div', {class: 'empty'},
      'A heatmap needs several measures to compare. Pick one from a breakdown ' +
      'group — a "by size of farm" or "by value of sales" set, for instance.')));

  const keep = activeCounties();
  const cols = sibs.map(m => {
    const v = series(m.id, STATE.year, STATE.mode).values;
    const mu = mean(keep.map(i => v[i])), sd = stdev(keep.map(i => v[i]));
    return {m, v, mu, sd};
  });

  let order = keep.slice();
  order.sort((i, j) => {
    const av = cols[0].v[i], bv = cols[0].v[j];
    return (bv == null ? -Infinity : bv) - (av == null ? -Infinity : av);
  });

  const c = card(`${DB.metricById.get(STATE.metric).context} — county profile`,
    `Every county against every measure in the group, ${STATE.year}. Each column ` +
    `is standardised on its own (z-scores), so a row reads as a profile: which ` +
    `parts of this breakdown the county leans into, not how big it is overall.`);
  root.append(c.el);

  const cw = 46, rh = 15, padL = 104, padT = 96;
  const W = padL + cols.length * cw + 16;
  const H = padT + order.length * rh + 12;
  c.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  c.svg.setAttribute('width', Math.min(W, root.clientWidth - 60));
  c.svg.setAttribute('height', H);

  const scale = makeClassScale([-2.5, 2.5], {
    nClasses: 7, diverging: true, divKey: STATE.divKey, reverse: STATE.reverse, center: 0,
  });

  cols.forEach((cd, k) => {
    const cx = padL + k * cw + cw / 2;
    c.svg.append(s('text', {
      x: cx, y: padT - 8, class: 'tick-text', 'text-anchor': 'start',
      transform: `rotate(-52,${cx},${padT - 8})`,
      text: truncate(cd.m.label.replace(/\s*\([^)]*\)$/, ''), 20),
    }));
  });

  order.forEach((i, r) => {
    const name = DB.counties[i].name;
    const yy = padT + r * rh;
    c.svg.append(s('text', {x: padL - 8, y: yy + rh - 4, class: 'mark-label',
      'text-anchor': 'end', text: truncate(name, 14)}));
    cols.forEach((cd, k) => {
      const raw = cd.v[i];
      const z = (raw == null || !cd.sd) ? null : (raw - cd.mu) / cd.sd;
      const kk = z == null ? -1 : scale.classOf(z);
      const rect = s('rect', {
        x: padL + k * cw + 1, y: yy + 1, width: cw - 2, height: rh - 2, rx: 2,
        fill: kk < 0 ? 'var(--grid)' : scale.colors[kk],
        style: {cursor: 'pointer'},
      });
      hoverable(rect, () => tipHTML(`${name} — ${cd.m.label}`, [
        ['Value', fmtFull(raw, cd.m.unit)],
        ['Z-score', z == null ? '—' : z.toFixed(2)],
      ], z == null ? 'Withheld or not reported.' : ''));
      c.svg.append(rect);
    });
  });

  legendClasses(c.legend, scale, 'z-score');
  c.legend.append(h('span', {class: 'hint',
    text: 'Rows sorted by the first column.'}));
}

/* -------------------------------------------------------- Ohio time series */

function viewHistory(root) {
  // An empty array means "cleared"; undefined means "never touched", which is
  // where the two opening series come from.
  const picks = STATE.historyPicks == null ? HISTORY_DEFAULT : STATE.historyPicks;
  const chosen = DB.history.filter(hh => picks.includes(hh.label));
  if (!chosen.length) {
    root.append(h('div', {class: 'card'}, h('div', {class: 'empty'},
      'No series selected.', h('br'),
      h('span', {class: 'hint', text: 'Pick one or more below to plot them.'}))));
    root.append(historyPicker());
    return;
  }
  const list = chosen;

  const c = card('Ohio since 1997 — the long view',
    'The county tables only run 2017 and 2022. The state chapter of the same ' +
    'report carries a longer series, shown here on a common index (first ' +
    'available census = 100) so measures of very different size share one axis. ' +
    'Figures are the coverage-adjusted ones, so 1992 — published unadjusted only — ' +
    'is not included.');
  root.append(c.el);

  const W = Math.max(520, Math.min(1000, root.clientWidth - 72));
  const H = 380, padL = 54, padR = 108, padT = 24, padB = 44;
  c.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  c.svg.setAttribute('height', H);

  const years = [...new Set(list.flatMap(hh => Object.keys(hh.points)))]
    .map(Number).sort((a, b) => a - b);
  if (!years.length) return;

  const norm = list.map(hh => {
    const base = hh.points[String(years[0])] ??
      hh.points[Object.keys(hh.points).sort()[0]];
    return {
      label: hh.label,
      pts: years.map(y => {
        const v = hh.points[String(y)];
        return v == null || !base ? null : {y, v: v / base * 100, raw: v};
      }).filter(Boolean),
    };
  });

  const all = norm.flatMap(nn => nn.pts.map(p => p.v));
  const x = linScale(years[0], years[years.length - 1], padL, W - padR);
  const y = linScale(Math.min(80, ...all), Math.max(120, ...all), H - padB, padT);

  for (const t of niceTicks(y.domain[0], y.domain[1], 5)) {
    c.svg.append(s('line', {x1: padL, x2: W - padR, y1: y(t), y2: y(t), class: 'grid-line'}));
    c.svg.append(s('text', {x: padL - 8, y: y(t) + 4, class: 'tick-text',
      'text-anchor': 'end', text: String(Math.round(t))}));
  }
  c.svg.append(s('line', {x1: padL, x2: W - padR, y1: y(100), y2: y(100),
    stroke: cssVar('--axis'), 'stroke-width': 1.5}));
  for (const yr of years) {
    c.svg.append(s('text', {x: x(yr), y: H - padB + 17, class: 'tick-text',
      'text-anchor': 'middle', text: String(yr)}));
  }

  const colors = categorical(norm.length);
  norm.forEach((nn, i) => {
    const col = colors[i % colors.length];
    c.svg.append(s('path', {
      d: 'M' + nn.pts.map(p => `${x(p.y)},${y(p.v)}`).join(' L'),
      fill: 'none', stroke: col, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
    nn.pts.forEach(p => {
      const dot = s('circle', {cx: x(p.y), cy: y(p.v), r: 4.5, fill: col,
        stroke: cssVar('--surface-1'), 'stroke-width': 2});
      hoverable(dot, () => tipHTML(`${nn.label} — ${p.y}`, [
        ['Value', p.raw.toLocaleString()],
        ['Index', `${p.v.toFixed(1)} (${years[0]} = 100)`],
      ]));
      c.svg.append(dot);
    });
    const last = nn.pts[nn.pts.length - 1];
    c.svg.append(s('text', {x: x(last.y) + 9, y: y(last.v) + 4, class: 'mark-label',
      fill: col, 'font-weight': 600,
      text: truncate(nn.label.replace(/\s*\([^)]*\)$/, ''), 16)}));
  });

  legendSwatches(c.legend, norm.map((nn, i) => [colors[i % colors.length], nn.label]));
  root.append(historyPicker());
}

const HISTORY_MAX = 8;
const HISTORY_DEFAULT = ['Farms (number)', 'Land in farms (acres)'];

/**
 * Series picker for the Ohio time series.
 *
 * 113 series as a wall of truncated chips was unreadable — "Livestock and
 * poultry · Cattle and calv…" appeared seven times with no way to tell the
 * seven apart. So: full labels, grouped by the heading the census files them
 * under, searchable, and each with a sparkline and its 1997→2022 change, so
 * you can see the shape of a series before adding it.
 */
function historyPicker() {
  const picks = new Set(STATE.historyPicks == null ? HISTORY_DEFAULT : STATE.historyPicks);
  const chosen = DB.history.filter(hh => picks.has(hh.label));
  const colors = categorical(Math.max(1, chosen.length));
  const colorOf = label => {
    const i = chosen.findIndex(hh => hh.label === label);
    return i < 0 ? null : colors[i % colors.length];
  };

  const toggle = label => {
    if (picks.has(label)) picks.delete(label);
    else if (picks.size < HISTORY_MAX) picks.add(label);
    else return toast(`Eight series is the limit — remove one first.`);
    STATE.historyPicks = [...picks];
    render();
  };

  const box = h('div', {class: 'card'},
    h('h2', {text: 'Series to plot'}),
    h('p', {class: 'caption',
      text: `Ohio-wide figures from the state chapter of the report, ` +
            `${DB.history.length} of them, 1997 to 2022. Up to ${HISTORY_MAX} at a time — ` +
            `they share one indexed axis, so any mix is comparable.`}));

  /* ---- what is currently plotted, in the chart's own colours ---- */
  const sel = h('div', {class: 'hist-sel'});
  if (!chosen.length) {
    sel.append(h('span', {class: 'hint', text: 'Nothing selected — pick a series below.'}));
  } else {
    chosen.forEach(hh => {
      sel.append(h('button', {class: 'hist-tag', title: 'Remove from the chart',
        onclick: () => toggle(hh.label)},
        h('span', {class: 'sw', style: {background: colorOf(hh.label)}}),
        h('span', {text: hh.label}),
        h('span', {class: 'x', text: '×'})));
    });
    sel.append(h('button', {class: 'btn sm', text: 'Clear all', onclick: () => {
      STATE.historyPicks = []; render();
    }}));
  }
  box.append(sel);

  /* ---- the searchable list ---- */
  const q = (STATE.historyQuery || '').trim().toLowerCase();
  const search = h('input', {type: 'search', 'data-keep': 'historySearch',
    value: STATE.historyQuery || '', style: {maxWidth: '380px', margin: '10px 0 4px'},
    placeholder: 'Filter series — "hogs", "expenses", "wheat"…',
    oninput: e => {
      STATE.historyQuery = e.target.value;
      const pos = e.target.selectionStart;
      render();
      requestAnimationFrame(() => {
        const el = document.querySelector('[data-keep="historySearch"]');
        if (el) { el.focus(); el.setSelectionRange(pos, pos); }
      });
    }});
  box.append(search);

  const groups = new Map();
  for (const hh of DB.history) {
    if (q && !hh.label.toLowerCase().includes(q)) continue;
    const i = hh.label.indexOf(' · ');
    const g = i > 0 ? hh.label.slice(0, i) : 'Headline figures';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(hh);
  }

  const list = h('div', {class: 'hist-list'});
  if (!groups.size) {
    list.append(h('div', {class: 'hint', style: {padding: '12px'},
      text: `Nothing matches “${q}”.`}));
  }
  for (const [g, items] of groups) {
    list.append(h('div', {class: 'hist-group', text: g}));
    for (const hh of items) {
      const on = picks.has(hh.label);
      const leaf = hh.label.startsWith(g + ' · ') ? hh.label.slice(g.length + 3) : hh.label;
      const years = Object.keys(hh.points).sort();
      const first = hh.points[years[0]], last = hh.points[years[years.length - 1]];
      const pct = first ? (last - first) / Math.abs(first) * 100 : null;

      list.append(h('label', {class: 'hist-row' + (on ? ' on' : '')},
        h('input', {type: 'checkbox', checked: on,
          disabled: !on && picks.size >= HISTORY_MAX,
          onchange: () => toggle(hh.label)}),
        h('span', {class: 'nm', text: leaf}),
        sparkline(hh, on ? colorOf(hh.label) : null),
        h('span', {class: 'chg',
          style: {color: pct == null ? 'var(--text-muted)'
            : pct >= 0 ? 'var(--good)' : 'var(--bad)'},
          title: `${years[0]}: ${first.toLocaleString()} → ${years[years.length - 1]}: ${last.toLocaleString()}`,
          text: pct == null ? '—' : `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`})));
    }
  }
  box.append(list);
  box.append(h('p', {class: 'hint', style: {marginTop: '8px'},
    text: `${picks.size} of ${HISTORY_MAX} selected. The sparkline shows each ` +
          `series' own shape across the six censuses; the figure is its total change.`}));
  return box;
}

/** A 1997–2022 thumbnail, scaled to the series' own range. */
function sparkline(hh, color) {
  const W = 62, H = 16, pad = 1.5;
  const years = Object.keys(hh.points).sort();
  const vals = years.map(y => hh.points[y]);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const x = i => pad + (i / (years.length - 1)) * (W - pad * 2);
  const y = v => hi === lo ? H / 2 : H - pad - ((v - lo) / (hi - lo)) * (H - pad * 2);
  const svg = s('svg', {class: 'spark', width: W, height: H, viewBox: `0 0 ${W} ${H}`,
    'aria-hidden': 'true'});
  svg.append(s('path', {
    d: 'M' + vals.map((v, i) => `${x(i)},${y(v)}`).join(' L'),
    fill: 'none', stroke: color || cssVar('--axis'),
    'stroke-width': color ? 1.8 : 1.3,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));
  svg.append(s('circle', {cx: x(vals.length - 1), cy: y(vals[vals.length - 1]),
    r: 1.9, fill: color || cssVar('--axis')}));
  return svg;
}

/* ---------------------------------------------------------------- discovery */

/**
 * Two questions the census can answer but no published table does:
 * which other measure maps like this one, and which county is this one's twin.
 */
function viewDiscover(root) {
  const base = series(STATE.metric, STATE.year, STATE.mode).values;
  const keep = new Set(activeCounties());
  const masked = base.map((v, i) => (keep.has(i) ? v : null));

  // --- correlates
  const scored = [];
  for (const m of DB.metrics) {
    if (m.id === STATE.metric) continue;
    if (!m.years.includes(STATE.year) || m.coverage < 40) continue;
    const v = series(m.id, STATE.year, STATE.mode).values;
    const r = correlation(masked, v.map((x, i) => (keep.has(i) ? x : null)));
    if (r != null && isFinite(r)) scored.push({m, r});
  }
  const withIt = [...scored].sort((a, b) => b.r - a.r).slice(0, 18);
  const againstIt = [...scored].sort((a, b) => a.r - b.r).slice(0, 18)
    .filter(d => d.r < 0);

  const cur = DB.metricById.get(STATE.metric);
  const c1 = card(`What else looks like ${cur.label}?`,
    `Every one of the ${DB.metrics.length.toLocaleString()} measures in this report, ` +
    `correlated across counties against the one you have selected (${STATE.year}, ` +
    `${MODE_BY_ID.get(STATE.mode).label.toLowerCase()}). An r near 1.000 usually means ` +
    `the census published the same figure in two tables, or that both measures simply ` +
    `track how much farmland a county has — the surprises are further down, and in the ` +
    `second column. Correlation across 88 counties is not evidence of cause.`);
  root.append(c1.el);
  c1.svg.remove();

  const table = (title, list, empty) => {
    const body = list.length
      ? h('tbody', {}, list.map(({m, r}) => {
          const tr = h('tr', {style: {cursor: 'pointer'},
            title: `${m.label} — ${m.context}`},
            h('td', {class: 'num', style: {color: r < 0 ? 'var(--bad)' : 'var(--good)',
              fontWeight: '600'}, text: r.toFixed(3)}),
            h('td', {text: truncate(m.label, 48)}),
            h('td', {style: {color: 'var(--text-muted)'}, text: truncate(m.context, 26)}));
          tr.addEventListener('click', () => {
            STATE.metric2 = m.id; STATE.view = 'scatter'; render();
          });
          return tr;
        }))
      : h('tbody', {}, h('tr', {}, h('td', {colspan: 3, class: 'hint', text: empty})));
    return h('div', {style: {flex: '1 1 380px', minWidth: '0'}},
      h('h2', {style: {fontSize: '12px', marginBottom: '6px'}, text: title}),
      h('div', {class: 'scroll-x'},
        h('table', {class: 'data'},
          h('thead', {}, h('tr', {},
            h('th', {text: 'r'}), h('th', {text: 'Measure'}), h('th', {text: 'From'}))),
          body)));
  };

  c1.el.append(h('div', {style: {display: 'flex', gap: '22px', flexWrap: 'wrap'}},
    table('Moves with it', withIt, ''),
    table('Moves against it', againstIt,
      'Nothing in the report moves inversely with this measure.')));
  c1.el.append(h('p', {class: 'caption', style: {margin: '12px 0 0'},
    text: 'Click any row to plot it against your measure on the scatter view.'}));

  // --- statistical twins
  const anchor = STATE.focus || DB.counties[0].name;
  const profile = twinProfile();
  const ai = DB.byName.get(anchor);
  const twins = DB.counties.map((cty, i) => {
    if (i === ai) return null;
    let sum = 0, n = 0;
    for (const p of profile) {
      const a = p.z[ai], b = p.z[i];
      if (a == null || b == null) continue;
      sum += (a - b) ** 2; n++;
    }
    return n >= 4 ? {name: cty.name, d: Math.sqrt(sum / n), n} : null;
  }).filter(Boolean).sort((a, b) => a.d - b.d);

  const c2 = card(`Counties most like ${anchor}`,
    `Distance across ${profile.length} standardised headline measures — farm ` +
    `count and size, land use, sales mix, livestock and expenses. Lower is more ` +
    `alike. Click a county on any map to re-anchor this list.`);
  root.append(c2.el);
  c2.svg.remove();

  const grid = h('div', {style: {display: 'flex', gap: '8px', flexWrap: 'wrap'}});
  twins.slice(0, 8).forEach((t, i) => {
    grid.append(h('button', {
      class: 'btn', style: {flexDirection: 'column', alignItems: 'flex-start',
        display: 'flex', gap: '2px', minWidth: '112px', padding: '9px 11px'},
      onclick: () => { STATE.focus = t.name; render(); },
    },
      h('span', {style: {fontWeight: '600', color: 'var(--text-primary)'}, text: t.name}),
      h('span', {class: 'hint', text: `distance ${t.d.toFixed(2)}`})));
  });
  c2.el.append(grid);

  const far = twins[twins.length - 1];
  if (far) c2.el.append(h('p', {class: 'caption', style: {margin: '12px 0 0'},
    text: `Least like ${anchor}: ${far.name} (distance ${far.d.toFixed(2)}).`}));
}

/** Standardised headline measures used for the twin comparison. */
function twinProfile() {
  const wanted = [
    'Farms (number)', 'Land in farms (acres)', 'Average size of farm (acres)',
    'Market value of agricultural products sold ($1,000)',
    'Crops, including nursery and greenhouse crops ($1,000)',
    'Livestock, poultry, and their products ($1,000)',
    'Total cropland (acres)', 'Harvested cropland (acres)',
    'Irrigated land (acres)', 'Total farm production expenses ($1,000)',
  ];
  const out = [];
  for (const label of wanted) {
    const m = DB.metrics.find(o => o.label === label && o.context.startsWith('County Summary'))
           || DB.metrics.find(o => o.label === label);
    if (!m) continue;
    const v = series(m.id, '2022', 'raw').values;
    const mu = mean(v), sd = stdev(v);
    if (!sd) continue;
    out.push({m, z: v.map(x => (x == null ? null : (x - mu) / sd))});
  }
  return out;
}

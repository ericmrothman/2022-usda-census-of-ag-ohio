/* ============================================================================
   Magnitude and change: ranked bars, slope / dumbbell, and distribution.
   ========================================================================== */

/** [{i, name, v}] for the active counties, sorted and optionally truncated. */
function rows(ser) {
  const keep = activeCounties();
  let out = keep.map(i => ({i, name: DB.counties[i].name, v: ser.values[i]}));
  if (STATE.sortBy === 'name') out.sort((a, b) => a.name.localeCompare(b.name));
  else out.sort((a, b) => (b.v == null ? -Infinity : b.v) - (a.v == null ? -Infinity : a.v));
  if (STATE.topN > 0) out = out.slice(0, STATE.topN);
  return out;
}

/* ------------------------------------------------------------- ranked bars */

function viewRank(root) {
  const ser = currentSeries();
  if (!ser) return root.append(noDeltaNotice());
  const data = rows(ser);
  if (!data.length) return root.append(emptySelection());

  const c = card(ser.label, subtitleFor(ser) + (ser.note ? ' — ' + ser.note : ''));
  root.append(c.el);

  const W = Math.max(520, Math.min(1060, root.clientWidth - 72));
  const rowH = 19, padL = 108, padR = 66, padT = 26, padB = 8;
  const H = padT + data.length * rowH + padB;
  c.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  c.svg.setAttribute('height', H);

  const vals = data.map(d => d.v);
  const lo = Math.min(0, ...finite(vals)), hi = Math.max(0, ...finite(vals));
  const x = linScale(lo, hi, padL, W - padR);
  const zero = x(0);
  const anyNeg = lo < 0;

  // A single measure is one series, so one colour — unless the values carry a
  // sign, where the diverging pair states direction.
  const posC = cssVar('--series-1');
  const negC = cssVar('--series-2');

  for (const t of niceTicks(lo, hi, 5)) {
    c.svg.append(s('line', {x1: x(t), x2: x(t), y1: padT - 6, y2: H - padB, class: 'grid-line'}));
    c.svg.append(s('text', {x: x(t), y: padT - 11, class: 'tick-text', 'text-anchor': 'middle',
      text: fmtNumber(t, ser.unit)}));
  }

  data.forEach((d, k) => {
    const y = padT + k * rowH;
    const bh = rowH - 5;                       // 2px surface gap top and bottom
    c.svg.append(s('text', {
      x: padL - 8, y: y + bh - 2, class: 'mark-label', 'text-anchor': 'end',
      text: truncate(d.name, 15),
    }));
    if (d.v == null) {
      c.svg.append(s('text', {x: zero + 4, y: y + bh - 2, class: 'tick-text',
        text: 'withheld', opacity: 0.7}));
      return;
    }
    const neg = d.v < 0;
    const x0 = neg ? x(d.v) : zero, x1 = neg ? zero : x(d.v);
    const w = Math.max(1, x1 - x0);
    const fill = anyNeg ? (neg ? negC : posC) : posC;
    const bar = s('rect', {
      x: x0, y: y + 1, width: w, height: bh, fill,
      rx: 4, ry: 4,
      opacity: STATE.focus && STATE.focus !== d.name ? 0.35 : 1,
      style: {cursor: 'pointer'},
    });
    hoverable(bar, () => tipHTML(d.name, [[ser.label, fmtFull(d.v, ser.unit)]]));
    bar.addEventListener('click', () => spotlight(d.name));
    c.svg.append(bar);
    c.svg.append(s('text', {
      x: neg ? x0 - 6 : x1 + 6, y: y + bh - 2, class: 'tick-text',
      'text-anchor': neg ? 'end' : 'start',
      text: fmtNumber(d.v, ser.unit),
    }));
  });

  if (anyNeg)
    c.svg.append(s('line', {x1: zero, x2: zero, y1: padT - 6, y2: H - padB, class: 'axis-line'}));

  if (anyNeg) legendSwatches(c.legend, [[posC, 'increase'], [negC, 'decrease']]);
  else clear(c.legend).append(h('span', {class: 'hint',
    text: ser.unit ? `Values in ${ser.unit}.` : ''}));
}

/* ------------------------------------------------- slope / dumbbell 2017-22 */

function viewChange(root) {
  const m = DB.metricById.get(STATE.metric);
  const pair = deltaYears(STATE.metric);
  if (!m || !pair) return root.append(noDeltaNotice());
  const [from, to] = pair;
  const a = series(STATE.metric, from, STATE.mode);
  const b = series(STATE.metric, to, STATE.mode);

  const keep = activeCounties();
  let data = keep.map(i => ({
    i, name: DB.counties[i].name, a: a.values[i], b: b.values[i],
  })).filter(d => d.a != null && d.b != null);
  data.sort((x, y) => (y.b - y.a) - (x.b - x.a));
  if (STATE.topN > 0) {
    // Keep the largest movers at both ends rather than one arbitrary end.
    const n = Math.max(2, Math.floor(STATE.topN / 2));
    data = [...data.slice(0, n), ...data.slice(-n)];
  }
  if (!data.length) return root.append(emptySelection());

  const modeNote = STATE.mode === 'raw' ? unitNote(m.unit)
    : MODE_BY_ID.get(STATE.mode).label;
  const c = card(`${m.label}: ${from} → ${to}`,
    [m.context, modeNote].filter(Boolean).join(' · ') +
    `. Each line is one county; its length is the change between the two ` +
    `censuses. Counties where either year was withheld are omitted.`);
  root.append(c.el);

  const W = Math.max(520, Math.min(1000, root.clientWidth - 72));
  const rowH = 17, padT = 34, padB = 26, padL = 108, padR = 108;
  const H = padT + data.length * rowH + padB;
  c.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  c.svg.setAttribute('height', H);

  const all = data.flatMap(d => [d.a, d.b]);
  const lo = Math.min(...all), hi = Math.max(...all);
  const x = linScale(Math.min(0, lo), hi, padL, W - padR);

  const up = cssVar('--series-1'), down = cssVar('--series-2');

  for (const t of niceTicks(Math.min(0, lo), hi, 5)) {
    c.svg.append(s('line', {x1: x(t), x2: x(t), y1: padT - 8, y2: H - padB, class: 'grid-line'}));
    c.svg.append(s('text', {x: x(t), y: padT - 14, class: 'tick-text',
      'text-anchor': 'middle', text: fmtNumber(t, a.unit)}));
  }

  data.forEach((d, k) => {
    const y = padT + k * rowH + rowH / 2;
    const rise = d.b >= d.a;
    const col = rise ? up : down;
    c.svg.append(s('text', {x: padL - 10, y: y + 4, class: 'mark-label',
      'text-anchor': 'end', text: truncate(d.name, 15)}));
    c.svg.append(s('line', {
      x1: x(d.a), x2: x(d.b), y1: y, y2: y, stroke: col, 'stroke-width': 2,
      'stroke-linecap': 'round', opacity: 0.55,
    }));
    // Hollow start, solid end: the direction reads without relying on colour.
    c.svg.append(s('circle', {cx: x(d.a), cy: y, r: 4, fill: cssVar('--surface-1'),
      stroke: col, 'stroke-width': 2}));
    const end = s('circle', {cx: x(d.b), cy: y, r: 4.5, fill: col,
      stroke: cssVar('--surface-1'), 'stroke-width': 2, style: {cursor: 'pointer'}});
    const pct = d.a !== 0 ? ((d.b - d.a) / Math.abs(d.a) * 100) : null;
    hoverable(end, () => tipHTML(d.name, [
      [from, fmtFull(d.a, a.unit)],
      [to, fmtFull(d.b, b.unit)],
      ['Change', `${d.b - d.a >= 0 ? '+' : ''}${fmtNumber(d.b - d.a, a.unit)}` +
        (pct != null ? ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)` : '')],
    ]));
    end.addEventListener('click', () => spotlight(d.name));
    c.svg.append(end);
    c.svg.append(s('text', {
      x: W - padR + 10, y: y + 4, class: 'tick-text',
      fill: rise ? 'var(--good)' : 'var(--bad)',
      text: (pct == null ? '—' : `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`),
    }));
  });

  legendSwatches(c.legend, [[up, `higher in ${to}`], [down, `lower in ${to}`]]);
  c.legend.append(h('span', {class: 'hint',
    text: `Hollow dot = ${from}, solid dot = ${to}.`}));
}

/* ------------------------------------------------------------ distribution */

function viewDistribution(root) {
  const ser = currentSeries();
  if (!ser) return root.append(noDeltaNotice());
  const keep = activeCounties();
  const data = keep.map(i => ({i, name: DB.counties[i].name, v: ser.values[i]}))
    .filter(d => d.v != null);
  if (data.length < 3) return root.append(emptySelection());

  const c = card(`How ${ser.label} is spread across counties`,
    `${subtitleFor(ser)}. Every county is one dot, nudged vertically only so ` +
    `they don't overlap — horizontal position is the value.`);
  root.append(c.el);

  const W = Math.max(520, Math.min(1060, root.clientWidth - 72));
  const H = 300, padL = 40, padR = 30, padT = 30, padB = 52;
  c.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  c.svg.setAttribute('height', H);

  const vals = data.map(d => d.v);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const x = linScale(Math.min(lo, 0), hi, padL, W - padR);

  for (const t of niceTicks(Math.min(lo, 0), hi, 6)) {
    c.svg.append(s('line', {x1: x(t), x2: x(t), y1: padT, y2: H - padB, class: 'grid-line'}));
    c.svg.append(s('text', {x: x(t), y: H - padB + 16, class: 'tick-text',
      'text-anchor': 'middle', text: fmtNumber(t, ser.unit)}));
  }

  // quartile band behind the dots
  const sorted = [...vals].sort((p, q) => p - q);
  const q1 = quantileSorted(sorted, 0.25), med = quantileSorted(sorted, 0.5),
        q3 = quantileSorted(sorted, 0.75);
  c.svg.append(s('rect', {x: x(q1), y: padT, width: Math.max(1, x(q3) - x(q1)),
    height: H - padB - padT, fill: cssVar('--grid'), opacity: 0.55, rx: 4}));
  c.svg.append(s('line', {x1: x(med), x2: x(med), y1: padT, y2: H - padB,
    stroke: cssVar('--axis'), 'stroke-width': 2}));
  c.svg.append(s('text', {x: x(med), y: padT - 8, class: 'tick-text',
    'text-anchor': 'middle', text: `median ${fmtNumber(med, ser.unit)}`}));

  // beeswarm: place each dot at its value, stepping down when it would collide
  const r = 5, midY = (padT + H - padB) / 2;
  const placed = [];
  data.sort((p, q) => p.v - q.v).forEach(d => {
    const cx = x(d.v);
    let k = 0, cy = midY;
    while (placed.some(p => Math.abs(p.cx - cx) < r * 2 && Math.abs(p.cy - cy) < r * 2)) {
      k++;
      cy = midY + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (r * 2 + 1);
      if (Math.abs(cy - midY) > (H - padB - padT) / 2 - r) { cy = midY; break; }
    }
    placed.push({cx, cy});
    const dot = s('circle', {
      cx, cy, r, fill: cssVar('--series-1'),
      stroke: cssVar('--surface-1'), 'stroke-width': 2,
      opacity: STATE.focus && STATE.focus !== d.name ? 0.3 : 0.95,
      style: {cursor: 'pointer'},
    });
    hoverable(dot, () => tipHTML(d.name, [[ser.label, fmtFull(d.v, ser.unit)]]));
    dot.addEventListener('click', () => spotlight(d.name));
    c.svg.append(dot);
  });

  clear(c.legend).append(h('span', {class: 'hint',
    text: `Shaded band = the middle half of counties (${fmtNumber(q1, ser.unit)}` +
          ` to ${fmtNumber(q3, ser.unit)}). ${data.length} counties plotted.`}));
  root.append(statsCard(ser.values.map((v, i) =>
    keep.includes(i) ? v : null), ser));
}

function emptySelection() {
  return h('div', {class: 'card'}, h('div', {class: 'empty'},
    'No counties in the current selection. ',
    h('br'), 'Clear the county filter in the sidebar to bring them back.'));
}

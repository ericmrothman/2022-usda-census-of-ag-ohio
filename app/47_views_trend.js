/* ============================================================================
   County trend — one measure, every county, across all five censuses.

   The printed Ohio volume only carries 2017 and 2022, so "change" there is a
   single hop. USDA's Quick Stats release runs 2002 to 2022, which turns the
   same question into an actual trajectory: which counties grew, which fell
   away, and which reversed somewhere in the middle. A 2017→2022 dumbbell
   cannot show a reversal at all.
   ========================================================================== */

function viewTrend(root) {
  const m = DB.metricById.get(STATE.metric);
  if (!m || m.years.length < 3) {
    root.append(h('div', {class: 'card'}, h('div', {class: 'empty'},
      m ? `“${truncate(m.label, 60)}” covers ${m.years.join(' and ')} only.` : 'No measure selected.',
      h('br'),
      h('span', {class: 'hint', text:
        'A trend needs three or more censuses. The measures drawn from USDA ' +
        'Quick Stats carry all five (2002–2022) — open All measures and filter ' +
        'to that source, or use the button below.'}),
      h('br'), h('br'),
      h('button', {class: 'btn primary', text: 'Show me the five-census measures',
        onclick: () => {
          STATE.view = 'browse'; STATE.browseSource = 'quickstats'; render();
        }}))));
    return;
  }

  const years = m.years;
  const keep = activeCounties();
  const indexed = STATE.trendMode !== 'absolute';

  // One line per county. Indexing to the first census lets counties of wildly
  // different size share an axis; absolute keeps the real magnitudes.
  const lines = keep.map(i => {
    const pts = years.map(y => {
      const v = series(STATE.metric, y, STATE.mode).values[i];
      return v == null ? null : {y, v};
    }).filter(Boolean);
    if (pts.length < 2) return null;
    const base = pts[0].v;
    return {
      i, name: DB.counties[i].name, pts, base,
      last: pts[pts.length - 1].v,
      change: base ? (pts[pts.length - 1].v - base) / Math.abs(base) * 100 : null,
    };
  }).filter(Boolean);

  if (!lines.length) return root.append(emptySelection());

  const unit = series(STATE.metric, years[years.length - 1], STATE.mode).unit;
  const c = card(`${m.label} — ${years[0]} to ${years[years.length - 1]}`,
    `${sourceLabel(m)}. One line per county across ${years.length} censuses` +
    (indexed ? `, indexed to ${years[0]} = 100 so counties of different size ` +
      `share an axis` : `, at actual values`) +
    `. Counties where a census withheld the figure are drawn with a gap.` +
    (STATE.focus ? ` ${STATE.focus} is highlighted.` : ''));
  root.append(c.el);

  c.el.insertBefore(h('div', {class: 'row', style: {margin: '0 0 12px'}},
    segmented([
      {id: 'indexed', label: `Indexed (${years[0]} = 100)`,
       desc: 'Every county starts at 100, so the shape of the change is comparable.'},
      {id: 'absolute', label: 'Actual values',
       desc: 'Real magnitudes — a few large counties will dominate.'},
    ], indexed ? 'indexed' : 'absolute',
      v => { STATE.trendMode = v; render(); })), c.svg);

  const W = Math.max(520, Math.min(1000, root.clientWidth - 72));
  const H = Math.round(W * 0.55);
  const padL = 62, padR = 120, padT = 20, padB = 44;
  c.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  c.svg.setAttribute('height', H);

  const val = d => indexed
    ? (d.base ? p => p.v / d.base * 100 : () => null)
    : p => p.v;

  const allY = [];
  for (const d of lines) {
    const f = val(d);
    for (const p of d.pts) { const v = f(p); if (v != null && isFinite(v)) allY.push(v); }
  }
  if (!allY.length) return;

  const yr = years.map(Number);
  const x = linScale(yr[0], yr[yr.length - 1], padL, W - padR);
  const y = linScale(Math.min(...allY), Math.max(...allY), H - padB, padT);

  for (const t of niceTicks(y.domain[0], y.domain[1], 5)) {
    c.svg.append(s('line', {x1: padL, x2: W - padR, y1: y(t), y2: y(t), class: 'grid-line'}));
    c.svg.append(s('text', {x: padL - 8, y: y(t) + 4, class: 'tick-text',
      'text-anchor': 'end', text: fmtNumber(t, indexed ? '' : unit)}));
  }
  if (indexed) {
    c.svg.append(s('line', {x1: padL, x2: W - padR, y1: y(100), y2: y(100),
      stroke: cssVar('--axis'), 'stroke-width': 1.5}));
  }
  for (const yy of yr) {
    c.svg.append(s('text', {x: x(yy), y: H - padB + 17, class: 'tick-text',
      'text-anchor': 'middle', text: String(yy)}));
  }

  // Every county in a recessive ink, the spotlighted one on top in the series
  // colour: 88 individually-coloured lines would be unreadable, and the
  // categorical palette only carries eight slots anyway.
  const quiet = cssVar('--axis');
  const loud = cssVar('--series-1');
  const up = cssVar('--good'), down = cssVar('--bad');

  const draw = (d, on) => {
    const f = val(d);
    const pts = d.pts.map(p => [x(Number(p.y)), y(f(p))])
      .filter(q => q[1] != null && isFinite(q[1]));
    if (pts.length < 2) return;
    const path = s('path', {
      d: 'M' + pts.map(q => `${q[0]},${q[1]}`).join(' L'),
      fill: 'none',
      stroke: on ? loud : quiet,
      'stroke-width': on ? 2.5 : 1,
      opacity: on ? 1 : (STATE.focus ? 0.18 : 0.35),
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      style: {cursor: 'pointer'},
    });
    hoverable(path, () => tipHTML(d.name, [
      ...d.pts.map(p => [p.y, fmtFull(p.v, unit)]),
      ['Change', d.change == null ? '—'
        : `${d.change >= 0 ? '+' : ''}${d.change.toFixed(1)}%`],
    ], d.pts.length < years.length
      ? `${years.length - d.pts.length} census year(s) withheld for this county.` : ''));
    path.addEventListener('click', () => spotlight(d.name));
    c.svg.append(path);
    if (on) {
      for (const q of pts)
        c.svg.append(s('circle', {cx: q[0], cy: q[1], r: 4, fill: loud,
          stroke: cssVar('--surface-1'), 'stroke-width': 2}));
      c.svg.append(s('text', {x: pts[pts.length - 1][0] + 9,
        y: pts[pts.length - 1][1] + 4, class: 'mark-label',
        fill: loud, 'font-weight': 600, text: d.name}));
    }
  };

  for (const d of lines) if (d.name !== STATE.focus) draw(d, false);
  const hero = lines.find(d => d.name === STATE.focus);
  if (hero) draw(hero, true);

  // Name the extremes so the chart says something without a hover.
  const ranked = lines.filter(d => d.change != null)
    .sort((a, b) => b.change - a.change);
  if (ranked.length >= 2 && !hero) {
    for (const [d, col] of [[ranked[0], up], [ranked[ranked.length - 1], down]]) {
      const f = val(d);
      const lastPt = d.pts[d.pts.length - 1];
      const yy = y(f(lastPt));
      if (yy == null || !isFinite(yy)) continue;
      c.svg.append(s('text', {x: x(Number(lastPt.y)) + 9, y: yy + 4,
        class: 'mark-label', fill: col, 'font-weight': 600,
        text: `${d.name} ${d.change >= 0 ? '+' : ''}${d.change.toFixed(0)}%`}));
    }
  }

  clear(c.legend).append(h('span', {class: 'hint',
    text: `${lines.length} counties drawn. Click a line to hold it; click again to release.`}));

  root.append(trendSummary(lines, years, unit));
}

/** Who rose, who fell, and where the turning points are. */
function trendSummary(lines, years, unit) {
  const withChange = lines.filter(d => d.change != null);
  const rose = withChange.filter(d => d.change > 0).length;
  const fell = withChange.filter(d => d.change < 0).length;
  const ranked = [...withChange].sort((a, b) => b.change - a.change);

  // A county that moved one way then the other is invisible in a two-point
  // comparison — this is the whole reason for carrying five censuses.
  const reversals = lines.filter(d => {
    if (d.pts.length < 3) return false;
    const deltas = d.pts.slice(1).map((p, k) => p.v - d.pts[k].v);
    return deltas.some(v => v > 0) && deltas.some(v => v < 0);
  }).length;

  const stat = (k, v, sub) => h('div', {class: 'stat'},
    h('span', {class: 'k', text: k}),
    h('span', {class: 'v'}, v, sub ? h('small', {text: ' ' + sub}) : null));

  return h('div', {class: 'card'},
    h('div', {class: 'stat-row'},
      stat('Higher in ' + years[years.length - 1], String(rose)),
      stat('Lower', String(fell)),
      ranked[0] ? stat('Biggest rise',
        `${ranked[0].change >= 0 ? '+' : ''}${ranked[0].change.toFixed(0)}%`,
        ranked[0].name) : null,
      ranked.length ? stat('Biggest fall',
        `${ranked[ranked.length - 1].change.toFixed(0)}%`,
        ranked[ranked.length - 1].name) : null,
      stat('Changed direction', String(reversals), 'counties')),
    h('p', {class: 'caption', style: {margin: '10px 0 0'},
      text: `${reversals} of ${lines.length} counties moved one way and then the ` +
        `other somewhere between ${years[0]} and ${years[years.length - 1]}. ` +
        `A comparison of just the two most recent censuses would show none of them.`}));
}

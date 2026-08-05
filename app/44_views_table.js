/* ============================================================================
   The table view — the accessible twin of every chart — and file export.
   ========================================================================== */

function viewTable(root) {
  const m = DB.metricById.get(STATE.metric);
  const years = m.years;
  const keep = activeCounties();

  const cols = [
    {k: 'name', label: 'County', num: false},
    ...years.map(y => ({k: y, label: y, num: true})),
  ];
  if (years.length > 1) {
    cols.push({k: 'chg', label: 'Change', num: true});
    cols.push({k: 'pct', label: '% change', num: true});
  }
  cols.push({k: 'rank', label: 'Rank', num: true});
  cols.push({k: 'share', label: '% of Ohio', num: true});

  const byYear = Object.fromEntries(years.map(y =>
    [y, series(STATE.metric, y, STATE.mode)]));
  const last = years[years.length - 1];
  const lastVals = byYear[last].values;
  const ranked = lastVals.map((v, i) => [v, i]).filter(d => d[0] != null)
    .sort((a, b) => b[0] - a[0]);
  const rankOf = new Map(ranked.map(([, i], k) => [i, k + 1]));
  const total = ohioValue(STATE.metric, last) ??
    finite(lastVals).reduce((a, b) => a + b, 0);

  let data = keep.map(i => {
    const row = {i, name: DB.counties[i].name};
    years.forEach(y => { row[y] = byYear[y].values[i]; });
    if (years.length > 1) {
      const a = row[years[0]], b = row[last];
      row.chg = (a == null || b == null) ? null : b - a;
      row.pct = (a == null || b == null || a === 0) ? null : (b - a) / Math.abs(a) * 100;
    }
    row.rank = rankOf.get(i) ?? null;
    row.share = (row[last] == null || !total) ? null : row[last] / total * 100;
    return row;
  });

  const sortKey = STATE.tableSort || last;
  const dir = STATE.tableDir ?? -1;
  data.sort((a, b) => {
    const x = a[sortKey], y = b[sortKey];
    if (sortKey === 'name') return a.name.localeCompare(b.name) * (dir < 0 ? -1 : 1);
    if (x == null) return 1;
    if (y == null) return -1;
    return (x - y) * dir;
  });

  const c = card(`${m.label} — every value`,
    `${m.context} · ${m.table} of the county chapter. ` +
    `${MODE_BY_ID.get(STATE.mode).label}. A dash means the census withheld the ` +
    `figure to avoid identifying an individual operation, or never collected it.`);
  c.svg.remove();
  root.append(c.el);

  const unit = byYear[last].unit;
  const thead = h('thead', {}, h('tr', {}, cols.map(col =>
    h('th', {
      class: col.num ? 'num' : '', style: col.num ? {textAlign: 'right'} : {},
      text: col.label + (sortKey === col.k ? (dir < 0 ? '  ↓' : '  ↑') : ''),
      onclick: () => {
        STATE.tableDir = STATE.tableSort === col.k ? -(STATE.tableDir ?? -1) : -1;
        STATE.tableSort = col.k;
        render();
      },
    }))));

  const tbody = h('tbody', {}, data.map(row => h('tr', {},
    cols.map(col => {
      if (col.k === 'name')
        return h('td', {}, h('button', {
          class: 'btn sm', style: {border: 0, background: 'none', padding: 0,
            color: STATE.focus === row.name ? 'var(--accent)' : 'inherit',
            fontWeight: STATE.focus === row.name ? '650' : '500'},
          text: row.name,
          onclick: () => { STATE.focus = row.name; render(); },
        }));
      const v = row[col.k];
      const txt = v == null ? '—'
        : col.k === 'pct' ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
        : col.k === 'share' ? `${v.toFixed(2)}%`
        : col.k === 'rank' ? String(v)
        : fmtNumber(v, unit);
      const style = {};
      if (col.k === 'pct' && v != null) style.color = v >= 0 ? 'var(--good)' : 'var(--bad)';
      return h('td', {class: 'num', style, text: txt});
    }))));

  c.el.append(h('div', {class: 'scroll-x', style: {maxHeight: '62vh', overflowY: 'auto'}},
    h('table', {class: 'data'}, thead, tbody)));

  const ohioRow = ohioValue(STATE.metric, last);
  if (ohioRow != null)
    c.el.append(h('p', {class: 'caption', style: {margin: '12px 0 0'},
      text: `Ohio total, ${last}: ${fmtFull(ohioRow, m.unit)}. ` +
        `Published county figures for this measure sum to ` +
        `${fmtNumber(finite(rawSeries(STATE.metric, last)).reduce((a, b) => a + b, 0), m.unit)}` +
        ` — any gap is withheld values.`}));
}

/* -------------------------------------------------------------------- export */

/** Inline the computed theme colours so the exported file stands alone. */
function standaloneSVG(svg) {
  const clone = svg.cloneNode(true);
  const cs = getComputedStyle(document.documentElement);
  const vars = ['--surface-1', '--text-primary', '--text-secondary', '--text-muted',
    '--grid', '--axis', '--series-1', '--series-2', '--series-3', '--series-4',
    '--series-5', '--series-6', '--series-7', '--series-8', '--good', '--bad'];
  const resolved = Object.fromEntries(vars.map(v => [v, cs.getPropertyValue(v).trim()]));

  clone.querySelectorAll('*').forEach(el => {
    for (const attr of ['fill', 'stroke']) {
      const val = el.getAttribute(attr);
      if (val && val.startsWith('var(')) {
        const key = val.slice(4, -1).trim().split(',')[0].trim();
        if (resolved[key]) el.setAttribute(attr, resolved[key]);
      }
    }
  });

  const box = svg.viewBox.baseVal;
  const w = box && box.width ? box.width : svg.clientWidth;
  const hh = box && box.height ? box.height : svg.clientHeight;
  clone.setAttribute('xmlns', SVG_NS);
  clone.setAttribute('width', w);
  clone.setAttribute('height', hh);
  clone.setAttribute('viewBox', `0 0 ${w} ${hh}`);

  const style = document.createElementNS(SVG_NS, 'style');
  style.textContent = `
    text { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    .tick-text { fill: ${resolved['--text-muted']}; font-size: 11px; }
    .mark-label { fill: ${resolved['--text-secondary']}; font-size: 11px; }
    .title-text { fill: ${resolved['--text-primary']}; font-size: 13px; font-weight: 600; }
    .grid-line { stroke: ${resolved['--grid']}; stroke-width: 1; }
    .axis-line { stroke: ${resolved['--axis']}; stroke-width: 1; }
    .geo-stroke { stroke: ${resolved['--surface-1']}; stroke-width: 1.2; }
  `;
  clone.insertBefore(style, clone.firstChild);

  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('width', w); bg.setAttribute('height', hh);
  bg.setAttribute('fill', resolved['--surface-1']);
  clone.insertBefore(bg, style.nextSibling);

  return {markup: new XMLSerializer().serializeToString(clone), w, h: hh};
}

function firstChart() {
  return document.querySelector('#canvas svg.chart');
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', {href: url, download: filename});
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportName(ext) {
  const m = DB.metricById.get(STATE.metric);
  const slug = (m ? m.label : 'chart').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return `ohio-ag-${STATE.view}-${slug}.${ext}`;
}

function exportSVG() {
  const svg = firstChart();
  if (!svg) return toast('This view has no chart to export — try the CSV.');
  const {markup} = standaloneSVG(svg);
  download(new Blob([markup], {type: 'image/svg+xml;charset=utf-8'}), exportName('svg'));
}

function exportPNG(scale = 2) {
  const svg = firstChart();
  if (!svg) return toast('This view has no chart to export — try the CSV.');
  const {markup, w, h: hh} = standaloneSVG(svg);
  const img = new Image();
  const blob = new Blob([markup], {type: 'image/svg+xml;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(hh * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = cssVar('--surface-1');
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(b => {
      download(b, exportName('png'));
      URL.revokeObjectURL(url);
    }, 'image/png');
  };
  img.onerror = () => { toast('Could not rasterise this chart; the SVG export will work.');
    URL.revokeObjectURL(url); };
  img.src = url;
}

function exportCSV() {
  const m = DB.metricById.get(STATE.metric);
  const years = m.years;
  const keep = activeCounties();
  const head = ['county', 'fips', ...years.map(y => `${y}_${STATE.mode}`)];
  if (years.length > 1) head.push('change', 'pct_change');
  const lines = [head.join(',')];
  const byYear = Object.fromEntries(years.map(y => [y, series(STATE.metric, y, STATE.mode).values]));
  for (const i of keep) {
    const cty = DB.counties[i];
    const cells = [cty.name, cty.fips, ...years.map(y => byYear[y][i] ?? '')];
    if (years.length > 1) {
      const a = byYear[years[0]][i], b = byYear[years[years.length - 1]][i];
      cells.push(a == null || b == null ? '' : b - a);
      cells.push(a == null || b == null || a === 0 ? '' : ((b - a) / Math.abs(a) * 100).toFixed(3));
    }
    lines.push(cells.map(v => (typeof v === 'string' && v.includes(',') ? `"${v}"` : v)).join(','));
  }
  lines.push('');
  lines.push(`# ${m.label} — ${m.context} (${m.table}, county chapter)`);
  lines.push(`# ${DB.source}`);
  lines.push('# Blank = withheld by the census to avoid disclosing an individual operation.');
  download(new Blob([lines.join('\n')], {type: 'text/csv;charset=utf-8'}), exportName('csv'));
}

function toast(msg) {
  const t = h('div', {
    text: msg,
    style: {position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
      background: 'var(--panel)', color: 'var(--text-primary)', padding: '9px 14px',
      border: '1px solid var(--border-strong)', borderRadius: '8px', zIndex: '200',
      boxShadow: 'var(--shadow)', fontSize: '13px'},
  });
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

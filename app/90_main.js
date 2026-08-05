/* ============================================================================
   Wiring: view registry, render loop, boot.
   ========================================================================== */

const VIEWS = [
  {id: 'stories',   label: 'Key findings',  fn: viewStories},
  {id: 'map',       label: 'Map',            fn: viewMap},
  {id: 'grid',      label: 'Tile grid',      fn: viewGrid},
  {id: 'bivariate', label: 'Two at once',    fn: viewBivariate},
  {id: 'rank',      label: 'Ranked bars',    fn: viewRank},
  {id: 'change',    label: 'Change',         fn: viewChange},
  {id: 'small',     label: 'Small multiples', fn: viewSmallMultiples},
  {id: 'treemap',   label: 'Treemap',        fn: viewTreemap},
  {id: 'waffle',    label: 'Waffle',         fn: viewWaffle},
  {id: 'donut',     label: 'Donut',          fn: viewDonut},
  {id: 'dist',      label: 'Distribution',   fn: viewDistribution},
  {id: 'scatter',   label: 'Scatter',        fn: viewScatter},
  {id: 'heatmap',   label: 'Heatmap',        fn: viewHeatmap},
  {id: 'conc',      label: 'Concentration',  fn: viewConcentration},
  {id: 'history',   label: 'Ohio over time', fn: viewHistory},
  {id: 'discover',  label: 'Discover',       fn: viewDiscover},
  {id: 'table',     label: 'Table',          fn: viewTable},
];

/** Some views describe measures rather than counties; they choose their own split. */
const PARTS_VIEWS = new Set(['treemap', 'waffle', 'donut']);

let rafToken = null;

function render() {
  if (rafToken) cancelAnimationFrame(rafToken);
  rafToken = requestAnimationFrame(() => {
    rafToken = null;
    try {
      paintViewbar();
      buildSidebar($('#sidebar'));
      const canvas = clear($('#canvas'));
      const view = VIEWS.find(v => v.id === STATE.view) || VIEWS[0];
      if (PARTS_VIEWS.has(view.id)) canvas.append(partsToggle());
      view.fn(canvas);
      canvas.append(sourceFooter());
    } catch (err) {
      console.error(err);
      clear($('#canvas')).append(h('div', {class: 'card'},
        h('div', {class: 'empty'},
          'That combination could not be drawn.', h('br'),
          h('span', {class: 'hint', text: String(err && err.message || err)}))));
    }
    writeHash();
  });
}

/**
 * Source credit, on every view. The census is public-domain federal data, so
 * the citation is courtesy rather than licence — but a chart that travels
 * should say where its numbers came from.
 */
function sourceFooter() {
  return h('footer', {style: {padding: '2px 4px 6px', fontSize: '11px',
    lineHeight: '1.5', color: 'var(--text-muted)'}},
    h('span', {text: DB.source}),
    h('span', {text: '  ·  '}),
    h('a', {href: 'https://www.nass.usda.gov/AgCensus', target: '_blank',
      rel: 'noopener', style: {color: 'inherit'}, text: 'nass.usda.gov/AgCensus'}));
}

function paintViewbar() {
  const bar = clear($('#viewbar'));
  for (const v of VIEWS) {
    bar.append(h('button', {
      role: 'tab', 'aria-selected': String(v.id === STATE.view), text: v.label,
      onclick: () => { STATE.view = v.id; render(); },
    }));
  }
}

/** Part-to-whole charts can split by county or by sibling measure. */
function partsToggle() {
  const by = STATE.partsBy || 'county';
  return h('div', {class: 'card', style: {padding: '10px 14px'}},
    h('div', {class: 'row'},
      h('span', {class: 'hint', style: {marginRight: '4px'}, text: 'Divide by'}),
      segmented([
        {id: 'county', label: 'County', desc: 'Split the measure across counties.'},
        {id: 'metric', label: 'Measure', desc: 'Split the county total across the measures reported alongside it.'},
      ], by, v => { STATE.partsBy = v; render(); })));
}

/* -------------------------------------------------------------- URL sharing */

const HASH_KEYS = ['view', 'metric', 'metric2', 'year', 'mode', 'delta', 'deltaPct',
  'ramp', 'diverging', 'divKey', 'reverse', 'nClasses', 'breakMode', 'exclude',
  'showLabels', 'sortBy', 'topN', 'partsBy', 'focus', 'storyCounty'];

function writeHash() {
  const o = {};
  for (const k of HASH_KEYS) if (STATE[k] != null && STATE[k] !== false) o[k] = STATE[k];
  if (STATE.selected && STATE.selected.size) o.sel = [...STATE.selected].join('|');
  const q = new URLSearchParams(o).toString();
  history.replaceState(null, '', `#${q}`);
}

function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  if (![...q].length) return;
  for (const k of HASH_KEYS) {
    if (!q.has(k)) continue;
    const raw = q.get(k);
    STATE[k] = raw === 'true' ? true : raw === 'false' ? false
      : /^-?\d+$/.test(raw) ? +raw : raw;
  }
  if (q.has('sel')) STATE.selected = new Set(q.get('sel').split('|'));
}

/* --------------------------------------------------------------------- boot */

function buildShell() {
  document.body.append(
    h('div', {id: 'app'},
      h('header', {},
        h('div', {class: 'brand'},
          h('h1', {text: 'Ohio Agriculture Explorer'}),
          h('span', {class: 'sub', text: '2022 Census of Agriculture · 88 counties'})),
        h('div', {class: 'head-spacer'}),
        h('div', {class: 'head-actions'},
          h('button', {class: 'btn', text: 'SVG', title: 'Download the current chart as SVG',
            onclick: exportSVG}),
          h('button', {class: 'btn', text: 'PNG', title: 'Download the current chart as a 2× PNG',
            onclick: () => exportPNG(2)}),
          h('button', {class: 'btn', text: 'CSV', title: 'Download the data behind this view',
            onclick: exportCSV}),
          h('button', {class: 'btn', id: 'themeBtn', text: 'Theme',
            title: 'Switch between light and dark',
            onclick: () => {
              const el = document.documentElement;
              el.dataset.theme = el.dataset.theme === 'dark' ? 'light' : 'dark';
              saveState();
              render();
            }}))),
      h('aside', {id: 'sidebar'}),
      h('main', {},
        h('div', {class: 'viewbar', id: 'viewbar', role: 'tablist'}),
        h('div', {class: 'canvas-wrap', id: 'canvas'}))),
    h('div', {id: 'tooltip'}));
}

async function boot() {
  loadState();
  if (!document.documentElement.dataset.theme) {
    document.documentElement.dataset.theme =
      matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  buildShell();

  let payload;
  try {
    payload = await loadPayload();
  } catch (err) {
    $('#canvas').append(h('div', {class: 'card'}, h('div', {class: 'empty'},
      'Could not unpack the embedded data.', h('br'),
      h('span', {class: 'hint', text: String(err.message || err)}), h('br'),
      h('span', {class: 'hint',
        text: 'This page needs a browser with DecompressionStream — Chrome 80+, ' +
              'Safari 16.4+, or Firefox 113+.'}))));
    return;
  }

  initDB(payload);

  // Open on a measure that carries both censuses, so every view — the change
  // and slope ones included — has something to draw on first load.
  const pick = (label, ctx) => DB.metrics.find(m =>
    m.label === label && m.years.length > 1 && (!ctx || m.context.startsWith(ctx)));
  const first = pick('Total sales ($1,000)') ||
    pick('Land in farms (acres)', 'Farms, Land in Farms') ||
    DB.metrics.find(m => m.years.length > 1 && m.coverage >= 88) ||
    DB.metrics[0];
  STATE.metric = first.id;
  STATE.year = first.years[first.years.length - 1];
  const cmp = pick('Farms (number)', 'Farms, Land in Farms');
  if (cmp && cmp.id !== first.id) STATE.metric2 = cmp.id;

  readHash();
  if (!DB.metricById.has(STATE.metric)) STATE.metric = first.id;
  if (STATE.metric2 && !DB.metricById.has(STATE.metric2)) STATE.metric2 = null;

  render();
  window.addEventListener('resize', debounce(render, 220));
  window.addEventListener('keydown', e => {
    if (e.target.matches('input, select, textarea')) return;
    const i = VIEWS.findIndex(v => v.id === STATE.view);
    if (e.key === '[') { STATE.view = VIEWS[(i - 1 + VIEWS.length) % VIEWS.length].id; render(); }
    if (e.key === ']') { STATE.view = VIEWS[(i + 1) % VIEWS.length].id; render(); }
  });
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** The payload rides along as gzipped base64 so the page stays a single file. */
async function loadPayload() {
  const b64 = document.getElementById('payload').textContent.trim();
  const bin = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
  if (typeof DecompressionStream !== 'function')
    throw new Error('DecompressionStream is not available in this browser');
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

document.addEventListener('DOMContentLoaded', boot);

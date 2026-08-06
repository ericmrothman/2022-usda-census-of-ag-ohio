/* ============================================================================
   Wiring: view registry, render loop, boot.
   ========================================================================== */

/**
 * Views, grouped by what they ask of you.
 *
 *   start   where to go when you don't yet know what you're looking for
 *   single  one measure, drawn one way — swap the chart, keep the question
 *   compare two or more things side by side
 *
 * Eighteen tabs in one scrolling row all read as equally likely. Split three
 * ways with the groups named, the shelf explains itself.
 */
const VIEW_GROUPS = [
  {id: 'start',   label: 'Start here',
   hint: 'Ready-made findings, and the full list of what the census measures'},
  {id: 'single',  label: 'Single measure',
   hint: 'The measure selected in the sidebar, drawn a different way'},
  {id: 'compare', label: 'Compare measures',
   hint: 'Two or more measures, or one measure against everything else'},
];

const VIEWS = [
  {g: 'start', id: 'stories', label: 'Key findings', fn: viewStories,
   tip: 'Ready-made findings for any county, each opening the view that proves it'},
  {g: 'start', id: 'browse', label: 'All measures', fn: viewBrowse,
   tip: 'Browse all 2,325 measures by topic and census table'},

  {g: 'single', id: 'map', label: 'Map', fn: viewMap,
   tip: 'Choropleth of the 88 counties, equal-area projection'},
  {g: 'single', id: 'grid', label: 'Tile grid', fn: viewGrid,
   tip: 'Every county the same size, so small ones stay visible'},
  {g: 'single', id: 'rank', label: 'Ranked bars', fn: viewRank,
   tip: 'Counties sorted by value — the most precise comparison'},
  {g: 'single', id: 'change', label: 'Change', fn: viewChange,
   tip: '2017 to 2022 for each county, sorted by how far it moved'},
  {g: 'single', id: 'dist', label: 'Distribution', fn: viewDistribution,
   tip: 'How the 88 counties are spread across the range'},
  {g: 'single', id: 'treemap', label: 'Treemap', fn: viewTreemap,
   tip: 'Share of the total, as nested rectangles'},
  {g: 'single', id: 'waffle', label: 'Waffle', fn: viewWaffle,
   tip: 'Share of the total, as 500 countable squares'},
  {g: 'single', id: 'donut', label: 'Donut', fn: viewDonut,
   tip: 'Share of the total, for a handful of parts'},
  {g: 'single', id: 'conc', label: 'Concentration', fn: viewConcentration,
   tip: 'How much of Ohio’s total sits in how few counties (Lorenz curve, Gini)'},
  {g: 'single', id: 'table', label: 'Table', fn: viewTable,
   tip: 'Every value, sortable — the plain-text twin of every chart'},

  {g: 'compare', id: 'bivariate', label: 'Two at once', fn: viewBivariate,
   tip: 'Two measures on one map, shaded by where a county falls on both',
   needs2: true},
  {g: 'compare', id: 'scatter', label: 'Scatter', fn: viewScatter,
   tip: 'One measure against another, with 2017→2022 movement arrows',
   needs2: true},
  {g: 'compare', id: 'small', label: 'Small multiples', fn: viewSmallMultiples,
   tip: 'One mini-map per measure in the same breakdown group'},
  {g: 'compare', id: 'heatmap', label: 'Heatmap', fn: viewHeatmap,
   tip: 'Every county against every measure in the group, standardised'},
  {g: 'compare', id: 'trend', label: 'County trends', fn: viewTrend,
   tip: 'One measure per county across all five censuses, 2002–2022'},
  {g: 'compare', id: 'history', label: 'Ohio over time', fn: viewHistory,
   tip: 'Several statewide series, 1997–2022, indexed to a common base'},
  {g: 'compare', id: 'discover', label: 'Discover', fn: viewDiscover,
   tip: 'What else looks like this measure, and which counties are alike'},
];

/** Some views describe measures rather than counties; they choose their own split. */
const PARTS_VIEWS = new Set(['treemap', 'waffle', 'donut']);

let rafToken = null;
let lastView = null;

/**
 * Panels inside the canvas that scroll on their own. Ticking a checkbox
 * halfway down one of these rebuilds the canvas, so their offsets have to be
 * carried across the same way the page's own scroll is.
 */
const SCROLL_KEEP = ['.hist-list', '.scroll-x'];

function captureScroll(root) {
  const parts = [];
  for (const sel of SCROLL_KEEP) {
    root.querySelectorAll(sel).forEach((el, i) => {
      if (el.scrollTop || el.scrollLeft) parts.push([sel, i, el.scrollTop, el.scrollLeft]);
    });
  }
  return {self: root.scrollTop, parts};
}

function restoreScroll(root, snap) {
  root.scrollTop = snap.self;
  for (const [sel, i, top, left] of snap.parts) {
    const el = root.querySelectorAll(sel)[i];
    if (el) { el.scrollTop = top; el.scrollLeft = left; }
  }
}

function render() {
  if (rafToken) cancelAnimationFrame(rafToken);
  rafToken = requestAnimationFrame(() => {
    rafToken = null;
    try {
      paintViewbar();
      buildSidebar($('#sidebar'));
      const canvas = $('#canvas');
      // Adjusting a control should leave you looking at what you adjusted;
      // switching to a different view should start you at the top of it.
      const sameView = STATE.view === lastView;
      const snap = sameView ? captureScroll(canvas) : null;
      clear(canvas);
      const view = VIEWS.find(v => v.id === STATE.view) || VIEWS[0];
      lastView = view.id;
      if (view.id === 'stories') markSeen('stories');
      if (PARTS_VIEWS.has(view.id)) canvas.append(partsToggle());
      view.fn(canvas);
      canvas.append(sourceFooter());
      if (snap) restoreScroll(canvas, snap);
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
  for (const grp of VIEW_GROUPS) {
    const row = h('div', {class: 'viewrow', role: 'tablist', 'aria-label': grp.label});
    row.append(h('span', {class: 'rowlab', title: grp.hint, text: grp.label}));

    for (const v of VIEWS.filter(x => x.g === grp.id)) {
      const btn = h('button', {
        role: 'tab', 'aria-selected': String(v.id === STATE.view),
        title: v.tip, text: v.label,
        onclick: () => {
          if (v.id === 'stories') markSeen('stories');
          STATE.view = v.id;
          render();
        },
      });
      // Views needing a second measure say so before you click, rather than
      // greeting you with an empty state.
      if (v.needs2 && !STATE.metric2) {
        btn.classList.add('wants');
        btn.setAttribute('title', `${v.tip} — needs a second measure; pick one in the sidebar`);
      }
      // Key findings is the best way in but the least obvious tab, so it keeps
      // a dot until it has been opened once.
      if (v.id === 'stories' && !SEEN.stories && STATE.view !== 'stories') {
        btn.append(h('span', {class: 'nudge', 'aria-hidden': 'true'}));
      }
      row.append(btn);
    }
    bar.append(row);
  }
}

/** Which one-time hints the reader has already dismissed by using them. */
const SEEN = {};

function markSeen(key) {
  if (SEEN[key]) return;
  SEEN[key] = true;
  saveState();
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
  'showLabels', 'sortBy', 'topN', 'partsBy', 'focus', 'storyCounty',
  'browseTopic', 'browseQuery', 'historyQuery', 'yearFrom', 'yearTo',
  'browseDeep', 'trendMode'];

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

/* ============================================================================
   Application state, persistence, and small DOM/SVG helpers.
   ========================================================================== */

const STATE = {
  view: 'map',
  metric: null,          // primary metric id
  metric2: null,         // secondary, used by scatter / bivariate / compare
  year: '2022',
  mode: 'raw',           // one of MODES
  delta: false,          // draw 2017 → 2022 change instead of a level
  deltaPct: true,
  // colour
  ramp: 'blue',
  diverging: false,
  divKey: 'blueRed',
  reverse: false,
  nClasses: 6,
  breakMode: 'quantile',
  // county selection
  selected: null,        // Set of names, or null for "all"
  exclude: false,        // treat the selection as an exclusion list
  focus: null,           // county spotlighted by hover / click
  // display
  showLabels: false,
  showOhio: true,
  sortBy: 'value',
  topN: 0,               // 0 = no limit
  collections: {},       // user-saved county sets
};

const LS_KEY = 'ohio-ag-explorer/v1';

function saveState() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      collections: STATE.collections,
      theme: document.documentElement.dataset.theme,
    }));
  } catch (e) { /* private mode; not worth surfacing */ }
}

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    if (s.collections) STATE.collections = s.collections;
    if (s.theme) document.documentElement.dataset.theme = s.theme;
  } catch (e) { /* ignore */ }
}

/** Everything the charts draw is scoped to this list, in payload order. */
function activeCounties() {
  const all = DB.counties;
  if (!STATE.selected || STATE.selected.size === 0) return all.map((c, i) => i);
  const sel = STATE.selected;
  return all.map((c, i) => i)
    .filter(i => (STATE.exclude ? !sel.has(all[i].name) : sel.has(all[i].name)));
}

function activeNames() { return activeCounties().map(i => DB.counties[i].name); }

/**
 * Clicking a mark spotlights that county — it never changes which counties are
 * in play. Filtering is the sidebar's job, where the effect is visible and
 * reversible; a click on a chart that silently dropped a county from the data
 * was too easy to trigger by accident and too hard to undo.
 */
function spotlight(name) {
  STATE.focus = STATE.focus === name ? null : name;
  render();
}

/* ------------------------------------------------------------- DOM helpers */

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  applyAttrs(el, attrs);
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return el;
}

function applyAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function')
      el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v);
  }
}

const $ = sel => document.querySelector(sel);
const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

/* ------------------------------------------------------------------ tooltip */

const TIP = {el: null};

function tipShow(evt, content) {
  if (!TIP.el) TIP.el = $('#tooltip');
  TIP.el.innerHTML = content;
  TIP.el.style.opacity = '1';
  tipMove(evt);
}

function tipMove(evt) {
  if (!TIP.el) return;
  const pad = 14, r = TIP.el.getBoundingClientRect();
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
  TIP.el.style.left = `${Math.max(4, x)}px`;
  TIP.el.style.top = `${Math.max(4, y)}px`;
}

function tipHide() { if (TIP.el) TIP.el.style.opacity = '0'; }

/** Attach the standard hover behaviour to an SVG mark. */
function hoverable(el, contentFn) {
  el.addEventListener('mouseenter', e => tipShow(e, contentFn()));
  el.addEventListener('mousemove', tipMove);
  el.addEventListener('mouseleave', tipHide);
  el.setAttribute('tabindex', '0');
  el.addEventListener('focus', e => {
    const r = el.getBoundingClientRect();
    tipShow({clientX: r.left + r.width / 2, clientY: r.top}, contentFn());
  });
  el.addEventListener('blur', tipHide);
  return el;
}

function tipHTML(name, rows, note) {
  return `<div class="t-name">${esc(name)}</div>` +
    rows.map(([k, v]) => `<div class="t-row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('') +
    (note ? `<div class="t-note">${esc(note)}</div>` : '');
}

function esc(x) {
  return String(x).replace(/[&<>"']/g, c =>
    ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

/* -------------------------------------------------------------- chart frame */

/**
 * A chart card: heading, caption, an SVG sized to the container, and a slot
 * for the legend.  Every view builds on this so spacing stays consistent.
 */
function card(title, caption) {
  const svg = s('svg', {class: 'chart'});
  const legend = h('div', {class: 'legend'});
  const el = h('div', {class: 'card'},
    h('h2', {text: title}),
    caption ? h('p', {class: 'caption', text: caption}) : null,
    svg, legend);
  return {el, svg, legend};
}

function legendSwatches(container, entries) {
  clear(container);
  for (const [color, label] of entries) {
    container.append(h('div', {class: 'item'},
      h('span', {class: 'sw', style: {background: color}}),
      label));
  }
}

/** Ramp legend for a class scale, with the numeric edges printed. */
function legendClasses(container, scale, unit) {
  clear(container);
  const {colors, breaks} = scale;
  const wrap = h('div', {class: 'item', style: {gap: '0', alignItems: 'stretch', flexWrap: 'wrap'}});
  colors.forEach((c, i) => {
    const lo = i === 0 ? scale.min : breaks[i - 1];
    const hi = i === colors.length - 1 ? scale.max : breaks[i];
    const cell = h('div', {style: {display: 'flex', flexDirection: 'column', gap: '3px', minWidth: '54px'}},
      h('span', {style: {background: c, height: '10px', borderRadius: i === 0 ? '3px 0 0 3px'
        : i === colors.length - 1 ? '0 3px 3px 0' : '0', display: 'block'}}),
      h('span', {class: 'hint', style: {fontVariantNumeric: 'tabular-nums'},
        text: fmtNumber(lo, unit)}));
    wrap.append(cell);
  });
  container.append(wrap);
  if (unit) container.append(h('span', {class: 'hint', text: unit}));
}

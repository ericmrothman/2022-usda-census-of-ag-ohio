/* ============================================================================
   Data layer: the payload, lookups, and the transform engine that turns a
   raw metric into whatever the current normalisation asks for.
   ========================================================================== */

const DB = {
  counties: [],      // [{name, fips, lon, lat, area, col, row}]
  byName: new Map(),
  metrics: [],
  metricById: new Map(),
  values: {},        // id -> {year: [v x 88]}
  ohio: {},          // id -> {year: v}
  history: [],
  cv: {},            // Quick Stats coefficient of variation, 2012 onward
  geo: null,
  grid: {cols: 12, rows: 12},
  presets: {},
  source: '',
};

/** Metric ids used by the derived normalisations, resolved once at load. */
const ANCHOR = {farms: null, landInFarms: null, landArea: null, sales: null};

function initDB(payload) {
  Object.assign(DB, payload);
  DB.byName = new Map(DB.counties.map((c, i) => [c.name, i]));
  DB.metricById = new Map(DB.metrics.map(m => [m.id, m]));

  const find = (label, ctx) => (DB.metrics.find(
    m => m.label === label && (!ctx || m.context.startsWith(ctx))) || {}).id || null;

  ANCHOR.farms       = find('Farms (number)', 'County Summary');
  ANCHOR.landInFarms = find('Land in farms (acres)', 'County Summary');
  ANCHOR.landArea    = find('Approximate land area (acres)');
  ANCHOR.sales       = find('Market value of agricultural products sold ($1,000)',
                            'County Summary');

  // Fall back to any table that carries the same measure.
  if (!ANCHOR.farms) ANCHOR.farms = find('Farms (number)');
  if (!ANCHOR.landInFarms) ANCHOR.landInFarms = find('Land in farms (acres)');
}

const N_COUNTIES = () => DB.counties.length;
const countyNames = () => DB.counties.map(c => c.name);

/** Raw values for a metric-year, or an array of nulls when unavailable. */
function rawSeries(metricId, year) {
  const v = DB.values[metricId];
  if (!v) return new Array(N_COUNTIES()).fill(null);
  if (v[year]) return v[year];
  return new Array(N_COUNTIES()).fill(null);
}

function ohioValue(metricId, year) {
  const o = DB.ohio[metricId];
  return o && o[year] != null ? o[year] : null;
}

/**
 * USDA's coefficient of variation for a figure, as a percentage.
 *
 * Published only for the Quick Stats series, and only from 2012 — the 2002 and
 * 2007 censuses carry none. A high CV means the estimate is uncertain, which no
 * amount of chart polish can fix, so it belongs in the tooltip next to the
 * number it qualifies.
 */
function cvFor(metricId, year, countyIndex) {
  const c = DB.cv[metricId];
  if (!c || !c[year]) return null;
  const v = c[year][countyIndex];
  return v == null ? null : v;
}

function cvNote(cv) {
  if (cv == null) return '';
  if (cv < 15) return 'reliable';
  if (cv < 30) return 'moderate uncertainty';
  return 'high uncertainty';
}

const isQuickStats = m => (m && m.source) === 'quickstats';

/** A measure whose earlier censuses were filled in from Quick Stats. */
const hasQsYears = m => !!(m && m.qsYears && m.qsYears.length);

/**
 * Where a figure came from.
 *
 * Most measures are now two-sourced: the report supplies 2017 and 2022 — the
 * years checked against the published tables — and Quick Stats supplies the
 * earlier censuses. Saying only one of those would be untrue for 950 measures.
 */
function sourceLabel(m) {
  if (!m) return '';
  if (isQuickStats(m))
    return `USDA Quick Stats · ${m.years[0]}–${m.years[m.years.length - 1]}`;
  if (hasQsYears(m)) {
    const own = m.years.filter(y => !m.qsYears.includes(y));
    return `${m.table}, county chapter (${own.join(' & ')}) · ` +
           `USDA Quick Stats (${m.qsYears.join(', ')})`;
  }
  return `${m.table}, county chapter`;
}

/** Years a metric actually carries, newest last. */
function metricYears(metricId) {
  const m = DB.metricById.get(metricId);
  return m ? m.years : [];
}

function bestYear(metricId, wanted) {
  const ys = metricYears(metricId);
  if (!ys.length) return null;
  return ys.includes(wanted) ? wanted : ys[ys.length - 1];
}

/* -------------------------------------------------------------- statistics */

function finite(arr) { return arr.filter(v => v != null && isFinite(v)); }

function mean(arr) {
  const f = finite(arr);
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : null;
}

function stdev(arr) {
  const f = finite(arr);
  if (f.length < 2) return null;
  const mu = mean(f);
  return Math.sqrt(f.reduce((a, b) => a + (b - mu) ** 2, 0) / (f.length - 1));
}

function quantileSorted(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Pearson correlation over the positions where both series have values. */
function correlation(a, b) {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x == null || y == null || !isFinite(x) || !isFinite(y)) continue;
    n++; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
  }
  if (n < 8) return null;
  const num = n * sab - sa * sb;
  const den = Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb));
  return den === 0 ? null : num / den;
}

/** Gini coefficient of a non-negative distribution. */
function gini(values) {
  const f = finite(values).filter(v => v >= 0).sort((a, b) => a - b);
  const n = f.length;
  if (n < 2) return null;
  const total = f.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (i + 1) * f[i];
  return (2 * cum) / (n * total) - (n + 1) / n;
}

/* ------------------------------------------------------- the transform core */

const MODES = [
  {id: 'raw',    label: 'Raw value',       desc: 'The number as published.'},
  {id: 'share',  label: '% of Ohio',       desc: 'Each county as a share of the state total for this measure.'},
  {id: 'perFarm', label: 'Per farm',       desc: 'Divided by the number of farms in the county.'},
  {id: 'perAcre', label: 'Per farm acre',  desc: 'Divided by the county’s land in farms.'},
  {id: 'density', label: 'Per 1,000 acres of land', desc: 'Divided by the county’s total land area — intensity, not size.'},
  {id: 'z',      label: 'Z-score',         desc: 'Standard deviations from the 88-county mean.'},
  {id: 'rank',   label: 'Rank (1 = highest)', desc: 'Position among the counties reporting a value.'},
  {id: 'lq',     label: 'Location quotient', desc:
    'Share of Ohio’s total for this measure ÷ share of Ohio’s farms. Above 1 means the county specialises in it.'},
];

const MODE_BY_ID = new Map(MODES.map(m => [m.id, m]));

/**
 * Build the series the charts actually draw.
 * Returns {values, unit, label, mode, year, note} where `values` is aligned to
 * DB.counties and holds null wherever the census withheld or omitted a figure.
 */
function series(metricId, year, mode) {
  const m = DB.metricById.get(metricId);
  if (!m) return {values: [], unit: '', label: '', note: ''};
  const y = bestYear(metricId, year);
  const base = rawSeries(metricId, y);
  const n = base.length;
  const out = new Array(n).fill(null);
  let unit = m.unit, note = '';

  const divide = (denomId, scale, unitLabel) => {
    const d = denomId ? rawSeries(denomId, bestYear(denomId, y)) : null;
    if (!d) return;
    for (let i = 0; i < n; i++) {
      if (base[i] == null || d[i] == null || d[i] === 0) continue;
      out[i] = base[i] / d[i] * scale;
    }
    unit = unitLabel;
  };

  switch (mode) {
    case 'share': {
      const total = ohioValue(metricId, y) ??
        finite(base).reduce((a, b) => a + b, 0);
      if (total) for (let i = 0; i < n; i++)
        if (base[i] != null) out[i] = base[i] / total * 100;
      unit = '% of Ohio';
      break;
    }
    case 'perFarm':
      divide(ANCHOR.farms, 1, `${m.unit || 'units'} per farm`);
      break;
    case 'perAcre':
      divide(ANCHOR.landInFarms, 1, `${m.unit || 'units'} per farm acre`);
      break;
    case 'density':
      divide(ANCHOR.landArea, 1000, `${m.unit || 'units'} per 1,000 acres`);
      break;
    case 'z': {
      const mu = mean(base), sd = stdev(base);
      if (sd) for (let i = 0; i < n; i++)
        if (base[i] != null) out[i] = (base[i] - mu) / sd;
      unit = 'z-score';
      break;
    }
    case 'rank': {
      const idx = base.map((v, i) => [v, i]).filter(d => d[0] != null)
        .sort((a, b) => b[0] - a[0]);
      idx.forEach((d, k) => { out[d[1]] = k + 1; });
      unit = 'rank';
      note = `${idx.length} counties reported a value.`;
      break;
    }
    case 'lq': {
      const farms = ANCHOR.farms ? rawSeries(ANCHOR.farms, bestYear(ANCHOR.farms, y)) : null;
      const totalM = ohioValue(metricId, y) ?? finite(base).reduce((a, b) => a + b, 0);
      const totalF = farms ? finite(farms).reduce((a, b) => a + b, 0) : 0;
      if (farms && totalM && totalF) {
        for (let i = 0; i < n; i++) {
          if (base[i] == null || farms[i] == null || farms[i] === 0) continue;
          out[i] = (base[i] / totalM) / (farms[i] / totalF);
        }
      }
      unit = 'location quotient';
      note = '1.0 = the county holds exactly its share of Ohio farms’ worth.';
      break;
    }
    default:
      for (let i = 0; i < n; i++) out[i] = base[i];
  }

  const suppressed = base.filter(v => v == null).length;
  if (suppressed) {
    note += `${note ? ' ' : ''}${suppressed} ${suppressed === 1 ? 'county is' : 'counties are'} ` +
            'blank — the census withholds figures that would identify an individual operation.';
  }
  return {values: out, unit, label: m.label, context: m.context, mode, year: y, note, metric: m};
}

/**
 * Which two censuses a change is measured between.
 *
 * The report only carries 2017 and 2022, so this used to be implicit. Quick
 * Stats series run 2002–2022, where "the change" is a question rather than a
 * given — hence an explicit pair, falling back to first→last.
 */
function deltaYears(metricId) {
  const ys = metricYears(metricId);
  if (ys.length < 2) return null;
  const from = ys.includes(STATE.yearFrom) ? STATE.yearFrom : ys[0];
  let to = ys.includes(STATE.yearTo) ? STATE.yearTo : ys[ys.length - 1];
  if (to === from) to = ys[ys.length - 1] === from ? ys[0] : ys[ys.length - 1];
  return from < to ? [from, to] : [to, from];
}

/** Change in a metric between two censuses, absolute or as a percentage. */
function changeSeries(metricId, mode, pct) {
  const pair = deltaYears(metricId);
  if (!pair) return null;
  const [from, to] = pair;
  const a = series(metricId, from, mode).values;
  const b = series(metricId, to, mode).values;
  const out = new Array(a.length).fill(null);
  for (let i = 0; i < a.length; i++) {
    if (a[i] == null || b[i] == null) continue;
    if (pct) { if (a[i] !== 0) out[i] = (b[i] - a[i]) / Math.abs(a[i]) * 100; }
    else out[i] = b[i] - a[i];
  }
  return {values: out, from, to, pct,
          unit: pct ? '% change' : `change (${MODE_BY_ID.get(mode)?.id === 'raw'
            ? (DB.metricById.get(metricId).unit || '') : ''})`.trim()};
}

/* ---------------------------------------------------------------- formatting */

function fmtNumber(v, unit) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (unit === 'rank') return String(Math.round(v));
  if (unit === 'z-score' || unit === 'location quotient') return v.toFixed(2);
  if (unit && unit.includes('%')) return `${v.toFixed(1)}%`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return Math.round(v).toLocaleString();
  if (a >= 100) return Math.round(v).toLocaleString();
  if (a >= 1) return v.toFixed(a >= 10 ? 1 : 2).replace(/\.0+$/, '');
  if (a === 0) return '0';
  return v.toPrecision(2);
}

function fmtFull(v, unit) {
  if (v == null || !isFinite(v)) return 'no data';
  const s = unit === 'rank' ? String(Math.round(v))
    : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString()
    : v.toLocaleString(undefined, {maximumFractionDigits: 2});
  return unit && !unit.includes('%') ? `${s} ${unit}` : s;
}

/**
 * Census dollar figures are printed in thousands, so "117,505 $1,000" is a
 * true but unreadable rendering of $117.5 million. Prose uses this instead.
 */
function fmtMoney(thousands) {
  if (thousands == null || !isFinite(thousands)) return '—';
  const d = thousands * 1000;
  const a = Math.abs(d);
  if (a >= 1e9) return `$${(d / 1e9).toFixed(2)} billion`;
  if (a >= 1e6) return `$${(d / 1e6).toFixed(1)} million`;
  if (a >= 1e3) return `$${Math.round(d / 1e3)},000`;
  return `$${Math.round(d).toLocaleString()}`;
}

/** "$1,000" is a scaling note in the census, not a currency symbol. */
function unitNote(unit) {
  if (unit === '$1,000') return 'reported in thousands of dollars';
  if (unit === 'cwt') return 'hundredweight';
  return '';
}

/* ============================================================================
   Colour and scale plumbing.

   Sequential ramps are single-hue light→dark; diverging ramps are a warm/cool
   pair around a neutral grey.  Both shapes are safe by construction, so the
   palette picker can only ever hand the charts a valid ramp.
   ========================================================================== */

const RAMPS = {
  blue:    {name: 'Blue',    light: ['#eaf2fd', '#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'],
                             dark:  ['#12243a', '#123b62', '#164f85', '#1c66ab', '#2a78d6', '#5598e7', '#86b6ef', '#cde2fb']},
  orange:  {name: 'Orange',  light: ['#fdeee7', '#fbd8c6', '#f6b795', '#f19365', '#eb6834', '#c94e1f', '#9e3c17', '#702a10'],
                             dark:  ['#3a1d0e', '#5c2c14', '#82401c', '#a95326', '#d95926', '#ea7c4b', '#f2a67e', '#fbd8c6']},
  teal:    {name: 'Teal',    light: ['#e4f7f0', '#c2ece0', '#8ed9c3', '#4fc4a2', '#1baf7a', '#149063', '#0e714d', '#095038'],
                             dark:  ['#0b2a21', '#0e4234', '#125c47', '#16785c', '#199e70', '#3cbb8e', '#74d3b0', '#c2ece0']},
  violet:  {name: 'Violet',  light: ['#eeecfa', '#d9d4f3', '#b9b0e8', '#8a7dd4', '#6155bf', '#4a3aa7', '#392c82', '#28205c'],
                             dark:  ['#1e1a3d', '#2d2560', '#3d3285', '#5245ab', '#6f61d4', '#9085e9', '#b5aef1', '#d9d4f3']},
  magenta: {name: 'Magenta', light: ['#fceef3', '#f8d5e2', '#f1b0c8', '#e87ba4', '#d55181', '#b23a64', '#8b2b4c', '#631d35'],
                             dark:  ['#3a1220', '#5a1d33', '#7d2947', '#a3375d', '#c74a76', '#e87ba4', '#f1b0c8', '#f8d5e2']},
  earth:   {name: 'Earth',   light: ['#f5f0e4', '#e8dcc0', '#d6c191', '#c0a263', '#a68544', '#876a34', '#6a5227', '#4a391a'],
                             dark:  ['#2a2214', '#42351f', '#5c4a2b', '#786138', '#9a7d47', '#bd9d61', '#d6c191', '#e8dcc0']},
  gray:    {name: 'Neutral', light: ['#f2f2ef', '#e1e0d9', '#c7c5bb', '#a8a69b', '#898781', '#6b6a65', '#52514e', '#333331'],
                             dark:  ['#242422', '#33332f', '#45443f', '#5a5952', '#727068', '#898781', '#a8a69b', '#c7c5bb']},
};

/** Diverging: two hues that read as opposite, neutral grey at the middle. */
const DIVERGING = {
  blueRed:    {name: 'Blue ↔ Red',    neg: 'blue',   pos: 'magenta'},
  tealOrange: {name: 'Teal ↔ Orange', neg: 'teal',   pos: 'orange'},
  violetEarth:{name: 'Violet ↔ Earth',neg: 'violet', pos: 'earth'},
};

const MIDPOINT = {light: '#f0efec', dark: '#383835'};

/**
 * Bivariate 3×3 matrices, indexed [rowB][colA] with the low class first.
 *
 * Mixing two arbitrary hues per pixel gives mud, so these are stated outright:
 * the light matrix is the well-travelled blue↔rose scheme, and the dark one is
 * its counterpart re-stepped so "low on both" sits nearest the dark surface
 * and "high on both" is the brightest corner.
 */
const BIVARIATE = {
  light: [
    ['#e8e8e8', '#b8d6d8', '#5ac8c8'],
    ['#dbb2d1', '#a5aec4', '#5698b9'],
    ['#c364a4', '#94619f', '#3b4994'],
  ],
  dark: [
    ['#2e2e2b', '#367274', '#3fb5bd'],
    ['#784464', '#7a809e', '#7cbcd6'],
    ['#c25a9e', '#be8fc7', '#b9c4f0'],
  ],
};
// Corner separation is validated all-pairs in both modes (worst CVD ΔE 8.7,
// worst normal-vision ΔE 15.5 on dark; 12.6 / 19.0 on light). The low-low
// corner sits under 3:1 against the surface on purpose — it means "least of
// both" and is meant to recede; the key, the worded tooltips and the table
// view are the relief.

const isDark = () => document.documentElement.dataset.theme === 'dark';
const rampSteps = key => RAMPS[key][isDark() ? 'dark' : 'light'];

/**
 * n colours from a single-hue ramp, running away from the chart surface.
 *
 * The dark ramps are ordered dark→light, so on a dark surface the low end sits
 * closest to the background. Starting the sample above the ramp's floor keeps
 * even the lowest class about 2:1 against the surface — without it the quiet
 * counties dissolve and the state loses its silhouette.
 */
function sequentialColors(key, n, reverse) {
  const steps = rampSteps(key);
  const floor = isDark() ? 0.28 : 0.06;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.7 : i / (n - 1);
    out.push(sampleRamp(steps, floor + t * (0.97 - floor)));
  }
  return reverse ? out.reverse() : out;
}

/** n colours across a diverging pair, neutral in the middle. */
function divergingColors(key, n, reverse) {
  const {neg, pos} = DIVERGING[key];
  const mid = MIDPOINT[isDark() ? 'dark' : 'light'];
  const half = Math.floor(n / 2);
  const odd = n % 2 === 1;
  const negS = rampSteps(neg), posS = rampSteps(pos);
  const out = [];
  for (let i = 0; i < half; i++)
    out.push(sampleRamp(negS, 0.95 - (i / Math.max(1, half - 1)) * 0.55));
  if (odd) out.push(mid);
  for (let i = 0; i < half; i++)
    out.push(sampleRamp(posS, 0.40 + (i / Math.max(1, half - 1)) * 0.55));
  return reverse ? out.reverse() : out;
}

function sampleRamp(steps, t) {
  const x = Math.max(0, Math.min(1, t)) * (steps.length - 1);
  const i = Math.floor(x), f = x - i;
  if (i >= steps.length - 1) return steps[steps.length - 1];
  return mixHex(steps[i], steps[i + 1], f);
}

function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t);
  const g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t);
  const bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t);
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}

function relLuminance(hex) {
  const p = parseInt(hex.slice(1), 16);
  const ch = [(p >> 16) & 255, (p >> 8) & 255, p & 255].map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/**
 * Ink that stays legible on a given fill — for labels printed inside marks.
 * Compares the actual contrast ratio against black and white rather than
 * guessing from lightness; mid-tone blues read far better with dark ink than
 * a naive lightness threshold suggests.
 */
function inkOn(hex) {
  if (!hex || hex[0] !== '#') return '#0b0b0b';
  const l = relLuminance(hex);
  const vsWhite = 1.05 / (l + 0.05);
  const vsBlack = (l + 0.05) / 0.05;
  return vsBlack >= vsWhite ? '#0b0b0b' : '#ffffff';
}

/** The eight-slot categorical theme, read from CSS so it follows the theme. */
function categorical(n) {
  const cs = getComputedStyle(document.documentElement);
  const out = [];
  for (let i = 1; i <= Math.min(n, 8); i++)
    out.push(cs.getPropertyValue(`--series-${i}`).trim());
  return out;
}

const cssVar = name => getComputedStyle(document.documentElement)
  .getPropertyValue(name).trim();

/* ------------------------------------------------------------- class breaks */

const BREAK_MODES = [
  {id: 'quantile', label: 'Equal count', desc: 'Each class holds the same number of counties — best for skewed data.'},
  {id: 'equal',    label: 'Equal range', desc: 'Classes of equal width across the value range.'},
  {id: 'jenks',    label: 'Natural breaks', desc: 'Class edges placed where the data has gaps.'},
  {id: 'log',      label: 'Log', desc: 'Equal ratios rather than equal amounts. Positive values only.'},
];

/**
 * Compute class edges. Returns {breaks, colors, classOf(v), min, max} where
 * `breaks` has colors.length - 1 interior edges.
 */
function makeClassScale(values, opts) {
  const {nClasses = 6, method = 'quantile', ramp = 'blue', diverging = false,
         divKey = 'blueRed', reverse = false, center = 0} = opts;
  const vals = finite(values);
  const colors = diverging
    ? divergingColors(divKey, nClasses, reverse)
    : sequentialColors(ramp, nClasses, reverse);

  if (!vals.length) return {breaks: [], colors, classOf: () => -1, min: 0, max: 0};

  const sorted = [...vals].sort((a, b) => a - b);
  const min = sorted[0], max = sorted[sorted.length - 1];
  let breaks = [];

  if (diverging) {
    // Symmetric around the centre so equal magnitudes get equal weight.
    const span = Math.max(Math.abs(min - center), Math.abs(max - center)) || 1;
    for (let i = 1; i < nClasses; i++)
      breaks.push(center - span + (2 * span) * (i / nClasses));
  } else if (method === 'equal') {
    for (let i = 1; i < nClasses; i++) breaks.push(min + (max - min) * i / nClasses);
  } else if (method === 'log') {
    const pos = sorted.filter(v => v > 0);
    const lo = pos.length ? pos[0] : 1, hi = max > 0 ? max : 1;
    for (let i = 1; i < nClasses; i++)
      breaks.push(Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * i / nClasses));
  } else if (method === 'jenks') {
    breaks = jenksBreaks(sorted, nClasses);
  } else {
    for (let i = 1; i < nClasses; i++) breaks.push(quantileSorted(sorted, i / nClasses));
  }
  // Strictly increasing edges, so heavily tied data still yields usable classes.
  for (let i = 1; i < breaks.length; i++)
    if (breaks[i] <= breaks[i - 1]) breaks[i] = breaks[i - 1] + 1e-9;

  const classOf = v => {
    if (v == null || !isFinite(v)) return -1;
    let k = 0;
    while (k < breaks.length && v >= breaks[k]) k++;
    return k;
  };
  return {breaks, colors, classOf, min, max, center, diverging};
}

/**
 * Fisher–Jenks, done on a sample when the series is large. 88 counties is
 * small enough to run exactly, so this stays cheap.
 */
function jenksBreaks(sorted, k) {
  const n = sorted.length;
  if (k >= n) return sorted.slice(1);
  const mat1 = [], mat2 = [];
  for (let i = 0; i <= n; i++) {
    mat1.push(new Array(k + 1).fill(0));
    mat2.push(new Array(k + 1).fill(Infinity));
  }
  for (let j = 1; j <= k; j++) { mat1[0][j] = 1; mat2[0][j] = 0; mat2[1][j] = 0; }
  for (let l = 2; l <= n; l++) {
    let s1 = 0, s2 = 0, w = 0;
    for (let m = 1; m <= l; m++) {
      const i3 = l - m + 1, val = sorted[i3 - 1];
      w++; s1 += val; s2 += val * val;
      const v = s2 - (s1 * s1) / w;
      const i4 = i3 - 1;
      if (i4 !== 0) {
        for (let j = 2; j <= k; j++) {
          if (mat2[l][j] >= v + mat2[i4][j - 1]) {
            mat1[l][j] = i3;
            mat2[l][j] = v + mat2[i4][j - 1];
          }
        }
      }
    }
    mat1[l][1] = 1; mat2[l][1] = s2 - (s1 * s1) / w;
  }
  const out = [];
  let kk = n;
  for (let j = k; j >= 2; j--) {
    const id = mat1[kk][j] - 1;
    out.unshift(sorted[id]);
    kk = mat1[kk][j] - 1;
  }
  return out;
}

/* --------------------------------------------------------------- axis ticks */

function niceTicks(min, max, count = 5) {
  if (!isFinite(min) || !isFinite(max)) return [];
  if (min === max) return [min];
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step)
    out.push(Math.abs(v) < 1e-9 ? 0 : v);
  return out;
}

function linScale(d0, d1, r0, r1) {
  const span = d1 - d0 || 1;
  const f = v => r0 + (v - d0) / span * (r1 - r0);
  f.invert = p => d0 + (p - r0) / (r1 - r0) * span;
  f.domain = [d0, d1];
  f.range = [r0, r1];
  return f;
}

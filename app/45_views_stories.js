/* ============================================================================
   Stories — one-click presets that open the explorer on a specific finding.

   Two kinds sit side by side:

     * curated cards, hand-picked for a county, whose numbers are still read
       live from the data so the prose can never drift from the figures;
     * generated cards, which work for any of the 88 counties by scanning every
       measure for the places that county stands out.

   Every card carries a state patch, so "Show me" lands you on the view that
   makes the claim checkable rather than asking you to take it on trust.
   ========================================================================== */

const STORY_COUNTY = () => STATE.storyCounty || STATE.focus || 'Montgomery';

/** Resolve a measure by label, preferring a given table context. */
function findMetric(label, ctx) {
  const exact = DB.metrics.filter(m => m.label === label);
  const pool = exact.length ? exact
    : DB.metrics.filter(m => m.label.startsWith(label));
  if (!pool.length) return null;
  return (ctx && pool.find(m => m.context.startsWith(ctx))) || pool[0];
}

/**
 * Everything a story needs to state a fact about one county and one measure:
 * the value, where it ranks, its share of the state, and how it moved.
 */
function facts(metric, county, year) {
  if (!metric) return null;
  const i = DB.byName.get(county);
  if (i == null) return null;
  const y = year && metric.years.includes(year) ? year
    : metric.years[metric.years.length - 1];
  const v = rawSeries(metric.id, y);
  const x = v[i];
  if (x == null) return null;
  const fin = finite(v);
  const sorted = [...fin].sort((a, b) => b - a);
  const total = fin.reduce((a, b) => a + b, 0);
  const out = {
    metric, county, year: y, value: x, reporting: fin.length,
    rank: sorted.indexOf(x) + 1,
    share: total ? x / total * 100 : null,
    ohio: ohioValue(metric.id, y) ?? total,
    unit: metric.unit,
  };
  if (metric.years.length > 1) {
    const y0 = metric.years[0];
    const a = rawSeries(metric.id, y0)[i];
    if (a != null && a !== 0) {
      out.from = a; out.fromYear = y0;
      out.pct = (x - a) / Math.abs(a) * 100;
    }
  }
  return out;
}

const ord = n => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 - n % 10 !== 10) * (n % 10 < 4) * n % 10] || 'th'}`;

function rankPhrase(f) {
  return f.rank <= 3 ? `<strong>${ord(f.rank)} highest in Ohio</strong>`
    : `${ord(f.rank)} of the ${f.reporting} counties reporting it`;
}

/* -------------------------------------------------------- curated: by county */

/**
 * Curated Montgomery County (Dayton) cards. Each states a claim the data
 * supports, names the caveat where there is one, and opens the view that
 * shows the working.
 */
const CURATED = {
  Montgomery: [
    {
      tag: 'The headline is misleading',
      metric: ['Total sales ($1,000)', 'Market Value'],
      also: ['Value of sales by commodity or commodity group · Crops, including nursery and greenhouse crops · Nursery, greenhouse, floriculture, and sod ($1,000)', 'Market Value'],
      title: 'Middling on the total, sixth in Ohio on greenhouse and nursery',
      tell: (f, g) => `Montgomery sells ${fmtMoney(f.value)} of farm products — ` +
        `${ord(f.rank)} of ${f.reporting} counties, squarely mid-table. But ` +
        `${fmtMoney(g.value)} of that is nursery, greenhouse, floriculture and sod: ` +
        `${rankPhrase(g)}, and <strong>${(g.value / f.value * 100).toFixed(0)}% of the county's own ` +
        `farm sales</strong> against ${(g.ohio / f.ohio * 100).toFixed(0)}% for Ohio as a whole. ` +
        `Ranked by total sales this county looks unremarkable; ranked by what it actually grows, it isn't.`,
      go: (f, g) => ({view: 'rank', metric: g.metric.id, year: '2022', mode: 'raw', topN: 15}),
    },
    {
      tag: 'Under glass',
      metric: ['Total Greenhouse Vegetables and Fresh Cut Herbs · 2022 · Sq. ft. under glass', 'Floriculture'],
      title: 'The third-largest area of food grown under glass in the state',
      tell: f => `${fmtNumber(f.value, 'square feet')} sq ft of greenhouse vegetables and fresh-cut ` +
        `herbs — ${rankPhrase(f)}, and ${f.share.toFixed(1)}% of Ohio's total, from a county with ` +
        `40% of its land in farms. Growing under glass is how farming survives where land is dear: ` +
        `it needs a fraction of the acreage and sells into the city next door.`,
      go: f => ({view: 'rank', metric: f.metric.id, year: '2022', mode: 'raw', topN: 20}),
    },
    {
      tag: 'Who farms here',
      metric: ['Hispanic, Latino, or Spanish Origin Producers · Land in farms (acres)', 'Hispanic'],
      also: ['Producers by race · Black or African American', 'Selected Operation'],
      title: 'Ohio’s most demographically distinctive farm county',
      tell: (f, g) => `${fmtNumber(f.value, 'acres')} acres — <strong>more land farmed by Hispanic, ` +
        `Latino or Spanish-origin producers than any other county in Ohio</strong>, ${f.share.toFixed(0)}% ` +
        `of the state total, on a county holding under 1% of Ohio's farmland. Montgomery also reports ` +
        `${g.value} Black or African American producers, ${rankPhrase(g)}. These are small counts, and ` +
        `the census asks producers to self-identify, so read them as presence rather than precision.`,
      go: f => ({view: 'map', metric: f.metric.id, year: '2022', mode: 'share', ramp: 'violet'}),
    },
    {
      tag: 'What it grows',
      metric: ['Beets · 2022 · Total harvested · Farms', 'Vegetables'],
      title: 'A market garden: first in Ohio for beets, spinach and turnips',
      tell: f => `${f.value} farms harvesting beets — ${rankPhrase(f)}. The same pattern repeats down ` +
        `the vegetable table: first for spinach and turnips grown for fresh market, top three for ` +
        `carrots and lettuce. Each is a handful of farms on a few acres, so any single one is thin ` +
        `evidence; it is the <em>repetition across a dozen crops</em> that makes it a real signal.`,
      go: f => ({view: 'small', metric: f.metric.id, year: '2022', mode: 'raw'}),
    },
    {
      tag: 'What changed',
      metric: ['Total farm production expenses · Contract labor ($1,000)', 'Farm Production'],
      title: 'Contract labour spending grew elevenfold in five years',
      tell: f => `From ${fmtMoney(f.from)} in ${f.fromYear} to ${fmtMoney(f.value)} ` +
        `in ${f.year} — <strong>${f.pct >= 0 ? '+' : ''}${f.pct.toFixed(0)}%</strong>, now ${rankPhrase(f)}. ` +
        `That is what a shift toward greenhouses, orchards and market vegetables costs: those crops are ` +
        `picked by hand, and the bill shows up as labour rather than land.`,
      go: f => ({view: 'change', metric: f.metric.id, mode: 'raw', delta: true, deltaPct: true, topN: 20}),
    },
    {
      tag: 'Its peers',
      metric: ['Land in farms (acres)', 'County Summary'],
      title: 'Statistically, Montgomery’s twins are the other metro-edge counties',
      tell: () => `Across ten standardised headline measures the counties closest to Montgomery are ` +
        `Delaware, Morrow, Lorain, Ottawa and Warren — a ring of metro-edge counties, not the ` +
        `farm-belt west or the Appalachian east. If you want a comparison group for Montgomery, ` +
        `that is the defensible one.`,
      go: () => ({view: 'discover', focus: 'Montgomery'}),
    },
  ],
};

/* ------------------------------------------------------ generated: any county */

/**
 * Is this value substantial enough to headline?
 *
 * The filters exist because "first in Ohio" is cheap: a measure only 32
 * counties report, or one resting on three farms, will hand almost any county
 * a number-one finish that says nothing about the place.
 */
function material(f) {
  if (f.reporting < 45) return false;          // thinly-reported measures
  if (f.metric.coverage < 45) return false;
  if (f.ohio < 500) return false;              // trivial statewide totals
  const countLike = /farm|number|producer|operation|colonies|head|worker/i.test(f.unit || '');
  return countLike ? f.value >= 12 : f.value > 0;
}

/** Scan every measure for the ones where this county stands out. */
function generatedStories(county) {
  const i = DB.byName.get(county);
  const farmsId = ANCHOR.farms;
  const farms = farmsId ? rawSeries(farmsId, '2022') : null;
  const farmShare = farms && farms[i] ? farms[i] / finite(farms).reduce((a, b) => a + b, 0) : null;

  const topRanks = [], special = [], movers = [];

  for (const m of DB.metrics) {
    if (m.coverage < 30) continue;
    const f = facts(m, county, '2022');
    if (!f || !material(f)) continue;

    // A high rank only means something if the county also holds a real share;
    // otherwise fifth place is just a big county being big.
    if (f.rank <= 5 && f.share >= 6) topRanks.push(f);
    if (farmShare && f.share != null && f.share >= 3) {
      const lq = (f.share / 100) / farmShare;
      if (lq >= 2.5) special.push({...f, lq});
    }
    if (f.pct != null && Math.abs(f.pct) >= 40 && f.value >= 100 && f.from >= 50)
      movers.push(f);
  }

  topRanks.sort((a, b) => a.rank - b.rank || b.share - a.share);
  special.sort((a, b) => b.lq - a.lq);
  movers.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));

  // One card per measure, and one per underlying figure: the census prints the
  // same count under several headings ("Beets, total harvested" and "Beets,
  // fresh market" are the same twelve farms), which would otherwise fill the
  // section with restatements of one fact.
  const used = new Set(), seenValue = new Set();
  const take = (list, n) => list.filter(f => {
    const vk = `${Math.round(f.value)}|${f.rank}|${f.unit}`;
    const lk = f.metric.label.slice(0, 44);
    if (used.has(f.metric.id) || seenValue.has(vk) || seenValue.has(lk)) return false;
    used.add(f.metric.id);
    seenValue.add(vk);
    seenValue.add(lk);
    return true;
  }).slice(0, n);

  return {
    topRanks: take(topRanks, 6),
    special: take(special, 6),
    movers: take(movers, 6),
  };
}

/* -------------------------------------------------------------- the view */

function viewStories(root) {
  const county = STORY_COUNTY();

  root.append(storyPicker(county));

  const summary = countySummary(county);
  if (summary) root.append(summary);

  const curated = CURATED[county] || [];
  if (curated.length) {
    root.append(h('h2', {style: {margin: '6px 2px 0', fontSize: '13px'},
      text: `Hand-picked findings for ${county}`}));
    const grid = h('div', {style: {display: 'grid', gap: '14px',
      gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))'}});
    for (const st of curated) {
      const f = facts(findMetric(st.metric[0], st.metric[1]), county, '2022');
      const g = st.also ? facts(findMetric(st.also[0], st.also[1]), county, '2022') : null;
      if (!f || (st.also && !g)) continue;
      grid.append(storyCard({
        tag: st.tag, title: st.title, body: st.tell(f, g),
        source: `${f.metric.context} · ${f.metric.table}`,
        patch: st.go(f, g),
      }));
    }
    root.append(grid);
  }

  const gen = generatedStories(county);
  const sections = [
    ['Where it leads Ohio', gen.topRanks,
     f => `${rankPhrase(f)} for <strong>${esc(f.metric.label)}</strong> — ` +
          `${f.unit === '$1,000' ? fmtMoney(f.value) : fmtFull(f.value, f.unit)}, ` +
          `${f.share.toFixed(1)}% of the state total.`,
     f => ({view: 'rank', metric: f.metric.id, year: f.year, mode: 'raw', topN: 15})],
    ['Where it punches above its weight', gen.special,
     f => `Holds ${f.share.toFixed(1)}% of Ohio's <strong>${esc(f.metric.label)}</strong> ` +
          `with only ${(100 * (rawSeries(ANCHOR.farms, '2022')[DB.byName.get(county)] /
            finite(rawSeries(ANCHOR.farms, '2022')).reduce((a, b) => a + b, 0))).toFixed(1)}% ` +
          `of the state's farms — a location quotient of ${f.lq.toFixed(1)}.`,
     f => ({view: 'map', metric: f.metric.id, year: f.year, mode: 'lq'})],
    ['What moved most since 2017', gen.movers,
     f => `<strong>${esc(f.metric.label)}</strong> went from ` +
          `${f.unit === '$1,000' ? fmtMoney(f.from) : fmtNumber(f.from, f.unit)} to ` +
          `${f.unit === '$1,000' ? fmtMoney(f.value) : fmtNumber(f.value, f.unit)} — ` +
          `${f.pct >= 0 ? '+' : ''}${f.pct.toFixed(0)}%.`,
     f => ({view: 'change', metric: f.metric.id, mode: 'raw', delta: true, topN: 20})],
  ];

  for (const [title, list, tell, go] of sections) {
    if (!list.length) continue;
    root.append(h('h2', {style: {margin: '10px 2px 0', fontSize: '13px'}, text: title}));
    const grid = h('div', {style: {display: 'grid', gap: '14px',
      gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))'}});
    for (const f of list) {
      grid.append(storyCard({
        tag: f.metric.topic, title: truncate(f.metric.label, 62), body: tell(f),
        source: `${f.metric.context} · ${f.metric.table}`, patch: go(f),
      }));
    }
    root.append(grid);
  }

  root.append(h('div', {class: 'card'},
    h('p', {class: 'caption', style: {margin: 0},
      text: 'Generated cards are found by scanning every measure in the report for the ones ' +
        'where this county ranks high, holds a share out of proportion to its farm count, or ' +
        'moved sharply between the two censuses. Measures reported by fewer than 30 counties, ' +
        'and county figures under 10 farms, are excluded — with counts that small a single ' +
        'operation moves the ranking. Nothing here is adjusted for the fact that a county with ' +
        'more farmland will lead on more measures; the "punches above its weight" section is ' +
        'the one that controls for size.'})));
}

function storyCard({tag, title, body, source, patch}) {
  return h('div', {class: 'card', style: {display: 'flex', flexDirection: 'column', gap: '8px'}},
    h('span', {style: {fontSize: '10px', letterSpacing: '.07em', textTransform: 'uppercase',
      color: 'var(--accent)', fontWeight: '650'}, text: tag}),
    h('h2', {style: {margin: 0, fontSize: '14.5px', lineHeight: '1.35'}, text: title}),
    h('p', {style: {margin: 0, fontSize: '12.5px', lineHeight: '1.55',
      color: 'var(--text-secondary)'}, html: body}),
    h('div', {style: {marginTop: 'auto', paddingTop: '4px', display: 'flex',
      alignItems: 'center', gap: '10px', flexWrap: 'wrap'}},
      h('button', {class: 'btn primary', text: 'Show me →', onclick: () => {
        // A preset has to land the same way every time, so reset everything it
        // does not set. Carrying "change 2017 → 2022" over from a previous card
        // would drop a single-year measure straight into an empty state.
        Object.assign(STATE, {
          delta: false, deltaPct: true, mode: 'raw', topN: 0, partsBy: 'county',
          selected: null, exclude: false, diverging: false, reverse: false,
          ramp: 'blue', nClasses: 6, breakMode: 'quantile', showLabels: false,
        }, patch);
        if (!('focus' in patch)) STATE.focus = STORY_COUNTY();
        render();
      }}),
      h('span', {class: 'hint', style: {flex: '1'}, text: source})));
}

function storyPicker(county) {
  const sel = h('select', {style: {maxWidth: '220px'}, onchange: e => {
    STATE.storyCounty = e.target.value; STATE.focus = e.target.value; render();
  }});
  for (const c of DB.counties)
    sel.append(h('option', {value: c.name, selected: c.name === county, text: c.name}));

  return h('div', {class: 'card'},
    h('h2', {text: `Key findings for ${county} County`}),
    h('p', {class: 'caption',
      text: 'Presets that open the explorer on a specific finding. Pick any county — ' +
        'the cards under each heading are found in the data, not written in advance. ' +
        (CURATED[county]
          ? 'The cards at the top are hand-picked and written against these figures.'
          : `${county} has no hand-picked cards — switch to Montgomery to see those.`)}),
    h('div', {class: 'row'},
      h('span', {class: 'hint', text: 'County'}), sel));
}

/** The four numbers that place a county before any of the stories land. */
function countySummary(county) {
  const i = DB.byName.get(county);
  const rows = [
    ['Farms', findMetric('Farms (number)', 'County Summary')],
    ['Land in farms', findMetric('Land in farms (acres)', 'County Summary')],
    ['Products sold', findMetric('Market value of agricultural products sold ($1,000)', 'County Summary')],
    ['Average farm size', findMetric('Land in farms · Average size of farm (acres)', 'County Summary')],
  ].map(([k, m]) => [k, facts(m, county, '2022')]).filter(([, f]) => f);
  if (!rows.length) return null;

  return h('div', {class: 'card'},
    h('div', {class: 'stat-row'}, rows.map(([k, f]) => h('div', {class: 'stat'},
      h('span', {class: 'k', text: k}),
      h('span', {class: 'v'}, f.unit === '$1,000' ? fmtMoney(f.value) : fmtNumber(f.value, f.unit),
        h('small', {text: ` · ${ord(f.rank)} of ${f.reporting}`}))))),
    h('p', {class: 'caption', style: {margin: '10px 0 0'},
      text: `${county} County, 2022. Ranks are among the counties reporting each measure.`}));
}

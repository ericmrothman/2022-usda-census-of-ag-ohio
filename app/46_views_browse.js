/* ============================================================================
   Browse — the measure dictionary.

   Search only helps once you know what to ask for. This view is the opposite
   entry point: it lays the whole report out as the census organises it, so you
   can read down the shelf and find things you would never have typed.

   Topic → table → section → measure, everything collapsed until you open it.
   ========================================================================== */

const TOPIC_BLURB = {
  Overview:   'The one-page summary the census prints for every county: farms, land, sales, livestock and the headline crops.',
  Money:      'What operations sold, spent, were paid, and kept — including sales by commodity, expenses line by line, and government payments.',
  Land:       'How much land, in whose hands, doing what: farm sizes, cropland, pasture, woodland, irrigation and drainage.',
  Livestock:  'Every animal the census counts, by inventory and by sales — cattle, hogs, sheep, goats, horses, poultry, bees and fish.',
  Crops:      'Everything grown, from field corn to Marionberries, with acres, quantity harvested and the size bands of the farms growing it.',
  Operations: 'How farms are run: machinery, fertiliser and chemicals, organic certification, production contracts and industry classification.',
  Producers:  'Who farms — age, sex, race and ethnicity, military service, years on the operation, and off-farm work.',
};

/**
 * Everything grouped the way its source organises it: topic → table → section
 * for the printed report, topic → commodity group → commodity for Quick Stats.
 *
 * The two sources genuinely are shelved differently — the report by the table
 * it was printed in, Quick Stats by what the thing is — so forcing one tree on
 * both would misrepresent whichever lost.
 */
function browseTree(deepOnly) {
  const topics = new Map();
  for (const m of DB.metrics) {
    const src = m.source || 'report';
    if (deepOnly && m.years.length < 3) continue;
    if (!topics.has(m.topic)) topics.set(m.topic, new Map());
    const tables = topics.get(m.topic);

    let key, table, title, sec;
    if (src === 'quickstats') {
      const tree = m.tree || [];
      table = 'Quick Stats';
      title = tree[1] || tree[0] || 'Quick Stats';
      key = `qs:${title}`;
      sec = tree.slice(2).join(' › ');
    } else {
      table = m.table;
      title = m.context;
      key = `${m.table} — ${m.context}`;
      sec = m.section ? tidySection(m.section) : '';
    }

    if (!tables.has(key))
      tables.set(key, {table, title, source: src, sections: new Map()});
    const t = tables.get(key);
    if (!t.sections.has(sec)) t.sections.set(sec, []);
    t.sections.get(sec).push(m);
  }
  return topics;
}

function tidySection(section) {
  return section.split(' > ')
    .map(p => p.replace(/^(19|20)\d\d\s+/, ''))
    .filter(p => p && !/^(19|20)\d\d$/.test(p))
    .join(' › ');
}

/** Measures carrying three or more censuses — what the trend view can draw. */
const DEEP_COUNT = () => DB.metrics.filter(m => m.years.length >= 3).length;

const TOPIC_ORDER = ['Overview', 'Money', 'Land', 'Livestock', 'Crops',
                     'Operations', 'Producers'];

function matchesQuery(m, terms) {
  if (!terms.length) return true;
  const hay = `${m.label} ${m.context} ${m.section} ${m.topic} ${m.table}`.toLowerCase();
  return terms.every(t => hay.includes(t));
}

function viewBrowse(root) {
  const q = (STATE.browseQuery || '').trim().toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  const tree = browseTree(STATE.browseDeep || false);

  /* ---- header: what this is, plus search and a way in for the undecided --- */

  const search = h('input', {type: 'search', value: STATE.browseQuery || '',
    placeholder: 'Filter the dictionary — "goats", "irrigat", "expenses", "organic"…',
    style: {maxWidth: '420px'},
    oninput: e => {
      STATE.browseQuery = e.target.value;
      const pos = e.target.selectionStart;
      render();
      // keep the caret where it was after the re-render
      requestAnimationFrame(() => {
        const el = document.querySelector('#canvas input[type="search"]');
        if (el) { el.focus(); el.setSelectionRange(pos, pos); }
      });
    }});

  const head = h('div', {class: 'card'},
    h('h2', {text: 'Measure dictionary'}),
    h('p', {class: 'caption'},
      `Every one of the ${DB.metrics.length.toLocaleString()} measures, laid out the ` +
      `way the census organises them — 57 county tables, each broken into sections. ` +
      `${DEEP_COUNT().toLocaleString()} of them carry all five censuses back to 2002. ` +
      `Open a group to see what is in it; clicking a measure selects it and takes ` +
      `you to the map.`),
    h('div', {class: 'row'}, search,
      segmented([
        {id: '', label: 'All measures'},
        {id: 'deep', label: `20-year trend (${DEEP_COUNT()})`,
         desc: 'Measures carrying all five censuses, 2002 to 2022 — the ones the ' +
               'County trends view can draw. The rest have 2017 and 2022 only.'},
      ], STATE.browseDeep ? 'deep' : '',
        v => { STATE.browseDeep = v === 'deep'; render(); }),
      h('button', {class: 'btn', text: 'Surprise me', title:
        'Jump to a randomly chosen measure with good county coverage',
        onclick: () => {
          const pool = DB.metrics.filter(m => m.coverage >= 60);
          const m = pool[Math.floor(Math.random() * pool.length)];
          pickMeasure(m.id);
        }}),
      q ? h('button', {class: 'btn sm', text: 'Clear filter',
        onclick: () => { STATE.browseQuery = ''; render(); }}) : null),
  );
  root.append(head);

  /* --------------------------------- topic chips --------------------------- */

  const chips = h('div', {class: 'chips', style: {margin: '0 2px'}});
  const activeTopic = STATE.browseTopic || null;
  chips.append(h('button', {class: 'chip', 'aria-pressed': String(!activeTopic),
    text: `All topics (${DB.metrics.length.toLocaleString()})`,
    onclick: () => { STATE.browseTopic = null; render(); }}));
  for (const topic of TOPIC_ORDER) {
    const tables = tree.get(topic);
    if (!tables) continue;
    const n = [...tables.values()]
      .reduce((a, t) => a + [...t.sections.values()].reduce((b, ms) => b + ms.length, 0), 0);
    chips.append(h('button', {class: 'chip', 'aria-pressed': String(activeTopic === topic),
      text: `${topic} (${n.toLocaleString()})`,
      onclick: () => { STATE.browseTopic = activeTopic === topic ? null : topic; render(); }}));
  }
  root.append(chips);

  /* --------------------------------- the shelf ----------------------------- */

  STATE.browseOpen = STATE.browseOpen || {};
  let shown = 0;

  for (const topic of TOPIC_ORDER) {
    if (activeTopic && topic !== activeTopic) continue;
    const tables = tree.get(topic);
    if (!tables) continue;

    // Only draw a topic if something under it survives the filter.
    const live = [...tables.values()].map(t => {
      const sections = [...t.sections.entries()]
        .map(([sec, ms]) => [sec, ms.filter(m => matchesQuery(m, terms))])
        .filter(([, ms]) => ms.length);
      return {...t, live: sections,
        count: sections.reduce((a, [, ms]) => a + ms.length, 0)};
    }).filter(t => t.count);
    if (!live.length) continue;

    root.append(h('h2', {style: {margin: '12px 2px 0', fontSize: '13px'},
      text: topic}));
    if (TOPIC_BLURB[topic] && !terms.length)
      root.append(h('p', {class: 'hint', style: {margin: '0 2px', maxWidth: '86ch'},
        text: TOPIC_BLURB[topic]}));

    for (const t of live) {
      const key = `${t.table}|${t.title}`;
      // A search opens what it matches; otherwise remember what the user opened.
      const open = terms.length ? true : !!STATE.browseOpen[key];
      shown += t.count;

      const yrs = [...new Set(t.live.flatMap(([, ms]) => ms.flatMap(m => m.years)))].sort();
      const bodyId = `tbl-${key.replace(/\W+/g, '-')}`;

      const header = h('button', {
        class: 'browse-head', 'aria-expanded': String(open), 'aria-controls': bodyId,
        onclick: () => { STATE.browseOpen[key] = !open; render(); },
      },
        h('span', {class: 'tw'}),
        h('span', {class: 'nm'}, h('strong', {text: t.title}),
          h('span', {class: 'hint', text: t.source === 'quickstats'
            ? '  USDA Quick Stats' : `  ${t.table} · county chapter`})),
        h('span', {class: 'hint', style: {marginLeft: 'auto', whiteSpace: 'nowrap'},
          text: `${t.count} measure${t.count === 1 ? '' : 's'} · ` +
                (yrs.length > 2 ? `${yrs[0]}–${yrs[yrs.length - 1]}` : yrs.join(' & '))}));

      const card = h('div', {class: 'card browse-card'}, header);

      if (open) {
        const body = h('div', {id: bodyId, style: {marginTop: '10px'}});
        for (const [sec, ms] of t.live) {
          if (sec)
            body.append(h('div', {class: 'browse-sec', text: sec}));
          const list = h('div', {class: 'browse-list'});
          for (const m of ms) list.append(measureRow(m));
          body.append(list);
        }
        card.append(body);
      }
      root.append(card);
    }
  }

  if (!shown) {
    root.append(h('div', {class: 'card'}, h('div', {class: 'empty'},
      `Nothing matches “${esc(q)}”.`, h('br'),
      h('span', {class: 'hint', text:
        'Try a broader word — the census calls things by their own names, so ' +
        '"hogs" not "pigs", "equine" not "horses", "floriculture" not "flowers".'}))));
  } else if (terms.length) {
    root.append(h('p', {class: 'hint', style: {margin: '4px 2px'},
      text: `${shown.toLocaleString()} measure${shown === 1 ? '' : 's'} match “${q}”.`}));
  }
}

/** One measure: what it is, how well it is reported, and two ways to use it. */
function measureRow(m) {
  const isPrimary = STATE.metric === m.id;
  const isSecond = STATE.metric2 === m.id;
  const pct = Math.round(m.coverage / DB.counties.length * 100);

  const row = h('div', {class: 'browse-row' + (isPrimary ? ' on' : '')});

  row.append(h('button', {class: 'pick', title: 'Select this measure and show the map',
    onclick: () => pickMeasure(m.id)},
    h('span', {class: 'lab', text: m.label}),
    h('span', {class: 'meta'},
      h('span', {text: m.years.length > 2
        ? `${m.years[0]}–${m.years[m.years.length - 1]}` : m.years.join(' & ')}),
      m.years.length >= 3 ? h('span', {text: '·'}) : null,
      m.years.length >= 3 ? h('span', {style: {color: 'var(--accent)'},
        title: 'Carries all five censuses — can be drawn on the County trends view',
        text: 'trend'}) : null,
      m.hasCV ? h('span', {text: '·'}) : null,
      m.hasCV ? h('span', {title:
        'USDA publishes a coefficient of variation for this measure, so the ' +
        'tooltip can say how reliable each county figure is', text: 'CV'}) : null,
      h('span', {text: '·'}),
      h('span', {title: `${m.coverage} of ${DB.counties.length} counties report a figure`,
        text: `${m.coverage}/${DB.counties.length} counties`}),
      m.suppressed ? h('span', {text: '·'}) : null,
      m.suppressed ? h('span', {title:
        'Cells the census withheld to avoid disclosing an individual operation',
        text: `${m.suppressed} withheld`}) : null)));

  // Full coverage is the norm, so it earns no ink. Only the gaps are worth
  // showing — a half-full bar is the signal that a measure is patchy.
  if (m.coverage < DB.counties.length)
    row.append(h('span', {class: 'cov',
      title: `Reported for ${m.coverage} of ${DB.counties.length} counties`},
      h('i', {style: {width: `${pct}%`}})));

  row.append(h('button', {
    class: 'cmp' + (isSecond ? ' on' : ''),
    title: isSecond ? 'Remove from the comparison slot' : 'Use as the second measure (scatter, bivariate map)',
    text: isSecond ? '✓ vs' : 'vs',
    onclick: e => {
      e.stopPropagation();
      STATE.metric2 = isSecond ? null : m.id;
      render();
    }}));

  return row;
}

/** Select a measure and land somewhere it can actually be seen. */
function pickMeasure(id) {
  const m = DB.metricById.get(id);
  if (!m) return;
  STATE.metric = id;
  STATE.year = m.years[m.years.length - 1];
  STATE.delta = false;
  STATE.view = 'map';
  render();
}

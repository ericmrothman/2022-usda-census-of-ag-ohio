/* ============================================================================
   The control panel. One filter surface for every view — nothing chart-local.
   ========================================================================== */

/**
 * Every control re-renders the whole app, which rebuilds this panel from
 * scratch. Anything the reader has adjusted about the panel itself — which
 * sections are open, how far the county list is scrolled, what is typed in its
 * filter — therefore has to live in STATE and be restored, or picking a colour
 * ramp would snap the Colour section shut under your cursor.
 */
function buildSidebar(aside) {
  const scroll = aside.scrollTop;
  const listScroll = (aside.querySelector('.county-list') || {}).scrollTop || 0;
  const activeId = document.activeElement && document.activeElement.dataset
    ? document.activeElement.dataset.keep : null;
  const caret = activeId && document.activeElement.selectionStart;

  clear(aside);
  aside.append(
    groupMeasure(),
    groupTime(),
    groupNormalise(),
    groupCounties(),
    groupColour(),
    groupDisplay(),
    groupAbout(),
  );

  aside.scrollTop = scroll;
  const list = aside.querySelector('.county-list');
  if (list) list.scrollTop = listScroll;
  if (activeId) {
    const el = aside.querySelector(`[data-keep="${activeId}"]`);
    if (el) {
      el.focus();
      if (caret != null && el.setSelectionRange) el.setSelectionRange(caret, caret);
    }
  }
}

function group(title, defaultOpen, ...body) {
  STATE.groupOpen = STATE.groupOpen || {};
  const open = STATE.groupOpen[title] ?? defaultOpen;
  const d = h('details', {class: 'group'},
    h('summary', {text: title}),
    h('div', {class: 'body'}, ...body));
  if (open) d.setAttribute('open', '');
  d.addEventListener('toggle', () => { STATE.groupOpen[title] = d.open; });
  return d;
}

function segmented(options, current, onPick) {
  const wrap = h('div', {class: 'seg'});
  for (const o of options) {
    wrap.append(h('button', {
      'aria-pressed': String(o.id === current), text: o.label,
      title: o.desc || '', onclick: () => onPick(o.id),
    }));
  }
  return wrap;
}

/* ------------------------------------------------------------------ measure */

function groupMeasure() {
  return group('Measure', true,
    metricPicker('metric', 'Primary measure'),
    metricPicker('metric2', 'Compare with (optional)', true),
    h('button', {class: 'btn', style: {width: '100%'},
      text: 'Browse all measures →',
      title: 'The full dictionary, laid out the way the census organises it',
      onclick: () => { STATE.view = 'browse'; render(); }}),
    h('p', {class: 'hint',
      text: `${DB.metrics.length.toLocaleString()} measures from the printed county ` +
            `tables and USDA's Quick Stats release. Search above if you know what ` +
            `you want; browse if you don't.`}));
}

function metricPicker(key, label, clearable) {
  const cur = DB.metricById.get(STATE[key]);
  const box = h('div', {class: 'picker'});
  const btn = h('button', {class: 'current'},
    h('span', {class: 'lab', text: cur ? cur.label : 'Choose a measure…'}),
    h('span', {class: 'ctx', text: cur ? `${cur.context} · ${cur.table}` : ''}));
  const field = h('label', {class: 'field'}, h('span', {text: label}), box);
  box.append(btn);

  let panel = null;
  const close = () => { if (panel) { panel.remove(); panel = null; } };

  btn.addEventListener('click', () => {
    if (panel) return close();
    panel = h('div', {class: 'results'});
    const input = h('input', {type: 'search', placeholder: 'Search measures…',
      style: {marginBottom: '5px'}});
    const list = h('div');
    panel.append(input, list);
    box.append(panel);
    input.focus();

    const paint = q => {
      clear(list);
      const hits = searchMetrics(q, key === 'metric2');
      if (!hits.length) {
        list.append(h('div', {class: 'hint', style: {padding: '10px'},
          text: 'Nothing matches. Try a crop, an animal, or a dollar amount.'}));
        return;
      }
      let topic = null;
      for (const m of hits.slice(0, 120)) {
        if (m.topic !== topic) {
          topic = m.topic;
          list.append(h('div', {class: 'head', text: topic}));
        }
        list.append(h('div', {class: 'opt', onclick: () => {
          STATE[key] = m.id;
          close();
          render();
        }},
          h('div', {class: 'lab', text: m.label}),
          h('div', {class: 'ctx',
            text: `${m.context} · ${m.table} · ${m.years.join('/')} · ${m.coverage}/88 counties`})));
      }
      if (hits.length > 120)
        list.append(h('div', {class: 'hint', style: {padding: '8px'},
          text: `…and ${hits.length - 120} more. Keep typing to narrow it down.`}));
    };
    paint('');
    input.addEventListener('input', () => paint(input.value));
    setTimeout(() => document.addEventListener('click', function once(e) {
      if (panel && !box.contains(e.target)) { close(); document.removeEventListener('click', once); }
    }), 0);
  });

  if (clearable && cur) {
    field.append(h('button', {class: 'btn sm', text: 'Clear comparison',
      onclick: () => { STATE[key] = null; render(); }}));
  }
  return field;
}

function searchMetrics(q, allowAny) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const pool = DB.metrics;
  if (!terms.length) {
    // Lead with the headline table so the first thing offered is meaningful.
    const head = pool.filter(m => m.table === 'Table 1');
    return [...head, ...pool.filter(m => m.table !== 'Table 1')];
  }
  const scored = [];
  for (const m of pool) {
    const hay = `${m.label} ${m.context} ${m.topic} ${m.table}`.toLowerCase();
    if (!terms.every(t => hay.includes(t))) continue;
    let score = m.coverage;
    if (m.label.toLowerCase().startsWith(terms[0])) score += 200;
    if (m.table === 'Table 1') score += 60;
    if (m.years.length > 1) score += 40;
    scored.push({m, score});
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(d => d.m);
}

/* --------------------------------------------------------------------- time */

function groupTime() {
  const m = DB.metricById.get(STATE.metric);
  const years = m ? m.years : ['2022'];
  const body = [
    h('label', {class: 'field'}, h('span', {text: 'Census year'}),
      segmented(years.map(y => ({id: y, label: y})), bestYear(STATE.metric, STATE.year),
        y => { STATE.year = y; STATE.delta = false; render(); })),
  ];

  if (years.length > 1) {
    const pair = deltaYears(STATE.metric) || [years[0], years[years.length - 1]];
    body.push(h('div', {class: 'row'},
      h('button', {class: `btn${STATE.delta ? ' primary' : ''}`,
        text: `Change ${pair[0]} → ${pair[1]}`,
        onclick: () => { STATE.delta = !STATE.delta; render(); }}),
      STATE.delta ? segmented(
        [{id: 'pct', label: '%'}, {id: 'abs', label: 'absolute'}],
        STATE.deltaPct ? 'pct' : 'abs',
        v => { STATE.deltaPct = v === 'pct'; render(); }) : null));

    // With five censuses "the change" stops being obvious, so name the pair.
    if (STATE.delta && years.length > 2) {
      const pick = (which, current) => {
        const sel = h('select', {onchange: e => {
          STATE[which] = e.target.value; render();
        }});
        for (const y of years)
          sel.append(h('option', {value: y, selected: y === current, text: y}));
        return sel;
      };
      body.push(h('label', {class: 'field'}, h('span', {text: 'Between which censuses'}),
        h('div', {class: 'row'},
          pick('yearFrom', pair[0]),
          h('span', {class: 'hint', text: '→'}),
          pick('yearTo', pair[1]),
          h('button', {class: 'btn sm', text: 'Full span', onclick: () => {
            STATE.yearFrom = null; STATE.yearTo = null; render();
          }}))));
    }
  } else {
    body.push(h('p', {class: 'hint',
      text: 'The census published this measure once, so there is no change to draw. ' +
            'Measures from Quick Stats carry all five censuses, 2002 to 2022.'}));
  }

  if (m) {
    body.push(h('p', {class: 'hint',
      text: `${sourceLabel(m)} · ${years.length} census ` +
            `${years.length === 1 ? 'year' : 'years'}: ${years.join(', ')}`}));
  }
  return group('Time', true, ...body.filter(Boolean));
}

/* --------------------------------------------------------------- normalise */

function groupNormalise() {
  const cur = MODE_BY_ID.get(STATE.mode);
  return group('How to count it', true,
    h('div', {class: 'seg'}, MODES.map(o => h('button', {
      'aria-pressed': String(o.id === STATE.mode), text: o.label, title: o.desc,
      onclick: () => { STATE.mode = o.id; render(); },
    }))),
    h('p', {class: 'hint', text: cur ? cur.desc : ''}));
}

/* ---------------------------------------------------------------- counties */

function groupCounties() {
  const sel = STATE.selected;
  const n = activeCounties().length;

  const search = h('input', {type: 'search', placeholder: 'Filter the list…',
    'data-keep': 'countySearch', value: STATE.countyQuery || '',
    oninput: e => { STATE.countyQuery = e.target.value; paint(); }});
  const list = h('div', {class: 'county-list'});
  const ser = STATE.metric ? series(STATE.metric, STATE.year, STATE.mode) : null;

  const paint = () => {
    clear(list);
    const q = (STATE.countyQuery || '').toLowerCase();
    DB.counties.forEach((cty, i) => {
      if (q && !cty.name.toLowerCase().includes(q)) return;
      const on = !sel || sel.size === 0 ? !STATE.exclude : sel.has(cty.name);
      const row = h('label', {class: 'cty'},
        h('input', {type: 'checkbox', checked: sel ? sel.has(cty.name) : false,
          onchange: () => toggleCounty(cty.name, true)}),
        h('span', {text: cty.name}),
        ser ? h('span', {class: 'v', text: fmtNumber(ser.values[i], ser.unit)}) : null);
      list.append(row);
    });
  };
  paint();

  const presetChips = h('div', {class: 'chips'});
  const presets = {
    'All 88': null,
    ...DB.presets,
    'Top 10 here': topNames(10),
    'Bottom 10 here': topNames(10, true),
    ...STATE.collections,
  };
  for (const [name, names] of Object.entries(presets)) {
    presetChips.append(h('button', {class: 'chip', text: name, onclick: () => {
      STATE.selected = names ? new Set(names) : null;
      STATE.exclude = false;
      render();
    }}));
  }

  return group('Counties', false,
    h('div', {class: 'row'},
      h('span', {class: 'hint', style: {flex: '1'},
        text: `${n} of ${DB.counties.length} in play` +
              (STATE.exclude && sel && sel.size ? ` (${sel.size} excluded)` : '')}),
      h('button', {class: 'btn sm', text: 'Reset',
        onclick: () => { STATE.selected = null; STATE.exclude = false; render(); }})),
    segmented([{id: 'in', label: 'Keep only these'}, {id: 'out', label: 'Leave these out'}],
      STATE.exclude ? 'out' : 'in',
      v => { STATE.exclude = v === 'out'; render(); }),
    presetChips,
    search, list,
    h('div', {class: 'row'},
      h('button', {class: 'btn sm', text: 'Select all', onclick: () => {
        STATE.selected = new Set(DB.counties.map(c => c.name)); STATE.exclude = false; render();
      }}),
      h('button', {class: 'btn sm', text: 'Invert', onclick: () => {
        const cur = new Set(activeNames());
        STATE.selected = new Set(DB.counties.map(c => c.name).filter(nn => !cur.has(nn)));
        STATE.exclude = false; render();
      }}),
      h('button', {class: 'btn sm', text: 'Save as collection…', onclick: saveCollection})),
    Object.keys(STATE.collections).length
      ? h('p', {class: 'hint', text: 'Saved collections appear as chips above. ' +
          'Shift-click a chip to delete it.'}) : null);
}

function topNames(k, bottom) {
  if (!STATE.metric) return [];
  const ser = series(STATE.metric, STATE.year, STATE.mode);
  const idx = ser.values.map((v, i) => [v, i]).filter(d => d[0] != null)
    .sort((a, b) => bottom ? a[0] - b[0] : b[0] - a[0]);
  return idx.slice(0, k).map(d => DB.counties[d[1]].name);
}

function toggleCounty(name, fromList) {
  if (!STATE.selected) STATE.selected = new Set(fromList ? [] : activeNames());
  const sel = STATE.selected;
  if (sel.has(name)) sel.delete(name); else sel.add(name);
  if (sel.size === 0) STATE.selected = null;
  STATE.focus = name;
  render();
}

function saveCollection() {
  const names = activeNames();
  if (!names.length) return toast('Nothing selected to save.');
  const name = prompt(`Name this collection of ${names.length} counties:`);
  if (!name) return;
  STATE.collections[name] = names;
  saveState();
  render();
}

/* ------------------------------------------------------------------ colour */

function groupColour() {
  const ramps = h('div', {class: 'ramps'});
  for (const [key, def] of Object.entries(RAMPS)) {
    const steps = def[isDark() ? 'dark' : 'light'];
    ramps.append(h('button', {
      class: 'ramp', 'aria-pressed': String(!STATE.diverging && STATE.ramp === key),
      onclick: () => { STATE.ramp = key; STATE.diverging = false; render(); },
    },
      h('span', {class: 'nm', text: def.name}),
      h('span', {class: 'bar'}, steps.map(cc => h('i', {style: {background: cc}})))));
  }
  for (const [key, def] of Object.entries(DIVERGING)) {
    const cols = divergingColors(key, 7, false);
    ramps.append(h('button', {
      class: 'ramp', 'aria-pressed': String(STATE.diverging && STATE.divKey === key),
      onclick: () => { STATE.divKey = key; STATE.diverging = true; render(); },
    },
      h('span', {class: 'nm', text: def.name}),
      h('span', {class: 'bar'}, cols.map(cc => h('i', {style: {background: cc}})))));
  }

  const autoDiv = STATE.delta || STATE.mode === 'z' || STATE.mode === 'lq';

  return group('Colour', false,
    ramps,
    autoDiv ? h('p', {class: 'hint',
      text: 'This measure has a natural midpoint, so a diverging ramp is in use ' +
            'whichever ramp is selected — the pair above sets which two hues.'}) : null,
    h('label', {class: 'field'}, h('span', {text: `Classes: ${STATE.nClasses}`}),
      h('input', {type: 'range', min: 3, max: 9, value: STATE.nClasses,
        oninput: e => { STATE.nClasses = +e.target.value; render(); }})),
    h('label', {class: 'field'}, h('span', {text: 'Where the class edges go'}),
      segmented(BREAK_MODES, STATE.breakMode, v => { STATE.breakMode = v; render(); })),
    h('p', {class: 'hint',
      text: BREAK_MODES.find(b => b.id === STATE.breakMode).desc}),
    h('div', {class: 'row'},
      h('button', {class: `btn${STATE.reverse ? ' primary' : ''}`, text: 'Reverse ramp',
        onclick: () => { STATE.reverse = !STATE.reverse; render(); }})));
}

/* ----------------------------------------------------------------- display */

function groupDisplay() {
  return group('Display', false,
    h('div', {class: 'row'},
      h('button', {class: `btn${STATE.showLabels ? ' primary' : ''}`,
        text: 'Value labels', onclick: () => { STATE.showLabels = !STATE.showLabels; render(); }})),
    h('label', {class: 'field'}, h('span', {text: 'Sort bars by'}),
      segmented([{id: 'value', label: 'Value'}, {id: 'name', label: 'Name'}],
        STATE.sortBy, v => { STATE.sortBy = v; render(); })),
    h('label', {class: 'field'},
      h('span', {text: STATE.topN ? `Show top ${STATE.topN}` : 'Show all counties'}),
      h('input', {type: 'range', min: 0, max: 40, step: 5, value: STATE.topN,
        oninput: e => { STATE.topN = +e.target.value; render(); }})),
    STATE.focus ? h('div', {class: 'row'},
      h('span', {class: 'hint', style: {flex: '1'}, text: `Spotlight: ${STATE.focus}`}),
      h('button', {class: 'btn sm', text: 'Clear',
        onclick: () => { STATE.focus = null; render(); }})) : null);
}

function groupAbout() {
  const m = DB.metricById.get(STATE.metric);
  return group('About this figure', false,
    m ? h('p', {class: 'hint'},
      h('strong', {text: m.label}), h('br'),
      m.official ? h('span', {style: {fontFamily: 'var(--mono)', fontSize: '10.5px'},
        text: m.official}) : `${m.context}`, h('br'),
      `${sourceLabel(m)} · ${m.coverage} of 88 counties` +
      (m.suppressed ? ` · ${m.suppressed} withheld cell${m.suppressed === 1 ? '' : 's'}` : '')) : null,
    m && m.hasCV ? h('p', {class: 'hint',
      text: `USDA publishes a coefficient of variation for this measure in ` +
            `${(DB.cv[m.id] ? Object.keys(DB.cv[m.id]).sort() : []).join(', ')} — ` +
            `hover a county to see it. The 2002 and 2007 censuses were released ` +
            `without one, and not every measure carries it in every later year.`}) : null,
    m && isQuickStats(m) ? h('p', {class: 'hint',
      text: 'Taken from the Quick Stats bulk release rather than the printed ' +
            'tables, so it carries all five censuses and USDA’s own variable name.'}) : null,
    h('p', {class: 'hint', text: DB.source}),
    h('p', {class: 'hint',
      text: 'Codes in the source: (D) withheld to avoid disclosing an individual ' +
            'operation, (Z) rounds to zero, (NA) not available, (X) not applicable, ' +
            '- none. All appear here as blanks except "-", which is a true zero.'}));
}

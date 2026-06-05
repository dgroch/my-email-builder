'use strict';
// library.js — the interactive component library. Renders every component "alive" with sample
// data (from /api/gallery), supports live palette/lever variation, a variant-compare strip, and
// a coverage/gaps lens computed from /api/schema. Reuses el()/$() defined in app.js (classic
// scripts share one global scope); scoped in an IIFE so it adds no new globals of its own.

(function () {
  const BASE = 640; // render width: 640 (not 600) so the email's 600px mobile breakpoint stays off

  let SCHEMA = null;        // /api/schema (own copy — decoupled from app.js boot timing)
  let LIB = [];             // merged: schema meta + gallery sampleTokens/variants, per component
  let byName = {};
  let observer = null;      // lazy-renders previews as cards scroll into view
  let inited = false;

  // ── mode toggle (Builder ⇄ Library) ───────────────────────────────────────────
  function setMode(mode) {
    const lib = mode === 'library';
    document.body.classList.toggle('mode-library', lib);
    $('#library').classList.toggle('hidden', !lib);
    document.querySelector('main').classList.toggle('hidden', lib);
    $('#modeLibrary').classList.toggle('active', lib);
    $('#modeBuilder').classList.toggle('active', !lib);
    if (lib && !inited) initLibrary();
  }
  // Bind as soon as the script runs (buttons exist in the topbar).
  $('#modeBuilder').onclick = () => setMode('builder');
  $('#modeLibrary').onclick = () => setMode('library');

  // ── init: pull schema + gallery, build the merged model, render ────────────────
  async function initLibrary() {
    inited = true;
    const grid = $('#libGrid');
    try {
      const [schema, gallery] = await Promise.all([
        (window.SCHEMA_CACHE) || fetch('/api/schema').then((r) => r.json()),
        fetch('/api/gallery').then((r) => r.json()),
      ]);
      SCHEMA = schema;
      const sampleByName = {};
      for (const g of gallery.components) sampleByName[g.name] = g;
      LIB = schema.components.map((c) => ({ ...c, ...(sampleByName[c.name] || { sampleTokens: {}, variants: { palettes: [], lever: null } }) }));
      for (const c of LIB) byName[c.name] = c;
      buildFilters();
      renderGrid();
    } catch (e) {
      grid.innerHTML = '';
      grid.append(el('p', { class: 'empty warn', text: 'Could not load the component library: ' + (e.message || e) }));
    }
  }

  // ── filter controls ────────────────────────────────────────────────────────────
  function buildFilters() {
    const groups = [...new Set(LIB.map((c) => c.group))].sort();
    const gsel = $('#libGroup');
    for (const g of groups) gsel.append(el('option', { value: g, text: g }));
    const osel = $('#libObjective');
    for (const o of (SCHEMA.objectives || [])) osel.append(el('option', { value: o.id, text: o.id }));
    const rerender = () => renderGrid();
    let t = null;
    $('#libSearch').oninput = () => { clearTimeout(t); t = setTimeout(rerender, 180); };
    gsel.onchange = rerender; osel.onchange = rerender;
    $('#libDesigned').onchange = rerender; $('#libDraft').onchange = rerender;
    $('#btnCoverage').onclick = openCoverage;
    $('#coverageClose').onclick = () => $('#coverageDialog').close();
  }

  function currentFilters() {
    return {
      q: $('#libSearch').value.trim().toLowerCase(),
      group: $('#libGroup').value,
      objective: $('#libObjective').value,
      designed: $('#libDesigned').checked,
      draft: $('#libDraft').checked,
    };
  }
  function matches(c, f) {
    if (f.group && c.group !== f.group) return false;
    if (f.designed && !c.designed) return false;
    if (f.draft && !c.draft) return false;
    if (f.objective && !((c.bestFor || []).includes(f.objective))) return false;
    if (f.q) {
      const hay = [c.name, c.desc, (c.tokens || []).map((t) => t.name).join(' '), (c.bestFor || []).join(' '), c.visualRole || '']
        .join(' ').toLowerCase();
      if (!hay.includes(f.q)) return false;
    }
    return true;
  }

  // ── grid ─────────────────────────────────────────────────────────────────────
  function renderGrid() {
    const grid = $('#libGrid');
    if (observer) observer.disconnect();
    observer = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) { renderCardPreview(en.target._card); observer.unobserve(en.target); }
      }
    }, { rootMargin: '200px' });

    const f = currentFilters();
    const shown = LIB.filter((c) => matches(c, f));
    $('#libCount').textContent = `${shown.length} of ${LIB.length} components`;
    grid.innerHTML = '';
    if (!shown.length) { grid.append(el('p', { class: 'empty', text: 'No components match these filters.' })); return; }
    for (const c of shown) grid.append(buildCard(c));
  }

  function badge(text, cls) { return el('span', { class: 'lib-badge ' + (cls || ''), text }); }

  function buildCard(c) {
    const card = $('#libCardTpl').content.firstElementChild.cloneNode(true);
    card._state = { palette: (c.variants.palettes && c.variants.palettes[0]) || null, levers: {} };
    card._comp = c;
    card.querySelector('.lib-name').textContent = c.name;
    const badges = card.querySelector('.lib-badges');
    if (c.designed) badges.append(badge('designed ◆', 'designed'));
    if (c.static) badges.append(badge('static', 'plain'));
    if (c.draft) badges.append(badge('DRAFT', 'draft'));

    // lazy preview
    const frameWrap = card.querySelector('.lib-preview');
    frameWrap._card = card;
    observer.observe(frameWrap);

    buildControls(card);
    card.querySelector('.lib-desc').textContent = c.desc || '';
    buildIntent(card);

    card.querySelector('.lib-compare').onclick = () => toggleCompare(card);
    card.querySelector('.lib-copy').onclick = (e) => copyJson(c, card, e.target);
    return card;
  }

  // current tokens for a card = sample tokens, with chosen palette + levers layered on
  function tokensFor(c, state) {
    const t = { ...c.sampleTokens };
    if (state.palette && c.palettePresets) {
      const p = c.palettePresets.find((x) => x.name === state.palette);
      if (p) Object.assign(t, p.values);
    }
    if (state.levers) Object.assign(t, state.levers);
    return t;
  }

  // ── live palette + lever controls ──────────────────────────────────────────────
  function buildControls(card) {
    const c = card._comp;
    const wrap = card.querySelector('.lib-controls');
    wrap.innerHTML = '';
    // palette preset
    if (c.palettePresets && c.palettePresets.length > 1) {
      const sel = el('select', { onchange: (e) => { card._state.palette = e.target.value; renderCardPreview(card); } });
      for (const p of c.palettePresets) sel.append(el('option', { value: p.name, text: p.name, ...(card._state.palette === p.name ? { selected: 'selected' } : {}) }));
      wrap.append(el('label', { class: 'lib-ctrl' }, [el('span', { text: 'palette' }), sel]));
    }
    // each enum lever
    for (const t of c.tokens.filter((x) => x.type === 'enum')) {
      const sel = el('select', { onchange: (e) => { card._state.levers[t.name] = e.target.value; renderCardPreview(card); } });
      for (const o of (t.enumOptions || [])) sel.append(el('option', { value: o, text: o }));
      const cur = (card._state.levers[t.name]) || (t.enumOptions && t.enumOptions[0]);
      if (cur) sel.value = cur;
      wrap.append(el('label', { class: 'lib-ctrl' }, [el('span', { text: t.name.toLowerCase() }), sel]));
    }
  }

  function buildIntent(card) {
    const c = card._comp;
    const wrap = card.querySelector('.lib-intent');
    wrap.innerHTML = '';
    const rows = [];
    if (c.bestFor && c.bestFor.length) rows.push(['best for', c.bestFor, 'good']);
    if (c.avoidFor && c.avoidFor.length) rows.push(['avoid for', c.avoidFor, 'bad']);
    for (const [label, items, cls] of rows) {
      const r = el('div', { class: 'intent-row' }, [el('span', { class: 'intent-label', text: label })]);
      for (const it of items) r.append(el('span', { class: 'intent-chip ' + cls, text: it }));
      wrap.append(r);
    }
    const facts = [];
    if (c.tone) facts.push('tone: ' + c.tone);
    if (c.imageRatio) facts.push('image: ' + c.imageRatio);
    if (facts.length) wrap.append(el('p', { class: 'intent-facts', text: facts.join('  ·  ') }));
  }

  // ── preview rendering (assemble → scaled iframe) ────────────────────────────────
  async function assembleHtml(component, tokens) {
    const r = await fetch('/api/assemble', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign: { blocks: [{ component, tokens }] } }),
    });
    const { html } = await r.json();
    return html;
  }

  // Scale the 640px-wide email down to the card column width; height follows content.
  function fitFrame(frame) {
    const wrap = frame.parentElement;
    const scaleW = wrap.clientWidth || 320;
    const measure = () => {
      let h = 480;
      try {
        const doc = frame.contentDocument;
        h = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight) || h;
      } catch (_) {}
      const scale = scaleW / BASE;
      frame.style.width = BASE + 'px';
      frame.style.height = h + 'px';
      frame.style.transform = 'scale(' + scale + ')';
      wrap.style.height = Math.round(h * scale) + 'px';
    };
    frame.onload = () => { measure(); setTimeout(measure, 500); setTimeout(measure, 1200); };
  }

  async function renderCardPreview(card) {
    const c = card._comp;
    const frame = card.querySelector('.lib-frame');
    fitFrame(frame);
    try { frame.srcdoc = await assembleHtml(c.name, tokensFor(c, card._state)); }
    catch (_) { /* leave prior frame */ }
    // keep the variant strip in sync if it's open
    if (!card.querySelector('.lib-variants').classList.contains('hidden')) renderVariants(card);
  }

  // ── variant compare ─────────────────────────────────────────────────────────────
  function toggleCompare(card) {
    const strip = card.querySelector('.lib-variants');
    const btn = card.querySelector('.lib-compare');
    const open = strip.classList.toggle('hidden');
    btn.textContent = open ? 'Compare variants' : 'Hide variants';
    if (!open) renderVariants(card);
  }

  function variantCell(c, label, state) {
    const wrap = el('div', { class: 'variant-cell' }, [el('span', { class: 'variant-label', text: label })]);
    const fwrap = el('div', { class: 'variant-frame-wrap' });
    const frame = el('iframe', { class: 'lib-frame variant-frame', scrolling: 'no', title: label });
    fwrap.append(frame); wrap.append(fwrap);
    // render after it's in the DOM (needs clientWidth)
    setTimeout(async () => { fitFrame(frame); try { frame.srcdoc = await assembleHtml(c.name, tokensFor(c, state)); } catch (_) {} }, 0);
    return wrap;
  }

  function renderVariants(card) {
    const c = card._comp;
    const strip = card.querySelector('.lib-variants');
    strip.innerHTML = '';
    // palette presets across (holding current levers steady)
    if (c.palettePresets && c.palettePresets.length > 1) {
      const row = el('div', { class: 'variant-row' }, [el('span', { class: 'variant-row-label', text: 'palette' })]);
      const cells = el('div', { class: 'variant-cells' });
      for (const p of c.palettePresets) cells.append(variantCell(c, p.name, { palette: p.name, levers: card._state.levers }));
      row.append(cells); strip.append(row);
    }
    // first enum lever across (holding current palette steady)
    const lev = c.variants && c.variants.lever;
    if (lev && lev.options && lev.options.length > 1) {
      const row = el('div', { class: 'variant-row' }, [el('span', { class: 'variant-row-label', text: lev.name.toLowerCase() })]);
      const cells = el('div', { class: 'variant-cells' });
      for (const o of lev.options) {
        const levers = { ...card._state.levers, [lev.name]: o };
        cells.append(variantCell(c, o, { palette: card._state.palette, levers }));
      }
      row.append(cells); strip.append(row);
    }
    if (!strip.children.length) strip.append(el('p', { class: 'intent-facts', text: 'No palette or lever variants — this component is fixed.' }));
  }

  // ── copy JSON ────────────────────────────────────────────────────────────────────
  function copyJson(c, card, btn) {
    const payload = { blocks: [{ component: c.name, tokens: tokensFor(c, card._state) }] };
    const text = JSON.stringify(payload, null, 2);
    const done = () => { const o = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => { btn.textContent = o; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const ta = el('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text; document.body.append(ta);
    ta.select(); try { document.execCommand('copy'); } catch (_) {} ta.remove(); done();
  }

  // ── coverage / gaps lens ─────────────────────────────────────────────────────────
  function openCoverage() {
    const body = $('#coverageBody');
    body.innerHTML = '';
    const objectives = SCHEMA.objectives || [];
    const comps = SCHEMA.components;

    // referenced-by-guidance set, to find orphans
    const referenced = new Set();
    for (const o of objectives) for (const list of [o.blockSequence, o.heroOptions, o.proofModules]) for (const n of (list || [])) referenced.add(n);

    // 1. objective coverage table
    const tbl = el('table', { class: 'cov-table' });
    tbl.append(el('thead', {}, el('tr', {}, [
      el('th', { text: 'Objective' }), el('th', { text: 'bestFor' }), el('th', { text: 'Skeleton' }), el('th', { text: 'Components' }),
    ])));
    const tb = el('tbody');
    for (const o of objectives) {
      const best = comps.filter((c) => (c.bestFor || []).includes(o.id));
      const thin = best.length < 2;
      const chips = el('div', { class: 'cov-chips' });
      for (const c of best) chips.append(el('span', { class: 'intent-chip good', text: c.name.split('/').pop() }));
      if (!best.length) chips.append(el('span', { class: 'intent-facts', text: 'none — borrows from neighbours' }));
      tb.append(el('tr', { class: thin ? 'cov-thin' : '' }, [
        el('td', {}, [el('b', { text: o.id }), el('div', { class: 'intent-facts', text: o.label || '' })]),
        el('td', { class: 'cov-num', text: String(best.length) + (thin ? ' ⚠' : '') }),
        el('td', { class: 'cov-num', text: String((o.blockSequence || []).length) }),
        el('td', {}, chips),
      ]));
    }
    tbl.append(tb);
    body.append(el('h3', { text: 'Objective coverage' }), tbl,
      el('p', { class: 'kv-note', text: '⚠ = fewer than two components name this objective as “best for” — a candidate for a new or extended component.' }));

    // 2. drafts
    const drafts = comps.filter((c) => c.draft);
    body.append(el('h3', { text: 'Drafts — pending design review (' + drafts.length + ')' }));
    body.append(chipList(drafts.map((c) => c.name), 'draft'));

    // 3. unannotated (non-static, no intent) — candidates to document
    const unann = comps.filter((c) => !c.static && !(c.bestFor && c.bestFor.length));
    body.append(el('h3', { text: 'Missing intent metadata (' + unann.length + ')' }));
    body.append(el('p', { class: 'kv-note', text: 'Non-static components with no bestFor/avoidFor — add intent so they surface under an objective.' }));
    body.append(chipList(unann.map((c) => c.name), 'plain'));

    // 4. orphans — never named in any objective skeleton/options
    const orphans = comps.filter((c) => !c.static && !referenced.has(c.name) && !/^(header|footer)$/.test(c.name));
    body.append(el('h3', { text: 'Not referenced by any objective (' + orphans.length + ')' }));
    body.append(el('p', { class: 'kv-note', text: 'Components no objective’s sequence/hero/proof list mentions — either niche by design, or a hint to wire them in.' }));
    body.append(chipList(orphans.map((c) => c.name), 'plain'));

    $('#coverageDialog').showModal();
  }
  function chipList(names, cls) {
    const wrap = el('div', { class: 'cov-chips' });
    if (!names.length) wrap.append(el('span', { class: 'intent-facts', text: 'none 🎉' }));
    for (const n of names) wrap.append(el('span', { class: 'intent-chip ' + (cls || ''), text: n }));
    return wrap;
  }
})();

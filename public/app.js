'use strict';
// app.js — Fig & Bloom email builder UI. Generates token forms from /api/schema,
// keeps a campaign model, live-previews via /api/assemble, rasterises via /api/render.

let SCHEMA = null;
const byName = {};                          // component name -> schema entry
let campaign = { campaignName: '', bodyBg: '#2c2825', blocks: [] };
let uid = 1;

const $ = s => document.querySelector(s);
const el = (tag, props = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) if (c) n.append(c);
  return n;
};

const LONG = /BODY|TEXT|INTRO|SUB|QUOTE|DESC|ADDRESS/;
const isLong = name => LONG.test(name);

// ── boot ──────────────────────────────────────────────────────────────────────
fetch('/api/schema').then(r => r.json()).then(s => {
  SCHEMA = s;
  const groups = {};
  for (const c of s.components) { byName[c.name] = c; (groups[c.group] ||= []).push(c); }
  const sel = $('#addSelect');
  for (const g of Object.keys(groups).sort()) {
    const og = el('optgroup', { label: g });
    for (const c of groups[g]) og.append(el('option', { value: c.name, text: c.name.split('/').pop() + (c.designed ? '  ◆' : '') }));
    sel.append(og);
  }
  bindToolbar();
});

// ── campaign model helpers ──────────────────────────────────────────────────────
function defaultsFor(comp) {
  const tokens = {};
  for (const t of comp.tokens) tokens[t.name] = '';
  // palette: seed from first preset
  if (comp.palettePresets && comp.palettePresets.length) Object.assign(tokens, comp.palettePresets[0].values);
  // enum: seed first option
  for (const t of comp.tokens) if (t.type === 'enum' && t.enumOptions && t.enumOptions[0]) tokens[t.name] = t.enumOptions[0];
  return tokens;
}
function addBlock(name) {
  const comp = byName[name]; if (!comp) return;
  const block = { id: uid++, component: name, tokens: defaultsFor(comp) };
  if (comp.palettePresets && comp.palettePresets.length) block.palette = comp.palettePresets[0].name;
  campaign.blocks.push(block); renderBlocks(); livePreview();
}
function move(i, d) { const j = i + d; if (j < 0 || j >= campaign.blocks.length) return; [campaign.blocks[i], campaign.blocks[j]] = [campaign.blocks[j], campaign.blocks[i]]; renderBlocks(); livePreview(); }
function remove(i) { campaign.blocks.splice(i, 1); renderBlocks(); livePreview(); }

// ── case helpers ────────────────────────────────────────────────────────────────
const violatesLower = v => v && /[A-Z]/.test(v);
const violatesSentence = v => v && (v === v.toUpperCase() && /[A-Z]/.test(v) || /^[a-z]/.test(v));
function fixLower(v) { return v.toLowerCase(); }
function fixSentence(v) { let s = v; if (s === s.toUpperCase()) s = s.toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); }

// ── render block cards & fields ───────────────────────────────────────────────
function renderBlocks() {
  const wrap = $('#blocks'); wrap.innerHTML = '';
  if (!campaign.blocks.length) { wrap.append(el('p', { class: 'empty', html: 'No blocks yet. Add one above, or click <b>Sample</b>.' })); return; }
  campaign.blocks.forEach((block, i) => {
    const comp = byName[block.component]; if (!comp) return;
    const card = $('#blockCardTpl').content.firstElementChild.cloneNode(true);
    card.dataset.index = i;
    card.querySelector('.block-name').textContent = block.component;
    const tag = card.querySelector('.block-tag');
    if (comp.designed) tag.textContent = 'designed'; else if (comp.static) { tag.textContent = 'static'; tag.classList.add('plain'); } else { tag.textContent = 'text'; tag.classList.add('plain'); }
    card.querySelector('.up').onclick = () => move(i, -1);
    card.querySelector('.down').onclick = () => move(i, 1);
    card.querySelector('.remove').onclick = () => remove(i);
    card.querySelector('.collapse').onclick = () => card.classList.toggle('collapsed');
    const fields = card.querySelector('.block-fields');
    if (comp.static) fields.append(el('p', { class: 'desc', text: 'Static block — no editable tokens.' }));
    else buildFields(fields, comp, block);
    wrap.append(card);
  });
}

function buildFields(container, comp, block) {
  // palette selector (once, if present)
  if (comp.palettePresets && comp.palettePresets.length) {
    const sel = el('select', { onchange: e => {
      const p = comp.palettePresets.find(x => x.name === e.target.value);
      block.palette = e.target.value; Object.assign(block.tokens, p.values); renderBlocks(); livePreview();
    } });
    for (const p of comp.palettePresets) sel.append(el('option', { value: p.name, text: p.name, ...(block.palette === p.name ? { selected: 'selected' } : {}) }));
    const swatches = el('div', { class: 'palette-swatches' });
    const cur = comp.palettePresets.find(x => x.name === block.palette) || comp.palettePresets[0];
    for (const v of Object.values(cur.values)) swatches.append(el('span', { class: 'sw', style: `background:${v}` }));
    container.append(el('div', { class: 'field' }, [el('label', { text: 'Palette preset' }), sel, swatches]));
  }
  for (const t of comp.tokens) {
    if (t.type === 'palette') continue; // handled by preset selector
    container.append(fieldFor(t, block));
  }
}

function fieldFor(t, block) {
  const wrap = el('div', { class: 'field' });
  const lab = el('label', { text: t.name });
  if (t.case) lab.append(el('span', { class: 'case-chip ' + t.case, text: t.case === 'lower' ? 'lowercase' : 'Sentence case' }));
  if (t.markdown) lab.append(el('span', { class: 'md-chip', title: 'Inline markdown: **bold**, *italic*, [text](url)', text: 'markdown' }));
  wrap.append(lab);
  if (t.desc) wrap.append(el('p', { class: 'desc', text: t.desc }));

  const commit = (v) => { block.tokens[t.name] = v; scheduleLive(); };
  let input;
  if (t.type === 'enum') {
    input = el('select', { onchange: e => commit(e.target.value) });
    for (const o of t.enumOptions) input.append(el('option', { value: o, text: o, ...(block.tokens[t.name] === o ? { selected: 'selected' } : {}) }));
    wrap.append(input);
  } else if (t.type === 'image' || t.type === 'url') {
    const thumb = el('img', { class: 'thumb', ...(t.type === 'image' && block.tokens[t.name] ? { src: block.tokens[t.name] } : {}) });
    input = el('input', { type: 'url', value: block.tokens[t.name] || '', placeholder: 'https://…', oninput: e => { commit(e.target.value); if (t.type === 'image') thumb.src = e.target.value; } });
    wrap.append(el('div', { class: 'row' }, t.type === 'image' ? [thumb, input] : [input]));
  } else {
    input = el(isLong(t.name) ? 'textarea' : 'input', { value: block.tokens[t.name] || '', oninput: e => { commit(e.target.value); validate(); } });
    if (!isLong(t.name)) input.type = 'text';
    else input.textContent = block.tokens[t.name] || '';
    wrap.append(input);
  }

  // live case validation
  const warn = el('div', { class: 'warn hidden' });
  wrap.append(warn);
  function validate() {
    const v = block.tokens[t.name] || '';
    let bad = false, msg = '';
    if (t.case === 'lower' && violatesLower(v)) { bad = true; msg = 'Should be lowercase (Cervanttis).'; }
    if (t.case === 'sentence' && violatesSentence(v)) { bad = true; msg = 'Should be Sentence case (Lust).'; }
    warn.classList.toggle('hidden', !bad);
    if (bad) {
      warn.innerHTML = msg;
      const fix = el('button', { class: 'fix', text: 'fix', onclick: () => { const nv = t.case === 'lower' ? fixLower(v) : fixSentence(v); block.tokens[t.name] = nv; input.value = nv; validate(); scheduleLive(); } });
      warn.append(fix);
    }
  }
  validate();
  return wrap;
}

// ── preview ───────────────────────────────────────────────────────────────────
let liveTimer = null;
function scheduleLive() { clearTimeout(liveTimer); liveTimer = setTimeout(livePreview, 450); }
function setStatus(msg, cls = '') { const s = $('#status'); s.textContent = msg; s.className = 'status ' + cls; }

async function livePreview() {
  campaign.campaignName = $('#campaignName').value;
  campaign.bodyBg = $('#bodyBg').value || '#2c2825';
  const frame = $('#liveFrame');
  if (!campaign.blocks.length) { frame.srcdoc = ''; return; }
  setStatus('rendering…');
  // Preserve the preview's scroll position so an edit doesn't yank it back to the top.
  let prevScroll = 0;
  try { prevScroll = (frame.contentWindow && frame.contentWindow.scrollY) || 0; } catch (_) {}
  try {
    const r = await fetch('/api/assemble', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaign, markBlocks: true }) });
    const { html, unfilled } = await r.json();
    frame.onload = () => {
      frame.onload = null;
      try { frame.contentWindow.scrollTo(0, prevScroll); } catch (_) {}
      wirePreviewClicks(frame);
    };
    frame.srcdoc = html;
    if (unfilled.length) setStatus(`${unfilled.length} empty token${unfilled.length > 1 ? 's' : ''}`, 'warn');
    else setStatus('preview up to date', 'ok');
  } catch (e) { setStatus('preview error', 'warn'); }
}

// Click a block in the preview → focus its builder card on the left.
function wirePreviewClicks(frame) {
  let doc; try { doc = frame.contentDocument; } catch (_) { return; }
  if (!doc) return;
  doc.querySelectorAll('[data-eb-block]').forEach((node) => {
    node.style.cursor = 'pointer';
    node.addEventListener('click', (e) => {
      // don't hijack real links/buttons inside the block
      if (e.target.closest('a,button')) return;
      focusBlockCard(Number(node.getAttribute('data-eb-block')));
    });
  });
}

// Scroll the matching builder card into view and flash a highlight.
function focusBlockCard(index) {
  const card = document.querySelector(`#blocks .block-card[data-index="${index}"]`);
  if (!card) return;
  card.classList.remove('collapsed');
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
}

async function renderPng() {
  setStatus('rasterising (Puppeteer)…');
  showTab('png');
  try {
    const r = await fetch('/api/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaign }) });
    const { pngBase64, brokenImages } = await r.json();
    $('#pngImg').src = 'data:image/png;base64,' + pngBase64;
    if (brokenImages && brokenImages.length) setStatus(`${brokenImages.length} broken image(s)`, 'warn');
    else setStatus('rendered ✓', 'ok');
  } catch (e) { setStatus('render failed', 'warn'); }
}

function showTab(which) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === which));
  $('#liveFrame').classList.toggle('hidden', which !== 'live');
  $('#pngWrap').classList.toggle('hidden', which !== 'png');
  $('#slicesWrap').classList.toggle('hidden', which !== 'slices');
}

// ── slices (one PNG per block, for hand-assembly in Klaviyo) ────────────────────
let SLICES = [];
async function renderSlices() {
  if (!campaign.blocks.length) { setStatus('add a block first', 'warn'); return; }
  setStatus('slicing (Puppeteer)…');
  $('#btnDownloadSlices').disabled = true;
  try {
    const r = await fetch('/api/render-slices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaign }) });
    const { slices, brokenImages } = await r.json();
    SLICES = slices || [];
    const wrap = $('#slices'); wrap.innerHTML = '';
    SLICES.forEach((s) => {
      const name = sliceName(s);
      // Per-block link: editable for image blocks; the unsubscribe footer stays live HTML.
      let linkRow;
      if (s.keepHtml) {
        linkRow = el('div', { class: 'slice-link note', text: 'Stays as live HTML (keeps the unsubscribe link) — not an image.' });
      } else {
        const input = el('input', { type: 'url', class: 'slice-link-input', value: s.link || '', placeholder: 'https://… (this block’s click-through URL)',
          oninput: e => { s.link = e.target.value; } });
        linkRow = el('label', { class: 'slice-link' }, [el('span', { text: 'Link URL' }), input]);
      }
      const card = el('div', { class: 'slice' }, [
        el('div', { class: 'slice-head' }, [
          el('span', { class: 'slice-name', text: name }),
          el('a', { class: 'slice-dl', text: 'download', download: name, href: 'data:image/png;base64,' + s.pngBase64 }),
        ]),
        el('img', { class: 'slice-img', src: 'data:image/png;base64,' + s.pngBase64, alt: s.component }),
        linkRow,
      ]);
      wrap.append(card);
    });
    $('#btnDownloadSlices').disabled = !SLICES.length;
    if (brokenImages && brokenImages.length) setStatus(`${SLICES.length} slices · ${brokenImages.length} broken image(s)`, 'warn');
    else setStatus(`${SLICES.length} slices ✓`, 'ok');
  } catch (e) { setStatus('slicing failed', 'warn'); }
}
function sliceName(s) {
  const n = String(s.index + 1).padStart(2, '0');
  return `${n}-${s.component.replace(/[\/]+/g, '-')}.png`;
}
async function downloadSlices() {
  if (!SLICES.length) return;
  const files = SLICES.map(s => ({ name: sliceName(s), bytes: b64ToBytes(s.pngBase64) }));
  const blob = zipStore(files);
  download((campaign.campaignName || 'email').replace(/\W+/g, '-').toLowerCase() + '-slices.zip', blob, 'application/zip');
}

// base64 → Uint8Array
function b64ToBytes(b64) {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Minimal ZIP (STORE / no compression) — PNGs are already compressed. Returns a Blob.
function zipStore(files) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  const u16 = n => [n & 255, (n >> 8) & 255];
  const u32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  for (const f of files) {
    const name = enc.encode(f.name), data = f.bytes, crc = crc32(data);
    const local = [].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0));
    chunks.push(new Uint8Array(local), name, data);
    central.push([].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset)), name);
    offset += local.length + name.length + data.length;
  }
  const cenStart = offset; let cenSize = 0;
  for (const c of central) { const a = c instanceof Uint8Array ? c : new Uint8Array(c); chunks.push(a); cenSize += a.length; }
  const end = [].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cenSize), u32(cenStart), u16(0));
  chunks.push(new Uint8Array(end));
  return new Blob(chunks, { type: 'application/zip' });
}
const CRC_TABLE = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

// ── export / import ─────────────────────────────────────────────────────────────
function download(name, content, type) {
  const blob = new Blob([content], { type }); const a = el('a', { href: URL.createObjectURL(blob), download: name }); a.click(); URL.revokeObjectURL(a.href);
}
async function exportHtml() {
  const r = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaign }) });
  const { html } = await r.json();
  download((campaign.campaignName || 'email').replace(/\W+/g, '-').toLowerCase() + '.html', html, 'text/html');
}
function exportJson() { download((campaign.campaignName || 'campaign').replace(/\W+/g, '-').toLowerCase() + '.json', JSON.stringify(campaign, null, 2), 'application/json'); }
function importJson(file) {
  const fr = new FileReader();
  fr.onload = () => { try { campaign = JSON.parse(fr.result); uid = Math.max(1, ...campaign.blocks.map(b => b.id || 0)) + 1; currentDesignId = null; hydrate(); } catch (e) { alert('Invalid JSON'); } };
  fr.readAsText(file);
}
function hydrate() {
  $('#campaignName').value = campaign.campaignName || '';
  $('#bodyBg').value = campaign.bodyBg || '#2c2825';
  renderBlocks(); livePreview();
}

// ── create campaign from a brief (fig-bloom-email-generator skill) ─────────────
let _cachedLiveContext = null;

function setLiveContextChips(ctx, loading) {
  const root = $('#createLiveContext');
  if (!root) return;
  const chips = root.querySelectorAll('.clc-chip');
  const labels = { products: 'Products', images: 'Lifestyle images', audiences: 'Audiences', blogPosts: 'Blog posts' };
  for (const chip of chips) {
    const src = chip.dataset.source;
    chip.classList.remove('ok', 'unavailable', 'loading');
    const count = chip.querySelector('.count');
    if (loading) {
      chip.classList.add('loading');
      count.textContent = '…';
    } else if (!ctx) {
      chip.classList.add('unavailable');
      count.textContent = '—';
    } else {
      const ok = (ctx.contextStatus || {})[src] === 'ok';
      chip.classList.add(ok ? 'ok' : 'unavailable');
      const n = src === 'products' ? (ctx.products || []).length
        : src === 'images' ? (ctx.images || []).length
        : src === 'audiences' ? (ctx.audiences || []).length
        : (ctx.blogPosts || []).length;
      count.textContent = ok ? (n + ' live') : 'unavailable';
    }
  }
  const detail = root.querySelector('.clc-detail');
  if (loading) {
    detail.textContent = 'Fetching from Shopify, the asset library, Klaviyo and Notion…';
  } else if (!ctx) {
    detail.textContent = 'Live context unreachable. The generator will run without it.';
  } else {
    const parts = [];
    if (ctx.asOf) parts.push('as of ' + ctx.asOf);
    const liveSources = ['products', 'images', 'audiences', 'blogPosts'];
    const liveCount = liveSources.filter((s) => (ctx.contextStatus || {})[s] === 'ok').length;
    parts.push(liveCount + ' of 4 sources live');
    if (ctx.errors && ctx.errors.images) parts.push('· Asset library: ' + ctx.errors.images);
    if (ctx.errors && ctx.errors.blogPosts) parts.push('· Notion blog index: ' + ctx.errors.blogPosts);
    if (ctx.errors && ctx.errors.audiences) parts.push('· Klaviyo: ' + ctx.errors.audiences);
    if (ctx.errors && ctx.errors.products) parts.push('· Shopify: ' + ctx.errors.products);
    detail.textContent = parts.join('  ');
  }
}

async function fetchLiveContext(forceFresh) {
  const url = '/api/live-context' + (forceFresh ? '?fresh=1' : '');
  const r = await fetch(url);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

function openCreate() {
  $('#createStatus').hidden = true;
  $('#createStatus').textContent = '';
  $('#createBrief').value = '';
  $('#createAudience').value = 'RH | All Email Subscribers';
  $('#createSave').checked = true;
  $('#createSubmit').disabled = false;
  $('#createDialog').showModal();
  setTimeout(() => $('#createBrief').focus(), 50);
  // Fire-and-forget live context fetch. The user can start typing the brief
  // while the chips update; the cached value is sent on submit.
  setLiveContextChips(null, true);
  fetchLiveContext(false)
    .then((ctx) => { _cachedLiveContext = ctx; setLiveContextChips(ctx, false); })
    .catch((e) => { _cachedLiveContext = null; setLiveContextChips(null, false); });
}

function setCreateStatus(msg, cls) {
  const s = $('#createStatus');
  s.textContent = msg;
  s.className = 'create-status ' + (cls || '');
  s.hidden = !msg;
}

async function submitCreate() {
  const brief = ($('#createBrief').value || '').trim();
  const audience = ($('#createAudience').value || '').trim() || 'RH | All Email Subscribers';
  const save = $('#createSave').checked;
  if (!brief) { setCreateStatus('Tell me what the campaign is for — at least one sentence.', 'err'); $('#createBrief').focus(); return; }
  const btn = $('#createSubmit');
  btn.disabled = true;
  setCreateStatus('Refreshing live context (semantic image search uses the brief as the query) and generating… this can take 30–90s on a cold start.', 'pending');
  // Refresh the live context with the brief as the asset-library search query
  // so the LLM gets semantically-ranked lifestyle imagery, not the empty-brief
  // pre-fetch. Cache is bypassed for this so the user always gets fresh results.
  let ctx = _cachedLiveContext;
  try {
    const r2 = await fetch('/api/live-context?q=' + encodeURIComponent(brief) + '&fresh=1');
    if (r2.ok) ctx = await r2.json();
  } catch (_) { /* fall through with cached context */ }
  if (ctx) setLiveContextChips(ctx, false);
  try {
    const r = await fetch('/api/campaigns/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brief, audience, save, liveContext: ctx || undefined }),
    });
    const data = await r.json();
    if (!r.ok) {
      setCreateStatus('Generation failed: ' + (data.error || r.status) + (data.code ? ' [' + data.code + ']' : ''), 'err');
      btn.disabled = false;
      return;
    }
    if (data.needsClarification) {
      setCreateStatus('Need one clarification: ' + data.needsClarification, 'pending');
      btn.disabled = false;
      return;
    }
    const camp = data.campaign;
    if (!camp || !Array.isArray(camp.blocks)) {
      setCreateStatus('Generation returned an unexpected shape. Check the server logs.', 'err');
      btn.disabled = false;
      return;
    }
    // Load the campaign into the builder.
    campaign = JSON.parse(JSON.stringify(camp));
    uid = Math.max(1, ...campaign.blocks.map(b => (b && b.id) || 0)) + 1;
    if (data.design && data.design.id) currentDesignId = data.design.id;
    else currentDesignId = null;
    $('#campaignName').value = campaign.campaignName || (data.design && data.design.name) || '';
    $('#bodyBg').value = campaign.bodyBg || '#2c2825';
    hydrate();
    // Close the modal — campaign is now in the builder.
    $('#createDialog').close();
    const v = data.validation || {};
    const ok = v.ok ? '✓' : '⚠';
    const issues = (v.issues && v.issues.length) ? ' (' + v.issues.length + ' validation note' + (v.issues.length === 1 ? '' : 's') + ')' : '';
    let liveMsg = '';
    if (data.liveContext) {
      const lc = data.liveContext;
      const liveSources = ['products', 'images', 'audiences', 'blogPosts'];
      const liveCount = (lc.contextStatus && liveSources.filter((s) => lc.contextStatus[s] === 'ok').length) || 0;
      liveMsg = ' · live context ' + liveCount + '/4 (' + lc.productCount + ' products, ' + lc.imageCount + ' images, ' + lc.audienceCount + ' audiences, ' + lc.blogPostCount + ' blog posts)';
    } else {
      liveMsg = ' · no live context';
    }
    setStatus('campaign generated ' + ok + issues + liveMsg, v.ok ? 'ok' : 'warn');
  } catch (e) {
    setCreateStatus('Request failed: ' + (e && e.message || e), 'err');
  } finally {
    btn.disabled = false;
  }
}

// ── toolbar ─────────────────────────────────────────────────────────────────────
function bindToolbar() {
  $('#btnAdd').onclick = () => { const v = $('#addSelect').value; if (v) addBlock(v); };
  $('#addSelect').onchange = e => { if (e.target.value) { addBlock(e.target.value); e.target.value = ''; } };
  $('#campaignName').oninput = scheduleLive;
  $('#bodyBg').oninput = scheduleLive;
  $('#btnRender').onclick = renderPng;
  $('#btnRenderSlices').onclick = renderSlices;
  $('#btnDownloadSlices').onclick = downloadSlices;
  $('#btnExportHtml').onclick = exportHtml;
  $('#btnExportJson').onclick = exportJson;
  $('#btnImport').onclick = () => $('#fileImport').click();
  $('#fileImport').onchange = e => e.target.files[0] && importJson(e.target.files[0]);
  $('#btnSample').onclick = () => { campaign = JSON.parse(JSON.stringify(SAMPLE)); uid = campaign.blocks.length + 1; currentDesignId = null; hydrate(); };
  $('#btnKlaviyo').onclick = openKlaviyo;
  $('#kvSubmit').onclick = submitKlaviyo;
  $('#btnSave').onclick = saveDesign;
  $('#btnDesigns').onclick = openDesigns;
  $('#btnCreate').onclick = openCreate;
  $('#createSubmit').onclick = submitCreate;
  $('#createCancel').onclick = () => $('#createDialog').close();
  $('#designsClose').onclick = () => $('#designsDialog').close();
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => showTab(t.dataset.tab));
}

// ── persisted designs (save / reopen / clone / delete) ──────────────────────────
let currentDesignId = null;   // server id of the design currently loaded (null = unsaved)

async function saveDesign() {
  campaign.campaignName = $('#campaignName').value;
  campaign.bodyBg = $('#bodyBg').value || '#2c2825';
  if (!campaign.blocks.length) { setStatus('nothing to save', 'warn'); return; }
  try {
    let r;
    if (currentDesignId) {
      r = await fetch('/api/designs/' + currentDesignId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: campaign.campaignName, campaign }) });
    } else {
      const name = prompt('Name this design:', campaign.campaignName || 'Untitled design');
      if (name === null) return;
      r = await fetch('/api/designs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, campaign }) });
    }
    if (!r.ok) throw new Error('save failed');
    const d = await r.json();
    currentDesignId = d.id;
    setStatus('saved ✓', 'ok');
  } catch (e) { setStatus('save failed', 'warn'); }
}

async function openDesigns() {
  const list = $('#designsList');
  list.innerHTML = '<p class="desc">Loading…</p>';
  $('#designsDialog').showModal();
  try {
    const { designs } = await (await fetch('/api/designs')).json();
    list.innerHTML = '';
    if (!designs.length) { list.innerHTML = '<p class="desc">No saved designs yet. Build something and click <b>Save</b>.</p>'; return; }
    for (const d of designs) {
      const when = d.updatedAt ? new Date(d.updatedAt).toLocaleString() : '';
      const row = el('div', { class: 'design-row' + (d.id === currentDesignId ? ' current' : '') }, [
        el('div', { class: 'design-meta' }, [
          el('span', { class: 'design-name', text: d.name || 'Untitled design' }),
          el('span', { class: 'design-when', text: when }),
        ]),
        el('div', { class: 'design-actions' }, [
          el('button', { class: 'mini', text: 'Open', onclick: () => loadDesign(d.id) }),
          el('button', { class: 'mini', text: 'Clone', onclick: () => cloneDesign(d.id) }),
          el('button', { class: 'mini', text: 'Delete', onclick: () => deleteDesign(d.id, row) }),
        ]),
      ]);
      list.append(row);
    }
  } catch (e) { list.innerHTML = '<p class="desc warn">Could not load designs.</p>'; }
}

async function loadDesign(id) {
  try {
    const d = await (await fetch('/api/designs/' + id)).json();
    if (!d || !d.campaign) throw new Error('bad design');
    campaign = d.campaign;
    uid = Math.max(1, ...campaign.blocks.map(b => b.id || 0)) + 1;
    currentDesignId = d.id;
    $('#designsDialog').close();
    hydrate();
    setStatus('opened “' + (d.name || 'design') + '”', 'ok');
  } catch (e) { setStatus('open failed', 'warn'); }
}

async function cloneDesign(id) {
  try {
    const d = await (await fetch('/api/designs/' + id + '/clone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    await openDesigns();          // refresh list to show the copy
    if (d && d.id) loadDesign(d.id); // open the clone for editing
  } catch (e) { setStatus('clone failed', 'warn'); }
}

async function deleteDesign(id, row) {
  if (!confirm('Delete this design? This cannot be undone.')) return;
  try {
    await fetch('/api/designs/' + id, { method: 'DELETE' });
    if (id === currentDesignId) currentDesignId = null;
    row.remove();
  } catch (e) { setStatus('delete failed', 'warn'); }
}

// ── push draft to Klaviyo ───────────────────────────────────────────────────────
const KV_KEYS = { kvListId: 'kvListId', kvFromEmail: 'kvFromEmail', kvFromLabel: 'kvFromLabel', kvReplyTo: 'kvReplyTo' };
function openKlaviyo() {
  if (!campaign.blocks.length) { setStatus('add a block first', 'warn'); return; }
  for (const id of Object.keys(KV_KEYS)) { const v = localStorage.getItem(KV_KEYS[id]); if (v != null) $('#' + id).value = v; }
  if (!$('#kvSubject').value) $('#kvSubject').value = campaign.campaignName || '';
  const result = $('#kvResult'); result.classList.add('hidden'); result.textContent = '';
  loadAudiences();
  $('#klaviyoDialog').showModal();
}

// Populate the audience picker from the account's lists + segments. Picking one fills the
// ID field (which is what we send to Klaviyo); the field stays editable as a manual override.
async function loadAudiences() {
  const sel = $('#kvAudience');
  const savedId = localStorage.getItem('kvListId') || $('#kvListId').value.trim();
  // A dedicated note element under the picker so the *reason* for a failure is visible
  // (missing key vs. missing scopes vs. bad key), instead of a silent generic message.
  let note = $('#kvAudienceErr');
  if (!note) { note = el('p', { id: 'kvAudienceErr', class: 'desc warn hidden' }); sel.insertAdjacentElement('afterend', note); }
  const showNote = (text) => { note.textContent = text; note.classList.remove('hidden'); };
  const hideNote = () => { note.classList.add('hidden'); };
  sel.innerHTML = '<option value="">Loading audiences…</option>';
  sel.onchange = () => { if (sel.value) $('#kvListId').value = sel.value; };
  try {
    const r = await fetch('/api/klaviyo-audiences');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    hideNote();
    sel.innerHTML = '';
    sel.append(el('option', { value: '', text: '— choose a list or segment —' }));
    const group = (label, items) => {
      if (!items || !items.length) return;
      const og = el('optgroup', { label });
      for (const a of items) og.append(el('option', { value: a.id, text: `${a.name} (${a.id})`, ...(a.id === savedId ? { selected: 'selected' } : {}) }));
      sel.append(og);
    };
    group('Lists', data.lists);
    group('Segments', data.segments);
    if (savedId) sel.value = savedId; // reflect remembered choice if present
  } catch (e) {
    const raw = String((e && e.message) || e);
    console.error('Could not load Klaviyo audiences:', raw);
    sel.innerHTML = '';
    sel.append(el('option', { value: '', text: 'Could not load audiences — paste an ID below', title: raw }));
    // Translate the common server-side causes into a plain-English fix.
    let why = raw;
    if (/KLAVIYO_API_KEY is not set/i.test(raw)) why = 'The server has no KLAVIYO_API_KEY set. Add it as an environment variable (Render → Environment) and redeploy.';
    else if (/\b(401|403)\b|scope|permission|not authorized|unauthorized/i.test(raw)) why = 'The KLAVIYO_API_KEY is rejected or missing scopes. It needs lists:read and segments:read (plus campaigns:write, templates:write, images:write to push). ' + raw;
    else if (/revision/i.test(raw)) why = 'Klaviyo rejected the API revision. ' + raw;
    showNote('⚠ ' + why);
  }
}
async function submitKlaviyo() {
  const listId = $('#kvListId').value.trim();
  const fromEmail = $('#kvFromEmail').value.trim();
  const result = $('#kvResult');
  if (!listId || !fromEmail) { showKvResult('List/segment ID and from email are required.', true); return; }
  // remember audience + sender for next time
  for (const id of Object.keys(KV_KEYS)) localStorage.setItem(KV_KEYS[id], $('#' + id).value.trim());
  const btn = $('#kvSubmit'); btn.disabled = true;
  showKvResult('Slicing blocks, uploading images & creating draft in Klaviyo…', false);
  // Per-block link overrides edited in the Slices tab (index → url).
  const links = {};
  for (const s of SLICES) if (!s.keepHtml && s.link) links[s.index] = s.link;
  try {
    const r = await fetch('/api/klaviyo-draft', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaign, listId, fromEmail, links, designId: currentDesignId,
        fromLabel: $('#kvFromLabel').value.trim(),
        replyToEmail: $('#kvReplyTo').value.trim(),
        subject: $('#kvSubject').value.trim(),
        previewText: $('#kvPreview').value.trim(),
      }),
    });
    const data = await r.json();
    if (!r.ok) { showKvResult('Klaviyo error: ' + (data.error || r.status), true); return; }
    result.innerHTML = '';
    result.append(
      el('p', { text: `✓ Draft created from ${data.sliceCount || 0} block image${data.sliceCount === 1 ? '' : 's'} (each linkable).` }),
      el('a', { href: data.editUrl, target: '_blank', text: 'Open the draft in Klaviyo →' }),
    );
    result.classList.remove('hidden', 'err');
    setStatus('pushed to Klaviyo ✓', 'ok');
  } catch (e) {
    showKvResult('Request failed: ' + (e.message || e), true);
  } finally { btn.disabled = false; }
}
function showKvResult(msg, isErr) {
  const r = $('#kvResult'); r.textContent = msg; r.classList.remove('hidden'); r.classList.toggle('err', !!isErr);
}

// ── sample campaign (the “card is the hard part” build, public CDN imagery) ──────
const P = 'https://cdn.shopify.com/s/files/1/0657/8723/2489/files/';
const BLOG = 'https://figandbloom.com/blogs/news/what-to-write-on-flower-card';
const SAMPLE = {
  campaignName: 'When the card is the hard part',
  bodyBg: '#2c2825',
  blocks: [
    { id: 1, component: 'header', tokens: {} },
    { id: 2, component: 'blocks/editorial-hero', tokens: {
      HERO_IMAGE_URL: P + 'WithLoveCard.jpg?v=1771723389', SUPER_LABEL: 'FIG & BLOOM · NOTES',
      ACCENT_SCRIPT: 'with love,', HEADLINE: 'When the card is the hard part',
      SUBHEADLINE: 'The flowers say a great deal before the card is even opened. Here is how to write the few words they keep — for birthdays, thank-yous, sympathy and just because.',
      CTA_TEXT: 'READ THE GUIDE', CTA_URL: BLOG } },
    { id: 3, component: 'blocks/feature-list', tokens: {
      SECTION_SUPER: 'WHY THE WORDS MATTER', HEADLINE: 'A few words they will keep',
      FEATURE_1_TITLE: 'THE RIGHT WORDS', FEATURE_1_TEXT: 'Message ideas for every occasion, ready to make your own.',
      FEATURE_2_TITLE: 'HANDWRITTEN, FREE', FEATURE_2_TEXT: 'We write your note by hand on a quality card with every order.',
      FEATURE_3_TITLE: 'SAME-DAY DELIVERY', FEATURE_3_TEXT: 'Order before 1pm for same-day delivery across the city.',
      POLAROID_IMAGE_URL: P + 'WithLoveCardCU.jpg?v=1771723389', POLAROID_CAPTION: 'with love,',
      CTA_TEXT: 'READ THE GUIDE', CTA_URL: BLOG } },
    { id: 4, component: 'blocks/howto-steps', palette: 'white', tokens: {
      PANEL_BG: '#ffffff', PANEL_TEXT: '#666666', PANEL_SUB: '#aaaaaa', PANEL_BORDER: '#e8e2da',
      SUPER_LABEL: 'HOW TO WRITE IT', HEADLINE: 'Start with the feeling, not the phrasing',
      INTRO: 'Stuck at the message box? Decide what you want them to feel — then keep it this simple.',
      STEP_1_NUMBER: '1', STEP_1_TITLE: 'NAME THEM', STEP_1_TEXT: 'Open with their name. It makes the whole note feel meant for them.', STEP_1_IMAGE_URL: P + 'SingleStemCardCU.jpg?v=1726026290',
      STEP_2_NUMBER: '2', STEP_2_TITLE: 'SAY WHY YOU SENT THEM', STEP_2_TEXT: 'One honest reason — celebrating you, thinking of you, or simply thank you.', STEP_2_IMAGE_URL: P + 'TulipGreetingCard.jpg?v=1732250184',
      STEP_3_NUMBER: '3', STEP_3_TITLE: 'ADD ONE TRUE THOUGHT', STEP_3_TEXT: 'A single specific line they will remember, then sign off in your own voice.', STEP_3_IMAGE_URL: P + 'FlowersCardCU.jpg?v=1726026071',
      CTA_TEXT: 'SEE ALL THE WORDS', CTA_URL: BLOG } },
    { id: 5, component: 'sections/body-copy-plain', tokens: {
      SUPER_LABEL: 'BORROW OUR WORDS', HEADLINE: 'If you are still stuck, start here.',
      BODY_P1: '<em>Birthday</em> &nbsp;·&nbsp; “I hope today feels as bright and generous as you are.”<br><em>Thank you</em> &nbsp;·&nbsp; “A small thank you for the very large difference you made.”',
      BODY_P2: '<em>Sympathy</em> &nbsp;·&nbsp; “No words feel enough, but please know I am here.”<br><em>Just because</em> &nbsp;·&nbsp; “Saw these and thought of you.”' } },
    { id: 6, component: 'sections/section-headline', tokens: { SUPER_LABEL: 'BEGIN WITH THE FLOWERS', HEADLINE: 'A bloom for every message.' } },
    { id: 7, component: 'products/card-horizontal', tokens: {
      PRODUCT_IMAGE_URL: P + 'Lucerne-Large_2.jpg?v=1764283956', PRODUCT_LABEL: 'SYMPATHY · THANK YOU', PRODUCT_NAME: 'Lucerne',
      PRODUCT_OCCASION: 'Contemporary white blooms for the gentlest moments.', PRODUCT_PRICE: 'From $105', PRODUCT_URL: 'https://figandbloom.com/products/lucerne' } },
    { id: 8, component: 'products/card-horizontal-reversed', tokens: {
      PRODUCT_IMAGE_URL: P + 'MonacoVaseArrangementPink_9.jpg?v=1764284295', PRODUCT_LABEL: 'HAPPY BIRTHDAY', PRODUCT_NAME: 'Monaco',
      PRODUCT_OCCASION: 'Whimsical pinks, made to be properly celebrated.', PRODUCT_PRICE: 'From $115', PRODUCT_URL: 'https://figandbloom.com/products/monaco-pink-vase-arrangement-regular' } },
    { id: 9, component: 'products/card-horizontal', tokens: {
      PRODUCT_IMAGE_URL: P + 'Savoie-Cover.webp?v=1764284279', PRODUCT_LABEL: 'JUST BECAUSE', PRODUCT_NAME: 'Savoie',
      PRODUCT_OCCASION: 'Crisp white and green, with a quiet pop of indigo.', PRODUCT_PRICE: 'From $225', PRODUCT_URL: 'https://figandbloom.com/products/savoie-vase' } },
    { id: 10, component: 'blocks/polaroid-collage', tokens: {
      PHOTO_1_URL: P + 'GreetingCard-ThankYou.webp?v=1709067806', PHOTO_1_CAPTION: 'thank you,',
      PHOTO_2_URL: P + 'WithLoveCardCU.jpg?v=1771723389', PHOTO_2_CAPTION: 'with love,',
      PHOTO_3_URL: P + 'ThinkingofYouDoveGreetingCard.jpg?v=1732250194', PHOTO_3_CAPTION: 'thinking of you,',
      QUOTE_ACCENT: 'in their words', PULL_QUOTE: 'The flowers were beautiful, and the card said exactly what I couldn’t.', QUOTE_ATTRIBUTION: '— Sarah, Brisbane' } },
    { id: 11, component: 'sections/upsell-noir', tokens: {
      SUPER_LABEL: 'Ready when you are', HEADLINE: 'for the moment they feel what you meant',
      BODY: 'Choose the flowers, add your note at checkout, and we hand-write it onto a card — free with every order.',
      CTA_TEXT: 'SEND WITH A NOTE', CTA_URL: 'https://figandbloom.com/collections/bouquets' } },
    { id: 12, component: 'sections/trust-bar', tokens: {} },
    { id: 13, component: 'footer', tokens: {} },
  ],
};

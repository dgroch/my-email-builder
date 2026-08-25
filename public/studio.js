'use strict';
// studio.js — the Design Studio: a visual authoring surface for the component library.
//
// The canvas is not a mock-up of the output. It renders the *compiled* component HTML, with
// data-el markers stamped on each element so selection and dragging can attach to it. What the
// designer moves on screen is the same markup a campaign will assemble — there is no second
// renderer to drift from the first.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const S = {
  brand: null, schema: null, shipped: [], list: [], layouts: [],
  rec: null, doc: null, selId: null, compiled: null,
  zoom: 1, dirty: false, drag: null, compileTimer: null, brandDraft: null,
};

// ── plumbing ────────────────────────────────────────────────────────────────
async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${path} failed (${res.status})`);
  return data;
}

let toastTimer = null;
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 2600);
}

function openModal(html) { $('#modalBody').innerHTML = html; $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; $('#modalBody').innerHTML = ''; }

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function uid() { return 'e' + Math.random().toString(36).slice(2, 9); }
function markDirty() { S.dirty = true; $('#saveState').textContent = 'Unsaved changes'; $('#saveState').className = 'save-state dirty'; }
function markClean(label) { S.dirty = false; $('#saveState').textContent = label || 'Saved'; $('#saveState').className = 'save-state'; }

// The real brand faces, loaded into the canvas. The page already links /api/studio/fonts.css,
// which serves the four faces base64-embedded out of the preview shell; these CDN-hosted copies
// are a second source in case that shell ever stops carrying them.
function injectFonts(cdn) {
  if (!cdn) return;
  const face = (family, src, weight) => src && src.url
    ? `@font-face{font-family:'${family}';src:url('${src.url}') format('${src.format || 'truetype'}');font-weight:${weight};font-style:normal;font-display:swap;}`
    : '';
  const css = [
    face('Cervanttis', cdn.cervanttis, 400),
    face('Lust', cdn.lust, 'normal'),
    face('NeuzeitGro', cdn.neuzeit_grotesk_light, 300),
    face('NeuzeitGro', cdn.neuzeit_grotesk_bold, 700),
  ].filter(Boolean).join('\n');
  const el = document.createElement('style');
  el.textContent = css;
  document.head.appendChild(el);
}

// ── element defaults ────────────────────────────────────────────────────────
// Every new element lands on the canvas already on-brand: a locked type role, a palette
// colour, sensible dimensions. There is no "unstyled" state to climb out of.
function newElement(type, parent) {
  const base = { id: uid(), type, name: '', parent: parent || undefined, order: Date.now() % 100000, z: 0, x: 40, y: 40 };
  switch (type) {
    case 'text': return { ...base, name: 'Text', typeStyle: 'body-m', content: 'New line of copy', colorKey: 'body', align: 'center', w: 480, marginBottom: 12 };
    case 'image': return { ...base, name: 'Image', src: '', alt: '', w: 600, h: 400, fit: 'cover', x: 0, y: 0, marginBottom: 0 };
    case 'button': return { ...base, name: 'Button', label: 'Shop the range', bgKey: 'primary', textKey: 'white', padX: 40, padY: 14, w: 240, marginBottom: 0 };
    case 'panel': return { ...base, name: 'Panel', w: 460, h: 0, padding: 36, bgKey: '#ffffff', borderKey: 'border', borderWidth: 1, x: 70, y: 60 };
    case 'rule': return { ...base, name: 'Rule', colorKey: 'border', thickness: 1, w: 400, marginBottom: 16 };
    case 'illo': return { ...base, name: 'Illustration', asset: (S.brand.assets || [])[3] || 'HandFlower_Black.png', opacity: 0.08, w: 120, h: 120 };
    case 'spacer': return { ...base, name: 'Spacer', h: 24, w: 600 };
    default: return base;
  }
}

// ── boot ────────────────────────────────────────────────────────────────────
async function boot() {
  S.brand = await api('/api/studio/brand');
  injectFonts(S.brand.fontCdn);
  await refreshComponents();
  bindChrome();
  showView('components');
}

async function refreshComponents() {
  const d = await api('/api/studio/components');
  S.list = d.components;
  S.shipped = d.shipped;
}

function bindChrome() {
  $$('.mode-toggle .seg').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  $('#modalClose').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
  $('#btnNew').addEventListener('click', createComponent);
  $('#btnUpgrade').addEventListener('click', () => showView('components', true));
  $('#btnBack').addEventListener('click', backToList);
  $('#btnNewLayout').addEventListener('click', createLayout);
  $('#btnBrandSave').addEventListener('click', saveBrand);
  $('#btnBrandReset').addEventListener('click', resetBrand);
  bindEditorChrome();
  window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
}

function showView(view, scrollToShipped) {
  $$('.mode-toggle .seg').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('#viewComponents').hidden = view !== 'components';
  $('#viewEditor').hidden = true;
  $('#viewLayouts').hidden = view !== 'layouts';
  $('#viewBrand').hidden = view !== 'brand';
  if (view === 'components') renderComponentList();
  if (view === 'layouts') renderLayouts();
  if (view === 'brand') renderBrand();
  if (scrollToShipped) $('#shippedList').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── components list ─────────────────────────────────────────────────────────
function renderComponentList() {
  const wrap = $('#componentList');
  if (!S.list.length) {
    wrap.innerHTML = '<p class="lede">No authored components yet. <b>New component</b> starts a blank 600px canvas; '
      + '<b>Upgrade a shipped one</b> starts from an existing component’s token contract.</p>';
  } else {
    wrap.innerHTML = S.list.map(c => `
      <button class="ccard" data-open="${esc(c.id)}">
        <h4>${esc(c.title)}</h4>
        <div class="meta">
          <span class="status-chip ${esc(c.status)}">${esc(c.status.replace('_', ' '))}</span>
          ${c.shadowsShipped ? '<span class="status-chip shadow">upgrade</span>' : ''}
          <span class="mono-tag">${esc(c.name)}</span>
        </div>
        <div class="desc">${esc(c.description || (c.mode === 'live' ? 'Live HTML component' : 'Designed block — rasterised on publish'))}</div>
        <div class="meta">
          <span>${c.tokenCount} token${c.tokenCount === 1 ? '' : 's'}</span>
          <span>·</span>
          <span>${c.versionCount} version${c.versionCount === 1 ? '' : 's'}</span>
          ${c.publishedVersion ? `<span>· live: v${c.publishedVersion}</span>` : ''}
        </div>
      </button>`).join('');
    $$('[data-open]', wrap).forEach(b => b.addEventListener('click', () => openEditor(b.dataset.open)));
  }

  $('#shippedCount').textContent = `(${S.shipped.length})`;
  $('#shippedList').innerHTML = S.shipped.map(c =>
    `<button class="chip" data-fork="${esc(c.name)}" title="${esc(c.desc || '')}">${esc(c.name)}</button>`).join('');
  $$('[data-fork]', $('#shippedList')).forEach(b => b.addEventListener('click', () => forkShipped(b.dataset.fork)));
}

async function createComponent() {
  const title = prompt('Name this component (e.g. "Editorial hero — split plate")');
  if (!title) return;
  const rec = await api('/api/studio/components', 'POST', { title, group: 'blocks', mode: 'designed' });
  await refreshComponents();
  await openEditor(rec.id);
}

// Upgrading a shipped component keeps its name and its token contract, so every campaign that
// already references it keeps working — the tokens are pre-seeded onto the new canvas as text
// and image elements rather than left for the designer to remember.
async function forkShipped(name) {
  if (!confirm(`Create an authored version of ${name}?\n\nOnce published it overrides the shipped component everywhere. Unpublishing reverts to the shipped one.`)) return;
  const schema = S.schema || (S.schema = await api('/api/schema'));
  const src = schema.components.find(c => c.name === name);
  const [group, slug] = name.split('/');
  const rec = await api('/api/studio/components', 'POST', {
    title: (src && src.desc) ? src.desc.split('—')[0].trim() || slug : slug,
    group, slug, shadowsShipped: true,
    mode: src && src.designed ? 'designed' : 'live',
    description: src ? src.desc : '',
  });
  // Seed the canvas with the existing token contract so nothing silently disappears.
  const elements = [];
  let y = 20;
  for (const t of (src ? src.tokens : [])) {
    if (t.type === 'image') {
      elements.push({ ...newElement('image'), id: uid(), token: t.name, y: 0, x: 0, name: t.name });
      y = 420;
    } else if (t.type === 'url') {
      continue;
    } else if (t.type === 'enum' || t.type === 'palette' || t.type === 'length') {
      continue;
    } else {
      const style = t.case === 'lower' ? 'script-m' : t.case === 'sentence' ? 'display-m' : 'body-m';
      elements.push({ ...newElement('text'), id: uid(), token: t.name, typeStyle: style, content: t.name.toLowerCase().replace(/_/g, ' '), name: t.name, x: 60, y, w: 480 });
      y += 60;
    }
  }
  await api('/api/studio/components/' + rec.id, 'PUT', {
    doc: { mode: rec.mode, canvas: { height: Math.max(320, y + 60), background: '#ffffff' }, elements },
  });
  await refreshComponents();
  await openEditor(rec.id);
  toast(`Upgrading ${name} — its ${elements.length} content slots are on the canvas.`);
}

// ── editor ──────────────────────────────────────────────────────────────────
async function openEditor(id) {
  S.rec = await api('/api/studio/components/' + id);
  S.doc = S.rec.doc || { mode: S.rec.mode, canvas: { height: 480, background: '#ffffff' }, elements: [] };
  S.doc.elements = S.doc.elements || [];
  S.selId = null;
  markClean(' ');
  $('#viewComponents').hidden = true;
  $('#viewLayouts').hidden = true;
  $('#viewBrand').hidden = true;
  $('#viewEditor').hidden = false;
  syncEditorChrome();
  renderReference();
  await recompile();
}

function backToList() {
  if (S.dirty && !confirm('You have unsaved changes. Leave anyway?')) return;
  S.rec = null; S.doc = null;
  refreshComponents().then(() => showView('components'));
}

function syncEditorChrome() {
  const r = S.rec;
  $('#edTitle').value = r.title || '';
  $('#edName').textContent = r.name;
  $('#edStatus').textContent = r.status.replace('_', ' ');
  $('#edStatus').className = 'status-chip ' + r.status;
  $('#edMode').value = r.mode;
  $('#edGroup').value = r.group;
  $('#edSlug').value = r.slug;
  $('#edDesc').value = r.description || '';
  $('#edHeight').value = (S.doc.canvas && S.doc.canvas.height) || 480;
  $('#edBg').value = (S.doc.canvas && S.doc.canvas.background) || '#ffffff';
  // Name and group lock once a version has shipped: the name is the contract saved campaigns
  // reference, so renaming it would orphan them.
  const locked = !!r.publishedVersion;
  $('#edSlug').disabled = locked;
  $('#edGroup').disabled = locked;
  $('#btnPublish').hidden = !(r.status === 'in_review' || r.status === 'published' || r.currentVersion > 0);
  renderVersions();
}

function renderVersions() {
  const r = S.rec;
  const vs = (r.versions || []).slice().reverse();
  $('#versionList').innerHTML = '<h3 style="margin-top:14px">Versions</h3>' + (vs.length
    ? vs.map(v => `<div class="v"><b>v${v.version}</b>
        <span>${esc(v.note || '')}</span><span class="spacer"></span>
        ${r.publishedVersion === v.version ? '<span class="status-chip published">live</span>'
          : `<button class="lbtn" data-pub="${v.version}">publish</button>`}</div>`).join('')
    : '<div class="v">No versions cut yet.</div>');
  $$('[data-pub]', $('#versionList')).forEach(b => b.addEventListener('click', () => publish(Number(b.dataset.pub))));
}

function bindEditorChrome() {
  $('#edTitle').addEventListener('input', () => { S.rec.title = $('#edTitle').value; markDirty(); });
  $('#edDesc').addEventListener('input', () => { S.rec.description = $('#edDesc').value; markDirty(); });
  $('#edSlug').addEventListener('change', () => { S.rec.slug = $('#edSlug').value; markDirty(); });
  $('#edGroup').addEventListener('change', () => { S.rec.group = $('#edGroup').value; markDirty(); });
  $('#edMode').addEventListener('change', () => {
    S.rec.mode = S.doc.mode = $('#edMode').value;
    markDirty(); recompile();
  });
  $('#edHeight').addEventListener('input', () => { S.doc.canvas.height = Number($('#edHeight').value) || 480; markDirty(); recompile(); });
  $('#edBg').addEventListener('change', () => { S.doc.canvas.background = $('#edBg').value; markDirty(); recompile(); });
  $('#edZoom').addEventListener('change', () => {
    S.zoom = Number($('#edZoom').value);
    $('#stageOuter').style.transform = `scale(${S.zoom})`;
    positionSel();
  });
  $$('[data-add]').forEach(b => b.addEventListener('click', () => addElement(b.dataset.add)));
  $('#btnSave').addEventListener('click', saveDraft);
  $('#btnVersion').addEventListener('click', cutVersion);
  $('#btnSubmit').addEventListener('click', submitForReview);
  $('#btnPublish').addEventListener('click', () => publish(S.rec.currentVersion));
  $('#btnPreview').addEventListener('click', previewInEmail);
  $('#btnRef').addEventListener('click', () => $('#refFile').click());
  $('#refFile').addEventListener('change', loadReference);
  ['refOpacity', 'refScale', 'refX', 'refY'].forEach(id => $('#' + id).addEventListener('input', syncReference));
  $('#btnRefToggle').addEventListener('click', toggleReference);
  $('#btnRefClear').addEventListener('click', clearReference);
  $('#stage').addEventListener('mousedown', onStageDown);
  $('#selBox').addEventListener('mousedown', onHandleDown);
  document.addEventListener('keydown', onKey);
}

// ── compile + canvas render ─────────────────────────────────────────────────
function metaFor(extra) {
  const r = S.rec;
  return {
    name: r.name, title: r.title, slug: r.slug, description: r.description,
    author: r.author, mode: r.mode, version: (r.currentVersion || 0) + 1, ...extra,
  };
}

async function recompile() {
  if (!S.rec) return;
  try {
    const out = await api('/api/studio/compile', 'POST', { doc: S.doc, meta: metaFor({ editorMarkers: true }) });
    S.compiled = out;
    // The compiled component is a run of <tr> rows: they have to be parsed inside a table or
    // the HTML parser discards them.
    const body = out.html.replace(/^<!--[\s\S]*?-->\s*/, '');
    $('#stage').innerHTML = '<table width="600" cellpadding="0" cellspacing="0" border="0" '
      + 'style="width:600px;border-collapse:collapse;"><tbody>' + body + '</tbody></table>';
    $('#canvasDims').textContent = `600 × ${S.doc.canvas.height || '—'}`;
    renderGuardrails(out.warnings, out.tokens);
    renderLayers();
    renderInspector();
    positionSel();
  } catch (e) { toast(e.message, true); }
}

function scheduleCompile() {
  clearTimeout(S.compileTimer);
  S.compileTimer = setTimeout(recompile, 140);
}

function renderGuardrails(warnings, tokens) {
  const w = warnings || [];
  const g = $('#guardrails');
  if (!w.length) {
    g.innerHTML = `<div class="gr-ok">✓ On-brand and email-safe. ${(tokens || []).length} fillable slot${(tokens || []).length === 1 ? '' : 's'}: `
      + (tokens || []).map(t => t.name).join(', ') + '</div>';
    return;
  }
  g.innerHTML = w.map(x => `<div class="gr ${esc(x.level)}"><span class="lvl">${esc(x.level)}</span>
    <span>${esc(x.message)}</span>${x.where ? `<span class="where">${esc(x.where)}</span>` : ''}</div>`).join('');
}

// ── layers ──────────────────────────────────────────────────────────────────
function renderLayers() {
  const els = S.doc.elements;
  const roots = els.filter(e => !e.parent);
  const rows = [];
  const sortKey = S.rec.mode === 'designed' ? (a, b) => (b.z || 0) - (a.z || 0) : (a, b) => (a.order || 0) - (b.order || 0);
  for (const e of roots.slice().sort(sortKey)) {
    rows.push(layerRow(e, false));
    for (const c of els.filter(x => x.parent === e.id).sort((a, b) => (a.order || 0) - (b.order || 0))) rows.push(layerRow(c, true));
  }
  $('#layers').innerHTML = rows.join('') || '<li class="ltype">Empty canvas</li>';
  $$('#layers li[data-sel]').forEach(li => li.addEventListener('click', ev => {
    if (ev.target.closest('.lbtn')) return;
    select(li.dataset.sel);
  }));
  $$('#layers .lbtn').forEach(b => b.addEventListener('click', ev => {
    ev.stopPropagation();
    const { act, id } = b.dataset;
    if (act === 'del') removeElement(id);
    if (act === 'up') nudgeOrder(id, -1);
    if (act === 'down') nudgeOrder(id, 1);
  }));
}

function layerRow(e, child) {
  const tok = e.token || e.labelToken;
  return `<li data-sel="${esc(e.id)}" class="${child ? 'child ' : ''}${S.selId === e.id ? 'sel' : ''}">
    <span class="ltype">${esc(e.type)}</span>
    <span class="lname">${esc(e.name || e.content || e.type)}</span>
    ${tok ? `<span class="tok">${esc(tok)}</span>` : ''}
    <button class="lbtn" data-act="up" data-id="${esc(e.id)}" title="Move forward">↑</button>
    <button class="lbtn" data-act="down" data-id="${esc(e.id)}" title="Move back">↓</button>
    <button class="lbtn" data-act="del" data-id="${esc(e.id)}" title="Delete">×</button>
  </li>`;
}

function nudgeOrder(id, dir) {
  const e = S.doc.elements.find(x => x.id === id);
  if (!e) return;
  if (S.rec.mode === 'designed' && !e.parent) e.z = (e.z || 0) - dir;
  else e.order = (e.order || 0) + dir * 1.5;
  markDirty(); recompile();
}

function addElement(type) {
  // A new element drops inside the selected panel when there is one — which is how a plate
  // gets its copy without any nesting UI.
  const sel = S.doc.elements.find(e => e.id === S.selId);
  const parent = sel ? (sel.type === 'panel' ? sel.id : sel.parent) : undefined;
  const el = newElement(type, parent);
  if (parent) { el.order = Date.now() % 100000; delete el.x; delete el.y; }
  else if (S.rec.mode === 'designed') { el.z = Math.max(0, ...S.doc.elements.filter(e => !e.parent).map(e => e.z || 0)) + 1; }
  S.doc.elements.push(el);
  S.selId = el.id;
  markDirty();
  recompile();
}

function removeElement(id) {
  S.doc.elements = S.doc.elements.filter(e => e.id !== id && e.parent !== id);
  if (S.selId === id) S.selId = null;
  markDirty(); recompile();
}

function select(id) {
  S.selId = id;
  renderLayers(); renderInspector(); positionSel();
}

// ── canvas selection + drag ─────────────────────────────────────────────────
function onStageDown(ev) {
  const node = ev.target.closest('[data-el]');
  if (!node) { S.selId = null; renderLayers(); renderInspector(); positionSel(); return; }
  const id = node.dataset.el;
  select(id);
  const el = S.doc.elements.find(e => e.id === id);
  // Only free-canvas, top-level elements drag. A panel's children are in flow, so they are
  // repositioned by their spacing and order, not by dragging.
  if (!el || el.parent || S.rec.mode !== 'designed') return;
  ev.preventDefault();
  S.drag = { mode: 'move', id, startX: ev.clientX, startY: ev.clientY, origX: el.x || 0, origY: el.y || 0, node };
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragUp);
}

function onHandleDown(ev) {
  const h = ev.target.closest('.h');
  if (!h) return;
  const el = S.doc.elements.find(e => e.id === S.selId);
  if (!el) return;
  ev.preventDefault(); ev.stopPropagation();
  S.drag = {
    mode: 'resize', id: el.id, dir: h.className.replace('h', '').trim(),
    startX: ev.clientX, startY: ev.clientY,
    origW: el.w || 0, origH: el.h || 0, origX: el.x || 0, origY: el.y || 0,
    node: $(`#stage [data-el="${el.id}"]`),
  };
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragUp);
}

function onDragMove(ev) {
  const d = S.drag;
  if (!d) return;
  const el = S.doc.elements.find(e => e.id === d.id);
  if (!el) return;
  const dx = (ev.clientX - d.startX) / S.zoom;
  const dy = (ev.clientY - d.startY) / S.zoom;
  if (d.mode === 'move') {
    el.x = Math.round(d.origX + dx);
    el.y = Math.round(d.origY + dy);
    if (d.node) { d.node.style.left = el.x + 'px'; d.node.style.top = el.y + 'px'; }
  } else {
    if (/e/.test(d.dir)) el.w = Math.max(16, Math.round(d.origW + dx));
    if (/w/.test(d.dir)) { el.w = Math.max(16, Math.round(d.origW - dx)); el.x = Math.round(d.origX + dx); }
    if (/s/.test(d.dir)) el.h = Math.max(8, Math.round(d.origH + dy));
    if (/n/.test(d.dir)) { el.h = Math.max(8, Math.round(d.origH - dy)); el.y = Math.round(d.origY + dy); }
    if (d.node) {
      if (el.type === 'image') { const img = d.node.querySelector('img'); if (img) { img.style.width = el.w + 'px'; img.style.height = el.h + 'px'; } }
      else { d.node.style.width = el.w + 'px'; if (el.h) d.node.style.minHeight = el.h + 'px'; }
      d.node.style.left = (el.x || 0) + 'px'; d.node.style.top = (el.y || 0) + 'px';
    }
  }
  positionSel();
}

function onDragUp() {
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragUp);
  if (S.drag) { S.drag = null; markDirty(); recompile(); }
}

function positionSel() {
  const box = $('#selBox');
  const node = S.selId ? $(`#stage [data-el="${S.selId}"]`) : null;
  if (!node) { box.hidden = true; return; }
  const outer = $('#stageOuter').getBoundingClientRect();
  const r = node.getBoundingClientRect();
  box.hidden = false;
  box.style.left = ((r.left - outer.left) / S.zoom) + 'px';
  box.style.top = ((r.top - outer.top) / S.zoom) + 'px';
  box.style.width = (r.width / S.zoom) + 'px';
  box.style.height = (r.height / S.zoom) + 'px';
  const el = S.doc.elements.find(e => e.id === S.selId);
  const resizable = el && !el.parent && S.rec.mode === 'designed';
  $$('.h', box).forEach(h => { h.style.display = resizable ? '' : 'none'; });
}

function onKey(ev) {
  if ($('#viewEditor').hidden) return;
  const tag = (ev.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  const el = S.doc && S.doc.elements.find(e => e.id === S.selId);
  if (!el) return;
  if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); removeElement(el.id); return; }
  const step = ev.shiftKey ? 10 : 1;
  const map = { ArrowLeft: ['x', -step], ArrowRight: ['x', step], ArrowUp: ['y', -step], ArrowDown: ['y', step] };
  if (map[ev.key] && !el.parent && S.rec.mode === 'designed') {
    ev.preventDefault();
    const [axis, delta] = map[ev.key];
    el[axis] = (el[axis] || 0) + delta;
    markDirty(); scheduleCompile();
  }
}

// ── inspector ───────────────────────────────────────────────────────────────
function field(label, inner) { return `<label class="fld">${esc(label)}${inner}</label>`; }
function numInput(key, val, attrs) { return `<input type="number" data-k="${key}" value="${val == null ? '' : val}" ${attrs || ''}>`; }
function textInput(key, val, ph) { return `<input type="text" data-k="${key}" value="${esc(val || '')}" placeholder="${esc(ph || '')}">`; }

function swatchRow(key, current) {
  const cols = { ...S.brand.colours, white: '#ffffff' };
  return `<div class="swatches" data-swatch="${key}">` + Object.entries(cols).map(([k, hex]) =>
    `<button type="button" data-val="${esc(k)}" title="${esc(k)} ${esc(hex)}" style="background:${esc(hex)}"
      class="${current === k ? 'on' : ''}"></button>`).join('') + '</div>';
}

function renderInspector() {
  const box = $('#inspector');
  const el = S.doc && S.doc.elements.find(e => e.id === S.selId);
  if (!el) {
    box.innerHTML = '<h3>Inspector</h3><p class="insp-empty">Select something on the canvas, or add an element from the left.'
      + (S.rec && S.rec.mode === 'designed'
        ? ' This is a designed block, so it rasterises on publish — overlap and rotation are safe here.'
        : ' This is a live-HTML component, so elements stack in flow and stay real markup in the inbox.') + '</p>';
    return;
  }
  const isChild = !!el.parent;
  const designed = S.rec.mode === 'designed';
  let h = `<h3>${esc(el.type)} <span class="hint">${esc(el.name || '')}</span></h3>`;
  h += field('Layer name', textInput('name', el.name));

  if (el.type === 'text') {
    h += field('Type style', `<select data-k="typeStyle">` + Object.entries(S.brand.typeScale).map(([k, v]) =>
      `<option value="${k}" ${el.typeStyle === k ? 'selected' : ''}>${esc(v.label)} · ${v.size}px</option>`).join('') + '</select>');
    h += field('Copy', `<textarea data-k="content" rows="3">${esc(el.content || '')}</textarea>`);
    h += field('Colour', swatchRow('colorKey', el.colorKey));
    h += `<div class="row2">${field('Align', `<select data-k="align">${['left', 'center', 'right'].map(a =>
      `<option ${el.align === a ? 'selected' : ''}>${a}</option>`).join('')}</select>`)}
      ${field('Heading tag', `<select data-k="tag"><option value="p" ${el.tag !== 'h1' ? 'selected' : ''}>p</option><option value="h1" ${el.tag === 'h1' ? 'selected' : ''}>h1</option></select>`)}</div>`;
    h += tokenBox(el, 'token', 'Fillable copy slot');
  }

  if (el.type === 'image') {
    h += field('Image URL', textInput('src', el.src, 'https://cdn.shopify.com/…'));
    h += field('Alt text', textInput('alt', el.alt, 'What the photo shows'));
    h += `<div class="row2">${field('Fit', `<select data-k="fit">${['cover', 'contain'].map(f =>
      `<option ${el.fit === f ? 'selected' : ''}>${f}</option>`).join('')}</select>`)}
      ${field('Radius', numInput('radius', el.radius || 0, 'min="0"'))}</div>`;
    h += tokenBox(el, 'token', 'Fillable image slot');
    h += tokenBox(el, 'linkToken', 'Click-through URL slot');
  }

  if (el.type === 'button') {
    h += field('Label', textInput('label', el.label));
    h += field('Destination URL', textInput('url', el.url, 'https://figandbloom.com/…'));
    h += field('Background', swatchRow('bgKey', el.bgKey));
    h += `<div class="row3">${field('Pad X', numInput('padX', el.padX))}${field('Pad Y', numInput('padY', el.padY))}${field('Radius', numInput('radius', el.radius || 0, 'min="0"'))}</div>`;
    h += tokenBox(el, 'labelToken', 'Fillable label slot');
    h += tokenBox(el, 'urlToken', 'Fillable URL slot');
  }

  if (el.type === 'panel') {
    h += field('Background', swatchRow('bgKey', el.bgKey));
    h += field('Border', swatchRow('borderKey', el.borderKey));
    h += `<div class="row2">${field('Border width', numInput('borderWidth', el.borderWidth, 'min="0"'))}${field('Padding', numInput('padding', el.padding, 'min="0"'))}</div>`;
    h += field('Corner radius', numInput('radius', el.radius || 0, 'min="0"'));
  }

  if (el.type === 'rule') {
    h += field('Colour', swatchRow('colorKey', el.colorKey));
    h += field('Thickness', numInput('thickness', el.thickness, 'min="1"'));
  }

  if (el.type === 'illo') {
    h += field('Artwork', `<select data-k="asset">` + (S.brand.assets || []).map(a =>
      `<option ${el.asset === a ? 'selected' : ''}>${esc(a)}</option>`).join('') + '</select>');
    h += field('Opacity', `<input type="number" data-k="opacity" step="0.01" min="0" max="1" value="${el.opacity}">`);
  }

  // Geometry: absolute on the free canvas, flow spacing inside a panel or in live mode.
  if (!isChild && designed) {
    h += '<h3 style="margin-top:16px">Position</h3>';
    h += `<div class="row2">${field('X', numInput('x', el.x))}${field('Y', numInput('y', el.y))}</div>`;
    h += `<div class="row2">${field('Width', numInput('w', el.w))}${field('Height', numInput('h', el.h))}</div>`;
    h += `<div class="row2">${field('Rotation°', numInput('rotation', el.rotation || 0, 'step="0.5"'))}${field('Layer (z)', numInput('z', el.z || 0))}</div>`;
  } else {
    h += '<h3 style="margin-top:16px">Spacing</h3>';
    h += `<div class="row2">${field('Space above', numInput('marginTop', el.marginTop || 0))}${field('Space below', numInput('marginBottom', el.marginBottom || 0))}</div>`;
    if (el.type !== 'text') h += field('Width', numInput('w', el.w));
  }

  box.innerHTML = h;
  bindInspector(box, el);
}

// A slot is what makes a component reusable: the designer marks the headline as fillable and
// the builder's form grows a field for it, with the case rule inferred from the type role.
function tokenBox(el, key, label) {
  const val = el[key] || '';
  const role = el.typeStyle && S.brand.typeScale[el.typeStyle]
    ? S.brand.fontRoles[S.brand.typeScale[el.typeStyle].role] : null;
  const caseNote = key === 'token' && role && role.caseRule
    ? `<div class="case case-${role.caseRule}">Copy in this slot must be ${role.caseRule === 'lower' ? 'lowercase' : 'Sentence case'} — ${esc(role.label.split(' — ')[0])}.</div>`
    : '';
  const hint = /URL|link/i.test(label) ? 'e.g. CTA_URL' : /image/i.test(label) ? 'e.g. HERO_IMAGE_URL' : 'e.g. HEADLINE';
  return `<div class="token-box">
    <label class="inline-check"><input type="checkbox" data-tokchk="${key}" ${val ? 'checked' : ''}> ${esc(label)}</label>
    ${val ? `<input type="text" data-k="${key}" value="${esc(val)}" placeholder="${hint}" style="width:100%;font-family:ui-monospace,Menlo,monospace;font-size:12px;border:1px solid var(--line);border-radius:6px;padding:6px 8px;">` : `<div class="rail-note" style="margin:0">Off — every campaign gets this exact content.</div>`}
    ${val ? caseNote : ''}
  </div>`;
}

function bindInspector(box, el) {
  $$('[data-k]', box).forEach(inp => {
    const commit = () => {
      const k = inp.dataset.k;
      let v = inp.type === 'number' ? Number(inp.value) : inp.value;
      if (inp.dataset.k === 'token' || inp.dataset.k === 'labelToken' || inp.dataset.k === 'urlToken' || inp.dataset.k === 'linkToken') {
        v = String(v).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
      }
      el[k] = v;
      markDirty();
      scheduleCompile();
    };
    inp.addEventListener('change', commit);
    if (inp.tagName === 'TEXTAREA' || inp.type === 'text') inp.addEventListener('input', () => { el[inp.dataset.k] = inp.value; markDirty(); scheduleCompile(); });
  });
  $$('[data-swatch] button', box).forEach(b => b.addEventListener('click', () => {
    el[b.closest('[data-swatch]').dataset.swatch] = b.dataset.val;
    markDirty(); recompile();
  }));
  $$('[data-tokchk]', box).forEach(c => c.addEventListener('change', () => {
    const key = c.dataset.tokchk;
    if (c.checked) {
      el[key] = key === 'token' && el.type === 'image' ? 'IMAGE_URL'
        : key === 'linkToken' || key === 'urlToken' ? 'CTA_URL'
        : key === 'labelToken' ? 'CTA_TEXT' : 'HEADLINE';
    } else delete el[key];
    markDirty(); recompile();
  }));
}

// ── reference overlay (the Figma path) ──────────────────────────────────────
function loadReference(ev) {
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  const fr = new FileReader();
  fr.onload = () => {
    S.doc.reference = { dataUrl: fr.result, opacity: 0.45, scale: 1, x: 0, y: 0, visible: true };
    markDirty(); renderReference();
  };
  fr.readAsDataURL(f);
}

function renderReference() {
  const r = S.doc.reference;
  const img = $('#refImg');
  $('#refControls').hidden = !r;
  if (!r) { img.hidden = true; return; }
  img.src = r.dataUrl;
  img.hidden = !r.visible;
  $('#refOpacity').value = Math.round((r.opacity ?? 0.45) * 100);
  $('#refScale').value = Math.round((r.scale ?? 1) * 100);
  $('#refX').value = r.x || 0;
  $('#refY').value = r.y || 0;
  $('#btnRefToggle').textContent = r.visible ? 'Hide' : 'Show';
  applyReferenceStyle();
}

function applyReferenceStyle() {
  const r = S.doc.reference;
  const img = $('#refImg');
  if (!r) return;
  img.style.opacity = r.opacity;
  img.style.width = (600 * (r.scale || 1)) + 'px';
  img.style.transform = `translate(${r.x || 0}px, ${r.y || 0}px)`;
}

function syncReference() {
  const r = S.doc.reference;
  if (!r) return;
  r.opacity = Number($('#refOpacity').value) / 100;
  r.scale = Number($('#refScale').value) / 100;
  r.x = Number($('#refX').value) || 0;
  r.y = Number($('#refY').value) || 0;
  applyReferenceStyle();
  markDirty();
}

function toggleReference() {
  if (!S.doc.reference) return;
  S.doc.reference.visible = !S.doc.reference.visible;
  markDirty(); renderReference();
}

function clearReference() {
  delete S.doc.reference;
  $('#refFile').value = '';
  markDirty(); renderReference();
}

// ── save / version / review / publish ───────────────────────────────────────
async function saveDraft() {
  try {
    S.rec = await api('/api/studio/components/' + S.rec.id, 'PUT', {
      doc: S.doc, title: S.rec.title, description: S.rec.description,
      slug: S.rec.slug, group: S.rec.group, mode: S.rec.mode,
    });
    S.doc = S.rec.doc;
    markClean('Saved');
    syncEditorChrome();
    toast('Draft saved.');
  } catch (e) { toast(e.message, true); }
}

async function cutVersion() {
  await saveDraft();
  const note = prompt('What changed in this version?') || '';
  try {
    const out = await api('/api/studio/components/' + S.rec.id + '/version', 'POST', { note });
    S.rec = await api('/api/studio/components/' + S.rec.id);
    syncEditorChrome();
    toast(`Version ${out.version.version} cut.`);
  } catch (e) { toast(e.message, true); }
}

async function submitForReview() {
  await saveDraft();
  if (!S.rec.currentVersion) await cutVersion();
  const note = prompt('Anything the reviewer should know?') || '';
  try {
    S.rec = await api('/api/studio/components/' + S.rec.id + '/submit', 'POST', { note });
    syncEditorChrome();
    toast('Submitted for review. It stays out of campaigns until it is published.');
  } catch (e) { toast(e.message, true); }
}

async function publish(version) {
  if (!confirm(`Publish v${version}?\n\nIt becomes available to every campaign immediately. Versions already used by saved campaigns keep resolving to the version they were built against.`)) return;
  try {
    S.rec = await api('/api/studio/components/' + S.rec.id + '/publish', 'POST', { version });
    syncEditorChrome();
    toast(`Published v${version} — ${S.rec.name} is live in the library.`);
  } catch (e) { toast(e.message, true); }
}

// Preview through the real assemble pipeline: shell, embedded brand fonts, absolute asset
// URLs. Not a canvas screenshot — the actual email.
async function previewInEmail() {
  try {
    const out = await api('/api/studio/preview', 'POST', { doc: S.doc, meta: metaFor({}) });
    openModal('<h2>In the email shell</h2>'
      + '<p class="lede">Assembled through the same pipeline a campaign uses.</p>'
      + '<iframe id="pvFrame"></iframe>');
    const f = $('#pvFrame');
    f.srcdoc = out.html;
  } catch (e) { toast(e.message, true); }
}

// ── layouts ─────────────────────────────────────────────────────────────────
async function renderLayouts() {
  const d = await api('/api/studio/layouts');
  S.layouts = d.layouts;
  const wrap = $('#layoutList');
  if (!S.layouts.length) {
    wrap.innerHTML = '<p class="lede">No layouts yet. A layout records a block sequence you want to reuse — '
      + 'build the shape once here and every campaign of that kind starts from it.</p>';
    return;
  }
  wrap.innerHTML = S.layouts.map(l => `
    <div class="ccard" style="cursor:default">
      <h4>${esc(l.name)}</h4>
      <div class="meta">
        <span class="status-chip ${esc(l.status)}">${esc(l.status)}</span>
        ${l.objective ? `<span class="mono-tag">${esc(l.objective)}</span>` : ''}
      </div>
      <div class="desc">${esc(l.description || '')}</div>
      <div class="desc mono-tag">${(l.blocks || []).map(b => b.component).join(' → ') || 'no blocks yet'}</div>
      <div class="meta">
        <button class="mini ghost" data-editlayout="${esc(l.id)}">Edit blocks</button>
        <button class="mini ghost" data-dellayout="${esc(l.id)}">Delete</button>
      </div>
    </div>`).join('');
  $$('[data-editlayout]', wrap).forEach(b => b.addEventListener('click', () => editLayout(b.dataset.editlayout)));
  $$('[data-dellayout]', wrap).forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Delete this layout?')) return;
    await api('/api/studio/layouts/' + b.dataset.dellayout, 'DELETE');
    renderLayouts();
  }));
}

async function createLayout() {
  const name = prompt('Name this layout (e.g. "Range launch — photo-led")');
  if (!name) return;
  const objective = prompt('Which campaign objective does it serve? (optional)') || '';
  const l = await api('/api/studio/layouts', 'POST', { name, objective });
  await renderLayouts();
  editLayout(l.id);
}

async function editLayout(id) {
  const l = await api('/api/studio/layouts/' + id);
  const schema = S.schema || (S.schema = await api('/api/schema'));
  const opts = schema.components.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  openModal(`<h2>${esc(l.name)}</h2>
    <p class="lede">Order the blocks. Copy stays out of a layout — this is structure only.</p>
    <label class="fld">Description<textarea id="lDesc" rows="2">${esc(l.description || '')}</textarea></label>
    <div id="lBlocks"></div>
    <div class="row2" style="margin-top:12px">
      <select id="lAdd">${opts}</select>
      <button id="lAddBtn" class="ghost">Add block</button>
    </div>
    <div class="actions" style="margin-top:16px;justify-content:flex-end">
      <button id="lPublish" class="ghost">${l.status === 'published' ? 'Unpublish' : 'Publish'}</button>
      <button id="lSave" class="primary">Save layout</button>
    </div>`);
  const blocks = (l.blocks || []).slice();
  const draw = () => {
    $('#lBlocks').innerHTML = blocks.length ? blocks.map((b, i) => `
      <div class="v" style="border-top:1px solid var(--line);padding:7px 0;display:flex;gap:8px;align-items:center">
        <span class="mono-tag" style="flex:1">${i + 1}. ${esc(b.component)}</span>
        <button class="lbtn" data-up="${i}">↑</button>
        <button class="lbtn" data-down="${i}">↓</button>
        <button class="lbtn" data-rm="${i}">×</button>
      </div>`).join('') : '<p class="lede">No blocks yet.</p>';
    $$('[data-up]').forEach(b => b.addEventListener('click', () => { const i = +b.dataset.up; if (i > 0) { [blocks[i - 1], blocks[i]] = [blocks[i], blocks[i - 1]]; draw(); } }));
    $$('[data-down]').forEach(b => b.addEventListener('click', () => { const i = +b.dataset.down; if (i < blocks.length - 1) { [blocks[i + 1], blocks[i]] = [blocks[i], blocks[i + 1]]; draw(); } }));
    $$('[data-rm]').forEach(b => b.addEventListener('click', () => { blocks.splice(+b.dataset.rm, 1); draw(); }));
  };
  draw();
  $('#lAddBtn').addEventListener('click', () => { blocks.push({ component: $('#lAdd').value }); draw(); });
  $('#lPublish').addEventListener('click', async () => {
    await api('/api/studio/layouts/' + id, 'PUT', { status: l.status === 'published' ? 'draft' : 'published' });
    closeModal(); renderLayouts();
  });
  $('#lSave').addEventListener('click', async () => {
    await api('/api/studio/layouts/' + id, 'PUT', { blocks, description: $('#lDesc').value });
    closeModal(); renderLayouts(); toast('Layout saved.');
  });
}

// ── brand primitives ────────────────────────────────────────────────────────
async function renderBrand() {
  S.brand = await api('/api/studio/brand');
  S.brandDraft = { colours: {}, typeScale: {} };
  const wrap = $('#brandColours');
  const entries = Object.entries(S.brand.colours);
  wrap.innerHTML = entries.map(([k, hex]) => `
    <div class="swatch" data-key="${esc(k)}">
      <div class="chipbig" style="background:${esc(hex)}"></div>
      <div class="key">${esc(k)}</div>
      <input type="text" data-col="${esc(k)}" value="${esc(hex)}">
      <div class="touches" data-touch="${esc(k)}">counting components…</div>
    </div>`).join('');

  // Each swatch says what it touches before it is changed — a palette edit is the one action
  // in here that restyles the whole library at once.
  for (const [k] of entries) {
    api('/api/studio/brand/affected?key=' + encodeURIComponent(k)).then(r => {
      const n = r.components.length;
      const el = $(`[data-touch="${k}"]`);
      if (el) el.innerHTML = n ? `Touches <b>${n}</b> shipped component${n === 1 ? '' : 's'}` : 'Not referenced by any shipped component';
    }).catch(() => {});
  }

  $$('[data-col]', wrap).forEach(inp => inp.addEventListener('input', () => {
    S.brandDraft.colours[inp.dataset.col] = inp.value;
    const card = inp.closest('.swatch');
    card.classList.add('changed');
    $('.chipbig', card).style.background = inp.value;
  }));

  $('#brandType').innerHTML = Object.entries(S.brand.typeScale).map(([k, v]) => {
    const role = S.brand.fontRoles[v.role];
    return `<div class="tstep" data-step="${esc(k)}">
      <div><div class="key mono-tag">${esc(k)}</div><label>${esc(role.label)}</label></div>
      <div class="sample" style="font-family:${role.stack};font-weight:${role.weight};font-size:${Math.min(v.size, 44)}px;line-height:1.1;">
        ${v.role === 'script' ? 'with love,' : v.role === 'display' ? 'When the card is the hard part' : 'Australia-wide flower delivery'}
      </div>
      <div><label>Size</label><input type="number" data-ts="${esc(k)}" data-f="size" value="${v.size}"></div>
      <div><label>Leading</label><input type="number" step="0.05" data-ts="${esc(k)}" data-f="lineHeight" value="${v.lineHeight}"></div>
    </div>`;
  }).join('');

  $$('[data-ts]').forEach(inp => inp.addEventListener('change', () => {
    const k = inp.dataset.ts;
    const cur = S.brandDraft.typeScale[k] || { ...S.brand.typeScale[k] };
    cur[inp.dataset.f] = Number(inp.value);
    S.brandDraft.typeScale[k] = cur;
  }));
}

async function saveBrand() {
  const changedColours = Object.keys(S.brandDraft.colours).length;
  const changedType = Object.keys(S.brandDraft.typeScale).length;
  if (!changedColours && !changedType) return toast('Nothing changed.');
  if (!confirm(`Save ${changedColours} colour change${changedColours === 1 ? '' : 's'} and ${changedType} type change${changedType === 1 ? '' : 's'}?\n\nEvery component that references them re-renders with the new values.`)) return;
  try {
    S.brand = await api('/api/studio/brand', 'PUT', S.brandDraft);
    toast('Brand updated. Every component now inherits it.');
    renderBrand();
  } catch (e) { toast(e.message, true); }
}

async function resetBrand() {
  if (!confirm('Reset every brand primitive to the shipped values?')) return;
  S.brand = await api('/api/studio/brand/reset', 'POST');
  toast('Brand reset to the shipped baseline.');
  renderBrand();
}

boot().catch(e => toast(e.message, true));

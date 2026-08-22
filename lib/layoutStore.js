'use strict';
// layoutStore.js — designer-authored campaign layouts ("skeletons").
//
// A layout is the structural half of a campaign: which components, in what order, with which
// palette and levers — but no copy. It is the answer to "what does a range launch look like",
// expressed once by the designer instead of reassembled from memory on every brief.
//
// componentStrategy.js already carries a recommended block sequence per objective, shipped in
// code. A layout authored here extends that taxonomy at runtime, so the designer can add or
// refine a structure without a deploy.

const { collection } = require('./recordStore');

const store = collection({
  table: 'studio_layouts',
  dir: 'layouts',
  columns: { name: 'name', objective: 'objective', status: 'status' },
});

function newId() { return 'l' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
function validId(id) { return typeof id === 'string' && /^l[a-z0-9]+-[a-z0-9]+$/i.test(id); }
function now() { return new Date().toISOString(); }

async function list() {
  const out = await store.list();
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

async function get(id) { return validId(id) ? store.get(id) : null; }

// blocks: [{ component, palette?, tokens?, note? }] — tokens are seeds, not copy.
function normaliseBlocks(blocks) {
  return (Array.isArray(blocks) ? blocks : []).map(b => ({
    component: String(b.component || ''),
    palette: b.palette || undefined,
    tokens: (b.tokens && typeof b.tokens === 'object') ? b.tokens : undefined,
    note: b.note ? String(b.note).slice(0, 240) : undefined,
  })).filter(b => b.component);
}

async function create(input = {}) {
  return store.put({
    id: newId(),
    name: String(input.name || 'Untitled layout').slice(0, 120),
    objective: String(input.objective || ''),
    description: String(input.description || '').slice(0, 600),
    bodyBg: input.bodyBg || undefined,
    blocks: normaliseBlocks(input.blocks),
    status: input.status === 'published' ? 'published' : 'draft',
    author: String(input.author || ''),
    createdAt: now(), updatedAt: now(),
  });
}

async function update(id, patch = {}) {
  const r = await get(id);
  if (!r) return null;
  if (typeof patch.name === 'string') r.name = patch.name.slice(0, 120);
  if (typeof patch.objective === 'string') r.objective = patch.objective;
  if (typeof patch.description === 'string') r.description = patch.description.slice(0, 600);
  if (patch.bodyBg) r.bodyBg = patch.bodyBg;
  if (patch.blocks) r.blocks = normaliseBlocks(patch.blocks);
  if (patch.status === 'published' || patch.status === 'draft') r.status = patch.status;
  r.updatedAt = now();
  return store.put(r);
}

async function remove(id) {
  if (!await get(id)) return false;
  return store.del(id);
}

// A layout as a ready-to-open campaign: blocks with their seeds, no copy.
function toCampaign(r) {
  return {
    campaignName: r.name,
    bodyBg: r.bodyBg || undefined,
    blocks: (r.blocks || []).map(b => ({ component: b.component, palette: b.palette, tokens: b.tokens || {} })),
  };
}

module.exports = {
  list, get, create, update, remove, toCampaign,
  get backend() { return store.backend; },
};

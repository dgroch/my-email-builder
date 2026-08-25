'use strict';
// componentStore.js — persistence for designer-authored components.
//
// A component authored in the Studio is stored as a *canvas document* (the editable scene
// graph) plus the compiled template it produces. It is never written into the repo: the
// designer has no git, and requiring a commit would put a developer back in her loop.
//
// Three rules shape this file:
//
//   1. VERSIONS ARE IMMUTABLE. Publishing an edit appends a version; it never rewrites one.
//      A campaign that was built — or sent — against version 2 keeps resolving version 2,
//      so an edit today can't silently restyle an email that shipped last month.
//   2. AN AUTHORED COMPONENT MAY SHADOW A SHIPPED ONE. The brief is to *upgrade* the library
//      as well as extend it, so `blocks/editorial-hero` can have an authored published version
//      that wins over the file on disk. Unpublishing reverts to the shipped baseline, which
//      makes every upgrade reversible without a deploy.
//   3. READS ON THE RENDER PATH ARE SYNCHRONOUS. Storage is async (Postgres), but
//      `render.assemble()` resolves a component name to HTML synchronously, deep inside a
//      call stack that is sync all the way down. So writes go to the database and a
//      snapshot of everything publishable is held in memory for those reads. The snapshot is
//      refreshed after every local write and, on a short TTL, at the top of each request —
//      which is also what keeps a second instance from serving a stale library.

const { collection } = require('./recordStore');

const STATUSES = ['draft', 'in_review', 'published', 'archived'];
const GROUPS = ['heroes', 'blocks', 'sections', 'products', 'dividers'];

const store = collection({
  table: 'studio_components',
  dir: 'components',
  columns: {
    name: 'name',
    group_name: 'group',
    slug: 'slug',
    status: 'status',
    published_version: 'publishedVersion',
    // Drives the snapshot query: a pinned reference must resolve even after the component is
    // unpublished or archived, so "has any version ever shipped" is the useful predicate.
    ever_published: (r) => (r.versions || []).some((v) => v.publishedAt),
  },
  // What the in-memory snapshot needs: only components with at least one published version.
  // Drafts can never be resolved by a campaign, so they stay out of the hot path entirely.
  snapshot: {
    where: 'ever_published',
    predicate: (r) => (r.versions || []).some((v) => v.publishedAt),
  },
});

function newId() { return 'c' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
function validId(id) { return typeof id === 'string' && /^c[a-z0-9]+-[a-z0-9]+$/i.test(id); }
function now() { return new Date().toISOString(); }

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'untitled';
}

function versionOf(r, n) { return (r.versions || []).find((v) => v.version === n) || null; }
function latestVersionOf(r) { return (r.versions || []).slice(-1)[0] || null; }
function publishedVersionOf(r) { return r.publishedVersion ? versionOf(r, r.publishedVersion) : null; }

// Summary view — no canvas documents, so the Studio list stays cheap.
function metaOf(r) {
  const pub = publishedVersionOf(r);
  const latest = latestVersionOf(r);
  const tokens = (pub && pub.compiled.tokens) || (latest && latest.compiled && latest.compiled.tokens) || [];
  return {
    id: r.id, name: r.name, group: r.group, slug: r.slug,
    title: r.title || r.slug, description: r.description || '',
    mode: r.mode, status: r.status,
    shadowsShipped: !!r.shadowsShipped,
    currentVersion: r.currentVersion || 0,
    publishedVersion: r.publishedVersion || null,
    versionCount: (r.versions || []).length,
    tokenCount: tokens.length,
    author: r.author || '', createdAt: r.createdAt, updatedAt: r.updatedAt,
    reviewNote: r.reviewNote || '', publishedAt: r.publishedAt || null,
  };
}

// ── the synchronous snapshot ────────────────────────────────────────────────
// Everything the render path can resolve: the currently published version of each component,
// and every version that has ever been published (for `name@n` pins).

let _snap = { published: [], pinned: new Map(), at: 0 };
let _refreshing = null;

function snapshotFrom(records) {
  const published = [];
  const pinned = new Map();
  for (const r of records) {
    for (const v of r.versions || []) {
      if (!v.publishedAt) continue;
      pinned.set(`${r.name}@${v.version}`, {
        name: r.name, mode: r.mode, version: v.version, id: r.id,
        html: v.compiled.html, tokens: v.compiled.tokens || [],
      });
    }
    const pv = publishedVersionOf(r);
    if (!pv) continue;
    published.push({
      name: r.name, group: r.group, mode: r.mode, version: pv.version, id: r.id,
      html: pv.compiled.html, tokens: pv.compiled.tokens || [],
      sampleTokens: pv.compiled.sampleTokens || {}, intent: r.intent || null,
      shadowsShipped: !!r.shadowsShipped, title: r.title || r.slug,
    });
  }
  return { published, pinned, at: Date.now() };
}

// Rebuild the snapshot from storage. Concurrent callers share one in-flight refresh.
function refresh() {
  if (_refreshing) return _refreshing;
  _refreshing = store.listSnapshot()
    .then((records) => { _snap = snapshotFrom(records); return _snap; })
    .catch((e) => { console.error('[componentStore] refresh failed:', e.message); return _snap; })
    .finally(() => { _refreshing = null; });
  return _refreshing;
}

const STALE_MS = Number(process.env.STUDIO_CACHE_MS || 5000);

// Called at the top of each request. Cheap when warm; bounds how long a second instance can
// serve a library that another instance has already changed.
function refreshIfStale(maxAgeMs = STALE_MS) {
  if (Date.now() - _snap.at < maxAgeMs) return Promise.resolve(_snap);
  return refresh();
}

// Synchronous reads for the render path.
function publishedTemplates() { return _snap.published; }
function pinnedTemplate(name, version) { return _snap.pinned.get(`${name}@${Number(version)}`) || null; }

// ── reads ───────────────────────────────────────────────────────────────────
async function list() {
  const records = await store.list();
  return records.map(metaOf).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

async function get(id) { return validId(id) ? store.get(id) : null; }

async function nameTaken(group, slug, exceptId) {
  const name = `${group}/${slug}`;
  const all = await store.list();
  return all.some((r) => r.name === name && r.id !== exceptId && r.status !== 'archived');
}

// ── writes ──────────────────────────────────────────────────────────────────
async function save(rec) { await store.put(rec); await refresh(); return rec; }

async function create(input = {}) {
  const group = GROUPS.includes(input.group) ? input.group : 'blocks';
  let slug = slugify(input.slug || input.title);
  if (!input.shadowsShipped && await nameTaken(group, slug)) {
    let n = 2;
    while (await nameTaken(group, `${slug}-${n}`)) n++;
    slug = `${slug}-${n}`;
  }
  return save({
    id: newId(),
    name: `${group}/${slug}`, group, slug,
    title: input.title || slug,
    description: input.description || '',
    // 'designed' blocks rasterise to PNG on publish, so the canvas is free (overlap, rotation,
    // absolute position). 'live' blocks ship as real email HTML and stay in flow layout.
    mode: input.mode === 'live' ? 'live' : 'designed',
    status: 'draft',
    // True when this authored component deliberately overrides a template shipped on disk.
    shadowsShipped: !!input.shadowsShipped,
    intent: input.intent || null,
    author: input.author || '',
    doc: input.doc || null,
    currentVersion: 0,
    publishedVersion: null,
    versions: [],
    reviewNote: '',
    createdAt: now(), updatedAt: now(),
  });
}

// Save the working canvas document. This is the autosave path — it does NOT create a version
// and does NOT touch what campaigns resolve. Only publish() changes what ships.
async function saveDoc(id, patch = {}) {
  const rec = await get(id);
  if (!rec) return null;
  if (patch.doc) rec.doc = patch.doc;
  if (typeof patch.title === 'string') rec.title = patch.title;
  if (typeof patch.description === 'string') rec.description = patch.description;
  if (patch.intent) rec.intent = patch.intent;
  if (typeof patch.author === 'string') rec.author = patch.author;
  if (patch.mode === 'live' || patch.mode === 'designed') rec.mode = patch.mode;
  // Renaming is allowed while nothing is published — once a version ships, the name is the
  // contract saved campaigns reference, so it locks.
  if (patch.slug && !rec.publishedVersion) {
    const slug = slugify(patch.slug);
    if (!await nameTaken(rec.group, slug, rec.id)) { rec.slug = slug; rec.name = `${rec.group}/${slug}`; }
  }
  if (patch.group && GROUPS.includes(patch.group) && !rec.publishedVersion) {
    rec.group = patch.group; rec.name = `${rec.group}/${rec.slug}`;
  }
  rec.updatedAt = now();
  return save(rec);
}

// Cut an immutable version from the current document. `compiled` is the output of
// compileComponent(). Versions accumulate; nothing is ever overwritten.
async function cutVersion(id, compiled, note) {
  const rec = await get(id);
  if (!rec) return null;
  const version = (rec.currentVersion || 0) + 1;
  rec.versions.push({
    version, note: note || '', createdAt: now(), publishedAt: null,
    doc: JSON.parse(JSON.stringify(rec.doc || {})),
    compiled: { html: compiled.html, tokens: compiled.tokens, sampleTokens: compiled.sampleTokens },
  });
  rec.currentVersion = version;
  rec.updatedAt = now();
  await save(rec);
  return versionOf(rec, version);
}

async function submitForReview(id, note) {
  const rec = await get(id);
  if (!rec) return null;
  rec.status = 'in_review';
  rec.reviewNote = note || '';
  rec.updatedAt = now();
  return save(rec);
}

// Publish a version: from here it is what campaigns resolve, and it can never be edited —
// only superseded by a later version.
async function publish(id, version) {
  const rec = await get(id);
  if (!rec) return null;
  const v = versionOf(rec, Number(version) || rec.currentVersion);
  if (!v) return null;
  v.publishedAt = v.publishedAt || now();
  rec.publishedVersion = v.version;
  rec.publishedAt = now();
  rec.status = 'published';
  rec.updatedAt = now();
  return save(rec);
}

// Withdraw the live version. Campaigns fall back to the shipped template on disk when this
// component shadowed one, which is what makes every upgrade reversible without a deploy.
async function unpublish(id) {
  const rec = await get(id);
  if (!rec) return null;
  rec.publishedVersion = null;
  rec.status = 'draft';
  rec.updatedAt = now();
  return save(rec);
}

async function remove(id) {
  const rec = await get(id);
  if (!rec) return false;
  // A component that has ever published is archived, never deleted — a pinned version must
  // keep resolving for campaigns already built against it.
  if ((rec.versions || []).some((v) => v.publishedAt)) {
    rec.status = 'archived'; rec.publishedVersion = null; rec.updatedAt = now();
    await save(rec);
    return true;
  }
  const okDel = await store.del(rec.id);
  await refresh();
  return okDel;
}

module.exports = {
  list, get, create, saveDoc, cutVersion, submitForReview, publish, unpublish, remove,
  publishedTemplates, pinnedTemplate, refresh, refreshIfStale, metaOf,
  versionOf, latestVersionOf, publishedVersionOf,
  slugify, STATUSES, GROUPS,
  get backend() { return store.backend; },
};

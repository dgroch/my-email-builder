'use strict';
// componentStore.js — persistence for designer-authored components.
//
// A component authored in the Studio is stored as a *canvas document* (the editable scene
// graph) plus the compiled template it produces. It is never written into the repo: the
// designer has no git, and requiring a commit would put a developer back in her loop.
//
// Two rules shape this file:
//
//   1. VERSIONS ARE IMMUTABLE. Publishing an edit appends a version; it never rewrites one.
//      A campaign that was built — or sent — against version 2 keeps resolving version 2,
//      so an edit today can't silently restyle an email that shipped last month.
//   2. AN AUTHORED COMPONENT MAY SHADOW A SHIPPED ONE. The brief is to *upgrade* the library
//      as well as extend it, so `blocks/editorial-hero` can have an authored published version
//      that wins over the file on disk. Unpublishing reverts to the shipped baseline, which
//      makes every upgrade reversible without a deploy.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DIR = path.join(DATA_DIR, 'components');

const STATUSES = ['draft', 'in_review', 'published', 'archived'];
const GROUPS = ['heroes', 'blocks', 'sections', 'products', 'dividers'];

function ensureDir() { fs.mkdirSync(DIR, { recursive: true }); }
function fileFor(id) { return path.join(DIR, id + '.json'); }
function newId() { return 'c' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
function validId(id) { return typeof id === 'string' && /^c[a-z0-9]+-[a-z0-9]+$/i.test(id); }
function now() { return new Date().toISOString(); }

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'untitled';
}

function readRec(id) {
  try { return JSON.parse(fs.readFileSync(fileFor(id), 'utf8')); } catch (_) { return null; }
}
function writeRec(rec) { ensureDir(); fs.writeFileSync(fileFor(rec.id), JSON.stringify(rec, null, 2)); return rec; }

function allRecs() {
  ensureDir();
  const out = [];
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.json')) continue;
    const r = readRec(f.slice(0, -5));
    if (r && r.id) out.push(r);
  }
  return out;
}

// Summary view — no canvas documents, so the Studio list stays cheap.
function metaOf(r) {
  const pub = publishedVersionOf(r);
  return {
    id: r.id, name: r.name, group: r.group, slug: r.slug,
    title: r.title || r.slug, description: r.description || '',
    mode: r.mode, status: r.status,
    shadowsShipped: !!r.shadowsShipped,
    currentVersion: r.currentVersion || 0,
    publishedVersion: r.publishedVersion || null,
    versionCount: (r.versions || []).length,
    tokenCount: pub ? (pub.compiled.tokens || []).length : ((latestVersionOf(r) || {}).compiled || {}).tokens?.length || 0,
    author: r.author || '', createdAt: r.createdAt, updatedAt: r.updatedAt,
    reviewNote: r.reviewNote || '', publishedAt: r.publishedAt || null,
  };
}

function versionOf(r, n) { return (r.versions || []).find(v => v.version === n) || null; }
function latestVersionOf(r) { return (r.versions || []).slice(-1)[0] || null; }
function publishedVersionOf(r) { return r.publishedVersion ? versionOf(r, r.publishedVersion) : null; }

function list() { return allRecs().map(metaOf).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))); }
function get(id) { return validId(id) ? readRec(id) : null; }

// Every published version of every component, keyed `group/slug`. This is what the template
// resolver consults, so a published authored component is visible to assemble/render/slice/push.
function publishedTemplates() {
  const out = [];
  for (const r of allRecs()) {
    const v = publishedVersionOf(r);
    if (!v) continue;
    out.push({
      name: r.name, group: r.group, mode: r.mode, version: v.version, id: r.id,
      html: v.compiled.html, tokens: v.compiled.tokens || [],
      sampleTokens: v.compiled.sampleTokens || {}, intent: r.intent || null,
      shadowsShipped: !!r.shadowsShipped, title: r.title || r.slug,
    });
  }
  return out;
}

// Every version ever published, for version-pinned resolution (`blocks/x@2`). A saved or
// sent campaign pins the version it was built against; this is what keeps it reproducible.
function pinnedTemplate(name, version) {
  for (const r of allRecs()) {
    if (r.name !== name) continue;
    const v = versionOf(r, Number(version));
    if (v && v.publishedAt) return { name: r.name, mode: r.mode, version: v.version, html: v.compiled.html, tokens: v.compiled.tokens || [] };
  }
  return null;
}

function nameFor(group, slug) { return `${group}/${slug}`; }

function nameTaken(group, slug, exceptId) {
  const name = nameFor(group, slug);
  return allRecs().some(r => r.name === name && r.id !== exceptId && r.status !== 'archived');
}

function create(input = {}) {
  const group = GROUPS.includes(input.group) ? input.group : 'blocks';
  let slug = slugify(input.slug || input.title);
  if (nameTaken(group, slug) && !input.shadowsShipped) {
    let n = 2;
    while (nameTaken(group, `${slug}-${n}`)) n++;
    slug = `${slug}-${n}`;
  }
  const rec = {
    id: newId(),
    name: nameFor(group, slug), group, slug,
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
  };
  return writeRec(rec);
}

// Save the working canvas document. This is the autosave path — it does NOT create a version
// and does NOT touch what campaigns resolve. Only publish() changes what ships.
function saveDoc(id, patch = {}) {
  const rec = get(id);
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
    if (!nameTaken(rec.group, slug, rec.id)) { rec.slug = slug; rec.name = nameFor(rec.group, slug); }
  }
  if (patch.group && GROUPS.includes(patch.group) && !rec.publishedVersion) {
    rec.group = patch.group; rec.name = nameFor(rec.group, rec.slug);
  }
  rec.updatedAt = now();
  return writeRec(rec);
}

// Cut an immutable version from the current document. `compiled` is the output of
// compileComponent(). Versions accumulate; nothing is ever overwritten.
function cutVersion(id, compiled, note) {
  const rec = get(id);
  if (!rec) return null;
  const version = (rec.currentVersion || 0) + 1;
  rec.versions.push({
    version, note: note || '', createdAt: now(), publishedAt: null,
    doc: JSON.parse(JSON.stringify(rec.doc || {})),
    compiled: { html: compiled.html, tokens: compiled.tokens, sampleTokens: compiled.sampleTokens },
  });
  rec.currentVersion = version;
  rec.updatedAt = now();
  writeRec(rec);
  return versionOf(rec, version);
}

function submitForReview(id, note) {
  const rec = get(id);
  if (!rec) return null;
  rec.status = 'in_review';
  rec.reviewNote = note || '';
  rec.updatedAt = now();
  return writeRec(rec);
}

// Publish a version: from here it is what campaigns resolve, and it can never be edited —
// only superseded by a later version.
function publish(id, version) {
  const rec = get(id);
  if (!rec) return null;
  const v = versionOf(rec, Number(version) || rec.currentVersion);
  if (!v) return null;
  v.publishedAt = v.publishedAt || now();
  rec.publishedVersion = v.version;
  rec.publishedAt = now();
  rec.status = 'published';
  rec.updatedAt = now();
  return writeRec(rec);
}

// Withdraw the live version. Campaigns fall back to the shipped template on disk when this
// component shadowed one, which is what makes every upgrade reversible without a deploy.
function unpublish(id) {
  const rec = get(id);
  if (!rec) return null;
  rec.publishedVersion = null;
  rec.status = 'draft';
  rec.updatedAt = now();
  return writeRec(rec);
}

function remove(id) {
  const rec = get(id);
  if (!rec) return false;
  // A component that has ever published is archived, never deleted — a pinned version must
  // keep resolving for campaigns already built against it.
  if ((rec.versions || []).some(v => v.publishedAt)) {
    rec.status = 'archived'; rec.publishedVersion = null; rec.updatedAt = now();
    writeRec(rec); return true;
  }
  try { fs.unlinkSync(fileFor(rec.id)); return true; } catch (_) { return false; }
}

module.exports = {
  list, get, create, saveDoc, cutVersion, submitForReview, publish, unpublish, remove,
  publishedTemplates, pinnedTemplate, metaOf, versionOf, latestVersionOf, publishedVersionOf,
  slugify, STATUSES, GROUPS,
};

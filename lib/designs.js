'use strict';
// designs.js — persist campaign designs to disk so they can be reopened, edited and cloned.
// Each design is one JSON file in DATA_DIR: { id, name, createdAt, updatedAt, campaign }.
//
// DATA_DIR should point at a *persistent* disk (e.g. Render's mounted disk at /data).
// On an ephemeral filesystem the designs survive only until the next redeploy/restart.

const fs = require('fs');
const path = require('path');
const { deriveComponentsUsed, pickMeta, withCreateDefaults } = require('./designMeta');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }
function fileFor(id) { return path.join(DATA_DIR, id + '.json'); }

// Opaque, filesystem-safe id (no path separators, sortable-ish by creation time).
function newId() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
function validId(id) { return typeof id === 'string' && /^[a-z0-9]+-[a-z0-9]+$/i.test(id); }

function readDesign(id) {
  try { return JSON.parse(fs.readFileSync(fileFor(id), 'utf8')); } catch (_) { return null; }
}
function writeDesign(d) { ensureDir(); fs.writeFileSync(fileFor(d.id), JSON.stringify(d, null, 2)); return d; }

// Metadata fields (no campaign body) surfaced in list(), so approved patterns are
// searchable without loading every campaign.
function metaOf(d) {
  return {
    id: d.id, name: d.name, createdAt: d.createdAt, updatedAt: d.updatedAt,
    isExample: !!d.isExample, objective: d.objective || '',
    campaignType: d.campaignType || '', audienceAwareness: d.audienceAwareness || '',
    primaryCTA: d.primaryCTA || '', subjectLine: d.subjectLine || '', previewText: d.previewText || '',
    emotionalTone: d.emotionalTone || '',
    approvalStatus: d.approvalStatus || 'draft', componentsUsed: d.componentsUsed || [],
    sourceBriefLink: d.sourceBriefLink || '', klaviyoLink: d.klaviyoLink || '',
    resultNotes: d.resultNotes || '',
  };
}

// List metadata only (no campaign bodies), newest-updated first.
function list() {
  ensureDir();
  const out = [];
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!f.endsWith('.json')) continue;
    const d = readDesign(f.slice(0, -5));
    if (d && d.id) out.push(metaOf(d));
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
}

function get(id) { return validId(id) ? readDesign(id) : null; }

function create(input = {}) {
  const { name, campaign } = input;
  const now = new Date().toISOString();
  const meta = withCreateDefaults(pickMeta(input));
  return writeDesign({
    id: newId(), name: (name || (campaign && campaign.campaignName) || 'Untitled design').trim(),
    createdAt: now, updatedAt: now, campaign: campaign || {},
    ...meta, componentsUsed: deriveComponentsUsed(campaign),
  });
}

function update(id, input = {}) {
  if (!validId(id)) return null;
  const cur = readDesign(id);
  if (!cur) return null;
  const { name, campaign } = input;
  if (name != null) cur.name = String(name).trim() || cur.name;
  if (campaign != null) { cur.campaign = campaign; cur.componentsUsed = deriveComponentsUsed(campaign); }
  Object.assign(cur, pickMeta(input)); // only fields actually provided
  cur.updatedAt = new Date().toISOString();
  return writeDesign(cur);
}

function clone(id, name) {
  if (!validId(id)) return null;
  const cur = readDesign(id);
  if (!cur) return null;
  // Carry over the descriptive metadata, but a clone starts as a fresh draft (not an example).
  return create({
    name: (name || (cur.name + ' (copy)')), campaign: cur.campaign,
    objective: cur.objective, campaignType: cur.campaignType, audienceAwareness: cur.audienceAwareness,
    primaryCTA: cur.primaryCTA, emotionalTone: cur.emotionalTone, sourceBriefLink: cur.sourceBriefLink,
    isExample: false, approvalStatus: 'draft',
  });
}

function remove(id) {
  if (!validId(id)) return false;
  try { fs.unlinkSync(fileFor(id)); return true; } catch (_) { return false; }
}

module.exports = { list, get, create, update, clone, remove, DATA_DIR, backend: 'disk' };

'use strict';
// designs.js — persist campaign designs to disk so they can be reopened, edited and cloned.
// Each design is one JSON file in DATA_DIR: { id, name, createdAt, updatedAt, campaign }.
//
// DATA_DIR should point at a *persistent* disk (e.g. Render's mounted disk at /data).
// On an ephemeral filesystem the designs survive only until the next redeploy/restart.

const fs = require('fs');
const path = require('path');

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

// List metadata only (no campaign bodies), newest-updated first.
function list() {
  ensureDir();
  const out = [];
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!f.endsWith('.json')) continue;
    const d = readDesign(f.slice(0, -5));
    if (d && d.id) out.push({ id: d.id, name: d.name, createdAt: d.createdAt, updatedAt: d.updatedAt });
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
}

function get(id) { return validId(id) ? readDesign(id) : null; }

function create({ name, campaign }) {
  const now = new Date().toISOString();
  return writeDesign({ id: newId(), name: (name || (campaign && campaign.campaignName) || 'Untitled design').trim(), createdAt: now, updatedAt: now, campaign: campaign || {} });
}

function update(id, { name, campaign }) {
  if (!validId(id)) return null;
  const cur = readDesign(id);
  if (!cur) return null;
  if (name != null) cur.name = String(name).trim() || cur.name;
  if (campaign != null) cur.campaign = campaign;
  cur.updatedAt = new Date().toISOString();
  return writeDesign(cur);
}

function clone(id, name) {
  if (!validId(id)) return null;
  const cur = readDesign(id);
  if (!cur) return null;
  return create({ name: (name || (cur.name + ' (copy)')), campaign: cur.campaign });
}

function remove(id) {
  if (!validId(id)) return false;
  try { fs.unlinkSync(fileFor(id)); return true; } catch (_) { return false; }
}

module.exports = { list, get, create, update, clone, remove, DATA_DIR };

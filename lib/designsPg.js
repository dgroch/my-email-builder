'use strict';
// designsPg.js — saved designs in Postgres.
//
// Third backend for the same /api/designs contract, alongside the Notion store and the local
// disk fallback. It exists so one env var (DATABASE_URL) gives the whole app durable storage:
// without it, designs on a container with no persistent disk are lost on every redeploy, which
// is the same failure the Studio's component store had.
//
// Selection order in server.js is Notion → Postgres → disk, so an existing Notion deployment
// keeps working untouched.

const db = require('./db');
const { deriveComponentsUsed, pickMeta, withCreateDefaults } = require('./designMeta');

function newId() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
function validId(id) { return typeof id === 'string' && /^[a-z0-9]+-[a-z0-9]+$/i.test(id); }

// Metadata only (no campaign bodies) — the same shape the disk store's list() returns, so the
// UI and the examples lens don't care which backend is behind them.
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

async function write(d) {
  await db.query(
    `INSERT INTO designs (id, name, record, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, record = EXCLUDED.record, updated_at = now()`,
    [d.id, d.name || '', JSON.stringify(d)],
  );
  return d;
}

async function list() {
  const r = await db.query('SELECT record FROM designs ORDER BY updated_at DESC');
  return r.rows.map((x) => metaOf(x.record));
}

async function get(id) {
  if (!validId(id)) return null;
  const r = await db.query('SELECT record FROM designs WHERE id = $1', [id]);
  return r.rows.length ? r.rows[0].record : null;
}

async function create(input = {}) {
  const { name, campaign } = input;
  const now = new Date().toISOString();
  const meta = withCreateDefaults(pickMeta(input));
  return write({
    id: newId(), name: (name || (campaign && campaign.campaignName) || 'Untitled design').trim(),
    createdAt: now, updatedAt: now, campaign: campaign || {},
    ...meta, componentsUsed: deriveComponentsUsed(campaign),
  });
}

async function update(id, input = {}) {
  const cur = await get(id);
  if (!cur) return null;
  const { name, campaign } = input;
  if (name != null) cur.name = String(name).trim() || cur.name;
  if (campaign != null) { cur.campaign = campaign; cur.componentsUsed = deriveComponentsUsed(campaign); }
  Object.assign(cur, pickMeta(input)); // only fields actually provided
  cur.updatedAt = new Date().toISOString();
  return write(cur);
}

async function clone(id, name) {
  const cur = await get(id);
  if (!cur) return null;
  // Carry over the descriptive metadata, but a clone starts as a fresh draft (not an example).
  return create({
    name: (name || (cur.name + ' (copy)')), campaign: cur.campaign,
    objective: cur.objective, campaignType: cur.campaignType, audienceAwareness: cur.audienceAwareness,
    primaryCTA: cur.primaryCTA, emotionalTone: cur.emotionalTone, sourceBriefLink: cur.sourceBriefLink,
    isExample: false, approvalStatus: 'draft',
  });
}

async function remove(id) {
  if (!validId(id)) return false;
  const r = await db.query('DELETE FROM designs WHERE id = $1', [id]);
  return r.rowCount > 0;
}

module.exports = { list, get, create, update, clone, remove, backend: 'postgres' };

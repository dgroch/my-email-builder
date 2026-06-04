'use strict';
// examples.js — approved campaign exemplars, exposed via GET /api/examples (Task 2).
//
// Examples are just designs flagged `isExample: true`. They come from two places, merged:
//   1. Committed seed exemplars in examples/*.json (ship with the repo, always available,
//      used by the invariant test) — e.g. the repaired farewell_sellthrough design.
//   2. Any designs in the live store (disk or Notion) the team has flagged isExample.
//
// Each returned example carries its full campaign + metadata so an agent can copy the
// pattern directly. Seeds and store records are de-duplicated by id (store wins).

const fs = require('fs');
const path = require('path');

const SEED_DIR = path.join(__dirname, '..', 'examples');

function loadSeedExamples() {
  let files = [];
  try { files = fs.readdirSync(SEED_DIR).filter((f) => f.endsWith('.json')); } catch (_) { return []; }
  const out = [];
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(SEED_DIR, f), 'utf8'));
      if (d && d.campaign) out.push({ ...d, isExample: true, seed: true });
    } catch (_) { /* skip malformed seed */ }
  }
  return out;
}

// Gather examples from the store (designs flagged isExample) + the committed seeds.
async function listExamples(designs, { objective } = {}) {
  const seeds = loadSeedExamples();

  // Store-backed examples: list() carries isExample/objective metadata, then get() the body.
  const storeExamples = [];
  try {
    const metas = await designs.list();
    for (const m of metas) {
      if (!m.isExample) continue;
      const full = await designs.get(m.id);
      if (full) storeExamples.push(full);
    }
  } catch (_) { /* store unavailable → fall back to seeds only */ }

  const byId = new Map();
  for (const e of seeds) byId.set(e.id, e);
  for (const e of storeExamples) byId.set(e.id, e); // store overrides a seed with the same id

  let all = [...byId.values()];
  if (objective) all = all.filter((e) => (e.objective || '') === objective);
  return all;
}

module.exports = { loadSeedExamples, listExamples, SEED_DIR };

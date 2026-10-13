const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const db = require('../lib/db');
after(() => db.close());

const campaign = { campaignName: 'Fixture', bodyBg: '#fff', blocks: [
  { id: 1, component: 'blocks/copy', tokens: { TEXT: 'Saved copy', ALT: 'Copy' } },
  { id: 2, component: 'footer', tokens: {} },
] };
// PostgreSQL JSONB can reorder keys at every object level; array order is retained.
const persisted = { blocks: [
  { id: 1, tokens: { ALT: 'Copy', TEXT: 'Saved copy' }, component: 'blocks/copy' },
  { id: 2, tokens: {}, component: 'footer' },
], bodyBg: '#fff', campaignName: 'Fixture' };

async function handoff(saved) {
  const button = {}, statuses = [], navigations = [];
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  vm.runInNewContext(source.slice(source.indexOf('// Creative handoff only:')), {
    campaign, currentDesignId: 'fixture-design', URL,
    document: { querySelector: () => button },
    setStatus: (message) => statuses.push(message),
    window: { location: { assign: (url) => navigations.push(url) } },
    fetch: async (url) => ({ ok: true, json: async () => url === '/api/publishing-config'
      ? { engineOrigin: 'https://engagement.figandbloom.com' }
      : { id: 'fixture-design', campaign: saved, subjectLine: 'Fixture', previewText: 'Fixture', updatedAt: '2026-10-13T00:00:00Z' } }),
  });
  await new Promise(setImmediate);
  await button.onclick();
  return { statuses, navigations };
}

test('publishing accepts saved campaigns with reordered JSONB object keys', async () => {
  const saved = db.enabled
    ? (await db.query('SELECT $1::jsonb AS campaign', [JSON.stringify(campaign)])).rows[0].campaign
    : persisted;
  assert.deepEqual(campaign, saved);
  const result = await handoff(saved);
  assert.deepEqual(result.statuses, []);
  assert.deepEqual(result.navigations, ['https://engagement.figandbloom.com/campaigns/import?designId=fixture-design&expectedUpdatedAt=2026-10-13T00%3A00%3A00Z']);
});

test('publishing still blocks changed nested content and reordered blocks', async () => {
  for (const change of [
    (saved) => { saved.blocks[0].tokens.TEXT = 'Unsaved copy'; },
    (saved) => { saved.blocks.reverse(); },
  ]) {
    const saved = structuredClone(persisted);
    change(saved);
    const result = await handoff(saved);
    assert.deepEqual(result.navigations, []);
    assert.deepEqual(result.statuses, ['Save your latest changes before publishing']);
  }
});

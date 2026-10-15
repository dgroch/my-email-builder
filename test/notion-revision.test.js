const { test } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');

// Exercise the real store against a bounded Notion HTTP double. Notion echoes
// timestamp dates with an offset, while date-only properties stay date-only.
test('Notion saved-design revisions round-trip and distinguish same-day edits', async (t) => {
  const id = '10000000-0000-4000-8000-000000000001';
  let page, children = [], sequence = 0;
  t.mock.method(https, 'request', (options, callback) => {
    const request = new EventEmitter();
    let raw = '';
    request.write = (value) => { raw += value; };
    request.end = () => queueMicrotask(() => {
      const body = raw ? JSON.parse(raw) : {};
      let result;
      const route = options.method + ' ' + options.path;
      if (route.startsWith('GET /v1/databases/')) result = { properties: {} };
      else if (route === 'POST /v1/pages') {
        page = { id, properties: body.properties, archived: false };
        children = body.children.map(b => ({ ...b, id: String(++sequence) }));
        result = page;
      } else if (route === 'GET /v1/pages/' + id) result = page;
      else if (route === 'PATCH /v1/pages/' + id) {
        Object.assign(page.properties, body.properties); result = page;
      } else if (route.startsWith('GET /v1/blocks/' + id + '/children')) {
        result = { results: children, has_more: false, next_cursor: null };
      } else if (route === 'PATCH /v1/blocks/' + id + '/children') {
        children.push(...body.children.map(b => ({ ...b, id: String(++sequence) })));
        result = { results: children };
      } else if (route.startsWith('DELETE /v1/blocks/')) {
        children = children.filter(b => b.id !== options.path.split('/').pop()); result = {};
      } else throw new Error('Unexpected Notion request: ' + route);
      const response = new EventEmitter(); response.statusCode = 200;
      callback(response);
      response.emit('data', JSON.stringify(result).replaceAll('Z"', '+00:00"'));
      response.emit('end');
    });
    return request;
  });
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-15T01:00:00.123Z') });
  const store = require('../lib/notionStore');
  const saved = await store.create({ name: 'Synthetic', campaign: { blocks: [] } });
  const reopened = await store.get(id);
  assert.equal(reopened.updatedAt, saved.updatedAt, 'saved revision must survive readback');
  assert.equal(reopened.updatedAt, '2026-10-15T01:00:00.123Z');
  t.mock.timers.tick(1000);
  const updated = await store.update(id, { name: 'Synthetic edited' });
  assert.equal(updated.updatedAt, '2026-10-15T01:00:01.123Z');
  assert.notEqual(updated.updatedAt, saved.updatedAt, 'same-day edits invalidate previous revision');
  assert.equal((await store.get(id)).updatedAt, updated.updatedAt);
});

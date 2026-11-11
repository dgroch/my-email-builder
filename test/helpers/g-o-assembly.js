'use strict';
// Exercise the real push handler and HTTPS serialization without credentials
// or API sockets. Default pixels are faked; realAssets uses Chrome
// with resources supplied by the render script. HTTPS API serialization stays stubbed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const fixture = require('../fixtures/send8-marseille-403fdc24.json');

async function capturePush(campaign = structuredClone(fixture.campaign), options = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-go-'));
  const envKeys = ['DATA_DIR', 'KLAVIYO_API_KEY', 'PUBLIC_ASSETS_BASE', 'IMAGE_OPT_CACHE', 'DATABASE_URL', 'NOTION_TOKEN', 'NOTION_DESIGNS_DB'];
  const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  // This helper is used only in dedicated test/script processes; never load integrations.
  process.env.DATA_DIR = scratch;
  process.env.KLAVIYO_API_KEY = 'offline-test-key';
  process.env.PUBLIC_ASSETS_BASE = 'https://cdn.example.com';
  process.env.IMAGE_OPT_CACHE = 'false';
  for (const key of ['DATABASE_URL', 'NOTION_TOKEN', 'NOTION_DESIGNS_DB']) delete process.env[key];
  const render = require('../../lib/render');
  const { server } = require('../../server');
  const originalSlices = render.renderSlices, originalRequest = https.request, originalFetch = global.fetch;
  const requests = [], rasterized = [], uploads = [];
  let html;
  global.fetch = async () => { throw new Error('Network prohibited in offline push capture'); };
  https.request = (opts, callback) => {
    assert.equal(opts.hostname, 'a.klaviyo.com');
    const req = new EventEmitter(), chunks = [];
    req.write = chunk => chunks.push(Buffer.from(chunk));
    req.end = () => queueMicrotask(() => {
      const body = Buffer.concat(chunks);
      requests.push({ path: opts.path, body: opts.path === '/api/image-upload' ? null : JSON.parse(body.toString()) });
      if (opts.path === '/api/image-upload') {
        const boundary = opts.headers['Content-Type'].split('boundary=')[1];
        const start = body.indexOf('\r\n\r\n') + 4;
        const end = body.indexOf(Buffer.from(`\r\n--${boundary}`), start);
        assert.ok(start > 3 && end > start, 'Valid multipart image');
        const ext = body.subarray(0, start).toString().match(/filename="[^"]+\.(\w+)"/)[1];
        uploads.push({ url: `https://assets.example.test/slice-${requests.length}.png`, ext, buffer: body.subarray(start, end) });
      }
      const replies = {
        '/api/image-upload': { data: { attributes: { image_url: `https://assets.example.test/slice-${requests.length}.png` } } },
        '/api/templates/': { data: { id: 'offline-template' } },
        '/api/campaigns/': { data: { id: 'offline-campaign', relationships: { 'campaign-messages': { data: [{ id: 'offline-message' }] } } } },
        '/api/campaign-message-assign-template/': {},
      };
      assert.ok(Object.hasOwn(replies, opts.path), `Unexpected endpoint ${opts.path}`);
      if (opts.path === '/api/templates/') html = requests.at(-1).body.data.attributes.html;
      const res = new EventEmitter();
      res.statusCode = 200;
      callback(res);
      res.emit('data', JSON.stringify(replies[opts.path]));
      res.emit('end');
    });
    return req;
  };
  if (options.realAssets) {
    render.renderSlices = async (html, opts) => {
      const result = await originalSlices(await options.localize(html, true), { ...opts, frozenResources: true });
      assert.deepEqual(result.brokenImages, [], 'All real raster images must load');
      rasterized.push(...result.slices.map(s => s.component));
      return result;
    };
  } else {
    const buffer = await require('sharp')({ create: { width: 600, height: 100, channels: 3, background: '#ffffff' } }).png().toBuffer();
    render.renderSlices = async (_html, opts = {}) => ({ slices: campaign.blocks.flatMap((b, index) => {
      if ((opts.skipIndexes || []).includes(index)) return [];
      rasterized.push(b.component);
      return [{ index, component: b.component, width: 600, height: 750, seg: 0, segCount: 1, kind: 'png', buffer }];
    }), brokenImages: [] });
  }
  try {
    const response = await new Promise((resolve, reject) => {
      const req = Readable.from([JSON.stringify({ campaign, listId: 'offline-list', fromEmail: 'fixture@example.test', subject: campaign.subjectLine || 'Fixture', previewText: campaign.previewText || 'Fixture' })]);
      Object.assign(req, { method: 'POST', url: '/api/klaviyo-draft', headers: { host: '127.0.0.1', 'content-type': 'application/json' } });
      let status;
      const res = { writeHead(code) { status = code; }, end(raw) {
        try { resolve({ status, body: JSON.parse(raw) }); } catch (e) { reject(e); }
      } };
      server.emit('request', req, res);
    });
    return { html, requests, rasterized, uploads, response };
  } finally {
    if (options.realAssets) await render.closeBrowser();
    render.renderSlices = originalSlices;
    https.request = originalRequest;
    global.fetch = originalFetch;
    await require('../../lib/db').close();
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
module.exports = { capturePush, fixture };

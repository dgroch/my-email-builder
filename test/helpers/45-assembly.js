'use strict';
// Offline fixture: exercise the real HTTP route, optimiser, image rows, production
// shell and Klaviyo request serialization. Request streams are injected in-process; only rasterization and HTTPS are mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const ALT = 'Pink roses in a seasonal bouquet';
const campaign = {
  campaignName: 'Images-off regression',
  blocks: [{ component: 'heroes/hero-image-only', tokens: {
    HERO_IMAGE_URL: 'https://assets.example.test/hero.jpg',
    HERO_IMAGE_ALT: ALT, HERO_LINK_URL: 'https://example.test/bouquets',
  } }],
};
async function captureAssembly() {
  const keys = ['DATA_DIR', 'DATABASE_URL', 'NOTION_TOKEN', 'NOTION_DESIGNS_DB', 'KLAVIYO_API_KEY', 'PUBLIC_ASSETS_BASE', 'IMAGE_OPT_CACHE'];
  const savedEnv = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'eb45-'));
  Object.assign(process.env, { DATA_DIR: temp, KLAVIYO_API_KEY: 'mock-only', PUBLIC_ASSETS_BASE: 'https://cdn.example.com', IMAGE_OPT_CACHE: 'false' });
  for (const k of ['DATABASE_URL', 'NOTION_TOKEN', 'NOTION_DESIGNS_DB']) delete process.env[k];
  const render = require('../../lib/render');
  const { server } = require('../../server');
  const originalSlices = render.renderSlices, originalRequest = https.request, originalFetch = global.fetch;
  const captures = {}, requests = [];
  let mode, submitted;
  https.request = (opts, callback) => {
    assert.equal(opts.hostname, 'a.klaviyo.com', 'Unexpected external request');
    const replies = {
      '/api/image-upload': { data: { attributes: { image_url: 'https://assets.example.test/slice.png' } } },
      '/api/templates/': { data: { id: 'mock-template' } },
      '/api/campaigns/': { data: { id: 'mock-campaign', relationships: { 'campaign-messages': { data: [{ id: 'mock-message' }] } } } },
      '/api/campaign-message-assign-template/': {},
    };
    assert.ok(Object.hasOwn(replies, opts.path), 'Unexpected Klaviyo endpoint');
    assert.equal(opts.method, 'POST');
    const req = new EventEmitter(), chunks = [];
    req.write = chunk => chunks.push(Buffer.from(chunk));
    req.end = () => queueMicrotask(() => {
      requests.push(opts.path);
      if (opts.path === '/api/templates/') submitted = JSON.parse(Buffer.concat(chunks).toString()).data.attributes.html;
      const res = new EventEmitter();
      res.statusCode = 200;
      callback(res);
      res.emit('data', JSON.stringify(replies[opts.path]));
      res.emit('end');
    });
    return req;
  };
  const buffer = fs.readFileSync(path.join(__dirname, '../fixtures/campaign-assets/placeholder-hero.jpg'));
  render.renderSlices = async html => {
    assert.match(html, /data-eb-block="0"/);
    const base = { index: 0, component: campaign.blocks[0].component, width: 600, height: 750, seg: 0, segCount: 1 };
    if (mode === 'fallback') return { slices: [{ ...base, index: 1, kind: 'png', buffer }] };
    if (mode === 'gif') return { slices: [{ ...base, kind: 'gif', src: 'https://assets.example.test/hero.gif' }] };
    if (mode === 'columns') return { slices: [
      { ...base, layout: 'cols', width: 300, kind: 'gif', src: 'https://assets.example.test/hero.gif' },
      { ...base, layout: 'cols', width: 300, kind: 'png', buffer },
    ] };
    return { slices: [{ ...base, kind: 'png', buffer }] };
  };
  try {
    const origin = 'http://127.0.0.1';
    global.fetch = (url, opts) => {
      assert.equal(new URL(url).origin, origin, 'External fetch prohibited');
      return originalFetch(url, opts);
    };
    async function post(route, body) {
      // Inject a request stream into the actual server listener; no TCP socket or
      // alternate assembly implementation is involved.
      return new Promise((resolve, reject) => {
        const req = Readable.from([JSON.stringify(body)]);
        Object.assign(req, { method: 'POST', url: route, headers: { host: '127.0.0.1', 'content-type': 'application/json' } });
        let status;
        const res = {
          writeHead(code) { status = code; },
          end(raw) {
            try { const data = JSON.parse(raw); assert.equal(status, 200, raw); resolve(data); } catch (e) { reject(e); }
          },
        };
        server.emit('request', req, res);
      });
    }
    captures.direct = (await post('/api/export', { campaign, previewText: 'Seasonal flowers' })).html;
    const escapedCampaign = structuredClone(campaign);
    escapedCampaign.blocks[0].tokens.HERO_IMAGE_ALT = 'Pink roses & "seasonal" blooms';
    captures.escaped = (await post('/api/export', { campaign: escapedCampaign, previewText: 'Seasonal flowers' })).html;
    for (mode of ['sliced', 'gif', 'columns', 'fallback']) {
      submitted = null;
      const routeCampaign = mode === 'fallback' ? { ...campaign, blocks: [...campaign.blocks, ...campaign.blocks] } : campaign;
      await post('/api/klaviyo-draft', { campaign: routeCampaign, listId: 'mock-list', fromEmail: 'fixture@example.test', subject: 'Seasonal flowers', previewText: 'Seasonal flowers' });
      assert.ok(submitted, 'Must capture final serialized Klaviyo template');
      captures[mode] = submitted;
    }
    assert.equal(requests.filter(p => p === '/api/templates/').length, 4);
    return { captures, requests, campaign, alt: ALT };
  } finally {
    render.renderSlices = originalSlices;
    https.request = originalRequest;
    global.fetch = originalFetch;
    if (server.listening) await new Promise(r => server.close(r));
    await require('../../lib/db').close();
    for (const k of keys) savedEnv[k] === undefined ? delete process.env[k] : process.env[k] = savedEnv[k];
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
module.exports = { captureAssembly, ALT };
if (require.main === module) captureAssembly().then(result => {
  const out = process.argv[2];
  fs.mkdirSync(out, { recursive: true });
  for (const [name, html] of Object.entries(result.captures)) fs.writeFileSync(path.join(out, name + '.html'), html);
  fs.writeFileSync(path.join(out, 'assembly.json'), JSON.stringify(result, null, 2));
}).catch(e => { console.error(e); process.exitCode = 1; });

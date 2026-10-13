'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'carousel-test-'));
const render = require('../lib/render');
const { buildSchema } = require('../lib/parseTemplates');
const { validateCampaign } = require('../lib/validate');
const sample = require('../lib/sampleData');
const component = 'products/carousel-prototype';
const product = (title = 'Cloud vase', n = 1) => ({ title, alt: `${title}, portrait photograph`,
  image: 'https://cdn.shopify.com/s/files/1/0657/8723/2489/files/cloud-vase-icy-pink-xl-1.jpg',
  url: `https://figandbloom.com/products/cloud-vase-icy-pink-xl?utm_source=klaviyo&utm_content=card-${n}` });
const campaign = (products, extra = {}) => ({ campaignName: 'Carousel test', blocks: [
  { component, tokens: { PRODUCTS: products, ...extra } }, { component: 'footer', tokens: {} },
] });

test('draft schema and library expose an ordered product list with a six-card limit', () => {
  const def = buildSchema(render.DS).components.find(c => c.name === component);
  assert.ok(def, 'prototype component is registered');
  assert.equal(def.draft, true);
  const list = def.tokens.find(t => t.name === 'PRODUCTS');
  assert.equal(list.type, 'product-list');
  assert.equal(list.maxItems, 6);
  const c = sample.sampleCampaignFor(def);
  assert.ok(Array.isArray(c.blocks[0].tokens.PRODUCTS));
  assert.equal(validateCampaign(c, buildSchema(render.DS), { requireUnsubscribe: false }).ok, true);
});

test('production and sliced Klaviyo assembly cannot enable an unverified scrolling preview', () => {
  const c = campaign([product(), product('Glass vase', 2)], { PREVIEW_MODE: 'scroll' });
  const preview = render.assemble(c).html;
  assert.match(preview, /overflow-x:auto/);
  const exported = render.assemble(c, { production: true, shell: 'production' }).html;
  assert.doesNotMatch(exported, /overflow-x:auto/);
  const block = render.assembleBlocks(c).blocks[0];
  assert.doesNotMatch(block.html, /overflow-x:auto/);
  assert.equal(render.isHtmlOnlyComponent(component, buildSchema(render.DS).assembly.html_only_components), true);
  assert.match(block.html, /utm_content=card-1/);
  assert.match(block.html, /utm_content=card-2/);
});

test('assembly keeps one ordered copy, removes known unavailable products and escapes text', () => {
  const c = campaign([product('First <flower> & "vase"'), { ...product('Sold out', 2), available: false }, product('Last', 3)]);
  const html = render.assemble(c, { production: true, shell: 'production' }).html;
  assert.doesNotMatch(html, /Sold out/);
  assert.match(html, /First &lt;flower&gt; &amp; &quot;vase&quot;/);
  assert.equal((html.match(/data-carousel-card=/g) || []).length, 2);
  assert.ok(html.indexOf('utm_content=card-1') < html.indexOf('utm_content=card-3'));
});

test('empty, single and maximum lists export without unresolved tokens or mandatory prices', () => {
  for (const n of [0, 1, 6]) {
    const c = campaign(Array.from({ length: n }, (_, i) => product('Vase ' + i, i)));
    const result = render.assemble(c, { production: true, shell: 'production' });
    assert.deepEqual(result.unfilled, []);
    assert.equal((result.html.match(/data-carousel-card=/g) || []).length, n);
    assert.ok(Buffer.byteLength(result.html) < 80 * 1024);
    assert.equal(validateCampaign(c, buildSchema(render.DS)).ok, true);
  }
});

test('invalid lists and unsafe or off-store destinations fail validation and export assembly', () => {
  for (const products of ['not an array', Array.from({ length: 7 }, () => product()),
    [{ ...product(), url: 'javascript:alert(1)' }], [{ ...product(), url: 'https://example.com/products/vase' }],
    [{ ...product(), image: 'data:text/html,bad' }], [{ ...product(), title: '' }]]) {
    const c = campaign(products);
    assert.equal(validateCampaign(c, buildSchema(render.DS)).ok, false);
    assert.throws(() => render.assemble(c, { production: true, shell: 'production' }), /product|PRODUCTS|destination|image|title/i);
  }
});

test('optional collection link must be complete and remains outside the card region', () => {
  const c = campaign([product()], { COLLECTION_TEXT: 'Explore vases', COLLECTION_URL: 'https://figandbloom.com/collections/vases' });
  const html = render.assemble(c, { production: true }).html;
  assert.ok(html.indexOf('data-carousel-collection') > html.indexOf('<!-- carousel-region-end -->'));
  c.blocks[0].tokens.COLLECTION_URL = '';
  assert.equal(validateCampaign(c, buildSchema(render.DS)).ok, false);
});

test('real HTTP save, reopen, clone, JSON roundtrip and Klaviyo handler retain independent live links', async () => {
  const { server } = require('../server');
  const klaviyo = require('../lib/klaviyo');
  const original = klaviyo.createDraftCampaign;
  const originalUpload = klaviyo.uploadImage;
  const originalKey = process.env.KLAVIYO_API_KEY;
  const originalDb = process.env.DATABASE_URL;
  assert.ok(!originalDb, 'Use a scratch disk store for this test, not a configured production database.');
  let captured, uploads = 0;
  klaviyo.createDraftCampaign = async opts => { captured = opts.html; return { campaignId: 'test', templateId: 'test', messageId: 'test', editUrl: 'https://example.test' }; };
  klaviyo.uploadImage = async () => { uploads++; throw new Error('Live cards must not upload raster slices'); };
  process.env.KLAVIYO_API_KEY = 'test-only';
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const api = async (route, body, method = 'POST') => {
      const r = await fetch(base + route, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      return { status: r.status, data: await r.json() };
    };
    const c = campaign([product('First', 1), product('Last', 2)], { PREVIEW_MODE: 'scroll' });
    const saved = await api('/api/designs', { name: 'Carousel roundtrip', campaign: c });
    assert.equal(saved.status, 200);
    const reopened = await api('/api/designs/' + saved.data.id, null, 'GET');
    assert.deepEqual(reopened.data.campaign, JSON.parse(JSON.stringify(c)));
    const cloned = await api('/api/designs/' + saved.data.id + '/clone', {});
    assert.notEqual(cloned.data.id, saved.data.id);
    const changed = structuredClone(c);
    changed.blocks[0].tokens.PRODUCTS.reverse();
    await api('/api/designs/' + cloned.data.id, { campaign: changed }, 'PUT');
    const source = await api('/api/designs/' + saved.data.id, null, 'GET');
    assert.equal(source.data.campaign.blocks[0].tokens.PRODUCTS[0].title, 'First');
    const exported = await api('/api/export', { campaign: changed, carouselProbe: true });
    assert.equal(exported.status, 200);
    assert.ok(!exported.data.html.includes('overflow-x:auto'), 'HTTP must ignore attempts to enable the internal probe option');
    assert.ok(exported.data.html.indexOf('utm_content=card-2') < exported.data.html.indexOf('utm_content=card-1'));
    const invalid = await api('/api/export', { campaign: campaign([{ ...product(), url: 'javascript:bad' }]) });
    assert.equal(invalid.status, 422);
    const draft = await api('/api/klaviyo-draft', { campaign: c, subject: 'Test only', previewText: 'Compatibility test only' });
    assert.equal(draft.status, 200, JSON.stringify(draft.data));
    assert.equal(uploads, 0);
    assert.equal((captured.match(/data-carousel-card=/g) || []).length, 2);
    assert.ok(!captured.includes('overflow-x:auto'));
    assert.ok(captured.includes('utm_content=card-1') && captured.includes('utm_content=card-2'));
    assert.ok(captured.includes('{% unsubscribe %}'));
  } finally {
    klaviyo.createDraftCampaign = original; klaviyo.uploadImage = originalUpload;
    if (originalKey === undefined) delete process.env.KLAVIYO_API_KEY; else process.env.KLAVIYO_API_KEY = originalKey;
    await new Promise(resolve => server.close(resolve));
    await render.closeBrowser();
  }
});

after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

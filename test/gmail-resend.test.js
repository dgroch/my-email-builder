'use strict';
// Defects 1–3: Gmail-safe image crops, the Resend export target, and designId export loading.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Pick the local disk designs store and keep the test's writes in a scratch dir, before server.js
// is required (it chooses its backend at require time).
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-gmail-resend-'));
process.env.DATA_DIR = scratch;
for (const k of ['DATABASE_URL', 'NOTION_TOKEN', 'NOTION_DESIGNS_DB', 'KLAVIYO_API_KEY']) delete process.env[k];

const emailImages = require('../lib/emailImages');
const exportTargets = require('../lib/exportTargets');
const render = require('../lib/render');
const designs = require('../lib/designs');
const { validateCampaign } = require('../lib/validate');
const { buildSchema } = require('../lib/parseTemplates');
const schema = buildSchema(render.DS);

const AFTER_DARK_HERO = 'https://cdn.shopify.com/s/files/1/0657/8723/2489/files/nebula-model-4x5.jpg?v=1793579519';
const AFTER_DARK_HERO_CROPPED = AFTER_DARK_HERO + '&width=704&height=516&crop=center';
const SOURCE_928 = { width: 928, height: 1160 };

function heroTag(src, position = 'center') {
  return `<img class="fimg" src="${src}" width="600" height="440" alt="After Dark" style="display:block;width:100%;max-width:600px;height:440px;object-fit:cover;object-position:${position};">`;
}

function simpleCampaign(over = {}) {
  return {
    campaignName: 'After Dark | November capsule launch | 6 Nov 2026',
    subjectLine: 'Introducing After Dark',
    previewText: 'Our November capsule collection has arrived.',
    blocks: [
      { component: 'header', tokens: {} },
      { component: 'sections/body-copy-plain', tokens: {
        SUPER_LABEL: 'THE EDIT', HEADLINE: 'A quieter kind of drama',
        BODY_P1: 'Four bold designs, wrapped in black.', BODY_P2: '', ALIGN: 'center',
        MOBILE_ALIGN: 'inherit', TOP_RULE: 'on', PADDING_TOP: '44px',
        PADDING_BOTTOM: '44px', PADDING_X: '64px', MOBILE_PADDING_X: '24px',
      } },
      { component: 'footer', tokens: {} },
    ],
    ...over,
  };
}

// ── Defect 1: pre-cropped email images ────────────────────────────────────────────────────

test('Shopify crop replaces existing width/height/crop and preserves v=', () => {
  const result = emailImages.rewriteHtml(heroTag(AFTER_DARK_HERO_CROPPED), {
    component: 'blocks/editorial-hero', index: 1,
    sourceSizes: { [AFTER_DARK_HERO]: SOURCE_928 },
  });
  assert.equal(result.issues.length, 0);
  assert.equal((result.html.match(/[?&]width=/g) || []).length, 1, 'one width param');
  assert.equal((result.html.match(/[?&]height=/g) || []).length, 1, 'one height param');
  assert.equal((result.html.match(/[?&]crop=/g) || []).length, 1, 'one crop param');
  assert.match(result.html, /nebula-model-4x5\.jpg\?v=1793579519&width=600&height=440&crop=center/);
  assert.doesNotMatch(result.html, /object-fit|object-position/);
  assert.match(result.html, /style="[^"]*height:auto/);
  assert.match(result.html, /style="[^"]*width:100%/);
  assert.match(result.html, /style="[^"]*max-width:600px/);
  assert.match(result.html, /width="600" height="440"/, 'layout attributes stay');
});

test('crop width is capped at the source width and height follows the slot ratio', () => {
  const result = emailImages.rewriteHtml(heroTag(AFTER_DARK_HERO), {
    component: 'blocks/editorial-hero', index: 1,
    sourceSizes: { [AFTER_DARK_HERO]: { width: 400, height: 500 } },
  });
  assert.match(result.html, /width=400&height=293&crop=center/);
  assert.ok(result.issues.some((i) => i.type === 'image_source_small' && i.severity === 'warning'));
});

test('object-position maps to the four supported crop positions', () => {
  const cases = {
    center: 'center', 'center top': 'top', 'center 25%': 'top',
    'center bottom': 'bottom', left: 'left', 'right top': 'top', '75% 50%': 'right',
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(emailImages.cropPositionFromObjectPosition(input), expected, input);
  }
});

test('a non-Shopify fixed-slot image is a validation error, never a silent object-fit fallback', () => {
  const bad = 'https://brand-cdn.figandbloom.workers.dev/figandbloom/hero.jpg';
  const result = emailImages.rewriteHtml(heroTag(bad), { component: 'blocks/editorial-hero', index: 1 });
  const issue = result.issues.find((i) => i.type === 'image_crop_unsupported');
  assert.equal(issue.severity, 'error');
  assert.match(issue.message, /cdn\.shopify\.com/);
  assert.doesNotMatch(result.html, /object-fit|object-position/);
  assert.match(result.html, /height:auto/);

  const report = validateCampaign({ blocks: [{
    component: 'blocks/editorial-hero',
    tokens: {
      HERO_IMAGE_URL: bad, SUPER_LABEL: 'Notes', ACCENT_SCRIPT: 'with love,',
      HEADLINE: 'A headline', SUBHEADLINE: 'x', CTA_TEXT: 'Shop', CTA_URL: 'https://figandbloom.com',
    },
  }] }, schema, { requireUnsubscribe: false });
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((i) => i.type === 'image_crop_unsupported' && i.component === 'blocks/editorial-hero'));
});

test('assemble pre-crops the editorial hero and renders it height:auto', () => {
  const campaign = { blocks: [{
    component: 'blocks/editorial-hero',
    tokens: {
      HERO_IMAGE_URL: AFTER_DARK_HERO_CROPPED, SUPER_LABEL: 'Notes', ACCENT_SCRIPT: 'with love,',
      HEADLINE: 'A headline', SUBHEADLINE: 'x', CTA_TEXT: 'Shop', CTA_URL: 'https://figandbloom.com',
    },
  }] };
  const { html, imageIssues } = render.assemble(campaign, { assetsBase: '/a' });
  assert.equal(imageIssues.length, 0);
  assert.match(html, /nebula-model-4x5\.jpg\?v=1793579519&width=600&height=440&crop=center/);
  const img = html.match(/<img[^>]*nebula[^>]*>/i);
  assert.ok(img, 'hero image present');
  assert.doesNotMatch(img[0], /object-fit/);
  assert.match(img[0], /height:auto/);
});

test('primeHtml reads the source size and the next rewrite caps against it', async () => {
  const png = fs.readFileSync(path.join(__dirname, 'fixtures', '207-p2-photo.png')); // 560×700
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return { ok: true, headers: { get: () => String(png.length) }, arrayBuffer: async () => png };
  };
  emailImages.clearSourceSizeCache();
  try {
    const html = heroTag(AFTER_DARK_HERO);
    const primed = await emailImages.primeHtml(html, { fetchImpl: fakeFetch });
    assert.equal(primed.fetched, 1);
    assert.equal(primed.failed, 0);
    assert.equal(calls[0], AFTER_DARK_HERO, 'fetches the source URL with crop params stripped');
    const rewritten = emailImages.rewriteHtml(html);
    assert.match(rewritten.html, /width=560&height=411&crop=center/);
  } finally {
    emailImages.clearSourceSizeCache();
  }
});

test('a local/placeholder asset is exempt from the host error but still loses object-fit', () => {
  const result = emailImages.rewriteHtml(heroTag('/design-system/assets/placeholder-hero.jpg'), { component: 'blocks/caption-bar-hero', index: 0 });
  assert.equal(result.issues.filter((i) => i.severity === 'error').length, 0);
  assert.doesNotMatch(result.html, /object-fit|object-position/);
  assert.match(result.html, /height:auto/);
});

// ── Defect 2: Resend target ───────────────────────────────────────────────────────────────

test('Resend footer replaces Klaviyo tags with the provider token and literal address', () => {
  const html = '<p>No longer want these? {% unsubscribe %}.</p><p>{{ organization.name }} {{ organization.full_address }}</p>';
  const out = exportTargets.applyResendFooter(html);
  assert.match(out, /<a href="\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}">Unsubscribe<\/a>/);
  assert.ok(out.includes(exportTargets.RESEND_ADDRESS));
  assert.doesNotMatch(out, /\{%/);
  assert.doesNotMatch(out, /\{\{\s+organization|\{\{\s*organization/);
});

test('unresolved-token gate excludes {{{RESEND_UNSUBSCRIBE_URL}}} but not the double-brace form', () => {
  assert.deepEqual(exportTargets.unresolvedTokens('<a href="{{{RESEND_UNSUBSCRIBE_URL}}}">x</a>'), []);
  assert.deepEqual(exportTargets.unresolvedTokens('<a href="{{RESEND_UNSUBSCRIBE_URL}}">x</a>'), ['{{RESEND_UNSUBSCRIBE_URL}}']);
  assert.deepEqual(exportTargets.unresolvedTokens('{{HEADLINE}} {{{RESEND_UNSUBSCRIBE_URL}}}'), ['{{HEADLINE}}']);
});

test('resend validation accepts the provider tag while klaviyo validation does not', () => {
  assert.equal(exportTargets.hasUnsubscribe('{{{RESEND_UNSUBSCRIBE_URL}}}', 'resend'), true);
  assert.equal(exportTargets.hasUnsubscribe('{{{RESEND_UNSUBSCRIBE_URL}}}', 'klaviyo'), false);
  assert.equal(exportTargets.hasUnsubscribe('{% unsubscribe %}', 'klaviyo'), true);
  assert.equal(exportTargets.hasUnsubscribe('{% unsubscribe %}', 'resend'), true);
});

// ── Defect 3 + HTTP contract ──────────────────────────────────────────────────────────────

let server;
let origin;
test('start the local builder', async () => {
  ({ server } = require('../server'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = 'http://127.0.0.1:' + server.address().port;
});

async function post(body) {
  const res = await fetch(origin + '/api/export', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('resend export: provider footer, subject-line title, preheader, no comments', async () => {
  const campaign = simpleCampaign({ previewText: undefined, subjectLine: 'Introducing After Dark' });
  const { status, body } = await post({ campaign, previewText: 'Our November capsule collection has arrived.', target: 'resend' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.match(body.html, /<title>Introducing After Dark<\/title>/);
  assert.ok(body.html.includes('Our November capsule collection has arrived.'));
  assert.match(body.html, /<div style="display:none;font-size:1px;/);
  assert.match(body.html, /<a href="\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}">Unsubscribe<\/a>/);
  assert.ok(body.html.includes(exportTargets.RESEND_ADDRESS));
  assert.doesNotMatch(body.html, /\{%/);
  assert.doesNotMatch(body.html, /\{\{\s/);
  assert.doesNotMatch(body.html, /<!--\s*COMPONENT:/);
  assert.equal(body.target, 'resend');
});

test('default (klaviyo) export is unchanged: Klaviyo tags, campaign-name title, comments kept', async () => {
  const campaign = simpleCampaign();
  const legacy = await post({ campaign, previewText: 'Our November capsule collection has arrived.' });
  const explicit = await post({ campaign, previewText: 'Our November capsule collection has arrived.', target: 'klaviyo' });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
  assert.equal(explicit.status, 200, JSON.stringify(explicit.body));
  assert.equal(legacy.body.html, explicit.body.html, 'omitting target is exactly target=klaviyo');
  assert.match(legacy.body.html, /<title>After Dark \| November capsule launch \| 6 Nov 2026<\/title>/);
  assert.ok(legacy.body.html.includes('{% unsubscribe %}'));
  assert.ok(legacy.body.html.includes('{{ organization.name }} {{ organization.full_address }}'));
  assert.doesNotMatch(legacy.body.html, /RESEND_UNSUBSCRIBE_URL/);
  assert.match(legacy.body.html, /<!--\s*COMPONENT:/);
});

test('the disk store accepts UUID-shaped design ids but still rejects traversal', () => {
  const id = '410fdc24-425f-8156-b52b-c378be664a40';
  fs.writeFileSync(path.join(scratch, id + '.json'), JSON.stringify({
    id, name: 'UUID fixture', createdAt: '2026-11-06', updatedAt: '2026-11-07', campaign: simpleCampaign(),
  }));
  const loaded = designs.get(id);
  assert.ok(loaded);
  assert.equal(loaded.id, id);
  assert.equal(designs.get('../escape'), null);
  assert.equal(designs.get('a/b'), null);
});

test('{"designId":"…"} exports the saved design and picks up its subject/preview', async () => {
  const design = await designs.create({
    name: 'Resend design', subjectLine: 'Design subject line',
    previewText: 'Design preview line',
    campaign: simpleCampaign({ campaignName: 'Campaign name only' }),
  });
  const resend = await post({ designId: design.id, target: 'resend' });
  assert.equal(resend.status, 200, JSON.stringify(resend.body));
  assert.match(resend.body.html, /<title>Design subject line<\/title>/);
  assert.ok(resend.body.html.includes('Design preview line'));
  assert.ok(resend.body.html.includes('{{{RESEND_UNSUBSCRIBE_URL}}}'));

  const klaviyo = await post({ designId: design.id });
  assert.equal(klaviyo.status, 200, JSON.stringify(klaviyo.body));
  assert.match(klaviyo.body.html, /<title>Campaign name only<\/title>/);
  assert.ok(klaviyo.body.html.includes('{% unsubscribe %}'));
});

test('empty campaign / missing body returns 400, and empty campaigns never validate ok', async () => {
  for (const body of [{}, { campaign: {} }, { campaign: { blocks: [] } }, { designId: 'does-not-exist' }]) {
    const { status, body: payload } = await post(body);
    assert.equal(status, 400, JSON.stringify(body));
    assert.match(payload.error, /No campaign blocks to export/);
  }
  assert.equal(validateCampaign({}, schema).ok, false);
  assert.equal(validateCampaign({ blocks: [] }, schema).ok, false);
  assert.ok(validateCampaign({ blocks: [] }, schema).issues.some((i) => i.type === 'empty_campaign'));
});

after(async () => {
  await require('../lib/db').close();
  if (server && server.listening) await new Promise((r) => server.close(r));
  fs.rmSync(scratch, { recursive: true, force: true });
});

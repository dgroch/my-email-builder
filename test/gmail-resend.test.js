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
const sampleData = require('../lib/sampleData');
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
  assert.equal((result.html.match(/&amp;width=/g) || []).length, 1, 'one width param');
  assert.equal((result.html.match(/&amp;height=/g) || []).length, 1, 'one height param');
  assert.equal((result.html.match(/&amp;crop=/g) || []).length, 1, 'one crop param');
  assert.match(result.html, /nebula-model-4x5\.jpg\?v=1793579519&amp;width=600&amp;height=440&amp;crop=center/);
  assert.doesNotMatch(result.html, /src="[^"]*[^a]&width=/, 'src attributes must not carry a raw ampersand');
  assert.doesNotMatch(result.html, /object-fit|object-position/);
  assert.match(result.html, /style="[^"]*height:auto/);
  assert.match(result.html, /style="[^"]*width:100%/);
  assert.match(result.html, /style="[^"]*min-width:100%/);
  assert.match(result.html, /style="[^"]*max-width:600px/);
  assert.match(result.html, /width="600" height="440"/, 'layout attributes stay');
});

test('crop width is capped at the source width and height follows the slot ratio', () => {
  const result = emailImages.rewriteHtml(heroTag(AFTER_DARK_HERO), {
    component: 'blocks/editorial-hero', index: 1,
    sourceSizes: { [AFTER_DARK_HERO]: { width: 400, height: 500 } },
  });
  assert.match(result.html, /&amp;width=400&amp;height=293&amp;crop=center/);
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
  assert.match(html, /nebula-model-4x5\.jpg\?v=1793579519&amp;width=600&amp;height=440&amp;crop=center/);
  const img = html.match(/<img[^>]*nebula[^>]*>/i);
  assert.ok(img, 'hero image present');
  assert.doesNotMatch(img[0], /object-fit/);
  assert.match(img[0], /height:auto/);
  assert.match(img[0], /min-width:100%/);
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
    assert.match(rewritten.html, /&amp;width=560&amp;height=411&amp;crop=center/);
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

test('fluid fixed-slot images keep max-width:100% and request the email-column width', () => {
  const story = `<img class="st-img" src="${AFTER_DARK_HERO}" width="240" height="300" alt="Story" style="display:block;width:240px;height:300px;object-fit:cover;object-position:center;">`;
  const result = emailImages.rewriteHtml(story, {
    component: 'blocks/story', index: 1, sourceSizes: { [AFTER_DARK_HERO]: SOURCE_928 },
  });
  assert.equal(result.issues.length, 0);
  assert.match(result.html, /max-width:100%/);
  assert.doesNotMatch(result.html, /max-width:240px/);
  assert.match(result.html, /&amp;width=600&amp;height=750&amp;crop=center/, 'requests the 600px column, not the 240px slot');
  assert.equal(result.images[0].fluid, true);
  assert.equal(result.images[0].columnCeiling, 600);
});

test('card-horizontal requests the larger fluid ceiling but keeps a fixed image at its slot', () => {
  const card = `<img src="${AFTER_DARK_HERO}" width="280" height="350" alt="Card" style="display:block;width:280px;height:350px;object-fit:cover;object-position:center top;">`;
  const fluid = emailImages.rewriteHtml(card, {
    component: 'products/card-horizontal', sourceSizes: { [AFTER_DARK_HERO]: SOURCE_928 },
  });
  assert.match(fluid.html, /max-width:100%/);
  assert.match(fluid.html, /&amp;width=600&amp;height=750&amp;crop=top/);

  const fixed = emailImages.rewriteHtml(
    `<img src="${AFTER_DARK_HERO}" width="340" height="425" alt="Testimonial" style="display:block;width:340px;height:425px;object-fit:cover;object-position:center top;">`,
    { component: 'products/card-single-testimonial', sourceSizes: { [AFTER_DARK_HERO]: SOURCE_928 } },
  );
  assert.match(fixed.html, /max-width:340px/);
  assert.match(fixed.html, /&amp;width=340&amp;height=425&amp;crop=top/);
});

test('src escaping never doubles an existing entity and always emits crop params as &amp;', () => {
  assert.equal(emailImages.escapeAmpersands('https://x.test/a?b=1&c=2'), 'https://x.test/a?b=1&amp;c=2');
  assert.equal(emailImages.escapeAmpersands('https://x.test/a?b=1&amp;c=2'), 'https://x.test/a?b=1&amp;c=2');
  assert.equal(emailImages.escapeAmpersands('https://x.test/a?b=1&#38;c=2'), 'https://x.test/a?b=1&#38;c=2');
});

test('editorial-hero omits the accent illo when the lever is off and keeps it visible inline when on', () => {
  const def = schema.components.find((c) => c.name === 'blocks/editorial-hero');
  const campaign = sampleData.sampleCampaignFor(def);
  campaign.blocks[0].tokens.ACCENT_ILLO = 'off';
  const off = render.assemble(campaign, { assetsBase: '/a', shell: 'production', production: true }).html;
  assert.doesNotMatch(off, /eh-illo|HandFlower/, 'illo-off must not emit a stylesheet-hidden watermark');
  assert.doesNotMatch(off, /\.eh \.eh-illo/);
  campaign.blocks[0].tokens.ACCENT_ILLO = 'on';
  const on = render.assemble(campaign, { assetsBase: '/a', shell: 'production', production: true }).html;
  assert.match(on, /class="eh-illo"[^>]*style="[^"]*display:block/);
  assert.match(on, /HandFlower_Black\.png/);
});

test('card-feature uses a percentage image cell and an image that cannot exceed it', () => {
  const def = schema.components.find((c) => c.name === 'products/card-feature');
  const html = render.assemble(sampleData.sampleCampaignFor(def), { assetsBase: '/a', shell: 'production', production: true }).html;
  assert.match(html, /<td class="cf-img" width="46\.6667%" valign="middle" style="width:46\.6667%;padding:0;vertical-align:middle;">/);
  assert.match(html, /<img[^>]*style="display:block;width:100%;min-width:100%;max-width:100%;height:auto;border:0;"/);
  assert.doesNotMatch(html, /\.cf-img\{width:44%/, 'the column width must not depend on a media query');
});

test('card-horizontal drops the fixed 240px clip and lets the image own the cell height', () => {
  for (const shellName of ['shell-preview.html', 'shell-production.html']) {
    const shell = fs.readFileSync(path.join(render.DS, 'shell', shellName), 'utf8');
    const mediaStart = shell.indexOf('@media only screen and (max-width:600px)');
    const media = mediaStart < 0 ? '' : shell.slice(mediaStart, shell.indexOf('</style>', mediaStart));
    assert.doesNotMatch(media, /\.hi\{[^}]*height:\s*240px/, `${shellName} must not clip the card image at 240px`);
    assert.match(media, /\.hi\{[^}]*height:\s*auto/, `${shellName} follows the image height`);
  }
  for (const card of ['card-horizontal.html', 'card-horizontal-reversed.html']) {
    const cardHtml = fs.readFileSync(path.join(render.DS, 'templates', 'products', card), 'utf8');
    assert.match(cardHtml, /<td class="hi" width="47%" valign="top" style="width:47%;height:auto;padding:0;vertical-align:top;">/);
    assert.doesNotMatch(cardHtml, /<td class="hi"[^>]*(?:height:350px|overflow:hidden)/);
  }
});

test('production shell is fluid without its stylesheet and keeps a 600px Word ghost', () => {
  const def = schema.components.find((c) => c.name === 'blocks/editorial-hero');
  const html = render.assemble(sampleData.sampleCampaignFor(def), { assetsBase: '/a', shell: 'production', production: true }).html;
  assert.match(html, /<table class="ew" width="100%"[^>]*style="width:100%;max-width:600px;/);
  assert.match(html, /<!--\[if mso\]>[\s\S]*?<table\b[^>]*width="600"/);
  const f600 = [...html.matchAll(/<table\b[^>]*class="[^"]*\bf600\b[^"]*"[^>]*>/g)].map((m) => m[0]);
  assert.ok(f600.length > 0, 'the hero table is opted in');
  assert.ok(f600.every((tag) => /width="100%"/.test(tag)), 'every f600 table is percentage-wide in production');
});

test('body-copy-plain keeps a 440px desktop measure that shrinks without its stylesheet', () => {
  const def = schema.components.find((c) => c.name === 'sections/body-copy-plain');
  const html = render.assemble(sampleData.sampleCampaignFor(def), { assetsBase: '/a', shell: 'production', production: true }).html;
  assert.match(html, /<table width="100%" class="fm"[^>]*style="width:100%;max-width:440px;margin:0 auto;"/);
  assert.match(html, /<!--\[if mso\]>[\s\S]*?<table\b[^>]*width="440"/);
});

test('the guard flags surviving object-fit declarations but ignores comments', () => {
  assert.deepEqual(emailImages.objectFitIssues('<!-- <img style="object-fit:cover"> -->'), []);
  assert.deepEqual(emailImages.objectFitIssues('<style>/* object-fit:cover is only a note */</style>'), []);
  const issues = emailImages.objectFitIssues('<style>.eg .eg-grid img { display:block; object-fit: cover; }</style>');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, 'object_fit_remaining');
  assert.equal(issues[0].severity, 'warning');
  assert.match(issues[0].message, /1 object-fit declaration/);
});

test('event-gallery CSS object-fit now produces an object_fit_remaining validation warning', () => {
  const def = schema.components.find((c) => c.name === 'blocks/event-gallery');
  assert.ok(def, 'event-gallery exists');
  const report = validateCampaign(sampleData.sampleCampaignFor(def), schema, { requireUnsubscribe: false });
  assert.equal(report.ok, true, 'a designed block is not rejected outright');
  assert.ok(report.issues.some((i) => i.type === 'object_fit_remaining' && i.severity === 'warning'));
});

test('readSourceSize refuses a redirect instead of following it off cdn.shopify.com', async () => {
  const fakeFetch = async () => ({
    ok: false, status: 302, url: AFTER_DARK_HERO,
    headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0),
  });
  await assert.rejects(
    () => emailImages.readSourceSize(AFTER_DARK_HERO, { fetchImpl: fakeFetch }),
    /refusing redirect/i,
  );
});

test('render and exportTargets share one PROVIDER_TOKENS set', () => {
  assert.equal(exportTargets.PROVIDER_TOKENS, render.PROVIDER_TOKENS);
  assert.deepEqual([...render.PROVIDER_TOKENS], ['RESEND_UNSUBSCRIBE_URL']);
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

test('leftover-Klaviyo-tag gate names Liquid block and lowercase merge tags, not the Resend token', () => {
  assert.deepEqual(exportTargets.leftoverKlaviyoTags('<a href="{{{RESEND_UNSUBSCRIBE_URL}}}">x</a>'), []);
  assert.deepEqual(
    exportTargets.leftoverKlaviyoTags('{% if person.first_name %}Hi{% endif %}'),
    ['{% if person.first_name %}', '{% endif %}'],
  );
  assert.deepEqual(exportTargets.leftoverKlaviyoTags('<p>{{ first_name }}</p>'), ['{{ first_name }}']);
  assert.deepEqual(exportTargets.leftoverKlaviyoTags('<p>{{first_name}}</p>'), ['{{first_name}}']);
  assert.deepEqual(exportTargets.leftoverKlaviyoTags('<p>{{ organization.name }}</p>'), ['{{ organization.name }}']);
  assert.deepEqual(exportTargets.leftoverKlaviyoTags('<p>{{ first_name'), ['{{ first_name'], 'unclosed spaced tag');
});

test('keepConditionals preserves downlevel-revealed fallbacks and still strips developer comments', () => {
  const raw = '<!-- COMPONENT: sections/button -->'
    + '<!--[if gte mso 9]><v:roundrect/><![endif]-->'
    + '<!--[if !gte mso 9]><!--><a href="#">x</a><!--<![endif]-->';

  const resend = render.stripDocComments(raw, { keepConditionals: true });
  assert.doesNotMatch(resend, /COMPONENT/);
  assert.match(resend, /<!--\[if gte mso 9\]><v:roundrect\/><!\[endif\]-->/);
  assert.match(resend, /<!--\[if !gte mso 9\]><!--><a href="#">x<\/a><!--<!\[endif\]-->/);

  // The default Klaviyo push / Outlook-scanner behaviour is unchanged.
  const klaviyo = render.stripDocComments(raw);
  assert.doesNotMatch(klaviyo, /COMPONENT/);
  assert.match(klaviyo, /<!--\[if gte mso 9\]>/);
  assert.doesNotMatch(klaviyo, /\[if !gte mso 9\]/);
  assert.doesNotMatch(klaviyo, /<!--<!\[endif\]-->/);
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

test('resend export 422s on Liquid preview text and lowercase body tags instead of leaking them', async () => {
  const liquid = await post({
    campaign: simpleCampaign(),
    previewText: '{% if person.first_name %}Hi{% endif %} plain preview',
    target: 'resend',
  });
  assert.equal(liquid.status, 422, JSON.stringify(liquid.body));
  assert.equal(liquid.body.code, 'UNRESOLVED_KLAVIYO_TAGS');
  assert.ok(liquid.body.unresolved.includes('{% if person.first_name %}'));
  assert.ok(liquid.body.unresolved.includes('{% endif %}'));

  const bodyCampaign = simpleCampaign();
  bodyCampaign.blocks.find((b) => b.component === 'sections/body-copy-plain').tokens.BODY_P1 =
    'Hi {{ first_name }}, the capsule is here.';
  const lower = await post({ campaign: bodyCampaign, previewText: 'Plain preview', target: 'resend' });
  assert.equal(lower.status, 422, JSON.stringify(lower.body));
  assert.equal(lower.body.code, 'UNRESOLVED_KLAVIYO_TAGS');
  assert.ok(lower.body.unresolved.includes('{{ first_name }}'));

  // Plain preview text still exports, and the result carries no Klaviyo syntax.
  const plain = await post({ campaign: simpleCampaign(), previewText: 'After Dark is here.', target: 'resend' });
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  assert.doesNotMatch(plain.body.html, /\{%|(?<!\{)\{\{(?!\{)/);
  assert.ok(plain.body.html.includes('After Dark is here.'));
});

test('resend export keeps the downlevel-revealed MSO fallback around a button CTA', async () => {
  const buttonDef = schema.components.find((c) => c.name === 'sections/button');
  const buttonBlock = sampleData.sampleCampaignFor(buttonDef).blocks[0];
  const campaign = simpleCampaign({ blocks: [
    { component: 'header', tokens: {} },
    buttonBlock,
    { component: 'footer', tokens: {} },
  ] });

  const { status, body } = await post({ campaign, previewText: 'Plain preview', target: 'resend' });
  assert.equal(status, 200, JSON.stringify(body));
  // The production shell has one `<!--[if !mso]><!-->` … `<!--<![endif]-->` pair around its
  // font block, so the button's pair brings the document to two of each.
  assert.equal((body.html.match(/<!--\[if !gte mso 9\]><!-->/g) || []).length, 1, 'one button downlevel opener');
  assert.equal(
    (body.html.match(/<!--\[if [^\]]*\]><!-->/g) || []).length,
    (body.html.match(/<!--<!\[endif\]-->/g) || []).length,
    'every downlevel opener has its closer',
  );
  assert.equal((body.html.match(/<v:roundrect/g) || []).length, 1, 'the VML button is still present');
  const fallback = body.html.match(/<!--\[if !gte mso 9\]><!-->[\s\S]*?<!--<!\[endif\]-->/);
  assert.ok(fallback && /<a\b[^>]*>[\s\S]*?<\/a>/.test(fallback[0]), 'fallback anchor sits inside the conditional');
  assert.doesNotMatch(body.html, /<!--\s*COMPONENT:/);

  // The Klaviyo/default path is untouched: no developer-comment strip at all, so its raw
  // conditionals are still there (see the unit test above for the default strip behaviour).
  const klaviyo = await post({ campaign, previewText: 'Plain preview' });
  assert.equal(klaviyo.status, 200, JSON.stringify(klaviyo.body));
  assert.equal((klaviyo.body.html.match(/<!--\[if !gte mso 9\]><!-->/g) || []).length, 1);
  assert.equal((klaviyo.body.html.match(/<v:roundrect/g) || []).length, 1);
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

test('a body campaign + designId still borrows saved subject/preview on the resend path', async () => {
  const design = await designs.create({
    name: 'Metadata design', subjectLine: 'Saved subject line',
    previewText: 'Saved preview line',
    campaign: simpleCampaign({ campaignName: 'Stored campaign name' }),
  });
  const bodyCampaign = simpleCampaign({ campaignName: 'Body campaign name', subjectLine: undefined, previewText: undefined });
  const resend = await post({ campaign: bodyCampaign, designId: design.id, target: 'resend' });
  assert.equal(resend.status, 200, JSON.stringify(resend.body));
  assert.match(resend.body.html, /<title>Saved subject line<\/title>/);
  assert.ok(resend.body.html.includes('Saved preview line'));
  assert.ok(resend.body.html.includes('{{{RESEND_UNSUBSCRIBE_URL}}}'));
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

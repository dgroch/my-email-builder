'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { Parser } = require('htmlparser2');
const { capturePush, fixture } = require('./helpers/g-o-assembly');
let captured;
before(async () => { captured = await capturePush(); assert.equal(captured.response.status, 200, JSON.stringify(captured.response)); });
function inspect(html) {
  const images = []; let text = '', hidden = 0;
  new Parser({
    onopentag(name, attrs) { if (name === 'img') images.push(attrs); if (['style', 'script'].includes(name)) hidden++; },
    onclosetag(name) { if (['style', 'script'].includes(name)) hidden--; else text += ' '; },
    ontext(value) { if (!hidden) text += value; },
  }).end(html);
  return { images, text };
}
test('G-O a: captured template keeps exact greeting and story/testimonial as live text', () => {
  assert.ok(captured.html.includes('Hi {{ first_name|default:"there" }},'));
  const { text } = inspect(captured.html);
  for (const component of ['blocks/story', 'sections/testimonial']) {
    assert.ok(!captured.rasterized.includes(component), `${component} must not enter rasterisation`);
    const tokens = fixture.campaign.blocks.find(b => b.component === component).tokens;
    for (const key of component === 'blocks/story' ? ['BODY_P1', 'BODY_P2'] : ['REVIEW_TEXT', 'REVIEWER_NAME']) assert.ok(text.includes(tokens[key]), key);
  }
});
test('G-O b: captured testimonial names Joseph without a dash prefix', () => {
  const text = inspect(captured.html).text;
  assert.match(text, /Joseph/);
  assert.doesNotMatch(text, /[—–-]\s+Joseph/);
  assert.match(captured.html, /<cite\b[^>]*>Joseph<\/cite>/);
});
test('G-O c: every image has alt; slices/content have non-empty alt; only locked decorations may be empty; IMAGE_ALT preserved', () => {
  const { images } = inspect(captured.html);
  assert.ok(images.length > 0);
  // Exact design-system URLs only: a content/upload URL with the same filename
  // cannot qualify. These two locked illustrations are documented in templates.
  const decorativeAssets = new Set([
    'https://cdn.example.com/HandRose_White.png',
    'https://cdn.example.com/BodyFlower_White_wide.png',
  ]);
  const sliceUrls = new Set(captured.uploads.map(upload => upload.url));
  for (const img of images) {
    assert.ok(Object.hasOwn(img, 'alt'), `Missing alt attribute: ${img.src}`);
    if (sliceUrls.has(img.src) || !decorativeAssets.has(img.src)) {
      assert.ok(img.alt.trim(), `Empty content/slice alt: ${img.src}`);
    } else {
      assert.ok(img.alt === '' || img.alt.trim(), `Whitespace-only alt: ${img.src}`);
    }
  }
  assert.ok(!images.some(img => /Face2_Black/.test(img.src)), 'Face2 is a CSS decoration, never an img');
  const block = fixture.campaign.blocks.find(b => b.component === 'products/card-feature');
  assert.ok(images.some(img => img.alt === block.tokens.IMAGE_ALT));
});
test('G-O d: merge tag in image-bound source refuses before any Klaviyo request', async () => {
  const campaign = structuredClone(fixture.campaign);
  campaign.blocks.find(b => b.component === 'blocks/editorial-hero').tokens.HEADLINE = 'Hello {{ first_name|default:"there" }}';
  const result = await capturePush(campaign);
  assert.equal(result.response.status, 422);
  assert.equal(result.response.body.code, 'MERGE_TAG_IN_IMAGE_SLICE');
  assert.match(result.response.body.error, /blocks\/editorial-hero.*merge tag/);
  assert.deepEqual(result.requests, []);
  assert.deepEqual(result.rasterized, []);
});
test('G-O e: real rasterizer excludes live block indexes from screenshots', async () => {
  const render = require('../lib/render');
  const html = '<html><body><table><tbody data-eb-block="0" data-eb-component="blocks/story"><tr><td style="width:600px;height:80px">Live story</td></tr></tbody><tbody data-eb-block="1" data-eb-component="blocks/editorial-hero"><tr><td style="width:600px;height:80px">Image copy</td></tr></tbody></table></body></html>';
  try {
    const { slices } = await render.renderSlices(html, { scale: 1, skipIndexes: [0], frozenResources: true });
    assert.deepEqual(slices.map(s => s.index), [1]);
    assert.ok(slices[0].buffer.length > 0);
  } finally { await render.closeBrowser(); }
});

// R3 regressions intentionally use public entry points so they also run on 9da60db5.
const fs = require('node:fs');
const path = require('node:path');
const render = require('../lib/render');
const assembly = require('../lib/publishAssembly');
const outlook = html => html
  .replace(/<!--\[if !mso\]><!-->[\s\S]*?<!--<!\[endif\]-->/gi, '')
  .replace(/<!--\[if (?:mso|gte mso 9)\]>([\s\S]*?)<!\[endif\]-->/gi, '$1');
function assertFaceHidden(html, frozen = false) {
  assert.doesNotMatch(html, /<img\b[^>]*Face2_Black/);
  assert.match(html, /background-image:linear-gradient\(rgba\(235,229,223,0\.89\),rgba\(235,229,223,0\.89\)\),url\(/);
  assert.doesNotMatch(html, /\sbackground\s*=/);
  if (!frozen) assert.match(html, /<style>\.testimonial-face2\{background-image:linear-gradient/);
}
function savedDesign() {
  return { id: 'send8-r3', updatedAt: '2026-11-12T00:00:00Z', name: 'Send 8',
    subjectLine: fixture.campaign.subjectLine, previewText: fixture.campaign.previewText,
    campaign: structuredClone(fixture.campaign) };
}
async function freeze(design = savedDesign()) {
  const png = await require('sharp')({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer();
  return assembly.freezeSavedDesign(design, { loadImage: async () => png });
}
test('R3 1: Face2 background survives captured push, comment stripper and export inliner', () => {
  assertFaceHidden(captured.html);
  const html = render.assembleBlocks(fixture.campaign).blocks.find(b => b.component === 'sections/testimonial').html;
  assertFaceHidden(render.stripDocComments(html));
  assertFaceHidden(assembly.inlineStyleElements(render.stripDocComments(html)), true);
  assert.match(render.applyOutlookDegradation(captured.html), /background-image: none !important/);
});
test('R3 2: manifest controls story/testimonial publication and honest Outlook risk', () => {
  const list = require('../design-system/manifest.json').assembly.html_only_components;
  for (const name of ['story', 'testimonial']) assert.ok(list.includes(name), name);
  const risks = render.outlookRisks(fixture.campaign);
  for (const component of ['blocks/story', 'sections/testimonial']) {
    const risk = risks.find(r => r.component === component);
    assert.ok(risk, component);
    assert.equal(risk.rasterisedOnPublish, false);
    assert.equal(risk.atRisk, true);
  }
  const testimonial = risks.find(r => r.component === 'sections/testimonial');
  assert.ok(!testimonial.unsupported.some(r => ['position:absolute', 'opacity'].includes(r.property)));
  assert.ok(testimonial.unsupported.some(r => r.property === 'max-width'));
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.doesNotMatch(source, /htmlOnly\s*=.*['"]story['"].*['"]testimonial['"]/);
});
for (const [label, value] of [
  ['control', '{% if first_name %}Hi {{ first_name }}{% endif %}'],
  ['comment', '{# x #}'],
  ['numeric', '&#123;&#123; first_name &#125;&#125;'],
  ['named', '&lbrace;&lbrace; x &rbrace;&rbrace;'],
  ['hex', '&#X7B;&#x7b; first_name &#125;&#125;'],
  ['percent', '&lcub;&percnt; if first_name %}Hi{% endif %}'],
  ['numeric-percent', '&#123;&#37; if first_name %}Hi{% endif %}'],
]) test(`R3 3 ${label}: image merge tags refuse before rendering or HTTPS`, async () => {
  const campaign = structuredClone(fixture.campaign);
  campaign.blocks.find(b => b.component === 'blocks/editorial-hero').tokens.HEADLINE = value;
  const result = await capturePush(campaign);
  assert.equal(result.response.status, 422);
  assert.equal(result.response.body.code, 'MERGE_TAG_IN_IMAGE_SLICE');
  assert.deepEqual(result.requests, []);
  assert.deepEqual(result.rasterized, []);
  assert.equal(result.html, undefined);
});
test('R3 4: missing builder SUBHEADLINE has its own actionable error', async () => {
  const campaign = structuredClone(fixture.campaign);
  delete campaign.blocks.find(b => b.component === 'blocks/editorial-hero').tokens.SUBHEADLINE;
  const result = await capturePush(campaign);
  assert.equal(result.response.status, 422);
  assert.equal(result.response.body.code, 'UNRESOLVED_TOKENS');
  assert.deepEqual(result.response.body.tokens, ['SUBHEADLINE']);
  assert.match(result.response.body.error, /Supply.*token values/);
  assert.deepEqual(result.requests, []);
});
test('R3 5: reviewer samples have no leading dash', () => {
  const schema = require('../lib/parseTemplates').buildSchema(render.DS);
  for (const component of ['products/card-single-testimonial', 'sections/testimonial']) {
    const sample = require('../lib/sampleData').sampleCampaignFor(schema.components.find(c => c.name === component));
    assert.equal(sample.blocks[0].tokens.REVIEWER_NAME, 'Sarah, Brisbane');
  }
});
test('R3 6: freeze send 8 preserves exact live greeting; image-bound merge still rejects', async () => {
  const frozen = await freeze();
  assert.ok(frozen.rendered.blocks.some(b => b.live && b.html.includes('Hi {{ first_name|default:"there" }},')));
  assertFaceHidden(frozen.rendered.blocks.find(b => b.component === 'sections/testimonial').html, true);
  const design = savedDesign();
  design.campaign.blocks.find(b => b.component === 'blocks/editorial-hero').tokens.HEADLINE = '{# x #}';
  await assert.rejects(freeze(design), /Unsupported dynamic template/);
});
test('R3 1 publication: frozen artifact preserves greeting and fails closed on live CSS assets', async () => {
  const design = savedDesign();
  // Isolate publication of testimonial and greeting from the existing engine
  // restriction on story's CSS background asset. R3 6 freezes the exact fixture.
  const story = design.campaign.blocks.find(b => b.component === 'blocks/story');
  design.campaign.blocks = design.campaign.blocks.filter(b => b !== story);
  design.campaign.blocks.find(b => b.component === 'sections/body-copy-plain').tokens.BODY_P1 = story.tokens.BODY_P1;
  const frozen = await freeze(design);
  const original = render.renderSlices;
  const png = await require('sharp')({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer();
  render.renderSlices = async () => ({ slices: frozen.rendered.blocks.filter(b => !b.live && !b.footer).map(b => ({ index: b.index, buffer: png, width: 600, height: 2, kind: 'png' })), brokenImages: [] });
  try {
    assert.ok(frozen.rendered.blocks.some(b => b.live && b.html.includes('Hi {{ first_name|default:"there" }},')));
    // Face2 now shares story's existing CSS asset export limitation. Fail closed.
    await assert.rejects(assembly.renderFrozenArtifact(frozen), /LIVE_CSS_ASSET_UNSUPPORTED/);
  } finally { render.renderSlices = original; }
});
test('R3 minor: capture restores environment', async () => {
  const before = { ...process.env };
  await capturePush();
  for (const key of new Set([...Object.keys(before), ...Object.keys(process.env)])) {
    assert.ok(process.env[key] === before[key], `${key} must be restored`);
  }
});

for (const variant of ['normal', 'gmail', 'gmail-nobg']) test(`R4 render ${variant}: testimonial preserves desktop and mobile height in isolated and full send 8`, async () => {
  const { gmailSimulation, measure, localFace } = require('./helpers/g-o-client-render');
  const browser = await require('puppeteer').launch({ headless: 'new', executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', r => r.url().startsWith('data:') ? r.continue() : r.abort());
    const isolated = render.assemble({ blocks: fixture.campaign.blocks.filter(b => b.component === 'sections/testimonial') }, { assetsBase: 'https://cdn.example.com' }).html;
    for (const source of [isolated, captured.html]) {
      const simulated = variant === 'normal' ? source : gmailSimulation(source, variant === 'gmail-nobg');
      if (variant !== 'normal') assert.doesNotMatch(simulated, /(?<![\w-])(?:position|top|right|bottom|left|z-index)\s*:/i);
      const html = localFace(simulated);
      for (const width of [600, 390]) {
        const result = await measure(page, html, width);
        assert.ok(Math.abs(result.height - (width === 600 ? 192 : 217)) <= 1, `${variant} ${width}: ${result.height}px`);
        assert.equal(result.faceImages, 0);
        if (variant === 'gmail-nobg') assert.equal(result.backgroundImage, 'none');
        else {
          assert.match(result.backgroundImage, /^linear-gradient\(.*\), url\(/);
          assert.match(result.backgroundRepeat, /^no-repeat/);
          assert.match(result.backgroundPosition, /100% \+ 16px.*100% \+ 20px/);
          assert.equal(result.backgroundSize, '100% 100%, auto 200px');
          assert.match(result.backgroundPosition, /^0px 0px, /); // Overlay covers every pixel of the cell.
        }
      }
    }
    // An unsupported gradient invalidates the complete list, never retaining URL alone.
    await page.setContent('<table><tr><td style="background:#EBE5DF;background-image:unsupported-gradient(red,red),url(data:image/png;base64,AA);">x</td></tr></table>');
    assert.equal(await page.$eval('td', e => getComputedStyle(e).backgroundImage), 'none');
  } finally { await browser.close(); }
});
for (const component of ['sections/testimonial', 'blocks/story']) test(`R4 outlookRisks: detects background image in ${component}`, () => {
  const risk = render.outlookRisks(fixture.campaign).find(r => r.component === component);
  assert.equal(risk.atRisk, true);
  assert.equal(risk.rasterisedOnPublish, false);
  assert.ok(risk.unsupported.some(r => r.property === 'background-image'), component);
});

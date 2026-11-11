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
  // cannot qualify. These three locked illustrations are documented in templates.
  const decorativeAssets = new Set([
    'https://cdn.example.com/Face2_Black.png',
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
  assert.ok(images.some(img => img.src === 'https://cdn.example.com/Face2_Black.png' && img.alt === ''), 'Face2 keeps its decorative empty alt');
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

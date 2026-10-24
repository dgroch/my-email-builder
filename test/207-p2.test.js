'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eb207-p2-test-'));
const render = require('../lib/render');
const schema = require('../lib/parseTemplates').buildSchema(render.DS);
const sample = require('../lib/sampleData');
const manifest = require('../design-system/manifest.json');
const validate = c => require('../lib/validate').validateCampaign(c, schema, { requireUnsubscribe: false });
const campaign = name => {
  const def = schema.components.find(c => c.name === name);
  assert.ok(def, `${name} exists`);
  return sample.sampleCampaignFor(def);
};
const block = c => render.stripDocComments(render.assembleBlocks(c).blocks[0].html);
const both = c => [block(c), render.stripDocComments(render.assemble(c).html)];

test('1: feature card links, independent alt, side lever, optional rows/button and validation', () => {
  const c = campaign('products/card-feature'), t = c.blocks[0].tokens;
  Object.assign(t, { IMAGE_ALT: 'Pink flowers in a vase', TITLE: 'A colourful table', SUPER_LABEL: '', BODY_P2: '', LINK_LABEL: 'Colourful, from $125', LINK_ROW: '[Shop pink](https://example.test/pink) / [Shop white](https://example.test/white)', CTA_TEXT: '', IMG_SIDE: 'right' });
  assert.equal(validate(c).ok, true);
  for (const html of both(c)) {
    assert.match(html, /alt="Pink flowers in a vase"/);
    assert.match(html, /dir="rtl"/);
    assert.match(html, /color:inherit;text-decoration:underline;">Shop pink/);
    assert.equal((html.match(new RegExp(`href="${t.LINK_URL}"`, 'g')) || []).length, 3);
    assert.doesNotMatch(html, /<v:roundrect|class="cf-btn"|\{\{/);
  }
  t.CTA_TEXT = 'Choose flowers'; t.BODY_P2 = 'A second paragraph.';
  assert.match(block(c), /<v:roundrect/); assert.match(block(c), /A second paragraph/);
  for (const token of ['IMAGE_ALT','BODY_P1','TITLE','LINK_URL']) {
    const invalid = structuredClone(c); invalid.blocks[0].tokens[token] = '';
    assert.equal(validate(invalid).ok, false, token);
  }
  t.IMG_SIDE = 'up'; assert.equal(validate(c).ok, false);
  const minimal = {blocks:[{component:'products/card-feature',tokens:{IMAGE_URL:'https://example.test/image.jpg',IMAGE_ALT:'Flowers',LINK_URL:'https://example.test/flowers',TITLE:'Flowers for you',BODY_P1:'Hand arranged.'}}]};
  assert.equal(validate(minimal).ok, true);
  assert.doesNotMatch(block(minimal), /<v:roundrect|cf-btn"|\{\{/);
  // The old card's shared styles activate at 600px. This tile needs a true 280px
  // desktop image at that width and its own phone styles below 600px.
  assert.match(block(minimal), /max-width:599px/);
  assert.doesNotMatch(block(minimal), /class="(?:cl-img|cl-txt|pn)"/);
  assert.ok(render.htmlOnlyComponents().includes('card-feature'));
  t.IMAGE_ALT = 'Flowers in a \"pink\" vase & greenery';
  assert.match(block(c), /alt="Flowers in a &quot;pink&quot; vase &amp; greenery"/);
  assert.equal(schema.components.find(c => c.name === 'products/card-feature').tokens.find(t => t.name === 'IMAGE_ALT').markdown,false);
});

test('2: text band palette, optional content, markdown, alignment and max two', () => {
  const def = schema.components.find(c => c.name === 'sections/text-band'); assert.ok(def);
  assert.deepEqual(def.palettePresets.map(p => p.name), ['clay','50clay','white','noir']);
  for (const preset of def.palettePresets) {
    const c = sample.sampleCampaignFor(def, { palette: preset.name });
    Object.assign(c.blocks[0].tokens, { HEADLINE:'Your own table', BODY_P2:'A second thought.', LINK_ROW:'[See flowers](https://example.test/flowers)', LINK_TEXT:'Explore', LINK_URL:'https://example.test/explore', ALIGN:'left' });
    assert.equal(validate(c).ok, true);
    for (const html of both(c)) {
      assert.ok(html.includes(`background:${preset.values.PANEL_BG}`));
      assert.ok(html.includes(`color:${preset.values.PANEL_TEXT}`));
      assert.match(html, /text-align:left/); assert.match(html, /text-decoration:underline/);
    }
    const triple = { blocks: Array.from({length:3}, () => structuredClone(c.blocks[0])) };
    assert.equal(validate(triple).ok, false);
    assert.equal(validate({blocks:triple.blocks.slice(0,2)}).ok, true);
    assert.ok(block(c).includes(`style="color:${preset.values.PANEL_TEXT};text-decoration:underline;">Explore`));
  }
  const c = campaign('sections/text-band'); c.blocks[0].tokens.BODY_P1 = '';
  assert.equal(validate(c).ok, false);
  c.blocks[0].tokens.BODY_P1 = 'Copy'; c.blocks[0].tokens.LINK_TEXT = 'Missing destination';
  assert.equal(validate(c).ok, false);
});

test('4: body copy controls and arbitrary paragraphs preserve markdown in both render paths', () => {
  const c = campaign('sections/body-copy-plain'), t = c.blocks[0].tokens;
  Object.assign(t, { ALIGN:'left', MOBILE_ALIGN:'left', TOP_RULE:'off', PADDING_TOP:'12px', PADDING_BOTTOM:'20px', PADDING_X:'32px', MOBILE_PADDING_X:'18px', BODY_P1:'First paragraph.\n\nSecond **bold** paragraph.\n\nThird [link](https://example.test/third).', BODY_P2:'Fourth.\n\nFifth.' });
  assert.equal(validate(c).ok, true);
  for (const html of both(c)) {
    assert.match(html, /border-top:0;/); assert.match(html, /padding:12px 32px 20px/);
    assert.match(html, /text-align:left!important/); assert.match(html, /padding-left:18px!important/);
    assert.match(html, /Second <strong>bold<\/strong>/);
    assert.match(html, /Third <a href=/); assert.match(html, /Fifth\./);
    assert.equal((html.match(/<td[^>]*>[^<]*(?:First paragraph\.|Fourth\.|Fifth\.)/g) || []).length, 3);
  }
  t.ALIGN = 'right'; assert.equal(validate(c).ok, false);
  t.ALIGN = 'left'; t.TOP_RULE = 'none'; assert.equal(validate(c).ok, false);
  t.TOP_RULE = 'on'; t.PADDING_TOP = 'oops'; assert.equal(validate(c).ok, false);
});

test('8: trust-bar is optional pending artwork, and a sendable campaign without it validates', () => {
  assert.ok(!manifest.ordering_rules.required.includes('trust-bar'));
  assert.match(manifest.ordering_rules._note, /trust-bar returns to required when the new artwork lands/);
  const c = campaign('sections/body-copy-plain'); c.blocks.push({component:'footer', tokens:{}});
  assert.equal(require('../lib/validate').validateCampaign(c,schema).ok, true);
});

test('9: full width image padding is optional, independent and schema-typed', () => {
  const c = campaign('sections/full-width-image');
  for (const tok of schema.components.find(c => c.name === 'sections/full-width-image').tokens.filter(t => t.name.startsWith('PADDING_'))) { assert.equal(tok.type,'length'); assert.equal(tok.default,'0'); }
  Object.assign(c.blocks[0].tokens, {PADDING_TOP:'24px',PADDING_BOTTOM:'24px'});
  assert.equal(validate(c).ok,true);
  for (const html of both(c)) { assert.match(html,/padding:24px 0 24px/); assert.match(html,/padding-top:16px!important;padding-bottom:16px!important/); }
  c.blocks[0].tokens.PADDING_BOTTOM='0'; assert.match(block(c),/padding:24px 0 0/);
  c.blocks[0].tokens.PADDING_TOP='invalid'; assert.equal(validate(c).ok,false);
});

test('10: top-line fixed typography, plain text, no rule/link and HTML-only publication', () => {
  const c = campaign('sections/top-line'); c.blocks[0].tokens.TEXT = 'Made with care & delivered with love';
  assert.equal(validate(c).ok,true);
  for (const html of both(c)) {
    assert.match(html,/Made with care &amp; delivered with love/);
    assert.match(html,/background:#EBE5DF;color:#000000;padding:10px 24px/);
    assert.match(html,/font-size:12px;line-height:18px/); assert.match(html,/letter-spacing:0.02em/);
    assert.doesNotMatch(block(c),/<a\b|border/);
  }
  assert.ok(render.htmlOnlyComponents().includes('top-line'));
  assert.equal(schema.components.find(c => c.name === 'sections/top-line').tokens[0].markdown,false);
  for (const text of ['', '[Link](https://example.test)', '<a>Link</a>']) { c.blocks[0].tokens.TEXT=text; assert.equal(validate(c).ok,false); }
});

test('every existing component keeps exact sample, current sample and empty/default HTML bytes', () => {
  const changed = [];
  for (const record of require('./fixtures/207-p2-baseline.json')) {
    const original = render.assembleBlocks(record.campaign).blocks[0].html;
    const current = render.assembleBlocks(campaign(record.component)).blocks[0].html;
    const defaults = render.assembleBlocks({blocks:[{component:record.component,tokens:{}}]}).blocks[0].html;
    // Preserve P2's exact-byte control with only the approved S7b fine_print correction.
    const muted = html => html.replace(/color:#aaaaaa/gi, 'color:#4d4d4d');
    if (original !== muted(record.html) || current !== muted(record.html) || defaults !== muted(record.defaultsHtml)) changed.push(record.component);
  }
  assert.deepEqual(changed, []);
});

test('10: frozen publication includes the notice in HTML and plain text', async () => {
  const publishing = require('../lib/publishAssembly');
  const c = campaign('sections/top-line');
  c.blocks[0].tokens.TEXT = 'Delivery with care & love';
  c.blocks.push({component:'footer',tokens:{}});
  const image = await require('sharp')({create:{width:20,height:25,channels:3,background:'#D8CCBE'}}).png().toBuffer();
  const frozen = await publishing.freezeSavedDesign({id:'p2-text',name:'Notice',updatedAt:'2026-10-25T00:00:00Z',subjectLine:'Notice',previewText:'Notice',campaign:c}, {loadImage:async()=>image});
  // Both blocks stay live. Isolate text/HTML compilation from the unrelated rasterizer.
  const original = render.renderSlices;
  render.renderSlices = async () => ({slices:[],brokenImages:[]});
  try {
    const {artifact} = await publishing.renderFrozenArtifact(frozen);
    assert.match(artifact.text, /Delivery with care & love/);
    assert.match(artifact.rows[0].html, /Delivery with care &amp; love/);
    assert.equal(artifact.rows[0].kind, 'live');
  } finally { render.renderSlices = original; }
});


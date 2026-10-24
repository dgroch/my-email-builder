'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eb207-test-'));
const render = require('../lib/render');
const md = require('../lib/markdown');
const { validateCampaign } = require('../lib/validate');
const schema = require('../lib/parseTemplates').buildSchema(render.DS);
const sample = require('../lib/sampleData');
const campaign = name => sample.sampleCampaignFor(schema.components.find(c => c.name === name));
const blockHtml = c => render.assembleBlocks(c).blocks[0].html;
const link = '[Read **more**](https://example.test/read)';
const styled = colour => `style="color:${colour};color:inherit;text-decoration:underline;"`;

test('markdown links use an explicit fallback plus inherit and underline in both render paths', () => {
  assert.ok(md.toHtml(link).includes(styled('#000000')));
  const c = campaign('sections/body-copy-plain');
  c.blocks[0].tokens.BODY_P1 = link;
  for (const html of [blockHtml(c), render.assemble(c).html]) {
    assert.match(html, /<a href="https:\/\/example.test\/read" style="color:#[0-9a-f]+;color:inherit;text-decoration:underline;">Read <strong>more<\/strong><\/a>/i);
  }
});

test('markdown fallback follows each occurrence and ancestor, including palette tokens', () => {
  const c = { blocks: [{ component: 'test/custom', tokens: { COPY: link, PANEL_TEXT: '#fafafa' } }] };
  const template = '<tr><td style="color:{{PANEL_TEXT}};"><p>{{COPY}}</p><p style="color:#444444;">{{COPY}}</p></td><td>{{COPY}}</td><td><a href="https://example.test/template" style="color:red;">Template</a><img alt="{{COPY}}"></td></tr>';
  const html = render.assembleBlocks(c, { templateOverrides: { 'test/custom': template } }).blocks[0].html;
  for (const colour of ['#fafafa', '#444444', '#000000']) assert.ok(html.includes(styled(colour)), colour);
  assert.ok(html.includes('<a href="https://example.test/template" style="color:red;">Template</a>'));
  assert.ok(html.includes('alt="Read more"'));
});

test('hero and all footer image wrappers have readable alt typography and block images', () => {
  for (const name of ['heroes/hero-image-only', 'footer']) {
    const html = render.stripDocComments(blockHtml(campaign(name)));
    const anchors = [...html.matchAll(/<a\b[^>]*style="([^"]*)"[^>]*>\s*(?:<!--[\s\S]*?-->\s*)*<img\b[^>]*alt="[^"]+"[^>]*>/g)];
    assert.equal(anchors.length, name === 'footer' ? 11 : 1);
    for (const a of anchors) {
      assert.match(a[1], /font-size:14px;/);
      assert.match(a[1], /line-height:(?:normal|1\.[2-6]);/);
      assert.match(a[1], /color:#444444;/);
      assert.match(a[1], /font-family:'NeuzeitGro'/);
      assert.match(a[0], /<img[\s\S]*display:block;/);
    }
  }
});

for (const [component, token] of [['heroes/hero-image-only', 'HERO_LINK_URL'], ['products/card-live', 'CTA_TEXT']]) {
  for (const blank of ['', '  \t\n', null]) test(`${component} rejects blank ${token}: ${JSON.stringify(blank)}`, () => {
    const c = campaign(component);
    c.blocks[0].tokens[token] = blank;
    const report = validateCampaign(c, schema, { requireUnsubscribe: false });
    assert.equal(report.ok, false);
    assert.equal(report.blocks[0].valid, false);
    assert.ok(report.issues.some(i => i.severity === 'error' && i.token === token && i.component === component && i.message.includes(token) && i.message.includes(component)));
    for (const html of [render.stripDocComments(blockHtml(c)), render.stripDocComments(render.assemble(c).html)]) {
      if (component.startsWith('heroes/')) {
        assert.doesNotMatch(html, /<a\b/);
        assert.match(html, /<img\b/);
        assert.match(html, /font-size:14px/);
      } else {
        assert.doesNotMatch(html, /<v:roundrect|class="cl-btn"/);
        assert.match(html, /Savoie bouquet/);
      }
    }
  });
}

test('all other component samples are byte-identical to the pre-fix baseline', () => {
  const changed = [];
  for (const record of require('./fixtures/207-p1-baseline.json')) {
    const hash = crypto.createHash('sha256').update(blockHtml(record.campaign)).digest('hex');
    if (hash !== record.sha256) changed.push(record.component);
  }
  assert.deepEqual(changed.sort(), ['footer', 'heroes/hero-image-only']);
});

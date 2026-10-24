'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Parser } = require('htmlparser2');
// Enables a real main-code revert run without modifying the working implementation.
const root = process.env.EB212S7_TEST_ROOT || path.resolve(__dirname, '..');
const render = require(path.join(root, 'lib/render'));
const { buildSchema } = require(path.join(root, 'lib/parseTemplates'));
const { validateCampaign } = require(path.join(root, 'lib/validate'));
const sample = require(path.join(root, 'lib/sampleData'));
const schema = buildSchema(render.DS);
const capsNames = ['heroes/hero-d-noir','heroes/hero-b-noir','heroes/hero-c1-noir','heroes/hero-c2-noir','sections/upsell-noir','sections/section-headline'];
function tags(html) {
  const out = [];
  new Parser({ onopentag(name, attrs) { out.push({ name, ...attrs }); } }).end(html);
  return out;
}
function css(tag, property) {
  return (tag.style || '').split(';').map(s => s.trim()).filter(s => s.startsWith(property + ':')).pop()?.slice(property.length + 1).trim();
}
function baselineCases() {
  const f = require('./fixtures/212-s7-baseline.json');
  const cases = JSON.parse(zlib.gunzipSync(Buffer.from(f.data, 'base64')).toString()
    .replace(/@@BASELINE_ASSET_(\d+)@@/g, (_m, i) => f.shared[i]));
  const delta = require('./fixtures/212-s7b-muted-baseline.json');
  assert.deepEqual(cases.filter(c => /color:#aaaaaa/i.test(JSON.stringify(c.renders)) || /color:#aaaaaa/i.test(JSON.stringify(c.blocks))).map(c => c.id), delta.cases);
  return cases.map(c => delta.cases.includes(c.id) ? JSON.parse(JSON.stringify(c).replace(/color:#aaaaaa/gi, 'color:' + delta.to)) : c);
}
test('S7 compatibility control: all 112 campaigns retain bytes except the listed fine_print baseline delta', () => {
  for (const c of baselineCases()) for (const theme of [undefined, 'light']) {
    const campaign = { ...c.campaign, ...(theme ? { theme } : {}) };
    for (const expected of c.renders) {
      const actual = render.assemble(campaign, expected.opts);
      assert.ok(Buffer.from(actual.html).equals(Buffer.from(expected.html)), `${c.id} ${theme} ${JSON.stringify(expected.opts)}`);
      assert.deepEqual(actual.unfilled, expected.unfilled);
    }
    assert.deepEqual(render.assembleBlocks(campaign).blocks.map(b => b.html), c.blocks.blocks.map(b => b.html), c.id + ' block bytes');
  }
  const section = '<tr><td>Baseline production shell</td></tr>';
  // Wrap's ordinary behavior is also identical to its pre-edit production assembly.
  assert.equal(render.wrapProductionShell(section), render.wrapProductionShell(section, { theme: 'light' }));
});
for (const comp of schema.components) {
  test(`S7 dark: ${comp.name} paints noir wrappers and light text/links`, () => {
    const campaign = { ...sample.sampleCampaignFor(comp), theme: 'dark' };
    const { blocks } = render.assembleBlocks(campaign);
    const html = blocks[0].html;
    const elements = tags(html);
    assert.ok(elements.some(t => t.bgcolor === '#000000'), comp.name + ' noir bgcolor');
    for (const el of elements) {
      if (['table','td','th','div'].includes(el.name)) {
        assert.equal(el.bgcolor, '#000000', comp.name + ' ' + el.name + ' bgcolor');
        assert.equal(css(el, 'background'), '#000000', comp.name + ' CSS background');
      }
      if (/^h[1-6]$/.test(el.name)) assert.equal(css(el, 'color'), '#ffffff');
      if (el.name === 'a') {
        assert.equal(css(el, 'color'), '#ffffff', comp.name + ' explicit link colour');
        assert.equal(css(el, 'text-decoration'), 'underline');
      }
      const color = css(el, 'color');
      if (color) assert.ok(['#ffffff','#d9d4ce'].includes(color), comp.name + ' ' + color);
    }
    assert.equal(render.assemble(campaign).unfilled.length, 0);
  });
}
test('S7 dark preview, production, marked and sliced shells carry client-mode protection', () => {
  const campaign = require('./fixtures/212-s7-dark-caps.json');
  const segments = render.assembleBlocks(campaign);
  const outputs = [{}, { shell: 'production', production: true }, { markBlocks: true }].map(opts => render.assemble(campaign, opts).html);
  outputs.push(render.wrapProductionShell(segments.blocks.map(b => b.html).join('\n'), segments));
  for (const html of outputs) {
    assert.match(html, /name="color-scheme" content="dark"/);
    assert.match(html, /name="supported-color-schemes" content="dark"/);
    assert.match(html, /\[data-ogsc\]/); assert.match(html, /\[data-ogsb\]/);
    assert.match(html, /@media \(prefers-color-scheme:dark\)/);
    for (const el of tags(html).filter(t => ['body','table','td'].includes(t.name))) {
      assert.equal(el.bgcolor, '#000000'); assert.equal(css(el,'background'), '#000000');
    }
  }
});
test('S7 supplied cream assets are default, swappable and local; footer navigation survives images off', async () => {
  const campaign = { ...require('./fixtures/212-s7-dark-test.json'), theme: 'dark' };
  const html = render.assemble(campaign).html;
  const images = tags(html).filter(t => t.name === 'img');
  const logos = images.filter(t => t.alt === 'Fig & Bloom');
  assert.equal(logos.length, 2);
  for (const logo of logos) {
    assert.match(logo.src, /F_B_Logo_Horizontal_CREAM_914x200.png$/);
    assert.equal(logo.width, '120'); assert.doesNotMatch(logo.style, /filter/);
  }
  for (const social of ['Facebook','Instagram','Pinterest','Youtube']) {
    const icon = images.find(t => t.alt.toLowerCase() === social.toLowerCase());
    assert.ok(icon, social); assert.equal(icon.width, '150');
    assert.match(icon.src, /_CREAM_300x120.png$/);
  }
  for (const im of images) {
    assert.ok(im.src.startsWith('/design-system/assets/'), im.src);
    const local = path.join(root, im.src.slice(1));
    assert.ok(fs.existsSync(local), im.src);
    const m = await require('sharp')(local).metadata(); assert.ok(m.width > 0 && m.height > 0);
  }
  for (const label of ['BOUQUETS','VASE ARRANGEMENTS','PLANTS','GIFTS','EVENTS','STORE FINDER']) assert.ok(html.includes('>' + label + '</a>'));
  const override = render.assemble({ ...campaign, themeTokens: { DARK_LOGO_URL: '/logo.png', DARK_INSTAGRAM_URL: '/instagram.png' } }).html;
  assert.match(override, /src="\/logo.png"/); assert.match(override, /src="\/instagram.png"/);
  const light = render.assemble({ ...campaign, theme: 'light', themeTokens: campaign.themeTokens }).html;
  assert.doesNotMatch(light, /_CREAM_|eb-dark/);
});
test('S7 reconstructed dark test and caps variant validate clean with real uppercase HTML', () => {
  for (const fixture of ['dark-test','dark-caps']) {
    const campaign = { ...require('./fixtures/212-s7-' + fixture + '.json'), theme: 'dark' };
    const result = validateCampaign(campaign, schema);
    assert.equal(result.errorCount, 0, JSON.stringify(result.issues));
    assert.equal(result.warningCount, 0, JSON.stringify(result.issues));
    assert.equal(render.assemble(campaign).unfilled.length, 0);
    assert.match(render.assemble(campaign).html, /data-eb-dark/);
  }
  const html = render.assemble(require('./fixtures/212-s7-dark-caps.json')).html;
  assert.match(html, />AFTER DARK<\/h1>/);
  assert.match(html, />BLACK FRIDAY IS ABOUT TO BLOOM<\/h2>/);
});
for (const name of capsNames) test(`S7 caps: ${name} preserves text, uses Lust and validates separately from default`, () => {
  const comp = schema.components.find(c => c.name === name);
  const tokens = { ...sample.sampleTokensFor(comp), HEADLINE: 'AFTER DARK / BLACK FRIDAY IS ABOUT TO BLOOM', HEADLINE_STYLE: 'caps', HEADLINE_LETTER_SPACING: '0.09em' };
  assert.ok(comp.tokens.some(t => t.name === 'HEADLINE_STYLE' && t.enumOptions.includes('caps')));
  const campaign = { theme: 'dark', blocks: [{ component: name, tokens }] };
  const headline = tags(render.assembleBlocks(campaign).blocks[0].html).find(t => t['data-eb-caps']);
  assert.ok(headline); assert.match(css(headline, 'font-family'), /^'Lust'/);
  assert.equal(css(headline, 'text-transform'), 'none'); assert.equal(css(headline, 'letter-spacing'), '0.09em');
  assert.equal(css(headline,'padding-bottom'), '0');
  assert.equal(validateCampaign(campaign, schema, { requireUnsubscribe: false }).errorCount, 0);
  if (name !== 'sections/section-headline') {
    const defaults = { ...campaign, blocks: [{ component: name, tokens: { ...tokens, HEADLINE_STYLE: 'default' } }] };
    assert.ok(validateCampaign(defaults, schema, { requireUnsubscribe: false }).issues.some(i => i.type === 'casing'));
  }
  const badStyle = { ...campaign, blocks: [{ component: name, tokens: { ...tokens, HEADLINE_STYLE: 'shout' } }] };
  assert.ok(validateCampaign(badStyle, schema, { requireUnsubscribe: false }).issues.some(i => i.type === 'invalid_enum'));
});
test('S7 unsupported authored block warns by name, without making validation fail', () => {
  const custom = { name: 'authored/new-panel', tokens: [], authored: true };
  const customSchema = { ...schema, components: [...schema.components, custom] };
  const campaign = { theme: 'dark', blocks: [{ component: custom.name, tokens: {} }] };
  const report = validateCampaign(campaign, customSchema, { requireUnsubscribe: false });
  assert.equal(report.ok, true); assert.equal(report.errorCount, 0);
  const warning = report.issues.find(i => i.type === 'missing_dark_version');
  assert.equal(warning?.severity, 'warning'); assert.ok(warning.message.includes(custom.name));
  assert.equal(validateCampaign({ ...campaign, theme: 'light' }, customSchema, { requireUnsubscribe: false }).warningCount, 0);
});

test('S7b hero-a HEADLINE_FONT defaults retain exact bytes and Lust preserves case and punctuation', () => {
  const comp = schema.components.find(c => c.name === 'heroes/hero-a');
  assert.deepEqual(comp.tokens.find(t => t.name === 'HEADLINE_FONT')?.enumOptions, ['cervanttis', 'lust']);
  const campaign = sample.sampleCampaignFor(comp);
  const explicit = structuredClone(campaign);
  explicit.blocks[0].tokens.HEADLINE_FONT = 'cervanttis';
  for (const opts of [{}, { markBlocks: true }, { production: true, shell: 'production' }]) {
    assert.equal(render.assemble(campaign, opts).html, render.assemble(explicit, opts).html);
  }
  assert.deepEqual(render.assembleBlocks(campaign).blocks, render.assembleBlocks(explicit).blocks);
  for (const font of ['cervanttis', 'lust', 'unknown']) {
    const c = structuredClone(campaign);
    Object.assign(c.blocks[0].tokens, { HEADLINE_FONT: font, HEADLINE: font === 'cervanttis' ? 'the christmas table, done.' : 'The Christmas table, done.' });
    const report = validateCampaign(c, schema, { requireUnsubscribe: false });
    if (font === 'unknown') assert.ok(report.issues.some(i => i.type === 'invalid_enum'));
    else assert.equal(report.errorCount, 0, JSON.stringify(report.issues));
    if (font === 'lust') for (const theme of ['light', 'dark']) {
      const html = render.assemble({ ...c, theme }).html;
      assert.match(html, />The Christmas table, done\.<\/h1>/);
      const h = tags(html).find(t => t['data-eb-headline-font']);
      assert.match(css(h, 'font-family'), /^'Lust'/);
      assert.equal(css(h, 'text-transform'), 'none');
      assert.equal(css(h, 'padding-bottom'), '0');
    }
  }
  const tokens = sample.sampleTokensFor(comp, { levers: { HEADLINE_FONT: 'lust', HEADLINE: 'The Christmas table, done.' } });
  assert.equal(tokens.HEADLINE, 'The Christmas table, done.');
});

function contrast(a, b) {
  const lum = hex => {
    const rgb = hex.replace('#', '').match(/../g).map(c => parseInt(c, 16) / 255)
      .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return rgb.reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  };
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
test('S7b fine_print alone changes and meets WCAG 4.5:1 on cream and S7 noir', () => {
  const manifest = require(path.join(root, 'design-system/manifest.json'));
  const colours = manifest.locked_styles.colours;
  assert.deepEqual(colours, { primary: '#000000', body: '#444444', secondary: '#666666', fine_print: '#4d4d4d', stars: '#C8A888', clay: '#D8CCBE', clay_50: '#EBE5DF', border: '#e8e2da' });
  const campaign = { blocks: [{ component: 'sections/delivery-cutoffs', tokens: { CUTOFF_NOTE: 'Small note' } }] };
  const light = tags(render.assembleBlocks(campaign).blocks[0].html).find(t => t.name === 'p');
  const dark = tags(render.assembleBlocks({ ...campaign, theme: 'dark' }).blocks[0].html).find(t => t.name === 'p');
  assert.equal(css(light, 'color'), colours.fine_print);
  const ratios = { oldLight: contrast('#aaaaaa', '#EBE5DF'), newLight: contrast(css(light, 'color'), '#EBE5DF'), oldLightClay: contrast('#aaaaaa', '#D8CCBE'), newLightClay: contrast(css(light, 'color'), '#D8CCBE'), oldDark: contrast('#d9d4ce', '#000000'), newDark: contrast(css(dark, 'color'), '#000000') };
  assert.ok(ratios.oldLight < 4.5);
  assert.ok(ratios.newLight >= 4.5, JSON.stringify(ratios));
  assert.ok(ratios.newLightClay >= 4.5, JSON.stringify(ratios));
  assert.ok(ratios.newDark >= 4.5, JSON.stringify(ratios));
  console.log('S7b contrast ratios: ' + JSON.stringify(ratios));
});

// The #207 fallback must remain explicit and readable with images disabled, including VML.
test('S7 merged #207 markdown links and image alt typography stay readable in both themes', () => {
  for (const theme of ['light', 'dark']) {
    const c = sample.sampleCampaignFor(schema.components.find(c => c.name === 'sections/body-copy-plain'));
    c.theme = theme;
    c.blocks[0].tokens.BODY_P1 = '[Read **more**](https://example.test/read)';
    for (const html of [render.assemble(c).html, render.assembleBlocks(c).blocks[0].html]) {
      const link = tags(html).find(t => t.href === 'https://example.test/read');
      assert.ok(link);
      assert.equal(css(link, 'color'), theme === 'dark' ? '#ffffff' : 'inherit');
      assert.equal(css(link, 'text-decoration'), 'underline');
      assert.match(link.style, theme === 'dark' ? /color:#ffffff;/ : /color:#444444;/);
    }
    for (const name of ['footer', 'heroes/hero-image-only']) {
      const campaign = { ...sample.sampleCampaignFor(schema.components.find(c => c.name === name)), theme };
      for (const html of [render.assemble(campaign).html, render.assembleBlocks(campaign).blocks[0].html]) {
        const clean = render.stripDocComments(html);
        const anchors = [...clean.matchAll(/<a\b[^>]*>\s*(?:<!--[\s\S]*?-->\s*)*<img\b/g)];
        assert.equal(anchors.length, name === 'footer' ? (theme === 'dark' ? 5 : 11) : 1);
        for (const anchor of anchors) {
          const a = tags(anchor[0])[0];
          assert.match(a.style, /font-size:14px;/);
          assert.match(a.style, /line-height:normal;/);
          assert.equal(css(a, 'color'), theme === 'dark' ? '#ffffff' : '#444444');
        }
        if (name === 'heroes/hero-image-only') {
          const vml = clean.match(/<v:image\b[\s\S]*?\/>/)[0];
          assert.match(vml, theme === 'dark' ? /color:#d9d4ce;/ : /color:#444444;/);
        }
      }
    }
  }
});

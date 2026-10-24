'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eb212-test-'));
process.env.DATA_DIR = scratch;
const render = require('../lib/render');
const { buildSchema } = require('../lib/parseTemplates');
const { validateCampaign } = require('../lib/validate');
const sampleData = require('../lib/sampleData');
const baseline = require('./fixtures/212-s1-baseline.json');
const schema = buildSchema(render.DS);
const component = 'sections/delivery-cutoffs';
const two = { REGION_1: 'MEL', CUTOFF_1: 'Order by Thursday', REGION_2: 'SYD', CUTOFF_2: 'Order by Wednesday', CUTOFF_NOTE: 'Delivery deadlines' };
const campaign = tokens => ({ blocks: [{ component, tokens }] });
const fullBaseline = middle => (baseline.previewPrefix + middle + baseline.previewSuffix)
  .replace(/@@BASELINE_FONT_(\d+)@@/g, (_, n) => baseline.sharedFonts[n]);

test('third-slot manifest contract and real GET /api/schema handler expose optional tokens', async () => {
  const { server } = require('../server');
  // Dispatch through the actual HTTP request listener; no socket/listen needed in a sandbox.
  const response = await new Promise((resolve, reject) => {
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { resolve({ status: this.status, headers: this.headers, body: JSON.parse(body) }); } };
    Promise.resolve(server.listeners('request')[0]({ method: 'GET', url: '/api/schema', headers: {} }, res)).catch(reject);
  });
  assert.equal(response.status, 200);
  assert.match(response.headers['Content-Type'], /application\/json/);
  const def = response.body.components.find(c => c.name === component);
  const entry = require('../design-system/manifest.json').components.sections['delivery-cutoffs'];
  for (const name of ['REGION_3', 'CUTOFF_3']) {
    assert.ok(entry.tokens.includes(name), `manifest must declare ${name}`);
    assert.equal(def.tokens.find(t => t.name === name)?.default, '', `${name} must be optional in GET /api/schema`);
  }
});

test('three equal email-safe columns; all main sample/default HTML and blank third-slot HTML stay byte-identical', () => {
  const three = { ...two, REGION_3: 'BNE', CUTOFF_3: 'Order by Tuesday' };
  const assembled = render.assemble(campaign(three));
  assert.deepEqual(assembled.unfilled, []);
  for (const html of [assembled.html, render.assembleBlocks(campaign(three)).blocks[0].html,
    render.assemble(campaign(three), { shell: 'production', production: true }).html]) {
    assert.equal((html.match(/class="cc" width="168"/g) || []).length, 3);
    assert.equal((html.match(/style="width:33.33%;padding:0;vertical-align:top;"/g) || []).length, 3);
    assert.ok(html.includes('BNE') && html.includes('Order by Tuesday'));
    assert.match(html, /table-layout:fixed/);
    assert.match(html, /min-width:600px/);
    assert.ok(!/\{\{[#^/]/.test(html));
  }
  assert.deepEqual(schema.components.map(c => c.name).sort(), Object.keys(baseline.components).sort());
  for (const def of schema.components) {
    const b = baseline.components[def.name];
    const currentSample = sampleData.sampleCampaignFor(def);
    for (const [label, camp] of [['sample', currentSample], ['empty', b.emptyCampaign]]) {
      assert.equal(render.assemble(camp, baseline.options).html, fullBaseline(b[label]), `${def.name}: ${label} full HTML`);
      assert.equal(render.assembleBlocks(camp, baseline.options).blocks[0].html, b[label + 'Block'], `${def.name}: ${label} block HTML`);
    }
  }
  const b = baseline.components[component];
  for (const optional of [{}, { REGION_3: '', CUTOFF_3: '' }, { REGION_3: ' \t', CUTOFF_3: '\n ' }, { REGION_3: null, CUTOFF_3: null }]) {
    const camp = structuredClone(b.sampleCampaign);
    Object.assign(camp.blocks[0].tokens, optional);
    assert.equal(render.assemble(camp, baseline.options).html, fullBaseline(b.sample));
    assert.equal(render.assembleBlocks(camp, baseline.options).blocks[0].html, b.sampleBlock);
    assert.equal(validateCampaign(camp, schema, { requireUnsubscribe: false }).ok, true);
  }
});

for (const [present, missing] of [['REGION_3', 'CUTOFF_3'], ['CUTOFF_3', 'REGION_3']]) {
  test(`half-filled slot 3 names ${missing}, while two and three complete slots validate`, () => {
    const check = tokens => validateCampaign(campaign(tokens), schema, { requireUnsubscribe: false });
    assert.equal(check(two).ok, true);
    assert.equal(check({ ...two, REGION_3: 'BNE', CUTOFF_3: 'Order by Tuesday' }).ok, true);
    for (const blank of [undefined, '', ' \n\t', null]) {
      const result = check({ ...two, [present]: 'BNE', [missing]: blank });
      assert.equal(result.ok, false);
      const issue = result.issues.find(i => i.type === 'incomplete_cutoff_slot');
      assert.equal(issue?.token, missing);
      assert.equal(issue.component, component);
      assert.equal(issue.index, 0);
      assert.equal(result.blocks[0].valid, false);
      assert.ok(issue.message.includes(component) && issue.message.includes(missing));
    }
    // Explicit blanks in original required slots remain valid, as on main.
    assert.equal(check({ ...two, REGION_1: '', CUTOFF_2: '' }).ok, true);
  });
}

after(async () => {
  await require('../lib/db').close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

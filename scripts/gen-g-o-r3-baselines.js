'use strict';
// Refresh only the samples changed by R3/R4. Preserve historical intentional differences
// in the 207 baselines and 212's original component set/source revision.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createHash } = require('crypto');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'go-r3-baseline-'));
process.env.DATA_DIR = path.join(scratch, 'data');
const render = require('../lib/render');
const sample = require('../lib/sampleData');
const schema = require('../lib/parseTemplates').buildSchema(render.DS);
const names = ['products/card-single-testimonial', 'sections/testimonial', 'blocks/story'];
try {
  for (const file of ['207-p1', '207-p2']) {
    const target = path.join(root, 'test/fixtures', file + '-baseline.json');
    const records = JSON.parse(fs.readFileSync(target));
    for (const record of records.filter(r => names.includes(r.component))) {
      record.campaign = sample.sampleCampaignFor(schema.components.find(c => c.name === record.component));
      const html = render.assembleBlocks(record.campaign).blocks[0].html;
      if (file === '207-p1') record.sha256 = createHash('sha256').update(html).digest('hex');
      else {
        record.html = html;
        record.defaultsHtml = render.assembleBlocks({ blocks: [{ component: record.component, tokens: {} }] }).blocks[0].html;
      }
    }
    fs.writeFileSync(target, JSON.stringify(records, null, 2) + '\n');
  }
  const generated = path.join(scratch, '212.json');
  execFileSync(process.execPath, [path.join(__dirname, 'gen-212-s1-baseline.js'), root, generated],
    { env: { ...process.env, TMPDIR: scratch } });
  const target = path.join(root, 'test/fixtures/212-s1-baseline.json');
  const original = JSON.parse(fs.readFileSync(target));
  const fresh = JSON.parse(fs.readFileSync(generated));
  // Font references must retain their original indices.
  if (JSON.stringify(original.sharedFonts) !== JSON.stringify(fresh.sharedFonts)) throw Error('Font table changed');
  for (const name of names) original.components[name] = fresh.components[name];
  fs.writeFileSync(target, JSON.stringify(original, null, 2) + '\n');
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }

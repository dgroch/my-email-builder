'use strict';
// Regenerate test/fixtures/212-s1-baseline.json from an UNMODIFIED main checkout.
// Usage: node scripts/gen-212-s1-baseline.js <main-checkout-root> <out.json>
const fs = require('fs'); const os = require('os'); const path = require('path');
const [root, out] = process.argv.slice(2).map(p => path.resolve(p));
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eb212-gen-'));
const render = require(path.join(root, 'lib/render'));
const { buildSchema } = require(path.join(root, 'lib/parseTemplates'));
const sampleData = require(path.join(root, 'lib/sampleData'));
const sha = require('child_process').execSync('git rev-parse HEAD', { cwd: root }).toString().trim();
const options = { assetsBase: '/design-system/assets' };
const previewPrefix = '<!DOCTYPE html>\n<html lang="en"><head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>';
const previewSuffix = '\n<!-- COMPONENTS_END -->\n</table>\n</center>\n</body></html>';
const sharedFonts = [];
const encode = html => {
  if (!html.startsWith(previewPrefix) || !html.endsWith(previewSuffix)) throw new Error('unexpected shell');
  let mid = html.slice(previewPrefix.length, html.length - previewSuffix.length);
  mid = mid.replace(/@font-face\{[^}]*\}/g, f => {
    let i = sharedFonts.indexOf(f); if (i < 0) { i = sharedFonts.length; sharedFonts.push(f); }
    return `@@BASELINE_FONT_${i}@@`;
  });
  return mid;
};
const components = {};
for (const def of buildSchema(render.DS).components) {
  const sampleCampaign = sampleData.sampleCampaignFor(def);
  const emptyCampaign = { blocks: [{ component: def.name, tokens: {} }] };
  const e = { sampleCampaign, emptyCampaign };
  for (const [label, camp] of [['sample', sampleCampaign], ['empty', emptyCampaign]]) {
    e[label] = encode(render.assemble(camp, options).html);
    e[label + 'Block'] = render.assembleBlocks(camp, options).blocks[0].html;
  }
  components[def.name] = e;
}
const fx = { source: sha, options, components, previewPrefix, previewSuffix,
  encoding: 'sample/empty store the middle of complete HTML; concatenate previewPrefix + middle + previewSuffix (lossless shell deduplication); expand @@BASELINE_FONT_n@@ from sharedFonts',
  sharedFonts };
fs.writeFileSync(out, JSON.stringify(fx, null, 2) + '\n');
console.log(`wrote ${Object.keys(components).length} components from ${sha}`);
process.exit(0);

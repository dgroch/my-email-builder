'use strict';
// Produces research artifacts through the same live-block + production-shell path used by
// Klaviyo. No credentials, campaign creation, recipient lists, scheduling or sending.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const render = require('../lib/render');
const { buildSchema } = require('../lib/parseTemplates');
const { sampleTokensFor } = require('../lib/sampleData');
const { validateCampaign } = require('../lib/validate');
const { COMPONENT } = require('../lib/productCarousel');
const out = path.join(__dirname, '../docs/product-carousel');
const schema = buildSchema(render.DS);
const def = schema.components.find(c => c.name === COMPONENT);
const block = { component: COMPONENT, tokens: sampleTokensFor(def) };
block.tokens.PRODUCTS = structuredClone(block.tokens.PRODUCTS).map((p, i) => ({ ...p,
  url: `${p.url}?utm_source=klaviyo&utm_medium=email&utm_campaign=carousel_compatibility_test&utm_content=product_${i + 1}` }));
const button = { component: 'sections/button', tokens: sampleTokensFor(schema.components.find(c => c.name === 'sections/button')) };
Object.assign(button.tokens, { CTA_TEXT: 'Explore gifts', CTA_URL: 'https://figandbloom.com/collections/gifts?utm_source=klaviyo&utm_medium=email&utm_campaign=carousel_compatibility_test&utm_content=main_cta', PANEL_BG: '#ffffff' });
const campaign = { campaignName: 'TEST - Product carousel feasibility', bodyBg: '#f3f0eb',
  previewText: 'Test email: portrait cards, individual links and a static fallback.',
  blocks: [block, button, { component: 'footer', tokens: {} }] };
const validation = validateCampaign(campaign, schema);
if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'campaign.json'), JSON.stringify(campaign, null, 2) + '\n');
const records = {};
for (const [name, probe] of [['fallback', false], ['candidate-test-only', true]]) {
  const meta = render.assembleBlocks(campaign, { carouselProbe: probe, assetsBase: 'https://my-email-builder.onrender.com/design-system/assets' });
  // Every block in this research campaign is html_only. This is exactly the live branch in
  // server.js's sliced Klaviyo export; tests also exercise that handler with only network I/O stubbed.
  if (!meta.blocks.every(b => render.isUnsubscribeBlock(b.component, b.html) || render.isHtmlOnlyComponent(b.component, schema.assembly.html_only_components)))
    throw new Error('Probe campaign must contain only live HTML blocks.');
  const html = render.wrapProductionShell(meta.blocks.map(b => render.stripDocComments(b.html)).join('\n'),
    { campaignName: campaign.campaignName, bodyBg: campaign.bodyBg, previewText: campaign.previewText });
  fs.writeFileSync(path.join(out, name + '.html'), html);
  records[name] = { bytes: Buffer.byteLength(html), sha256: crypto.createHash('sha256').update(html).digest('hex'),
    status: probe ? 'Unverified test artifact. Not a production carousel.' : 'Production exports use this static fallback.' };
}
fs.writeFileSync(path.join(out, 'export-evidence.json'), JSON.stringify({ generatedAt: new Date().toISOString(), artifacts: records }, null, 2) + '\n');
console.log(JSON.stringify(records, null, 2));

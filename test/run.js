'use strict';
// Zero-dependency test runner: `npm test`. Covers the guardrails called out in the backend
// task spec plus the new agent-facing surfaces (intent metadata, objective taxonomy,
// teaching validation, examples). Exits non-zero on the first batch of failures.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DS = path.join(ROOT, 'design-system');

const { buildSchema } = require('../lib/parseTemplates');
const { OBJECTIVES, OBJECTIVE_GUIDANCE, COMPONENT_INTENT } = require('../lib/componentStrategy');
const { validateCampaign } = require('../lib/validate');
const { loadSeedExamples } = require('../lib/examples');
const render = require('../lib/render');
const sampleData = require('../lib/sampleData');

let passed = 0;
const failures = [];
function ok(cond, msg) { if (cond) passed++; else failures.push(msg); }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

const schema = buildSchema(DS);
const names = new Set(schema.components.map((c) => c.name));

// ── Guardrail: every schema component name resolves to an existing template file ──────
// This single check prevents whole classes of the group-prefix bug.
for (const c of schema.components) {
  ok(fs.existsSync(path.join(ROOT, c.file)), `template file missing for component '${c.name}': ${c.file}`);
}

// ── Task 4: objective taxonomy is exposed and internally consistent ───────────────────
ok(Array.isArray(schema.objectives), 'schema.objectives should be an array');
eq(schema.objectives.length, OBJECTIVES.length, 'schema.objectives length matches OBJECTIVES');
eq(Object.keys(OBJECTIVE_GUIDANCE).sort().join(','), [...OBJECTIVES].sort().join(','),
  'OBJECTIVE_GUIDANCE keys match the OBJECTIVES list');

// Every component referenced by the guidance resolves to a real component.
for (const [obj, g] of Object.entries(OBJECTIVE_GUIDANCE)) {
  for (const list of [g.blockSequence, g.heroOptions, g.proofModules, g.avoid]) {
    for (const n of (list || [])) ok(names.has(n), `objective '${obj}' references unknown component '${n}'`);
  }
}

// ── Task 3: intent metadata is additive and drift-free ────────────────────────────────
const objectiveSet = new Set(OBJECTIVES);
for (const [name, intent] of Object.entries(COMPONENT_INTENT)) {
  ok(names.has(name), `COMPONENT_INTENT references unknown component '${name}'`);
  for (const o of (intent.bestFor || [])) ok(objectiveSet.has(o), `'${name}'.bestFor has unknown objective '${o}'`);
  for (const o of (intent.avoidFor || [])) ok(objectiveSet.has(o), `'${name}'.avoidFor has unknown objective '${o}'`);
}
// Merged onto the schema, and genuinely additive (unannotated components carry no intent).
const eh = schema.components.find((c) => c.name === 'blocks/editorial-hero');
ok(eh && Array.isArray(eh.bestFor) && eh.bestFor.includes('range_launch'), 'editorial-hero schema carries bestFor');
const header = schema.components.find((c) => c.name === 'header');
ok(header && header.bestFor === undefined, 'unannotated component (header) has no intent fields');

// ── Task 2 invariant: every isExample design assembles cleanly ────────────────────────
const seeds = loadSeedExamples();
ok(seeds.length > 0, 'at least one seed example ships in examples/');
ok(seeds.some((s) => s.objective === 'farewell_sellthrough'), 'farewell_sellthrough exemplar present');
for (const ex of seeds) {
  const { unfilled } = render.assemble(ex.campaign || {}, { assetsBase: '/design-system/assets' });
  const missing = unfilled.filter((u) => u.token === '(missing template)');
  const blank = unfilled.filter((u) => u.token !== '(missing template)');
  eq(missing.length, 0, `example '${ex.id}' has no (missing template)`);
  eq(blank.length, 0, `example '${ex.id}' has no unfilled tokens`);
}

// ── Task 5: teaching validation ───────────────────────────────────────────────────────
// Bare component name → group-prefixed suggestion.
const bare = validateCampaign({ blocks: [{ component: 'hero-d-clay', tokens: {} }] }, schema);
const unknown = bare.issues.find((i) => i.type === 'unknown_component');
ok(unknown, 'bare component name produces an unknown_component issue');
eq(unknown && unknown.suggestion, 'heroes/hero-d-clay', 'unknown_component suggests the group-prefixed name');
eq(bare.ok, false, 'campaign with unknown component is not ok');

// Casing: a lowercase-only token (Cervanttis) flagged when given caps; suggestion lowercased.
const caseRep = validateCampaign({ blocks: [{ component: 'blocks/editorial-hero', tokens: {
  HERO_IMAGE_URL: 'x', SUPER_LABEL: 'x', ACCENT_SCRIPT: 'With Love', HEADLINE: 'a lowercase headline',
  SUBHEADLINE: 'x', CTA_TEXT: 'x', CTA_URL: 'x',
} }] }, schema);
const lowerIssue = caseRep.issues.find((i) => i.type === 'casing' && i.token === 'ACCENT_SCRIPT');
ok(lowerIssue, 'uppercase in a lowercase token is flagged');
eq(lowerIssue && lowerIssue.suggestion, 'with love', 'lowercase suggestion is provided');
const sentenceIssue = caseRep.issues.find((i) => i.type === 'casing' && i.token === 'HEADLINE');
ok(sentenceIssue, 'all-lowercase in a Sentence-case token is flagged');
eq(sentenceIssue && sentenceIssue.suggestion, 'A lowercase headline', 'Sentence-case suggestion is provided');

// Unfilled token detection.
const unfilledRep = validateCampaign({ blocks: [{ component: 'sections/body-copy-plain', tokens: { SUPER_LABEL: 'x' } }] }, schema);
ok(unfilledRep.issues.some((i) => i.type === 'unfilled_token' && i.token === 'HEADLINE'), 'missing token reported as unfilled_token');

// A valid example campaign passes clean.
const good = validateCampaign(seeds[0].campaign, schema);
eq(good.ok, true, `seed example '${seeds[0].id}' validates clean`);

// ── Inline markdown in token values ───────────────────────────────────────────────────
const mdHtml = render.assemble({ blocks: [{ component: 'blocks/editorial-hero', tokens: {
  HERO_IMAGE_URL: 'x.jpg', SUPER_LABEL: 'Notes', ACCENT_SCRIPT: 'with love,',
  HEADLINE: 'The last of the **Rosehaven** blooms',
  SUBHEADLINE: 'Shop *now* before [they go](https://figandbloom.com.au/x).',
  CTA_TEXT: 'Shop', CTA_URL: 'https://x.com',
} }] }, { assetsBase: '/a' }).html;
ok(/<h1[^>]*>The last of the <strong>Rosehaven<\/strong> blooms<\/h1>/.test(mdHtml), 'bold renders in body text');
ok(/<em>now<\/em>/.test(mdHtml), 'italic renders in body text');
ok(/<a href="https:\/\/figandbloom\.com\.au\/x">they go<\/a>/.test(mdHtml), 'link renders in body text');
// The same token in an alt="" attribute must stay plain text (no tags leak into attributes).
ok(/alt="The last of the Rosehaven blooms"/.test(mdHtml), 'markdown is flattened inside attributes');
// Schema advertises markdown support on text tokens only.
const hl = eh.tokens.find((t) => t.name === 'HEADLINE');
const img = eh.tokens.find((t) => t.name === 'HERO_IMAGE_URL');
ok(hl && hl.markdown === true, 'text token advertises markdown:true');
ok(img && img.markdown === undefined, 'non-text token does not advertise markdown');
// Escaped markers and stray (spaced) asterisks survive without becoming emphasis.
const plain = render.assemble({ blocks: [{ component: 'sections/body-copy-plain', tokens: {
  SUPER_LABEL: 'X', HEADLINE: 'Two stars * and *', BODY_P1: 'Keep \\*everything\\* literal', BODY_P2: '',
} }] }, { assetsBase: '/a' }).html;
ok(plain.includes('Keep *everything* literal'), 'escaped asterisks become literal asterisks (no emphasis)');
ok(plain.includes('Two stars * and *'), 'stray spaced asterisks are left untouched');
ok(!/<em>everything<\/em>/.test(plain), 'escaped emphasis is not rendered');

// ── GIF passthrough detection (animated heroes must not be flattened on publish) ──────
// Hosted .gif → live passthrough; everything else → rasterise as before.
ok(render.isGifUrl('https://cdn.shopify.com/s/files/1/0657/8723/2489/files/IMG-1703.gif?v=1781564985'), 'hosted .gif with query is a passthrough GIF');
ok(render.isGifUrl('//cdn.shopify.com/x.GIF'), 'protocol-relative .GIF (any case) is a passthrough GIF');
ok(!render.isGifUrl('https://cdn.shopify.com/s/files/Genoa.jpg?v=1'), 'a .jpg is not a passthrough GIF');
ok(!render.isGifUrl('file:///assets/HandFlower_Black.gif'), 'a file:// .gif is not emailable, so not passed through');
ok(!render.isGifUrl(''), 'empty URL is not a passthrough GIF');
ok(!render.isGifUrl('https://example.com/gif-explainer'), 'a path that merely contains "gif" is not a passthrough GIF');

// ── Component library: sample data covers every component (the gallery invariant) ─────
// For the interactive library, every component must produce a complete, on-brand sample that
// assembles with zero unfilled tokens and validates clean — so the gallery never shows an
// empty field or a casing violation, and new components are forced to keep sample data in step.
for (const c of schema.components) {
  const camp = sampleData.sampleCampaignFor(c);
  const rep = validateCampaign(camp, schema);
  eq(rep.ok, true, `sample for '${c.name}' validates clean (${rep.errorCount} errors: ${(rep.issues[0] || {}).message || ''})`);
  const { unfilled } = render.assemble(camp, { assetsBase: '/design-system/assets' });
  const leftover = unfilled.filter((u) => u.token !== '(missing template)');
  eq(leftover.length, 0, `sample for '${c.name}' leaves no unfilled tokens (${leftover.map((u) => u.token).join(',')})`);
}
// Variant axes are well-formed: palette presets come from the component, the lever is an enum.
const storyV = sampleData.variantsFor(schema.components.find((c) => c.name === 'blocks/story'));
ok(storyV.palettes.includes('noir'), 'story variant palettes include noir');
ok(storyV.lever && storyV.lever.name === 'TYPE_SCALE', 'story variant lever is the TYPE_SCALE enum');

// ── draft flag is surfaced on the schema (coverage lens + library badges rely on it) ──
const draftNames = schema.components.filter((c) => c.draft).map((c) => c.name).sort();
eq(draftNames.join(','), 'blocks/annotated-product,blocks/editorial-collage', 'exactly the two DRAFT blocks are flagged draft');
ok(schema.components.find((c) => c.name === 'header').draft === false, 'non-draft component is not flagged draft');

// ── blocks/journal-tile: live-HTML "From the Journal" row (2–3 linked article tiles) ──
const jt = schema.components.find((c) => c.name === 'blocks/journal-tile');
ok(jt, 'blocks/journal-tile appears in the schema');
if (jt) {
  // Expected token set, with the right derived types/cases.
  const jtTokens = new Set(jt.tokens.map((t) => t.name));
  const expectedJt = [
    'SECTION_LABEL', 'SECTION_HEADLINE',
    'TILE_1_IMAGE_URL', 'TILE_1_EYEBROW', 'TILE_1_TITLE', 'TILE_1_TEASER', 'TILE_1_LINK_URL',
    'TILE_2_IMAGE_URL', 'TILE_2_EYEBROW', 'TILE_2_TITLE', 'TILE_2_TEASER', 'TILE_2_LINK_URL',
    'TILE_3_IMAGE_URL', 'TILE_3_EYEBROW', 'TILE_3_TITLE', 'TILE_3_TEASER', 'TILE_3_LINK_URL',
  ];
  for (const t of expectedJt) ok(jtTokens.has(t), `journal-tile exposes token '${t}'`);
  eq(jtTokens.size, expectedJt.length, 'journal-tile exposes exactly the expected token set');
  const imgTok = jt.tokens.find((t) => t.name === 'TILE_1_IMAGE_URL');
  const linkTok = jt.tokens.find((t) => t.name === 'TILE_1_LINK_URL');
  const titleTok = jt.tokens.find((t) => t.name === 'TILE_1_TITLE');
  eq(imgTok && imgTok.type, 'image', '_IMAGE_URL token is typed image');
  eq(linkTok && linkTok.type, 'url', '_LINK_URL token is typed url');
  eq(titleTok && titleTok.case, 'sentence', 'TITLE token enforces sentence case');
  // Sliced multi-region block now (was live HTML): designed, not draft, with its intent metadata.
  eq(jt.designed, true, 'journal-tile is a designed/sliced block (multi-region)');
  eq(jt.draft, false, 'journal-tile is not flagged draft');
  ok(Array.isArray(jt.bestFor) && jt.bestFor.includes('editorial_digest'), 'journal-tile carries bestFor intent');

  // Assemble a full 3-tile campaign → validates clean, no residual tokens, 3 distinct hrefs.
  const jt3 = sampleData.sampleCampaignFor(jt);
  const jt3Rep = validateCampaign(jt3, schema);
  eq(jt3Rep.ok, true, '3-tile journal campaign validates clean');
  const out3 = render.assemble(jt3, { assetsBase: '/a' }).html;
  ok(!/\{\{[#/]?[A-Z0-9_]+\}\}/.test(out3), '3-tile render leaves no residual {{tokens}} or section markers');
  const tk = jt3.blocks[0].tokens;
  const hrefs3 = [tk.TILE_1_LINK_URL, tk.TILE_2_LINK_URL, tk.TILE_3_LINK_URL];
  for (const h of hrefs3) ok(out3.includes(`href="${h}"`), `3-tile render contains tile href ${h}`);
  eq(new Set(hrefs3).size, 3, '3-tile render has three distinct tile links');

  // Assemble with TILE_3_IMAGE_URL:"" → validates, renders a 2-up row, no broken third cell.
  const jt2 = sampleData.sampleCampaignFor(jt);
  jt2.blocks[0].tokens.TILE_3_IMAGE_URL = '';
  const jt2Rep = validateCampaign(jt2, schema);
  eq(jt2Rep.ok, true, '2-up journal campaign (blank TILE_3_IMAGE_URL) validates clean');
  const out2 = render.assemble(jt2, { assetsBase: '/a' }).html;
  ok(!/\{\{[#/]?[A-Z0-9_]+\}\}/.test(out2), '2-up render leaves no residual {{tokens}} or section markers');
  ok(out2.includes(`href="${tk.TILE_1_LINK_URL}"`) && out2.includes(`href="${tk.TILE_2_LINK_URL}"`), '2-up render keeps tiles 1 and 2');
  ok(!out2.includes(`href="${tk.TILE_3_LINK_URL}"`), '2-up render drops the third tile entirely');
  // The third tile (and its link) is gone — exactly two stacked tiles remain.
  eq((out2.match(/Read the piece/g) || []).length, 2, '2-up render shows exactly two tiles');
  eq((out2.match(/class="jt-img"/g) || []).length, 2, '2-up render keeps exactly two tile cards');

  // ── multi-region slicing markup: header + one region per tile, each with its own href/alt ──
  // Strip the leading doc comment first — it *documents* data-eb-* attrs as literal text, which
  // would otherwise inflate the counts. Only the real element markup should carry them.
  const strip = (h) => h.replace(/<!--[\s\S]*?-->/g, '');
  const out3m = strip(out3);
  const regionNames = [...out3m.matchAll(/data-eb-slice="([^"]+)"/g)].map((m) => m[1]);
  eq(regionNames.join(','), 'header,tile-1,tile-2,tile-3', '3-up marks header + 3 tile regions in DOM order');
  // Header region carries the section headline as alt and NO link; each tile carries its own href.
  ok(out3m.includes(`data-eb-slice="header" data-eb-alt="${tk.SECTION_HEADLINE}"`), 'header region alt = SECTION_HEADLINE');
  ok(!/data-eb-slice="header"[^>]*data-eb-href/.test(out3m), 'header region has no data-eb-href (unlinked)');
  const regionHrefs = [...out3m.matchAll(/data-eb-href="([^"]+)"/g)].map((m) => m[1]);
  eq(regionHrefs.join('|'), [tk.TILE_1_LINK_URL, tk.TILE_2_LINK_URL, tk.TILE_3_LINK_URL].join('|'), '3-up region hrefs are the three distinct tile links in order');
  eq(new Set(regionHrefs).size, 3, '3-up has three distinct region links');
  ok(out3m.includes(`data-eb-href="${tk.TILE_1_LINK_URL}" data-eb-alt="${tk.TILE_1_TITLE}"`), 'tile-1 region alt = TILE_1_TITLE');
  // Brand fonts are used now (Lust titles / NeuzeitGro body); the Georgia/Gill Sans stacks are gone.
  ok(/font-family:'Lust'/.test(out3m), 'journal-tile titles use Lust');
  ok(/font-family:'NeuzeitGro'/.test(out3m), 'journal-tile eyebrow/teaser use NeuzeitGro');
  ok(!/font-family:Georgia,/.test(out3m), 'journal-tile no longer uses the Georgia web-safe title stack');
  // 2-up drops the tile-3 region → exactly header + 2 tile regions.
  const region2 = [...strip(out2).matchAll(/data-eb-slice="([^"]+)"/g)].map((m) => m[1]);
  eq(region2.join(','), 'header,tile-1,tile-2', '2-up marks header + 2 tile regions (tile-3 region dropped)');
}

// ── Klaviyo push: html_only_components stay live HTML (not sliced) ─────────────────────
// Slicing flattens a block to one PNG with a single click-through — so blocks that must keep
// live anchors (opt-out's unsubscribe link, footer) stay html-only. blocks/journal-tile is NO
// LONGER html-only: it now rasterises as a multi-region slice (header + one linked slice per
// tile), which preserves its 2–3 per-tile links while restoring brand typography.
const htmlOnly = (schema.assembly && schema.assembly.html_only_components) || [];
ok(!htmlOnly.includes('journal-tile'), "manifest assembly.html_only_components no longer lists 'journal-tile'");
ok(!render.isHtmlOnlyComponent('blocks/journal-tile', htmlOnly), 'journal-tile is no longer html-only (it is sliced into per-region slices)');
ok(render.isHtmlOnlyComponent('sections/body-copy-plain', htmlOnly), 'body-copy-plain is html-only');
ok(render.isHtmlOnlyComponent('sections/opt-out', htmlOnly), 'opt-out is html-only (its live unsubscribe link must survive)');
ok(render.isHtmlOnlyComponent('footer', htmlOnly), 'footer is html-only');
ok(!render.isHtmlOnlyComponent('blocks/editorial-hero', htmlOnly), 'a designed/sliced block is not html-only');
ok(!render.isHtmlOnlyComponent('products/card-horizontal', htmlOnly), 'a product card is not html-only');
ok(!render.isHtmlOnlyComponent('', htmlOnly) && !render.isHtmlOnlyComponent('blocks/journal-tile', null), 'isHtmlOnlyComponent is null/empty safe');

// ── Empty CTA_TEXT drops the button (whole-component link survives via deriveLink) ────
// Authors can blank CTA_TEXT to hide the button. The block still validates (empty string is a
// provided value), the <a> button is omitted, and on publish the whole sliced block keeps a
// click-through to CTA_URL (deriveLink), so a buttonless component is still linkable.
for (const name of ['blocks/editorial-hero', 'blocks/image-text', 'heroes/hero-d-clay', 'sections/upsell-noir']) {
  const comp = schema.components.find((c) => c.name === name);
  ok(comp, `${name} present for empty-CTA test`);
  if (!comp) continue;
  // Button shown when CTA_TEXT is filled.
  const withCta = sampleData.sampleCampaignFor(comp);
  const onHtml = render.assemble(withCta, { assetsBase: '/a' }).html;
  ok(/<a href=/.test(onHtml), `${name}: button renders when CTA_TEXT is filled`);
  // Button hidden when CTA_TEXT is blank — and no residual tokens / markers leak.
  const blankCta = sampleData.sampleCampaignFor(comp);
  blankCta.blocks[0].tokens.CTA_TEXT = '';
  const offRep = validateCampaign(blankCta, schema);
  eq(offRep.ok, true, `${name}: blank CTA_TEXT still validates clean`);
  const offHtml = render.assemble(blankCta, { assetsBase: '/a' }).html;
  ok(!/href="\{\{CTA_URL\}\}"/.test(offHtml), `${name}: no half-filled button when CTA_TEXT blank`);
  ok(!/\{\{[#/]?CTA_(TEXT|URL)\}\}/.test(offHtml), `${name}: no residual CTA tokens/markers when blank`);
  const { unfilled } = render.assemble(blankCta, { assetsBase: '/design-system/assets' });
  eq(unfilled.filter((u) => u.token !== '(missing template)').length, 0, `${name}: blank CTA leaves no unfilled tokens`);
}
// On publish the whole block still links to CTA_URL even with no button.
eq(render.deriveLink({ CTA_URL: 'https://figandbloom.com.au/x' }), 'https://figandbloom.com.au/x',
  'deriveLink keeps the component-level click-through from CTA_URL');

// ── report ────────────────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n✗ ${failures.length} failure(s), ${passed} passed:\n`);
  for (const f of failures) console.error('  • ' + f);
  process.exit(1);
}
console.log(`\n✓ all ${passed} assertions passed\n`);

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
  SUBHEADLINE: 'Shop *now* before [they go](https://figandbloom.com/x).',
  CTA_TEXT: 'Shop', CTA_URL: 'https://x.com',
} }] }, { assetsBase: '/a' }).html;
ok(/<h1[^>]*>The last of the <strong>Rosehaven<\/strong> blooms<\/h1>/.test(mdHtml), 'bold renders in body text');
ok(/<em>now<\/em>/.test(mdHtml), 'italic renders in body text');
ok(/<a href="https:\/\/figandbloom\.com\/x">they go<\/a>/.test(mdHtml), 'link renders in body text');
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
  // Single component in isolation — no footer by construction, so the campaign-level
  // unsubscribe assertion doesn't apply (it's asserted on whole campaigns below).
  const rep = validateCampaign(camp, schema, { requireUnsubscribe: false });
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
// sections/trust-bar is draft for a different reason from the other two: its baked artwork
// carries a banned phrase and an unapproved delivery cut-off, so it must not ship until the
// PNG is replaced (the copy is inside the flattened image — no token can disable it).
eq(draftNames.join(','), 'blocks/annotated-product,blocks/editorial-collage,sections/trust-bar',
  'exactly the DRAFT components are flagged draft');
{
  const tb = fs.readFileSync(path.join(ROOT, 'design-system/templates/sections/trust-bar.html'), 'utf8');
  const altText = (tb.match(/alt="([^"]*)"/) || [])[1] || '';
  ok(!/perfect for every occasion/i.test(altText), 'trust-bar alt text drops the banned phrase');
  ok(!/same day|order before/i.test(altText), 'trust-bar alt text drops the unapproved delivery claim');
}
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
  const jt3Rep = validateCampaign(jt3, schema, { requireUnsubscribe: false });
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
  const jt2Rep = validateCampaign(jt2, schema, { requireUnsubscribe: false });
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
  const offRep = validateCampaign(blankCta, schema, { requireUnsubscribe: false });
  eq(offRep.ok, true, `${name}: blank CTA_TEXT still validates clean`);
  const offHtml = render.assemble(blankCta, { assetsBase: '/a' }).html;
  ok(!/href="\{\{CTA_URL\}\}"/.test(offHtml), `${name}: no half-filled button when CTA_TEXT blank`);
  ok(!/\{\{[#/]?CTA_(TEXT|URL)\}\}/.test(offHtml), `${name}: no residual CTA tokens/markers when blank`);
  const { unfilled } = render.assemble(blankCta, { assetsBase: '/design-system/assets' });
  eq(unfilled.filter((u) => u.token !== '(missing template)').length, 0, `${name}: blank CTA leaves no unfilled tokens`);
}
// On publish the whole block still links to CTA_URL even with no button.
eq(render.deriveLink({ CTA_URL: 'https://figandbloom.com/x' }), 'https://figandbloom.com/x',
  'deriveLink keeps the component-level click-through from CTA_URL');

// ── Column recomposition (a live GIF beside rasterised text, e.g. blocks/image-text) ──
// A layout:'cols' block must come back as ONE row of side-by-side cells — stacking (or the
// old behaviour, dropping the text column entirely) loses the designed 2/3+1/3 layout.
{
  const klaviyo = require('../lib/klaviyo');
  const row = klaviyo.columnRow([
    { url: 'https://cdn.example/text-col.png', widthPx: 200, pct: 33.33, bg: '#000000' },
    { url: 'https://cdn.example/anim.gif', widthPx: 400, pct: 66.67, bg: '#000000' },
  ], { href: 'https://figandbloom.com/collections/bouquets', alt: 'Something new' });
  ok(/text-col\.png/.test(row) && /anim\.gif/.test(row), 'columnRow keeps both the PNG text column and the live GIF');
  ok(row.indexOf('text-col.png') < row.indexOf('anim.gif'), 'columnRow preserves left-to-right column order');
  ok((row.match(/<td width="33\.33%"/).length && /<td width="66\.67%"/.test(row)), 'columnRow cells carry proportional percentage widths (mobile scales, not stacks)');
  ok((row.match(/<a href=/g) || []).length === 2, 'both columns carry the block click-through');
  ok((row.match(/bgcolor="#000000"/g) || []).length === 2, 'block background rides along to absorb column height differences');
  ok(/^<tr><td[^>]*><table width="100%"/.test(row) && (row.match(/<tr>/g) || []).length === 2, 'columnRow is a single outer row wrapping one inner row');
  const single = klaviyo.columnRow([{ url: 'https://cdn.example/x.gif', widthPx: 600, pct: 100, bg: '' }], {});
  ok(!/bgcolor/.test(single) && !/<a /.test(single), 'columnRow omits bgcolor and link when absent');
}

// ── Brand domain: figandbloom.com is canonical; .com.au redirects to it ────────────────
// A .com.au link resolves, just via a 301, so nothing looks broken in review and it ships.
// Exemplars are what the generator imitates, which is how one stray host propagates.
{
  const jt = schema.components.find((c) => c.name === 'blocks/journal-tile');
  const withUrl = (url) => {
    const c = sampleData.sampleCampaignFor(jt);
    c.blocks[0].tokens.TILE_1_LINK_URL = url;
    return validateCampaign(c, schema, { requireUnsubscribe: false }).issues
      .filter((i) => i.type === 'wrong_domain');
  };

  const bad = withUrl('https://figandbloom.com.au/blogs/journal/x');
  eq(bad.length, 1, 'a .com.au link is flagged as wrong_domain');
  eq(bad[0].suggestion, 'https://figandbloom.com/blogs/journal/x', 'the suggestion drops the .au');
  eq(bad[0].severity, 'error', 'wrong_domain is an error');

  eq(withUrl('https://figandbloom.com/blogs/journal/x').length, 0, 'the canonical host passes');
  eq(withUrl('https://cdn.shopify.com/s/files/x.jpg').length, 0, 'third-party hosts are not policed');
  eq(withUrl('https://notfigandbloom.com.au/x').length, 0, 'a lookalike host is not ours to police');
  eq(withUrl('{{ unsubscribe_url }}').length, 0, 'a merge tag is not treated as a URL');

  // Every shipped exemplar and every sample is on the canonical host — these are the two
  // surfaces the generator copies from, so a regression here spreads.
  for (const ex of seeds) {
    eq(validateCampaign(ex.campaign, schema).issues.filter((i) => i.type === 'wrong_domain').length, 0,
      `exemplar '${ex.id}' uses only canonical Fig & Bloom links`);
  }
  for (const c of schema.components) {
    eq(validateCampaign(sampleData.sampleCampaignFor(c), schema, { requireUnsubscribe: false })
      .issues.filter((i) => i.type === 'wrong_domain').length, 0,
      `'${c.name}' sample uses only canonical Fig & Bloom links`);
  }

  // No reference to the legacy .com.au domain anywhere in the shipped source — links, email
  // addresses, config defaults, prose. Nothing is served from it, so any pointer is a pointer
  // at a redirect nobody owns. lib/validate.js is exempt: it implements this rule and has to
  // name the host it rejects.
  // Root-level config and docs count too — a stale default in render.yaml is exactly the kind
  // of pointer that outlives the code change it describes.
  for (const f of ['server.js', 'render.yaml', 'README.md', 'Dockerfile', 'package.json']) {
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) continue;
    const hits = fs.readFileSync(full, 'utf8').match(/figandbloom\.com\.au/g) || [];
    eq(hits.length, 0, `${f} has no reference to the legacy .com.au domain`);
  }

  for (const dir of ['examples', 'lib', 'design-system', 'public', 'docs']) {
    const stack = [path.join(ROOT, dir)];
    while (stack.length) {
      const cur = stack.pop();
      for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) { stack.push(full); continue; }
        if (!/\.(js|json|md|html|css)$/.test(e.name)) continue;
        const txt = fs.readFileSync(full, 'utf8');
        if (full.endsWith(path.join('lib', 'validate.js'))) continue;
        const hits = txt.match(/figandbloom\.com\.au/g) || [];
        eq(hits.length, 0, `${path.relative(ROOT, full)} has no reference to the legacy .com.au domain`);
      }
    }
  }
}

// ── Outlook degradation: report the real exposure, not every use of unsupported CSS ────
// Outlook lays out with Word, which silently drops a known set of CSS. But most blocks that
// lean on it are rasterised to a PNG on publish, so Outlook never sees the CSS at all. A report
// that flags those is noise; the exposure is the intersection of "stays live HTML" and
// "declares unsupported CSS" and "has no VML fallback".
{
  const risk = (name) => render.outlookRisks({ blocks: [{ component: name, tokens: {} }] })[0];

  // A designed block: leans hard on unsupported CSS, but ships as a PNG, so it is not at risk.
  const pc = risk('blocks/polaroid-collage');
  ok(pc, 'the collage is detected as using unsupported CSS');
  ok(pc.unsupported.some((u) => u.property === 'position:absolute'), 'position:absolute is detected');
  eq(pc.rasterisedOnPublish, true, 'the collage is rasterised on publish');
  eq(pc.atRisk, false, 'a rasterised block is not reported at risk — Outlook gets a PNG');

  // Live HTML + a VML fallback: covered.
  const btn = risk('sections/button');
  eq(btn.rasterisedOnPublish, false, 'the button stays live HTML');
  eq(btn.hasVmlFallback, true, 'the button ships a VML fallback');
  eq(btn.atRisk, false, 'a VML-covered block is not reported at risk');

  // text-transform is supported by Word and must not be confused for transform — otherwise
  // every component with an uppercase micro-label is reported broken.
  // body-copy-plain still sets text-transform on its micro-label but is otherwise clean, so a
  // false match here would be its *only* reported risk — which makes it the sharpest guard.
  const bcp = risk('sections/body-copy-plain');
  ok(!bcp || !bcp.unsupported.some((u) => u.property === 'transform'),
    'text-transform is not mistaken for transform');
  ok(/text-transform/.test(fs.readFileSync(path.join(DS, 'templates/sections/body-copy-plain.html'), 'utf8')),
    '…and that component really does use text-transform (guards the guard)');

  // The degradation stylesheet neutralises the properties rather than deleting markup.
  const html = render.assemble({ blocks: [{ component: 'blocks/polaroid-collage', tokens: {} }] }, { assetsBase: '/a' }).html;
  const degraded = render.applyOutlookDegradation(html);
  ok(/position:\s*static\s*!important/.test(degraded), 'degradation forces position:static');
  ok(/transform:\s*none\s*!important/.test(degraded), 'degradation forces transform:none');
  ok(degraded.includes('{{PHOTO_1_URL}}') === html.includes('{{PHOTO_1_URL}}'), 'degradation does not alter content');
  ok(degraded.length > html.length, 'degradation only adds a stylesheet');

  // A CSS button is the commonest Outlook failure and a property scan misses it: Word drops
  // padding + display:inline-block on an <a>, collapsing the button to underlined text.
  ok(btn.unsupported.some((u) => u.property === 'padding on <a>'),
    'a padded <a> is detected as an Outlook risk');

  // Documentation comments are not markup. Every template opens with a COMPONENT/TOKENS/RULES
  // block that discusses these very properties, so a component explaining "fixed-width table,
  // not max-width" would otherwise report itself broken.
  ok(!render.outlookRisks({ blocks: [{ component: 'sections/opt-out', tokens: {} }] })[0]
      .unsupported.some((u) => u.property === 'max-width'),
    'max-width named in a doc comment is not counted as markup');

  // …but the downlevel-revealed branch IS markup, and its opening marker ends in a bare `<!--`
  // that a naive comment strip runs past, swallowing the very <a> it reveals.
  ok(render.outlookRisks({ blocks: [{ component: 'sections/button', tokens: {} }] })[0]
      .unsupported.some((u) => u.property === 'padding on <a>'),
    'markup inside a downlevel-revealed block is still scanned');

  // max-width on an element that also carries a width="…" attribute cannot degrade — Word
  // honours the attribute. sections/full-width-image measures 600px with and without the cap.
  const fwi = render.outlookRisks({ blocks: [{ component: 'sections/full-width-image', tokens: {} }] })[0];
  ok(!fwi || !fwi.unsupported.some((u) => u.property === 'max-width'),
    'max-width alongside a width attribute is not reported — it cannot degrade');

  // The at-risk set is pinned exactly. Every entry is a decision someone made; a new one means
  // a block that ships as live HTML picked up CSS Word drops, which is the regression this
  // whole report exists to catch. It is currently empty, and should stay that way.
  const schemaCampaign = { blocks: schema.components.map((c) => ({ component: c.name, tokens: {} })) };
  const atRisk = render.outlookRisks(schemaCampaign).filter((r) => r.atRisk);
  eq(atRisk.map((r) => `${r.component}: ${r.unsupported.map((u) => u.property).sort().join('+')}`).sort().join(' | '),
    '', 'no component is exposed to the Outlook renderer');
}

// ── The two components that were exposed, and how they were closed ────────────────────
// sections/opt-out is the one that mattered: its control is the way out of Mother's Day and
// memorial sends, and in Outlook it rendered as unstyled text that did not read as a link.
{
  const tpl = (n) => fs.readFileSync(path.join(DS, 'templates/sections', n + '.html'), 'utf8');

  const oo = tpl('opt-out');
  ok(/<v:roundrect[\s\S]*?href="\{\{UNSUBSCRIBE_URL\}\}"/.test(oo) || /<v:roundrect[\s\S]*?\{\{UNSUBSCRIBE_URL\}\}/.test(oo),
    'the opt-out button ships a VML roundrect carrying the unsubscribe URL');
  ok(/strokecolor="#000000"/.test(oo), 'the VML keeps the outline (not filled) button style');
  ok(/<!--\[if !gte mso 9\]><!-->[\s\S]*<a href[\s\S]*<!--<!\[endif\]-->/.test(oo),
    'the opt-out <a> is hidden from Outlook so the button never renders twice');

  // Both measures are fixed-width tables now, not max-width caps that Word discards.
  for (const [name, width] of [['opt-out', 380], ['body-copy-plain', 440]]) {
    const t = tpl(name);
    ok(new RegExp(`<table width="${width}"`).test(t), `${name} constrains its measure with a ${width}px table`);
    ok(!/max-width/.test(t.replace(/<!--[\s\S]*?-->/g, '')), `${name} no longer relies on a max-width cap`);
  }

  // The unsubscribe mechanism still survives assembly — the whole point of the block.
  const camp = { campaignName: 't', blocks: [{ component: 'sections/opt-out', tokens: {
    OPT_OUT_HEADLINE: 'a gentle note', OPT_OUT_BODY: 'x', UNSUBSCRIBE_URL: '{{ unsubscribe_url }}',
  } }] };
  // Counted as hrefs: the template's own TOKENS comment also mentions the tag, and assembly
  // substitutes tokens inside comments too, so a raw count of the merge tag reads 4.
  const prod = render.assemble(camp, { assetsBase: '/a', production: true }).html;
  eq((prod.match(/href="\{\{ unsubscribe_url \}\}"/g) || []).length, 2,
    'both the VML and the <a> link to the unsubscribe merge tag');
  eq(validateCampaign(camp, schema).ok, true, 'an opt-out block still satisfies the unsubscribe assertion');
}

// ── sections/button: a standalone CTA that survives publish and Outlook ───────────────
// Every other component bakes its CTA in, so there was no way to put a button after a text
// section. The two ways a standalone button dies are (a) publish rasterises it, turning the
// href into a flat image, and (b) Outlook's Word renderer drops padding on an <a>, collapsing
// it to underlined text. Both are pinned here.
{
  const btn = schema.components.find((c) => c.name === 'sections/button');
  ok(btn, 'sections/button is in the schema');
  eq(btn.designed, false, 'the button is not a DESIGNED (sliced) block');
  eq(btn.static, false, 'the button has editable tokens');

  // Must be html-only on push, or the Klaviyo slice flattens it to a PNG and the link dies.
  ok(render.isHtmlOnlyComponent('sections/button', schema.assembly.html_only_components),
    'the button is html-only on push, so its href survives');

  const camp = sampleData.sampleCampaignFor(btn);
  const html = render.assemble(camp, { assetsBase: '/a' }).html;

  // Outlook fallback: VML draws the button, and the <a> is hidden from Outlook so only one renders.
  ok(/<!--\[if gte mso 9\]>[\s\S]*<v:roundrect[\s\S]*<!\[endif\]-->/.test(html),
    'a VML roundrect is emitted for Outlook');
  ok(/arcsize="0%"/.test(html), 'the Outlook button is square, matching the brand style');
  ok(/<!--\[if !gte mso 9\]><!-->[\s\S]*<a href[\s\S]*<!--<!\[endif\]-->/.test(html),
    'the <a> is hidden from Outlook so the button never renders twice');
  const vml = (html.match(/<v:roundrect[\s\S]*?<\/v:roundrect>/) || [''])[0];
  ok(vml.includes(camp.blocks[0].tokens.CTA_URL), 'the VML button carries the same href as the <a>');
  ok(vml.includes(camp.blocks[0].tokens.CTA_TEXT), 'the VML button carries the same label as the <a>');

  // ALIGN drives the HTML attribute too — Outlook positions on `align`, not text-align.
  const aligned = (a) => {
    const c = sampleData.sampleCampaignFor(btn);
    c.blocks[0].tokens.ALIGN = a;
    return render.assemble(c, { assetsBase: '/a' }).html;
  };
  for (const a of ['center', 'left', 'right']) {
    const h = aligned(a);
    ok(h.includes(`align="${a}"`), `ALIGN=${a} sets the align attribute (Outlook)`);
    ok(h.includes(`text-align:${a}`), `ALIGN=${a} sets text-align (everyone else)`);
  }
  const lever = btn.tokens.find((t) => t.name === 'ALIGN');
  eq(lever && (lever.enumOptions || []).join(','), 'center,left,right', 'ALIGN is a locked enum');

  // The noir preset flips the button to white-on-black; light presets stay black-on-white.
  const presetOf = (name) => {
    const c = sampleData.sampleCampaignFor(btn, { palette: name });
    return c.blocks[0].tokens;
  };
  eq(presetOf('noir').BTN_BG, '#ffffff', 'noir flips the button background to white');
  eq(presetOf('noir').BTN_TEXT, '#000000', 'noir flips the button label to black');
  eq(presetOf('clay').BTN_BG, '#000000', 'light presets keep the black button');

  // Padding frames the block (the polaroid lesson — pin the element, not just the height).
  const c2 = sampleData.sampleCampaignFor(btn);
  c2.blocks[0].tokens.PADDING_TOP = '100px'; c2.blocks[0].tokens.PADDING_BOTTOM = '10px';
  ok(/padding:100px 48px 10px;/.test(render.assemble(c2, { assetsBase: '/a' }).html),
    'the padding tokens frame the button cell');
}

// ── blocks/comparison-vs: desaturating the left photo is opt-in, never automatic ──────
// The block used to hard-code filter:grayscale(100%) on LEFT_IMAGE_URL, so a neutral A-vs-B
// comparison silently rendered the author's own product in black and white.
{
  const cvs = schema.components.find((c) => c.name === 'blocks/comparison-vs');
  const lever = cvs.tokens.find((t) => t.name === 'LEFT_TREATMENT');
  ok(lever, 'comparison-vs exposes a LEFT_TREATMENT token');
  eq(lever && lever.type, 'enum', 'LEFT_TREATMENT is a locked enum');
  eq(lever && (lever.enumOptions || []).join(','), 'none,grayscale', 'LEFT_TREATMENT options are none / grayscale');
  eq(lever && lever.default, 'none', 'LEFT_TREATMENT defaults to none (no silent desaturation)');

  const imgTag = (html) => (html.match(/<img[^>]*cvs-left-img[^>]*>/) || [])[0] || '';
  const camp = sampleData.sampleCampaignFor(cvs);
  const neutral = render.assemble(camp, { assetsBase: '/a' }).html;
  ok(/class="cvs treat-none"/.test(neutral), 'default treatment renders treat-none');
  ok(!/grayscale/.test(imgTag(neutral)), 'the left image carries no inline grayscale filter');

  // Omitting the token entirely (an existing saved campaign) still assembles at the default.
  const omitted = JSON.parse(JSON.stringify(camp));
  delete omitted.blocks[0].tokens.LEFT_TREATMENT;
  ok(/class="cvs treat-none"/.test(render.assemble(omitted, { assetsBase: '/a' }).html),
    'a campaign predating the token falls back to treat-none');
  eq(validateCampaign(omitted, schema, { requireUnsubscribe: false }).ok, true,
    'a campaign predating the token still validates');

  // Opting in restores the us-vs-them treatment.
  const grey = JSON.parse(JSON.stringify(camp));
  grey.blocks[0].tokens.LEFT_TREATMENT = 'grayscale';
  const greyHtml = render.assemble(grey, { assetsBase: '/a' }).html;
  ok(/class="cvs treat-grayscale"/.test(greyHtml), 'grayscale treatment renders treat-grayscale');
  ok(/\.cvs\.treat-grayscale \.cvs-left-img \{ filter:grayscale\(100%\); \}/.test(greyHtml),
    'the grayscale rule is present for the rasteriser to bake in');
}

// ── Alt text: every content image describes itself when images are blocked ────────────
// A content image is one whose src comes from a maker-supplied token ({{…_URL}}) — those must
// carry alt text derived from a descriptive token. Brand illustrations served from
// {{ASSETS_BASE}} stay alt="" (decorative), as does dividers/divider-image (a visual pause).
{
  const DECORATIVE = new Set(['dividers/divider-image']);
  for (const c of schema.components) {
    const html = fs.readFileSync(path.join(ROOT, c.file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    for (const tag of html.match(/<img[\s\S]*?>/g) || []) {
      const src = (tag.match(/src="([^"]*)"/) || [])[1] || '';
      if (!/^\{\{[A-Z0-9_]+\}\}$/.test(src)) continue;      // {{ASSETS_BASE}} illustration → decorative
      if (DECORATIVE.has(c.name)) continue;
      const alt = (tag.match(/alt="([^"]*)"/) || [])[1];
      ok(alt !== undefined && /\{\{[A-Z0-9_]+\}\}/.test(alt),
        `'${c.name}': content image ${src} must take alt from a descriptive token (got alt="${alt}")`);
    }
  }

  // End to end: the sample polaroid collage renders each photo's caption as its alt text.
  const pcComp = schema.components.find((c) => c.name === 'blocks/polaroid-collage');
  const pcHtml = render.assemble(sampleData.sampleCampaignFor(pcComp), { assetsBase: '/a' }).html;
  for (const caption of ['thank you,', 'with love,', 'thinking of you,']) {
    ok(pcHtml.includes(`alt="${caption}"`), `polaroid photo carries alt="${caption}" from its caption token`);
  }
  ok(!/<img[^>]*src="https[^"]*"[^>]*alt=""/.test(pcHtml), 'no content image in the collage ships alt=""');
}

// ── Locked enums: an off-list lever value must be rejected, not silently ignored ──────
// The levers drive CSS class names (`illo-{{ACCENT_ILLO}}`), so an off-list value matches no
// rule and reads as "off" — a silent, confusing no-op. Every enum token is checked.
{
  const pc = schema.components.find((c) => c.name === 'blocks/polaroid-collage');
  const bad = sampleData.sampleCampaignFor(pc);
  bad.blocks[0].tokens.ACCENT_ILLO = 'none';                 // documented enum is "on" / "off"
  const rep = validateCampaign(bad, schema, { requireUnsubscribe: false });
  const enumIssue = rep.issues.find((i) => i.type === 'invalid_enum' && i.token === 'ACCENT_ILLO');
  ok(enumIssue, 'off-list enum value is flagged as invalid_enum');
  eq(enumIssue && enumIssue.severity, 'error', 'invalid_enum is an error');
  eq(enumIssue && enumIssue.value, 'none', 'invalid_enum reports the offending value');
  eq(enumIssue && (enumIssue.options || []).join(','), 'on,off', 'invalid_enum lists the locked options');
  ok(enumIssue && ['on', 'off'].includes(enumIssue.suggestion), 'invalid_enum suggests a real option');
  eq(rep.ok, false, 'a campaign with an off-list enum value does not validate');
  eq(rep.blocks[0].valid, false, 'the offending block is marked invalid');

  // Case-sensitive: the templates lower-case the class names, so "On" is not "on".
  const cased = sampleData.sampleCampaignFor(pc);
  cased.blocks[0].tokens.ROTATION = 'Subtle';
  ok(validateCampaign(cased, schema, { requireUnsubscribe: false }).issues
      .some((i) => i.type === 'invalid_enum' && i.token === 'ROTATION'), 'wrong-case enum value is flagged');

  // A blank enum is invalid too — it renders a dangling `dens-` class.
  const blank = sampleData.sampleCampaignFor(pc);
  blank.blocks[0].tokens.DENSITY = '';
  ok(validateCampaign(blank, schema, { requireUnsubscribe: false }).issues
      .some((i) => i.type === 'invalid_enum' && i.token === 'DENSITY'), 'blank enum value is flagged');

  // Every enum token in the schema enforces its own options (not just the polaroid levers).
  for (const c of schema.components) {
    for (const t of c.tokens) {
      if (t.type !== 'enum' || !(t.enumOptions || []).length) continue;
      const camp = sampleData.sampleCampaignFor(c);
      camp.blocks[0].tokens[t.name] = '__not_an_option__';
      ok(validateCampaign(camp, schema, { requireUnsubscribe: false }).issues
          .some((i) => i.type === 'invalid_enum' && i.token === t.name),
        `'${c.name}'.${t.name} rejects an off-list value`);
    }
  }
  // …and the on-list values still pass (no false positives from the sample data).
  for (const c of schema.components) {
    const camp = sampleData.sampleCampaignFor(c);
    ok(!validateCampaign(camp, schema, { requireUnsubscribe: false }).issues.some((i) => i.type === 'invalid_enum'),
      `'${c.name}' sample uses only on-list enum values`);
  }
}

// ── The collage's padding tokens move the BLOCK's outer edges, not the pull-quote band ──
// Padding the quote's interior only moves the quote down inside an unchanged block. An author
// reaching for PADDING_TOP wants the clay above the polaroids and below the attribution — the
// component's own frame. Pin the element it lands on so it can't drift back inward.
{
  const pc = schema.components.find((c) => c.name === 'blocks/polaroid-collage');
  const camp = sampleData.sampleCampaignFor(pc);
  camp.blocks[0].tokens.PADDING_TOP = '100px';
  camp.blocks[0].tokens.PADDING_BOTTOM = '30px';
  const html = render.assemble(camp, { assetsBase: '/a' }).html;

  // Anchored to the cell that wraps the collage — the block has an outer wrapper cell too,
  // and matching that one would pass while the tokens went nowhere.
  const frameCell = /<td style="padding:([^;]+);background:#D8CCBE;">\s*<!-- Collage region/;
  eq((html.match(frameCell) || [])[1], '100px 0 30px',
    'the padding tokens land on the block cell, framing the whole component');
  const quote = (html.match(/<div class="pc-quote" style="[^"]*"/) || [])[0] || '';
  ok(/padding:40px 72px 0;/.test(quote), 'the quote band keeps its fixed collage-to-quote rhythm');
  ok(!/100px|30px/.test(quote), 'no padding token is applied to the quote band');

  // Both edges move independently — a regression that wired only one would still pass a
  // whole-block height check, so assert each edge separately.
  const framed = (pt, pb) => {
    const c = sampleData.sampleCampaignFor(pc);
    c.blocks[0].tokens.PADDING_TOP = pt; c.blocks[0].tokens.PADDING_BOTTOM = pb;
    return (render.assemble(c, { assetsBase: '/a' }).html.match(frameCell) || [])[1];
  };
  eq(framed('0', '0'), '0 0 0', 'zero padding collapses the frame');
  eq(framed('120px', '0'), '120px 0 0', 'the top edge moves on its own');
  eq(framed('0', '120px'), '0 0 120px', 'the bottom edge moves on its own');
}

// ── Dimension tokens: a unitless value must be rejected, not silently rendered as 0 ────
// PADDING_TOP interpolates straight into a CSS shorthand. A bare "100" produces
// `padding:100 0 50px`, which is invalid, so the browser drops the whole declaration and the
// padding renders as 0. Nothing errors and the block just looks unchanged — the exact symptom
// that makes an author think the lever does nothing.
{
  const pc = schema.components.find((c) => c.name === 'blocks/polaroid-collage');
  const padTokens = pc.tokens.filter((t) => t.name.startsWith('PADDING_'));
  eq(padTokens.length, 2, 'the collage exposes both padding tokens');
  for (const t of padTokens) eq(t.type, 'length', `${t.name} is typed as a CSS length`);

  const bare = sampleData.sampleCampaignFor(pc);
  bare.blocks[0].tokens.PADDING_TOP = '100';
  const rep = validateCampaign(bare, schema, { requireUnsubscribe: false });
  const lenIssue = rep.issues.find((i) => i.type === 'invalid_length' && i.token === 'PADDING_TOP');
  ok(lenIssue, 'a unitless dimension is flagged as invalid_length');
  eq(lenIssue && lenIssue.severity, 'error', 'invalid_length is an error');
  eq(lenIssue && lenIssue.value, '100', 'invalid_length reports the offending value');
  eq(lenIssue && lenIssue.suggestion, '100px', 'invalid_length suggests the value with a unit');
  eq(rep.ok, false, 'a campaign with a unitless dimension does not validate');
  eq(rep.blocks[0].valid, false, 'the offending block is marked invalid');

  // Junk that isn't even a number is rejected, with no bogus suggestion.
  const junk = sampleData.sampleCampaignFor(pc);
  junk.blocks[0].tokens.PADDING_BOTTOM = 'lots';
  const jIssue = validateCampaign(junk, schema, { requireUnsubscribe: false })
    .issues.find((i) => i.type === 'invalid_length' && i.token === 'PADDING_BOTTOM');
  ok(jIssue, 'a non-numeric dimension is flagged');
  eq(jIssue && jIssue.suggestion, undefined, 'no suggestion is offered when none can be derived');

  // Valid units — and bare 0, which is legal CSS — all pass.
  for (const good of ['0', '40px', '2.5rem', '10%', '1em']) {
    const camp = sampleData.sampleCampaignFor(pc);
    camp.blocks[0].tokens.PADDING_TOP = good;
    ok(!validateCampaign(camp, schema, { requireUnsubscribe: false }).issues
        .some((i) => i.type === 'invalid_length'), `"${good}" is accepted as a CSS length`);
  }

  // Every length token in the schema enforces units, and no sample trips a false positive.
  for (const c of schema.components) {
    for (const t of c.tokens) {
      if (t.type !== 'length') continue;
      const camp = sampleData.sampleCampaignFor(c);
      camp.blocks[0].tokens[t.name] = '12';
      ok(validateCampaign(camp, schema, { requireUnsubscribe: false }).issues
          .some((i) => i.type === 'invalid_length' && i.token === t.name),
        `'${c.name}'.${t.name} rejects a unitless value`);
    }
    const camp = sampleData.sampleCampaignFor(c);
    ok(!validateCampaign(camp, schema, { requireUnsubscribe: false }).issues.some((i) => i.type === 'invalid_length'),
      `'${c.name}' sample uses only valid CSS lengths`);
  }

  // The builder's client-side check must agree with the server's, or the UI warns on values the
  // validator accepts (or worse, stays silent on ones it rejects).
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const clientRe = (appJs.match(/ok:\s*v\s*=>\s*\/([^/]+)\/\.test/) || [])[1];
  const serverRe = (fs.readFileSync(path.join(__dirname, '..', 'lib', 'validate.js'), 'utf8')
    .match(/const LENGTH_RE\s*=\s*\/([^/]+)\//) || [])[1];
  ok(clientRe && serverRe && clientRe === serverRe, 'the builder and the validator share one length rule');
}

// ── Unsubscribe compliance: the footer tag must survive to production HTML ────────────
// Klaviyo does NOT inject an unsubscribe link into a CODE-editor template, so the literal
// {% unsubscribe %} block tag has to reach the exported HTML. The preview substitution
// (readable "unsubscribe here" text) is for the on-screen iframe only.
{
  const footerCampaign = { campaignName: 'T', blocks: [{ component: 'footer', tokens: {} }] };
  const prod = render.assemble(footerCampaign, { assetsBase: '/a', production: true }).html;
  ok(prod.includes('{% unsubscribe %}'), 'production assembly keeps the literal {% unsubscribe %} tag');
  ok(!prod.includes('unsubscribe here'), 'production assembly does not carry the inert preview text');
  const prev = render.assemble(footerCampaign, { assetsBase: '/a' }).html;
  ok(prev.includes('unsubscribe here'), 'preview assembly still substitutes readable text');
  ok(!prev.includes('{% unsubscribe %}'), 'preview assembly has no raw merge tag');

  // The validator fails a campaign with no unsubscribe mechanism, and passes one with a footer.
  const noUnsub = validateCampaign({ blocks: [{ component: 'sections/section-headline',
    tokens: sampleData.sampleTokensFor(schema.components.find((c) => c.name === 'sections/section-headline')) }] }, schema);
  const unsubIssue = noUnsub.issues.find((i) => i.type === 'missing_unsubscribe');
  ok(unsubIssue, 'a campaign with no unsubscribe tag is flagged');
  eq(unsubIssue && unsubIssue.severity, 'error', 'missing_unsubscribe is an error, not a warning');
  eq(noUnsub.ok, false, 'a campaign with no unsubscribe tag does not validate');

  const withFooter = validateCampaign({ blocks: [
    { component: 'sections/section-headline', tokens: sampleData.sampleTokensFor(schema.components.find((c) => c.name === 'sections/section-headline')) },
    { component: 'footer', tokens: {} },
  ] }, schema);
  ok(!withFooter.issues.some((i) => i.type === 'missing_unsubscribe'), 'a campaign carrying the footer is not flagged');
  eq(withFooter.ok, true, 'a campaign carrying the footer validates clean');

  // sections/opt-out's {{ unsubscribe_url }} merge tag satisfies the assertion too.
  const optOut = schema.components.find((c) => c.name === 'sections/opt-out');
  const withOptOut = validateCampaign({ blocks: [{ component: 'sections/opt-out', tokens: sampleData.sampleTokensFor(optOut) }] }, schema);
  ok(!withOptOut.issues.some((i) => i.type === 'missing_unsubscribe'), 'opt-out\'s {{ unsubscribe_url }} satisfies the unsubscribe assertion');

  // Every shipped exemplar must be sendable — this is the gate that stops a non-compliant
  // reference campaign propagating to everything copied from it.
  for (const ex of seeds) {
    const rep = validateCampaign(ex.campaign, schema);
    ok(!rep.issues.some((i) => i.type === 'missing_unsubscribe'), `exemplar '${ex.id}' carries an unsubscribe tag`);
  }
}

// ── report ────────────────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n✗ ${failures.length} failure(s), ${passed} passed:\n`);
  for (const f of failures) console.error('  • ' + f);
  process.exit(1);
}
console.log(`\n✓ all ${passed} assertions passed\n`);

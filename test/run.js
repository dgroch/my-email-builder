'use strict';
// Zero-dependency test runner: `npm test`. Covers the guardrails called out in the backend
// task spec plus the new agent-facing surfaces (intent metadata, objective taxonomy,
// teaching validation, examples). Exits non-zero on the first batch of failures.

const fs = require('fs');
const path = require('path');

const os = require('os');

const ROOT = path.join(__dirname, '..');
const DS = path.join(ROOT, 'design-system');

// The Studio stores are disk-backed and read DATA_DIR when they load, so point them at a
// scratch directory before anything requires them — a test run must never touch real designs.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-studio-test-'));

const { buildSchema } = require('../lib/parseTemplates');
const { OBJECTIVES, OBJECTIVE_GUIDANCE, COMPONENT_INTENT } = require('../lib/componentStrategy');
const { validateCampaign } = require('../lib/validate');
const { loadSeedExamples } = require('../lib/examples');
const render = require('../lib/render');
const glyphs = require('../lib/glyphs');
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
  if (c.authored) continue; // authored components resolve to a published version, not a file
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

// ── Responsive assembly contract: 600px desktop, fluid/stacked mobile structure ───────
// These are the three Week 1 candidate module families that exposed the shared overflow,
// assembled through the real renderer with the shared header/footer. This is deliberately a
// structural (non-browser) gate: runtime 390px measurements belong to the approved renderer lane.
{
  const componentNames = [
    'header',
    'blocks/image-text',
    'sections/body-copy-plain',
    'blocks/designed-product-card',
    'sections/section-headline',
    'products/card-horizontal',
    'products/card-horizontal-reversed',
    'footer',
  ];
  const blocks = componentNames.map((name) => {
    const component = schema.components.find((c) => c.name === name);
    ok(component, `responsive fixture component '${name}' exists`);
    return component ? sampleData.sampleCampaignFor(component).blocks[0] : { component: name, tokens: {} };
  });
  const assembled = render.assemble({
    campaignName: 'Responsive structural fixture',
    bodyBg: '#2c2825',
    blocks,
  }, { assetsBase: '/design-system/assets' });
  eq(assembled.unfilled.length, 0, 'responsive fixture assembles with no unfilled tokens');

  const markup = render.stripDocComments(assembled.html);
  const fixedTables = [...markup.matchAll(/<table\b[^>]*\bwidth="600"[^>]*>/gi)].map((m) => m[0]);
  ok(fixedTables.length > componentNames.length, 'fixture contains nested 600px structural tables');
  for (const tag of fixedTables) {
    ok(/\bclass="[^"]*\b(?:ew|f600)\b[^"]*"/i.test(tag),
      `every 600px structural table opts into the root or nested fluid contract: ${tag.slice(0, 100)}`);
  }
  ok(/<table\b[^>]*class="[^"]*\bew\b[^"]*"[^>]*width="600"[^>]*style="[^"]*width:600px;max-width:600px/i.test(markup),
    'desktop root retains its 600px width attribute, inline width and max-width fallback');

  const fullWidthImages = [...markup.matchAll(/<img\b[^>]*\bwidth="600"[^>]*>/gi)].map((m) => m[0]);
  ok(fullWidthImages.length > 0, 'fixture contains shared full-width footer images');
  for (const tag of fullWidthImages) {
    ok(/\bclass="[^"]*\bfimg\b[^"]*"/i.test(tag) || /\bstyle="[^"]*\bwidth:\s*100%/i.test(tag),
      `every 600px image has an explicit fluid-image contract: ${tag.slice(0, 100)}`);
  }

  ok(/<table\b[^>]*class="[^"]*\bfm\b[^"]*"[^>]*width="440"/i.test(markup)
      || /<table\b[^>]*width="440"[^>]*class="[^"]*\bfm\b/i.test(markup),
    'the 440px body-copy measure becomes fluid on narrow screens without losing its desktop width');
  eq((markup.match(/class="[^"]*\bitc\b[^"]*"/g) || []).length, 2,
    'image-text marks both columns for mobile stacking');
  ok(/class="[^"]*\biti\b[^"]*"/.test(markup), 'image-text marks its structural image for fluid mobile sizing');
  eq((markup.match(/class="[^"]*\bdpcc\b[^"]*"/g) || []).length, 2,
    'designed-product-card marks both columns for mobile stacking');
  ok(/class="[^"]*\bhi\b[^"]*"/.test(markup) && /class="[^"]*\bhinfo\b[^"]*"/.test(markup),
    'horizontal product cards preserve their existing mobile stack classes');

  for (const shellName of ['shell-preview.html', 'shell-production.html']) {
    const shell = fs.readFileSync(path.join(DS, 'shell', shellName), 'utf8');
    const mediaStart = shell.indexOf('@media only screen and (max-width:600px)');
    const media = mediaStart < 0 ? '' : shell.slice(mediaStart, shell.indexOf('</style>', mediaStart));
    ok(/\.f600\s*\{[^}]*width:\s*100%\s*!important;[^}]*max-width:\s*100%\s*!important;[^}]*\}/.test(media),
      `${shellName} makes only opted-in 600px structural tables fluid`);
    ok(/\.fm\s*\{[^}]*width:\s*100%\s*!important;[^}]*\}/.test(media),
      `${shellName} fluidises opted-in fixed text measures`);
    ok(/\.itc\s*\{[^}]*display:\s*block\s*!important;[^}]*width:\s*100%\s*!important;[^}]*\}/.test(media),
      `${shellName} stacks image-text columns`);
    ok(/\.iti\s*\{[^}]*width:\s*100%\s*!important;[^}]*height:\s*auto\s*!important;[^}]*\}/.test(media),
      `${shellName} scales the image-text image without clipping`);
    ok(/\.dpcc\s*\{[^}]*display:\s*block\s*!important;[^}]*width:\s*100%\s*!important;[^}]*\}/.test(media),
      `${shellName} stacks designed-product-card columns`);
    ok(/\.hi\s+img\s*\{[^}]*width:\s*100%\s*!important;[^}]*height:\s*240px\s*!important;[^}]*\}/.test(media),
      `${shellName} fills the existing 240px stacked product-image cell`);
    ok(!/(?:^|\n)\s*(?:table|img|a)(?:\b|\[)/m.test(media),
      `${shellName} does not globally resize semantic tables, images or CTA anchors`);
  }

  const buttonComponent = schema.components.find((c) => c.name === 'sections/button');
  const buttonHtml = render.assemble(sampleData.sampleCampaignFor(buttonComponent), { assetsBase: '/a' }).html;
  ok(/<a\b[^>]*display:inline-block[^>]*>/.test(buttonHtml),
    'intrinsically sized live CTA remains an inline-block control');
}

// ── Dark mode: the production shell declares itself light-only ────────────────────────────
// iOS/Apple Mail and Gmail auto-invert colours in dark mode, but they only invert LIVE HTML —
// images are never touched. Our push is a mix (designed blocks rasterise to image slices,
// html_only_components ship as live HTML), so without an opt-out the email goes patchwork:
// a live black band under a black hero slice rendered WHITE, and the white promo-code block
// rendered dark. Declaring the email light-only is the standard opt-out from auto-inversion.
const prodShell = fs.readFileSync(path.join(render.DS, 'shell', 'shell-production.html'), 'utf8');
ok(/<meta\s+name="color-scheme"\s+content="light"\s*\/?>/.test(prodShell),
  'production shell declares <meta name="color-scheme" content="light">');
ok(/<meta\s+name="supported-color-schemes"\s+content="light"\s*\/?>/.test(prodShell),
  'production shell declares <meta name="supported-color-schemes" content="light">');
ok(/color-scheme\s*:\s*light/.test(prodShell),
  'production shell CSS carries a color-scheme:light declaration (clients that read the property, not the meta)');
// And it survives assembly — the built email, not just the file on disk, carries the opt-out.
const litEmail = render.wrapProductionShell('<tr><td>x</td></tr>', { campaignName: 'x' });
ok(/<meta\s+name="color-scheme"\s+content="light"\s*\/?>/.test(litEmail),
  'built production email carries the color-scheme:light meta through wrapProductionShell');

// ── Klaviyo push: html_only_components stay live HTML (not sliced) ─────────────────────
// Slicing flattens a block to one PNG with a single click-through — and bakes whatever text the
// block contains into pixels. So blocks stay html-only when they need live anchors (opt-out's
// unsubscribe link, footer) OR dynamic Klaviyo tags rendered as text (promo-code's
// {% coupon_code %} box, substituted per recipient at send time). blocks/journal-tile is NO
// LONGER html-only: it now rasterises as a multi-region slice (header + one linked slice per
// tile), which preserves its 2–3 per-tile links while restoring brand typography.
const htmlOnly = (schema.assembly && schema.assembly.html_only_components) || [];
ok(!htmlOnly.includes('journal-tile'), "manifest assembly.html_only_components no longer lists 'journal-tile'");
ok(!render.isHtmlOnlyComponent('blocks/journal-tile', htmlOnly), 'journal-tile is no longer html-only (it is sliced into per-region slices)');
ok(render.isHtmlOnlyComponent('sections/body-copy-plain', htmlOnly), 'body-copy-plain is html-only');
ok(render.isHtmlOnlyComponent('sections/opt-out', htmlOnly), 'opt-out is html-only (its live unsubscribe link must survive)');
ok(render.isHtmlOnlyComponent('footer', htmlOnly), 'footer is html-only');
ok(render.isHtmlOnlyComponent('sections/promo-code', htmlOnly), 'promo-code is html-only (Klaviyo must inject {% coupon_code %} into live text, not pixels)');

// ── Live-HTML blocks must not ship their author comment to Klaviyo ────────────────────────
// html_only blocks are pushed as raw HTML, and Klaviyo parses template tags even inside HTML
// comments. promo-code's RULES line documents the merge tag as prose; shipped raw, that bare
// `{% coupon_code %}` (no coupon name) is invalid and Klaviyo fails the WHOLE template with
// 400 "The template could not be rendered with the provided context." stripDocComments() has
// to remove the doc comment while leaving the Outlook conditionals and tokens untouched.
const promoRaw = fs.readFileSync(path.join(render.DS, 'templates', 'sections', 'promo-code.html'), 'utf8');
const promoDoc = (promoRaw.match(/^<!--[\s\S]*?-->/) || [''])[0];
ok(/coupon_code/.test(promoDoc), "promo-code's doc comment does contain a coupon_code tag (the hazard this strip exists for)");
const promoStripped = render.stripDocComments(promoRaw);
ok(!/\{%\s*coupon_code\s*%\}/.test(promoStripped), 'stripDocComments removes the bare {% coupon_code %} that would 400 the whole Klaviyo template');
ok(/\[if gte mso 9\]/.test(promoStripped), 'stripDocComments keeps the [if gte mso 9] conditional (real VML, not a doc comment)');
ok(/<v:roundrect/.test(promoStripped), 'stripDocComments keeps the VML roundrect markup inside the conditional');
ok(/\{\{CTA_URL\}\}/.test(promoStripped), 'stripDocComments leaves {{CTA_URL}} tokens intact');
const footerStripped = render.stripDocComments(fs.readFileSync(path.join(render.DS, 'templates', 'footer.html'), 'utf8'));
ok((footerStripped.match(/\{%\s*unsubscribe\s*%\}/g) || []).length === 1,
  'footer ships exactly one {% unsubscribe %} after stripping — the live one, not the duplicate its doc comment describes');
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
    ok(new RegExp(`<table[^>]*\\bwidth="${width}"`).test(t), `${name} constrains its measure with a ${width}px table`);
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
  ok(/class="[^"]*\bcvs\b[^"]*\btreat-none\b/.test(neutral), 'default treatment renders treat-none');
  ok(!/grayscale/.test(imgTag(neutral)), 'the left image carries no inline grayscale filter');

  // Omitting the token entirely (an existing saved campaign) still assembles at the default.
  const omitted = JSON.parse(JSON.stringify(camp));
  delete omitted.blocks[0].tokens.LEFT_TREATMENT;
  ok(/class="[^"]*\bcvs\b[^"]*\btreat-none\b/.test(render.assemble(omitted, { assetsBase: '/a' }).html),
    'a campaign predating the token falls back to treat-none');
  eq(validateCampaign(omitted, schema, { requireUnsubscribe: false }).ok, true,
    'a campaign predating the token still validates');

  // Opting in restores the us-vs-them treatment.
  const grey = JSON.parse(JSON.stringify(camp));
  grey.blocks[0].tokens.LEFT_TREATMENT = 'grayscale';
  const greyHtml = render.assemble(grey, { assetsBase: '/a' }).html;
  ok(/class="[^"]*\bcvs\b[^"]*\btreat-grayscale\b/.test(greyHtml), 'grayscale treatment renders treat-grayscale');
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

  // A bare number is a UNIT SLIP, not a wrong value: the validator already knew the intended
  // unit well enough to suggest it, so assembly coerces it to px and the report says so. It is
  // a warning, and the campaign still validates — rejecting it outright was pointlessly strict.
  const bare = sampleData.sampleCampaignFor(pc);
  bare.blocks[0].tokens.PADDING_TOP = '100';
  const rep = validateCampaign(bare, schema, { requireUnsubscribe: false });
  const lenIssue = rep.issues.find((i) => i.type === 'coerced_length' && i.token === 'PADDING_TOP');
  ok(lenIssue, 'a unitless dimension is flagged as coerced_length');
  eq(lenIssue && lenIssue.severity, 'warning', 'coerced_length is a warning, not an error');
  eq(lenIssue && lenIssue.value, '100', 'coerced_length reports the offending value');
  eq(lenIssue && lenIssue.suggestion, '100px', 'coerced_length suggests the value with a unit');
  eq(rep.ok, true, 'a campaign with a unitless dimension still validates');
  eq(rep.blocks[0].valid, true, 'a warning does not mark the block invalid');
  ok(!rep.issues.some((i) => i.type === 'invalid_length'), 'a bare number is no longer an invalid_length error');

  // …and the coercion is real: the assembled CSS carries the unit, so the declaration survives
  // instead of being dropped whole and rendering as 0.
  const coerced = render.assemble(bare, { assetsBase: '/a' }).html;
  ok(/padding:\s*100px\b/.test(coerced), 'assembly coerces a unitless dimension to px');
  ok(!/padding:\s*100\s/.test(coerced), 'no unitless value survives into the CSS shorthand');

  // BTN_WIDTH accepts `auto` — an Outlook-only VML width, resolved to a real px value sized to
  // the label, because Word cannot shrink-wrap a roundrect and every other client already does.
  const btn = schema.components.find((c) => c.name === 'sections/button');
  const autoCamp = sampleData.sampleCampaignFor(btn);
  autoCamp.blocks[0].tokens.BTN_WIDTH = 'auto';
  autoCamp.blocks[0].tokens.CTA_TEXT = 'Shop the collection';
  const autoRep = validateCampaign(autoCamp, schema, { requireUnsubscribe: false });
  ok(!autoRep.issues.some((i) => i.token === 'BTN_WIDTH'), 'BTN_WIDTH accepts "auto"');
  const autoHtml = render.assemble(autoCamp, { assetsBase: '/a' }).html;
  const vmlWidth = (autoHtml.match(/width:(\d+)px;v-text-anchor/) || [])[1];
  ok(vmlWidth && Number(vmlWidth) > 120, `"auto" resolves the VML width to the label (got ${vmlWidth}px)`);
  ok(!/width:auto/.test(autoHtml), '"auto" never reaches the VML, which cannot interpret it');
  // A shorter label gets a narrower button — the point of asking for auto in the first place.
  const shortCamp = sampleData.sampleCampaignFor(btn);
  shortCamp.blocks[0].tokens.BTN_WIDTH = 'auto';
  shortCamp.blocks[0].tokens.CTA_TEXT = 'Shop';
  const shortWidth = (render.assemble(shortCamp, { assetsBase: '/a' }).html.match(/width:(\d+)px;v-text-anchor/) || [])[1];
  ok(Number(shortWidth) < Number(vmlWidth), 'a shorter label yields a narrower auto button');
  // `auto` is a WIDTH keyword; it is meaningless in a padding shorthand and stays rejected there.
  const badAuto = sampleData.sampleCampaignFor(btn);
  badAuto.blocks[0].tokens.PADDING_TOP = 'auto';
  ok(validateCampaign(badAuto, schema, { requireUnsubscribe: false }).issues
      .some((i) => i.type === 'invalid_length' && i.token === 'PADDING_TOP'),
    'PADDING_TOP does not accept "auto"');

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

  // Every length token in the schema notices a missing unit, and no sample trips a false positive.
  for (const c of schema.components) {
    for (const t of c.tokens) {
      if (t.type !== 'length') continue;
      const camp = sampleData.sampleCampaignFor(c);
      camp.blocks[0].tokens[t.name] = '12';
      ok(validateCampaign(camp, schema, { requireUnsubscribe: false }).issues
          .some((i) => i.type === 'coerced_length' && i.token === t.name),
        `'${c.name}'.${t.name} reports a unitless value as coerced`);
      ok(/:\s*(?:[^;]*\s)?12px\b/.test(render.assemble(camp, { assetsBase: '/a' }).html),
        `'${c.name}'.${t.name} renders a unitless value as px rather than dropping the rule`);
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

// ── Inbox preview: preheader baked into the shells + human alt text ───────────────────
// Klaviyo does not inject preview_text into CODE-editor templates, so the snippet Gmail /
// Apple Mail show is whatever text they scrape first from the body. These guards keep that
// text ours: a hidden preheader ahead of everything, and alt text that is copy, never slugs.
{
  const klaviyo = require('../lib/klaviyo');

  for (const s of ['shell-preview.html', 'shell-production.html']) {
    const src = fs.readFileSync(path.join(DS, 'shell', s), 'utf8');
    ok(src.includes('{{PREHEADER}}'), `${s} carries the {{PREHEADER}} slot`);
    ok(src.indexOf('{{PREHEADER}}') < src.indexOf('{{COMPONENTS}}'), `${s} preheader sits before the components`);
  }

  const ph = render.preheader('Knowing what to send & when <3');
  ok(ph.includes('display:none'), 'preheader div is hidden');
  ok(ph.includes('mso-hide:all'), 'preheader div is hidden for Outlook');
  ok(ph.includes('Knowing what to send &amp; when &lt;3'), 'preheader text is HTML-escaped');
  ok((ph.match(/&zwnj;&nbsp;/g) || []).length >= 80, 'preheader pads the snippet so body text cannot trail the preview line');
  eq(render.preheader(''), '', 'blank preview text produces no preheader div');
  eq(render.preheader('   '), '', 'whitespace-only preview text produces no preheader div');

  const wrapped = render.wrapProductionShell('<tr><td>x</td></tr>', { campaignName: 'n', previewText: 'The intended line' });
  ok(wrapped.includes('The intended line'), 'production shell carries the baked preview text');
  ok(!wrapped.includes('{{PREHEADER}}'), 'production shell has no unfilled PREHEADER token');
  const bare = render.wrapProductionShell('<tr><td>x</td></tr>', { campaignName: 'n' });
  ok(!bare.includes('{{PREHEADER}}'), 'production shell without preview text still fills the slot');
  const asmPrev = render.assemble({ blocks: [] }, {}).html;
  ok(!asmPrev.includes('{{PREHEADER}}'), 'preview assembly fills the PREHEADER slot');
  const asmProd = render.assemble({ blocks: [] }, { production: true, previewText: 'Line for export' }).html;
  ok(asmProd.includes('Line for export'), 'production assembly bakes the export preview text');
  ok(asmProd.indexOf('Line for export') < asmProd.indexOf('<table'), 'preheader sits ahead of all body content');

  eq(render.deriveAlt({ CAPTION: 'peonies are back', SUPER_LABEL: 'FLOWER OF THE MONTH' }), 'peonies are back',
    'deriveAlt prefers real copy (caption)');
  eq(render.deriveAlt({ SUPER_LABEL: 'FROM THE JOURNAL' }), 'FROM THE JOURNAL', 'deriveAlt falls back to the super label');
  eq(render.deriveAlt({ HEADLINE: '**When** the card is *hard*' }), 'When the card is hard', 'deriveAlt flattens markdown (alt is an attribute)');
  eq(render.deriveAlt({}), '', 'a block with no copy tokens gets an empty (decorative) alt, never a slug');

  // Regression guard: the push handler derives alt from copy tokens, never the component name —
  // "blocks/caption-bar-hero" leading a sent campaign's Gmail snippet is the bug this pins down.
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(serverSrc.includes('render.deriveAlt('), 'server push path uses render.deriveAlt');
  ok(!/HEADLINE\s*\|\|\s*b\.component/.test(serverSrc), 'server push path no longer falls back to the component name for alt');

  let threw = null;
  try { klaviyo.assertSendReady({ subject: '', previewText: 'x' }); } catch (e) { threw = e; }
  ok(threw && /subject/i.test(threw.message), 'a draft with no subject line is refused');
  threw = null;
  try { klaviyo.assertSendReady({ subject: 'x', previewText: '  ' }); } catch (e) { threw = e; }
  ok(threw && /preview/i.test(threw.message), 'a draft with no preview text is refused');
  threw = null;
  try { klaviyo.assertSendReady({ subject: "When you don't know what to send", previewText: 'Knowing what to send, and when.' }); } catch (e) { threw = e; }
  ok(!threw, 'a real subject + preview pass the send-ready guard');

  // Exemplars are the fallback source for subject/preview on push — they must carry both.
  for (const ex of seeds) {
    ok(ex.subjectLine && String(ex.subjectLine).trim(), `exemplar '${ex.id}' carries a subjectLine`);
    ok(ex.previewText && String(ex.previewText).trim(), `exemplar '${ex.id}' carries previewText`);
  }
}

// ══ Studio: authoring, compiling, versioning and publishing components ═══════════════════
//
// The load-bearing claim of the Studio is that a designer-authored component is not a special
// case: it compiles to the same artefact a hand-written template is, and every downstream
// consumer therefore handles it unchanged. These assertions hold that claim up.
// Driver is chosen by DATABASE_URL exactly as it is in production, so `npm test` covers the
// disk driver and `DATABASE_URL=… npm test` runs the identical assertions against Postgres.
async function studioSuite() {
  const { compileComponent } = require('../lib/compileComponent');
  const componentStore = require('../lib/componentStore');
  const templateSource = require('../lib/templateSource');
  const brandTokens = require('../lib/brandTokens');
  const layoutStore = require('../lib/layoutStore');
  const db = require('../lib/db');
  const driver = db.enabled ? 'postgres' : 'disk';
  eq(componentStore.backend, driver, `component store uses the ${driver} driver`);
  eq(layoutStore.backend, driver, `layout store uses the ${driver} driver`);

  // A Postgres run reuses one database, so start from a clean slate rather than inheriting
  // records from a previous run.
  if (db.enabled) await db.query('TRUNCATE studio_components, studio_layouts, studio_brand, designs');
  await componentStore.refresh();
  await brandTokens.refresh();

  const docFor = (over = {}) => ({
    mode: 'designed',
    canvas: { height: 520, background: '#ffffff' },
    elements: [
      { id: 'i1', type: 'image', name: 'Hero', x: 0, y: 0, w: 600, h: 400, token: 'HERO_IMAGE_URL', src: 'https://example.com/a.jpg', alt: 'A bouquet' },
      { id: 'p1', type: 'panel', name: 'Plate', x: 70, y: 300, w: 460, padding: 36, bgKey: '#ffffff', borderKey: 'border', borderWidth: 1, rotation: -2 },
      { id: 't1', type: 'text', name: 'Script', parent: 'p1', order: 0, typeStyle: 'script-m', content: 'with love,', token: 'ACCENT_SCRIPT', align: 'center' },
      { id: 't2', type: 'text', name: 'Headline', parent: 'p1', order: 1, typeStyle: 'display-m', tag: 'h1', content: 'When the card is the hard part', token: 'HEADLINE', align: 'center' },
      { id: 'b1', type: 'button', name: 'CTA', parent: 'p1', order: 2, label: 'Shop the range', labelToken: 'CTA_TEXT', urlToken: 'CTA_URL', url: 'https://figandbloom.com' },
    ],
    ...over,
  });

  // ── the round-trip: compiled output parses back as a first-class component ─────────────
  const compiled = compileComponent(docFor(), { name: 'blocks/studio-spec', title: 'Studio spec', version: 1 });
  eq(compiled.errorCount, 0, 'a well-formed canvas compiles without errors');

  const withAuthored = buildSchema(DS, {
    extraTemplates: [{ name: 'blocks/studio-spec', html: compiled.html, version: 1, id: 'ctest-000001' }],
  });
  const parsed = withAuthored.components.find((c) => c.name === 'blocks/studio-spec');
  ok(parsed, 'an authored component appears in the derived schema');
  ok(parsed.authored, 'the schema marks it authored');
  ok(parsed.designed, 'a designed-mode component is flagged DESIGNED BLOCK by its header');
  ok(!parsed.draft, 'a published component header does not read as DRAFT');
  ok(!parsed.static, 'a component with tokens is not flagged static');

  const tok = (n) => parsed.tokens.find((t) => t.name === n);
  ok(tok('HERO_IMAGE_URL'), 'the image slot survives the round-trip');
  eq(tok('HERO_IMAGE_URL').type, 'image', 'an _URL image slot is typed as an image field');
  eq(tok('ACCENT_SCRIPT').case, 'lower', 'a Cervanttis slot carries the lowercase case rule');
  eq(tok('HEADLINE').case, 'sentence', 'a Lust slot carries the Sentence case rule');
  eq(tok('CTA_URL').type, 'url', 'a URL slot is typed as a url field');

  // ── invariants the compiler applies so a person cannot forget them ─────────────────────
  ok(/font-family:'Cervanttis'[^"]*padding-bottom:0\.65em/.test(compiled.html),
    'script text is compiled with the 0.65em descender padding (the overlap bug cannot be authored)');
  ok(/\{\{#CTA_TEXT\}\}[\s\S]*\{\{\/CTA_TEXT\}\}/.test(compiled.html),
    'a tokenised button compiles inside its conditional section, so a blank label drops the button');
  ok(/rotate\(-2deg\)/.test(compiled.html), 'rotation survives in a designed (rasterised) block');
  ok(/font-family:'Lust'/.test(compiled.html), 'the display role resolves to the locked Lust stack');

  // ── guardrails that must fire ─────────────────────────────────────────────────────────
  const liveRot = compileComponent(docFor({ mode: 'live' }), { name: 'sections/x', mode: 'live', version: 1 });
  ok(liveRot.warnings.some((w) => w.code === 'live_rotation' && w.level === 'error'),
    'rotation in a live-HTML component is an error, not a silent no-op');

  const noAlt = compileComponent({
    mode: 'designed', canvas: { height: 200 },
    elements: [{ id: 'i', type: 'image', name: 'Photo', w: 600, h: 200, src: 'x.jpg' }],
  }, { name: 'blocks/y', version: 1 });
  ok(noAlt.warnings.some((w) => w.code === 'missing_alt'), 'an image with no alt text is flagged');

  const badCase = compileComponent({
    mode: 'designed', canvas: { height: 100 },
    elements: [{ id: 't', type: 'text', name: 'S', typeStyle: 'script-m', content: 'With Love,' }],
  }, { name: 'blocks/z', version: 1 });
  ok(badCase.warnings.some((w) => w.code === 'case_violation'), 'capitals in a Cervanttis line are flagged');

  const badToken = compileComponent({
    mode: 'designed', canvas: { height: 100 },
    elements: [{ id: 't', type: 'text', name: 'T', typeStyle: 'body-m', content: 'x', token: 'bad name!' }],
  }, { name: 'blocks/z2', version: 1 });
  ok(badToken.errorCount > 0, 'an invalid token name is a compile error');

  const overflow = compileComponent({
    mode: 'designed', canvas: { height: 100 },
    elements: [{ id: 'i', type: 'image', name: 'Tall', x: 0, y: 0, w: 600, h: 400, src: 'x.jpg', alt: 'a' }],
  }, { name: 'blocks/z3', version: 1 });
  ok(overflow.warnings.some((w) => w.code === 'overflow'), 'content past the canvas bottom is flagged as cropped');

  // ── store: versions are immutable, publishing is reversible ───────────────────────────
  const rec0 = await componentStore.create({ title: 'Studio spec', group: 'blocks', slug: 'studio-spec', mode: 'designed' });
  eq(rec0.name, 'blocks/studio-spec', 'a new component takes its group/slug name');
  eq(rec0.status, 'draft', 'a new component starts as a draft');
  eq(rec0.publishedVersion, null, 'a new component publishes nothing');

  await componentStore.saveDoc(rec0.id, { doc: docFor() });
  ok(!templateSource.resolve('blocks/studio-spec'), 'an unpublished draft is invisible to campaigns');

  const v1 = await componentStore.cutVersion(rec0.id, compileComponent(docFor(), { name: 'blocks/studio-spec', version: 1 }), 'first');
  eq(v1.version, 1, 'the first cut version is v1');
  ok(!templateSource.resolve('blocks/studio-spec'), 'cutting a version still does not publish it');

  await componentStore.publish(rec0.id, 1);
  const resolved = templateSource.resolve('blocks/studio-spec');
  ok(resolved && resolved.source === 'authored', 'a published component resolves for campaigns');
  eq(resolved.version, 1, 'it resolves to the published version');

  // Edit and publish again — the point of versioning is that v1 keeps rendering as it did.
  // The v2 edit has to be one that reaches the compiled markup. Changing tokenised *copy*
  // would not: it compiles to {{HEADLINE}} either way, and the assertion below would hold
  // whether or not pinning worked.
  const docV2 = docFor();
  docV2.elements.find((e) => e.id === 'p1').rotation = -6;
  await componentStore.saveDoc(rec0.id, { doc: docV2 });
  await componentStore.cutVersion(rec0.id, compileComponent(docV2, { name: 'blocks/studio-spec', version: 2 }), 'reworded');
  await componentStore.publish(rec0.id, 2);
  eq(templateSource.resolve('blocks/studio-spec').version, 2, 'the newest published version wins by default');
  const pinned = templateSource.resolve('blocks/studio-spec@1');
  ok(pinned && pinned.version === 1, 'a version-pinned reference still resolves to the old version');
  ok(/rotate\(-2deg\)/.test(pinned.html) && !/rotate\(-6deg\)/.test(pinned.html),
    'publishing v2 does not rewrite v1 — a campaign built against v1 renders as it was built');
  ok(/rotate\(-6deg\)/.test(templateSource.resolve('blocks/studio-spec').html),
    'and the unpinned reference does pick up the newly published version');

  // Unpublishing is the escape hatch that makes every upgrade reversible without a deploy.
  await componentStore.unpublish(rec0.id);
  ok(!templateSource.resolve('blocks/studio-spec'), 'unpublishing withdraws the component from campaigns');
  ok(templateSource.resolve('blocks/studio-spec@1'), 'a pinned version keeps resolving after unpublish');
  await componentStore.publish(rec0.id, 2);

  // A component that has ever shipped is archived rather than deleted, so pinned versions live.
  await componentStore.remove(rec0.id);
  eq((await componentStore.get(rec0.id)).status, 'archived', 'a previously-published component is archived, not deleted');
  ok(templateSource.resolve('blocks/studio-spec@2'), 'its published versions still resolve after archiving');

  // ── shadowing a shipped component (the "upgrade the library" half of the brief) ────────
  const shippedHtml = templateSource.resolve('sections/button');
  ok(shippedHtml && shippedHtml.source === 'disk', 'a shipped component resolves from disk by default');
  const up = await componentStore.create({ title: 'Button', group: 'sections', slug: 'button', mode: 'live', shadowsShipped: true });
  eq(up.name, 'sections/button', 'an upgrade keeps the shipped name rather than being renamed aside');
  const upDoc = {
    mode: 'live', canvas: { height: 120, background: '#ffffff' },
    elements: [{ id: 'b', type: 'button', name: 'CTA', label: 'Shop', labelToken: 'CTA_TEXT', urlToken: 'CTA_URL', order: 0 }],
  };
  await componentStore.saveDoc(up.id, { doc: upDoc });
  await componentStore.cutVersion(up.id, compileComponent(upDoc, { name: 'sections/button', mode: 'live', version: 1 }), 'upgrade');
  await componentStore.publish(up.id, 1);
  eq(templateSource.resolve('sections/button').source, 'authored', 'a published upgrade overrides the shipped template');
  ok(templateSource.htmlOnlyExtras().includes('button'),
    'a live-HTML authored component joins the html-only list, so the push keeps it as real markup');
  await componentStore.unpublish(up.id);
  eq(templateSource.resolve('sections/button').source, 'disk', 'unpublishing reverts to the shipped template');

  // ── an authored component actually assembles into a campaign ──────────────────────────
  const authoredCampaign = {
    campaignName: 'Studio spec',
    blocks: [{
      component: 'blocks/studio-spec@2',
      tokens: { HERO_IMAGE_URL: 'https://example.com/a.jpg', ACCENT_SCRIPT: 'with love,', HEADLINE: 'A headline', CTA_TEXT: 'Shop', CTA_URL: 'https://figandbloom.com' },
    }],
  };
  const asm = render.assemble(authoredCampaign, { assetsBase: '/design-system/assets' });
  eq(asm.unfilled.length, 0, 'a campaign using an authored component assembles with no unfilled tokens');
  ok(/A headline/.test(asm.html), 'the campaign copy reaches the assembled HTML');
  ok(!/\{\{[A-Z0-9_]+\}\}/.test(asm.html.split('COMPONENTS_END')[0].split('COMPONENTS_START')[1] || ''),
    'no residual {{tokens}} survive assembly of an authored component');

  // ── brand primitives ──────────────────────────────────────────────────────────────────
  const base = brandTokens.getBrand();
  eq(base.colours.clay, '#D8CCBE', 'the brand baseline comes from the manifest locked_styles');
  await brandTokens.setBrand({ colours: { clay: '#CCBBAA', not_a_colour: '#123456', border: 'chartreuse' } });
  const edited = brandTokens.getBrand();
  eq(edited.colours.clay, '#CCBBAA', 'a valid palette override is applied');
  ok(!('not_a_colour' in edited.colours), 'an unknown palette key is rejected, not invented');
  eq(edited.colours.border, base.colours.border, 'a non-hex value is rejected rather than written through');
  ok(edited.overridden.colours.includes('clay'), 'the override is reported as changed from the baseline');
  ok(brandTokens.affectedBy('clay').length > 0, 'the blast radius of a palette change is knowable before publishing');
  await brandTokens.setBrand({ colours: { clay: '#D8CCBE' } });
  ok(!brandTokens.getBrand().overridden.colours.includes('clay'),
    'setting a colour back to its baseline clears the override rather than pinning it');

  // A palette edit has to reach components that were compiled before it — including shipped
  // templates, which are static files nobody rewrites. That works because a compiled template
  // always speaks the *baseline* palette and the override is applied at assembly.
  const clayDoc = { mode: 'designed', canvas: { height: 100 }, elements: [{ id: 'p', type: 'panel', name: 'P', w: 600, h: 80, bgKey: 'clay' }] };
  await brandTokens.setBrand({ colours: { clay: '#112233' } });
  const clayCompiled = compileComponent(clayDoc, { name: 'blocks/clay', version: 1 }).html;
  ok(/#D8CCBE/i.test(clayCompiled) && !/#112233/.test(clayCompiled),
    'a compiled template bakes the baseline colour, never the current override — so a published version never needs rewriting');
  ok(/#112233/.test(brandTokens.applyOverrides(clayCompiled)),
    'the override is applied at assembly, so a component compiled before the edit still picks it up');

  const shippedClay = fs.readFileSync(path.join(DS, 'templates', 'sections', 'three-column-steps-clay.html'), 'utf8');
  ok(/#112233/.test(brandTokens.applyOverrides(shippedClay)),
    'a palette edit reaches shipped templates too, which is what the Brand tab promises');

  // Sequential per-colour replacement would cascade here: clay's override is clay_50's
  // baseline, so a second pass would rewrite what the first pass just wrote.
  await brandTokens.setBrand({ colours: { clay: '#EBE5DF', clay_50: '#00ff00' } });
  const cascade = brandTokens.applyOverrides('<i>#D8CCBE</i><b>#EBE5DF</b>');
  ok(/#EBE5DF/i.test(cascade) && /#00ff00/i.test(cascade),
    'overrides are applied in one pass, so one colour mapping onto another does not cascade');

  await brandTokens.resetBrand();
  eq(brandTokens.applyOverrides('<i>#D8CCBE</i>'), '<i>#D8CCBE</i>',
    'resetting the brand restores the shipped value everywhere');

  // ── layouts ───────────────────────────────────────────────────────────────────────────
  const lay = await layoutStore.create({
    name: 'Range launch — photo-led', objective: 'range_launch',
    blocks: [{ component: 'header' }, { component: 'heroes/hero-a' }, { component: 'footer' }, { component: '' }],
  });
  eq(lay.blocks.length, 3, 'a layout drops empty block entries');
  eq(lay.status, 'draft', 'a new layout starts as a draft');
  const layCampaign = layoutStore.toCampaign(lay);
  eq(layCampaign.blocks.length, 3, 'a layout opens as a campaign skeleton');
  ok(layCampaign.blocks.every((b) => b.tokens && Object.keys(b.tokens).length === 0),
    'a layout carries structure only — no copy');
  await layoutStore.remove(lay.id);
  ok(!await layoutStore.get(lay.id), 'a layout can be deleted');

  // Durability is the whole point of the Postgres driver: prove a record written through the
  // store is really in the table, not just in the in-memory snapshot.
  if (db.enabled) {
    const fresh = await componentStore.create({ title: 'Durability probe', group: 'blocks', mode: 'designed' });
    const row = await db.query('SELECT id, name, status FROM studio_components WHERE id = $1', [fresh.id]);
    eq(row.rows.length, 1, 'a created component is a real row in Postgres');
    eq(row.rows[0].name, fresh.name, 'the promoted name column matches the record');
    await componentStore.remove(fresh.id);
    const gone = await db.query('SELECT id FROM studio_components WHERE id = $1', [fresh.id]);
    eq(gone.rows.length, 0, 'deleting a never-published component removes the row');
    await db.query('TRUNCATE studio_components, studio_layouts, studio_brand, designs');
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════
// Defects from the 9 Sep render review. Every one of these shipped past a green
// /api/validate, an empty `unfilled`, and an empty `brokenImages` — the theme of that report
// was that the API reported success on emails that were visibly wrong. So each fix below is
// pinned by a test that would have caught it.
// ══════════════════════════════════════════════════════════════════════════════════════

// ── Bug 1: heroes/hero-b-* replace the header; pairing them renders two logo bars ──────
// hero-b-* draw their own logo bar tinted to the band colour. Every saved design that uses one
// puts it at index 0 with no header at all and depends on that bar, so the bar stays and the
// PAIRING is the error. The documented order ("header ← always first") had to gain the
// exception, and /api/validate now enforces it.
{
  const LOGO = /F_B_Logo_Horizontal/g;
  const heroes = schema.components.filter((c) => c.group === 'heroes');
  ok(heroes.length >= 12, `every hero variant is present (found ${heroes.length})`);

  for (const hero of heroes) {
    const blocks = [
      { component: 'header', tokens: {} },
      sampleData.sampleCampaignFor(hero).blocks[0],
      { component: 'footer', tokens: {} },
    ];
    const html = render.assemble({ campaignName: 'logo probe', blocks }, { assetsBase: '/a' }).html;
    const bars = (html.match(LOGO) || []).length;
    const headerReplacing = /^heroes\/hero-b-/.test(hero.name);
    const report = validateCampaign({ campaignName: 'logo probe', blocks }, schema);
    const dupe = report.issues.find((i) => i.type === 'duplicate_logo_bar');

    if (headerReplacing) {
      // The pairing is rejected, and the reason names the second logo bar rather than leaving
      // the author to spot it in a render.
      ok(dupe, `'header' + '${hero.name}' is reported as duplicate_logo_bar`);
      eq(dupe && dupe.severity, 'error', `${hero.name}: the duplicate logo bar is an error`);
      eq(report.ok, false, `${hero.name}: a campaign with two logo bars does not validate`);
      ok(dupe && /header/.test(dupe.suggestion || ''), `${hero.name}: the fix suggests dropping the header`);
      eq(bars, 2, `${hero.name}: the rejected pairing is genuinely two logo bars`);
      // Without the header — how all four saved hero-b designs are built — exactly one bar.
      const solo = [blocks[1], blocks[2]];
      eq((render.assemble({ campaignName: 'x', blocks: solo }, { assetsBase: '/a' }).html.match(LOGO) || []).length, 1,
        `${hero.name} on its own renders exactly one logo bar`);
      ok(!validateCampaign({ campaignName: 'x', blocks: solo }, schema).issues.some((i) => i.type === 'duplicate_logo_bar'),
        `${hero.name} without a header validates — the four saved designs keep working`);
    } else {
      eq(bars, 1, `'header' + '${hero.name}' renders exactly one logo bar`);
      ok(!dupe, `'header' + '${hero.name}' is not flagged`);
    }
  }

  // The rule is discoverable without submitting a campaign and reading the error.
  const ord = schema.orderingRules && schema.orderingRules.header_replacing_heroes;
  ok(ord && Array.isArray(ord.components) && ord.components.length === 3,
    'orderingRules documents the three header-replacing heroes');
  for (const n of (ord ? ord.components : [])) ok(names.has(n), `header_replacing_heroes lists a real component: ${n}`);
}

// ── Bug 2: a glyph the brand face folds onto its base letter ───────────────────────────
// Cervanttis maps all 48 accented Latin-1 letters to their unaccented glyph, so "økar" sets as
// a clean, well-set "okar". It does not render tofu and it does not fall back to another face,
// so nothing about it looks wrong — the maker's name is just spelt differently from the same
// word set in NeuzeitGro three blocks further down. brokenImages already promises that /api/render
// names what silently failed; missingGlyphs puts this in the same contract.
{
  const cov = {};
  for (const face of ['cervanttis', 'lust', 'neuzeitgro']) {
    cov[face] = glyphs.faceCoverage(face);
    ok(cov[face], `the ${face} face is readable from the preview shell`);
  }
  // The fold is real and specific to Cervanttis. If a re-cut font fixes it, this flips — which
  // is the point: the guard verifies the font rather than trusting it.
  ok(cov.cervanttis.folded.includes('Ø') && cov.cervanttis.folded.includes('ø'),
    'Cervanttis still folds Ø/ø onto O/o (re-cut the face to clear this)');
  eq(cov.lust.folded.length, 0, 'Lust folds nothing — Ø renders as Ø, contrary to the original report');
  eq(cov.neuzeitgro.folded.length, 0, 'NeuzeitGro folds nothing');

  // Per-face inspection of the review's own probe string.
  const PROBE = 'Økar ø Ø Sítio Canaã Cuvée Mörk';
  eq(glyphs.inspect(PROBE, 'lust').length, 0, 'Lust renders the whole probe string');
  eq(glyphs.inspect(PROBE, 'neuzeitgro').length, 0, 'NeuzeitGro renders the whole probe string');
  const cerv = glyphs.inspect(PROBE, 'cervanttis');
  ok(cerv.length > 0, 'Cervanttis reports the probe string rather than failing open');
  const slash = cerv.find((h) => h.char === 'Ø');
  eq(slash && slash.kind, 'folded', 'Ø is reported as folded, not missing');
  eq(slash && slash.rendersAs, 'O', 'the report says what it actually renders as');
  eq(slash && slash.codepoint, 'U+00D8', 'the report carries the codepoint');

  // A campaign audit attributes each miss to the block and token that carries it, and checks
  // each value against the face that TYPESETS it — a Ø in a Lust product name is fine, the same
  // Ø in a Cervanttis headline is not.
  const camp = { campaignName: 'Økar', blocks: [
    { component: 'heroes/hero-a', tokens: { HERO_IMAGE_URL: '', SUPER_LABEL: 'APPLEWOOD',
      HEADLINE: 'the økar negroni', SUBHEADLINE: 'Økar Bitter Aperitivo', CTA_TEXT: 'Shop the Økar',
      CTA_URL: 'https://figandbloom.com' } },
    { component: 'products/card-horizontal', tokens: { PRODUCT_IMAGE_URL: '', PRODUCT_LABEL: 'APPLEWOOD',
      PRODUCT_NAME: 'Økar Bitter Aperitivo, 700ml', PRODUCT_DESC: 'Sítio Canaã', PRODUCT_PRICE: '$55',
      CTA_TEXT: 'Add', PRODUCT_URL: 'https://figandbloom.com' } },
  ] };
  const misses = glyphs.auditCampaign(camp, schema);
  eq(misses.length, 1, 'the audit reports exactly the one token whose face cannot set it');
  eq(misses[0] && misses[0].component, 'heroes/hero-a', 'the miss is attributed to its block');
  eq(misses[0] && misses[0].token, 'HEADLINE', 'the miss is attributed to its token');
  eq(misses[0] && misses[0].face, 'cervanttis', 'the miss names the face that folds it');
  eq(misses[0] && misses[0].index, 0, 'the miss carries the block index');
  ok(/renders as o/.test(misses[0] && misses[0].message || ''), 'the message says what the reader will see');

  // Copy the brand faces can all set produces no report at all — the guard has to be quiet to
  // be worth reading.
  const clean = { campaignName: 'clean', blocks: [
    { component: 'heroes/hero-a', tokens: { HERO_IMAGE_URL: '', SUPER_LABEL: 'APPLEWOOD',
      HEADLINE: 'the negroni hour', SUBHEADLINE: 'Sítio Canaã, Mörk and Cuvée', CTA_TEXT: 'Shop',
      CTA_URL: 'https://figandbloom.com' } },
  ] };
  eq(glyphs.auditCampaign(clean, schema).length, 0, 'copy every face can set reports nothing');
}

// ── Bug 3: the casing rule follows the FONT, and the schema now says which ─────────────
// tokenRules is a flat map keyed by token name, which cannot express "HEADLINE is Cervanttis
// here and Lust there". Worse, the TOKENS: parser let a token documented with no description
// swallow the next line: SUPER_LABEL in hero-c1 inherited HEADLINE's "MUST be lowercase" —
// the phantom rule the review hit — and consumed {{HEADLINE}} on the way, so HEADLINE lost its
// real rule at the same time. Both are gone; the font is read off the template body.
{
  const c1 = schema.components.find((c) => c.name === 'heroes/hero-c1');
  const tok = (c, n) => c.tokens.find((t) => t.name === n);

  const sup = tok(c1, 'SUPER_LABEL');
  eq(sup.font, 'neuzeitgro', 'hero-c1 SUPER_LABEL is NeuzeitGro, as the markup renders it');
  eq(sup.case, 'any', 'hero-c1 SUPER_LABEL has no casing rule — the lowercase rule was a parser artefact');
  ok(!/lowercase/i.test(sup.desc || ''), 'SUPER_LABEL no longer inherits the next line’s description');

  const hl = tok(c1, 'HEADLINE');
  eq(hl.font, 'cervanttis', 'hero-c1 HEADLINE is Cervanttis');
  eq(hl.case, 'lower', 'hero-c1 HEADLINE recovers its real lowercase rule');

  // Caps in SUPER_LABEL are accepted in every hero, which is what "discoverable only by trial"
  // was about: the same token behaved differently between variants for no stated reason.
  for (const c of schema.components.filter((x) => x.group === 'heroes' || x.name === 'blocks/caption-bar-hero')) {
    const t = tok(c, 'SUPER_LABEL');
    if (!t) continue;
    eq(t.case, 'any', `${c.name} SUPER_LABEL accepts caps like every other component`);
  }

  // Every token that reaches type carries a face, and the face implies the rule.
  const FACE_CASE = { cervanttis: 'lower', lust: 'sentence', neuzeitgro: 'any' };
  let typed = 0;
  for (const c of schema.components) {
    for (const t of c.tokens) {
      ok(['text', 'url', 'image', 'length', 'palette', 'enum'].includes(t.type), `${c.name}.${t.name} has a known type`);
      if (!t.font) continue;
      typed++;
      ok(['cervanttis', 'lust', 'neuzeitgro'].includes(t.font), `${c.name}.${t.name} names a brand face`);
      ok(['lower', 'sentence', 'any'].includes(t.case), `${c.name}.${t.name} carries a casing rule`);
      // A description may override the face's default, but never contradict it silently.
      if (!/lowercase|sentence case/i.test(t.desc || '') && !/lowercase|sentence case/i.test(t.rule || '')) {
        eq(t.case, FACE_CASE[t.font], `${c.name}.${t.name} defaults its casing from its face`);
      }
    }
  }
  ok(typed > 60, `most text tokens are attributed to a face (${typed})`);
  ok(schema.tokenRules && Object.keys(schema.tokenRules).length, 'the global tokenRules map is kept as a deprecated fallback');

  // The description-bleed regression, stated directly: no token's description may be another
  // token's declaration.
  for (const c of schema.components) {
    for (const t of c.tokens) {
      ok(!/^\{\{[A-Z0-9_]+\}\}/.test(t.desc || ''),
        `${c.name}.${t.name} description is its own, not the next token's`);
    }
  }
}

// ── Bug 4: casing is Unicode-aware ─────────────────────────────────────────────────────
// Ø is an uppercase letter. Under /[A-Z]/ it is not, so "Økar bitter aperitivo" was rejected as
// all-lowercase — and the repair walked to the first /[A-Za-z]/, stepped over the Ø, and
// proposed "ØKar".
{
  const pc = schema.components.find((c) => c.name === 'blocks/polaroid-collage');
  const sentenceToken = 'PULL_QUOTE';   // Lust → Sentence case
  const lowerToken = 'QUOTE_ACCENT';    // Cervanttis → lowercase
  const issueFor = (token, value) => {
    const camp = sampleData.sampleCampaignFor(pc);
    camp.blocks[0].tokens[token] = value;
    return validateCampaign(camp, schema, { requireUnsubscribe: false })
      .issues.find((i) => i.type === 'casing' && i.token === token);
  };

  // Values that OPEN with a non-ASCII capital are correct Sentence case and must pass clean.
  for (const v of ['Økar Bitter Aperitivo', 'Ærø in the morning', 'Ölund and the others',
                   'Île de Ré, in a bottle', 'Sítio Canaã, our filter', 'Mörk drinking chocolate']) {
    ok(!issueFor(sentenceToken, v), `Sentence case accepts ${JSON.stringify(v)}`);
  }

  // Genuinely all-lowercase is still rejected, and the suggestion capitalises the FIRST CASED
  // character rather than skipping it.
  const bad = issueFor(sentenceToken, 'økar bitter aperitivo');
  ok(bad, 'a genuinely all-lowercase Lust value is still rejected');
  eq(bad && bad.suggestion, 'Økar bitter aperitivo', 'the suggestion capitalises the first cased character');
  eq(issueFor(sentenceToken, 'ærø in the morning').suggestion, 'Ærø in the morning', 'and does so for a ligature');
  eq(issueFor(sentenceToken, 'îles flottantes').suggestion, 'Îles flottantes', 'and for a circumflex');
  eq(issueFor(sentenceToken, '“økar” bitter').suggestion, '“Økar” bitter', 'skipping leading punctuation, not letters');

  // No suggestion when the value already starts with a capital — the old code offered one anyway.
  const already = issueFor(sentenceToken, 'Økar');
  ok(!already, 'a value already in Sentence case raises nothing to suggest');

  // Lowercase tokens see non-ASCII capitals too.
  const caps = issueFor(lowerToken, 'Ølund in their words');
  ok(caps, 'a Cervanttis value opening with Ø is caught as containing capitals');
  eq(caps && caps.suggestion, 'ølund in their words', 'and is lowercased correctly');
  ok(!issueFor(lowerToken, 'økar, ærø and île'), 'an all-lowercase Cervanttis value with accents passes');
}

// ── Bug 6: sections/button inherits the panel it sits on ───────────────────────────────
// The button draws its own full-width band. With PANEL_BG left at the body colour it read as a
// stray dark stripe between a white section and the black close — two near-but-not-equal darks,
// which looks like a rendering fault. The right value is almost always "whatever is above me".
{
  const btnBlock = (tokens) => ({ component: 'sections/button', tokens: {
    CTA_TEXT: 'Read the story', CTA_URL: 'https://figandbloom.com', ALIGN: 'center',
    BTN_BG: '#000000', BTN_TEXT: '#ffffff', ...tokens } });
  const bgOf = (blocks, bodyBg) => {
    const meta = render.assembleBlocks({ campaignName: 't', bodyBg, blocks });
    return meta.blocks.find((b) => b.component === 'sections/button').tokens.PANEL_BG;
  };
  const headline = { component: 'sections/section-headline', tokens: { SUPER_LABEL: 'X', HEADLINE: 'Y' } };
  const noir = sampleData.sampleCampaignFor(schema.components.find((c) => c.name === 'sections/upsell-noir')).blocks[0];

  eq(bgOf([headline, btnBlock({})], '#2c2825'), '#ffffff',
    'a button after a white section takes the white panel');
  eq(bgOf([noir, btnBlock({})], '#2c2825'), '#000000',
    'a button after the noir close takes the black panel');
  eq(bgOf([btnBlock({})], '#2c2825'), '#2c2825',
    'a button with nothing above it falls back to the campaign bodyBg');
  eq(bgOf([headline, btnBlock({ PANEL_BG: '#D8CCBE' })], '#2c2825'), '#D8CCBE',
    'an explicit PANEL_BG still wins — the default never overrides an author');
  eq(bgOf([headline, btnBlock({ PANEL_BG: '' })], '#2c2825'), '#ffffff',
    'a blank PANEL_BG means "inherit", not "no colour"');

  // PANEL_BG carries a manifest default, so it is optional rather than unfilled.
  const btn = schema.components.find((c) => c.name === 'sections/button');
  const t = btn.tokens.find((x) => x.name === 'PANEL_BG');
  ok(t && t.default !== undefined, 'PANEL_BG is declared optional in the manifest');
  ok(!validateCampaign({ campaignName: 't', blocks: [headline, btnBlock({})] }, schema, { requireUnsubscribe: false })
      .issues.some((i) => i.token === 'PANEL_BG'), 'omitting PANEL_BG is not an unfilled token');
}

// ── Bug 7: the collages must not paint over their own text ─────────────────────────────
// Both blocks lay absolutely-positioned rotated cards inside a fixed-height region. In
// polaroid-collage the centre card is in FRONT and the outer captions sat in the overlapped
// column, so they were clipped ("fig and olive leaf" → "fig and olive lea"). DENSITY never
// helped: it changes the region height only, so the horizontal overlap was identical at every
// setting. In editorial-collage the front frame overhung the region and painted over the
// SUPER_LABEL below it ("PLANT HOUSE" → "PLA…HOU").
//
// The runtime proof is a browser measurement (elementsFromPoint over each caption); this is the
// arithmetic invariant that keeps it fixed, so an edit to the offsets fails here first.
{
  const pc = fs.readFileSync(path.join(DS, 'templates', 'blocks', 'polaroid-collage.html'), 'utf8');
  const at = (cls) => {
    const m = pc.match(new RegExp(`class="${cls}"[^>]*style="[^"]*left:(-?\\d+)px;top:(-?\\d+)px`));
    return m ? { left: +m[1], top: +m[2] } : null;
  };
  const left = at('pc-left'), right = at('pc-right'), centre = at('pc-center');
  ok(left && right && centre, 'the three polaroids declare their offsets');

  // Card heights: 1px border + padding + photo + caption margin + one caption line + tail.
  const CENTRE_H = 2 + 22 + 176 + 12 + 20 + 4;   // centre card, 176px photo, 20px caption line
  const OUTER_CAPTION_TOP = 10 + 168 + 12;       // padding + photo + caption margin, from card top
  const centreBottom = centre.top + CENTRE_H;
  for (const [name, card] of [['left', left], ['right', right]]) {
    ok(card.top + OUTER_CAPTION_TOP > centreBottom + 12,
      `the ${name} polaroid's caption starts below the centre card (${card.top + OUTER_CAPTION_TOP} > ${centreBottom} + rotation slack)`);
  }
  // Horizontal overlap is the locked design and must NOT have been traded away for clearance.
  ok(left.left + 190 > centre.left, 'the left polaroid still overlaps the centre one');
  ok(right.left < centre.left + 200, 'the right polaroid still overlaps the centre one');

  // Every DENSITY region is tall enough for the lowest card, so no card is cropped by the slicer.
  const lowest = Math.max(left.top, right.top) + 2 + 20 + 168 + 12 + 20 + 4 + 14; // + rotation slack
  const heights = [...pc.matchAll(/\.pc\.dens-(\w+) \.pc-region \{ height:(\d+)px; \}/g)].map((m) => [m[1], +m[2]]);
  eq(heights.length, 3, 'all three DENSITY heights are declared');
  for (const [d, h] of heights) ok(h >= lowest, `the '${d}' region (${h}px) clears the lowest card (${lowest}px)`);

  // editorial-collage: the region must clear its tallest frame at the steepest rotation.
  const ec = fs.readFileSync(path.join(DS, 'templates', 'blocks', 'editorial-collage.html'), 'utf8');
  const regionH = +(ec.match(/position:relative;width:600px;height:(\d+)px/) || [])[1];
  const frameBottom = 18 + 2 + 22 + 264 + 12;  // front frame: top + border + padding + photo + rotation slack
  ok(regionH >= frameBottom, `the editorial-collage region (${regionH}px) clears its front frame (${frameBottom}px)`);
}

// ── Bug 9: nothing may hold the document wider than the viewport ───────────────────────
// The email is one shrink-to-fit document: a single block that cannot go below 600px scales
// EVERY glyph in the email, not just its own. That is why 14px body copy arrived at 8.8px —
// 375/600 = 0.625 — and why this is a whole-system contract rather than a per-block one.
{
  const tdir = path.join(DS, 'templates');
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp, out);
      else if (e.name.endsWith('.html')) out.push(fp);
    }
    return out;
  };
  for (const fp of walk(tdir)) {
    const rel = path.relative(tdir, fp);
    const markup = render.stripDocComments(fs.readFileSync(fp, 'utf8'));
    // Every structural 600px table opts into the fluid contract — not just the eight in the
    // original fixture. Forty-five components had never opted in, so the media query had
    // nothing to act on and every campaign scaled.
    for (const tag of markup.match(/<table\b[^>]*\bwidth="600"[^>]*>/gi) || []) {
      ok(/\bclass="[^"]*\b(?:ew|f600)\b/i.test(tag), `${rel}: every 600px table opts into the fluid contract`);
    }
    // Any fixed measure wider than a phone must be able to go fluid too.
    for (const tag of markup.match(/<table\b[^>]*\bwidth="(\d+)"[^>]*>/gi) || []) {
      const w = +(tag.match(/width="(\d+)"/) || [])[1];
      if (w <= 376 || w === 600) continue;
      ok(/\bclass="[^"]*\b(?:fm|f600)\b/i.test(tag), `${rel}: the ${w}px measure opts into .fm`);
    }
    // A full-bleed image must not be able to impose a 600px minimum on the table it sits in.
    // An image that has not loaded takes its intrinsic size from its width/height attributes,
    // so `width:100%` is resolved back through that aspect ratio whenever the CSS height is
    // definite. Two shapes are safe, and one of them has to hold:
    //   height:auto      — no definite height, so there is no ratio to resolve through; or
    //   max-width:600px  — a DEFINITE cap, which together with the shell's .fimg vw rule lets
    //                      the image shrink while keeping the crop the designer chose.
    // A percentage max-width is not a third option: it resolves to none against a shrink-to-fit
    // table, which is exactly how the whole document got pinned at 600px.
    for (const tag of markup.match(/<img\b[^>]*\bwidth="600"[^>]*>/gi) || []) {
      ok(/\bclass="[^"]*\bfimg\b/i.test(tag), `${rel}: every full-bleed image carries .fimg`);
      ok(/width:\s*100%/.test(tag), `${rel}: every full-bleed image is inline-fluid`);
      ok(/height:\s*auto/.test(tag) || /max-width:\s*600px/.test(tag),
        `${rel}: a full-bleed image is either height:auto or capped at a definite 600px`);
    }
  }

  // The three blocks the report named, and the classes their stacking depends on.
  const fl = fs.readFileSync(path.join(tdir, 'blocks', 'feature-list.html'), 'utf8');
  for (const cls of ['fl-col-img', 'fl-col-txt', 'fl-img']) {
    ok(new RegExp(`class="[^"]*\\b${cls}\\b`).test(fl), `blocks/feature-list carries .${cls} (it had no classes at all)`);
  }
  const st = fs.readFileSync(path.join(tdir, 'blocks', 'story.html'), 'utf8');
  for (const cls of ['st-col-img', 'st-col-txt', 'st-img']) {
    ok(new RegExp(`class="[^"]*\\b${cls}\\b`).test(st), `blocks/story carries .${cls}`);
  }
  const jt = fs.readFileSync(path.join(tdir, 'blocks', 'journal-tile.html'), 'utf8');
  ok(/class="[^"]*\bjt-imgel\b/.test(jt), 'blocks/journal-tile marks its tile images for fluid sizing');

  // Both shells carry the rules, and the vw cap that lets an unloaded image shrink.
  for (const shellName of ['shell-preview.html', 'shell-production.html']) {
    const shell = fs.readFileSync(path.join(DS, 'shell', shellName), 'utf8');
    const start = shell.indexOf('@media only screen and (max-width:600px)');
    const media = start < 0 ? '' : shell.slice(start, shell.indexOf('</style>', start));
    for (const sel of ['.st-col', '.fl-col', '.ap-col', '.jt-img', '.jt-txt']) {
      ok(new RegExp(`\\${sel}\\{[^}]*display:\\s*block\\s*!important;[^}]*width:\\s*100%\\s*!important`).test(media),
        `${shellName} stacks ${sel} on mobile`);
    }
    ok(/\.fimg\{[^}]*width:\s*100%\s*!important;[^}]*max-width:\s*100vw\s*!important/.test(media),
      `${shellName} caps full-bleed images at the viewport, not at a percentage`);
    ok(!/\.fimg\{[^}]*max-width:\s*100%/.test(media),
      `${shellName} does not use a percentage cap on .fimg — it resolves to none and re-opens the bug`);
    for (const sel of ['.st-img', '.fl-img', '.ap-img', '.cvs-img', '.jt-imgel']) {
      ok(new RegExp(`\\${sel}\\{[^}]*width:\\s*100%\\s*!important`).test(media),
        `${shellName} makes ${sel} fluid`);
    }
  }
}

// ── Bug 10: an empty PROMO_CODE draws no box ───────────────────────────────────────────
// Every other block drops its optional furniture on an empty token. offer-panel kept drawing the
// dashed rectangle, which is exactly the documented giveaway mode — prize in OFFER_VALUE, no code.
{
  const op = schema.components.find((c) => c.name === 'blocks/offer-panel');
  const build = (code) => {
    const camp = sampleData.sampleCampaignFor(op);
    camp.blocks[0].tokens.PROMO_CODE = code;
    camp.blocks[0].tokens.CODE_LABEL = 'USE CODE AT CHECKOUT';
    return render.stripDocComments(render.assemble(camp, { assetsBase: '/a' }).html);
  };
  const withCode = build('BLOOM20'), giveaway = build('');
  ok(/2px dashed/.test(withCode), 'a real code still draws the dashed box');
  ok(/BLOOM20/.test(withCode), 'and the code itself');
  ok(/USE CODE AT CHECKOUT/.test(withCode), 'and its label');
  ok(!/2px dashed/.test(giveaway), 'GIVEAWAY MODE draws no empty dashed box');
  ok(!/USE CODE AT CHECKOUT/.test(giveaway), 'and no orphaned "USE CODE" label above it');
  // Everything else in the block survives — the conditional must not swallow its neighbours.
  for (const frag of [op.tokens.length && '</table>', 'Free delivery']) {
    if (frag) ok(giveaway.includes(frag), `GIVEAWAY MODE keeps the rest of the block (${frag})`);
  }
  ok(/<a href/.test(giveaway), 'GIVEAWAY MODE keeps the CTA button');

  // The same emptiness contract every other block already honours.
  for (const name of ['blocks/caption-bar-hero', 'blocks/story', 'blocks/feature-list', 'sections/upsell-noir']) {
    const c = schema.components.find((x) => x.name === name);
    if (!c || !c.tokens.some((t) => t.name === 'CTA_TEXT')) continue;
    const camp = sampleData.sampleCampaignFor(c);
    camp.blocks[0].tokens.CTA_TEXT = '';
    ok(!/padding:14px 40px/.test(render.assemble(camp, { assetsBase: '/a' }).html),
      `${name} still drops its button on an empty CTA_TEXT`);
  }
}

// ── report ────────────────────────────────────────────────────────────────────────────
studioSuite()
  .catch((e) => { failures.push('studio suite threw: ' + (e && e.stack || e)); })
  .then(async () => {
    try { await require('../lib/db').close(); } catch (_) { /* no pool to close */ }
    const driver = process.env.DATABASE_URL ? 'postgres' : 'disk';
    if (failures.length) {
      console.error(`\n✗ ${failures.length} failure(s), ${passed} passed (studio driver: ${driver}):\n`);
      for (const f of failures) console.error('  • ' + f);
      process.exit(1);
    }
    console.log(`\n✓ all ${passed} assertions passed (studio driver: ${driver})\n`);
  });

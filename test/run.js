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

// ── report ────────────────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n✗ ${failures.length} failure(s), ${passed} passed:\n`);
  for (const f of failures) console.error('  • ' + f);
  process.exit(1);
}
console.log(`\n✓ all ${passed} assertions passed\n`);

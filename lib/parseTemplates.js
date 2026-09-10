'use strict';
// parseTemplates.js — derive a machine-readable token schema from the design system.
// Source of truth: each template's leading <!-- COMPONENT … TOKENS: … --> header,
// plus manifest.json (token_rules, ordering_rules, static flags). The UI form is
// generated from this, so it always stays in sync with the templates.

const fs = require('fs');
const path = require('path');
const { OBJECTIVES, OBJECTIVE_GUIDANCE, COMPONENT_INTENT } = require('./componentStrategy');
const glyphs = require('./glyphs');

function read(p) { return fs.readFileSync(p, 'utf8'); }

// Pull the leading HTML comment block from a template.
function leadingComment(html) {
  const m = html.match(/<!--([\s\S]*?)-->/);
  return m ? m[1] : '';
}

// Slice a labelled section out of the comment (TOKENS:, RULES:, PALETTE PRESETS:).
function section(comment, label) {
  // label may carry trailing prose before the newline, e.g. "PALETTE PRESETS (copy one row…):"
  const re = new RegExp(label + '[^\\n]*\\n([\\s\\S]*?)(?:\\n\\s*[A-Z][A-Z ]{2,}:|$)');
  const m = comment.match(re);
  return m ? m[1] : '';
}

// All {{TOKENS}} actually present in the body (excludes auto-injected ASSETS_BASE).
function bodyTokens(html) {
  const set = new Set();
  for (const m of html.matchAll(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g)) set.add(m[1]);
  set.delete('ASSETS_BASE');
  return [...set];
}

const PALETTE_KEYS = ['PANEL_BG', 'PANEL_TEXT', 'PANEL_SUB', 'PANEL_BORDER', 'BTN_BG', 'BTN_TEXT'];

function parsePalettePresets(comment) {
  const block = section(comment, 'PALETTE PRESETS');
  if (!block) return [];
  const presets = [];
  for (const line of block.split('\n')) {
    // e.g. "  white :  PANEL_BG=#ffffff  PANEL_TEXT=#000000  PANEL_SUB=#aaaaaa  PANEL_BORDER=#e8e2da ..."
    const name = line.match(/^\s*([A-Za-z0-9]+)\s*:/);
    const pairs = [...line.matchAll(/(PANEL_[A-Z]+|BTN_[A-Z]+)\s*=\s*(#[0-9a-fA-F]{3,8})/g)];
    if (name && pairs.length) {
      const values = {};
      for (const [, k, v] of pairs) values[k] = v;
      presets.push({ name: name[1].toLowerCase(), values });
    }
  }
  return presets;
}

function fieldType(name, desc) {
  const d = (desc || '').toLowerCase();
  if (PALETTE_KEYS.includes(name)) return 'palette';
  // Only a token that NAMES a URL holds one. Matching "photo"/"hero" anywhere in the name
  // typed PHOTO_1_CAPTION and HERO_IMAGE_ALT as images, so the editor offered a URL field and
  // a thumbnail for a line of Cervanttis caption copy.
  if (/_URL$/.test(name)) {
    // A *_LINK_URL is a click-through even when the thing it wraps is a picture, so it is
    // checked before the picture words — otherwise HERO_LINK_URL reads as an image source.
    if (/_LINK_URL$/.test(name)) return 'url';
    return /IMAGE|PHOTO|HERO|POLAROID|PORTRAIT|FRAME|TILE|STEP|STUDIO|LIFESTYLE|DIVIDER|SRC/.test(name)
      ? 'image' : 'url';
  }
  // enum lever, e.g. IMG_HEIGHT — "600" (square) or "440". Locked to these two.
  const quoted = [...(desc || '').matchAll(/"([^"]+)"/g)].map(m => m[1]);
  if (/locked to these|lever|one of|either/i.test(d) && quoted.length >= 2) {
    // keep only short, value-like options (no spaces / short)
    const opts = quoted.filter(q => q.length <= 12 && !/\s/.test(q));
    if (opts.length >= 2) return 'enum';
  }
  // Dimension lever, e.g. PADDING_TOP — "40px". Typed so the value can be checked as a CSS
  // length: a bare "100" interpolates to `padding:100 72px 100`, which is an invalid shorthand,
  // so the browser drops the whole declaration and the padding silently collapses to 0.
  if (/\bin px\b/.test(d) || quoted.some(q => /^\d+(?:\.\d+)?px$/.test(q))) return 'length';
  return 'text';
}

// The three brand faces, keyed as the schema exposes them. The stack's FIRST family is the
// only one that decides the rule — the rest of the stack is an email fallback chain, and a
// fallback is a deliverability decision, not a typographic one.
const FONT_KEYS = { cervanttis: 'cervanttis', lust: 'lust', neuzeitgro: 'neuzeitgro' };

// Which brand face actually renders a token, read off the template body rather than off the
// prose in the TOKENS: comment.
//
// This is the fix for "the casing rule follows the font face, not the token name": SUPER_LABEL
// is NeuzeitGro caps in heroes/hero-c1 and Cervanttis script in nothing at all, while HEADLINE
// is Cervanttis in the heroes and Lust in the products. A flat map keyed by token name cannot
// express that; the rendered font can, and it cannot drift from the template because it *is*
// the template.
//
// Only occurrences in TEXT content count. The same token routinely appears inside an attribute
// (alt="{{HEADLINE}}"), where it is never typeset, and the nearest preceding font-family there
// belongs to some earlier element entirely.
function fontOfToken(html, name) {
  const token = '{{' + name + '}}';
  for (let i = html.indexOf(token); i !== -1; i = html.indexOf(token, i + token.length)) {
    const before = html.slice(0, i);
    if (before.lastIndexOf('<') > before.lastIndexOf('>')) continue; // inside a tag — not typeset
    // The enclosing element carries its own inline font-family (every template sets one per
    // <p>/<h1>/<h2>/<a>/<span>), so the nearest declaration before the token is the token's.
    // A non-brand family (the Gill Sans inside a VML fallback) is skipped rather than returned,
    // so the next occurrence — the live <a> every other client renders — still answers.
    const decls = [...before.matchAll(/font-family:\s*'([^']+)'/g)];
    const family = decls.length ? decls[decls.length - 1][1] : null;
    const key = family && FONT_KEYS[String(family).toLowerCase()];
    if (key) return key;
  }
  return null;
}

// The case rule a face imposes, when the token's own description does not spell one out.
// Cervanttis is a script face set lowercase throughout the brand; Lust is the display serif and
// is Sentence case; NeuzeitGro carries text-transform:uppercase at every size it is used, so
// the authored casing is irrelevant to what renders.
const FONT_CASE = { cervanttis: 'lower', lust: 'sentence', neuzeitgro: 'any' };

function caseRule(name, desc, tokenRules, font) {
  // Per-template description wins (it names the actual font for this template).
  const d = (desc || '').toLowerCase();
  if (/lowercase/.test(d)) return 'lower';
  if (/sentence case/.test(d)) return 'sentence';
  // Fall back to the global token rule only when it's unambiguous.
  const r = (tokenRules[name] || '').toLowerCase();
  if (r) {
    const lower = /lowercase/.test(r), sent = /sentence case/.test(r);
    if (lower && !sent) return 'lower';
    if (sent && !lower) return 'sentence';
  }
  // Nothing written down: fall back to the face that renders it. This is what closes the gap
  // the flat tokenRules map could never express.
  return font ? FONT_CASE[font] : null;
}

function enumOptions(desc) {
  return [...(desc || '').matchAll(/"([^"]+)"/g)]
    .map(m => m[1]).filter(q => q.length <= 12 && !/\s/.test(q));
}

function groupOf(name) {
  return name.includes('/') ? name.split('/')[0] : name; // header, footer, blocks, sections, products, heroes, dividers
}

// manifest.components is nested by group ("blocks" → "polaroid-collage"), so a component's
// group-prefixed name walks straight into it. Returns {} for a component the manifest doesn't
// describe (the templates stay the source of truth for which tokens exist).
function manifestEntry(manifest, rel) {
  let node = manifest.components || {};
  for (const part of rel.split('/')) {
    if (!node || typeof node !== 'object') return {};
    node = node[part];
  }
  return (node && typeof node === 'object') ? node : {};
}

function buildSchema(dsRoot, opts = {}) {
  const manifest = JSON.parse(read(path.join(dsRoot, 'manifest.json')));
  const tokenRules = manifest.token_rules || {};
  const tdir = path.join(dsRoot, 'templates');

  // Shell-level tokens (BODY_BG, CAMPAIGN_NAME, …) are filled by the shell at assembly time,
  // not per-component. A block may reference one (e.g. journal-tile sits on {{BODY_BG}}); it
  // must not surface as one of that component's own fields.
  const shellTokens = new Set(Object.keys((manifest.assembly && manifest.assembly.shell_tokens) || {}));

  // walk templates/**.html
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.name.endsWith('.html')) files.push(fp);
    }
  })(tdir);

  // Parse one template — from disk, or authored in the Studio. Both go through the same
  // parser because an authored component compiles to the same artefact: table HTML with
  // {{TOKEN}} slots behind a `<!-- COMPONENT … TOKENS: … -->` header.
  function parseOne(rel, html, extra) {
    const comment = leadingComment(html);
    const header = comment.split('\n')[0] || '';
    const designed = /DESIGNED BLOCK/i.test(comment);
    const isStatic = /STATIC/i.test(comment) || /no tokens/i.test(comment);
    // A block whose header flags it "DRAFT" (e.g. "DRAFT — pending design review") is surfaced
    // as draft so the UI / component library / skills can mark it not-yet-ship-ready.
    const draft = /\bDRAFT\b/i.test(comment);
    const desc = (header.split('|')[1] || '').trim();

    // token descriptions from the TOKENS: section
    const tokBlock = section(comment, 'TOKENS');
    const descByName = {};
    // The separator run must stay on the token's OWN line. `\s*` matches newlines, so a token
    // documented without a description used to swallow the next line whole and adopt its
    // neighbour's rule: `{{SUPER_LABEL}}` in heroes/hero-c1 inherited HEADLINE's "MUST be
    // lowercase", which is where the phantom lowercase-SUPER_LABEL rule came from — and the
    // match consumed `{{HEADLINE}}` on the way, so HEADLINE lost its real rule at the same
    // time. `[^\S\n]` is horizontal whitespace only, which keeps each token on its own line.
    for (const m of tokBlock.matchAll(/\{\{\s*([A-Z0-9_]+)\s*\}\}[^\S\n]*[—\-:]*[^\S\n]*([^\n]*)/g)) {
      const d = m[2].trim();
      // A description that is itself just the next token(s) — the PALETTE TOKENS run lists
      // several on one line — is a listing, not a description.
      if (d && d !== '"' && !/^\{\{[A-Z0-9_]+\}\}/.test(d)) descByName[m[1]] = d;
    }

    const palettePresets = parsePalettePresets(comment);
    const present = bodyTokens(html).filter(t => !shellTokens.has(t));

    // Optional per-token defaults from the manifest (e.g. the PADDING_TOP/PADDING_BOTTOM levers).
    // A token with a default is optional: omit it (or leave it blank) and assembly fills the
    // default in, so adding one to an existing component never breaks a saved campaign.
    const tokenDefaults = manifestEntry(manifest, rel).token_defaults || {};

    const tokens = present.map(name => {
      const d = descByName[name] || '';
      const type = fieldType(name, d);
      // Which brand face typesets this token in THIS component. Null for a token that never
      // reaches text (a URL, a colour) or that renders in a non-brand face.
      const font = fontOfToken(html, name);
      return {
        name,
        desc: d,
        rule: tokenRules[name] || null,
        type,
        font,
        case: caseRule(name, d, tokenRules, font),
        default: Object.prototype.hasOwnProperty.call(tokenDefaults, name) ? String(tokenDefaults[name]) : undefined,
        enumOptions: type === 'enum' ? enumOptions(d) : undefined,
        // Text tokens accept inline markdown (**bold**, *italic*, [text](url)); see lib/markdown.js.
        markdown: type === 'text' ? true : undefined,
      };
    });

    // Intent metadata (Task 3) — additive: merged from the shared strategy table by name.
    // Consumers that don't understand these keys simply ignore them.
    const intent = COMPONENT_INTENT[rel] || null;

    return {
      name: rel, group: groupOf(rel), file: 'design-system/templates/' + rel + '.html',
      designed, static: isStatic || tokens.length === 0, draft,
      desc, tokens, palettePresets,
      ...(intent || {}),
      ...(extra || {}),
    };
  }

  const components = files.sort().map(fp =>
    parseOne(path.relative(tdir, fp).replace(/\.html$/, '').split(path.sep).join('/'), read(fp)));

  // Studio-authored components. A published one either adds a new component to the library or
  // *shadows* a shipped template of the same name — the brief is to upgrade the library as well
  // as extend it, so an authored version has to be able to win over the file on disk.
  for (const t of (opts.extraTemplates || [])) {
    if (!t || !t.name || !t.html) continue;
    const parsed = parseOne(t.name, t.html, {
      authored: true,
      authoredVersion: t.version,
      componentId: t.id,
      file: `studio://${t.id}@${t.version}`,
      shadowsShipped: !!t.shadowsShipped,
      ...(t.intent || {}),
    });
    const i = components.findIndex(c => c.name === t.name);
    if (i >= 0) { parsed.shadowsShipped = true; parsed.shippedBaseline = components[i].file; components[i] = parsed; }
    else components.push(parsed);
  }
  components.sort((a, b) => a.name.localeCompare(b.name));

  return {
    version: manifest.version,
    components,
    tokenRules,
    orderingRules: manifest.ordering_rules || null,
    assembly: manifest.assembly || null,
    // Campaign-objective taxonomy (Task 4) — canonical list + per-objective guidance.
    objectives: OBJECTIVES.map(id => ({ id, ...OBJECTIVE_GUIDANCE[id] })),
    // What each brand face can actually SET, so the editor can warn on the same characters the
    // validator rejects instead of the two disagreeing. `folded` is the dangerous list: those
    // codepoints are in the face's cmap but resolve to the unaccented letter, so they render
    // clean and misspelt. See lib/glyphs.js.
    fontCoverage: Object.fromEntries(['cervanttis', 'lust', 'neuzeitgro'].map((f) => {
      const c = glyphs.faceCoverage(f);
      return [f, c ? { folded: c.folded.join(''), missing: c.missing.join('') } : null];
    }).filter(([, v]) => v)),
    bodyBgDefault: '#2c2825',
  };
}

module.exports = { buildSchema };

if (require.main === module) {
  const ds = path.join(__dirname, '..', 'design-system');
  const s = buildSchema(ds);
  const designedCount = s.components.filter(c => c.designed).length;
  console.log(`components: ${s.components.length} (designed: ${designedCount})`);
  const fl = s.components.find(c => c.name === 'blocks/feature-list');
  console.log('\nfeature-list tokens:');
  for (const t of fl.tokens) console.log(`  ${t.name.padEnd(20)} type=${t.type.padEnd(7)} case=${t.case || '-'}`);
  const cb = s.components.find(c => c.name === 'blocks/caption-bar-hero');
  console.log('\ncaption-bar-hero palette presets:', cb.palettePresets.map(p => p.name).join(', '));
  console.log('caption-bar-hero IMG_HEIGHT options:', (cb.tokens.find(t => t.name === 'IMG_HEIGHT') || {}).enumOptions);
}

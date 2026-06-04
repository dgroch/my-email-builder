'use strict';
// parseTemplates.js — derive a machine-readable token schema from the design system.
// Source of truth: each template's leading <!-- COMPONENT … TOKENS: … --> header,
// plus manifest.json (token_rules, ordering_rules, static flags). The UI form is
// generated from this, so it always stays in sync with the templates.

const fs = require('fs');
const path = require('path');
const { OBJECTIVES, OBJECTIVE_GUIDANCE, COMPONENT_INTENT } = require('./componentStrategy');

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
  if (/_URL$/.test(name) || /image|photo|hero/i.test(name)) {
    if (/_URL$/.test(name) && /image|photo|hero|polaroid|src/i.test(name)) return 'image';
    if (/_URL$/.test(name)) return 'url';
    return 'image';
  }
  // enum lever, e.g. IMG_HEIGHT — "600" (square) or "440". Locked to these two.
  const quoted = [...(desc || '').matchAll(/"([^"]+)"/g)].map(m => m[1]);
  if (/locked to these|lever|one of|either/i.test(d) && quoted.length >= 2) {
    // keep only short, value-like options (no spaces / short)
    const opts = quoted.filter(q => q.length <= 12 && !/\s/.test(q));
    if (opts.length >= 2) return 'enum';
  }
  return 'text';
}

function caseRule(name, desc, tokenRules) {
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
  return null;
}

function enumOptions(desc) {
  return [...(desc || '').matchAll(/"([^"]+)"/g)]
    .map(m => m[1]).filter(q => q.length <= 12 && !/\s/.test(q));
}

function groupOf(name) {
  return name.includes('/') ? name.split('/')[0] : name; // header, footer, blocks, sections, products, heroes, dividers
}

function buildSchema(dsRoot) {
  const manifest = JSON.parse(read(path.join(dsRoot, 'manifest.json')));
  const tokenRules = manifest.token_rules || {};
  const tdir = path.join(dsRoot, 'templates');

  // walk templates/**.html
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.name.endsWith('.html')) files.push(fp);
    }
  })(tdir);

  const components = files.sort().map(fp => {
    const html = read(fp);
    const rel = path.relative(tdir, fp).replace(/\.html$/, '').split(path.sep).join('/');
    const comment = leadingComment(html);
    const header = comment.split('\n')[0] || '';
    const designed = /DESIGNED BLOCK/i.test(comment);
    const isStatic = /STATIC/i.test(comment) || /no tokens/i.test(comment);
    const desc = (header.split('|')[1] || '').trim();

    // token descriptions from the TOKENS: section
    const tokBlock = section(comment, 'TOKENS');
    const descByName = {};
    for (const m of tokBlock.matchAll(/\{\{\s*([A-Z0-9_]+)\s*\}\}\s*[—\-:]*\s*([^\n]*)/g)) {
      const d = m[2].trim();
      if (d && d !== '"') descByName[m[1]] = d;
    }

    const palettePresets = parsePalettePresets(comment);
    const present = bodyTokens(html);

    const tokens = present.map(name => {
      const d = descByName[name] || '';
      const type = fieldType(name, d);
      return {
        name,
        desc: d,
        rule: tokenRules[name] || null,
        type,
        case: caseRule(name, d, tokenRules),
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
      designed, static: isStatic || tokens.length === 0,
      desc, tokens, palettePresets,
      ...(intent || {}),
    };
  });

  return {
    version: manifest.version,
    components,
    tokenRules,
    orderingRules: manifest.ordering_rules || null,
    assembly: manifest.assembly || null,
    // Campaign-objective taxonomy (Task 4) — canonical list + per-objective guidance.
    objectives: OBJECTIVES.map(id => ({ id, ...OBJECTIVE_GUIDANCE[id] })),
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

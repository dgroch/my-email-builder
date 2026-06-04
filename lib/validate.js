'use strict';
// validate.js — turn a campaign into an actionable, structured validation report *without*
// rendering, so agents can self-correct before assembling/saving. This is the backend's
// highest-value teaching surface (Task 5): instead of a silent "(missing template)" or a
// quietly mis-cased headline, every failure carries a rule and a concrete suggestion.
//
// Shape:
//   { ok, errorCount, warningCount, blocks:[{index, component, valid}], issues:[ … ] }
// Each issue: { severity:'error'|'warning', type, index, component, token?, value?,
//               rule, message, suggestion? }

// Group-prefixed name → its bare basename (the part after the last '/').
function baseName(name) { const i = name.lastIndexOf('/'); return i === -1 ? name : name.slice(i + 1); }

// Build lookup indexes from a /api/schema payload.
function indexSchema(schema) {
  const byName = new Map();
  const byBase = new Map();
  for (const c of schema.components || []) {
    byName.set(c.name, c);
    const b = baseName(c.name);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(c.name);
  }
  return { byName, byBase };
}

// Suggest the correct group-prefixed name for an unknown/bare component reference.
function suggestComponent(component, idx) {
  const base = baseName(component);
  const matches = idx.byBase.get(base);
  if (matches && matches.length) return matches; // e.g. "hero-d-clay" → ["heroes/hero-d-clay"]
  return [];
}

const hasUpper = (s) => /[A-Z]/.test(s);
const hasLower = (s) => /[a-z]/.test(s);
function toSentence(s) {
  const m = s.match(/[A-Za-z]/);
  if (!m) return s;
  const i = m.index;
  return s.slice(0, i) + s[i].toUpperCase() + s.slice(i + 1);
}

// Inspect one token value against its case rule. Returns an issue or null.
function caseIssue(component, index, tok, value) {
  if (value == null || typeof value !== 'string' || !/[A-Za-z]/.test(value)) return null;
  if (tok.case === 'lower' && hasUpper(value)) {
    return {
      severity: 'error', type: 'casing', index, component, token: tok.name, value,
      rule: tok.rule || `${tok.name} must be lowercase (Cervanttis script).`,
      message: `Token '${tok.name}' must be lowercase but contains capitals.`,
      suggestion: value.toLowerCase(),
    };
  }
  if (tok.case === 'sentence' && hasLower(value) && !hasUpper(value)) {
    return {
      severity: 'error', type: 'casing', index, component, token: tok.name, value,
      rule: tok.rule || `${tok.name} must be Sentence case (Lust display).`,
      message: `Token '${tok.name}' must be Sentence case but is all lowercase.`,
      suggestion: toSentence(value),
    };
  }
  return null;
}

// Validate a campaign against the schema. Pure data in → structured report out.
function validateCampaign(campaign, schema) {
  const idx = indexSchema(schema);
  const issues = [];
  const blocks = [];

  (campaign && campaign.blocks || []).forEach((block, index) => {
    const component = block.component;
    const def = idx.byName.get(component);
    let blockValid = true;

    if (!def) {
      blockValid = false;
      const suggestions = suggestComponent(component || '', idx);
      issues.push({
        severity: 'error', type: 'unknown_component', index, component,
        rule: 'component names are group-prefixed (e.g. "heroes/hero-d-clay", not "hero-d-clay").',
        message: `Unknown component '${component}'.`,
        ...(suggestions.length ? { suggestion: suggestions[0], suggestions } : {}),
      });
    } else {
      const provided = block.tokens || {};
      // Unfilled tokens: any token the template needs that the block didn't provide a key for.
      for (const tok of def.tokens) {
        if (!Object.prototype.hasOwnProperty.call(provided, tok.name)) {
          blockValid = false;
          issues.push({
            severity: 'error', type: 'unfilled_token', index, component, token: tok.name,
            rule: tok.rule || 'every {{TOKEN}} in the template must be supplied (use "" to intentionally blank one).',
            message: `Component '${component}' is missing a value for token '${tok.name}'.`,
            ...(tok.desc ? { hint: tok.desc } : {}),
          });
        }
      }
      // Casing violations on the values that were provided.
      for (const tok of def.tokens) {
        if (!tok.case) continue;
        const issue = caseIssue(component, index, tok, provided[tok.name]);
        if (issue) { blockValid = false; issues.push(issue); }
      }
    }

    blocks.push({ index, component, valid: blockValid });
  });

  const errorCount = issues.filter(i => i.severity === 'error').length;
  const warningCount = issues.filter(i => i.severity === 'warning').length;
  return { ok: errorCount === 0, errorCount, warningCount, blocks, issues };
}

module.exports = { validateCampaign, suggestComponent, indexSchema };

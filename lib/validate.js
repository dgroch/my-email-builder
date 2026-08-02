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

const render = require('./render');

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

// Closest option to a rejected enum value, by simple prefix/substring affinity — enough to
// turn "Off"/"none" into a pointer at the real option without pulling in an edit-distance lib.
function nearestOption(value, options) {
  const v = String(value).trim().toLowerCase();
  if (!v) return options[0];
  return options.find(o => o.toLowerCase() === v)
      || options.find(o => o.toLowerCase().startsWith(v) || v.startsWith(o.toLowerCase()))
      || options.find(o => o.toLowerCase().includes(v) || v.includes(o.toLowerCase()))
      || options[0];
}

// Inspect one token value against its locked enum. Returns an issue or null.
// An enum token is an art-direction lever whose options are locked by the template (they drive
// CSS class names like `illo-{{ACCENT_ILLO}}`), so an off-list value doesn't error — it just
// silently matches no rule and the lever reads as "off". That has to fail loudly.
function enumIssue(component, index, tok, value) {
  const options = tok.enumOptions || [];
  // A token that was never supplied is already reported as unfilled_token — don't double-report.
  if (!options.length || value === undefined) return null;
  if (options.includes(value)) return null;
  return {
    severity: 'error', type: 'invalid_enum', index, component, token: tok.name, value,
    options,
    rule: tok.rule || `${tok.name} is a locked enum — one of: ${options.map(o => `"${o}"`).join(' / ')}.`,
    message: `Token '${tok.name}' must be one of ${options.map(o => `"${o}"`).join(', ')} but got ${JSON.stringify(value)}.`,
    suggestion: nearestOption(value, options),
  };
}

// Inspect a URL token for an off-canonical Fig & Bloom domain. Returns an issue or null.
//
// figandbloom.com is canonical; figandbloom.com.au 301-redirects to it. A .com.au link is not a
// broken link anyone notices in review — it resolves, just via an extra hop, which costs a
// round trip and is the kind of thing that quietly drops query params in some clients. It ships
// silently. Exemplars are what the campaign generator imitates, so one stray host in a seed
// file becomes stray hosts in generated campaigns.
const BRAND_HOST = 'figandbloom.com';
function brandDomainIssue(component, index, tok, value) {
  if (typeof value !== 'string' || !value) return null;
  const m = value.match(/^https?:\/\/([^/?#]+)/i);
  if (!m) return null;
  const host = m[1].toLowerCase().replace(/:\d+$/, '');
  // Only our own domain is policed — a third-party link (the Shopify CDN, a review site) is
  // none of its business.
  if (!/(^|\.)figandbloom\.com\.au$/.test(host)) return null;
  return {
    severity: 'error', type: 'wrong_domain', index, component, token: tok.name, value,
    rule: `Fig & Bloom links must use the canonical ${BRAND_HOST} (figandbloom.com.au redirects to it).`,
    message: `Token '${tok.name}' links to '${host}', which redirects — the canonical host is ${BRAND_HOST}.`,
    suggestion: value.replace(/^(https?:\/\/[^/?#]*figandbloom\.com)\.au/i, '$1'),
  };
}

// Inspect a dimension token's value. Returns an issue or null.
//
// These interpolate straight into a CSS shorthand, so a unitless number is not a harmless
// spelling difference: `padding:100 72px 100` is invalid, the browser drops the declaration
// outright, and the padding renders as 0 with no error anywhere. Catch it at validate time.
const LENGTH_RE = /^(?:0|\d+(?:\.\d+)?(?:px|em|rem|%))$/;
function lengthIssue(component, index, tok, value) {
  if (value === undefined || value === '') return null;   // unfilled/defaulted — reported elsewhere
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (LENGTH_RE.test(v)) return null;
  return {
    severity: 'error', type: 'invalid_length', index, component, token: tok.name, value,
    rule: tok.rule || `${tok.name} is a CSS length — a number with a unit, e.g. "40px".`,
    message: `Token '${tok.name}' must be a CSS length such as "40px" but got ${JSON.stringify(value)}.`,
    ...(/^\d+(?:\.\d+)?$/.test(v) ? { suggestion: `${v}px` } : {}),
  };
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

// A campaign is only sendable if its assembled HTML carries a live unsubscribe mechanism —
// either the Klaviyo `{% unsubscribe %}` block tag (footer) or the `{{ unsubscribe_url }}`
// merge tag (sections/opt-out). Klaviyo does NOT inject one into a CODE-editor template, so a
// campaign without it is non-compliant on send. Checked against the *production* assembly,
// because the preview substitution deliberately swaps the tag for readable text.
const UNSUBSCRIBE_TAG = /\{%\s*unsubscribe\s*%\}|\{\{\s*unsubscribe_url\s*\}\}/;

function assembledHasUnsubscribe(campaign) {
  try {
    const { html } = render.assemble(campaign, { assetsBase: '', production: true });
    return UNSUBSCRIBE_TAG.test(html);
  } catch (_) {
    return false; // a campaign we can't even assemble certainly can't carry the tag
  }
}

// Validate a campaign against the schema. Pure data in → structured report out.
// opts.requireUnsubscribe (default true) asserts the assembled HTML carries an unsubscribe
// tag; pass false when validating a single component in isolation (component library samples),
// where there is no footer by construction.
function validateCampaign(campaign, schema, opts = {}) {
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
        // A token carrying a manifest default is optional — assembly fills the default in.
        if (tok.default !== undefined) continue;
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
      // Locked-enum violations on the values that were provided.
      for (const tok of def.tokens) {
        if (tok.type !== 'enum') continue;
        const issue = enumIssue(component, index, tok, provided[tok.name]);
        if (issue) { blockValid = false; issues.push(issue); }
      }
      // Off-canonical Fig & Bloom hosts on any link. Checked on every token, not just url-typed
      // ones: link tokens are named *_LINK_URL, *_URL, CTA_URL and get typed url/image/text
      // depending on how the template's comment reads, and the host is wrong in all of them.
      for (const tok of def.tokens) {
        const issue = brandDomainIssue(component, index, tok, provided[tok.name]);
        if (issue) { blockValid = false; issues.push(issue); }
      }
      // Dimension tokens that aren't valid CSS lengths (a bare "100" renders as 0).
      for (const tok of def.tokens) {
        if (tok.type !== 'length') continue;
        const issue = lengthIssue(component, index, tok, provided[tok.name]);
        if (issue) { blockValid = false; issues.push(issue); }
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

  // Campaign-level: nothing ships without an unsubscribe link.
  if (opts.requireUnsubscribe !== false && blocks.length && !assembledHasUnsubscribe(campaign)) {
    issues.push({
      severity: 'error', type: 'missing_unsubscribe',
      rule: 'every campaign must carry an unsubscribe tag — Klaviyo does not inject one into a CODE-editor template.',
      message: 'Assembled HTML contains no unsubscribe tag ({% unsubscribe %} or {{ unsubscribe_url }}).',
      suggestion: 'footer',
      hint: "Add the 'footer' component (it carries the {% unsubscribe %} block tag), or 'sections/opt-out' with UNSUBSCRIBE_URL set to '{{ unsubscribe_url }}'.",
    });
  }

  const errorCount = issues.filter(i => i.severity === 'error').length;
  const warningCount = issues.filter(i => i.severity === 'warning').length;
  return { ok: errorCount === 0, errorCount, warningCount, blocks, issues };
}

module.exports = { validateCampaign, suggestComponent, indexSchema };

'use strict';
// exportTargets.js — the small differences between a Klaviyo export and a Resend broadcast.
//
// The default target is, and must remain, `klaviyo`: its output is byte-for-byte the same HTML
// (aside from the email-image crop fix) so existing pasted exports do not change.
//
// Resend differs in three places:
//   1. the footer's Klaviyo merge tags are replaced by Resend's triple-brace unsubscribe URL and
//      the literal postal address;
//   2. the <title> is the subject line (Klaviyo uses the campaign name);
//   3. developer comments are stripped (Resend parses template tags inside HTML comments, and
//      author docs have no business in a sent email).
//
// The triple-brace Resend token is a send-time provider tag. It *contains* a double-brace token,
// so the unresolved-token gate must exclude it explicitly — otherwise every resend export 422s.

const TARGETS = ['klaviyo', 'resend'];
const PROVIDER_TOKENS = new Set(['RESEND_UNSUBSCRIBE_URL']);

const KLAVIYO_UNSUBSCRIBE_TAG = /\{%\s*unsubscribe\s*%\}|\{\{\s*unsubscribe_url\s*\}\}/;
const RESEND_UNSUBSCRIBE_TAG = /\{\{\{\s*RESEND_UNSUBSCRIBE_URL\s*\}\}\}/;
const RESEND_ADDRESS = 'Fig & Bloom · 274 Wingrove St, Fairfield VIC 3078';

function normalizeTarget(value) {
  const t = value == null || value === '' ? 'klaviyo' : String(value).trim().toLowerCase();
  if (!TARGETS.includes(t)) {
    const err = new Error(`Unsupported export target '${value}'. Use "klaviyo" (default) or "resend".`);
    err.code = 'INVALID_EXPORT_TARGET';
    throw err;
  }
  return t;
}

// Swap the footer's provider tags for Resend's. The rest of the document is untouched.
function applyResendFooter(html) {
  return String(html || '')
    // Klaviyo's standalone block tag → a real link, so the recipient can act on it.
    .replace(/\{%\s*unsubscribe\s*%\}/g, '<a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Unsubscribe</a>')
    // sections/opt-out carries the token as a value; replace the token itself.
    .replace(/\{\{\s*unsubscribe_url\s*\}\}/g, '{{{RESEND_UNSUBSCRIBE_URL}}}')
    // The footer's organization line. Klaviyo resolves these; Resend needs literal copy.
    .replace(/\{\{\s*organization\.name\s*\}\}\s*\{\{\s*organization\.full_address\s*\}\}/g, RESEND_ADDRESS)
    .replace(/\{\{\s*organization\.name\s*\}\}/g, 'Fig & Bloom')
    .replace(/\{\{\s*organization\.full_address\s*\}\}/g, '274 Wingrove St, Fairfield VIC 3078');
}

// Every unresolved {{TOKEN}} except a triple-brace provider tag. Mirrors render.assemble's
// PROVIDER_TOKENS special case: a double-brace {{RESEND_UNSUBSCRIBE_URL}} is still unresolved.
function unresolvedTokens(html) {
  const found = new Set();
  for (const m of String(html || '').matchAll(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g)) {
    const name = m[1];
    const before = html[m.index - 1];
    const after = html[m.index + m[0].length];
    if (PROVIDER_TOKENS.has(name) && before === '{' && after === '}') continue;
    found.add(m[0]);
  }
  return [...found];
}

function hasUnsubscribe(html, target) {
  // The resend path converts the Klaviyo footer, so either source tag is acceptable while
  // validating the campaign. The default/klaviyo target keeps the original Klaviyo-only rule.
  if (target === 'resend') return RESEND_UNSUBSCRIBE_TAG.test(html) || KLAVIYO_UNSUBSCRIBE_TAG.test(html);
  return KLAVIYO_UNSUBSCRIBE_TAG.test(html);
}

module.exports = {
  TARGETS,
  PROVIDER_TOKENS,
  RESEND_ADDRESS,
  KLAVIYO_UNSUBSCRIBE_TAG,
  RESEND_UNSUBSCRIBE_TAG,
  normalizeTarget,
  applyResendFooter,
  unresolvedTokens,
  hasUnsubscribe,
};

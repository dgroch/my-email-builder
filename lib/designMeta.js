'use strict';
// designMeta.js — the additive metadata carried on every saved design, shared by both the
// disk store (lib/designs.js) and the Notion store (lib/notionStore.js) so the two backends
// stay at interface parity. Covers Task 2 (isExample/objective) and Task 6 (rich metadata
// for searchable/reusable approved patterns).

// The metadata fields a caller may set on create/update. `componentsUsed` is NOT here — it
// is always *derived* from the campaign, never accepted from the client.
const META_FIELDS = [
  'isExample',         // boolean — surface via GET /api/examples
  'objective',         // string  — campaign-objective taxonomy id (see /api/schema objectives)
  'campaignType',      // string  — free-form campaign type / theme
  'audienceAwareness', // string  — e.g. "cold", "engaged", "past-purchaser"
  'primaryCTA',        // string  — the main call-to-action text
  'emotionalTone',     // string  — e.g. "warm, nostalgic"
  'approvalStatus',    // 'draft' | 'approved' | 'sent'
  'sourceBriefLink',   // url     — link to the brief this was built from
  'klaviyoLink',       // url     — link to the Klaviyo draft/campaign
  'resultNotes',       // string  — post-send performance notes
];

const APPROVAL_STATUSES = ['draft', 'approved', 'sent'];

// Unique, order-preserving list of component names used by a campaign.
function deriveComponentsUsed(campaign) {
  const seen = [];
  for (const b of (campaign && campaign.blocks) || []) {
    if (b && b.component && !seen.includes(b.component)) seen.push(b.component);
  }
  return seen;
}

// Pull only the recognised metadata fields out of an arbitrary input object, coercing the
// obvious types. Unset fields are omitted (so update() only touches what was provided).
function pickMeta(input = {}) {
  const out = {};
  for (const k of META_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, k)) continue;
    let v = input[k];
    if (k === 'isExample') v = !!v;
    else if (k === 'approvalStatus') v = APPROVAL_STATUSES.includes(v) ? v : 'draft';
    else if (v == null) v = '';
    else v = String(v);
    out[k] = v;
  }
  return out;
}

// Apply defaults for a brand-new record (only where the caller didn't specify).
function withCreateDefaults(meta) {
  const out = { ...meta };
  if (!Object.prototype.hasOwnProperty.call(out, 'isExample')) out.isExample = false;
  if (!Object.prototype.hasOwnProperty.call(out, 'approvalStatus')) out.approvalStatus = 'draft';
  return out;
}

module.exports = { META_FIELDS, APPROVAL_STATUSES, deriveComponentsUsed, pickMeta, withCreateDefaults };

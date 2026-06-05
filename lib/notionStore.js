'use strict';
// notionStore.js — persist campaign designs in a Notion database (durable across redeploys).
// Same interface as lib/designs.js, but async. The server picks this when NOTION_TOKEN is set.
//
// Each design is one page in the Notion database NOTION_DESIGNS_DB:
//   - Name (title), Updated (date), Created (date) are the always-present properties;
//   - the full campaign JSON lives in the page body as a run of ```json code blocks under a
//     "Campaign JSON" heading (Notion caps a single text run at 2000 chars, so we chunk it);
//   - the design metadata (isExample / objective / approval status / etc. — Tasks 2 & 6) is
//     written as a second ```json block under a "Design metadata" heading. The body block is
//     the source of truth so metadata round-trips even on a database that has no extra columns.
//
// Optional native columns: if the database has matching properties (e.g. "Objective",
// "Is Example", "Approval Status", "Components Used", "Klaviyo Link", …) the metadata is ALSO
// mirrored into them so designs are filterable/searchable in Notion. Add those columns to
// NOTION_DESIGNS_DB to light this up; without them, nothing breaks — list() just reports the
// defaults and get() reads the full metadata from the body block.
//
// Env: NOTION_TOKEN (internal integration secret), NOTION_DESIGNS_DB (database id).
// The integration must be shared with the database (Notion → ••• → Connections).

const https = require('https');
const { deriveComponentsUsed, pickMeta, withCreateDefaults } = require('./designMeta');

const HOST = 'api.notion.com';
const VERSION = process.env.NOTION_VERSION || '2022-06-28';
const TOKEN = () => process.env.NOTION_TOKEN;
const DB = () => process.env.NOTION_DESIGNS_DB;
const CHUNK = 1800; // < Notion's 2000-char limit per text run

function api(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'Authorization': 'Bearer ' + TOKEN(),
      'Notion-Version': VERSION,
      'Accept': 'application/json',
    };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const req = https.request({ hostname: HOST, path: apiPath, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (_) {}
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        const msg = (parsed && parsed.message) || data.slice(0, 300);
        reject(new Error(`Notion ${method} ${apiPath} → ${res.statusCode}: ${msg}`));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Notion ids are uuids; accept dashed or dashless and normalise.
function validId(id) { return typeof id === 'string' && /^[0-9a-f]{32}$|^[0-9a-f-]{36}$/i.test(id); }
const isoDate = (s) => (s ? String(s).slice(0, 10) : new Date().toISOString().slice(0, 10));
const rtText = (arr) => (arr || []).map((t) => t.plain_text || (t.text && t.text.content) || '').join('');

// ── page body: a Campaign JSON section + a Design metadata section ───────────
const CAMPAIGN_HEADING = 'Campaign JSON (managed by the email builder — do not edit by hand)';
const META_HEADING = 'Design metadata (managed by the email builder — do not edit by hand)';

function heading(content) { return { object: 'block', type: 'heading_3', heading_3: { rich_text: [{ type: 'text', text: { content } }] } }; }
function chunkCode(text) {
  const blocks = [];
  for (let i = 0; i < text.length; i += CHUNK) {
    blocks.push({ object: 'block', type: 'code', code: { language: 'json', rich_text: [{ type: 'text', text: { content: text.slice(i, i + CHUNK) } }] } });
  }
  return blocks;
}
function bodyBlocks(campaign, meta) {
  return [
    heading(CAMPAIGN_HEADING), ...chunkCode(JSON.stringify(campaign || {}, null, 2)),
    heading(META_HEADING), ...chunkCode(JSON.stringify(meta || {}, null, 2)),
  ];
}
function blockText(b) {
  const rt = (b.code && b.code.rich_text) || [];
  return rt.map((r) => r.plain_text || (r.text && r.text.content) || '').join('');
}

// Walk children, splitting code text into the campaign vs. metadata buckets by the heading
// that precedes them. Legacy pages (no metadata heading) yield an empty metaText.
async function readBody(pageId) {
  let campaignText = '', metaText = '', section = 'campaign', cursor;
  do {
    const q = cursor ? `?start_cursor=${cursor}&page_size=100` : '?page_size=100';
    const page = await api('GET', `/v1/blocks/${pageId}/children${q}`);
    for (const b of (page.results || [])) {
      if (b.type === 'heading_3') {
        const t = rtText(b.heading_3 && b.heading_3.rich_text);
        if (/Design metadata/i.test(t)) section = 'meta';
        else if (/Campaign JSON/i.test(t)) section = 'campaign';
      } else if (b.type === 'code') {
        if (section === 'meta') metaText += blockText(b); else campaignText += blockText(b);
      }
    }
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return { campaignText, metaText };
}

async function deleteChildren(pageId) {
  let cursor;
  const ids = [];
  do {
    const q = cursor ? `?start_cursor=${cursor}&page_size=100` : '?page_size=100';
    const page = await api('GET', `/v1/blocks/${pageId}/children${q}`);
    for (const b of (page.results || [])) ids.push(b.id);
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  for (const id of ids) await api('DELETE', `/v1/blocks/${id}`);
}

// ── metadata ↔ native Notion columns (optional, best-effort) ─────────────────
// Our metadata field → acceptable Notion property names. First existing column wins.
const PROP_NAMES = {
  isExample: ['Is Example', 'IsExample', 'Example'],
  objective: ['Objective'],
  campaignType: ['Campaign Type', 'CampaignType'],
  audienceAwareness: ['Audience Awareness', 'AudienceAwareness'],
  primaryCTA: ['Primary CTA', 'PrimaryCTA'],
  emotionalTone: ['Emotional Tone', 'EmotionalTone'],
  approvalStatus: ['Approval Status', 'ApprovalStatus'],
  componentsUsed: ['Components Used', 'ComponentsUsed'],
  sourceBriefLink: ['Source Brief', 'Source Brief Link', 'SourceBrief'],
  klaviyoLink: ['Klaviyo Link', 'KlaviyoLink', 'Klaviyo'],
  resultNotes: ['Result Notes', 'ResultNotes'],
};

let _dbProps = null, _dbPropsAt = 0;
async function dbProps() {
  if (_dbProps && (Date.now() - _dbPropsAt) < 60000) return _dbProps;
  try { const db = await api('GET', `/v1/databases/${DB()}`); _dbProps = db.properties || {}; _dbPropsAt = Date.now(); }
  catch (_) { _dbProps = _dbProps || {}; }
  return _dbProps;
}

// Build a Notion property value for a metadata field, matching the column's actual type.
function buildValue(type, value) {
  switch (type) {
    case 'checkbox': return { checkbox: !!value };
    case 'select': return value ? { select: { name: String(value).slice(0, 100) } } : { select: null };
    case 'multi_select': {
      const arr = Array.isArray(value) ? value : (value ? [value] : []);
      return { multi_select: arr.map((v) => ({ name: String(v).slice(0, 100) })) };
    }
    case 'url': return { url: value ? String(value) : null };
    case 'rich_text': return { rich_text: value != null && String(value) !== '' ? [{ type: 'text', text: { content: String(value).slice(0, 1900) } }] : [] };
    default: return undefined; // title / status / date / unsupported → leave alone
  }
}

async function metaToProps(meta) {
  const props = await dbProps();
  const out = {};
  for (const [field, names] of Object.entries(PROP_NAMES)) {
    if (!Object.prototype.hasOwnProperty.call(meta, field)) continue;
    const colName = names.find((n) => props[n]);
    if (!colName) continue;
    const built = buildValue(props[colName].type, meta[field]);
    if (built !== undefined) out[colName] = built;
  }
  return out;
}

function propValue(prop) {
  if (!prop) return undefined;
  switch (prop.type) {
    case 'checkbox': return prop.checkbox;
    case 'select': return prop.select ? prop.select.name : '';
    case 'status': return prop.status ? prop.status.name : '';
    case 'multi_select': return (prop.multi_select || []).map((o) => o.name);
    case 'url': return prop.url || '';
    case 'rich_text': return rtText(prop.rich_text);
    case 'date': return prop.date ? prop.date.start : '';
    default: return undefined;
  }
}
function readNativeMeta(props) {
  const out = {};
  for (const [field, names] of Object.entries(PROP_NAMES)) {
    const colName = names.find((n) => props[n]);
    if (!colName) continue;
    const v = propValue(props[colName]);
    if (v !== undefined) out[field] = v;
  }
  return out;
}

// Fill any missing metadata fields with their defaults (and derive componentsUsed if absent).
function normalizeMeta(md = {}, campaign) {
  return {
    isExample: !!md.isExample,
    objective: md.objective || '',
    campaignType: md.campaignType || '',
    audienceAwareness: md.audienceAwareness || '',
    primaryCTA: md.primaryCTA || '',
    subjectLine: md.subjectLine || '',
    previewText: md.previewText || '',
    emotionalTone: md.emotionalTone || '',
    approvalStatus: md.approvalStatus || 'draft',
    componentsUsed: Array.isArray(md.componentsUsed) ? md.componentsUsed : (campaign ? deriveComponentsUsed(campaign) : []),
    sourceBriefLink: md.sourceBriefLink || '',
    klaviyoLink: md.klaviyoLink || '',
    resultNotes: md.resultNotes || '',
  };
}

// Map a Notion page object to our design metadata (name/dates + any native metadata columns).
function meta(pg) {
  const props = pg.properties || {};
  const title = (props.Name && rtText(props.Name.title)) || 'Untitled design';
  const updated = (props.Updated && props.Updated.date && props.Updated.date.start) || pg.last_edited_time;
  const created = (props.Created && props.Created.date && props.Created.date.start) || pg.created_time;
  return { id: pg.id, name: title, createdAt: created, updatedAt: updated, ...normalizeMeta(readNativeMeta(props)) };
}

function titleProp(title) { return { title: [{ type: 'text', text: { content: title } }] }; }

async function list() {
  const r = await api('POST', `/v1/databases/${DB()}/query`, {
    page_size: 100,
    sorts: [{ property: 'Updated', direction: 'descending' }],
  });
  return (r.results || []).map(meta);
}

async function get(id) {
  if (!validId(id)) return null;
  let pg;
  try { pg = await api('GET', `/v1/pages/${id}`); } catch (_) { return null; }
  if (!pg || pg.archived) return null;
  const m = meta(pg);
  const { campaignText, metaText } = await readBody(id);
  let campaign = {};
  try { campaign = JSON.parse(campaignText || '{}'); } catch (_) { campaign = {}; }
  let md = {};
  try { md = metaText ? JSON.parse(metaText) : {}; } catch (_) { md = {}; }
  // Body metadata is authoritative; native columns only fill gaps.
  return { ...m, ...normalizeMeta(md, campaign), campaign };
}

async function create(input = {}) {
  const { name, campaign } = input;
  const now = new Date().toISOString();
  const title = (name || (campaign && campaign.campaignName) || 'Untitled design').trim();
  const md = withCreateDefaults(pickMeta(input));
  md.componentsUsed = deriveComponentsUsed(campaign);
  const properties = {
    Name: titleProp(title),
    Updated: { date: { start: isoDate(now) } },
    Created: { date: { start: isoDate(now) } },
    ...(await metaToProps(md)),
  };
  const pg = await api('POST', '/v1/pages', { parent: { database_id: DB() }, properties, children: bodyBlocks(campaign, md) });
  return { id: pg.id, name: title, createdAt: now, updatedAt: now, ...normalizeMeta(md, campaign), campaign: campaign || {} };
}

async function update(id, input = {}) {
  if (!validId(id)) return null;
  let pg;
  try { pg = await api('GET', `/v1/pages/${id}`); } catch (_) { return null; }
  if (!pg || pg.archived) return null;

  const { name, campaign } = input;
  const incoming = pickMeta(input);
  const hasMetaChange = Object.keys(incoming).length > 0;

  // Merge against existing body metadata so we never drop fields we aren't changing.
  let cur = null;
  if (campaign != null || hasMetaChange) cur = await get(id);
  const md = normalizeMeta({ ...(cur || {}), ...incoming }, campaign != null ? campaign : (cur && cur.campaign));

  const props = { Updated: { date: { start: isoDate(new Date().toISOString()) } }, ...(await metaToProps(md)) };
  if (name != null && String(name).trim()) props.Name = titleProp(String(name).trim());
  await api('PATCH', `/v1/pages/${id}`, { properties: props });

  // Rewrite the body when the campaign or any metadata changed (so the metadata block stays current).
  if (campaign != null || hasMetaChange) {
    const nextCampaign = campaign != null ? campaign : (cur && cur.campaign) || {};
    await deleteChildren(id);
    await api('PATCH', `/v1/blocks/${id}/children`, { children: bodyBlocks(nextCampaign, md) });
  }
  return get(id);
}

async function clone(id, name) {
  const cur = await get(id);
  if (!cur) return null;
  // Carry over the descriptive metadata, but a clone starts as a fresh draft (not an example).
  return create({
    name: name || (cur.name + ' (copy)'), campaign: cur.campaign,
    objective: cur.objective, campaignType: cur.campaignType, audienceAwareness: cur.audienceAwareness,
    primaryCTA: cur.primaryCTA, emotionalTone: cur.emotionalTone, sourceBriefLink: cur.sourceBriefLink,
    isExample: false, approvalStatus: 'draft',
  });
}

async function remove(id) {
  if (!validId(id)) return false;
  try { await api('PATCH', `/v1/pages/${id}`, { archived: true }); return true; } catch (_) { return false; }
}

module.exports = { list, get, create, update, clone, remove, backend: 'notion' };

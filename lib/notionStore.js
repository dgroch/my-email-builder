'use strict';
// notionStore.js — persist campaign designs in a Notion database (durable across redeploys).
// Same interface as lib/designs.js, but async. The server picks this when NOTION_TOKEN is set.
//
// Each design is one page in the Notion database NOTION_DESIGNS_DB:
//   - Name (title), Updated (date), Created (date) are visible properties;
//   - the full campaign JSON lives in the page body as a run of ```json code blocks
//     (Notion caps a single text run at 2000 chars, so we chunk it).
//
// Env: NOTION_TOKEN (internal integration secret), NOTION_DESIGNS_DB (database id).
// The integration must be shared with the database (Notion → ••• → Connections).

const https = require('https');

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

// campaign JSON → array of "json" code blocks (chunked under the per-run limit).
function jsonToBlocks(campaign) {
  const text = JSON.stringify(campaign || {}, null, 2);
  const blocks = [{ object: 'block', type: 'heading_3', heading_3: { rich_text: [{ type: 'text', text: { content: 'Campaign JSON (managed by the email builder — do not edit by hand)' } }] } }];
  for (let i = 0; i < text.length; i += CHUNK) {
    const slice = text.slice(i, i + CHUNK);
    blocks.push({ object: 'block', type: 'code', code: { language: 'json', rich_text: [{ type: 'text', text: { content: slice } }] } });
  }
  return blocks;
}

function blockText(b) {
  const rt = (b.code && b.code.rich_text) || [];
  return rt.map((r) => r.plain_text || (r.text && r.text.content) || '').join('');
}

async function childCodeText(pageId) {
  let text = '', cursor;
  do {
    const q = cursor ? `?start_cursor=${cursor}&page_size=100` : '?page_size=100';
    const page = await api('GET', `/v1/blocks/${pageId}/children${q}`);
    for (const b of (page.results || [])) if (b.type === 'code') text += blockText(b);
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return text;
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

const rtText = (arr) => (arr || []).map((t) => t.plain_text || (t.text && t.text.content) || '').join('');

// Map a Notion page object to our design metadata.
function meta(pg) {
  const props = pg.properties || {};
  const title = (props.Name && rtText(props.Name.title)) || 'Untitled design';
  const updated = (props.Updated && props.Updated.date && props.Updated.date.start) || pg.last_edited_time;
  const created = (props.Created && props.Created.date && props.Created.date.start) || pg.created_time;
  return { id: pg.id, name: title, createdAt: created, updatedAt: updated };
}

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
  let campaign = {};
  try { campaign = JSON.parse(await childCodeText(id) || '{}'); } catch (_) { campaign = {}; }
  return { ...m, campaign };
}

async function create({ name, campaign }) {
  const now = new Date().toISOString();
  const title = (name || (campaign && campaign.campaignName) || 'Untitled design').trim();
  const pg = await api('POST', '/v1/pages', {
    parent: { database_id: DB() },
    properties: {
      Name: { title: [{ type: 'text', text: { content: title } }] },
      Updated: { date: { start: isoDate(now) } },
      Created: { date: { start: isoDate(now) } },
    },
    children: jsonToBlocks(campaign),
  });
  return { id: pg.id, name: title, createdAt: now, updatedAt: now, campaign: campaign || {} };
}

async function update(id, { name, campaign }) {
  if (!validId(id)) return null;
  let pg;
  try { pg = await api('GET', `/v1/pages/${id}`); } catch (_) { return null; }
  if (!pg || pg.archived) return null;
  const props = { Updated: { date: { start: isoDate(new Date().toISOString()) } } };
  if (name != null && String(name).trim()) props.Name = { title: [{ type: 'text', text: { content: String(name).trim() } }] };
  await api('PATCH', `/v1/pages/${id}`, { properties: props });
  if (campaign != null) {
    await deleteChildren(id);
    await api('PATCH', `/v1/blocks/${id}/children`, { children: jsonToBlocks(campaign) });
  }
  return get(id);
}

async function clone(id, name) {
  const cur = await get(id);
  if (!cur) return null;
  return create({ name: name || (cur.name + ' (copy)'), campaign: cur.campaign });
}

async function remove(id) {
  if (!validId(id)) return false;
  try { await api('PATCH', `/v1/pages/${id}`, { archived: true }); return true; } catch (_) { return false; }
}

module.exports = { list, get, create, update, clone, remove, backend: 'notion' };

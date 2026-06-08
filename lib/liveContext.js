'use strict';
// lib/liveContext.js — gather "live context" for the campaign generator.
//
// The Fig & Bloom email-builder "Create campaign" button is a fast path — most
// of the brand context (voice, personas, lens routing) is baked into the
// generator's static system prompt. But the *live* state (active products in
// the Shopify store today, real Klaviyo list/segment IDs, published blog
// posts with their canonical URLs) is not — it changes daily. This module
// gathers that live state from three sources, gracefully degrading when any
// are unavailable, and caches the result for 15 minutes.
//
// The agent in conversation (path C, future) builds its own richer live
// context and passes it directly to /api/campaigns/generate. This module
// is what the *button* uses.

const https = require('https');
const { URL } = require('url');

const CACHE_TTL_MS = 15 * 60 * 1000;        // 15 minutes
const SHOPIFY_BASE = process.env.SHOPIFY_STORE_DOMAIN || 'figandbloom.com.au';
const SHOPIFY_PRODUCTS_URL = `https://${SHOPIFY_BASE}/products.json?limit=250`;
const KLAVIYO_LISTS_URL = 'https://a.klaviyo.com/api/lists/';
const KLAVIYO_SEGMENTS_URL = 'https://a.klaviyo.com/api/segments/';
// Notion blog index lives in the marketing space; the email builder reads it
// only if NOTION_TOKEN + NOTION_BLOG_INDEX_PAGE are set. Page is configured
// to hold one block per blog post with the canonical Shopify URL.
const NOTION_VERSION = '2025-09-03';

let _cache = null;        // { fetchedAt, payload }
let _inflight = null;     // dedupe concurrent fetches


function getCache() {
  if (!_cache) return null;
  if (Date.now() - _cache.fetchedAt > CACHE_TTL_MS) return null;
  return _cache.payload;
}


/** GET a URL and return parsed JSON, or throw. */
function fetchJson(urlStr, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET', headers: headers || {} },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          try {
            const parsed = buf ? JSON.parse(buf) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
            reject(new Error(`HTTP ${res.statusCode} from ${urlStr}: ${buf.slice(0, 300)}`));
          } catch (e) {
            reject(new Error(`non-JSON from ${urlStr}: ${buf.slice(0, 300)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}


/** Fetch a Notion page's child blocks (recursive) and pull paragraph text. */
async function fetchNotionPage(pageId, token) {
  const headers = {
    'Authorization': 'Bearer ' + token,
    'Notion-Version': NOTION_VERSION,
  };
  const out = [];
  let cursor = null;
  while (true) {
    const path = `/blocks/${pageId}/children` + (cursor ? '?start_cursor=' + encodeURIComponent(cursor) : '');
    const data = await fetchJson('https://api.notion.com/v1' + path, headers);
    for (const blk of data.results || []) {
      const bt = blk.type;
      const rich = (blk[bt] && blk[bt].rich_text) || [];
      const text = rich.map((r) => r.plain_text || '').join('');
      if (text) out.push(text);
      if (blk.has_children) {
        const child = await fetchNotionPage(blk.id, token);
        out.push(...child);
      }
    }
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return out;
}


/** Extract blog entries from a page of bullet/paragraph lines like
 *    - "What to write on a flower card" — https://figandbloom.com/blogs/news/...
 *  or simply lines that contain a figandbloom.com/blogs/ URL. */
function parseBlogIndex(lines) {
  const out = [];
  const urlRe = /https?:\/\/figandbloom\.com\.au\/blogs\/[^\s)]+/i;
  for (const line of lines) {
    const m = line.match(urlRe);
    if (!m) continue;
    const url = m[0];
    // Title = the line minus the URL, trimmed of leading bullets/dashes/quotes
    const title = line.replace(url, '')
      .replace(/^[\s\-•*'"“”‘’]+/, '').replace(/[\s\-•*'"“”‘’]+$/, '')
      .replace(/\s+—\s*$/, '')
      .trim();
    if (!title || title.length < 3) continue;
    out.push({ title: title.slice(0, 200), url });
  }
  // Dedupe by URL
  const seen = new Set();
  return out.filter((p) => seen.has(p.url) ? false : (seen.add(p.url), true));
}


/** Get current Australia/Sydney ISO timestamp (for the asOf field). */
function nowSydney() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Australia/Sydney',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date()).replace(',', '') + '+10:00';
  } catch (_) {
    return new Date().toISOString();
  }
}


/** Pull the live Shopify products list. Returns the curated array. */
async function gatherShopify() {
  try {
    const data = await fetchJson(SHOPIFY_PRODUCTS_URL, {
      'User-Agent': 'FigAndBloom-EmailBuilder/1.0',
      'Accept': 'application/json',
    });
    const products = (data.products || [])
      .filter((p) => p && p.handle && p.title)
      .map((p) => {
        const minPrice = (p.variants || [])
          .map((v) => parseFloat(v.price))
          .filter((n) => !isNaN(n) && n > 0)
          .reduce((a, b) => (a == null ? b : Math.min(a, b)), null);
        const image = p.image || (p.images && p.images[0]) || null;
        return {
          title: p.title,
          handle: p.handle,
          productType: p.product_type || '',
          tags: Array.isArray(p.tags) ? p.tags : (typeof p.tags === 'string' ? p.tags.split(',').map((s) => s.trim()) : []),
          fromPrice: minPrice != null ? minPrice.toFixed(2) : null,
          priceText: minPrice != null ? ('From A$' + minPrice.toFixed(0)) : '',
          imageUrl: image ? (image.src || '') : '',
          url: 'https://figandbloom.com.au/products/' + p.handle,
        };
      });
    return { ok: true, products };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}


/** Pull Klaviyo lists + segments. */
async function gatherKlaviyo() {
  const apiKey = process.env.KLAVIYO_API_KEY;
  if (!apiKey) return { ok: false, error: 'KLAVIYO_API_KEY not set' };
  const headers = {
    'Authorization': 'Klaviyo-API-Key ' + apiKey,
    'Accept': 'application/vnd.api+json',
    'revision': process.env.KLAVIYO_REVISION || '2026-04-15',
  };
  const out = [];
  try {
    // Lists
    const lists = await fetchJson(KLAVIYO_LISTS_URL, headers);
    for (const l of (lists.data || [])) {
      out.push({ id: l.id, name: l.attributes && l.attributes.name || '(unnamed list)', type: 'list' });
    }
  } catch (e) {
    return { ok: false, error: 'lists: ' + String((e && e.message) || e) };
  }
  try {
    // Segments
    const segs = await fetchJson(KLAVIYO_SEGMENTS_URL, headers);
    for (const s of (segs.data || [])) {
      out.push({ id: s.id, name: s.attributes && s.attributes.name || '(unnamed segment)', type: 'segment' });
    }
  } catch (e) {
    // Segments can 403 with the wrong scope; lists succeeded — still return lists.
    return { ok: true, audiences: out, warning: 'segments unavailable: ' + String((e && e.message) || e) };
  }
  return { ok: true, audiences: out };
}


/** Pull the Notion blog index. */
async function gatherNotionBlog() {
  const token = process.env.NOTION_TOKEN;
  const pageId = process.env.NOTION_BLOG_INDEX_PAGE;
  if (!token || !pageId) return { ok: false, error: 'NOTION_TOKEN or NOTION_BLOG_INDEX_PAGE not set' };
  try {
    const lines = await fetchNotionPage(pageId, token);
    const blogPosts = parseBlogIndex(lines);
    return { ok: true, blogPosts };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}


/** Gather all three sources in parallel, gracefully degrading. */
async function gather({ forceFresh = false } = {}) {
  if (!forceFresh) {
    const cached = getCache();
    if (cached) return { ...cached, cached: true };
  }
  if (_inflight) return _inflight;

  _inflight = (async () => {
    const [shopRes, klavRes, notionRes] = await Promise.all([
      gatherShopify(),
      gatherKlaviyo(),
      gatherNotionBlog(),
    ]);

    const products = shopRes.ok ? shopRes.products : [];
    const audiences = klavRes.ok ? klavRes.audiences : [];
    const blogPosts = notionRes.ok ? notionRes.blogPosts : [];

    const status = {
      products: products.length ? 'ok' : 'unavailable',
      audiences: audiences.length ? 'ok' : (klavRes.ok ? 'ok' : 'unavailable'),
      blogPosts: blogPosts.length ? 'ok' : 'unavailable',
    };
    const errors = {};
    if (!shopRes.ok) errors.products = shopRes.error;
    if (!klavRes.ok) errors.audiences = klavRes.error;
    if (klavRes.warning) errors.audiences_warning = klavRes.warning;
    if (!notionRes.ok) errors.blogPosts = notionRes.error;

    const payload = {
      asOf: nowSydney(),
      products,
      audiences,
      blogPosts,
      contextStatus: status,
      errors: Object.keys(errors).length ? errors : undefined,
    };
    _cache = { fetchedAt: Date.now(), payload };
    return { ...payload, cached: false };
  })();

  try {
    return await _inflight;
  } finally {
    _inflight = null;
  }
}


/** Reset the cache (test helper). */
function reset() {
  _cache = null;
  _inflight = null;
}


module.exports = {
  gather,
  reset,
  getCache,
  // Exposed for tests
  _internal: {
    CACHE_TTL_MS,
    parseBlogIndex,
    renderLiveContextBlock: (p) => {
      // Local mirror of the generator's renderer — used by tests.
      const lines = [];
      if (p.asOf) lines.push('As of: ' + p.asOf);
      if (p.products && p.products.length) {
        lines.push('ACTIVE PRODUCTS:');
        for (const x of p.products) lines.push('- ' + x.title + ' — ' + (x.priceText || ''));
      }
      if (p.audiences && p.audiences.length) {
        lines.push('AUDIENCES:');
        for (const a of p.audiences) lines.push('- ' + a.id + ' — ' + a.name);
      }
      if (p.blogPosts && p.blogPosts.length) {
        lines.push('BLOG POSTS:');
        for (const b of p.blogPosts) lines.push('- "' + b.title + '" — ' + b.url);
      }
      return lines.join('\n');
    },
  },
};

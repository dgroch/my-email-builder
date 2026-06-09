'use strict';
// lib/liveContext.js — gather "live context" for the campaign generator.
//
// The Fig & Bloom email-builder "Create campaign" button is a fast path — most
// of the brand context (voice, personas, lens routing) is baked into the
// generator's static system prompt. But the *live* state (active products in
// the Shopify store today, real Klaviyo list/segment IDs, recent blog posts
// from the Shopify Atom feed, and lifestyle imagery from the asset library)
// is not — it changes daily. This module gathers that live state from four
// sources, gracefully degrading when any are unavailable, and caches the
// brief-agnostic result for 15 minutes.
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
const ASSET_LIBRARY_URL = (process.env.ASSET_LIBRARY_URL || 'https://asset-library-u70t.onrender.com').replace(/\/$/, '');
const ASSET_LIBRARY_REFERER = process.env.ASSET_LIBRARY_REFERER || 'https://my-email-builder.onrender.com/';
// Shopify blog index — the store publishes an Atom feed at /blogs/news.atom
// (figandbloom.com → figandbloom.com.au). Public, no auth. Top 20 most recent.
const SHOPIFY_BLOG_FEED_URL = (process.env.SHOPIFY_BLOG_FEED_URL
  || 'https://figandbloom.com/blogs/news.atom');
const SHOPIFY_BLOG_MAX = parseInt(process.env.SHOPIFY_BLOG_MAX || '20', 10);

let _cache = null;        // { fetchedAt, products, audiences, blogPosts } — brief-agnostic only
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


/** Fetch the Shopify Atom feed at /blogs/news.atom and return the raw XML. */
function fetchAtomFeed(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET',
        headers: { 'User-Agent': 'FigAndBloom-EmailBuilder/1.0', 'Accept': 'application/atom+xml, application/xml, text/xml' },
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(buf);
          reject(new Error(`HTTP ${res.statusCode} from ${urlStr}: ${buf.slice(0, 300)}`));
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}


/** Parse an Atom feed XML string. Returns up to N posts as {title, url, updated}.
 *  Robust to attribute-encoded CDATA, leading whitespace, and missing <updated>. */
function parseAtomFeed(xml, max) {
  if (!xml || typeof xml !== 'string') return [];
  // Find every <entry>...</entry> block (case-insensitive, non-greedy)
  const blocks = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  const out = [];
  const seen = new Set();
  for (const blk of blocks) {
    // <title> with optional type attr and CDATA-wrapped text
    const titleMatch = blk.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i);
    let title = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim() : '';
    // <link href="..." rel="alternate"/> (alternate, or first link if no rel)
    const altLink = blk.match(/<link[^>]*?rel=["']alternate["'][^>]*?href=["']([^"']+)["']/i);
    const anyLink = blk.match(/<link[^>]*?href=["']([^"']+)["']/i);
    const url = (altLink && altLink[1]) || (anyLink && anyLink[1]) || '';
    if (!url) continue;
    // <updated>YYYY-MM-DD...
    const updMatch = blk.match(/<updated>([\s\S]*?)<\/updated>/i);
    const updated = updMatch ? updMatch[1].trim().slice(0, 10) : '';
    if (seen.has(url)) continue;
    if (!title || title.length < 3) continue;
    seen.add(url);
    out.push({ title: title.slice(0, 200), url, updated });
    if (out.length >= max) break;
  }
  return out;
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


/** Pull the latest blog posts from the Shopify Atom feed. */
async function gatherShopifyBlog() {
  try {
    const xml = await fetchAtomFeed(SHOPIFY_BLOG_FEED_URL);
    const blogPosts = parseAtomFeed(xml, SHOPIFY_BLOG_MAX);
    if (!blogPosts.length) return { ok: false, error: 'atom feed returned no entries' };
    return { ok: true, blogPosts };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}


/** Semantic image search via the Fig & Bloom asset library.
 *  Uses the brief itself as the query; returns the top 24 results with
 *  real R2 URLs (directly usable as block image tokens) plus rich natural
 *  language descriptions for the LLM to evaluate fit. */
async function gatherAssetLibrary(brief) {
  const query = (brief || '').trim();
  if (!query) return { ok: false, error: 'no brief provided for semantic image search' };
  try {
    const u = ASSET_LIBRARY_URL + '/api/search?q=' + encodeURIComponent(query);
    const data = await fetchJson(u, { 'Referer': ASSET_LIBRARY_REFERER });
    const images = (data.results || [])
      .filter((r) => r && r.url)            // only keep results with a usable R2 URL
      .map((r) => ({
        id: r.id,
        title: r.title || '',
        url: r.url,
        description: (r.description || '').slice(0, 600),   // cap for token budget
        mediaType: r.mediaType || 'image',
      }));
    return { ok: true, images };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
/** Gather all sources in parallel, gracefully degrading.
 *  `brief` is the campaign brief; it's used to drive the semantic image
 *  search (the asset library). The other sources are brief-agnostic and
 *  cached for 15 minutes; images are always re-fetched when a brief is
 *  supplied (since the result is brief-specific). */
async function gather({ forceFresh = false, brief = '' } = {}) {
  const wantImages = !!brief && brief.trim();
  if (!forceFresh && !wantImages) {
    const cached = getCache();
    if (cached) return { ...cached, cached: true };
  }
  if (_inflight) return _inflight;

  _inflight = (async () => {
    // Brief-agnostic sources can use the cache even if images are being re-fetched.
    const useCache = !forceFresh;
    const briefAgnostic = useCache ? getCache() : null;

    const [shopRes, klavRes, blogRes, imgRes] = await Promise.all([
      briefAgnostic ? { ok: true, products: briefAgnostic.products } : gatherShopify(),
      briefAgnostic ? { ok: true, audiences: briefAgnostic.audiences } : gatherKlaviyo(),
      briefAgnostic ? { ok: true, blogPosts: briefAgnostic.blogPosts } : gatherShopifyBlog(),
      wantImages ? gatherAssetLibrary(brief) : Promise.resolve({ ok: false, error: 'no brief provided for image search' }),
    ]);

    const products = (briefAgnostic && briefAgnostic.products) || (shopRes.ok ? shopRes.products : []);
    const audiences = (briefAgnostic && briefAgnostic.audiences) || (klavRes.ok ? klavRes.audiences : []);
    const blogPosts = (briefAgnostic && briefAgnostic.blogPosts) || (blogRes.ok ? blogRes.blogPosts : []);
    const images = imgRes.ok ? imgRes.images : [];

    const status = {
      products: products.length ? 'ok' : 'unavailable',
      audiences: audiences.length ? 'ok' : (klavRes.ok ? 'ok' : 'unavailable'),
      blogPosts: blogPosts.length ? 'ok' : 'unavailable',
      images: images.length ? 'ok' : (wantImages ? 'unavailable' : 'skipped'),
    };
    const errors = {};
    if (!shopRes.ok) errors.products = shopRes.error;
    if (!klavRes.ok) errors.audiences = klavRes.error;
    if (klavRes.warning) errors.audiences_warning = klavRes.warning;
    if (!blogRes.ok) errors.blogPosts = blogRes.error;
    if (!imgRes.ok && wantImages) errors.images = imgRes.error;

    const briefAgnosticPayload = { products, audiences, blogPosts };
    // Always cache the brief-agnostic sources, even when images were re-fetched.
    if (!forceFresh) _cache = { fetchedAt: Date.now(), payload: briefAgnosticPayload };

    const payload = {
      asOf: nowSydney(),
      ...briefAgnosticPayload,
      images,
      contextStatus: status,
      errors: Object.keys(errors).length ? errors : undefined,
    };
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
    parseAtomFeed,
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

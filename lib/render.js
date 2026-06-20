'use strict';
// render.js — assemble a campaign into shell HTML and (optionally) rasterise to PNG.
// Live preview uses the assembled HTML directly in an <iframe>; the production-accurate
// image comes from rasterising designed blocks with Puppeteer, exactly like slice.js.

const fs = require('fs');
const path = require('path');
// Puppeteer is loaded lazily (only the rasterising paths need it), so the pure
// assemble/schema paths — and the test suite — work without the heavy dependency installed.
let puppeteer = null;
function loadPuppeteer() { return puppeteer || (puppeteer = require('puppeteer')); }

const DS = path.join(__dirname, '..', 'design-system');
const TPL = path.join(DS, 'templates');

const md = require('./markdown');

// Shell-level tokens are resolved when the components are injected into the shell (see assemble),
// not per-block — so a block that references one (e.g. {{BODY_BG}}) must not be reported unfilled.
const SHELL_TOKENS = new Set(['CAMPAIGN_NAME', 'BODY_BG', 'FONT_CDN_LINK', 'COMPONENTS']);

function read(p) { return fs.readFileSync(p, 'utf8'); }

// Replace every {{TOKEN}} occurrence, rendering inline markdown in the token value. The same
// token can appear both in visible text and inside an attribute (e.g. alt="{{HEADLINE}}"), so
// each occurrence is resolved by context: markers become HTML in text, but are flattened to
// plain text inside a tag. Values without markdown take the original fast path unchanged.
function replaceContextAware(html, token, value) {
  const rendered = md.toHtml(value);
  const plain = md.toText(value);
  let result = '', i = 0;
  for (let idx = html.indexOf(token, i); idx !== -1; idx = html.indexOf(token, i)) {
    result += html.slice(i, idx);
    // `result` is the verbatim prefix; we're inside a tag if the last '<' is unclosed.
    const inTag = result.lastIndexOf('<') > result.lastIndexOf('>');
    result += inTag ? plain : rendered;
    i = idx + token.length;
  }
  return result + html.slice(i);
}

// Resolve {{#TOKEN}}…{{/TOKEN}} conditional sections before the plain {{TOKEN}} replace.
// When TOKEN's value is empty/whitespace the whole region is dropped; otherwise the markers are
// unwrapped and the inner content kept. Generic and safe for all templates (a template with no
// such markers is returned unchanged) — used to drop the optional 3rd journal tile for a 2-up row.
function applyConditionals(html, tokens) {
  return html.replace(/\{\{#([A-Z0-9_]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, name, inner) => {
    const v = tokens[name];
    const empty = v == null || String(v).trim() === '';
    return empty ? '' : inner;
  });
}

// Fill a template's tokens (+ {{ASSETS_BASE}}). Shared by assemble() and assembleBlocks() so
// the live preview and the production/Klaviyo slices format identically.
function applyTokens(html, tokens, assetsBase) {
  html = applyConditionals(html, tokens);
  for (const [k, v] of Object.entries(tokens)) {
    const token = '{{' + k + '}}';
    const value = v == null ? '' : String(v);
    html = md.hasMarkdown(value) ? replaceContextAware(html, token, value) : html.split(token).join(value);
  }
  return html.split('{{ASSETS_BASE}}').join(assetsBase);
}

// Replace footer Klaviyo merge tags with readable text (preview only).
function previewFooter(html) {
  return html
    .replace(/\{%\s*unsubscribe\s*%\}/g, 'unsubscribe here')
    .replace(/\{\{\s*organization\.name\s*\}\}/g, 'Fig &amp; Bloom')
    .replace(/\{\{\s*organization\.full_address\s*\}\}/g, 'Australia-wide flower delivery');
}

function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

// campaign = { campaignName, bodyBg, blocks:[{component, tokens:{}}] }
// opts.assetsBase = string to substitute for {{ASSETS_BASE}} (served URL or file:// path)
// opts.production = keep real Klaviyo merge tags in the footer (skip preview substitution)
// opts.markBlocks = wrap each block in a <div data-eb-block> so it can be sliced individually
function assemble(campaign, opts = {}) {
  const assetsBase = opts.assetsBase || '/design-system/assets';
  const shell = read(path.join(DS, 'shell', 'shell-preview.html'));
  const parts = [];
  const unfilled = [];

  (campaign.blocks || []).forEach((block, i) => {
    const file = path.join(TPL, block.component + '.html');
    if (!fs.existsSync(file)) { unfilled.push({ component: block.component, token: '(missing template)' }); return; }
    let html = read(file);
    html = applyTokens(html, block.tokens || {}, assetsBase);
    if (/footer/.test(block.component) && !opts.production) html = previewFooter(html);
    // record any leftover tokens for this block (excluding ASSETS_BASE and shell-level tokens,
    // which are filled when the block is injected into the shell below)
    for (const m of html.matchAll(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g)) {
      if (SHELL_TOKENS.has(m[1])) continue;
      unfilled.push({ component: block.component, token: m[1] });
    }
    // Each block template is a run of <tr> rows that live *directly* inside the shell's
    // <table>. Mark a block by wrapping its rows in a <tbody> (a valid table child that
    // reports a real bounding box) — NOT a <div>, which the HTML parser foster-parents
    // out of the table, leaving a zero-size element and breaking slicing.
    if (opts.markBlocks) parts.push(`<tbody data-eb-block="${i}" data-eb-component="${escAttr(block.component)}">\n${html}\n</tbody>`);
    else parts.push('<!-- ' + block.component + ' -->\n' + html);
  });

  const components = parts.join('\n');
  // The shell wraps the token in an HTML comment (<!-- {{COMPONENTS}} -->). The plain path
  // relies on each block opening with its own comment to break out; the marked path can't,
  // so replace the whole commented token in that case.
  let full = opts.markBlocks
    ? shell.split('<!-- {{COMPONENTS}} -->').join(components).split('{{COMPONENTS}}').join(components)
    : shell.split('{{COMPONENTS}}').join(components);
  full = full
    .split('{{CAMPAIGN_NAME}}').join(campaign.campaignName || 'Untitled campaign')
    .split('{{BODY_BG}}').join(campaign.bodyBg || '#2c2825');

  return { html: full, unfilled };
}

// Assemble each block to its own HTML segment (production mode: real merge tags).
// Returns { blocks:[{index, component, tokens, html}], campaignName, bodyBg }.
// Used by the Klaviyo "sliced" push, where image blocks become uploaded PNGs but the
// footer (with its {% unsubscribe %} tag) must stay live HTML.
function assembleBlocks(campaign, opts = {}) {
  const assetsBase = opts.assetsBase || '/design-system/assets';
  const out = [];
  (campaign.blocks || []).forEach((block, index) => {
    const file = path.join(TPL, block.component + '.html');
    if (!fs.existsSync(file)) return;
    const tokens = block.tokens || {};
    const html = applyTokens(read(file), tokens, assetsBase);
    out.push({ index, component: block.component, tokens, html });
  });
  return { blocks: out, campaignName: campaign.campaignName || 'Untitled campaign', bodyBg: campaign.bodyBg || '#2c2825' };
}

// Wrap already-built component rows in the *production* shell (web-font links, the 600px
// .ew table, body bg). `inner` must be a sequence of <tr>…</tr> rows.
function wrapProductionShell(inner, opts = {}) {
  const shell = read(path.join(DS, 'shell', 'shell-production.html'));
  return shell
    .split('{{COMPONENTS}}').join(inner)
    .split('{{CAMPAIGN_NAME}}').join(opts.campaignName || 'Untitled campaign')
    .split('{{BODY_BG}}').join(opts.bodyBg || '#2c2825')
    .split('{{ASSETS_BASE}}').join(opts.assetsBase || '');
}

// A block whose HTML carries the Klaviyo unsubscribe tag (the footer) must NOT be
// rasterised — it has to stay live HTML so the unsubscribe link works.
function isUnsubscribeBlock(component, html) {
  return /footer/.test(component) || /\{%\s*unsubscribe\s*%\}|\{\{\s*unsubscribe_url\s*\}\}/.test(html || '');
}

// Best-guess click-through URL for a block, from its tokens (overridable in the UI).
function deriveLink(tokens = {}) {
  return tokens.HERO_LINK_URL || tokens.CTA_URL || tokens.PRODUCT_URL || tokens.HERO_IMAGE_LINK || '';
}

// True for a hosted animated-image URL (a GIF). Email clients only animate a GIF while it
// stays a live <img> — rasterising it to a screenshot freezes it to one frame — so on publish
// these are passed through as live images instead of being sliced to PNG. Detection is by
// extension: .gif is the only animatable format we host, and passing a static .gif through
// live is harmless, so matching the extension is enough (no need to fetch bytes and count
// frames). Must be an http(s)/protocol-relative URL Klaviyo can reference — a file:// asset
// could never be emailed, so it's still rasterised.
function isGifUrl(url) {
  if (!url) return false;
  const u = String(url);
  if (!/^(https?:)?\/\//i.test(u)) return false;
  return /\.gif$/i.test(u.split('#')[0].split('?')[0]);
}

let _browser = null;
async function getBrowser() {
  if (_browser && _browser.connected) return _browser;
  _browser = await loadPuppeteer().launch({
    headless: 'new',
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-gpu', '--font-render-hinting=none', '--allow-file-access-from-files'],
  });
  return _browser;
}

// Open assembled HTML in a Puppeteer page with fonts + images settled.
// Returns { page, broken, cleanup }; callers must await cleanup() when done.
async function openPage(html, opts = {}) {
  // For Puppeteer, {{ASSETS_BASE}} must resolve on the file:// origin.
  const assetsAbs = 'file://' + path.join(DS, 'assets');
  html = html.split('{{ASSETS_BASE}}').join(assetsAbs);

  const tmp = path.join(require('os').tmpdir(), `mb-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(tmp, html);
  const browser = await getBrowser();
  const page = await browser.newPage();
  const RENDER_WIDTH = (opts.width || 600) + 40, SCALE = opts.scale || 2;
  await page.setViewport({ width: RENDER_WIDTH, height: 10, deviceScaleFactor: SCALE });
  await page.goto('file://' + tmp, { waitUntil: 'domcontentloaded', timeout: opts.timeout || 60000 });
  await page.evaluate(() => document.fonts.ready);
  const broken = await page.evaluate(async () => {
    const imgs = Array.from(document.images);
    await Promise.all(imgs.map(i => i.complete ? null : new Promise(r => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); })));
    return imgs.filter(i => !i.complete || i.naturalWidth === 0).map(i => i.src);
  });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
  // Grow the viewport to the full document height so off-screen content rasterises.
  const docH = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewport({ width: RENDER_WIDTH, height: Math.max(10, docH), deviceScaleFactor: SCALE });
  const cleanup = async () => { await page.close(); try { fs.unlinkSync(tmp); } catch (_) {} };
  return { page, broken, cleanup, RENDER_WIDTH, SCALE };
}

// Rasterise assembled HTML to a PNG buffer (full 600px-wide email canvas).
async function renderToPng(html, opts = {}) {
  const { page, broken, cleanup } = await openPage(html, opts);
  try {
    const clip = await page.evaluate(() => {
      const t = document.querySelector('table.ew') || document.querySelector('table[width="600"]');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return { x: Math.max(0, Math.floor(r.left)), y: Math.max(0, Math.floor(r.top)), width: Math.ceil(r.width), height: Math.ceil(r.height) };
    });
    const buf = await page.screenshot(clip ? { type: 'png', clip } : { type: 'png', fullPage: true });
    return { buffer: buf, brokenImages: broken, height: clip ? clip.height : null };
  } finally {
    await cleanup();
  }
}

// Rasterise the blocks of the assembled email into "slices" for Klaviyo, each becoming its
// own image block (with its own link/alt). Requires HTML assembled with { markBlocks: true }
// so blocks carry data-eb-block.
//
// A block with no animated GIF is one PNG slice (its whole bounding box — unchanged). A block
// that contains a GIF is split into vertical bands: each GIF becomes a *live-image* slice
// (kind:'gif', carrying the hosted src — never rasterised, so it keeps animating) and the runs
// above/below/between the GIFs are rasterised to their own PNG slices. Before measuring, any
// negative top margins inside such a block are zeroed so an overlapping plate (e.g.
// editorial-hero's −88px layering) drops cleanly below the GIF instead of straddling the split.
//
// Slices keep block order; a block can yield several (seg/segCount give its position within
// the block). NOTE: the split is purely vertical, so it assumes the GIF spans the block width
// (true for hero/full-bleed image blocks); side-by-side content beside a GIF isn't separated.
async function renderSlices(html, opts = {}) {
  const { page, broken, cleanup } = await openPage(html, opts);
  try {
    // 1. Drop overlaps in any GIF-bearing block so vertical bands tile without straddling.
    await page.evaluate(() => {
      const isGif = (url) => !!url && /^(https?:)?\/\//i.test(url) && /\.gif$/i.test(url.split('#')[0].split('?')[0]);
      for (const el of document.querySelectorAll('[data-eb-block]')) {
        if (!Array.from(el.querySelectorAll('img')).some((img) => isGif(img.src))) continue;
        for (const d of el.querySelectorAll('*')) {
          if (parseFloat(getComputedStyle(d).marginTop) < 0) d.style.marginTop = '0px';
        }
      }
    });
    // Re-grow the viewport: zeroing overlaps can make the document taller, and a screenshot
    // clip must stay within the viewport.
    const docH = await page.evaluate(() => document.documentElement.scrollHeight);
    const vp = page.viewport();
    await page.setViewport({ width: vp.width, height: Math.max(10, docH), deviceScaleFactor: vp.deviceScaleFactor });

    // 2. Measure each block into ordered segments (gif = live passthrough, png = rasterise).
    const blocks = await page.evaluate(() => {
      const isGif = (url) => !!url && /^(https?:)?\/\//i.test(url) && /\.gif$/i.test(url.split('#')[0].split('?')[0]);
      const out = [];
      for (const el of document.querySelectorAll('[data-eb-block]')) {
        const r = el.getBoundingClientRect();
        const left = Math.max(0, Math.floor(r.left)), width = Math.ceil(r.width);
        const top = Math.max(0, Math.floor(r.top)), bottom = Math.ceil(r.bottom);
        if (width <= 0 || bottom - top <= 0) continue;
        const gifs = Array.from(el.querySelectorAll('img'))
          .filter((img) => isGif(img.src))
          .map((img) => { const b = img.getBoundingClientRect(); return { src: img.src, top: Math.max(top, Math.floor(b.top)), bottom: Math.min(bottom, Math.ceil(b.bottom)) }; })
          .filter((g) => g.bottom - g.top > 2)
          .sort((a, b) => a.top - b.top);
        const segments = [];
        if (!gifs.length) {
          segments.push({ kind: 'png', x: left, y: top, width, height: bottom - top });
        } else {
          let cursor = top;
          for (const g of gifs) {
            if (g.top - cursor > 2) segments.push({ kind: 'png', x: left, y: cursor, width, height: g.top - cursor });
            segments.push({ kind: 'gif', src: g.src, x: left, y: g.top, width, height: g.bottom - g.top });
            cursor = g.bottom;
          }
          if (bottom - cursor > 2) segments.push({ kind: 'png', x: left, y: cursor, width, height: bottom - cursor });
        }
        out.push({ index: Number(el.getAttribute('data-eb-block')), component: el.getAttribute('data-eb-component') || '', segments });
      }
      return out;
    });

    // 3. Rasterise the PNG segments; carry the GIF segments through by reference.
    const slices = [];
    for (const b of blocks) {
      const segCount = b.segments.length;
      let seg = 0;
      for (const s of b.segments) {
        const base = { index: b.index, component: b.component, seg, segCount, kind: s.kind, width: s.width, height: s.height };
        if (s.kind === 'gif') {
          slices.push({ ...base, src: s.src });
        } else {
          const buffer = await page.screenshot({ type: 'png', clip: { x: s.x, y: s.y, width: s.width, height: s.height } });
          slices.push({ ...base, buffer });
        }
        seg++;
      }
    }
    return { slices, brokenImages: broken };
  } finally {
    await cleanup();
  }
}

async function closeBrowser() { if (_browser) { try { await _browser.close(); } catch (_) {} _browser = null; } }

module.exports = { assemble, assembleBlocks, wrapProductionShell, isUnsubscribeBlock, deriveLink, isGifUrl, renderToPng, renderSlices, closeBrowser, DS };

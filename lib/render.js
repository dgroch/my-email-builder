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

// Fill a template's tokens (+ {{ASSETS_BASE}}). Shared by assemble() and assembleBlocks() so
// the live preview and the production/Klaviyo slices format identically.
function applyTokens(html, tokens, assetsBase) {
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
    // record any leftover tokens for this block (excluding ASSETS_BASE, already handled)
    for (const m of html.matchAll(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g)) unfilled.push({ component: block.component, token: m[1] });
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

// Rasterise each block of the assembled email to its own PNG ("slices"), so they can
// be uploaded into Klaviyo as individual image blocks (each with its own link/alt).
// Requires HTML assembled with { markBlocks: true } so blocks carry data-eb-block.
async function renderSlices(html, opts = {}) {
  const { page, broken, cleanup } = await openPage(html, opts);
  try {
    const boxes = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[data-eb-block]')).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          index: Number(el.getAttribute('data-eb-block')),
          component: el.getAttribute('data-eb-component') || '',
          x: Math.max(0, Math.floor(r.left)), y: Math.max(0, Math.floor(r.top)),
          width: Math.ceil(r.width), height: Math.ceil(r.height),
        };
      }).filter((b) => b.width > 0 && b.height > 0);
    });
    const slices = [];
    for (const b of boxes) {
      const buffer = await page.screenshot({ type: 'png', clip: { x: b.x, y: b.y, width: b.width, height: b.height } });
      slices.push({ index: b.index, component: b.component, width: b.width, height: b.height, buffer });
    }
    return { slices, brokenImages: broken };
  } finally {
    await cleanup();
  }
}

async function closeBrowser() { if (_browser) { try { await _browser.close(); } catch (_) {} _browser = null; } }

module.exports = { assemble, assembleBlocks, wrapProductionShell, isUnsubscribeBlock, deriveLink, renderToPng, renderSlices, closeBrowser, DS };

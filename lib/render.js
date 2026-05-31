'use strict';
// render.js — assemble a campaign into shell HTML and (optionally) rasterise to PNG.
// Live preview uses the assembled HTML directly in an <iframe>; the production-accurate
// image comes from rasterising designed blocks with Puppeteer, exactly like slice.js.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const DS = path.join(__dirname, '..', 'design-system');
const TPL = path.join(DS, 'templates');

function read(p) { return fs.readFileSync(p, 'utf8'); }

// Replace footer Klaviyo merge tags with readable text (preview only).
function previewFooter(html) {
  return html
    .replace(/\{%\s*unsubscribe\s*%\}/g, 'unsubscribe here')
    .replace(/\{\{\s*organization\.name\s*\}\}/g, 'Fig &amp; Bloom')
    .replace(/\{\{\s*organization\.full_address\s*\}\}/g, 'Australia-wide flower delivery');
}

// campaign = { campaignName, bodyBg, blocks:[{component, tokens:{}}] }
// opts.assetsBase = string to substitute for {{ASSETS_BASE}} (served URL or file:// path)
function assemble(campaign, opts = {}) {
  const assetsBase = opts.assetsBase || '/design-system/assets';
  const shell = read(path.join(DS, 'shell', 'shell-preview.html'));
  const parts = [];
  const unfilled = [];

  for (const block of campaign.blocks || []) {
    const file = path.join(TPL, block.component + '.html');
    if (!fs.existsSync(file)) { unfilled.push({ component: block.component, token: '(missing template)' }); continue; }
    let html = read(file);
    const tokens = block.tokens || {};
    for (const [k, v] of Object.entries(tokens)) html = html.split('{{' + k + '}}').join(v == null ? '' : String(v));
    html = html.split('{{ASSETS_BASE}}').join(assetsBase);
    if (/footer/.test(block.component)) html = previewFooter(html);
    // record any leftover tokens for this block (excluding ASSETS_BASE, already handled)
    for (const m of html.matchAll(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g)) unfilled.push({ component: block.component, token: m[1] });
    parts.push('<!-- ' + block.component + ' -->\n' + html);
  }

  const full = shell
    .split('{{CAMPAIGN_NAME}}').join(campaign.campaignName || 'Untitled campaign')
    .split('{{BODY_BG}}').join(campaign.bodyBg || '#2c2825')
    .split('{{COMPONENTS}}').join(parts.join('\n'));

  return { html: full, unfilled };
}

let _browser = null;
async function getBrowser() {
  if (_browser && _browser.connected) return _browser;
  _browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-gpu', '--font-render-hinting=none', '--allow-file-access-from-files'],
  });
  return _browser;
}

// Rasterise assembled HTML to a PNG buffer (full 600px-wide email canvas).
async function renderToPng(html, opts = {}) {
  // For Puppeteer, {{ASSETS_BASE}} must resolve on the file:// origin.
  const assetsAbs = 'file://' + path.join(DS, 'assets');
  html = html.split('{{ASSETS_BASE}}').join(assetsAbs);

  const tmp = path.join(require('os').tmpdir(), `mb-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(tmp, html);
  const browser = await getBrowser();
  const page = await browser.newPage();
  const RENDER_WIDTH = (opts.width || 600) + 40, SCALE = opts.scale || 2;
  try {
    await page.setViewport({ width: RENDER_WIDTH, height: 10, deviceScaleFactor: SCALE });
    await page.goto('file://' + tmp, { waitUntil: 'domcontentloaded', timeout: opts.timeout || 60000 });
    await page.evaluate(() => document.fonts.ready);
    const broken = await page.evaluate(async () => {
      const imgs = Array.from(document.images);
      await Promise.all(imgs.map(i => i.complete ? null : new Promise(r => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); })));
      return imgs.filter(i => !i.complete || i.naturalWidth === 0).map(i => i.src);
    });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
    const clip = await page.evaluate(() => {
      const t = document.querySelector('table.ew') || document.querySelector('table[width="600"]');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return { x: Math.max(0, Math.floor(r.left)), y: Math.max(0, Math.floor(r.top)), width: Math.ceil(r.width), height: Math.ceil(r.height) };
    });
    await page.setViewport({ width: RENDER_WIDTH, height: clip ? clip.y + clip.height : 2000, deviceScaleFactor: SCALE });
    const buf = await page.screenshot(clip ? { type: 'png', clip } : { type: 'png', fullPage: true });
    return { buffer: buf, brokenImages: broken, height: clip ? clip.height : null };
  } finally {
    await page.close();
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

async function closeBrowser() { if (_browser) { try { await _browser.close(); } catch (_) {} _browser = null; } }

module.exports = { assemble, renderToPng, closeBrowser, DS };

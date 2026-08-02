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

// Per-component token defaults, declared in manifest.json as `token_defaults` (see
// sections/three-column-steps-* and blocks/polaroid-collage). A token with a default is
// optional: omitted or blank, it resolves to the default rather than emitting a literal
// {{TOKEN}} — which would otherwise land inside a CSS declaration and break the rule.
let _tokenDefaults = null;
function tokenDefaults() {
  if (_tokenDefaults) return _tokenDefaults;
  const manifest = JSON.parse(read(path.join(DS, 'manifest.json')));
  _tokenDefaults = {};
  (function walk(node, prefix) {
    for (const [key, value] of Object.entries(node || {})) {
      if (!value || typeof value !== 'object') continue;
      const name = prefix ? prefix + '/' + key : key;
      if (value.token_defaults) _tokenDefaults[name] = value.token_defaults;
      else if (!value.file) walk(value, name);
    }
  })(manifest.components, '');
  return _tokenDefaults;
}

// Merge a block's supplied tokens over its component defaults. A supplied value wins unless it
// is null/undefined/blank — blank means "unset" for a defaulted token (an empty padding would
// otherwise silently drop the whole CSS declaration).
function withDefaults(component, tokens) {
  const defaults = tokenDefaults()[component];
  if (!defaults) return tokens || {};
  const out = { ...defaults };
  for (const [k, v] of Object.entries(tokens || {})) {
    if (Object.prototype.hasOwnProperty.call(defaults, k) && (v == null || String(v).trim() === '')) continue;
    out[k] = v;
  }
  return out;
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
    html = applyTokens(html, withDefaults(block.component, block.tokens), assetsBase);
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
    const tokens = withDefaults(block.component, block.tokens);
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

// A block listed in manifest assembly.html_only_components must be pushed to Klaviyo as LIVE
// HTML, not rasterised to a PNG. Slicing a block flattens it to one image with a single
// click-through (deriveLink), which would collapse a multi-link block (e.g. blocks/journal-tile,
// whose 2–3 tiles each link to a different post) to one URL — and would also break the live
// links inside sections/opt-out. The list carries bare basenames ("journal-tile", "body-copy-plain",
// "section-headline", …); component names are group-prefixed, so match on the basename.
function isHtmlOnlyComponent(component, htmlOnlyComponents) {
  if (!component || !Array.isArray(htmlOnlyComponents)) return false;
  const base = String(component).split('/').pop();
  return htmlOnlyComponents.includes(base);
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

// ── Outlook (Word renderer) degradation ───────────────────────────────────────────────
//
// Outlook 2007+ on Windows lays out mail with Microsoft Word, not a browser engine. Word
// silently ignores a specific set of CSS: the declaration is dropped, nothing errors, and the
// block reflows. Every property below is one this design system actually relies on somewhere,
// so a preview that neutralises them shows the real degraded layout rather than a guess.
//
// Deliberately NOT simulated: Word's own quirks that add rather than remove (its 1.15 default
// line-height, its table-cell rounding). This models "the CSS is gone", which is what breaks
// layouts here — not Word's typography, which shifts things by a pixel or two.
const OUTLOOK_UNSUPPORTED = [
  { prop: 'position:absolute',  why: 'Word has no positioning context — absolutely positioned elements fall back into normal flow, stacking vertically.' },
  { prop: 'position:relative',  why: 'Ignored, so it cannot anchor a positioned child.' },
  { prop: 'transform',          why: 'No transform support — rotated/scaled elements render straight and unscaled.' },
  { prop: 'opacity',            why: 'No opacity — a faint watermark renders at full strength.' },
  { prop: 'filter',             why: 'No filters — grayscale/blur render as the original image.' },
  { prop: 'box-shadow',         why: 'No shadows — edges render flat.' },
  { prop: 'border-radius',      why: 'No radii — rounded corners render square.' },
  { prop: 'max-width',          why: 'Ignored on block elements, so width-capped text runs full width.' },
  { prop: 'background-image',   why: 'Only supported via VML — a CSS background image simply does not paint.' },
  { prop: 'object-fit',         why: 'No object-fit — images stretch to the width/height attributes instead of cropping.' },
];

// CSS that strips the unsupported properties back to their initial values. Applied as the last
// stylesheet with !important so it beats the inline styles the templates use throughout.
const OUTLOOK_RESET = `
  *, *::before, *::after {
    position: static !important;
    transform: none !important;
    opacity: 1 !important;
    filter: none !important;
    box-shadow: none !important;
    border-radius: 0 !important;
    max-width: none !important;
    background-image: none !important;
    object-fit: fill !important;
  }
`;

// Reveal the Outlook branch of the conditional comments and drop the everyone-else branch, so
// an Outlook preview shows the fallback markup Outlook would actually receive.
//
// Caveat, stated plainly: the VML that fallback is built from (v:roundrect, v:rect) is a
// Microsoft vector language no browser implements, so Chromium cannot paint it. Revealing it
// would render an unstyled label, which reads as "the button is broken" when in Outlook it is
// fine. So the mso branch is left hidden and the preview shows the non-VML rendering — the
// worst case for a block that has a VML fallback. renderOutlookRisks() reports which blocks
// those are, so the two are read together.
function applyOutlookDegradation(html) {
  return html.replace('</head>', `<style>${OUTLOOK_RESET}</style></head>`);
}

// Static scan: which blocks lean on CSS Word drops, and which are insured by a VML fallback.
// This is the part that stays true regardless of what the rasteriser can paint.
// A property is "used" if the template declares it: `transform` matches `transform:`, while an
// entry that already names a value (`position:absolute`) matches that pairing only — otherwise
// every `position:relative` would be reported as an absolute-positioning risk.
// The leading boundary matters: without it `transform` matches inside `text-transform`, which
// Word supports perfectly well, and every component using uppercase micro-labels is reported
// as broken. A hyphen counts as part of the preceding name, not a boundary.
function declaresProperty(raw, prop) {
  const body = prop.includes(':') ? prop.replace(':', '\\s*:\\s*') : prop + '\\s*:';
  return new RegExp('(?<![\\w-])' + body, 'i').test(raw);
}

let _htmlOnly = null;
function htmlOnlyComponents() {
  if (_htmlOnly) return _htmlOnly;
  const manifest = JSON.parse(read(path.join(DS, 'manifest.json')));
  _htmlOnly = (manifest.assembly && manifest.assembly.html_only_components) || [];
  return _htmlOnly;
}

// The report that matters, because the degraded PNG on its own cries wolf.
//
// Most blocks that lean hardest on unsupported CSS are DESIGNED blocks, and those are flattened
// to a PNG on publish — Outlook receives an image and none of the CSS is in play. The genuine
// exposure is the intersection: a block that stays live HTML *and* declares CSS Word drops.
// `atRisk` is that intersection; everything else is reported as context, not as a problem.
// The most common Outlook failure in this system, and the one a property scan misses: a CTA
// built as an <a> with padding + display:inline-block. Word ignores both on an inline element,
// so the button collapses to bare underlined text — no box, no colour, no shape. Every component
// with a CTA is built this way, which is why the VML fallback (or being rasterised) matters.
const PADDED_ANCHOR = /<a\b[^>]*style="[^"]*(?:display\s*:\s*inline-block[^"]*padding\s*:|padding\s*:[^"]*display\s*:\s*inline-block)/i;
const PADDED_ANCHOR_EFFECT = 'Word ignores padding and display:inline-block on an inline element, so a CSS button collapses to bare underlined text. Needs a VML roundrect fallback, or the block must be rasterised.';

function outlookRisks(campaign) {
  const blocks = (campaign && campaign.blocks) || [];
  const htmlOnly = htmlOnlyComponents();
  return blocks.map((block, index) => {
    let raw = '';
    try { raw = read(path.join(TPL, block.component + '.html')); } catch (_) { return null; }
    const found = OUTLOOK_UNSUPPORTED
      .filter(({ prop }) => declaresProperty(raw, prop))
      .map(({ prop, why }) => ({ property: prop, effect: why }));
    if (PADDED_ANCHOR.test(raw)) found.push({ property: 'padding on <a>', effect: PADDED_ANCHOR_EFFECT });
    if (!found.length) return null;
    // Mirrors the push path in server.js: unsubscribe blocks and html_only_components are sent
    // as live HTML; everything else is rasterised to a PNG slice.
    const staysHtml = isUnsubscribeBlock(block.component, raw) || isHtmlOnlyComponent(block.component, htmlOnly);
    const hasVmlFallback = /\[if gte mso 9\]/.test(raw);
    return {
      index, component: block.component,
      rasterisedOnPublish: !staysHtml,
      // A VML fallback means Outlook is served purpose-built markup, so the degraded preview
      // understates this block. Without one, and staying HTML, the preview is the truth.
      hasVmlFallback,
      atRisk: staysHtml && !hasVmlFallback,
      unsupported: found,
    };
  }).filter(Boolean);
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
  // opts.client === 'outlook' rasterises the Word-renderer degradation instead of the true
  // design — the same HTML with the CSS Outlook drops stripped back to its initial values.
  if (opts.client === 'outlook') html = applyOutlookDegradation(html);
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
// the block). When a single GIF sits BESIDE other content instead (a partial-width image
// column spanning the block's height — e.g. blocks/image-text with an animated image), the
// split is horizontal: the non-GIF column(s) rasterise to PNG (brand fonts intact) and the
// GIF column stays live, each segment tagged layout:'cols' (+ the block's background colour)
// so the push recomposes them side by side in one row instead of stacking them. Blocks with
// several GIFs, or a partial-width GIF that doesn't span the height, still fall back to the
// vertical banding, which can't separate content sitting beside a GIF.
//
// A block may instead declare explicit sub-slice regions: any descendant carrying
// data-eb-slice="<name>" (optionally data-eb-href="<url>" and data-eb-alt="<text>") makes the
// block emit one PNG slice per region, in DOM order, each carrying { name, href, alt } so it can
// be wrapped in its own link on push. The regions tile the block's full height with no gaps, so
// they stack back into the original block seamlessly. This is how blocks/journal-tile preserves
// its 2–3 distinct per-tile links while rasterising to brand-font images. Blocks with neither a
// GIF nor a data-eb-slice region are one whole-block PNG, exactly as before.
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

        // Multi-region slicing: when a block declares [data-eb-slice] descendants, emit one PNG
        // slice per region (in DOM order) instead of the whole-block slice. Each region carries
        // its own { name, href, alt } (from data-eb-slice / data-eb-href / data-eb-alt) so the
        // push can wrap each slice in its own link — this is how blocks/journal-tile keeps its
        // 2–3 distinct per-tile links while still rasterising to brand-font images. The bands are
        // made contiguous (each region's bottom == the next region's top) so no gap or double-row
        // of pixels appears at a seam; the block's top padding falls to the first region and its
        // bottom padding to the last. Mutually exclusive with the GIF-band path below — a
        // region-sliced block is assumed to carry no animated GIF.
        const regionEls = Array.from(el.querySelectorAll('[data-eb-slice]'));
        if (regionEls.length) {
          const regions = regionEls.map((rel) => {
            const b = rel.getBoundingClientRect();
            return {
              name: rel.getAttribute('data-eb-slice') || '',
              href: rel.getAttribute('data-eb-href') || '',
              alt: rel.getAttribute('data-eb-alt') || '',
              top: b.top, bottom: b.bottom,
            };
          }).filter((g) => g.bottom - g.top > 2).sort((a, b) => a.top - b.top);
          if (regions.length) {
            // Shared band boundaries: block top, midpoint of each inter-region gap, block bottom.
            const bounds = new Array(regions.length + 1);
            bounds[0] = top;
            bounds[regions.length] = bottom;
            for (let k = 1; k < regions.length; k++) {
              bounds[k] = Math.round((regions[k - 1].bottom + regions[k].top) / 2);
            }
            for (let k = 1; k <= regions.length; k++) {
              bounds[k] = Math.min(bottom, Math.max(bounds[k - 1], bounds[k]));
            }
            const segments = [];
            for (let k = 0; k < regions.length; k++) {
              const h = bounds[k + 1] - bounds[k];
              if (h <= 0) continue;
              segments.push({ kind: 'png', name: regions[k].name, href: regions[k].href, alt: regions[k].alt,
                              x: left, y: bounds[k], width, height: h });
            }
            out.push({ index: Number(el.getAttribute('data-eb-block')), component: el.getAttribute('data-eb-component') || '', segments });
            continue;
          }
        }

        const gifs = Array.from(el.querySelectorAll('img'))
          .filter((img) => isGif(img.src))
          .map((img) => { const b = img.getBoundingClientRect(); return {
            src: img.src,
            top: Math.max(top, Math.floor(b.top)), bottom: Math.min(bottom, Math.ceil(b.bottom)),
            left: Math.max(left, Math.floor(b.left)), right: Math.min(left + width, Math.ceil(b.right)),
          }; })
          .filter((g) => g.bottom - g.top > 2)
          .sort((a, b) => a.top - b.top);
        const segments = [];
        if (!gifs.length) {
          segments.push({ kind: 'png', x: left, y: top, width, height: bottom - top });
        } else if (gifs.length === 1
                   && gifs[0].right - gifs[0].left < width * 0.9
                   && gifs[0].bottom - gifs[0].top >= (bottom - top) * 0.7) {
          // Column split: one partial-width GIF spanning (most of) the block's height — an
          // animated image COLUMN with content beside it (blocks/image-text). A vertical band
          // here would swallow the side content into the GIF band, so split horizontally
          // instead: PNG column(s) for the non-GIF side(s), the GIF column live. The block's
          // effective background colour rides along so the recomposed row can paint any
          // height difference between the natural-ratio GIF and the fixed-height PNG column.
          const g = gifs[0];
          let bg = '';
          for (let n = el.querySelector('td'); n && n !== document.body; n = n.parentElement) {
            const c = getComputedStyle(n).backgroundColor;
            if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') {
              const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
              if (m) bg = '#' + [m[1], m[2], m[3]].map((v) => (+v).toString(16).padStart(2, '0')).join('');
              break;
            }
          }
          const cols = [];
          if (g.left - left > 2) cols.push({ kind: 'png', x: left, width: g.left - left });
          cols.push({ kind: 'gif', src: g.src, x: g.left, width: g.right - g.left });
          if (left + width - g.right > 2) cols.push({ kind: 'png', x: g.right, width: left + width - g.right });
          for (const c of cols) segments.push({ ...c, layout: 'cols', bg, y: top, height: bottom - top });
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
        // Column segments (side-by-side split) carry their layout + block background so the
        // push can recompose them into one row instead of stacking.
        if (s.layout) { base.layout = s.layout; base.bg = s.bg || ''; }
        // Region slices carry their own name/link/alt (from data-eb-slice/href/alt).
        if (s.name != null) base.name = s.name;
        if (s.href != null) base.href = s.href;
        if (s.alt != null) base.alt = s.alt;
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

module.exports = { assemble, assembleBlocks, wrapProductionShell, isUnsubscribeBlock, isHtmlOnlyComponent, deriveLink, isGifUrl, withDefaults, renderToPng, renderSlices, closeBrowser, applyOutlookDegradation, outlookRisks, OUTLOOK_UNSUPPORTED, DS };

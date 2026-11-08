'use strict';
// emailImages.js — make email-bound images fill their designed slot without relying on
// CSS object-fit, which Gmail (most visibly Gmail iOS) strips from <img> style attributes.
//
// Why this exists
// ---------------
// A fixed-height image with `object-fit:cover` is a *client-side* crop. Gmail removes the
// object-fit declaration, so the image keeps its intrinsic aspect ratio inside a box declared
// 100% wide and 440px tall: a 4:5 portrait renders ~352px wide beside a white strip. The only
// reliable fix is to crop the pixels before send, at the CDN, and then let the image size
// itself with `width:100%;height:auto` plus a max-width that matches how the image actually
// fills its column: `100%` for fluid images, `600px` for a full-bleed hero/dividers, and the
// fixed slot width only for genuinely fixed images. A fluid image must not be capped at its
// desktop slot: the shell deliberately makes it width:100% on a phone.
//
// This helper is deliberately central. Components keep their `object-fit`/`object-position`
// declarations as the *authoring intent* (the slot ratio, the focal point), and every assembled
// block passes through `rewriteHtml()` before it reaches a preview or an export. Saved design
// JSON is never rewritten.
//
// Shopify's CDN supports the crop in the query string:
//   ?width=600&height=440&crop=center
// We replace any existing width/height/crop params rather than duplicating them, and we preserve
// every other param (notably the cache-busting `v=`). A fluid image can be displayed at the
// email column width on a phone, so we request up to 600px even when its desktop slot is
// 200–340px; the requested width is always capped at the source image's width because the CDN
// will not upscale. Source dimensions are fetched by `primeHtml()`, which the export path awaits
// before its final assembly; synchronous callers (preview, validation, unit tests) can pass a
// `sourceSizes` map or rely on the shared cache.
//
// Non-Shopify URLs are a validation error: there is no crop-and-upload pipeline in this repo, so
// there is nothing that can deliver a pre-cropped image. We never silently leave object-fit in
// the exported HTML.

const CROP_POSITIONS = new Set(['center', 'top', 'bottom', 'left', 'right']);
const CROP_PARAMS = ['width', 'height', 'crop'];
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const EMAIL_COLUMN_CEILING = 600;

// Images the shells deliberately make fluid on a phone (`.st-img`, `.fl-img`, `.ap-img`, …).
// These keep max-width:100% and may render wider than their desktop slot.
const FLUID_IMAGE_CLASSES = new Set(['st-img', 'fl-img', 'ap-img', 'cvs-img', 'jt-imgel', 'iti']);
// The two horizontal cards have no class on the <img>; their fluidisation comes from `.hi img`.
// Keep the component rule explicit rather than guessing from the tag alone.
const FLUID_COMPONENTS = new Set([
  'blocks/story', 'blocks/journal-tile', 'blocks/annotated-product', 'blocks/comparison-vs',
  'blocks/feature-list', 'blocks/image-text',
  'products/card-horizontal', 'products/card-horizontal-reversed',
]);

// stripped source URL → { width, height } | null. `null` means "we tried and could not read it".
const sourceSizes = new Map();

function normalizeUrl(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (s.startsWith('//')) return 'https:' + s;
  return s;
}

function isShopifyCdn(value) {
  try {
    const u = new URL(normalizeUrl(value));
    return u.protocol === 'https:' && u.hostname === 'cdn.shopify.com';
  } catch (_) {
    return false;
  }
}

// A relative asset path (the bundled /design-system placeholders) or an inline/file URL is not an
// emailable image URL yet, so there is nothing to crop and no host to reject. The shipped
// exemplars use these placeholders; real campaigns must resolve to a hosted URL.
function isLocalOrInline(value) {
  const s = String(value || '').trim();
  if (/^(data|file|blob):/i.test(s)) return true;
  return !/^(?:https?:)?\/\//i.test(s);
}

// The URL without the crop params — the thing whose intrinsic size we need to read. Other
// params (v=, etc.) are preserved so Shopify does not treat it as a different asset.
function strippedSourceUrl(value) {
  const u = new URL(normalizeUrl(value));
  for (const p of CROP_PARAMS) u.searchParams.delete(p);
  return u.toString();
}

function cropPositionFromObjectPosition(value) {
  const tokens = String(value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return 'center';
  const pct = (t) => (/^-?\d+(?:\.\d+)?%$/.test(t) ? parseFloat(t) : null);

  let x = 50;
  let y = 50;
  // Keyword forms ("center top", "left center", "top").
  if (tokens.includes('left') && !tokens.includes('right')) x = 0;
  if (tokens.includes('right')) x = 100;
  if (tokens.includes('top')) y = 0;
  if (tokens.includes('bottom')) y = 100;

  // Percentage forms. A lone percentage is the x coordinate (CSS object-position semantics);
  // a percentage after `center` / `left` / `right` is the y coordinate.
  const firstPct = pct(tokens[0]);
  if (firstPct != null) {
    x = firstPct;
    const secondPct = pct(tokens[1]);
    if (secondPct != null) y = secondPct;
  } else if (tokens[0] === 'center' && pct(tokens[1]) != null) {
    y = pct(tokens[1]);
  } else if ((tokens[0] === 'left' || tokens[0] === 'right') && pct(tokens[1]) != null) {
    y = pct(tokens[1]);
  } else {
    const nums = tokens.map(pct).filter((n) => n != null);
    if (nums.length >= 2) { x = nums[0]; y = nums[1]; }
    else if (nums.length === 1 && !tokens.includes('top') && !tokens.includes('bottom')) x = nums[0];
  }

  if (y <= 33) return 'top';
  if (y >= 67) return 'bottom';
  if (x <= 33) return 'left';
  if (x >= 67) return 'right';
  return 'center';
}

// Replace width/height/crop in place (URLSearchParams.set preserves the other params and their
// order), and never ask for more pixels than the source has.
function croppedShopifyUrl(value, { slotWidth, slotHeight, position, sourceWidth, columnCeiling }) {
  const u = new URL(normalizeUrl(value));
  const targetWidth = Math.max(slotWidth, Number(columnCeiling) || slotWidth);
  const width = Math.max(1, Math.round(sourceWidth ? Math.min(targetWidth, sourceWidth) : targetWidth));
  const height = Math.max(1, Math.round(width * slotHeight / slotWidth));
  u.searchParams.set('width', String(width));
  u.searchParams.set('height', String(height));
  u.searchParams.set('crop', CROP_POSITIONS.has(position) ? position : 'center');
  return u.toString();
}

function parseDeclarations(style) {
  return String(style || '')
    .split(';')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const colon = chunk.indexOf(':');
      if (colon < 0) return { key: chunk.trim().toLowerCase(), value: '' };
      return { key: chunk.slice(0, colon).trim().toLowerCase(), value: chunk.slice(colon + 1).trim() };
    });
}

// Turn a fixed-height/object-fit image style into a self-sizing one:
//   width:100%; max-width:<fluid 100% | full-bleed 600px | fixed slot>; height:auto
// Every other declaration (border, display, …) is preserved.
function rewriteImageStyle(style, slotWidth, opts = {}) {
  const maxWidth = opts.maxWidth || (slotWidth + 'px');
  const minWidth = opts.minWidth || null;
  const out = [];
  let hasWidth = false;
  let hasMaxWidth = false;
  let hasHeight = false;
  let hasMinWidth = false;
  for (const decl of parseDeclarations(style)) {
    if (decl.key === 'object-fit' || decl.key === 'object-position') continue;
    if (decl.key === 'height' && /^-?\d+(?:\.\d+)?px$/i.test(decl.value)) {
      out.push({ key: 'height', value: 'auto' });
      hasHeight = true;
    } else if (decl.key === 'width' && /^-?\d+(?:\.\d+)?px$/i.test(decl.value)) {
      out.push({ key: 'width', value: '100%' });
      hasWidth = true;
    } else if (decl.key === 'max-width') {
      out.push({ key: 'max-width', value: maxWidth });
      hasMaxWidth = true;
    } else if (decl.key === 'min-width' && minWidth) {
      out.push({ key: 'min-width', value: minWidth });
      hasMinWidth = true;
    } else {
      out.push(decl);
    }
  }
  if (!hasWidth) out.unshift({ key: 'width', value: '100%' });
  if (minWidth && !hasMinWidth) {
    const widthAt = out.findIndex((d) => d.key === 'width');
    out.splice(widthAt + 1, 0, { key: 'min-width', value: minWidth });
  }
  if (!hasMaxWidth) out.push({ key: 'max-width', value: maxWidth });
  if (!hasHeight) out.push({ key: 'height', value: 'auto' });

  // Multiple max-width/min-width declarations collapse to the last (hero-b ships three
  // max-width values as a cascade hint).
  const last = new Map();
  out.forEach((d, i) => last.set(d.key, i));
  const deduped = out.filter((d, i) => !['width', 'max-width', 'min-width', 'height'].includes(d.key) || last.get(d.key) === i);
  return deduped.map((d) => `${d.key}:${d.value}`).join(';') + ';';
}

// A src attribute is HTML, not a URL: a raw `&` starts an entity reference. Shopify crop params
// must be emitted as `&amp;` or an HTML/Gmail parser can drop everything after the first raw
// ampersand, silently throwing the crop away. Do not double-escape an attribute that already
// carries `&amp;`.
function escapeAmpersands(value) {
  return String(value).replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]+|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
}

function attr(tag, name) {
  const m = tag.match(new RegExp('\\s' + name + '\\s*=\\s*(["\'])([\\s\\S]*?)\\1', 'i'));
  return m ? m[2] : null;
}

function numericAttr(tag, name) {
  const raw = attr(tag, name);
  if (raw == null) return null;
  const m = String(raw).trim().match(/^(\d+(?:\.\d+)?)$/);
  return m ? Number(m[1]) : null;
}

function styleSlotWidth(style) {
  const decls = parseDeclarations(style);
  const byKey = (k) => decls.find((d) => d.key === k);
  for (const key of ['width', 'max-width']) {
    const d = byKey(key);
    const m = d && d.value.match(/^(\d+(?:\.\d+)?)px$/i);
    if (m) return Number(m[1]);
  }
  return null;
}

function styleSlotHeight(style) {
  const d = parseDeclarations(style).find((x) => x.key === 'height');
  const m = d && d.value.match(/^(\d+(?:\.\d+)?)px$/i);
  return m ? Number(m[1]) : null;
}

function replaceAttr(tag, name, value) {
  const re = new RegExp('(\\s' + name + '\\s*=\\s*)(["\'])([\\s\\S]*?)\\2', 'i');
  if (!re.test(tag)) return tag;
  return tag.replace(re, (_, pre, quote) => `${pre}${quote}${value}${quote}`);
}

function classTokens(tag) {
  return new Set(String(attr(tag, 'class') || '').split(/\s+/).filter(Boolean));
}

// Decide how wide this image may render. `.fimg` and any template that already capped itself at
// 600px are full-bleed; known fluid classes/components go to 100%; everything else keeps its
// fixed slot as the max-width (e.g. a 340px testimonial photo, a 168px collage tile).
function imageWidthPolicy(style, tag, component, slotWidth) {
  const classes = classTokens(tag);
  const original = parseDeclarations(style).filter((d) => d.key === 'max-width').at(-1);
  const originalWidth = original && original.value;
  const originalPx = originalWidth && /^(\d+(?:\.\d+)?)px$/i.test(originalWidth)
    ? Number(originalWidth.replace(/px$/i, '')) : null;
  const fullBleed = classes.has('fimg') || (originalPx != null && originalPx >= EMAIL_COLUMN_CEILING);
  const fluid = !fullBleed && (
    [...classes].some((c) => FLUID_IMAGE_CLASSES.has(c))
    || FLUID_COMPONENTS.has(String(component || ''))
    || originalWidth === '100%'
  );
  const maxWidth = fullBleed ? (slotWidth + 'px') : fluid ? '100%' : (slotWidth + 'px');
  const columnCeiling = (fullBleed || fluid) ? EMAIL_COLUMN_CEILING : slotWidth;
  // Gmail iOS will not stretch an image to fill a fluid cell unless the inline style itself
  // asks for it. A fixed-slot image (testimonial, collage tile) must keep its own width; a
  // full-bleed or fluid image must be at least as wide as its cell even when style blocks die.
  const minWidth = (fullBleed || fluid) ? '100%' : null;
  return { fullBleed, fluid, maxWidth, minWidth, columnCeiling };
}

// Rewrite every object-fit image in a fragment of assembled HTML.
//
// opts.component / opts.index annotate any issue for validation.
// opts.sourceSizes = { [strippedUrl]: { width, height } } — used by unit tests and callers that
// already know the source size. The shared cache (populated by primeHtml) is consulted next.
function rewriteHtml(html, opts = {}) {
  const issues = [];
  const images = [];
  const sourceSizesOpt = opts.sourceSizes || {};

  const out = String(html || '').replace(/<img\b[^>]*>/gi, (tag) => {
    const style = attr(tag, 'style');
    if (!style || !/object-fit\s*:/i.test(style)) return tag;
    const src = attr(tag, 'src');
    if (!src || /\{\{|\}\}/.test(src)) return tag; // unresolved token — the export gate owns that

    const slotWidth = numericAttr(tag, 'width') || styleSlotWidth(style);
    const slotHeight = numericAttr(tag, 'height') || styleSlotHeight(style);
    if (!slotWidth || !slotHeight || slotWidth <= 0 || slotHeight <= 0) return tag;

    const objectPosition = (parseDeclarations(style).find((d) => d.key === 'object-position') || {}).value || 'center';
    const position = cropPositionFromObjectPosition(objectPosition);
    const widthPolicy = imageWidthPolicy(style, tag, opts.component, slotWidth);
    const decodedSrc = src.replace(/&amp;/g, '&');
    let nextSrc = src;
    let sourceWidth = null;

    if (isShopifyCdn(decodedSrc)) {
      const key = strippedSourceUrl(decodedSrc);
      const known = sourceSizesOpt[key] || sourceSizes.get(key) || null;
      if (known && known.width) sourceWidth = known.width;
      nextSrc = croppedShopifyUrl(decodedSrc, {
        slotWidth, slotHeight, position, sourceWidth, columnCeiling: widthPolicy.columnCeiling,
      });
      if (sourceWidth && sourceWidth < slotWidth) {
        issues.push({
          severity: 'warning', type: 'image_source_small',
          index: opts.index, component: opts.component, src: decodedSrc,
          value: decodedSrc,
          rule: `email images must be at least as wide as their ${slotWidth}px slot.`,
          message: `Image source is ${sourceWidth}px wide for a ${slotWidth}px slot; the CDN will not upscale, so a browser will enlarge ${Math.min(slotWidth, sourceWidth)}px of pixels.`,
          suggestion: 'Upload a larger source image (at least the slot width at 2x for retina).',
        });
      }
      // The crop height is derived from the slot ratio, so this only trips on pathological
      // rounding — but it is the guard that would catch a future change that lets an exported
      // image's aspect ratio drift away from its slot.
      const cropped = new URL(nextSrc);
      const requestedW = Number(cropped.searchParams.get('width'));
      const requestedH = Number(cropped.searchParams.get('height'));
      if (requestedW > 0 && requestedH > 0 &&
          Math.abs((requestedW / requestedH) - (slotWidth / slotHeight)) > 0.01) {
        issues.push({
          severity: 'warning', type: 'image_aspect_mismatch',
          index: opts.index, component: opts.component, src: decodedSrc, value: nextSrc,
          rule: `an exported image's aspect ratio must match its ${slotWidth}×${slotHeight} slot.`,
          message: `Cropped image ${requestedW}×${requestedH} does not match the ${slotWidth}×${slotHeight} slot ratio.`,
        });
      }
    } else if (isLocalOrInline(decodedSrc)) {
      // Placeholder/local asset: nothing to crop, but still drop the client-side crop so the
      // emitted HTML never depends on object-fit.
      nextSrc = src;
    } else {
      issues.push({
        severity: 'error', type: 'image_crop_unsupported',
        index: opts.index, component: opts.component, src: decodedSrc, value: decodedSrc,
        rule: 'fixed-slot email images must be served from cdn.shopify.com so they can be pre-cropped; object-fit cannot ship.',
        message: `Image '${decodedSrc}' uses object-fit to fill a ${slotWidth}×${slotHeight} slot but is not on cdn.shopify.com, so it cannot be pre-cropped for Gmail.`,
        suggestion: 'Host the image on cdn.shopify.com (or use a source already cropped to the slot ratio) and remove object-fit.',
      });
    }

    let next = replaceAttr(tag, 'src', escapeAmpersands(nextSrc));
    next = replaceAttr(next, 'style', rewriteImageStyle(style, slotWidth, {
      maxWidth: widthPolicy.maxWidth, minWidth: widthPolicy.minWidth,
    }));
    images.push({
      component: opts.component,
      index: opts.index,
      src: decodedSrc,
      outSrc: nextSrc,
      slotWidth,
      slotHeight,
      position,
      sourceWidth,
      maxWidth: widthPolicy.maxWidth,
      minWidth: widthPolicy.minWidth,
      columnCeiling: widthPolicy.columnCeiling,
      fluid: widthPolicy.fluid,
      fullBleed: widthPolicy.fullBleed,
      cropped: nextSrc !== src,
    });
    return next;
  });

  return { html: out, images, issues };
}

function mapLimit(items, limit, fn) {
  const list = [...items];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      await fn(list[i], i);
    }
  });
  return Promise.all(workers);
}

async function readSourceSize(url, opts = {}) {
  const fetchImpl = opts.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs || 12000) : null;
  try {
    // Source-size reads are only for cdn.shopify.com. Do not follow a redirect: a 30x could
    // leave the allow-listed host (and fetch an internal address). The final-URL check is a
    // second guard for fetch implementations that follow redirects despite `manual`.
    const res = await fetchImpl(url, { redirect: 'manual', signal: controller && controller.signal });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`refusing redirect (HTTP ${res.status}) while reading a Shopify source size`);
    }
    if (res.url && !isShopifyCdn(res.url)) {
      throw new Error(`refusing redirect to non-Shopify host '${new URL(res.url).hostname}' while reading a Shopify source size`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers && res.headers.get && res.headers.get('content-length')) || 0;
    if (declared > MAX_SOURCE_BYTES) throw new Error(`source larger than ${MAX_SOURCE_BYTES} bytes`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_SOURCE_BYTES) throw new Error(`source larger than ${MAX_SOURCE_BYTES} bytes`);
    const sharp = require('sharp');
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) throw new Error('unreadable image dimensions');
    return { width: meta.width, height: meta.height };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Fetch (and cache) the intrinsic size of every Shopify image that needs a crop in this HTML.
// The export path awaits this, then assembles once more so each crop is capped at the source
// width. Failures are cached as null and never block an export — the next rewrite falls back to
// the slot width, exactly as a synchronous preview would.
async function primeHtml(html, opts = {}) {
  const wanted = new Set();
  for (const m of String(html || '').matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const style = attr(tag, 'style') || '';
    const src = attr(tag, 'src');
    if (!src) continue;
    const decoded = src.replace(/&amp;/g, '&');
    if (!isShopifyCdn(decoded)) continue;
    const hasObjectFit = /object-fit\s*:/i.test(style);
    const hasCrop = /[?&]crop=/i.test(decoded) && /[?&]width=/i.test(decoded) && /[?&]height=/i.test(decoded);
    if (!hasObjectFit && !hasCrop) continue;
    wanted.add(strippedSourceUrl(decoded));
  }
  const provided = opts.sourceSizes || {};
  const queue = [...wanted].filter((u) => !(u in provided) && !sourceSizes.has(u));
  let failed = 0;
  await mapLimit(queue, opts.concurrency || 4, async (url) => {
    try {
      const size = await readSourceSize(url, opts);
      sourceSizes.set(url, size);
    } catch (_) {
      failed += 1;
      sourceSizes.set(url, null);
    }
  });
  return { checked: wanted.size, fetched: queue.length, failed };
}

function snapshotSourceSizes() {
  const out = {};
  for (const [url, size] of sourceSizes) if (size) out[url] = size;
  return out;
}

function clearSourceSizeCache() { sourceSizes.clear(); }

// Final assembled-HTML guard: after every rewrite, no object-fit declaration may survive. This
// catches CSS-class object-fit (e.g. blocks/event-gallery's `.eg-grid img`) that no inline-style
// rewrite can see. HTML comments are stripped first so documentation/comment examples do not
// fire; CSS comments are stripped for the same reason. A warning, not an error: a designed block
// may legitimately be sliced to PNG, and the guard still tells the caller it is not safe as live
// HTML.
function objectFitIssues(html, opts = {}) {
  const stripped = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  const matches = [...stripped.matchAll(/object-fit\s*:/gi)];
  if (!matches.length) return [];
  const first = matches[0];
  const context = stripped.slice(Math.max(0, first.index - 70), first.index + 90)
    .replace(/\s+/g, ' ').trim().slice(0, 180);
  return [{
    severity: opts.severity || 'warning',
    type: 'object_fit_remaining',
    index: opts.index == null ? null : opts.index,
    component: opts.component || null,
    count: matches.length,
    rule: 'assembled email HTML must not contain object-fit declarations: Gmail strips them, so the designed crop is lost.',
    message: `Assembled HTML still contains ${matches.length} object-fit declaration${matches.length === 1 ? '' : 's'} after the image rewrite (near: ${context}). Slice that block to PNG or pre-crop its images.`,
    suggestion: 'If this is a designed block, send it as a PNG slice; otherwise add an inline object-fit/object-position style so lib/emailImages.js can pre-crop it.',
  }];
}

module.exports = {
  CROP_POSITIONS,
  isShopifyCdn,
  strippedSourceUrl,
  cropPositionFromObjectPosition,
  croppedShopifyUrl,
  rewriteImageStyle,
  rewriteHtml,
  escapeAmpersands,
  objectFitIssues,
  primeHtml,
  snapshotSourceSizes,
  clearSourceSizeCache,
  readSourceSize,
};

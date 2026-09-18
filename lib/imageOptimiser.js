'use strict';
// imageOptimiser.js — the encode stage between slice rasterisation and Klaviyo upload.
//
// Every rasterised block slice passes through here on its way to Klaviyo. The stage:
//   1. normalises the render — sRGB, no metadata, capped at 2x the 600px display width;
//   2. encodes every candidate (lossless PNG, 256-colour palette PNG, JPEG q82, optionally
//      WebP) from those normalised pixels;
//   3. quality-gates each lossy candidate with a windowed SSIM against the render;
//   4. keeps the smallest candidate that passes, ties to PNG.
//
// The rule is per image, never global, because the two image families pull in opposite
// directions: a photograph shipped as truecolour PNG is roughly 5x the bytes of the same
// picture at JPEG q82, while a flat graphic is the opposite — JPEG makes it bigger and a
// 256-colour palette PNG wins. Measuring both on every image is the only rule that holds.
//
// Deterministic output is the point, so results are cached on a hash of the source bytes plus
// the encoder settings: re-exporting an unchanged email does not re-encode.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// sharp is loaded lazily so the pure assemble/schema paths (and any install that only needs the
// editor) still work. It is not optional on the upload path — see optimiseImage().
let _sharp = null;
function loadSharp() {
  if (!_sharp) {
    try {
      _sharp = require('sharp');
    } catch (e) {
      throw new Error('The image optimisation stage needs the "sharp" package (npm install sharp). ' +
        'Refusing to upload unoptimised slices: ' + ((e && e.message) || e));
    }
  }
  return _sharp;
}
function sharpVersion() {
  try {
    const s = require('sharp');
    return `${(s.versions && s.versions.sharp) || '?'}/vips${(s.versions && s.versions.vips) || '?'}`;
  } catch (_) { return 'none'; }
}

// ── Configuration ─────────────────────────────────────────────────────────────────────
// Thresholds are config, not literals. Env wins over the defaults; explicit opts win over env.
const DEFAULTS = {
  // Retina discipline: slices render 2x the block's display width, hard-capped at 1200px.
  maxWidth: 1200,
  scale: 2,
  // Quality gate: SSIM between the original render and each lossy candidate.
  ssimThreshold: 0.98,
  jpegQuality: 82,
  pngColours: 256,
  // WebP measured 87% smaller than the PNG originals, but Outlook on Windows will not render
  // it and email has no reliable <picture> fallback, so it stays behind this flag, off.
  webp: false,
  webpQuality: 80,
  // Weight budget for the whole email (sum of the optimised images).
  budgetPassBytes: 600 * 1024,
  budgetWarnBytes: 1024 * 1024,
  // Cache: in-memory always, plus a disk tier so a restarted instance still hits.
  cache: true,
  cacheDir: path.join(os.tmpdir(), 'eb-image-optimiser-cache'),
  cacheMaxEntries: 400,
  cacheMaxBytes: 128 * 1024 * 1024,
  // Cap on the pixels SSIM is computed over, so one very long slice cannot dominate an export.
  ssimMaxPixels: 600000,
  verbose: false,
  logger: console,
};

function toInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}
function toFloat(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function toBool(v, fallback) {
  if (v == null || v === '') return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function config(overrides) {
  const env = process.env;
  const cfg = {
    ...DEFAULTS,
    maxWidth: toInt(env.IMAGE_OPT_MAX_WIDTH, DEFAULTS.maxWidth),
    scale: toInt(env.IMAGE_OPT_SCALE, DEFAULTS.scale),
    ssimThreshold: toFloat(env.IMAGE_OPT_SSIM, DEFAULTS.ssimThreshold),
    jpegQuality: toInt(env.IMAGE_OPT_JPEG_QUALITY, DEFAULTS.jpegQuality),
    pngColours: toInt(env.IMAGE_OPT_PNG_COLOURS, DEFAULTS.pngColours),
    webp: toBool(env.IMAGE_OPT_WEBP, DEFAULTS.webp),
    webpQuality: toInt(env.IMAGE_OPT_WEBP_QUALITY, DEFAULTS.webpQuality),
    budgetPassBytes: toInt(env.IMAGE_WEIGHT_PASS_BYTES, DEFAULTS.budgetPassBytes),
    budgetWarnBytes: toInt(env.IMAGE_WEIGHT_WARN_BYTES, DEFAULTS.budgetWarnBytes),
    cache: toBool(env.IMAGE_OPT_CACHE, DEFAULTS.cache),
    cacheDir: env.IMAGE_OPT_CACHE_DIR || DEFAULTS.cacheDir,
  };
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v === undefined) continue;
    cfg[k] = v; // logger:null silences the stage; cacheDir:null drops the disk tier
  }
  return cfg;
}

function loggerFor(cfg) {
  if (cfg.logger === null) return { warn() {}, info() {} };
  return cfg.logger || console;
}

// ── Naming ────────────────────────────────────────────────────────────────────────────
// One source of truth for what a slice is called: the Klaviyo media name, the download
// filename and the weight table all read from here, so the table names what was uploaded.
function sliceBaseName(s) {
  const ordinal = String((s.index || 0) + 1).padStart(2, '0');
  const comp = String(s.component || 'block').replace(/[\/]+/g, '-');
  const isRegion = s.name != null && s.name !== '';
  const suffix = isRegion ? '-' + String(s.name).replace(/^tile-/, '')
    : (s.segCount > 1 ? '-' + ((s.seg || 0) + 1) : '');
  return `${ordinal}-${comp}${suffix}`;
}
function fileName(s) {
  const ext = s.kind === 'gif' ? 'gif' : (s.image && s.image.ext) || (s.ext || 'png');
  return `${sliceBaseName(s)}.${ext}`;
}
function human(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// ── SSIM ──────────────────────────────────────────────────────────────────────────────
// Windowed SSIM (11x11 Gaussian, sigma 1.5) on greyscale, alpha composited over white — the
// canvas background the eye actually compares against. Both sides are reduced to the same
// bounded pixel count before comparison so the cost per slice is bounded.
function gaussianKernel(sigma, radius) {
  const k = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v; sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

// Separable blur with edge clamping — a 2-D 11x11 window becomes 2 x 11 taps per pixel.
function blur(src, w, h, kernel) {
  const r = (kernel.length - 1) / 2;
  const tmp = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i));
        acc += kernel[i + r] * src[row + xx];
      }
      tmp[row + x] = acc;
    }
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i));
        acc += kernel[i + r] * tmp[yy * w + x];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

function ssim(a, b, w, h) {
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const k = gaussianKernel(1.5, 5);
  const muA = blur(a, w, h, k), muB = blur(b, w, h, k);
  const aa = new Float64Array(w * h), bb = new Float64Array(w * h), ab = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) { aa[i] = a[i] * a[i]; bb[i] = b[i] * b[i]; ab[i] = a[i] * b[i]; }
  const muAA = blur(aa, w, h, k), muBB = blur(bb, w, h, k), muAB = blur(ab, w, h, k);
  let total = 0;
  for (let i = 0; i < w * h; i++) {
    const varA = muAA[i] - muA[i] * muA[i];
    const varB = muBB[i] - muB[i] * muB[i];
    const cov = muAB[i] - muA[i] * muB[i];
    const num = (2 * muA[i] * muB[i] + C1) * (2 * cov + C2);
    const den = (muA[i] * muA[i] + muB[i] * muB[i] + C1) * (varA + varB + C2);
    total += den === 0 ? 1 : num / den;
  }
  return total / (w * h);
}

// Decode either encoded bytes (Buffer) or normalised raw pixels (object) to a bounded
// greyscale field, so the render and every candidate are compared on identical terms.
async function greyAt(src, cfg, width, height) {
  const scale = Math.min(1, Math.sqrt(cfg.ssimMaxPixels / Math.max(1, width * height)));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const pipe = Buffer.isBuffer(src)
    ? loadSharp()(src, { failOn: 'none', limitInputPixels: false })
    : loadSharp()(src.buffer, { raw: { width: src.width, height: src.height, channels: src.channels },
        failOn: 'none', limitInputPixels: false });
  const { data, info } = await pipe
    .resize(w, h, { kernel: 'lanczos3', fit: 'fill' })
    .flatten({ background: '#ffffff' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = new Float32Array(info.width * info.height);
  for (let i = 0; i < out.length; i++) out[i] = data[i * info.channels];
  return { grey: out, width: info.width, height: info.height };
}

// ── Normalisation ─────────────────────────────────────────────────────────────────────
// Convert to sRGB, drop every metadata chunk (EXIF, text, ICC — sharp copies none unless
// asked), strip a fully-opaque alpha channel, and cap the width at the retina target with a
// Lanczos filter.
async function prepare(buffer, cfg) {
  const meta = await loadSharp()(buffer, { failOn: 'none', limitInputPixels: false }).metadata();
  if (!meta.width || !meta.height) throw new Error('unreadable image (no dimensions)');
  let pipe = loadSharp()(buffer, { failOn: 'none', limitInputPixels: false }).toColourspace('srgb');
  const downscaled = meta.width > cfg.maxWidth;
  if (downscaled) pipe = pipe.resize({ width: cfg.maxWidth, kernel: 'lanczos3', fit: 'inside', withoutEnlargement: true });
  const { data, info } = await pipe.raw().ensureAlpha().toBuffer({ resolveWithObject: true });
  // "Meaningful alpha" is measured, not assumed: Puppeteer screenshots carry an alpha channel
  // that is fully opaque, and a channel that is never below 255 is not an alpha channel.
  let minAlpha = 255;
  for (let i = 3; i < data.length; i += 4) if (data[i] < minAlpha) minAlpha = data[i];
  const hasAlpha = minAlpha < 255;
  let pixels = data;
  if (!hasAlpha) {
    pixels = Buffer.allocUnsafe(info.width * info.height * 3);
    for (let i = 0, p = 0; i < pixels.length; i += 3, p += 4) {
      pixels[i] = data[p]; pixels[i + 1] = data[p + 1]; pixels[i + 2] = data[p + 2];
    }
  }
  return {
    pixels, width: info.width, height: info.height, channels: hasAlpha ? 4 : 3,
    hasAlpha, minAlpha, downscaled,
    sourceWidth: meta.width, sourceHeight: meta.height,
    sourceSpace: meta.space || 'unknown',
  };
}

// ── Candidate encoders ────────────────────────────────────────────────────────────────
const RANK = { png: 0, 'png-palette': 1, jpeg: 2, webp: 3 };
const MIME = { png: 'image/png', 'png-palette': 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const EXT = { png: 'png', 'png-palette': 'png', jpeg: 'jpg', webp: 'webp' };

function encodeCandidates(prepared, cfg) {
  const raw = { width: prepared.width, height: prepared.height, channels: prepared.channels };
  const src = () => loadSharp()(prepared.pixels, { raw, failOn: 'none' });
  const jobs = [
    // Lossless re-encode at maximum compression: the always-safe floor, and the fallback when
    // every lossy candidate fails the gate.
    { format: 'png', lossless: true,
      run: () => src().png({ compressionLevel: 9, effort: 10, adaptiveFiltering: true }).toBuffer() },
    // Palette PNG is lossy: flat graphics pass the gate easily, photographs will not.
    { format: 'png-palette', lossless: false,
      run: () => src().png({ palette: true, colours: cfg.pngColours, effort: 10, compressionLevel: 9 }).toBuffer() },
  ];
  // JPEG cannot carry an alpha channel, so an image that needs one is never a JPEG candidate.
  if (!prepared.hasAlpha) {
    jobs.push({ format: 'jpeg', lossless: false,
      run: () => src().jpeg({ quality: cfg.jpegQuality, progressive: true, optimiseCoding: true,
        chromaSubsampling: '4:2:0', mozjpeg: true }).toBuffer() });
  }
  if (cfg.webp) {
    jobs.push({ format: 'webp', lossless: false,
      run: () => src().webp({ quality: cfg.webpQuality, effort: 6 }).toBuffer() });
  }
  return jobs;
}

// ── Cache ─────────────────────────────────────────────────────────────────────────────
// Key = hash(source bytes) + the settings that change the output + the encoder build. The
// version tag is bumped by hand when the pipeline's output shape changes.
const CACHE_VERSION = 1;
const memCache = new Map(); // key → { entry, bytes }
let memBytes = 0;
const counters = { hits: 0, misses: 0, diskHits: 0, diskWrites: 0, encodeMs: 0 };

function settingsFingerprint(cfg) {
  return JSON.stringify({
    maxWidth: cfg.maxWidth, ssimThreshold: cfg.ssimThreshold, jpegQuality: cfg.jpegQuality,
    pngColours: cfg.pngColours, webp: !!cfg.webp, webpQuality: cfg.webpQuality,
  });
}
function cacheKey(buffer, cfg) {
  return crypto.createHash('sha256')
    .update(`eb-image-opt|v${CACHE_VERSION}|${sharpVersion()}|${settingsFingerprint(cfg)}|`)
    .update(buffer)
    .digest('hex');
}
function memPut(key, entry, cfg) {
  const previous = memCache.get(key);
  if (previous) memBytes -= previous.bytes;
  memCache.delete(key);
  memCache.set(key, { entry, bytes: entry.buffer.length });
  memBytes += entry.buffer.length;
  while (memCache.size > cfg.cacheMaxEntries || (memBytes > cfg.cacheMaxBytes && memCache.size > 1)) {
    const oldest = memCache.keys().next().value;
    memBytes -= memCache.get(oldest).bytes;
    memCache.delete(oldest);
  }
}
function cacheGet(key, cfg) {
  if (!cfg.cache) { counters.misses++; return null; }
  const hit = memCache.get(key);
  if (hit) { // LRU refresh
    memCache.delete(key); memCache.set(key, hit);
    counters.hits++;
    return hit.entry;
  }
  if (cfg.cache && cfg.cacheDir) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(cfg.cacheDir, key + '.json'), 'utf8'));
      entry.buffer = Buffer.from(entry.dataBase64, 'base64');
      delete entry.dataBase64;
      memPut(key, entry, cfg);
      counters.hits++; counters.diskHits++;
      return entry;
    } catch (_) { /* miss */ }
  }
  counters.misses++;
  return null;
}
function cachePut(key, entry, cfg) {
  if (!cfg.cache) return;
  memPut(key, entry, cfg);
  if (!cfg.cacheDir) return;
  try {
    fs.mkdirSync(cfg.cacheDir, { recursive: true });
    const payload = JSON.stringify(entry, (k, v) => (k === 'buffer' ? undefined : v));
    fs.writeFileSync(path.join(cfg.cacheDir, key + '.json'),
      JSON.stringify({ ...JSON.parse(payload), dataBase64: entry.buffer.toString('base64') }));
    counters.diskWrites++;
  } catch (_) { /* a cold cache is a slow cache, never a failed export */ }
}
function cacheStats() { return { ...counters, entries: memCache.size, bytes: memBytes }; }
function clearCache(cfg) {
  memCache.clear(); memBytes = 0;
  const dir = (cfg && cfg.cacheDir) || DEFAULTS.cacheDir;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// ── The stage ─────────────────────────────────────────────────────────────────────────
// One image in, the smallest gate-passing encoding out, with the full measurement record.
async function optimiseImage(buffer, options = {}) {
  const cfg = options.config || config(options);
  const log = loggerFor(cfg);
  const label = options.label || 'slice';
  const key = cacheKey(buffer, cfg);
  const cached = cacheGet(key, cfg);
  if (cached) return { ...cached, cacheHit: true };

  const started = Date.now();
  const prepared = await prepare(buffer, cfg);
  const reference = await greyAt(
    { buffer: prepared.pixels, width: prepared.width, height: prepared.height, channels: prepared.channels },
    cfg, prepared.width, prepared.height);

  const candidates = [];
  for (const job of encodeCandidates(prepared, cfg)) {
    let out = null;
    try {
      out = await job.run();
    } catch (e) {
      log.warn(`[image-opt] ${job.format} encode failed for ${label}: ${(e && e.message) || e}`);
      continue;
    }
    const rec = { format: job.format, ext: EXT[job.format], mime: MIME[job.format],
      bytes: out.length, lossless: !!job.lossless, buffer: out };
    if (job.lossless) {
      rec.ssim = 1; rec.accepted = true; // a lossless re-encode is the reference by definition
    } else {
      const grey = await greyAt(out, cfg, prepared.width, prepared.height);
      rec.ssim = +ssim(reference.grey, grey.grey, reference.width, reference.height).toFixed(5);
      rec.accepted = rec.ssim >= cfg.ssimThreshold;
      // Rejections are logged so a regression in encoder settings is visible, not silent.
      if (!rec.accepted) {
        log.warn(`[image-opt] rejected ${job.format} for ${label} (${human(out.length)}, ` +
          `SSIM ${rec.ssim.toFixed(4)} < ${cfg.ssimThreshold})`);
      }
    }
    candidates.push(rec);
  }
  if (!candidates.length) throw new Error(`no candidate encoder succeeded for ${label}`);

  // Smallest passing candidate wins; ties go to PNG (the lower rank) for the broader set of
  // edge-case clients that render it without a fallback.
  const passing = candidates.filter((c) => c.accepted)
    .sort((a, b) => (a.bytes - b.bytes) || (RANK[a.format] - RANK[b.format]));
  const winner = passing[0];
  if (!winner) throw new Error(`every candidate failed the quality gate for ${label}`);

  const entry = {
    buffer: winner.buffer,
    format: winner.format, ext: winner.ext, mime: winner.mime,
    before: buffer.length, after: winner.buffer.length,
    ssim: winner.ssim, lossless: !!winner.lossless,
    width: prepared.width, height: prepared.height,
    sourceWidth: prepared.sourceWidth, sourceHeight: prepared.sourceHeight,
    hasAlpha: prepared.hasAlpha, downscaled: prepared.downscaled,
    sourceSpace: prepared.sourceSpace,
    candidates: candidates.map((c) => ({ format: c.format, bytes: c.bytes, ssim: c.ssim,
      accepted: c.accepted, lossless: !!c.lossless })),
  };
  cachePut(key, entry, cfg);
  counters.encodeMs += Date.now() - started;
  if (cfg.verbose) {
    log.info(`[image-opt] ${label} ${human(entry.before)} → ${human(entry.after)} (${entry.format}` +
      `${entry.lossless ? '' : ', SSIM ' + entry.ssim.toFixed(4)})`);
  }
  return { ...entry, cacheHit: false };
}

// Sum the optimised bytes and judge them against the budget. Live GIFs pass through by
// reference (rasterising one would freeze it), so they carry no bytes here and are reported
// as passthrough rather than counted.
function assessWeight(records, cfg) {
  const images = (records || []).filter((r) => !r.passthrough && r.after != null);
  const totalBytes = images.reduce((n, r) => n + (r.after || 0), 0);
  const heaviest = images.slice()
    .sort((a, b) => (b.after || 0) - (a.after || 0))
    .slice(0, 3)
    .map((r) => ({ label: r.label, bytes: r.after, format: r.format }));
  const status = totalBytes > cfg.budgetWarnBytes ? 'fail'
    : totalBytes > cfg.budgetPassBytes ? 'warn' : 'pass';
  return { status, totalBytes, passBytes: cfg.budgetPassBytes, warnBytes: cfg.budgetWarnBytes, heaviest };
}

// Optimise every rasterised slice of one email, returning new slice objects (buffer replaced
// with the chosen encoding) plus the report the API surfaces and the budget verdict.
async function optimiseSlices(slices, options = {}) {
  const cfg = options.config || config(options);
  const log = loggerFor(cfg);
  const out = [];
  const records = [];
  for (const s of slices || []) {
    const label = sliceBaseName(s);
    if (s.kind === 'gif' || !s.buffer) {
      const rec = { label, component: s.component, index: s.index, seg: s.seg, name: s.name,
        kind: s.kind || 'gif', format: 'gif', before: 0, after: 0, passthrough: true, cacheHit: false };
      records.push(rec);
      out.push({ ...s, image: rec });
      continue;
    }
    const res = await optimiseImage(s.buffer, { ...options, config: cfg, label });
    const rec = {
      label, component: s.component, index: s.index, seg: s.seg, segCount: s.segCount, name: s.name,
      kind: 'png', format: res.format, ext: res.ext, mime: res.mime,
      before: res.before, after: res.after, savedBytes: res.before - res.after,
      savedPct: res.before ? +((1 - res.after / res.before) * 100).toFixed(1) : 0,
      ssim: res.ssim, lossless: res.lossless, cacheHit: res.cacheHit,
      width: res.width, height: res.height, downscaled: res.downscaled, hasAlpha: res.hasAlpha,
      rejected: res.candidates.filter((c) => !c.accepted).map((c) => ({ format: c.format, bytes: c.bytes, ssim: c.ssim })),
      candidates: res.candidates,
    };
    records.push(rec);
    out.push({ ...s, buffer: res.buffer, image: rec });
  }
  const totalBefore = records.reduce((n, r) => n + r.before, 0);
  const totalAfter = records.reduce((n, r) => n + r.after, 0);
  const budget = assessWeight(records, cfg);
  if (budget.status === 'warn') {
    log.warn(`[image-opt] weight budget warning: images total ${human(totalAfter)}, over the ` +
      `${human(cfg.budgetPassBytes)} target — heaviest: ` +
      budget.heaviest.map((h) => `${h.label} (${human(h.bytes)})`).join(', '));
  }
  const report = {
    images: records,
    totalBefore, totalAfter,
    savedBytes: totalBefore - totalAfter,
    savedPct: totalBefore ? +((1 - totalAfter / totalBefore) * 100).toFixed(1) : 0,
    budget,
    settings: {
      maxWidth: cfg.maxWidth, scale: cfg.scale, jpegQuality: cfg.jpegQuality,
      pngColours: cfg.pngColours, ssimThreshold: cfg.ssimThreshold, webp: !!cfg.webp,
    },
  };
  return { slices: out, report };
}

module.exports = {
  config, DEFAULTS, optimiseImage, optimiseSlices, assessWeight, prepare, ssim,
  cacheStats, clearCache, sliceBaseName, fileName, human, cacheKey,
};

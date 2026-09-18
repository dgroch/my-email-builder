'use strict';
// measure-image-weights.js — run the real slice pipeline over one or more campaigns and print
// the before/after weight table for every image plus the email total and the budget verdict.
//
// This is the verification tool for the optimisation stage: it rasterises with the same
// Puppeteer path the Klaviyo push uses, runs lib/imageOptimiser over the slices, and reports
// exactly what would be uploaded.
//
//   node scripts/measure-image-weights.js                         # every committed seed design
//   node scripts/measure-image-weights.js --design examples/farewell_sellthrough.json
//   node scripts/measure-image-weights.js --campaign /tmp/c.json --assets /tmp/campaign-assets
//   node scripts/measure-image-weights.js --visual-diff        # also diff the re-rendered email
//   node scripts/measure-image-weights.js --json > weights.json
//
// --assets replaces {{ASSETS_BASE}} in the campaign's tokens with a directory (or URL) whose
// files the headless browser can actually fetch — the committed seeds point at placeholder
// filenames that are not in the repo, so a faithful measurement needs them supplied.
//
// Exits non-zero when a campaign's optimised images exceed the fail threshold, so it can gate a
// release the same way the push endpoint refuses to publish an over-budget email.

const fs = require('fs');
const path = require('path');

const render = require('../lib/render');
const images = require('../lib/imageOptimiser');
const examples = require('../lib/examples');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      const takesValue = ['design', 'campaign', 'assets', 'label'].includes(k);
      args[k] = takesValue ? (inline != null ? inline : argv[++i]) : (inline != null ? inline !== 'false' : true);
    } else args._.push(a);
  }
  return args;
}

// A campaign whose tokens point at {{ASSETS_BASE}} is the shipped shape; swap it for something
// the renderer can resolve (an absolute directory or an https base).
function withAssets(campaign, assetsBase) {
  if (!assetsBase) return campaign;
  const base = /^https?:|^file:/.test(assetsBase) ? assetsBase.replace(/\/+$/, '') : 'file://' + path.resolve(assetsBase);
  return JSON.parse(JSON.stringify(campaign).split('{{ASSETS_BASE}}').join(base));
}

function loadDesigns(args) {
  if (args.campaign) {
    const raw = JSON.parse(fs.readFileSync(args.campaign, 'utf8'));
    // Accept either a bare campaign or a saved design wrapping one.
    const campaign = raw.campaign && raw.campaign.blocks ? raw.campaign : raw;
    return [{ id: raw.id || path.basename(args.campaign, '.json'), name: raw.name || args.label || 'campaign', campaign }];
  }
  if (args.design) {
    const raw = JSON.parse(fs.readFileSync(args.design, 'utf8'));
    const campaign = raw.campaign && raw.campaign.blocks ? raw.campaign : raw;
    return [{ id: raw.id || path.basename(args.design, '.json'), name: raw.name || 'design', campaign }];
  }
  const seeds = examples.loadSeedExamples();
  return seeds.map((s) => ({ id: s.id, name: s.name, campaign: s.campaign }));
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function padLeft(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

// ── visual diff ───────────────────────────────────────────────────────────────────────
// Rebuild the email the way the push does — one image row per slice — twice: once from the
// original PNG renders and once from the optimised encodings. Rendering both at the same
// display width isolates the encoder as the only difference, so any pixels that moved are the
// compression, not the layout. Checks the 600px desktop view and the 375px phone view.
function composedHtml(slices, useOptimised, displayWidth) {
  const rows = slices.filter((s) => s.kind !== 'gif').map((s) => {
    const body = useOptimised ? s.buffer : s.original;
    const mime = useOptimised ? (s.image && s.image.mime) || 'image/png' : 'image/png';
    return `<tr><td style="padding:0;font-size:0;line-height:0;">` +
      `<img src="data:${mime};base64,${body.toString('base64')}" width="${s.width}" ` +
      `style="display:block;width:100%;height:auto;border:0;"></td></tr>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#ffffff;">` +
    `<div style="width:${displayWidth}px;">` +
    `<table width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">` +
    `${rows}</table></div></body></html>`;
}

async function greyField(buffer) {
  const sharpLib = require('sharp');
  const meta = await sharpLib(buffer).metadata();
  const { data, info } = await sharpLib(buffer).flatten({ background: '#ffffff' }).greyscale().raw()
    .toBuffer({ resolveWithObject: true });
  const grey = new Float32Array(info.width * info.height);
  for (let i = 0; i < grey.length; i++) grey[i] = data[i * info.channels];
  return { grey, width: info.width, height: info.height, meta };
}

async function visualDiff(slices) {
  const sharpLib = require('sharp');
  const out = {};
  for (const displayWidth of [600, 375]) {
    const beforePng = (await render.renderToPng(composedHtml(slices, false, displayWidth), { width: displayWidth })).buffer;
    const afterPng = (await render.renderToPng(composedHtml(slices, true, displayWidth), { width: displayWidth })).buffer;
    const a = await greyField(beforePng), b = await greyField(afterPng);
    const width = Math.min(a.width, b.width), height = Math.min(a.height, b.height);
    const rgbA = await sharpLib(beforePng).resize(width, height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    const rgbB = await sharpLib(afterPng).resize(width, height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    let sum = 0, worst = 0, over8 = 0;
    for (let i = 0; i < rgbA.length; i++) {
      const d = Math.abs(rgbA[i] - rgbB[i]);
      sum += d; if (d > worst) worst = d; if (d > 8) over8++;
    }
    const crop = (f, w, h) => {
      if (f.width === w && f.height === h) return f.grey;
      const g = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const sx = Math.min(f.width - 1, Math.round(x * f.width / w));
        const sy = Math.min(f.height - 1, Math.round(y * f.height / h));
        g[y * w + x] = f.grey[sy * f.width + sx];
      }
      return g;
    };
    out[displayWidth] = {
      width, height,
      ssim: +images.ssim(crop(a, width, height), crop(b, width, height), width, height).toFixed(5),
      meanAbsDiff: +(sum / rgbA.length).toFixed(3),
      worstChannelDiff: worst,
      pctChannelsOver8: +((over8 / rgbA.length) * 100).toFixed(3),
      beforeBytes: beforePng.length, afterBytes: afterPng.length,
    };
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Framework warnings (a rejected candidate, a mid-range weight budget) go to stderr so they
  // stay visible in a run and out of the way of --json on stdout.
  const cfg = images.config({ verbose: false, logger: { info: (m) => console.log(m), warn: (m) => console.error(m) } });
  if (args['no-cache']) cfg.cache = false;
  const designs = loadDesigns(args);
  const results = [];
  let failed = 0;

  for (const d of designs) {
    const campaign = withAssets(d.campaign || {}, args.assets);
    const { html } = render.assemble(campaign, { assetsBase: '{{ASSETS_BASE}}', markBlocks: true });
    const { slices, brokenImages } = await render.renderSlices(html);
    // Keep the pre-optimisation pixels so the visual diff can rebuild the email both ways.
    for (const s of slices) if (s.buffer) s.original = s.buffer;
    const { slices: optimised, report } = await images.optimiseSlices(slices, { config: cfg });
    // Diff the optimised slices against their own originals (both carry the same geometry).
    const diff = args['visual-diff'] ? await visualDiff(optimised) : null;
    results.push({ id: d.id, name: d.name, brokenImages: (brokenImages || []).length, report });
    if (report.budget.status === 'fail') failed++;

    if (!args.json) {
      console.log(`\n${d.name}  (${d.id})`);
      if (brokenImages && brokenImages.length) console.log(`  ⚠ ${brokenImages.length} image(s) did not load in the headless render`);
      console.log('  ' + pad('IMAGE', 34) + padLeft('BEFORE', 10) + padLeft('AFTER', 10) +
        '  ' + pad('FORMAT', 13) + pad('SSIM', 8) + 'SAVED');
      for (const r of report.images) {
        console.log('  ' + pad(r.label, 34) + padLeft(images.human(r.before), 10) + padLeft(images.human(r.after), 10) +
          '  ' + pad(r.passthrough ? 'gif (live)' : r.format, 13) +
          pad(r.passthrough ? '—' : (r.lossless ? 'lossless' : r.ssim.toFixed(4)), 8) +
          (r.passthrough ? '—' : `${r.savedPct.toFixed(1)}%`));
      }
      console.log('  ' + pad('TOTAL (' + report.images.filter((r) => !r.passthrough).length + ' images)', 34) +
        padLeft(images.human(report.totalBefore), 10) + padLeft(images.human(report.totalAfter), 10) +
        '  ' + pad('', 13) + pad('', 8) + `${report.savedPct.toFixed(1)}%`);
      const b = report.budget;
      console.log(`  budget: ${b.status.toUpperCase()} — ${images.human(b.totalBytes)} ` +
        `(pass ≤ ${images.human(b.passBytes)}, fail > ${images.human(b.warnBytes)})`);
      if (b.heaviest.length) console.log('  heaviest: ' + b.heaviest.map((h) => `${h.label} ${images.human(h.bytes)}`).join(', '));
      if (diff) {
        for (const [w, v] of Object.entries(diff)) {
          console.log(`  visual diff at ${w}px: SSIM ${v.ssim} · mean channel diff ${v.meanAbsDiff}/255 · ` +
            `${v.pctChannelsOver8}% of channels off by >8 · worst ${v.worstChannelDiff}`);
        }
      }
    }
  }

  if (args.json) console.log(JSON.stringify(results, null, 2));
  else {
    const before = results.reduce((n, r) => n + r.report.totalBefore, 0);
    const after = results.reduce((n, r) => n + r.report.totalAfter, 0);
    console.log(`\n${results.length} design(s): ${images.human(before)} → ${images.human(after)} ` +
      `(${before ? ((1 - after / before) * 100).toFixed(1) : '0.0'}% smaller)`);
    console.log('cache:', JSON.stringify(images.cacheStats()));
  }
  await render.closeBrowser();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e && e.stack || e);
  try { await render.closeBrowser(); } catch (_) {}
  process.exit(2);
});

#!/usr/bin/env node
'use strict';
// Offline QA only. No requests leave Chromium: local resources or explicit aborts.
const fs = require('node:fs');
const path = require('node:path');
const render = require('../lib/render');
const { buildSchema } = require('../lib/parseTemplates');
const { validateCampaign } = require('../lib/validate');
const ROOT = path.resolve(__dirname, '..');
const ASSET_BASE = 'https://eb212s7.invalid/design-system/assets';
// Only the caps specimen heroes contain photography. Stub their known sample URL locally.
const IMAGE_STUBS = new Map([[require('../lib/sampleData').IMG.hero,
  path.join(ROOT, 'test/fixtures/campaign-assets/placeholder-hero.jpg')]]);
function localResource(url) {
  if (IMAGE_STUBS.has(url)) return IMAGE_STUBS.get(url);
  const u = new URL(url);
  if (u.origin !== 'https://eb212s7.invalid') return null;
  if (!u.pathname.startsWith('/design-system/assets/')) return null;
  const file = path.resolve(ROOT, '.' + decodeURIComponent(u.pathname));
  const assetRoot = path.join(ROOT, 'design-system/assets') + path.sep;
  return file.startsWith(assetRoot) && fs.existsSync(file) ? file : null;
}
function auditPage() {
  const container = document.querySelector('.ew');
  const blueText = [], nonNoirBackgrounds = [], brokenImages = [], caps = [];
  const describe = el => ({ tag: el.tagName, class: el.className, text: (el.textContent || el.alt || '').trim().slice(0, 120) });
  for (const el of [container, ...container.querySelectorAll('*')]) {
    const css = getComputedStyle(el), rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height || css.visibility === 'hidden' || css.display === 'none') continue;
    const color = css.color.match(/[\d.]+/g)?.map(Number) || [];
    const hasText = [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    if (hasText && color[2] > color[0] + 40 && color[2] > color[1] + 40) blueText.push({ ...describe(el), color: css.color });
    const bg = css.backgroundColor.match(/[\d.]+/g)?.map(Number) || [];
    if (bg.length >= 3 && (bg.length < 4 || bg[3] > 0) && bg.slice(0, 3).some(c => c !== 0)) {
      nonNoirBackgrounds.push({ ...describe(el), background: css.backgroundColor });
    }
    if (el.hasAttribute('data-eb-caps')) caps.push({ ...describe(el), font: css.fontFamily, transform: css.textTransform, letterSpacing: css.letterSpacing });
  }
  for (const img of container.querySelectorAll('img')) {
    if (!img.complete || !img.naturalWidth) brokenImages.push({ src: img.src, alt: img.alt });
  }
  return { blueText, nonNoirBackgrounds, brokenImages, caps, documentWidth: document.documentElement.scrollWidth,
    containerWidth: container.getBoundingClientRect().width };
}
async function main() {
  const dir = process.env.EB212S7_RENDER_DIR;
  if (!dir) throw new Error('Set EB212S7_RENDER_DIR to the output directory.');
  fs.mkdirSync(dir, { recursive: true });
  const schema = buildSchema(render.DS);
  const recovered = require('../test/fixtures/212-s7-dark-test.json');
  const caps = require('../test/fixtures/212-s7-dark-caps.json');
  const campaigns = { 'dark-test': { ...recovered, theme: 'dark' }, 'dark-test-caps': caps };
  // Also render every caps-enabled component at each width and image setting.
  const specimen = { campaignName: 'S7 caps specimens', theme: 'dark', blocks: [] };
  for (const c of schema.components.filter(c => c.tokens.some(t => t.name === 'HEADLINE_STYLE'))) {
    specimen.blocks.push({ component: c.name, tokens: { ...require('../lib/sampleData').sampleTokensFor(c),
      HEADLINE_STYLE: 'caps', HEADLINE: 'AFTER DARK / BLACK FRIDAY IS ABOUT TO BLOOM', HEADLINE_LETTER_SPACING: '0.06em' } });
  }
  specimen.blocks.push({ component: 'footer', tokens: {} });
  campaigns['caps-specimens'] = specimen;
  const report = { offline: true, browserRun: !process.argv.includes('--assemble-only'), validation: {}, runs: [] };
  const htmlByName = {};
  for (const [name, campaign] of Object.entries(campaigns)) {
    const assembled = render.assemble(campaign, { assetsBase: ASSET_BASE });
    const validation = validateCampaign(campaign, schema);
    if (assembled.unfilled.length || !validation.ok || validation.warningCount) throw new Error(name + ': ' + JSON.stringify({ unfilled: assembled.unfilled, validation }));
    report.validation[name] = validation;
    htmlByName[name] = assembled.html;
    fs.writeFileSync(path.join(dir, name + '.html'), assembled.html);
    // Sendable output retains real unsubscribe tags and resolves assets identically.
    fs.writeFileSync(path.join(dir, name + '-production.html'), render.assemble(campaign,
      { assetsBase: ASSET_BASE, production: true, shell: 'production' }).html);
  }
  if (process.argv.includes('--assemble-only')) {
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
    console.log('Assembled and validated; browser checks NOT RUN. Output: ' + dir);
    return;
  }
  if (!process.env.CHROMIUM_PATH) throw new Error('Set CHROMIUM_PATH to your Chromium executable.');
  let browser;
  try {
    browser = await require('puppeteer').launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    for (const [name, html] of Object.entries(htmlByName)) {
      for (const width of [600, 390]) for (const imagesOff of [false, true]) for (const clientMode of ['light', 'dark']) {
        const page = await browser.newPage();
        const deniedRequests = [], stubbedImages = [], abortedImages = [];
        try {
          await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
          await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: clientMode }]);
          await page.setRequestInterception(true);
          page.on('request', async req => {
            try {
              if (imagesOff && req.resourceType() === 'image') { abortedImages.push(req.url()); return await req.abort(); }
              if (req.url().startsWith('data:')) return await req.continue();
              const file = localResource(req.url());
              if (file) {
                stubbedImages.push({ url: req.url(), file: path.relative(ROOT, file) });
                return await req.respond({ status: 200, contentType: file.endsWith('.png') ? 'image/png' : 'image/jpeg', body: fs.readFileSync(file) });
              }
              deniedRequests.push(req.url());
              await req.abort();
            } catch (err) { deniedRequests.push(req.url() + ': ' + err.message); }
          });
          await page.setContent(html, { waitUntil: 'networkidle0' });
          await page.evaluate(() => document.fonts.ready);
          const audit = await page.evaluate(auditPage);
          const filename = `${name}-${width}${imagesOff ? '-images-off' : ''}-${clientMode}.png`;
          await page.screenshot({ path: path.join(dir, filename), fullPage: true });
          const expectedCaps = name === 'dark-test-caps' ? ['AFTER DARK', 'BLACK FRIDAY IS ABOUT TO BLOOM'] : [];
          const missingCaps = expectedCaps.filter(text => !audit.caps.some(c => c.text === text && c.transform === 'none' && c.font.startsWith('Lust')));
          const failed = !!(audit.blueText.length || audit.nonNoirBackgrounds.length || deniedRequests.length || missingCaps.length
            || (!imagesOff && audit.brokenImages.length) || audit.documentWidth > width || audit.containerWidth > width);
          report.runs.push({ name, width, imagesOff, clientMode, filename, ...audit, missingCaps, deniedRequests, stubbedImages,
            abortedImages, expectedBrokenImages: imagesOff, failed });
        } finally { await page.close(); }
      }
    }
  } finally {
    if (browser) await browser.close();
    report.failed = report.runs.some(r => r.failed);
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  }
  if (report.failed) throw new Error('S7 visual audit failed; see ' + path.join(dir, 'report.json'));
  console.log('S7 offline visual audit passed: ' + report.runs.length + ' PNGs. Output: ' + dir);
}
if (require.main === module) main().catch(err => { console.error(err.stack); process.exitCode = 1; });
module.exports = { localResource, auditPage };

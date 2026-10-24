#!/usr/bin/env node
'use strict';
// B3 Sunday note: real source copy/photos, with the new hero-a font lever.
const fs = require('node:fs');
const path = require('node:path');
const render = require('../lib/render');
const { buildSchema } = require('../lib/parseTemplates');
const { validateCampaign } = require('../lib/validate');
const SOURCE = '/workspace/email-3x-week/month-2026-11/build/B3';
function b3Campaign(source = SOURCE) {
  const campaign = JSON.parse(fs.readFileSync(path.join(source, 'design-payload.json'))).campaign;
  const hero = campaign.blocks.find(b => b.component === 'heroes/hero-a');
  hero.tokens.HEADLINE_FONT = 'lust';
  hero.tokens.HEADLINE = 'The Christmas table, done.';
  return campaign;
}
async function main() {
  const dir = process.env.EB212S7_RENDER_DIR;
  if (!dir) throw new Error('Set EB212S7_RENDER_DIR.');
  fs.mkdirSync(dir, { recursive: true });
  const campaign = b3Campaign(process.env.EB212S7_B3_SOURCE || SOURCE);
  const validation = validateCampaign(campaign, buildSchema(render.DS));
  const assembled = render.assemble(campaign);
  if (!validation.ok || validation.warningCount || assembled.unfilled.length) throw new Error(JSON.stringify({ validation, unfilled: assembled.unfilled }));
  fs.writeFileSync(path.join(dir, 'b3-sunday.json'), JSON.stringify(campaign, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'b3-sunday.html'), assembled.html);
  fs.writeFileSync(path.join(dir, 'b3-sunday-production.html'), render.assemble(campaign, { production: true, shell: 'production' }).html);
  const report = { validation, runs: [], browserRun: !process.argv.includes('--assemble-only') };
  if (!report.browserRun) {
    fs.writeFileSync(path.join(dir, 'b3-report.json'), JSON.stringify(report, null, 2));
    return;
  }
  let browser;
  try {
    browser = await require('puppeteer').launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/google/chrome/chrome', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    for (const width of [600, 390]) for (const imagesOff of [false, true]) {
      const page = await browser.newPage();
      const failedRequests = [];
      try {
        await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
        await page.setRequestInterception(true);
        page.on('request', async req => {
          if (imagesOff && req.resourceType() === 'image') return req.abort();
          const url = new URL(req.url());
          if (url.origin === 'https://eb212s7.invalid' && url.pathname.startsWith('/design-system/assets/')) {
            const file = path.resolve(render.DS, 'assets', path.basename(url.pathname));
            if (fs.existsSync(file)) return req.respond({ status: 200, contentType: 'image/png', body: fs.readFileSync(file) });
          }
          return req.continue();
        });
        page.on('requestfailed', req => { if (!imagesOff || req.resourceType() !== 'image') failedRequests.push(req.url()); });
        const html = render.assemble(campaign, { assetsBase: 'https://eb212s7.invalid/design-system/assets' }).html;
        await page.setContent(html, { waitUntil: 'networkidle0' });
        await page.evaluate(() => document.fonts.ready);
        const audit = await page.evaluate(() => {
          const h = document.querySelector('[data-eb-headline-font]'), css = getComputedStyle(h);
          return { text: h.textContent, font: css.fontFamily, transform: css.textTransform,
            overflow: document.documentElement.scrollWidth > innerWidth,
            brokenImages: [...document.images].filter(i => !i.complete || !i.naturalWidth).map(i => i.src) };
        });
        const filename = `b3-sunday-${width}${imagesOff ? '-images-off' : ''}.png`;
        await page.screenshot({ path: path.join(dir, filename), fullPage: true });
        const failed = audit.text !== 'The Christmas table, done.' || !audit.font.startsWith('Lust') || audit.transform !== 'none' || audit.overflow || failedRequests.length > 0 || (!imagesOff && audit.brokenImages.length > 0);
        report.runs.push({ width, imagesOff, filename, ...audit, failedRequests, failed });
      } finally { await page.close(); }
    }
  } catch (err) {
    report.error = err.message;
    throw err;
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(dir, 'b3-report.json'), JSON.stringify(report, null, 2));
  }
  if (report.runs.some(r => r.failed)) throw new Error('B3 visual audit failed; see b3-report.json.');
}
if (require.main === module) main().catch(err => { console.error(err.stack); process.exitCode = 1; });
module.exports = { b3Campaign };

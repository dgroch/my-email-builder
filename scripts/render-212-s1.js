#!/usr/bin/env node
'use strict';
// Offline visual/geometry proof. No server or production service is used.
// CHROMIUM_PATH=/path/to/chromium EB212_RENDER_DIR=/tmp/eb212 node scripts/render-212-s1.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('url');
const puppeteer = require('puppeteer');

async function main() {
  assert.ok(process.env.CHROMIUM_PATH, 'Set CHROMIUM_PATH to the Chromium executable');
  assert.ok(process.env.EB212_RENDER_DIR, 'Set EB212_RENDER_DIR to the output directory');
  const output = path.resolve(process.env.EB212_RENDER_DIR);
  fs.mkdirSync(output, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eb212-render-'));
  process.env.DATA_DIR = scratch;
  // Isolate from any configured database/remote stores. All input is local and synthetic.
  delete process.env.DATABASE_URL;
  delete process.env.NOTION_TOKEN;
  const render = require('../lib/render');
  const two = { REGION_1: 'MEL', CUTOFF_1: 'Order by 1pm Thursday', REGION_2: 'SYD', CUTOFF_2: 'Order by 1pm Wednesday', CUTOFF_NOTE: 'Delivery times vary by region.' };
  const cases = { '2-slot': two, '3-slot': { ...two, REGION_3: 'BNE', CUTOFF_3: 'Order by 1pm Tuesday' } };
  let browser;
  const measurements = [];
  const failures = [];
  try {
    browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-background-networking'] });
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (request.resourceType() === 'image') {
        return request.respond({ status: 200, contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });
      }
      if (request.url().startsWith('data:') || request.url().startsWith('file:') || request.url() === 'about:blank') return request.continue();
      // No HTTP(S), including CDN fonts, analytics, or accidental external references.
      return request.abort('blockedbyclient');
    });
    for (const [name, tokens] of Object.entries(cases)) {
      const campaign = { campaignName: '#212 S1 delivery cutoffs', bodyBg: '#ffffff',
        blocks: [{ component: 'sections/delivery-cutoffs', tokens }] };
      const { html, unfilled } = render.assemble(campaign, {
        assetsBase: pathToFileURL(path.join(render.DS, 'assets')).href, markBlocks: true,
      });
      assert.deepEqual(unfilled, []);
      fs.writeFileSync(path.join(output, `${name}.html`), html);
      for (const width of [600, 390]) {
        await page.setViewport({ width, height: 800, deviceScaleFactor: 1 });
        await page.setContent(html, { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);
        const geometry = await page.evaluate(() => {
          const rect = element => {
            const r = element.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
          };
          const cells = [...document.querySelectorAll('.cc')];
          return { documentWidth: document.documentElement.scrollWidth,
            container: rect(cells[0].closest('table')), columns: cells.map(rect),
            displays: cells.map(c => getComputedStyle(c).display) };
        });
        const row = { name, viewport: width, ...geometry, errors: [] };
        const check = (condition, message) => { if (!condition) row.errors.push(message); };
        check(geometry.columns.length === (name === '3-slot' ? 3 : 2), 'Unexpected column count');
        check(geometry.documentWidth <= width, 'Document overflows viewport');
        const columns = geometry.columns;
        if (width === 390) {
          for (let i = 0; i < columns.length; i++) {
            check(Math.abs(columns[i].width - geometry.container.width) <= 1, `Column ${i + 1} does not fill mobile row`);
            check(Math.abs(columns[i].x - columns[0].x) <= 1, `Column ${i + 1} is not aligned`);
            if (i) check(columns[i].y >= columns[i - 1].bottom - 1, `Column ${i + 1} overlaps previous row`);
          }
        } else if (name === '3-slot') {
          check(Math.abs(geometry.container.width - 504) <= 1, 'Desktop content width should be 504px');
          for (let i = 0; i < columns.length; i++) {
            check(Math.abs(columns[i].width - 168) <= 1, `Column ${i + 1} should be 168px`);
            check(Math.abs(columns[i].y - columns[0].y) <= 1, `Column ${i + 1} should share desktop row`);
            if (i) check(Math.abs(columns[i].x - columns[i - 1].right) <= 1, 'Desktop columns should be adjacent');
          }
        }
        // The unchanged 2-slot version stacks at 600px due to the existing inclusive breakpoint.
        await page.screenshot({ path: path.join(output, `${name}-${width}.png`), fullPage: true });
        measurements.push(row);
        failures.push(...row.errors.map(error => `${name}/${width}: ${error}`));
      }
    }
    fs.writeFileSync(path.join(output, 'measurements.json'), JSON.stringify({ measurements, failures }, null, 2) + '\n');
    assert.deepEqual(failures, [], 'Geometry checks failed; see measurements.json');
    console.log(`Wrote four PNGs, two HTML files and measurements.json to ${output}`);
  } finally {
    try { if (browser) await browser.close(); }
    finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

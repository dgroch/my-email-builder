'use strict';
// Offline visual check. Baseline HTML must have been captured before editing.
// Uses the same local image fixture for before/after, intercepts every request, and
// never contacts a CDN or production service. One Chromium instance, closed in finally.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const sharp = require('sharp');
const render = require('../lib/render');
const OUT = process.env.EB207_RENDER_DIR || path.join(__dirname, '../render-out/eb207-p1');
const localImage = fs.readFileSync(path.join(__dirname, '../test/fixtures/campaign-assets/placeholder-hero.jpg'));

async function main() {
  for (const name of ['link', 'hero', 'footer']) {
    const campaign = JSON.parse(fs.readFileSync(path.join(OUT, name + '-campaign.json')));
    fs.writeFileSync(path.join(OUT, name + '-after.html'), render.assemble(campaign).html);
  }
  const browser = await require('puppeteer').launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });
  const report = { width: 600, assets: 'Controlled local placeholder-hero.jpg; no network. Not original CDN artwork.', captures: {}, comparisons: {} };
  try {
    for (const name of ['link', 'hero', 'footer']) {
      for (const off of name === 'link' ? [false] : [true, false]) {
        for (const phase of ['before', 'after']) {
          const stem = name === 'link' ? `link-${phase}` : `${name}-images-${off ? 'off' : 'on'}-${phase}`;
          const html = fs.readFileSync(path.join(OUT, `${name}-${phase}.html`), 'utf8');
          fs.writeFileSync(path.join(OUT, stem + '.html'), html);
          const page = await browser.newPage();
          try {
            await page.setViewport({ width: 600, height: 800, deviceScaleFactor: 1 });
            await page.setRequestInterception(true);
            page.on('request', request => {
              if (request.resourceType() === 'image') return off ? request.abort() : request.respond({ contentType: 'image/jpeg', body: localImage });
              if (request.url().startsWith('data:')) return request.continue();
              return request.abort();
            });
            await page.setContent(html, { waitUntil: 'load' });
            await page.evaluate(() => document.fonts.ready);
            report.captures[stem] = await page.evaluate(() => ({
              documentHeight: document.documentElement.scrollHeight,
              images: [...document.images].map(img => {
                const r = img.getBoundingClientRect(), wrapper = getComputedStyle(img.parentElement);
                return { alt: img.alt, x: r.x, y: r.y, width: r.width, height: r.height,
                  loaded: img.complete && img.naturalWidth > 0,
                  wrapperFontSize: wrapper.fontSize, wrapperColour: wrapper.color, wrapperLineHeight: wrapper.lineHeight };
              }),
            }));
            await page.screenshot({ path: path.join(OUT, stem + '.png'), fullPage: true });
          } finally { await page.close(); }
        }
      }
    }
    for (const name of ['hero', 'footer']) {
      const before = `${name}-images-on-before`, after = `${name}-images-on-after`;
      const a = await sharp(path.join(OUT, before + '.png')).raw().toBuffer({ resolveWithObject: true });
      const b = await sharp(path.join(OUT, after + '.png')).raw().toBuffer({ resolveWithObject: true });
      const geometry = capture => ({ height: capture.documentHeight, images: capture.images.map(({ x, y, width, height }) => ({ x, y, width, height })) });
      const pixelsIdentical = a.info.width === b.info.width && a.info.height === b.info.height && a.data.equals(b.data);
      report.comparisons[name] = { pixelsIdentical, geometryIdentical: JSON.stringify(geometry(report.captures[before])) === JSON.stringify(geometry(report.captures[after])) };
      assert.ok(report.captures[after].images.every(img => img.loaded), `${name}: all images loaded`);
      assert.ok(pixelsIdentical, `${name}: images-on pixels changed`);
      assert.deepEqual(geometry(report.captures[before]), geometry(report.captures[after]));
    }
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(OUT, 'visual-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });

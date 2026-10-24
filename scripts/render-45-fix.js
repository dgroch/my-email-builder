'use strict';
// Offline visual proof from the final HTML captured by test/helpers/45-assembly.js.
// Run prove-45-revert.js first. No external requests; one browser, closed in finally.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const sharp = require('sharp');
const source = path.join(__dirname, '../render-out/eb45-fix');
const out = process.env.EB45_RENDER_DIR || source;
const artwork = fs.readFileSync(path.join(__dirname, '../test/fixtures/campaign-assets/placeholder-hero.jpg'));
async function main() {
  fs.mkdirSync(out, { recursive: true });
  let browser;
  const report = { assets: 'All images served from controlled local placeholder-hero.jpg, fonts blocked. No network. Chromium does not execute Outlook VML.', captures: {}, comparisons: {} };
  try {
    browser = await require('puppeteer').launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/google-chrome', headless: true, pipe: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'], dumpio: true });
    for (const mode of ['direct', 'sliced', 'gif', 'columns', 'fallback']) for (const width of [600, 390]) {
      for (const [phase, off] of [['before', false], ['after', false], ['after', true]]) {
        const stem = `${mode}-${width}-images-${off ? 'off' : 'on'}-${phase}`;
        const html = fs.readFileSync(path.join(source, phase, mode + '.html'), 'utf8');
        const page = await browser.newPage();
        try {
          await page.setViewport({ width, height: 800, deviceScaleFactor: 1 });
          await page.setRequestInterception(true);
          page.on('request', req => {
            if (req.resourceType() === 'image') return off ? req.abort() : req.respond({ contentType: 'image/jpeg', body: artwork });
            return req.abort();
          });
          await page.setContent(html, { waitUntil: 'load' });
          await page.evaluate(() => document.fonts.ready);
          report.captures[stem] = await page.evaluate(() => ({
            height: document.documentElement.scrollHeight,
            images: [...document.images].map(img => {
              const r = img.getBoundingClientRect(), s = getComputedStyle(img);
              return { alt: img.alt, loaded: img.complete && img.naturalWidth > 0, x: r.x, y: r.y, width: r.width, height: r.height,
                fontSize: s.fontSize, lineHeight: s.lineHeight, color: s.color, fontFamily: s.fontFamily };
            }),
          }));
          const images = report.captures[stem].images;
          assert.ok(images.length);
          assert.ok(images.every(i => i.loaded === !off), `${stem}: image loading must match requested state`);
          if (off) for (const img of images) {
            assert.equal(img.fontSize, '14px'); assert.ok(img.lineHeight === 'normal' || (img.lineHeight.endsWith('px') && img.fontSize.endsWith('px') && parseFloat(img.lineHeight) >= parseFloat(img.fontSize)), `${stem}: image line-height must be normal or a px value at least the px font-size`);
            assert.equal(img.color, 'rgb(68, 68, 68)'); assert.match(img.fontFamily, /NeuzeitGro/);
            assert.ok(img.alt); assert.ok(img.height >= 14, `${stem}: alt must have a visible box`);
          }
          await page.screenshot({ path: path.join(out, stem + '.png'), fullPage: true });
        } finally { await page.close(); }
      }
      const before = `${mode}-${width}-images-on-before`, after = `${mode}-${width}-images-on-after`;
      const a = await sharp(path.join(out, before + '.png')).raw().toBuffer({ resolveWithObject: true });
      const b = await sharp(path.join(out, after + '.png')).raw().toBuffer({ resolveWithObject: true });
      const geometry = c => ({ height: c.height, images: c.images.map(({x,y,width,height}) => ({x,y,width,height})) });
      const pixelsIdentical = a.info.width === b.info.width && a.info.height === b.info.height && a.data.equals(b.data);
      const geometryIdentical = JSON.stringify(geometry(report.captures[before])) === JSON.stringify(geometry(report.captures[after]));
      report.comparisons[`${mode}-${width}`] = { pixelsIdentical, geometryIdentical };
      assert.ok(pixelsIdentical, `${mode} ${width}: images-on pixels changed`);
      assert.ok(geometryIdentical, `${mode} ${width}: geometry changed`);
    }
    report.passed = true;
  } catch (e) { report.error = e.stack; throw e; }
  finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(out, 'visual-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });

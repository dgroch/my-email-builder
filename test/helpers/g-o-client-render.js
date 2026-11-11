'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Remove complete declarations, including inline and stylesheet positioning.
function gmailSimulation(html, noBackgrounds = false) {
  html = html.replace(/(?<![\w-])(?:position|top|right|bottom|left|z-index)\s*:[^;"'{}]*;?/gim, '');
  if (noBackgrounds) html = html.replace(/(^|[;{\s"'])(?:background-image\s*:[^;"{}]*(?:"[^";]*"[^;"{}]*)*|background\s*:[^;"{}]*url\([^;{}]*?)\s*;/gim, '$1');
  return html;
}
async function measure(page, html, width, options = {}) {
  await page.setViewport({ width, height: 800, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const result = await page.evaluate(() => {
    const cite = [...document.querySelectorAll('cite')].find(e => e.textContent.trim() === 'Joseph');
    const td = cite.closest('td');
    const rect = td.getBoundingClientRect(), css = getComputedStyle(td);
    return { height: rect.height, faceImages: td.querySelectorAll('img').length,
      backgroundImage: css.backgroundImage, backgroundRepeat: css.backgroundRepeat, backgroundPosition: css.backgroundPosition,
      backgroundSize: css.backgroundSize, backgroundColor: css.backgroundColor,
      clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  });
  if (options.screenshot) await page.screenshot({ path: options.screenshot, fullPage: true });
  if (options.crop) await page.screenshot({ path: options.crop, clip: result.clip });
  return result;
}
function localFace(html) {
  const data = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '../../design-system/assets/Face2_Black.png')).toString('base64');
  const fonts = fs.readFileSync(path.join(__dirname, '../../design-system/shell/shell-preview.html'), 'utf8').match(/@font-face\{[^}]+\}/g).join('\n');
  html = html.replace(/@font-face\{[^}]+\}/g, '').replace('</head>', '<style>' + fonts + '</style></head>');
  return html.replace(/https:\/\/cdn\.example\.com\/Face2_Black\.png/g, data);
}
module.exports = { gmailSimulation, measure, localFace };

'use strict';
// Default: exact offline harness HTML with placeholder slices.
// --real-assets: real production rasterisation; API writes remain intercepted.
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { capturePush } = require('../test/helpers/g-o-assembly');
const { Parser } = require('htmlparser2');

async function realAssets(outdir) {
  const output = path.resolve(outdir);
  fs.mkdirSync(path.join(output, 'slices'), { recursive: true });
  fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
  const resources = new Map();
  async function resource(url) {
    if (resources.has(url)) return resources.get(url);
    const parsed = new URL(url);
    let buffer;
    if (parsed.origin === 'https://cdn.example.com') {
      const name = path.basename(parsed.pathname);
      if (parsed.pathname !== '/' + name) throw Error('Unexpected design asset path');
      buffer = fs.readFileSync(path.join(__dirname, '../design-system/assets', name));
    } else {
      if (parsed.protocol !== 'https:' || !['cdn.klaviyomail.com', 'figandbloom.com', 'www.figandbloom.com', 'cdn.shopify.com', 'd3k81ch9hvuctc.cloudfront.net'].includes(parsed.hostname)) {
        throw Error(`Public asset host not allowed: ${parsed.hostname}`);
      }
      // Plain public GET only. No auth, redirects, provider API, or browser network.
      const result = await execFile('curl', ['--fail', '--silent', '--show-error', '--proto', '=https', '--max-time', '90', url], { encoding: 'buffer', maxBuffer: 30 * 1024 * 1024 });
      buffer = result.stdout;
    }
    const ext = path.extname(parsed.pathname).slice(1).toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', woff2: 'font/woff2', ttf: 'font/ttf' }[ext];
    if (!mime || !buffer.length) throw Error(`Invalid asset: ${parsed.pathname}`);
    if (mime.startsWith('image/')) await require('sharp')(buffer).metadata();
    const local = `assets/${resources.size + 1}.${ext}`;
    fs.writeFileSync(path.join(output, local), buffer);
    const entry = { local, data: `data:${mime};base64,${buffer.toString('base64')}` };
    resources.set(url, entry);
    return entry;
  }
  async function localize(html, inline = false) {
    const urls = new Set();
    new Parser({ onopentag(name, attrs) {
      if (name === 'img' && /^https:\/\//.test(attrs.src || '')) urls.add(attrs.src);
      if (attrs.background && /^https:\/\//.test(attrs.background)) urls.add(attrs.background);
    } }).end(html);
    for (const match of html.matchAll(/url\(\s*['"]?(https:\/\/[^'"\s)]+)['"]?\s*\)/g)) urls.add(match[1]);
    for (const url of urls) {
      const entry = await resource(url);
      html = html.split(url).join(inline ? entry.data : entry.local);
    }
    return html;
  }
  const result = await capturePush(undefined, { realAssets: true, localize });
  if (result.response.status !== 200 || !result.html) throw Error(JSON.stringify(result.response));
  fs.writeFileSync(path.join(output, 'send8.pushed.html'), result.html);
  let html = result.html;
  result.uploads.forEach((upload, index) => {
    const local = `slices/${index + 1}.${upload.ext}`;
    fs.writeFileSync(path.join(output, local), upload.buffer);
    html = html.split(upload.url).join(local);
  });
  html = await localize(html);
  fs.writeFileSync(path.join(output, 'send8.html'), html);
  fs.writeFileSync(path.join(output, 'assets.json'), JSON.stringify([...resources].map(([url, entry]) => ({ url, local: entry.local })), null, 2));
  const browser = await require('puppeteer').launch({ headless: 'new', executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files'] });
  try {
    for (const width of [600, 390]) {
      const page = await browser.newPage();
      try {
        await page.setViewport({ width, height: 800, deviceScaleFactor: 1 });
        await page.setRequestInterception(true);
        const unexpected = [];
        page.on('request', request => {
          if (request.url().startsWith('file://' + output + '/') || request.url().startsWith('data:')) request.continue();
          else { unexpected.push(request.url()); request.abort(); }
        });
        await page.goto('file://' + path.join(output, 'send8.html'), { waitUntil: 'networkidle0' });
        await page.evaluate(() => document.fonts.ready);
        const broken = await page.evaluate(() => [...document.images].filter(img => !img.complete || !img.naturalWidth).map(img => img.getAttribute('src')));
        if (unexpected.length || broken.length) throw Error(JSON.stringify({ unexpected, broken }));
        await page.screenshot({ path: path.join(output, `send8-${width}.png`), fullPage: true });
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
  console.log(`${output}: ${result.uploads.length} real slices, ${resources.size} bundled resources; 600px and 390px screenshots; zero provider requests`);
}
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--real-assets' && args.length === 2) return realAssets(args[1]);
  if (args.length !== 1 || args[0].startsWith('--')) throw Error('Usage: node scripts/g-o-render-send8.js /path/send8.html | --real-assets <outdir>');
  const { html, response } = await capturePush();
  if (response.status !== 200 || !html) throw Error(JSON.stringify(response));
  const output = path.resolve(args[0]);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, html);
  console.log(output);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

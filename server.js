'use strict';
// server.js — zero-dependency HTTP server for the Fig & Bloom email token editor.
// Serves the editor UI, exposes the auto-generated token schema, assembles live
// previews, and rasterises production-accurate PNGs via Puppeteer.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildSchema } = require('./lib/parseTemplates');
const render = require('./lib/render');

const PORT = process.env.PORT || 4321;
const ROOT = __dirname;
const DS = render.DS;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.otf': 'font/otf',
};

function send(res, code, body, headers = {}) { res.writeHead(code, headers); res.end(body); }
function json(res, code, obj) { send(res, code, JSON.stringify(obj), { 'Content-Type': MIME['.json'] }); }

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return send(res, 404, 'Not found');
  const ext = path.extname(filePath).toLowerCase();
  send(res, 200, fs.readFileSync(filePath), { 'Content-Type': MIME[ext] || 'application/octet-stream' });
}

// Confine a served path to a base directory (no traversal).
function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, decodeURIComponent(rel)));
  return p.startsWith(base) ? p : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''; req.on('data', c => { data += c; if (data.length > 25e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveFile(res, path.join(ROOT, 'public', 'index.html'));
    if (req.method === 'GET' && (p === '/app.js' || p === '/style.css')) return serveFile(res, path.join(ROOT, 'public', p.slice(1)));

    // serve bundled design-system assets (for live-preview of designed blocks' {{ASSETS_BASE}})
    if (req.method === 'GET' && p.startsWith('/design-system/')) {
      const fp = safeJoin(DS, p.replace('/design-system/', ''));
      return fp ? serveFile(res, fp) : send(res, 403, 'Forbidden');
    }

    if (req.method === 'GET' && p === '/api/schema') return json(res, 200, buildSchema(DS));

    if (req.method === 'POST' && p === '/api/assemble') {
      const { campaign } = await readBody(req);
      const { html, unfilled } = render.assemble(campaign || {}, { assetsBase: '/design-system/assets' });
      return json(res, 200, { html, unfilled });
    }

    if (req.method === 'POST' && p === '/api/render') {
      const { campaign } = await readBody(req);
      const { html } = render.assemble(campaign || {}, { assetsBase: '{{ASSETS_BASE}}' }); // re-tokenise for file:// swap
      const { buffer, brokenImages, height } = await render.renderToPng(html);
      return json(res, 200, { pngBase64: buffer.toString('base64'), brokenImages, height });
    }

    if (req.method === 'POST' && p === '/api/export') {
      const { campaign } = await readBody(req);
      const { html, unfilled } = render.assemble(campaign || {}, { assetsBase: '{{ASSETS_BASE}}' });
      return json(res, 200, { html, unfilled, campaign });
    }

    send(res, 404, 'Not found');
  } catch (e) {
    json(res, 500, { error: String((e && e.stack) || e) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Fig & Bloom email builder → http://localhost:${PORT}\n`);
});

process.on('SIGINT', async () => { await render.closeBrowser(); process.exit(0); });
process.on('SIGTERM', async () => { await render.closeBrowser(); process.exit(0); });

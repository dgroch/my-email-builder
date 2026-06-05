'use strict';
// server.js — zero-dependency HTTP server for the Fig & Bloom email token editor.
// Serves the editor UI, exposes the auto-generated token schema, assembles live
// previews, and rasterises production-accurate PNGs via Puppeteer.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildSchema } = require('./lib/parseTemplates');
const render = require('./lib/render');
const klaviyo = require('./lib/klaviyo');
const { validateCampaign } = require('./lib/validate');
const examples = require('./lib/examples');
// Pick the designs backend: Notion (durable, survives redeploys) when configured,
// else the local-disk store. Both expose the same list/get/create/update/clone/remove API.
const designs = (process.env.NOTION_TOKEN && process.env.NOTION_DESIGNS_DB)
  ? require('./lib/notionStore')
  : require('./lib/designs');

const PORT = process.env.PORT || 4321;
const ROOT = __dirname;
const DS = render.DS;

// The schema is derived from the (static at runtime) templates + manifest, so cache it.
// Used by /api/schema and by the campaign validator. Restart the server to pick up
// template edits.
let _schema = null;
function schema() { return _schema || (_schema = buildSchema(DS)); }

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

    if (req.method === 'GET' && p === '/api/schema') return json(res, 200, schema());

    if (req.method === 'POST' && p === '/api/assemble') {
      const { campaign, markBlocks } = await readBody(req);
      const { html, unfilled } = render.assemble(campaign || {}, { assetsBase: '/design-system/assets', markBlocks: !!markBlocks });
      // Actionable validation alongside the raw unfilled list (additive — old field kept).
      const validation = validateCampaign(campaign || {}, schema());
      return json(res, 200, { html, unfilled, validation });
    }

    // Structured validation report without rendering, so agents can self-correct a campaign
    // (unknown/bare component names → group-prefixed suggestion; casing violations; unfilled
    // tokens) before assembling or saving.
    if (req.method === 'POST' && p === '/api/validate') {
      const { campaign } = await readBody(req);
      return json(res, 200, validateCampaign(campaign || {}, schema()));
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

    // Rasterise every block to its own PNG ("slices"). Also returns each block's default
    // click-through URL (from its tokens) and whether it's the live-HTML unsubscribe block,
    // so the UI can show/override per-block links before pushing the sliced draft.
    if (req.method === 'POST' && p === '/api/render-slices') {
      const { campaign } = await readBody(req);
      const { html } = render.assemble(campaign || {}, { assetsBase: '{{ASSETS_BASE}}', markBlocks: true });
      const { slices, brokenImages } = await render.renderSlices(html);
      const meta = render.assembleBlocks(campaign || {});
      const byIndex = {};
      for (const b of meta.blocks) byIndex[b.index] = b;
      return json(res, 200, {
        brokenImages,
        slices: slices.map(s => {
          const b = byIndex[s.index] || {};
          return {
            index: s.index, component: s.component, width: s.width, height: s.height,
            pngBase64: s.buffer.toString('base64'),
            link: render.deriveLink(b.tokens),
            keepHtml: render.isUnsubscribeBlock(s.component, b.html),
          };
        }),
      });
    }

    // List the account's lists + segments so the UI can offer an audience picker
    // (users choose by name; we send the real ID to Klaviyo).
    if (req.method === 'GET' && p === '/api/klaviyo-audiences') {
      const apiKey = process.env.KLAVIYO_API_KEY;
      if (!apiKey) return json(res, 400, { error: 'KLAVIYO_API_KEY is not set on the server. Add it as an environment variable and restart.' });
      try {
        return json(res, 200, await klaviyo.listAudiences(apiKey));
      } catch (e) {
        return json(res, 502, { error: String((e && e.message) || e) });
      }
    }

    // Create a *draft* campaign in Klaviyo, built from per-block image slices so each block
    // becomes its own image with its own link (never one giant PNG). The footer stays live
    // HTML so its {% unsubscribe %} tag works. `links` is an optional {index: url} override.
    if (req.method === 'POST' && p === '/api/klaviyo-draft') {
      const { campaign, listId, fromEmail, fromLabel, replyToEmail, subject, previewText, links, designId } = await readBody(req);
      const apiKey = process.env.KLAVIYO_API_KEY;
      if (!apiKey) return json(res, 400, { error: 'KLAVIYO_API_KEY is not set on the server. Add it as an environment variable and restart.' });
      // Fall back to the lines persisted on the saved design (designMeta subjectLine/previewText)
      // when the request body doesn't carry them — the subject/preview live outside the campaign
      // body, so a saved design is their source of truth.
      let subjectLine = subject, preview = previewText;
      if ((!subjectLine || !preview) && designId) {
        try {
          const d = await designs.get(designId);
          if (d) {
            if (!subjectLine) subjectLine = d.subjectLine || '';
            if (!preview) preview = d.previewText || '';
          }
        } catch (_) { /* design lookup is best-effort — fall through with whatever we have */ }
      }
      const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
      const assetsBase = `${proto}://${req.headers.host}/design-system/assets`;
      const linkOverride = links || {};
      try {
        // 1. Rasterise each block from the production-shelled, block-marked HTML.
        const { html: markedHtml } = render.assemble(campaign || {}, { assetsBase, production: true, markBlocks: true });
        const { slices } = await render.renderSlices(markedHtml);
        const sliceByIndex = {};
        for (const s of slices) sliceByIndex[s.index] = s;

        // 2. Per block, either keep live HTML (footer/unsubscribe) or upload its PNG and
        //    emit a linked image row. Each non-footer block = its own image with its own URL.
        const meta = render.assembleBlocks(campaign || {}, { assetsBase });
        const rows = [];
        for (const b of meta.blocks) {
          if (render.isUnsubscribeBlock(b.component, b.html)) { rows.push(b.html); continue; }
          const slice = sliceByIndex[b.index];
          if (!slice) { rows.push(b.html); continue; } // fallback: live HTML if no slice
          const imageUrl = await klaviyo.uploadImage(apiKey, slice.buffer, `${String(b.index + 1).padStart(2, '0')}-${b.component.replace(/[\/]+/g, '-')}`);
          const href = (Object.prototype.hasOwnProperty.call(linkOverride, b.index) ? linkOverride[b.index] : render.deriveLink(b.tokens)) || '';
          rows.push(klaviyo.imageRow(imageUrl, { href, alt: b.tokens.HEADLINE || b.component }));
        }
        const fullHtml = render.wrapProductionShell(rows.join('\n'), { campaignName: meta.campaignName, bodyBg: meta.bodyBg, assetsBase });

        // 3. Create the draft (template → campaign → assign template).
        const result = await klaviyo.createDraftCampaign({
          apiKey, listId, fromEmail, fromLabel, replyToEmail, subject: subjectLine, previewText: preview,
          name: meta.campaignName, html: fullHtml,
        });
        return json(res, 200, { ...result, sliceCount: slices.length });
      } catch (e) {
        return json(res, 502, { error: String((e && e.message) || e) });
      }
    }

    // Approved exemplars: designs flagged isExample (plus committed seeds), each with its
    // full campaign + metadata. Optional ?objective= filters by objective taxonomy id.
    if (req.method === 'GET' && p === '/api/examples') {
      const objective = u.searchParams.get('objective') || undefined;
      return json(res, 200, { examples: await examples.listExamples(designs, { objective }) });
    }

    // ── persisted designs (save / reopen / clone / delete) ───────────────────────
    // Store calls are awaited so either backend works (disk = sync, Notion = async).
    if (req.method === 'GET' && p === '/api/designs') return json(res, 200, { designs: await designs.list() });

    if (req.method === 'POST' && p === '/api/designs') {
      // Pass the whole body so design metadata (isExample, objective, approvalStatus, …) is
      // persisted alongside name + campaign.
      return json(res, 200, await designs.create(await readBody(req)));
    }

    // /api/designs/:id  and  /api/designs/:id/clone
    if (p.startsWith('/api/designs/')) {
      const rest = p.slice('/api/designs/'.length);
      const [id, action] = rest.split('/');

      if (req.method === 'POST' && action === 'clone') {
        const { name } = await readBody(req);
        const d = await designs.clone(id, name);
        return d ? json(res, 200, d) : json(res, 404, { error: 'Design not found.' });
      }
      if (!action) {
        if (req.method === 'GET') { const d = await designs.get(id); return d ? json(res, 200, d) : json(res, 404, { error: 'Design not found.' }); }
        if (req.method === 'PUT') { const d = await designs.update(id, await readBody(req)); return d ? json(res, 200, d) : json(res, 404, { error: 'Design not found.' }); }
        if (req.method === 'DELETE') return (await designs.remove(id)) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Design not found.' });
      }
    }

    send(res, 404, 'Not found');
  } catch (e) {
    json(res, 500, { error: String((e && e.stack) || e) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Fig & Bloom email builder → http://localhost:${PORT}`);
  console.log(`  designs store: ${designs.backend === 'notion' ? 'Notion database' : 'local disk (' + designs.DATA_DIR + ')'}\n`);
});

process.on('SIGINT', async () => { await render.closeBrowser(); process.exit(0); });
process.on('SIGTERM', async () => { await render.closeBrowser(); process.exit(0); });

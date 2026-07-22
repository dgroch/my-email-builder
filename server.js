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
const sampleData = require('./lib/sampleData');
const campaignGenerator = require('./lib/campaignGenerator');
const liveContext = require('./lib/liveContext');
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
    if (req.method === 'GET' && (p === '/app.js' || p === '/library.js' || p === '/style.css')) return serveFile(res, path.join(ROOT, 'public', p.slice(1)));

    // serve bundled design-system assets (for live-preview of designed blocks' {{ASSETS_BASE}})
    if (req.method === 'GET' && p.startsWith('/design-system/')) {
      const fp = safeJoin(DS, p.replace('/design-system/', ''));
      return fp ? serveFile(res, fp) : send(res, 403, 'Forbidden');
    }

    if (req.method === 'GET' && p === '/api/schema') return json(res, 200, schema());

    // Interactive component library: every component with a complete set of on-brand sample
    // tokens (so it renders "alive" with zero fields filled) plus its variant axes (palette
    // presets + first enum lever). The browser renders each card via /api/assemble — kept out
    // of this payload because the preview shell embeds fonts as large base64 blobs.
    if (req.method === 'GET' && p === '/api/gallery') {
      const s = schema();
      const components = s.components.map((c) => ({
        name: c.name, group: c.group, designed: !!c.designed, static: !!c.static, draft: !!c.draft,
        sampleTokens: sampleData.sampleTokensFor(c),
        variants: sampleData.variantsFor(c),
      }));
      return json(res, 200, { components });
    }

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

    // Live context for the campaign generator — gathers the current Shopify
    // catalogue, Klaviyo audiences, Notion blog index, and semantic image
    // search results from the asset library (any of which may be unavailable
    // without losing the others). The button calls this when it opens, then
    // passes the result to /api/campaigns/generate. The agent in conversation
    // builds its own richer version.
    //
    // The image search needs a `brief` query — when the button opens the modal
    // the brief is empty, so image search returns no results (the user can
    // re-fetch with the brief via /api/campaigns/generate's server-side gather,
    // or pass liveContext.images[] from a client-side fetch after typing).
    if (req.method === 'GET' && p === '/api/live-context') {
      const forceFresh = u.searchParams.get('fresh') === '1';
      const brief = u.searchParams.get('q') || '';
      try {
        const ctx = await liveContext.gather({ forceFresh, brief });
        return json(res, 200, ctx);
      } catch (e) {
        return json(res, 502, { error: String((e && e.message) || e) });
      }
    }

    // Generate a campaign JSON from a free-form brief (uses the
    // fig-bloom-email-generator skill — pre-loaded system prompt + user template).
    // The response is *not* auto-saved; the UI shows it in the builder for review.
    if (req.method === 'POST' && p === '/api/campaigns/generate') {
      const { brief, audience, save, liveContext: suppliedContext } = await readBody(req);
      // If the caller didn't supply live context, gather it server-side
      // (using the brief as the asset-library search query) so the button
      // works with a single POST.
      let ctx = suppliedContext;
      if (!ctx) {
        try { ctx = await liveContext.gather({ brief }); } catch (_) { ctx = null; }
      }
      try {
        const result = await campaignGenerator.generateValidated({
          brief,
          audience,
          liveContext: ctx,
          validateFn: async (campaign) => validateCampaign(campaign || {}, schema()),
        });
        if (result.needsClarification) {
          return json(res, 200, { needsClarification: result.needsClarification });
        }
        // Optionally save the generated campaign as a new design so the user lands
        // on it directly. Default: don't auto-save — the UI shows the JSON first.
        let design = null;
        if (save && result.campaign) {
          const name = (result.campaign.campaignName && String(result.campaign.campaignName).trim())
            || (brief && String(brief).slice(0, 60).trim())
            || 'Generated campaign';
          const payload = {
            name,
            campaign: result.campaign,
            subjectLine: result.campaign.subjectLine || '',
            previewText: result.campaign.previewText || '',
          };
          if (result.campaign.objective) payload.objective = result.campaign.objective;
          design = await designs.create(payload);
        }
        return json(res, 200, {
          campaign: result.campaign,
          validation: result.validation || null,
          design: design || null,
          liveContext: ctx ? {
            asOf: ctx.asOf,
            contextStatus: ctx.contextStatus,
            productCount: (ctx.products || []).length,
            audienceCount: (ctx.audiences || []).length,
            blogPostCount: (ctx.blogPosts || []).length,
            imageCount: (ctx.images || []).length,
          } : null,
        });
      } catch (e) {
        const code = (e && e.code) || 'GENERATE_FAILED';
        const status = code === 'EMPTY_BRIEF' ? 400 : 502;
        return json(res, status, { error: String((e && e.message) || e), code, raw: e.raw || null });
      }
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
          // Region slices (data-eb-slice) carry their own fixed link/alt — the per-block
          // deriveLink override doesn't apply, so surface the region's own href as the link.
          const isRegion = s.name != null;
          const base = {
            index: s.index, seg: s.seg, segCount: s.segCount, component: s.component,
            kind: s.kind, width: s.width, height: s.height,
            link: isRegion ? (s.href || '') : render.deriveLink(b.tokens),
            keepHtml: render.isUnsubscribeBlock(s.component, b.html),
          };
          if (isRegion) { base.region = true; base.name = s.name; base.alt = s.alt || ''; }
          // GIF segments pass through live (carry the hosted src); PNG segments carry pixels.
          return s.kind === 'gif' ? { ...base, src: s.src } : { ...base, pngBase64: s.buffer.toString('base64') };
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
      const { campaign: bodyCampaign, listId, fromEmail, fromLabel, replyToEmail, subject, previewText, links, designId } = await readBody(req);
      const apiKey = process.env.KLAVIYO_API_KEY;
      if (!apiKey) return json(res, 400, { error: 'KLAVIYO_API_KEY is not set on the server. Add it as an environment variable and restart.' });
      // Resolve the campaign body (blocks) and the subject/preview lines from the saved design
      // when the request doesn't carry them. The UI posts the live `campaign`; API clients
      // typically post only `designId` and expect the server to load the design's blocks
      // (which live under design.campaign, not design.blocks). The subject/preview also live
      // outside the campaign body (designMeta subjectLine/previewText), so a saved design is
      // their source of truth too. Load the design once and use it for both.
      let campaign = bodyCampaign, subjectLine = subject, preview = previewText;
      const needCampaign = !campaign || !Array.isArray(campaign.blocks) || !campaign.blocks.length;
      if (designId && (needCampaign || !subjectLine || !preview)) {
        try {
          const d = await designs.get(designId);
          if (d) {
            if (needCampaign && d.campaign) campaign = d.campaign;
            if (!subjectLine) subjectLine = d.subjectLine || '';
            if (!preview) preview = d.previewText || '';
          }
        } catch (_) { /* design lookup is best-effort — fall through with whatever we have */ }
      }
      // Guard against building a valid-but-blank draft from an empty campaign: with no blocks
      // there is nothing to slice or inject, which is exactly the silent empty-shell failure.
      if (!campaign || !Array.isArray(campaign.blocks) || !campaign.blocks.length) {
        return json(res, 400, { error: 'No campaign blocks to slice. Pass a `campaign` with blocks, or a `designId` whose saved design has blocks.' });
      }
      const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
      const assetsBase = `${proto}://${req.headers.host}/design-system/assets`;
      const linkOverride = links || {};
      try {
        // 1. Rasterise each block from the production-shelled, block-marked HTML.
        const { html: markedHtml } = render.assemble(campaign, { assetsBase, production: true, markBlocks: true });
        const { slices } = await render.renderSlices(markedHtml);

        // 2. Per block, either keep live HTML (footer/unsubscribe) or emit its image rows.
        //    Each block yields one or more ordered segments: a PNG slice is uploaded and linked;
        //    an animated GIF is referenced live at its already-hosted URL so it keeps animating
        //    (rasterising would freeze it to one frame). Each block keeps its own click-through.
        const meta = render.assembleBlocks(campaign, { assetsBase });
        // Blocks declared html_only in the manifest stay LIVE HTML (never sliced), so a
        // multi-link block keeps all its anchors — e.g. blocks/journal-tile's 2–3 per-tile
        // post links. Slicing would flatten the block to one PNG with a single click-through.
        const htmlOnly = (schema().assembly && schema().assembly.html_only_components) || [];
        // Fail loud if the slice stage silently produced nothing for blocks that should have
        // rasterised (e.g. a headless-browser OOM/launch failure on the render instance).
        // Without this, the handler would build an empty template and return 200 — the worst
        // failure mode, since a blank draft can be sent. Blocks that are intentionally live
        // HTML (footer/unsubscribe and html_only components) don't count toward this.
        const sliceableBlocks = meta.blocks.filter(b =>
          !render.isUnsubscribeBlock(b.component, b.html) && !render.isHtmlOnlyComponent(b.component, htmlOnly)).length;
        if (sliceableBlocks > 0 && slices.length === 0) {
          return json(res, 502, { error: `Slicer produced 0 slices for ${sliceableBlocks} sliceable block(s) — the block rasterise stage failed (check the headless-browser/CHROMIUM_PATH on this instance). Refusing to create an empty Klaviyo draft.` });
        }
        const segmentsByIndex = {};
        for (const s of slices) (segmentsByIndex[s.index] = segmentsByIndex[s.index] || []).push(s);
        const rows = [];
        for (const b of meta.blocks) {
          if (render.isUnsubscribeBlock(b.component, b.html) || render.isHtmlOnlyComponent(b.component, htmlOnly)) { rows.push(b.html); continue; }
          const segs = segmentsByIndex[b.index];
          if (!segs || !segs.length) { rows.push(b.html); continue; } // fallback: live HTML if no slice
          const href = (Object.prototype.hasOwnProperty.call(linkOverride, b.index) ? linkOverride[b.index] : render.deriveLink(b.tokens)) || '';
          const alt = b.tokens.HEADLINE || b.component;
          const compBase = b.component.replace(/[\/]+/g, '-');
          for (const s of segs) {
            // A region slice (data-eb-slice) carries its OWN href + alt — so a multi-link block
            // like blocks/journal-tile emits a header slice plus one linked slice per tile, each
            // to its own post URL. The whole slice row is the link (the padding is clickable too).
            const isRegion = s.name != null;
            const rowHref = isRegion ? (s.href || '') : href;
            const rowAlt = isRegion ? (s.alt || '') : alt;
            if (s.kind === 'gif') {
              rows.push(klaviyo.imageRow(s.src, { href: rowHref, alt: rowAlt }));
              continue;
            }
            // Region slices upload as <component>-<region> (journal-tile-header, journal-tile-1 …);
            // other multi-segment slices keep their -N ordinal suffix.
            const suffix = isRegion ? `-${s.name.replace(/^tile-/, '')}` : (s.segCount > 1 ? `-${s.seg + 1}` : '');
            const imageUrl = await klaviyo.uploadImage(apiKey, s.buffer, `${String(b.index + 1).padStart(2, '0')}-${compBase}${suffix}`);
            rows.push(klaviyo.imageRow(imageUrl, { href: rowHref, alt: rowAlt }));
          }
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

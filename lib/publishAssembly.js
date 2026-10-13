"use strict";
const render = require("./render");
const { Parser } = require("htmlparser2");
const images = require("./imageOptimiser");
const {
  freezeArtifactInputs,
  compileArtifact,
  binaryHash,
} = require("./campaignArtifact");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const templateSource = require("./templateSource");
const brandTokens = require("./brandTokens");
async function loadImage(src) {
  if (src.startsWith("/design-system/assets/")) {
    const root = path.resolve(render.DS, "assets");
    const file = path.resolve(root, src.slice("/design-system/assets/".length));
    if (!file.startsWith(root + path.sep)) throw Error("ASSET_PATH");
    return fs.readFileSync(file);
  }
  const u = new URL(src);
  const allowed = (
    process.env.BUILDER_IMAGE_HOSTS ||
    "cdn.shopify.com,images.unsplash.com,figandbloom.com,www.figandbloom.com"
  ).split(",");
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    !allowed.includes(u.hostname)
  )
    throw Error("ASSET_HOST_NOT_REGISTERED");
  const res = await fetch(u, {
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok || !res.body) throw Error("ASSET_UNAVAILABLE");
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > 1048576) throw Error("ASSET_SIZE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Rewrite parsed resource values only; URLs in links, copy, or longer URLs are independent.
function rewriteResources(html, replacements) {
  const edits = [];
  let inStyle = false;
  const escape = (value) =>
    value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const css = (value) =>
    value.replace(
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,
      (original, a, b, c) => {
        const replacement = replacements.get((a || b || c || "").trim());
        return replacement ? 'url("' + replacement + '")' : original;
      },
    );
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        inStyle = name === "style";
        let changed = false;
        for (const key of ["src", "background"]) {
          if (replacements.has(attrs[key])) {
            attrs[key] = replacements.get(attrs[key]);
            changed = true;
          }
        }
        if (attrs.style) {
          const next = css(attrs.style);
          changed ||= next !== attrs.style;
          attrs.style = next;
        }
        if (changed)
          edits.push({
            start: parser.startIndex,
            end: parser.endIndex + 1,
            value:
              "<" +
              name +
              Object.entries(attrs)
                .map(([key, value]) => " " + key + '="' + escape(value) + '"')
                .join("") +
              ">",
          });
      },
      onclosetag(name) {
        if (name === "style") inStyle = false;
      },
      ontext(value) {
        if (!inStyle) return;
        const next = css(value);
        if (next !== value)
          edits.push({
            start: parser.startIndex,
            end: parser.endIndex + 1,
            value: next,
          });
      },
    },
    { decodeEntities: true },
  );
  parser.end(html);
  for (const edit of edits.reverse())
    html = html.slice(0, edit.start) + edit.value + html.slice(edit.end);
  return html;
}

async function freezeSavedDesign(design, options = {}) {
  const resolve = options.resolve || templateSource.resolve,
    brand = options.brand || brandTokens.getBrand();
  const components = [];
  const overrides = {};
  for (const block of design.campaign.blocks) {
    const src = resolve(block.component);
    if (!src) throw new Error("MISSING_COMPONENT");
    overrides[block.component] = src.html;
    if (!components.some((c) => c.name === block.component))
      components.push({
        name: block.component,
        version: String(src.version || "disk-v1"),
        markup: src.html,
      });
  }
  const frozen = freezeArtifactInputs(design, components, brand);
  const opts = {
    templateOverrides: overrides,
    brand: frozen.provenance.brand,
    assetsBase: options.assetsBase || "/design-system/assets",
    production: true,
    markBlocks: true,
  };
  const assembled = render.assemble(frozen.provenance.design.campaign, opts);
  if (assembled.unfilled.length) throw new Error("UNFILLED_TOKENS");
  const meta = render.assembleBlocks(frozen.provenance.design.campaign, opts);
  const htmlOnly = render.htmlOnlyComponents();
  const blocks = meta.blocks.map((b) => ({
    ...b,
    html: render.stripDocComments(b.html),
    footer: b.component === "footer",
    live: render.isHtmlOnlyComponent(b.component, htmlOnly),
  }));
  if (blocks.filter((b) => b.footer).length !== 1 || !blocks.at(-1).footer)
    throw new Error("KNOWN_FINAL_FOOTER_REQUIRED");
  for (const b of blocks)
    if (!b.footer && /{{|{%|\{#/.test(b.html))
      throw new Error("UNSUPPORTED_DYNAMIC_BLOCK_" + b.index);
  const capturedMedia = {};
  const sources = new Set();
  const css = (style) => {
    if (/@import|expression\s*\(|javascript:/i.test(style))
      throw Error("UNSUPPORTED_RENDER_RESOURCE");
    for (const match of style.matchAll(
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,
    )) {
      const source = (match[1] || match[2] || match[3] || "").trim();
      if (!source.startsWith("data:")) sources.add(source);
    }
  };
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (
          [
            "script",
            "iframe",
            "object",
            "embed",
            "svg",
            "math",
            "form",
          ].includes(name) ||
          attrs.srcset ||
          Object.keys(attrs).some((key) => /^on/i.test(key))
        )
          throw Error("UNSUPPORTED_RENDER_RESOURCE");
        for (const key of ["src", "background"])
          if (attrs[key] && !attrs[key].startsWith("data:"))
            sources.add(attrs[key]);
        if (name === "link" && attrs.href)
          throw Error("UNSUPPORTED_RENDER_RESOURCE");
        if (attrs.style) css(attrs.style);
      },
      ontext(text) {
        css(text);
      },
    },
    { decodeEntities: true },
  );
  parser.write(assembled.html);
  parser.end();
  let total = 0;
  const replacements = new Map();
  for (const src of sources) {
    const bytes = await (options.loadImage || loadImage)(
      src.replace(/&amp;/g, "&"),
    );
    total += bytes.length;
    if (total > 1048576) throw Error("CAPTURED_IMAGE_BUDGET");
    const metadata = await sharp(bytes, {
      animated: true,
      limitInputPixels: 40000000,
    }).metadata();
    const mime = {
      png: "image/png",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    }[metadata.format];
    if (!mime) throw Error("CAPTURED_IMAGE_FORMAT");
    const base64 = bytes.toString("base64");
    const reference = "frozen-asset:" + binaryHash(bytes);
    capturedMedia[reference] = { base64, mime };
    replacements.set(src, reference);
  }
  assembled.html = rewriteResources(assembled.html, replacements);
  for (const block of blocks)
    block.html = rewriteResources(block.html, replacements);
  const imageConfig = images.config();
  delete imageConfig.logger;
  return {
    ...frozen,
    capturedMedia,
    rendered: { html: assembled.html, blocks },
    imageConfig,
  };
}
async function renderFrozenArtifact(frozen, signal) {
  const abort = () => {
    void render.closeBrowser();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    // Inflate only for this render. Persist each captured body once, independent of use count.
    const replacements = new Map();
    const mediaByUrl = {};
    for (const [reference, media] of Object.entries(frozen.capturedMedia)) {
      const dataUrl = "data:" + media.mime + ";base64," + media.base64;
      replacements.set(reference, dataUrl);
      mediaByUrl[dataUrl] = media;
    }
    const { slices: raw, brokenImages } = await render.renderSlices(
      rewriteResources(frozen.rendered.html, replacements),
      { scale: frozen.imageConfig.scale, frozenResources: true },
    );
    if (signal?.aborted) throw new Error("RENDER_TIMEOUT");
    if (brokenImages?.length) throw new Error("BROKEN_IMAGES");
    const notUploadedIndexes = new Set(
      frozen.rendered.blocks
        .filter((b) => b.footer || b.live)
        .map((b) => b.index),
    );
    const { slices, report } = await images.optimiseSlices(raw, {
      config: frozen.imageConfig,
      notUploadedIndexes,
    });
    if (report.budget.status === "fail") throw new Error("IMAGE_WEIGHT_BUDGET");
    const rows = [],
      media = [];
    let ordinal = 0;
    async function cell(s, b, width) {
      const buffer =
        s.kind === "gif"
          ? Buffer.from(mediaByUrl[s.src]?.base64 || "", "base64")
          : s.buffer;
      if (!buffer?.length) throw Error("CAPTURED_MEDIA_MISSING_" + b.index);
      const assetId = "asset-" + ++ordinal;
      media.push({ assetId, buffer });
      const href = s.name != null ? s.href : render.deriveLink(b.tokens);
      const alt =
        s.name != null
          ? s.alt
          : render.deriveAlt(b.tokens) ||
            b.html
              .replace(/<[^>]+>/g, " ")
              .replace(/\s+/g, " ")
              .trim();
      return { assetId, width, alt: alt || "", ...(href ? { href } : {}),
        ...(s.bg ? { backgroundColor: s.bg } : {}) };
    }
    for (const b of frozen.rendered.blocks) {
      if (b.footer) {
        rows.push({ kind: "legal_footer" });
        continue;
      }
      if (b.live) {
        if (/\bsrc\s*=/i.test(b.html))
          throw new Error("LIVE_ASSET_CAPTURE_REQUIRED_" + b.index);
        rows.push({
          kind: "live",
          html: b.html,
          text:
            render.deriveAlt(b.tokens) ||
            b.html
              .replace(/<[^>]+>/g, " ")
              .replace(/\s+/g, " ")
              .trim(),
        });
        continue;
      }
      const segs = slices.filter((s) => s.index === b.index);
      if (!segs.length) throw new Error("MISSING_BLOCK_SLICE_" + b.index);
      if (segs[0].layout === "cols") {
        const cells = [];
        for (const s of segs) cells.push(await cell(s, b, s.width));
        rows.push({ kind: "columns", cells });
      } else
        for (const s of segs)
          rows.push({ kind: "image", ...(await cell(s, b, 600)) });
    }
    if (signal?.aborted) throw new Error("RENDER_TIMEOUT");
    return await compileArtifact(frozen, {
      rows,
      media,
      text: frozen.rendered.blocks
        .filter((b) => !b.footer)
        .map((b) =>
          b.html
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim(),
        )
        .filter(Boolean)
        .join("\n\n"),
    });
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
module.exports = { freezeSavedDesign, renderFrozenArtifact };

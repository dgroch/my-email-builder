"use strict";
const { createHash } = require("crypto");
function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  throw new Error("Invalid canonical JSON");
}
const hash = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const binaryHash = (value) => createHash("sha256").update(value).digest("hex");
function selectedDesignHash(design) {
  return hash({
    id: design.id,
    name: design.name || "",
    updatedAt: design.updatedAt,
    subjectLine: design.subjectLine || "",
    previewText: design.previewText || "",
    campaign: design.campaign,
  });
}
function freezeArtifactInputs(design, resolvedComponents, resolvedBrand) {
  const provenance = JSON.parse(
    canonical({ design, components: resolvedComponents, brand: resolvedBrand }),
  );
  if (
    !design.id ||
    !design.updatedAt ||
    !design.campaign ||
    !Array.isArray(design.campaign.blocks) ||
    design.campaign.blocks.length > 100
  )
    throw new Error("Invalid saved design");
  const dynamic = JSON.stringify({
    subject: design.subjectLine,
    preview: design.previewText,
    tokens: design.campaign.blocks.map((b) => b.tokens),
  });
  if (/{{|{%|{%|\{#/.test(dynamic))
    throw new Error("Unsupported dynamic template");
  for (const key of ["subjectLine", "previewText"])
    if (
      typeof design[key] !== "string" ||
      !design[key].trim() ||
      /[\x00-\x1f\x7f]/.test(design[key])
    )
      throw new Error("Missing or invalid " + key);
  return {
    provenance,
    designHash: hash(provenance),
    brandHash: hash(provenance.brand),
    renderVersion: "builder-artifact-v1",
  };
}
async function compileArtifact(frozen, rendered) {
  const sharp = require("sharp");
  const assets = [];
  const media = [];
  let total = 0;
  if (rendered.rows.length > 100 || rendered.media.length > 64)
    throw new Error("Artifact bound exceeded");
  const seen = new Set();
  for (const item of rendered.media) {
    if (seen.has(item.assetId)) throw new Error("Duplicate asset");
    seen.add(item.assetId);
    const buffer = Buffer.from(item.buffer);
    const meta = await sharp(buffer, {
      animated: true,
      limitInputPixels: 40000000,
    }).metadata();
    const mime = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif" }[
      meta.format
    ];
    if (!mime) throw new Error("Unsupported media format");
    total += buffer.length;
    if (total > 1048576) throw new Error("Image weight budget exceeded");
    assets.push({
      id: item.assetId,
      sha256: binaryHash(buffer),
      mime,
      bytes: buffer.length,
      width: meta.width,
      height: meta.pageHeight || meta.height,
    });
    media.push({ assetId: item.assetId, base64: buffer.toString("base64") });
  }
  const rows = JSON.parse(canonical(rendered.rows));
  if (
    rows.filter((r) => r.kind === "legal_footer").length !== 1 ||
    rows.at(-1).kind !== "legal_footer"
  )
    throw new Error("Exactly one final legal footer required");
  for (const row of rows) {
    if (row.kind === "image" || row.kind === "columns")
      for (const cell of row.cells || [row]) {
        if ('backgroundColor' in cell &&
          (typeof cell.backgroundColor !== 'string' || !/^#(?:[a-fA-F0-9]{3}|[a-fA-F0-9]{6})$/.test(cell.backgroundColor)))
          throw new Error('Invalid background colour');
        if (
          !seen.has(cell.assetId) ||
          !Number.isInteger(cell.width) ||
          cell.width < 1 ||
          cell.width > 600
        )
          throw new Error("Invalid image row");
      }
    if (
      row.kind === "columns" &&
      (row.cells.length < 2 ||
        row.cells.length > 3 ||
        row.cells.reduce((n, c) => n + c.width, 0) !== 600)
    )
      throw new Error("Invalid columns");
    if (/{{|{%|\{#/.test(JSON.stringify(row)))
      throw new Error("Unsupported dynamic template");
  }
  const d = frozen.provenance.design;
  const text =
    rendered.text ||
    rows
      .flatMap((r) =>
        r.kind === "live"
          ? [r.text]
          : r.kind === "image"
            ? [r.alt]
            : r.kind === "columns"
              ? r.cells.map((c) => c.alt)
              : [],
      )
      .filter(Boolean)
      .join("\n\n");
  if (!text.trim()) throw new Error("Meaningful plain text required");
  const artifact = {
    schema: "fb-campaign-artifact/v1",
    format: "email-table-v1",
    source: {
      designId: d.id,
      designUpdatedAt: d.updatedAt,
      designHash: frozen.designHash,
      renderVersion: frozen.renderVersion,
      components: frozen.provenance.components.map((c) => ({
        name: c.name,
        version: c.version,
        hash: binaryHash(Buffer.from(c.markup)),
      })),
      brandHash: frozen.brandHash,
    },
    name: d.name,
    subject: d.subjectLine.trim(),
    previewText: d.previewText.trim(),
    text,
    rows,
    assets,
  };
  artifact.artifactHash = hash(artifact);
  const result = { artifact, provenance: frozen.provenance, media };
  if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024)
    throw new Error("Export bound exceeded");
  return result;
}
module.exports = {
  selectedDesignHash,
  canonical,
  hash,
  binaryHash,
  freezeArtifactInputs,
  compileArtifact,
};

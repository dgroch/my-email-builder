"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const artifact = fs.existsSync(
  require.resolve("../lib/render").replace("render.js", "campaignArtifact.js"),
)
  ? require("../lib/campaignArtifact")
  : {};
const design = {
  id: "fixture-design",
  updatedAt: "2026-10-13T00:00:00.000Z",
  name: "Fixture",
  subjectLine: "Fixture subject",
  previewText: "Fixture preview",
  campaign: { blocks: [{ component: "footer", tokens: {} }] },
};
test("artifact_freezes_components_and_brand", () => {
  assert.equal(typeof artifact.freezeArtifactInputs, "function");
  const components = [
    {
      name: "footer",
      version: "disk-v1",
      markup: "<tr><td>Known footer</td></tr>",
    },
  ];
  const brand = { colours: { ink: "#123456" } };
  const frozen = artifact.freezeArtifactInputs(design, components, brand);
  components[0].markup = "Changed";
  brand.colours.ink = "#ffffff";
  design.name = "Edited";
  assert.equal(
    frozen.provenance.components[0].markup,
    "<tr><td>Known footer</td></tr>",
  );
  assert.equal(frozen.provenance.brand.colours.ink, "#123456");
  assert.equal(frozen.provenance.design.name, "Fixture");
});
test("artifact_preserves_gif_columns_and_canonical_hash", async () => {
  assert.equal(typeof artifact.compileArtifact, "function");
  const sharp = require("sharp");
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "#123456" },
  })
    .png()
    .toBuffer();
  const gif = Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64",
  );
  const frozen = artifact.freezeArtifactInputs(
    { ...design, name: "Fixture" },
    [],
    {},
  );
  const out = await artifact.compileArtifact(frozen, {
    rows: [
      {
        kind: "columns",
        cells: [
          { assetId: "gif", width: 300, alt: "Motion" },
          { assetId: "png", width: 300, alt: "Fixture" },
        ],
      },
      {
        kind: "live",
        html: "<p>Fixture live text</p>",
        text: "Fixture live text",
      },
      { kind: "legal_footer" },
    ],
    media: [
      { assetId: "gif", buffer: gif },
      { assetId: "png", buffer: png },
    ],
  });
  assert.equal(out.artifact.rows[0].cells.length, 2);
  assert.equal(out.media[0].base64, gif.toString("base64"));
  assert.equal(out.artifact.assets[0].mime, "image/gif");
  assert.equal(
    out.artifact.artifactHash,
    artifact.hash(
      Object.fromEntries(
        Object.entries(out.artifact).filter(([k]) => k !== "artifactHash"),
      ),
    ),
  );
});
test("artifact_rejects_dynamic_coupon", () => {
  assert.equal(typeof artifact.freezeArtifactInputs, "function");
  assert.throws(
    () =>
      artifact.freezeArtifactInputs(
        { ...design, subjectLine: "{% coupon_code x %}" },
        [],
        {},
      ),
    /dynamic|template/i,
  );
});
test("artifact_duplicate_request_and_restart_uses_snapshot", async () => {
  const os = require("os");
  process.env.DATA_DIR = fs.mkdtempSync(
    require("path").join(os.tmpdir(), "artifact-jobs-"),
  );
  const jobs = fs.existsSync(
    require("path").join(__dirname, "../lib/publishArtifacts.js"),
  )
    ? require("../lib/publishArtifacts")
    : {};
  assert.equal(typeof jobs.createArtifactService, "function");
  let saved = { ...design, name: "Fixture" };
  let calls = 0;
  const binding = { tenantId: "synthetic", credential: "a".repeat(40) };
  const service = jobs.createArtifactService({
    binding,
    getDesign: async () => saved,
    freeze: async (d) => artifact.freezeArtifactInputs(d, [], {}),
    render: async (f) => {
      calls++;
      return artifact.compileArtifact(f, {
        rows: [
          { kind: "live", html: "<p>Fixture copy</p>", text: "Fixture copy" },
          { kind: "legal_footer" },
        ],
        media: [],
      });
    },
  });
  const request = {
    schema: 1,
    requestId: "10000000-0000-4000-8000-000000000001",
    designId: saved.id,
    expectedUpdatedAt: saved.updatedAt,
  };
  const first = await service.start(request);
  assert.equal(
    (await service.start(request)).artifactJobId,
    first.artifactJobId,
  );
  saved.name = "Changed after queue";
  await service.runNext();
  const result = await service.get(first.artifactJobId);
  assert.equal(result.artifact.name, "Fixture");
  assert.equal(calls, 1);
  await service.runNext();
  assert.equal(calls, 1);
  await assert.rejects(
    service.start({
      ...request,
      expectedUpdatedAt: "2026-10-14T00:00:00.000Z",
    }),
    /conflict/i,
  );
});
test("artifact_service_auth", () => {
  const jobs = fs.existsSync(
    require("path").join(__dirname, "../lib/publishArtifacts.js"),
  )
    ? require("../lib/publishArtifacts")
    : {};
  assert.equal(typeof jobs.authorizeExport, "function");
  assert.equal(jobs.authorizeExport(undefined, "a".repeat(40)), false);
  assert.equal(
    jobs.authorizeExport("Bearer " + "a".repeat(40), "a".repeat(40)),
    true,
  );
  assert.equal(jobs.authorizeExport("Bearer other", "a".repeat(40)), false);
});
test("artifact restart rerenders persisted frozen inputs without looking up mutable designs", async () => {
  const os = require("os");
  process.env.DATA_DIR = fs.mkdtempSync(
    require("path").join(os.tmpdir(), "artifact-restart-"),
  );
  const { createArtifactService } = require("../lib/publishArtifacts");
  const options = {
    binding: { tenantId: "synthetic", credential: "a".repeat(40) },
    getDesign: async () => ({ ...design, name: "Frozen" }),
    freeze: async (d) => artifact.freezeArtifactInputs(d, [], {}),
    render: async (f) =>
      artifact.compileArtifact(f, {
        rows: [
          { kind: "live", html: "<p>Fixture</p>", text: "Fixture" },
          { kind: "legal_footer" },
        ],
        media: [],
      }),
  };
  const first = await createArtifactService(options).start({
    schema: 1,
    requestId: "10000000-0000-4000-8000-000000000002",
    designId: design.id,
    expectedUpdatedAt: design.updatedAt,
  });
  const restarted = createArtifactService({
    ...options,
    getDesign: async () => {
      throw Error("Mutable lookup prohibited");
    },
  });
  await restarted.runNext();
  assert.equal(
    (await restarted.get(first.artifactJobId)).artifact.name,
    "Frozen",
  );
});
require("node:test").after(async () => {
  await require("../lib/db").close();
});

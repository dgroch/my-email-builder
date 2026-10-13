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
test('artifact rejects unsafe or non-opaque background colours', async () => {
  const fixture = require('./fixtures/artifact-v1/compatibility.json');
  const frozen = artifact.freezeArtifactInputs(design, [], {});
  for (const backgroundColor of ['#fff;display:none', '#12345', '#12345678', null]) {
    await assert.rejects(artifact.compileArtifact(frozen, {
      rows: [
        { kind: 'image', assetId: 'png', width: 600, alt: 'Fixture', backgroundColor },
        { kind: 'legal_footer' },
      ],
      media: [{ assetId: 'png', buffer: Buffer.from(fixture.media.find(m => m.assetId === 'png').base64, 'base64') }],
    }), /background colour/);
  }
});
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
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
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

test("concurrent export services reserve at most twenty pending slots", async () => {
  const crypto = require("crypto"),
    os = require("os"),
    path = require("path");
  process.env.DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "artifact-capacity-"),
  );
  const { createArtifactService } = require("../lib/publishArtifacts");
  const binding = {
    tenantId: "capacity-" + crypto.randomUUID(),
    credential: "x".repeat(40),
  };
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const options = {
    binding,
    getDesign: async () => design,
    freeze: async (d) => {
      await gate;
      return artifact.freezeArtifactInputs(d, [], {});
    },
    render: async () => {},
  };
  const requests = Array.from({ length: 21 }, () => ({
    schema: 1,
    requestId: crypto.randomUUID(),
    designId: design.id,
    expectedUpdatedAt: design.updatedAt,
  }));
  const starts = requests.map((request) =>
    createArtifactService(options).start(request),
  );
  const resultsPromise = Promise.allSettled(starts);
  setTimeout(release, 100);
  const results = await resultsPromise;
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 20);
  assert.equal(
    results.filter(
      (r) =>
        r.status === "rejected" && r.reason.message === "EXPORT_QUEUE_FULL",
    ).length,
    1,
  );
  const accepted = results.findIndex((r) => r.status === "fulfilled");
  assert.equal(
    (await createArtifactService(options).start(requests[accepted]))
      .artifactJobId,
    results[accepted].value.artifactJobId,
  );
});

test("failed snapshot captures release their queue reservations", async () => {
  const crypto = require("crypto");
  const { createArtifactService } = require("../lib/publishArtifacts");
  const options = {
    binding: {
      tenantId: "failed-capture-" + crypto.randomUUID(),
      credential: "x".repeat(40),
    },
    getDesign: async () => design,
    freeze: async () => {
      throw Error("Image unavailable");
    },
    render: async () => {},
  };
  const request = () => ({
    schema: 1,
    requestId: crypto.randomUUID(),
    designId: design.id,
    expectedUpdatedAt: design.updatedAt,
  });
  for (let i = 0; i < 21; i++)
    await assert.rejects(
      createArtifactService(options).start(request()),
      /Image unavailable/,
    );
  const next = await createArtifactService({
    ...options,
    freeze: (d) => artifact.freezeArtifactInputs(d, [], {}),
  }).start(request());
  assert.equal(next.state, "queued");
});

test("expired snapshot reservations terminate and cannot be resurrected by late capture", async () => {
  const crypto = require("crypto");
  const { createArtifactService } = require("../lib/publishArtifacts");
  const { collection } = require("../lib/recordStore");
  const records = collection({
    table: "publish_artifacts",
    dir: "publish-artifacts",
  });
  const tenantId = "expired-capture-" + crypto.randomUUID();
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const options = {
    binding: { tenantId, credential: "x".repeat(40) },
    getDesign: async () => design,
    freeze: async (d) => {
      entered();
      await gate;
      return artifact.freezeArtifactInputs(d, [], {});
    },
    render: async () => {
      throw Error("Unfrozen job must not render");
    },
  };
  const service = createArtifactService(options);
  const request = {
    schema: 1,
    requestId: crypto.randomUUID(),
    designId: design.id,
    expectedUpdatedAt: design.updatedAt,
  };
  const late = service.start(request);
  const id = crypto
    .createHash("sha256")
    .update(tenantId + ":" + request.requestId)
    .digest("hex");
  const rejected = assert.rejects(late, /SNAPSHOT_LEASE_EXPIRED/);
  try {
    await started;
    const record = await records.get(id);
    await records.compareAndSwap(id, record.revision, {
      ...record,
      leaseUntil: 0,
    });
    await createArtifactService(options).runNext();
    assert.equal((await service.get(id)).state, "failed");
  } finally {
    release();
    await rejected;
  }
  assert.equal((await service.get(id)).state, "failed");
  assert.equal((await service.get(id)).errorCode, "SNAPSHOT_LEASE_EXPIRED");
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const assembly = require("../lib/publishAssembly");
test("snapshot captures GIF bytes before rendering instead of retaining mutable image URL", async () => {
  const gif = Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
    "base64",
  );
  const d = {
    id: "fixture-design",
    updatedAt: "2026-10-13T00:00:00Z",
    name: "Fixture",
    subjectLine: "Fixture",
    previewText: "Fixture",
    campaign: {
      blocks: [
        { component: "blocks/fixture", tokens: {} },
        { component: "footer", tokens: {} },
      ],
    },
  };
  const frozen = await assembly.freezeSavedDesign(d, {
    brand: { colours: {}, baseline: {} },
    resolve: (n) => ({
      html:
        n === "footer"
          ? "<tr><td>{% unsubscribe %}</td></tr>"
          : '<tr><td><img src="https://cdn.shopify.com/fixture.gif"></td></tr>',
    }),
    loadImage: async () => gif,
  });
  assert.doesNotMatch(
    frozen.rendered.html,
    /https:\/\/cdn.shopify.com\/fixture.gif/,
  );
  assert.equal(
    Object.values(frozen.capturedMedia)[0].base64,
    gif.toString("base64"),
  );
});
test("real raster worker preserves GIF columns and captured PNG bytes", async () => {
  const sharp = require("sharp");
  const png = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "#123456" },
  })
    .png()
    .toBuffer();
  const gif = Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
    "base64",
  );
  const d = {
    id: "fixture-design",
    updatedAt: "2026-10-13T00:00:00Z",
    name: "Fixture",
    subjectLine: "Fixture",
    previewText: "Fixture",
    campaign: {
      blocks: [
        {
          component: "blocks/fixture",
          tokens: { ALT: "Synthetic column copy" },
        },
        { component: "footer", tokens: {} },
      ],
    },
  };
  const frozen = await assembly.freezeSavedDesign(d, {
    brand: { colours: {}, baseline: {} },
    resolve: (n) => ({
      html:
        n === "footer"
          ? "<tr><td>{% unsubscribe %}</td></tr>"
          : '<tr><td width="300"><img width="300" height="30" src="https://cdn.shopify.com/fixture.gif"></td><td width="300">Synthetic column copy<img width="8" height="8" src="https://cdn.shopify.com/fixture.png"></td></tr>',
    }),
    loadImage: async (url) => (url.endsWith(".gif") ? gif : png),
  });
  try {
    const result = await assembly.renderFrozenArtifact(
      frozen,
      new AbortController().signal,
    );
    assert.equal(result.artifact.rows[0].kind, "columns");
    assert.ok(result.artifact.assets.some((a) => a.mime === "image/gif"));
    assert.equal(
      result.media.find(
        (m) =>
          m.assetId ===
          result.artifact.assets.find((a) => a.mime === "image/gif").id,
      ).base64,
      gif.toString("base64"),
    );
  } finally {
    await require("../lib/render").closeBrowser();
  }
});
test("frozen snapshot captures CSS/background/unquoted image resources", async () => {
  const sharp = require("sharp");
  const png = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "#123456" },
  })
    .png()
    .toBuffer();
  let calls = 0;
  const design = {
    id: "fixture-design",
    updatedAt: "2026-10-13T00:00:00Z",
    name: "Fixture",
    subjectLine: "Fixture",
    previewText: "Fixture",
    campaign: {
      blocks: [
        { component: "blocks/fixture", tokens: {} },
        { component: "footer", tokens: {} },
      ],
    },
  };
  const frozen = await assembly.freezeSavedDesign(design, {
    brand: { colours: {}, baseline: {} },
    resolve: (name) => ({
      html:
        name === "footer"
          ? "<tr><td>{% unsubscribe %}</td></tr>"
          : '<tr><td background="https://cdn.shopify.com/a.png" style="background-image:url(https://cdn.shopify.com/b.png)">Synthetic<img src=https://cdn.shopify.com/c.png></td></tr>',
    }),
    loadImage: async () => {
      calls++;
      return png;
    },
  });
  assert.equal(calls, 3);
  assert.equal(
    frozen.rendered.html.includes("https://cdn.shopify.com/"),
    false,
  );
});
test("frozen raster transport refuses uncaptured network and file resources", async () => {
  const render = require("../lib/render");
  try {
    await assert.rejects(
      render.renderSlices(
        '<html><body><table><tbody data-eb-block="0"><tr><td>Fixture<img src="https://cdn.shopify.com/uncaptured.png"></td></tr></tbody></table></body></html>',
        { frozenResources: true },
      ),
      /UNCAPTURED_RENDER_RESOURCE/,
    );
  } finally {
    await render.closeBrowser();
  }
});

test("prefix-related image URLs remain distinct captured resources through rasterisation", async () => {
  const sharp = require("sharp");
  const png = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "#123456" },
  })
    .png()
    .toBuffer();
  const resized = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "#fedcba" },
  })
    .png()
    .toBuffer();
  const design = {
    id: "prefix-design",
    updatedAt: "2026-10-13T00:00:00Z",
    name: "Fixture",
    subjectLine: "Fixture",
    previewText: "Fixture",
    campaign: {
      blocks: [
        { component: "blocks/fixture", tokens: {} },
        { component: "footer", tokens: {} },
      ],
    },
  };
  const base = "https://cdn.shopify.com/photo.png";
  const frozen = await assembly.freezeSavedDesign(design, {
    brand: { colours: {}, baseline: {} },
    resolve: (name) => ({
      html:
        name === "footer"
          ? "<tr><td>{% unsubscribe %}</td></tr>"
          : `<tr><td background="${base}?width=300&amp;v=1" style="background-image:url('${base}?width=600')"><a href="${base}">Fixture link</a><img src="${base}"><img src=${base}?width=300&amp;v=1></td></tr>`,
    }),
    loadImage: async (url) => (url.includes("?width=") ? resized : png),
  });
  assert.match(
    frozen.rendered.html,
    /href="https:\/\/cdn.shopify.com\/photo.png"/,
  );
  const imageSources = [];
  const { Parser } = require("htmlparser2");
  new Parser({
    onopentag(name, attrs) {
      if (name === "img") imageSources.push(attrs.src);
    },
  }).end(frozen.rendered.blocks[0].html);
  assert.equal(
    frozen.capturedMedia[imageSources[0]].base64,
    png.toString("base64"),
  );
  assert.equal(
    frozen.capturedMedia[imageSources[1]].base64,
    resized.toString("base64"),
  );
  try {
    const result = await assembly.renderFrozenArtifact(
      frozen,
      new AbortController().signal,
    );
    assert.equal(result.artifact.rows[0].kind, "image");
    assert.ok(result.artifact.assets[0].bytes > 0);
  } finally {
    await require("../lib/render").closeBrowser();
  }
});

test("a sub-budget image can be frozen and rendered from its persisted snapshot", async () => {
  const fs = require("fs"),
    os = require("os"),
    path = require("path"),
    crypto = require("crypto");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-weight-"));
  process.env.DATA_DIR = dir;
  const sharp = require("sharp");
  const png = await sharp(crypto.randomBytes(600 * 250 * 3), {
    raw: { width: 600, height: 250, channels: 3 },
  })
    .png()
    .toBuffer();
  assert.ok(png.length < 600 * 1024);
  const design = {
    id: "weight-design",
    updatedAt: "2026-10-13T00:00:00Z",
    name: "Fixture",
    subjectLine: "Fixture",
    previewText: "Fixture",
    campaign: {
      blocks: [
        { component: "blocks/fixture", tokens: {} },
        { component: "footer", tokens: {} },
      ],
    },
  };
  const { createArtifactService } = require("../lib/publishArtifacts");
  const options = {
    binding: {
      tenantId: "weight-" + crypto.randomUUID(),
      credential: "x".repeat(40),
    },
    getDesign: async () => design,
    freeze: (d) =>
      assembly.freezeSavedDesign(d, {
        brand: { colours: {}, baseline: {} },
        resolve: (name) => ({
          html:
            name === "footer"
              ? "<tr><td>{% unsubscribe %}</td></tr>"
              : '<tr><td>Fixture copy<img width="600" src="https://cdn.shopify.com/weight.png"></td></tr>',
        }),
        loadImage: async () => png,
      }),
    render: assembly.renderFrozenArtifact,
  };
  try {
    const job = await createArtifactService(options).start({
      schema: 1,
      requestId: crypto.randomUUID(),
      designId: design.id,
      expectedUpdatedAt: design.updatedAt,
    });
    const restarted = createArtifactService({
      ...options,
      getDesign: async () => {
        throw Error("Must use snapshot");
      },
      freeze: async () => {
        throw Error("Must use snapshot");
      },
    });
    await restarted.runNext();
    const result = await restarted.get(job.artifactJobId);
    assert.ok(result.artifact, JSON.stringify(result));
    assert.equal(result.artifact.rows[0].kind, "image");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await require("../lib/render").closeBrowser();
  }
});
require("node:test").after(async () => {
  await require("../lib/db").close();
});

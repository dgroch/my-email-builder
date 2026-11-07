const { test } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const assembly = require("../lib/publishAssembly");
const templateSource = require("../lib/templateSource");

// CRC32 for the PNG tEXt chunk used to pad a valid PNG to an exact byte length.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++)
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer)
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// A real PNG of an exact byte size: insert an ancillary tEXt chunk before IEND. The tag keeps
// same-sized images byte-distinct so they remain separate captured resources.
async function pngOfSize(size, tag = "") {
  const base = await sharp({
    create: { width: 4, height: 4, channels: 3, background: "#123456" },
  })
    .png()
    .toBuffer();
  const tagBytes = Buffer.from(String(tag));
  assert.ok(
    size >= base.length + 14 + tagBytes.length,
    "padding target must fit the PNG",
  );
  const data = Buffer.concat([
    Buffer.from("p"),
    Buffer.from([0]),
    tagBytes,
    Buffer.alloc(size - base.length - 14 - tagBytes.length, 0x78),
  ]);
  const type = Buffer.from("tEXt");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);
  return Buffer.concat([
    base.subarray(0, base.length - 12),
    chunk,
    base.subarray(base.length - 12),
  ]);
}
function fixtureDesign(blocks, id = "fixture-design") {
  return {
    id,
    updatedAt: "2026-11-07T00:00:00Z",
    name: "Fixture",
    subjectLine: "Fixture subject",
    previewText: "Fixture preview",
    campaign: { blocks },
  };
}
function imageBlock(name, index) {
  return { component: name, tokens: { IMAGE_INDEX: String(index) } };
}
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
          : '<tr><td width="300" bgcolor="#e00000"><img width="300" height="30" src="https://cdn.shopify.com/fixture.gif"></td><td width="300" bgcolor="#e00000">Synthetic column copy<img width="8" height="8" src="https://cdn.shopify.com/fixture.png"></td></tr>',
    }),
    loadImage: async (url) => (url.endsWith(".gif") ? gif : png),
  });
  try {
    const result = await assembly.renderFrozenArtifact(
      frozen,
      new AbortController().signal,
    );
    assert.equal(result.artifact.rows[0].kind, "columns");
    assert.deepEqual(
      result.artifact.rows[0].cells.map((c) => c.backgroundColor),
      ["#e00000", "#e00000"],
    );
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
    expectedDesignHash: require("../lib/campaignArtifact").selectedDesignHash(design),
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

test("ordinary inline GIF slices remain uploadable raster images", async () => {
  const render = require("../lib/render");
  const images = require("../lib/imageOptimiser");
  const src =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
  const html = `<html><body><table width="600"><tbody data-eb-block="0"><tr><td><img src="${src}" width="600" height="30"></td></tr></tbody></table></body></html>`;
  try {
    const rendered = await render.renderSlices(html, { scale: 1 });
    const result = await images.optimiseSlices(rendered.slices);
    assert.equal(result.slices[0].kind, "png");
    assert.ok(result.slices[0].buffer.length > 0);
    assert.equal(result.slices[0].src, undefined);
  } finally {
    await render.closeBrowser();
  }
});

test("artifact plain text excludes styles and decodes readable copy and links", async () => {
  const design = {
    id: "text-design",
    name: "Synthetic",
    updatedAt: "2026-10-14T00:00:00Z",
    subjectLine: "Synthetic",
    previewText: "Synthetic",
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
          : '<tr><td><style>/* private layout */ .copy { color:red; }</style><h2>Fig &amp; Bloom</h2><p>Read <strong>this</strong> today.</p><a href="https://figandbloom.com/?a=1&amp;b=2">Shop</a><img alt="A bouquet" width="1" height="1" src="https://cdn.shopify.com/fixture.png"></td></tr>',
    }),
    loadImage: async () =>
      require("sharp")({
        create: { width: 1, height: 1, channels: 3, background: "#fff" },
      })
        .png()
        .toBuffer(),
  });
  try {
    const { artifact } = await assembly.renderFrozenArtifact(
      frozen,
      new AbortController().signal,
    );
    assert.doesNotMatch(artifact.text, /private layout|color:red|&amp;/);
    assert.match(artifact.text, /Fig & Bloom/);
    assert.match(artifact.text, /Read this today\./);
    assert.match(
      artifact.text,
      /Shop \(https:\/\/figandbloom\.com\/\?a=1&b=2\)/,
    );
    assert.match(artifact.text, /A bouquet/);
  } finally {
    await require("../lib/render").closeBrowser();
  }
});


test("frozen inline GIF survives persistence and publishes its original bytes", async () => {
  const base64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
  const design = {
    id: "inline-gif", updatedAt: "2026-10-14T00:00:00Z",
    name: "Synthetic", subjectLine: "Synthetic", previewText: "Synthetic",
    campaign: { blocks: [
      { component: "blocks/fixture", tokens: {} },
      { component: "footer", tokens: {} },
    ] },
  };
  const options = (src) => ({
    brand: { colours: {}, baseline: {} },
    resolve: (name) => ({ html: name === "footer"
      ? "<tr><td>{% unsubscribe %}</td></tr>"
      : `<tr><td><img src="${src}" width="600" height="30" alt="Synthetic GIF"></td></tr>` }),
  });
  try {
    const frozen = await assembly.freezeSavedDesign(design, options("data:image/gif;base64," + base64));
    const result = await assembly.renderFrozenArtifact(JSON.parse(JSON.stringify(frozen)), new AbortController().signal);
    assert.equal(result.artifact.rows[0].kind, "image");
    assert.equal(result.artifact.assets[0].mime, "image/gif");
    assert.equal(result.media[0].base64, base64);
    await assert.rejects(assembly.freezeSavedDesign(design, options("data:image/gif;base64,%%%")), /INLINE_IMAGE_ENCODING/);
    await assert.rejects(assembly.freezeSavedDesign(design, options("data:image/gif;base64," + Buffer.alloc(assembly.CAPTURED_IMAGE_BUDGET + 1).toString("base64"))), /CAPTURED_IMAGE_BUDGET/);
  } finally {
    await require("../lib/render").closeBrowser();
  }
});


test("capture budget accepts exactly 2 MiB and rejects one byte over", async () => {
  const BUDGET = assembly.CAPTURED_IMAGE_BUDGET;
  assert.equal(BUDGET, 2 * 1024 * 1024);
  const atBudget = await pngOfSize(BUDGET);
  const overBudget = await pngOfSize(BUDGET + 1);
  const design = fixtureDesign([
    { component: "blocks/boundary", tokens: {} },
    { component: "footer", tokens: {} },
  ], "budget-boundary");
  const options = (bytes) => ({
    brand: { colours: {}, baseline: {} },
    resolve: (name) => ({
      html:
        name === "footer"
          ? "<tr><td>{% unsubscribe %}</td></tr>"
          : '<tr><td><img src="https://cdn.shopify.com/boundary.png"></td></tr>',
    }),
    loadImage: async () => bytes,
  });
  const frozen = await assembly.freezeSavedDesign(design, options(atBudget));
  assert.equal(Object.keys(frozen.capturedMedia).length, 1);
  assert.equal(
    Object.values(frozen.capturedMedia)[0].base64,
    atBudget.toString("base64"),
  );
  await assert.rejects(
    assembly.freezeSavedDesign(design, options(overBudget)),
    /CAPTURED_IMAGE_BUDGET/,
  );
});

test("six original images summing just over the old 1 MiB cap are captured intact", async () => {
  const sizes = [175000, 175000, 175000, 175000, 175000, 178458];
  const originals = [];
  for (let i = 0; i < sizes.length; i++)
    originals.push(await pngOfSize(sizes[i], "six-" + i));
  const total = originals.reduce((n, b) => n + b.length, 0);
  assert.equal(total, 1053458);
  assert.ok(total > 1048576 && total <= assembly.CAPTURED_IMAGE_BUDGET);
  const design = fixtureDesign(
    [
      ...originals.map((_, i) => imageBlock("blocks/after-dark-" + i, i)),
      { component: "footer", tokens: {} },
    ],
    "six-originals",
  );
  const byUrl = new Map(
    originals.map((b, i) => ["https://cdn.shopify.com/after-dark/" + i + ".png", b]),
  );
  const frozen = await assembly.freezeSavedDesign(design, {
    brand: { colours: {}, baseline: {} },
    resolve: (name) => {
      if (name === "footer")
        return { html: "<tr><td>{% unsubscribe %}</td></tr>" };
      const i = Number(name.split("-").pop());
      return {
        html:
          '<tr><td><img src="https://cdn.shopify.com/after-dark/' +
          i +
          '.png" alt="After Dark image ' +
          i +
          '"></td></tr>',
      };
    },
    loadImage: async (url) => byUrl.get(url),
  });
  assert.equal(Object.keys(frozen.capturedMedia).length, 6);
  const captured = new Set(
    Object.values(frozen.capturedMedia).map((media) => media.base64),
  );
  for (const original of originals)
    assert.ok(captured.has(original.toString("base64")));
});

test("live html-only card-feature externalises its captured image as an asset reference", async () => {
  const png = await pngOfSize(60000);
  const card = templateSource.resolve("products/card-feature");
  const link =
    "https://figandbloom.com/collections/after-dark?utm_source=resend&utm_medium=email&utm_campaign=after_dark_launch_20261107&utm_content=feature";
  const design = fixtureDesign(
    [
      { component: "blocks/live-copy-0", tokens: {} },
      { component: "blocks/live-copy-1", tokens: {} },
      { component: "blocks/live-copy-2", tokens: {} },
      { component: "blocks/live-copy-3", tokens: {} },
      {
        component: "products/card-feature",
        tokens: {
          IMAGE_URL: "https://cdn.shopify.com/card-feature.png",
          IMAGE_ALT: "After Dark feature card",
          LINK_URL: link,
          TITLE: "After Dark",
          BODY_P1: "A feature card that stays live HTML.",
        },
      },
      { component: "footer", tokens: {} },
    ],
    "live-card-feature",
  );
  const frozen = await assembly.freezeSavedDesign(design, {
    brand: { colours: {}, baseline: {} },
    resolve: (name) => {
      if (name === "footer")
        return { html: "<tr><td>{{{RESEND_UNSUBSCRIBE_URL}}}</td></tr>" };
      if (name === "products/card-feature") return card;
      return { html: "<tr><td>Live copy " + name + "</td></tr>" };
    },
    loadImage: async (url) => {
      assert.equal(url, "https://cdn.shopify.com/card-feature.png");
      return png;
    },
  });
  assert.equal(frozen.rendered.blocks[4].component, "products/card-feature");
  assert.equal(frozen.rendered.blocks[4].live, true);
  assert.equal(Object.keys(frozen.capturedMedia).length, 1);
  assert.equal(
    Object.values(frozen.capturedMedia)[0].base64,
    png.toString("base64"),
  );
  try {
    const result = await assembly.renderFrozenArtifact(
      frozen,
      new AbortController().signal,
    );
    const live = result.artifact.rows.find((row) => row.kind === "live");
    assert.ok(live, JSON.stringify(result.artifact.rows));
    const source = live.html.match(/src="asset:([^"]+)"/);
    assert.ok(source, live.html);
    const asset = result.artifact.assets.find((item) => item.id === source[1]);
    assert.ok(asset, JSON.stringify(result.artifact.assets));
    assert.equal(
      result.media.find((item) => item.assetId === source[1]).base64,
      png.toString("base64"),
    );
    assert.doesNotMatch(live.html, /data:image|cdn\.shopify\.com|frozen-asset:/);

    const uncaptured = JSON.parse(JSON.stringify(frozen));
    uncaptured.rendered.blocks[4].html =
      '<tr><td><img src="https://cdn.shopify.com/uncaptured.png"></td></tr>';
    await assert.rejects(
      assembly.renderFrozenArtifact(uncaptured, new AbortController().signal),
      /LIVE_ASSET_CAPTURE_REQUIRED_4/,
    );

    const dangling = JSON.parse(JSON.stringify(frozen));
    dangling.rendered.blocks[4].html =
      '<tr><td><img src="frozen-asset:not-captured"></td></tr>';
    await assert.rejects(
      assembly.renderFrozenArtifact(dangling, new AbortController().signal),
      /LIVE_ASSET_CAPTURE_REQUIRED_4/,
    );
  } finally {
    await require("../lib/render").closeBrowser();
  }
});

test("After Dark-shaped fixture keeps six UTM links and the native Resend unsubscribe token", async () => {
  const sizes = [175000, 175000, 175000, 175000, 175000, 178458];
  const originals = [];
  for (let i = 0; i < sizes.length; i++)
    originals.push(await pngOfSize(sizes[i], "after-dark-" + i));
  assert.equal(
    originals.reduce((n, b) => n + b.length, 0),
    1053458,
  );
  const link = (content) =>
    "https://figandbloom.com/collections/after-dark?utm_source=resend&utm_medium=email&utm_campaign=after_dark_launch_20261107&utm_content=" +
    content;
  const contents = ["hero", "product-a", "product-b", "product-c", "feature", "cta"];
  const blocks = [
    { component: "blocks/after-dark-hero", tokens: { UTM_CONTENT: "hero" } },
    { component: "blocks/after-dark-product-a", tokens: { UTM_CONTENT: "product-a" } },
    { component: "blocks/after-dark-product-b", tokens: { UTM_CONTENT: "product-b" } },
    { component: "blocks/after-dark-product-c", tokens: { UTM_CONTENT: "product-c" } },
    {
      component: "products/card-feature",
      tokens: {
        IMAGE_URL: "https://cdn.shopify.com/after-dark/feature.png",
        IMAGE_ALT: "After Dark feature card",
        LINK_URL: link("feature"),
        TITLE: "After Dark",
        BODY_P1: "Six original images, one live feature card.",
      },
    },
    { component: "blocks/after-dark-cta", tokens: { UTM_CONTENT: "cta" } },
    { component: "footer", tokens: {} },
  ];
  // Index 0..3 and 5 are simple image links; index 4 is the live card-feature.
  const byUrl = new Map([
    ["https://cdn.shopify.com/after-dark/hero.png", originals[0]],
    ["https://cdn.shopify.com/after-dark/product-a.png", originals[1]],
    ["https://cdn.shopify.com/after-dark/product-b.png", originals[2]],
    ["https://cdn.shopify.com/after-dark/product-c.png", originals[3]],
    ["https://cdn.shopify.com/after-dark/cta.png", originals[5]],
  ]);
  byUrl.set(
    "https://cdn.shopify.com/after-dark/feature.png",
    originals[4],
  );
  const frozen = await assembly.freezeSavedDesign(
    fixtureDesign(blocks, "after-dark-acceptance"),
    {
      brand: { colours: {}, baseline: {} },
      resolve: (name) => {
        if (name === "footer")
          return {
            html:
              "<tr><td>No longer want these? {{{RESEND_UNSUBSCRIBE_URL}}}</td></tr>",
          };
        if (name === "products/card-feature")
          return templateSource.resolve("products/card-feature");
        const content = name.slice("blocks/after-dark-".length);
        return {
          html:
            '<tr><td><a href="' +
            link(content) +
            '"><img src="https://cdn.shopify.com/after-dark/' +
            content +
            '.png" alt="After Dark ' +
            content +
            '" width="600"></a></td></tr>',
        };
      },
      loadImage: async (url) => byUrl.get(url),
    },
  );
  assert.equal(Object.keys(frozen.capturedMedia).length, 6);
  assert.equal(frozen.rendered.blocks.at(-1).footer, true);
  assert.match(
    frozen.rendered.blocks.at(-1).html,
    /\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/,
  );
  assert.match(frozen.rendered.html, /\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/);
  const hrefs = [
    ...frozen.rendered.html.matchAll(/href="([^"]*)"/g),
  ].map((match) => match[1].replace(/&amp;/g, "&"));
  for (const content of contents) {
    const expected = link(content);
    assert.ok(hrefs.includes(expected), "missing " + expected);
    const parsed = new URL(expected);
    assert.equal(parsed.searchParams.get("utm_source"), "resend");
    assert.equal(parsed.searchParams.get("utm_medium"), "email");
    assert.equal(parsed.searchParams.get("utm_campaign"), "after_dark_launch_20261107");
    assert.equal(parsed.searchParams.get("utm_content"), content);
  }
  const campaignLinks = hrefs.filter((href) =>
    href.includes("utm_campaign=after_dark_launch_20261107"),
  );
  assert.deepEqual(
    [...new Set(campaignLinks.map((href) => new URL(href).searchParams.get("utm_content")))].sort(),
    [...contents].sort(),
  );
  assert.equal(
    Object.values(frozen.capturedMedia).filter((media) =>
      originals.some((original) => original.toString("base64") === media.base64),
    ).length,
    6,
  );
  try {
    const result = await assembly.renderFrozenArtifact(
      frozen,
      new AbortController().signal,
    );
    const live = result.artifact.rows.find((row) => row.kind === "live");
    assert.ok(live, JSON.stringify(result.artifact.rows));
    const source = live.html.match(/src="asset:([^"]+)"/);
    assert.ok(source, live.html);
    assert.equal(
      result.media.find((item) => item.assetId === source[1]).base64,
      originals[4].toString("base64"),
    );
    assert.doesNotMatch(live.html, /data:image|cdn\.shopify\.com|frozen-asset:/);
  } finally {
    await require("../lib/render").closeBrowser();
  }
});

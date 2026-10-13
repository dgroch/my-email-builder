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
  assert.match(frozen.rendered.html, /data:image\/gif;base64/);
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
test('frozen raster transport refuses uncaptured network and file resources',async()=>{const render=require('../lib/render');try{await assert.rejects(render.renderSlices('<html><body><table><tbody data-eb-block="0"><tr><td>Fixture<img src="https://cdn.shopify.com/uncaptured.png"></td></tr></tbody></table></body></html>',{frozenResources:true}),/UNCAPTURED_RENDER_RESOURCE/);}finally{await render.closeBrowser();}});

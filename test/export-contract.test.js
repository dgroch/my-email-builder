const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const render = require("../lib/render");
const assembly = require("../lib/publishAssembly");

const originalHtmlOnly = render.htmlOnlyComponents;
const originalRenderSlices = render.renderSlices;
after(() => {
  render.htmlOnlyComponents = originalHtmlOnly;
  render.renderSlices = originalRenderSlices;
});

function fixtureDesign(blocks) {
  return {
    id: "fixture-design",
    updatedAt: "2026-11-07T00:00:00Z",
    name: "Fixture",
    subjectLine: "Fixture subject",
    previewText: "Fixture preview",
    campaign: { blocks },
  };
}

test("live style rules are inlined into attributes and style/media elements are dropped", () => {
  const input =
    '<style>td.copy{text-align:left}.promo{color:#fff;font-weight:700!important}@media only screen and (max-width:599px){.promo{font-size:99px}}</style>' +
    '<table><tr><td class="copy" style="color:#000">Hi <a class="promo" style="color:#111" href="https://figandbloom.com/products/x?utm_source=resend&amp;utm_medium=email&amp;utm_campaign=after_dark_launch_20261107&amp;utm_content=product_x">Go</a></td></tr></table>';
  const output = assembly.inlineStyleElements(input);
  assert.doesNotMatch(output, /<style|@media|font-size:99px/i);
  assert.match(output, /<td class="copy" style="color:#000;text-align:left">/);
  assert.match(output, /<a class="promo" style="color:#111;font-weight:700"/);
  assert.doesNotMatch(output, /!important/);
  assert.equal(
    (output.match(/utm_campaign=after_dark_launch_20261107/g) || []).length,
    1,
  );
});

test("tag selectors only match their own element, not its ancestors", () => {
  const output = assembly.inlineStyleElements(
    '<style>td{color:#123456}</style><table><tr><td>Copy</td></tr></table>',
  );
  assert.equal(
    output,
    '<table><tr><td style="color:#123456">Copy</td></tr></table>',
  );
});

test("real-style live rows externalise images as asset refs and preserve link bytes", async () => {
  const png = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "#123456" },
  })
    .png()
    .toBuffer();
  render.htmlOnlyComponents = () => ["fixture"];
  render.renderSlices = async () => ({ slices: [], brokenImages: [] });
  const href =
    "https://figandbloom.com/products/nebula?utm_source=resend&amp;utm_medium=email&amp;utm_campaign=after_dark_launch_20261107&amp;utm_content=product_nebula";
  const liveHtml =
    '<style>.promo{color:#123456}@media only screen and (max-width:599px){.promo{font-size:9px}}</style>' +
    '<a class="promo" href="' +
    href +
    '"><img src="https://cdn.shopify.com/fixture.png" alt="Fixture"></a>';
  const design = fixtureDesign([
    { component: "blocks/fixture", tokens: {} },
    { component: "footer", tokens: {} },
  ]);
  const frozen = await assembly.freezeSavedDesign(design, {
    brand: { colours: {}, baseline: {} },
    resolve: (name) => ({
      name,
      version: 1,
      html:
        name === "footer"
          ? "<tr><td>{% unsubscribe %}</td></tr>"
          : liveHtml,
    }),
    loadImage: async () => png,
  });
  const result = await assembly.renderFrozenArtifact(frozen);
  const live = result.artifact.rows[0];
  assert.equal(live.kind, "live");
  assert.doesNotMatch(live.html, /<style|@media|data:image|frozen-asset:/i);
  assert.match(live.html, /src="asset:asset-1"/);
  assert.match(live.html, /style="color:#123456"/);
  assert.doesNotMatch(live.html, /font-size:9px/);
  assert.ok(live.html.includes(href.replaceAll("&amp;", "&amp;")));
  assert.equal(result.artifact.assets.length, 1);
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].base64, png.toString("base64"));
  assert.match(result.artifact.assets[0].sha256, /^[a-f0-9]{64}$/);
});

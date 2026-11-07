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

test("ordinary rules are inlined and sanctioned media blocks are preserved", () => {
  const input =
    '<style>td.copy{text-align:left}.promo{color:#fff;font-weight:700!important}@media only screen and (max-width:599px){.promo{font-size:99px!important}}</style>' +
    '<table><tr><td class="copy" style="color:#000">Hi <a class="promo" style="color:#111" href="https://figandbloom.com/products/x?utm_source=resend&amp;utm_medium=email&amp;utm_campaign=after_dark_launch_20261107&amp;utm_content=product_x">Go</a></td></tr></table>';
  const output = assembly.inlineStyleElements(input);
  assert.match(
    output,
    /^<style>@media \(max-width:599px\)\{\.promo\{font-size:99px!important;\}\}<\/style>/,
  );
  assert.equal((output.match(/<style/g) || []).length, 1);
  assert.match(output, /<td class="copy" style="color:#000;text-align:left">/);
  assert.match(output, /<a class="promo" style="color:#111;font-weight:700"/);
  assert.doesNotMatch(output, /style="[^"]*font-size:99px/);
  assert.equal((output.match(/!important/g) || []).length, 1);
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

test("cascade uses importance, then specificity, then source order", () => {
  const idBeatsClass = assembly.inlineStyleElements(
    '<style>#x{color:red}.b{color:blue}</style><p id="x" class="b">x</p>',
  );
  assert.equal(idBeatsClass, '<p class="b" style="color:red">x</p>');

  const compoundBeatsSingle = assembly.inlineStyleElements(
    '<style>.a{color:red}.a.b{color:blue}</style><p class="a b">x</p>',
  );
  assert.equal(compoundBeatsSingle, '<p class="a b" style="color:blue">x</p>');

  const classBeatsTag = assembly.inlineStyleElements(
    '<style>td{color:red}.b{color:blue}</style><table><tr><td class="b">x</td></tr></table>',
  );
  assert.equal(
    classBeatsTag,
    '<table><tr><td class="b" style="color:blue">x</td></tr></table>',
  );

  const importantBeatsSpecificity = assembly.inlineStyleElements(
    '<style>#x{color:red}.b{color:blue!important}</style><p id="x" class="b">x</p>',
  );
  assert.equal(
    importantBeatsSpecificity,
    '<p class="b" style="color:blue">x</p>',
  );

  const importantSpecificityTie = assembly.inlineStyleElements(
    '<style>#x{color:red!important}.b{color:blue!important}</style><p id="x" class="b">x</p>',
  );
  assert.equal(
    importantSpecificityTie,
    '<p class="b" style="color:red">x</p>',
  );

  const laterOrderWins = assembly.inlineStyleElements(
    '<style>.b{color:red}.b{color:blue}</style><p class="b">x</p>',
  );
  assert.equal(laterOrderWins, '<p class="b" style="color:blue">x</p>');

  const laterStylesheetWins = assembly.inlineStyleElements(
    '<style>.x{color:green}.target{color:red}</style>' +
      '<style>.target{color:blue}</style><p class="x target">x</p>',
  );
  assert.equal(
    laterStylesheetWins,
    '<p class="x target" style="color:blue">x</p>',
  );

  const laterImportantStylesheetWins = assembly.inlineStyleElements(
    '<style>.target{color:red!important}</style>' +
      '<style>.target{color:blue!important}</style><p class="target">x</p>',
  );
  assert.equal(
    laterImportantStylesheetWins,
    '<p class="target" style="color:blue">x</p>',
  );
});

test("!important is always stripped from style attributes, including media-only rows", () => {
  const noStyle = assembly.inlineStyleElements(
    '<p class="b" style="color:blue!important">x</p>',
  );
  assert.equal(noStyle, '<p class="b" style="color:blue">x</p>');

  const mediaOnly = assembly.inlineStyleElements(
    '<style>@media (max-width:599px){.b{color:green!important}}</style><p class="b" style="color:blue!important">x</p>',
  );
  assert.match(mediaOnly, /^<style>@media \(max-width:599px\)\{\.b\{color:green!important;\}\}<\/style>/);
  assert.match(mediaOnly, /<p class="b" style="color:blue">x<\/p>/);
  assert.doesNotMatch(mediaOnly, /style="[^"]*!important/);

  const inlineImportantWins = assembly.inlineStyleElements(
    '<style>.b{color:blue}</style><p class="b" style="color:red!important">x</p>',
  );
  assert.equal(inlineImportantWins, '<p class="b" style="color:red">x</p>');

  const stylesheetImportantWins = assembly.inlineStyleElements(
    '<style>.b{color:blue!important}</style><p class="b" style="color:red">x</p>',
  );
  assert.equal(stylesheetImportantWins, '<p class="b" style="color:blue">x</p>');
});

test("unsupported selectors fail closed instead of over-applying", () => {
  for (const selector of [
    "a[href]",
    "a:hover",
    ".a + .b",
    ".a ~ .b",
    ":not(.a, .b)",
    "*",
    ".a::before",
  ])
    assert.throws(
      () =>
        assembly.inlineStyleElements(
          "<style>" + selector + "{color:red}</style><p class=\"a\">x</p>",
        ),
      /LIVE_STYLE_SELECTOR_UNSUPPORTED/,
      selector,
    );
  assert.throws(
    () =>
      assembly.inlineStyleElements(
        '<style>.a, a[href]{color:red}</style><p class="a">x</p>',
      ),
    /LIVE_STYLE_SELECTOR_UNSUPPORTED/,
  );
  assert.equal(
    assembly.inlineStyleElements(
      '<style>.a,.b{color:red}</style><p class="a">a</p><p class="b">b</p>',
    ),
    '<p class="a" style="color:red">a</p><p class="b" style="color:red">b</p>',
  );
});

test("media blocks merge into one style per row and ids are stripped after matching", () => {
  const output = assembly.inlineStyleElements(
    '<style>#hero{color:#000}@media only screen and (max-width:599px){.hero{padding:2px!important}}</style>' +
      '<p id="hero" class="hero">x</p>' +
      '<style>@media only screen and (min-width:600px){.hero td{display:block!important}}</style>',
  );
  assert.equal((output.match(/<style/g) || []).length, 1);
  assert.match(
    output,
    /^<style>@media \(max-width:599px\)\{\.hero\{padding:2px!important;\}\}@media \(min-width:600px\)\{\.hero td\{display:block!important;\}\}<\/style>/,
  );
  assert.doesNotMatch(output, /id="hero"/);
  assert.match(output, /<p class="hero" style="color:#000">x<\/p>/);
  assert.throws(
    () =>
      assembly.inlineStyleElements(
        '<style>@media (max-width:599px){a[href]{color:red}}</style><p>x</p>',
      ),
    /LIVE_STYLE_SELECTOR_UNSUPPORTED/,
  );
  assert.throws(
    () =>
      assembly.inlineStyleElements(
        '<style>@media (max-width:599px){.a{background:url(x)}}</style><p class="a">x</p>',
      ),
    /LIVE_STYLE_DECLARATION_UNSUPPORTED/,
  );
  assert.throws(
    () =>
      assembly.inlineStyleElements(
        '<style>@media (max-width:599px){.a > .b{color:red!important}}</style><p class="a"><span class="b">x</span></p>',
      ),
    /LIVE_STYLE_SELECTOR_UNSUPPORTED/,
  );
  assert.throws(
    () =>
      assembly.inlineStyleElements(
        '<style>@media (max-width:599px){.a{color:red}}</style><p class="a" style="color:blue">x</p>',
      ),
    /LIVE_STYLE_DECLARATION_UNSUPPORTED/,
  );
});

test("media dedup keeps non-adjacent source order", () => {
  const output = assembly.inlineStyleElements(
    '<style>@media (max-width:599px){.x{color:red!important}}</style>' +
      '<style>@media (max-width:599px){.x{color:blue!important}}</style>' +
      '<style>@media (max-width:599px){.x{color:red!important}}</style>' +
      '<p class="x">x</p>',
  );
  assert.equal(
    output,
    '<style>@media (max-width:599px){.x{color:red!important;}}' +
      '@media (max-width:599px){.x{color:blue!important;}}' +
      '@media (max-width:599px){.x{color:red!important;}}</style>' +
      '<p class="x">x</p>',
  );

  const adjacent = assembly.inlineStyleElements(
    '<style>@media (max-width:599px){.x{color:red!important}}</style>' +
      '<style>@media (max-width:599px){.x{color:red!important}}</style>' +
      '<p class="x">x</p>',
  );
  assert.equal((adjacent.match(/@media/g) || []).length, 1);
});

test("style media attributes stay scoped and unsupported scopes fail closed", () => {
  const scoped = assembly.inlineStyleElements(
    '<style media="(max-width:599px)">.x{color:red!important}</style><p class="x">x</p>',
  );
  assert.equal(
    scoped,
    '<style>@media (max-width:599px){.x{color:red!important;}}</style><p class="x">x</p>',
  );
  assert.throws(
    () =>
      assembly.inlineStyleElements(
        '<style media="print">.x{color:red!important}</style><p class="x">x</p>',
      ),
    /LIVE_STYLE_UNSUPPORTED/,
  );
  assert.throws(
    () =>
      assembly.inlineStyleElements(
        '<style media="(max-width:599px)">.x{color:red}</style><p class="x">x</p>',
      ),
    /LIVE_STYLE_DECLARATION_UNSUPPORTED/,
  );
});

test("duplicate declarations honor important precedence", () => {
  const sheetImportant = assembly.inlineStyleElements(
    '<style>.x{color:red!important;color:blue}</style><p class="x">x</p>',
  );
  assert.equal(sheetImportant, '<p class="x" style="color:red">x</p>');

  const inlineImportant = assembly.inlineStyleElements(
    '<p class="x" style="color:red!important;color:blue">x</p>',
  );
  assert.equal(inlineImportant, '<p class="x" style="color:red">x</p>');

  const laterImportant = assembly.inlineStyleElements(
    '<style>.x{color:blue;color:red!important}</style><p class="x">x</p>',
  );
  assert.equal(laterImportant, '<p class="x" style="color:red">x</p>');

  const laterNormal = assembly.inlineStyleElements(
    '<style>.x{color:red;color:blue}</style><p class="x">x</p>',
  );
  assert.equal(laterNormal, '<p class="x" style="color:blue">x</p>');
});

test("blockless and unsupported at-rules fail closed without swallowing rules", () => {
  for (const css of [
    '@charset "utf-8";.x{color:red}',
    '@import url("x.css");.x{color:red}',
    '@namespace svg url(http://www.w3.org/2000/svg);.x{color:red}',
  ])
    assert.throws(
      () =>
        assembly.inlineStyleElements(
          "<style>" + css + '</style><p class="x">x</p>',
        ),
      /LIVE_STYLE_UNSUPPORTED/,
      css,
    );
  assert.throws(
    () =>
      assembly.inlineStyleElements(
        '<style>@supports (display:block){.x{color:red}}</style><p class="x">x</p>',
      ),
    /LIVE_STYLE_UNSUPPORTED/,
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
    '<style>.promo{color:#123456}@media only screen and (max-width:599px){.promo{font-size:9px!important}}</style>' +
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
  assert.match(
    live.html,
    /^<style>@media \(max-width:599px\)\{\.promo\{font-size:9px!important;\}\}<\/style>/,
  );
  assert.doesNotMatch(live.html, /data:image|frozen-asset:/i);
  assert.match(live.html, /src="asset:asset-1"/);
  assert.match(live.html, /style="color:#123456"/);
  assert.doesNotMatch(live.html, /style="[^"]*font-size:9px/);
  assert.ok(live.html.includes(href));
  assert.doesNotMatch(live.html, /&amp;amp;/);
  assert.equal(result.artifact.assets.length, 1);
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].base64, png.toString("base64"));
  assert.match(result.artifact.assets[0].sha256, /^[a-f0-9]{64}$/);
});

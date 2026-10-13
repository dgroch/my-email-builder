const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
test("frozen assembly uses captured component and brand, preserves exact footer slot", async () => {
  const file = path.join(__dirname, "../lib/publishAssembly.js");
  const assembly = fs.existsSync(file) ? require(file) : {};
  assert.equal(typeof assembly.freezeSavedDesign, "function");
  const design = {
    id: "fixture-design",
    updatedAt: "2026-10-13T00:00:00.000Z",
    name: "Fixture",
    subjectLine: "Fixture subject",
    previewText: "Fixture preview",
    campaign: {
      blocks: [
        { component: "blocks/test", tokens: {} },
        { component: "footer", tokens: {} },
      ],
    },
  };
  const frozen = await assembly.freezeSavedDesign(design, {
    resolve: (n) => ({
      name: n,
      html:
        n === "footer"
          ? "<tr><td>{% unsubscribe %}</td></tr>"
          : '<tr><td style="color:#123456">Captured copy</td></tr>',
      version: 1,
    }),
    brand: {
      colours: { ink: "#654321" },
      baseline: { colours: { ink: "#123456" } },
    },
  });
  assert.match(frozen.rendered.blocks[0].html, /#654321/);
  assert.equal(frozen.rendered.blocks[1].footer, true);
  assert.match(frozen.rendered.html, /Captured copy/);
});

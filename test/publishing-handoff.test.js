const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const db = require("../lib/db");
after(() => db.close());

const campaign = {
  campaignName: "Fixture",
  bodyBg: "#fff",
  blocks: [
    {
      id: 1,
      component: "blocks/copy",
      tokens: { TEXT: "Saved copy", ALT: "Copy" },
    },
    { id: 2, component: "footer", tokens: {} },
  ],
};
// PostgreSQL JSONB can reorder keys at every object level; array order is retained.
const persisted = {
  blocks: [
    {
      id: 1,
      tokens: { ALT: "Copy", TEXT: "Saved copy" },
      component: "blocks/copy",
    },
    { id: 2, tokens: {}, component: "footer" },
  ],
  bodyBg: "#fff",
  campaignName: "Fixture",
};

async function handoff(saved) {
  const button = {},
    statuses = [],
    navigations = [];
  const source = fs.readFileSync(
    path.join(__dirname, "../public/app.js"),
    "utf8",
  );
  vm.runInNewContext(
    source.slice(source.indexOf("// Creative handoff only:")),
    {
      campaign,
      currentDesignId: "fixture-design",
      URL,
      $: () => ({ value: "Fixture" }),
      document: { querySelector: () => button },
      setStatus: (message) => statuses.push(message),
      window: { location: { assign: (url) => navigations.push(url) } },
      fetch: async (url) => ({
        ok: true,
        json: async () =>
          url === "/api/publishing-config"
            ? { engineOrigin: "https://engagement.figandbloom.com" }
            : {
                id: "fixture-design",
                designHash: "a".repeat(64),
                campaign: saved,
                subjectLine: "Fixture",
                previewText: "Fixture",
                updatedAt: "2026-10-13T00:00:00Z",
              },
      }),
    },
  );
  await new Promise(setImmediate);
  await button.onclick();
  return { statuses, navigations };
}

test("publishing accepts saved campaigns with reordered JSONB object keys", async () => {
  const saved = db.enabled
    ? (
        await db.query("SELECT $1::jsonb AS campaign", [
          JSON.stringify(campaign),
        ])
      ).rows[0].campaign
    : persisted;
  assert.deepEqual(campaign, saved);
  const result = await handoff(saved);
  assert.deepEqual(result.statuses, []);
  assert.deepEqual(result.navigations, [
    "https://engagement.figandbloom.com/campaigns/import?designId=fixture-design&expectedUpdatedAt=2026-10-13T00%3A00%3A00Z&expectedDesignHash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ]);
});

test("publishing still blocks changed nested content and reordered blocks", async () => {
  for (const change of [
    (saved) => {
      saved.blocks[0].tokens.TEXT = "Unsaved copy";
    },
    (saved) => {
      saved.blocks.reverse();
    },
  ]) {
    const saved = structuredClone(persisted);
    change(saved);
    const result = await handoff(saved);
    assert.deepEqual(result.navigations, []);
    assert.deepEqual(result.statuses, [
      "Save your latest changes before publishing",
    ]);
  }
});

test("manual design metadata is saved, reopened and required before handoff", async () => {
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manual-handoff-"));
  const original = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  const designs = require("../lib/designs");
  if (original === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = original;
  const source = fs.readFileSync(
    path.join(__dirname, "../public/app.js"),
    "utf8",
  );
  const fields = {
    campaignName: { value: "Manual" },
    bodyBg: { value: "#fff" },
    subjectLine: { value: "  Manual subject  " },
    previewText: { value: "  Manual preview  " },
  };
  const statuses = [],
    navigations = [],
    button = {};
  const context = vm.createContext({
    campaign: structuredClone(campaign),
    currentDesignId: null,
    currentDesignMeta: {},
    uid: 1,
    loadSeq: 0,
    URL,
    $: (selector) => fields[selector.slice(1)] || { close() {} },
    document: { querySelector: () => button },
    window: { location: { assign: (url) => navigations.push(url) } },
    refreshStaleBadges() {},
    supersedeLoads() {
      return ++context.loadSeq;
    },
    setDesignUrl() {},
    renderBlocks() {},
    livePreview() {},
    prompt: () => "Manual",
    setStatus: (message) => statuses.push(message),
    fetch: async (url, options) => ({
      ok: true,
      json: async () => {
        if (url === "/api/publishing-config")
          return { engineOrigin: "https://engagement.figandbloom.com" };
        if (url === "/api/designs")
          return designs.create(JSON.parse(options.body));
        const id = url.split("/").pop();
        const saved = options?.method === "PUT"
          ? designs.update(id, JSON.parse(options.body))
          : designs.get(id);
        return {...saved, designHash: require("../lib/campaignArtifact").selectedDesignHash(saved)};
      },
    }),
  });
  try {
    vm.runInContext(
      source.slice(
        source.indexOf("async function saveDesign()"),
        source.indexOf("async function openDesigns()"),
      ),
      context,
    );
    vm.runInContext(
      source.slice(
        source.indexOf("function hydrate()"),
        source.indexOf("// ── create campaign"),
      ),
      context,
    );
    vm.runInContext(
      source.slice(
        source.indexOf("async function loadDesign("),
        source.indexOf("async function cloneDesign("),
      ),
      context,
    );
    await vm.runInContext("saveDesign()", context);
    const id = context.currentDesignId;
    assert.equal(designs.get(id).subjectLine, "Manual subject");
    assert.equal(designs.get(id).previewText, "Manual preview");
    fields.subjectLine.value = "";
    fields.previewText.value = "";
    await vm.runInContext(`loadDesign(${JSON.stringify(id)})`, context);
    assert.equal(fields.subjectLine.value, "Manual subject");
    assert.equal(fields.previewText.value, "Manual preview");
    vm.runInContext(
      source.slice(source.indexOf("// Creative handoff only:")),
      context,
    );
    await new Promise(setImmediate);
    await button.onclick();
    assert.equal(navigations.length, 1);
    fields.subjectLine.value = "Changed subject";
    await button.onclick();
    assert.equal(
      navigations.length,
      1,
      "unsaved metadata must not publish stale copy",
    );
    await vm.runInContext("saveDesign()", context);
    assert.equal(designs.get(id).subjectLine, "Changed subject");
    await button.onclick();
    assert.equal(navigations.length, 2);
    fields.previewText.value = "";
    await vm.runInContext("saveDesign()", context);
    await button.onclick();
    assert.equal(
      navigations.length,
      2,
      "empty saved preview must still be held",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

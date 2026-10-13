const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const artifact = require("../lib/campaignArtifact");
test("shared compatibility fixture keeps pinned hash and immutable media", () => {
  const f = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "fixtures/artifact-v1/compatibility.json"),
      "utf8",
    ),
  );
  assert.equal(
    f.artifact.artifactHash,
    "b241c713ebb0a49ba6c68f4202af57e127ff8d8dabedda8131577c02d3b8032d",
  );
  assert.equal(
    artifact.hash(
      Object.fromEntries(
        Object.entries(f.artifact).filter(([k]) => k !== "artifactHash"),
      ),
    ),
    f.artifact.artifactHash,
  );
  for (const asset of f.artifact.assets)
    assert.equal(
      artifact.binaryHash(
        Buffer.from(
          f.media.find((x) => x.assetId === asset.id).base64,
          "base64",
        ),
      ),
      asset.sha256,
    );
});

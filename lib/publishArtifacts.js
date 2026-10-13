"use strict";
const { timingSafeEqual, createHash } = require("crypto");
const { collection } = require("./recordStore");
const db = require("./db");
const { canonical, hash } = require("./campaignArtifact");
const store = collection({
  table: "publish_artifacts",
  dir: "publish-artifacts",
});
function authorizeExport(header, credential) {
  if (
    typeof credential !== "string" ||
    credential.length < 32 ||
    typeof header !== "string"
  )
    return false;
  const expected = Buffer.from("Bearer " + credential),
    actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function fail(code, status = 422) {
  const e = new Error(code);
  e.status = status;
  throw e;
}
function createArtifactService({ binding, getDesign, freeze, render }) {
  if (
    !binding?.tenantId ||
    !binding?.credential ||
    binding.credential.length < 32
  )
    throw new Error("Export binding unavailable");
  if (process.env.NODE_ENV === "production" && store.backend !== "postgres")
    throw new Error("Hosted exports require PostgreSQL");
  let running = false;
  async function start(request) {
    if (
      !request ||
      Object.keys(request).sort().join(",") !==
        "designId,expectedUpdatedAt,requestId,schema" ||
      request.schema !== 1 ||
      !/^[a-f0-9-]{36}$/i.test(request.requestId) ||
      typeof request.designId !== "string" ||
      !/^[-a-z0-9]{1,100}$/i.test(request.designId) ||
      typeof request.expectedUpdatedAt !== "string" ||
      !Number.isFinite(Date.parse(request.expectedUpdatedAt))
    )
      fail("INVALID_EXPORT_REQUEST");
    const id = createHash("sha256")
        .update(binding.tenantId + ":" + request.requestId)
        .digest("hex"),
      fingerprint = hash(request);
    const previous = await store.get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        fail("IDEMPOTENCY_CONFLICT", 409);
      return { artifactJobId: id, state: previous.state };
    }
    const design = await getDesign(request.designId);
    if (!design) fail("DESIGN_NOT_FOUND", 404);
    if (design.updatedAt !== request.expectedUpdatedAt)
      fail("DESIGN_CHANGED", 409);
    const rec = {
      id,
      tenantId: binding.tenantId,
      fingerprint,
      state: "freezing",
      revision: 0,
      attempts: 0,
      leaseUntil: Date.now() + 125000,
    };
    const reservation = await store.reserve(rec, 20);
    if (reservation.status === "full") fail("EXPORT_QUEUE_FULL", 503);
    if (reservation.status === "exists") {
      if (reservation.record.fingerprint !== fingerprint)
        fail("IDEMPOTENCY_CONFLICT", 409);
      return { artifactJobId: id, state: reservation.record.state };
    }
    try {
      const frozen = await freeze(design);
      if (Buffer.byteLength(canonical(frozen)) > 2 * 1024 * 1024)
        fail("SNAPSHOT_TOO_LARGE", 413);
      if (Date.now() >= rec.leaseUntil) fail("SNAPSHOT_LEASE_EXPIRED", 503);
      if (
        !(await store.compareAndSwap(id, rec.revision, {
          ...rec,
          frozen,
          state: "queued",
          revision: 1,
          leaseUntil: 0,
        }))
      )
        fail("SNAPSHOT_LEASE_EXPIRED", 503);
    } catch (error) {
      await store.compareAndSwap(id, rec.revision, {
        ...rec,
        state: "failed",
        revision: 1,
        leaseUntil: 0,
        errorCode: error.status ? error.message : "SNAPSHOT_UNAVAILABLE",
      });
      throw error;
    }
    return { artifactJobId: id, state: "queued" };
  }
  async function get(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) fail("JOB_NOT_FOUND", 404);
    const rec = await store.get(id);
    if (!rec || rec.tenantId !== binding.tenantId) fail("JOB_NOT_FOUND", 404);
    return rec.state === "ready"
      ? rec.result
      : { artifactJobId: id, state: rec.state, errorCode: rec.errorCode };
  }
  async function runOne() {
    if (running) return;
    running = true;
    try {
      const records = await store.pending(binding.tenantId);
      const rec = records.find(
        (r) =>
          r.tenantId === binding.tenantId &&
          ["freezing", "queued", "rendering"].includes(r.state) &&
          r.leaseUntil < Date.now(),
      );
      if (!rec) return;
      if (rec.state === "freezing" || rec.attempts >= 3) {
        await store.compareAndSwap(rec.id, rec.revision, {
          ...rec,
          revision: rec.revision + 1,
          state: "failed",
          errorCode:
            rec.state === "freezing"
              ? "SNAPSHOT_LEASE_EXPIRED"
              : "RENDER_ATTEMPTS_EXHAUSTED",
        });
        return;
      }
      const claim = {
        ...rec,
        revision: rec.revision + 1,
        state: "rendering",
        attempts: rec.attempts + 1,
        leaseUntil: Date.now() + 125000,
      };
      if (!(await store.compareAndSwap(rec.id, rec.revision, claim))) return;
      let timer;
      const controller = new AbortController();
      try {
        const result = await Promise.race([
          render(rec.frozen, controller.signal),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("RENDER_TIMEOUT"));
            }, 120000);
          }),
        ]);
        if (hash(result.provenance) !== rec.frozen.designHash)
          throw new Error("FROZEN_INPUT_MISMATCH");
        await store.compareAndSwap(rec.id, claim.revision, {
          ...claim,
          revision: claim.revision + 1,
          state: "ready",
          leaseUntil: 0,
          result,
        });
      } catch (e) {
        await store.compareAndSwap(rec.id, claim.revision, {
          ...claim,
          revision: claim.revision + 1,
          state: claim.attempts >= 3 ? "failed" : "queued",
          leaseUntil: Date.now() + 5000,
          errorCode:
            e.message === "RENDER_TIMEOUT"
              ? "RENDER_TIMEOUT"
              : "ARTIFACT_RENDER_FAILED",
        });
      } finally {
        clearTimeout(timer);
      }
    } finally {
      running = false;
    }
  }
  async function runNext() {
    return db.enabled ? db.withRenderLock(binding.tenantId, runOne) : runOne();
  }
  return { start, get, runNext };
}
module.exports = { authorizeExport, createArtifactService };

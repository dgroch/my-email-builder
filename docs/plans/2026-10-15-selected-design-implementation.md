# Selected Design Fingerprint Implementation Plan

> For agentic workers: use superpowers:executing-plans inline, test-first, followed by one whole-change review.

Goal: refuse an export/import whose selected saved content changed, including unchanged timestamps.
Architecture: canonical SHA-256 projection shared by contract across Node builder and TypeScript engine; request hash and verified provenance bind both ends. No artifact schema change.
Tech stack: Node crypto, TypeScript, existing canonical serializers, node:test, Vitest/PostgreSQL.
Spec: 2026-10-15-selected-design-fingerprint.md (owner approved15October).
Constraints: no storage migration, no sends; preserve current approved installation; additional release remains concrete and gated.
Review focus: same-timestamp concurrent edits; missing fingerprints; reordered JSONB keys; legacy queued work; malicious/mismatched returned provenance. Tests below cover all five.

## Task1 — builder selection and export guard
- [ ] Add selectedDesignHash(design) projecting exactly id/name/updatedAt/subjectLine/previewText/campaign; missing optional text becomes empty string, missing campaign invalid. Golden fixture hash verifies independently across repositories.
- [ ] Add failing tests for same-time changed content rejection before freeze, canonical key ordering, array order, metadata exclusion, missing/malformed fingerprints and idempotency conflict.
- [ ] Expose designHash only on full saved responses in server.js; public/app.js requires hash and carries expectedDesignHash to engine.
- [ ] Require expectedDesignHash on protected export and compare against the selected snapshot before reservation. Clone selected design before any async freeze boundary.
- [ ] Run node --test focused tests then npm test. Commit builder implementation and regression tests.

## Task2 — engine propagation and independent acceptance
- [ ] Fresh engine fix branch from c1b926c. Add same projection/helper in packages/content/src/artifact.ts; use shared golden fixture.
- [ ] Require expectedDesignHash in BuilderImportRequestV1/startBuilderImport; preserve request JSON/idempotency semantics. Carry field through apps/web/src/pages/BuilderImport.tsx and packages/runtime/src/builder-bindings.ts.
- [ ] Add failing integration case returning valid artifact with different content fingerprint: no storage writes, artifact/campaign/revision creation; old queued missing hash fails closed. Include missing/malformed API command and key conflict tests.
- [ ] Verify provenance.design fingerprint before prepareArtifactAssets in runBuilderImport. Do not change artifact v1 schema.
- [ ] Run focused unit/PostgreSQL integration, type/lint/build and relevant full suites. Commit and publish paired draft PR.

## Task3 — review and installation continuation
- [ ] Independent read-only review of exact paired changes; one test-first fix pass for actionable findings.
- [ ] Rewrite PR43 description to final scope, record exact checks and limitations. No merge/deploy until exact release authorized.
- [ ] Owner confirmed staff sign-in and reply-to hello@figandbloom.com. Verify staff session via normal browser and incorporate reply mailbox in concrete native-draft configuration; remaining management credential/capacity/client proof gates persist.
- [ ] On authorized release reuse synthetic fixture for actual export/import, duplicate/stale and persistence tests. Record full installation evidence, roadmap/decisions and standalone Stage3 handoff.

Ledger: prior timestamp regression passed3280disk assertions+26tests; paired fingerprint work starts at builder315e556, enginec1b926c. User approved implementation and supplied reply mailbox; do not re-ask those questions.

Progress: builder and engine guards implemented. Red tests reproduced missing helper and same-time mismatch; engine mutation test without fingerprint comparison accepted mismatched/legacy content as ready, then restored guard passed all21focused tests. Type/lint/build passed; full suites in progress. Engine checkout /tmp/cee-selected-design-fix on codex/selected-design-fingerprint. No deployment.

Final local verification: engine Node24.21 full993passed/4existing skipped, type/lint/build passed; final PostgreSQL imports/routes19passed and Chromium4passed. Builder disk3282assertions+28tests/PostgreSQL3285assertions+28tests passed; added actual HTTP create/read fingerprint assertions pass. Independent paired review found no actionable introduced findings; hosted/release acceptance remains separate.

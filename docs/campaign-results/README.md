# Campaign results: local implementation and operator contract

Task: https://github.com/dgroch/business-os/issues/258. Goal `3a7548a6-3778-48ce-a5aa-984f67e861b6`.
Baseline: `b2b5bc2086c322b8de92632302dbd2f093fd5505`, dgroch/my-email-builder. Isolated Minisforum checkout, branch `codex/campaign-revenue-dashboard-20261102`. No campaign worker existed in this checkout; no pre-existing dashboard issue was found. CEE is the sending/receipt owner; this builder is the verified `emails.figandbloom.com` application.

## Status and decisions

Implemented and fixture-tested locally, **not deployed, not live accepted, not business-definition approved**. No send, schedule, provider write, purchase, production migration or existing dispatch change. The only existing product edits add a Results navigation link and an isolated read-only route handler. Results do not start a poller, worker or external read on page load.

Recommended v1 definition for Daniel: most recent verified non-bot commerce email click at or before paid time, within an inclusive seven-day lookback; deterministic click-ID tie-break for equal timestamps; one campaign per paid Shopify order. Opens, test sends/orders and cancelled orders excluded. Net revenue is successfully captured order total after discounts, including shipping/tax, less successful cash refunds; same shop currency, no currency conversion. Fully refunded orders still count as orders/purchasers, with zero net revenue. This measures attribution, not incremental lift. Daniel has **not agreed** these defaults. Cancelling a paid order excludes it under this provisional choice. Pending/partially paid orders are excluded until paid. Partial captures use the final successful capture time after Shopify marks the order paid.

Historical snapshots pin `last-qualifying-click-7d-paid-total-v1-provisional`. Unknown definitions fail closed, never silently reinterpreted. A later agreed definition requires a new version and explicit historical restatement decision. Seven days is a purchase lookback from each click, not automatically seven days after sending. Window closure therefore requires an authoritative `clickTrackingEndsAt` plus seven days and a complete source watermark. Without that input the UI stays provisional; later refunds can change closed results.

## Authorised access and deployment preparation

Existing builder has no general staff login. This addition uses **separate dedicated staff reporting bearer capabilities**, not the artifact-export credential. Configure protected `RESULTS_VIEW_CREDENTIAL` and, only for staff authorised for order evidence, `RESULTS_EVIDENCE_CREDENTIAL` (each 32+ characters). The latter also grants overview access. Staff enter their authorised capability on `/results`; it is held only in page memory, never browser storage or URL. Responses are `no-store`. Lock clears evidence and invalidates in-flight reads. Account-level SSO membership/provisioning remains a deployment integration choice, not implemented SSO. Do not distribute the evidence capability to aggregate-only staff.

Set `RESULTS_TENANT_ID` to the fixed deployment tenant and `RESULTS_SNAPSHOT_FILE` to an absolute, protected, persistent `latest.json` outside public/design-system directories. Unset source renders Unavailable; corrupt, unsupported or tenant-mismatched source returns 503, not zeros. No configuration or production installation has been performed. Render free ephemeral files are **not** durable storage: mount an approved persistent private path or supply a versioned file from the source owner's retained store before hosted acceptance. No spend or new storage plan was created here.

## Input and refresh workflow

`test/fixtures/campaign-results.js` is a complete **synthetic** schema example. Never install it as production evidence. Source owner supplies a canonical snapshot:

- `schema:1`, fixed `tenantId`, `definitionId`, `refreshedAt` (last fully successful reporting watermark), `shopCurrency`.
- `coverage.orders` and `coverage.refunds`, plus each campaign's `coverage.delivery` and `coverage.clicks`: explicit `complete`, `partial`, or `unavailable`. Declare complete only after native pagination/reconciliation, identity join and all competing campaign coverage are established. Completeness cannot be inferred from an empty API response.
- Campaigns: native stable ID/name/send timestamp/audience size, optional subject and frozen sent HTML. Optional authoritative tracking end. Include all potentially competing campaigns, not just the selected UI date range. Source IDs must be namespaced when multiple providers overlap.
- Events: stable native event/message/campaign/person IDs and UTC event timestamp; `sent`, `delivered`, `bounced`, `unsubscribed`, `clicked`, `opened`. Clicks require stable `linkId`, `verified:true`, `bot:false`, `linkPurpose:'commerce'`. These assertions must come from retained trustworthy evidence; a raw provider click does not by itself establish non-bot activity. Unknown bot/identity classifications do not qualify. Identity keys are opaque canonical joins, never guessed matching by send time. Preserve test classification on messages and campaigns.
- Orders: Shopify order ID, same verified opaque `personId`, paid timestamp, `paidMinor`, currency, paid/test/cancelled status, and successful/pending refund evidence with stable IDs, timestamps and amount in minor units. Retain older orders and their updated refunds, not just new orders.
- Optional `gaps`/campaign gaps and `refreshFailure` explain coverage failures. Never mark a failed refresh as successful. A still-readable last-good snapshot displays its retained age and optional failure; a broken current file fails closed.

Run explicitly, **not scheduled**:

```sh
node scripts/campaign-results-import.js /protected/normalised-snapshot.json /protected/reporting-history
```

Validation and full projection occur before replacement. Content-addressed immutable snapshots retain their definition; the private `latest.json` is atomically replaced. Replaying identical input is idempotent. No HTTP write/import endpoint is exposed. This file boundary is intentional: no speculative native engine endpoint or undocumented provider schema is trusted. The native CEE read-only adapter and exact source-identity join are now implemented, but remain **unconnected** to production. See [integration and deployment proposal](integration.md). Native recipient click observations lack qualifying-event evidence and remain separate directional counts.

Shopify read adapter, optional explicit operator use with protected existing credentials:

```sh
node scripts/campaign-results-shopify-read.js /protected/shopify-customer-to-person.json 2026-10-25T00:00:00Z /protected/shopify-delta.json
```

Uses `SHOPIFY_STORE_DOMAIN` (`*.myshopify.com`) and `SHOPIFY_ADMIN_API_TOKEN`. All requests are GET, bounded timeout, pagination constrained to same origin/API version with redirects rejected. Reads order transaction history, not mutable current price minus refunds twice. Authorisations/failed refunds excluded. Currency precision is exact. Returned updated-since delta is **partial**, not import-ready or full recovery. Reconcile by order ID against retained orders, preserve historical refunds and declare coverage separately before snapshot import. No automatic provider acquisition is enabled. Explicit CEE read-only acquisition is described in [integration.md](integration.md); it cannot infer qualifying clicks from recipient observations. Production source credentials never enter the browser or reporting snapshot.

## UI and scope

`/results` overview filters send dates (UTC, visibly labelled); sort by orders, net revenue or revenue per delivered (currency-grouped). Campaign detail includes a sandboxed sent preview, delivery/engagement table, delivered → unique qualifying clickers → attributed purchasers, purchase-day UTC net revenue table and restricted click/order/refund evidence. Preview blocks remote resources and scripts; external images are intentionally unavailable in this inert evidence preview. Rows show denominators and source timestamps; missing data is Unavailable, incomplete observed totals carry Partial coverage. No recipient-purchase correlation is included in attributed metrics. Optional separate recipient-purchases reporting is deferred.

## Verification and recovery

- `NO_PROXY=localhost,127.0.0.1 npm run test:results`: unit and actual HTTP integration.
- `NO_PROXY=localhost,127.0.0.1 CHROMIUM_PATH=/usr/bin/chromium npm run test:results:uat`: mounted application and real Chromium, desktop/mobile, no external requests. This is automated fixture acceptance, not Daniel's UAT or a production customer journey.
- `NO_PROXY=localhost,127.0.0.1 CHROMIUM_PATH=/usr/bin/chromium npm test`: existing complete builder regression suite plus results tests.

The loopback NO_PROXY override is necessary because this execution host proxies Node fetch by default; the unchanged export HTTP test reproduced the same transport failure before loopback was configured. External service proxy configuration stays intact.

See `recovery-20261102.md`: real read-only application mapping and Shopify aggregate source coverage recovered, but exact 1 November sent campaign, receipts and qualifying click ledger remain unverified. Do not infer missing data is permanently unrecoverable or turn store-wide order totals into campaign revenue. Resend authenticated access and engine staff record access need CTO/CMO resolution; no attribution business result is claimed.

## Integration follow-up

[Native source contracts, verified storage and staff-access deployment proposal](integration.md) describes the opt-in PostgreSQL store, manual acquisition/import commands and exact access gaps. `npm run test:results` now includes native contract tests. `RESULTS_TEST_DATABASE_URL` must target a scratch localhost PostgreSQL database for `npm run test:results:pg`. No source reads or schema migrations run on page load.

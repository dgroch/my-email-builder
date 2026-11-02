# Acceptance evidence, 2 November 2026

## Fresh execution on final implementation

| Command | Result |
| --- | --- |
| `NO_PROXY=localhost,127.0.0.1 npm run test:results` | 24/24: 20 unit/provider-replay cases and 4 real-HTTP/storage/authentication cases |
| `NO_PROXY=localhost,127.0.0.1 CHROMIUM_PATH=/usr/bin/chromium npm run test:results:uat` | 10/10 actual Chromium fixture-backed browser journeys; no page errors |
| `NO_PROXY=localhost,127.0.0.1 CHROMIUM_PATH=/usr/bin/chromium npm test` | 3,457 legacy disk assertions plus 84 Node tests, all pass, none skipped |
| `git diff --check` and `node --check` on new runtime modules | Pass |

Initial HTTP run failed because this host's default Node proxy intercepted loopback; unchanged export HTTP test reproduced the same error. Using NO_PROXY only for localhost/127.0.0.1 fixed the test transport. No product auth or provider transport policy was bypassed. Final logs retained alongside this document. No PostgreSQL schema was changed; PostgreSQL regression mode was not run. No production purchase, email send or browser customer journey was performed.

## Mapping to brief

| Brief / story | Fresh evidence | Remaining live or business evidence |
| --- | --- | --- |
| Campaign overview / fair comparison | Browser overview, send-date filter and labelled efficiency metrics. Unit denominators, currencies and global attribution before filtering | Production canonical campaign feed and provider identity joins not connected |
| Campaign detail / funnel | Real browser detail, delivery table, unique-person funnel, purchase-day net revenue table, sandboxed frozen preview | Actual sent-content snapshot and campaign records required |
| Trusted revenue | Last-click overlap, inclusive seven-day boundary, no-click recipient exclusion, tie-break, tests/bots/opens excluded; exact Shopify captures/refunds; multiple-page read replay | Daniel's agreed definition; actual source click qualification and transaction reconciliation |
| Authorised order evidence | Actual HTTP 401 without access, aggregate role omits evidence, evidence role returns click/order/refund lineage, cross-tenant rejection, no-store; browser restricted/evidence screens and lock race | Provision dedicated staff capability bindings or integrate existing SSO before hosted acceptance |
| Missing tracking / provisional results | Unit unknown versus partial versus true zero, competing-campaign coverage, watermark/window tests; HTTP corrupt/unconfigured failure; real browser unavailable/failure states | Full source watermarks, reporting cadence and persistent private source installation |
| Duplicate events / refunds | Same event/order/refund replay idempotent; conflicting evidence fails; refund arrival updates correct winner; fully refunded order remains count with zero net | Actual provider replay through retained feed |
| Historical definition | Version pinned in immutable content-addressed archive; unsupported versions fail; repeat import same hash; atomic latest replacement | Production private durable archive installation |
| 1 November recovery | Separate read-only live-source investigation retained in `recovery-20261102.md` | Exact native send/click ledger not accessible; unverified, not proven unrecoverable |

## Acceptance status

**Local implementation and automated fixture acceptance passed. End-to-end production acceptance remains NOT RUN.** An authorised user cannot yet view this new code on emails.figandbloom.com because nothing was merged/deployed. No business rule has been agreed by implication. The source adapters/contracts and file-backed read model are implemented; a native engine/Resend send-click ingestion integration, live identity map, private persistent snapshot source and staff authentication configuration are still unconnected. Do not call those steps complete or describe store-wide Shopify order totals as campaign results.

## Remaining concrete decisions / next work

1. Daniel: agree the displayed proposed definition (seven-day last qualifying non-bot commerce click, captured total including shipping/tax less successful refunds, cancelled/test orders excluded, equal-time deterministic tie-break, paid time at final capture). Decide whether a later agreed rule restates old snapshots.
2. CTO with CMO: obtain authenticated read access to the actual 1 November engine/Resend campaign and retained receipts/clicks; produce native stable IDs and identity-joined source snapshots. Resend MCP reports OAuth required; engine campaign API returns login required. Existing Shopify read access is working. Do not ask Daniel for Shopify credentials again.
3. CTO: select existing authorised persistent private storage and staff access binding, then exercise a genuine retained click → paid Shopify order → later refund replay without sending or purchasing.
4. Parent: independently review exact commit. Merge/deploy require Daniel's separate explicit authority. No push, PR, merge, deploy or activation performed by this implementation task.

Browser artefacts: `uat/overview-desktop.png`, `uat/detail-evidence-desktop.png`, `uat/detail-mobile.png`, `uat/results.json`. Screenshots contain synthetic data only. Human business UAT has not been claimed.

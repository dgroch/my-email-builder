# Observed provider-receipt reporting

Issue business-os#258. Local reporting adapter, not a live import/deployment. Sending paths are unchanged. This is independent of native publication acquisition: no publication, customer, audience, intent or Shopify source binding is inferred or required.

## Source and contract

`lib/campaignResultsReceipts.js` uses the deployed CEE `37c081a39c01f02cc5d3e5cfb85982ab00b878b9` `provider_receipts` contract: migrations005 (base ledger),016 (text provider ID/account),020 (tenant/provider/account/event PK),038 (`received_at`),150 (`broadcast_id`). SQL filters exact tenant, provider `resend`, account and non-null broadcast UUID. It uses one repeatable-read read-only transaction and transaction-local tenant RLS context. No joins, reconciliation, provider calls or writes. Only status aggregates leave the database, not destinations, event/message IDs, webhook bodies or customer records.

Each supported status (`accepted`, `delivered`, `bounced`, `complained`, `suppressed`) counts **distinct provider message IDs within that status**, not unique recipients. Duplicate status events collapse; the same message can appear in multiple statuses. Never sum status populations. Missing stored status rows produce observed zero, not a provider completeness claim. Unknown imported aggregate counts remain null.

Retained history and optional receipt-occurrence window are separate populations. Window start is inclusive, end exclusive. Both `occurred_at` and `received_at` must be at or before the transaction watermark. Window results are observed as of that same read, not counts historically available at window end and not a cohort of messages sent within that window. Later queries may change historical counts due to late receipts/retention. No exhaustive provider totals or retention completeness is claimed.

The campaign row is anchored only by a retained acceptance receipt. Its date is explicitly labelled **First retained acceptance receipt**, not configured launch/native publication time. Without an acceptance anchor the exact scope returns no campaign; this does not mean the provider never sent. Null/unbound broadcasts cannot be attributed to this scope. Unknown test classification stays unknown, not `test=false`. Subject, content, audience, identity, native binding, qualifying clicks and revenue remain unavailable. Receipt campaigns reject imported recipient events, native metadata and upgraded click coverage. They cannot provide attribution evidence.

Snapshot `providerReceipts` carries provider/account/broadcast identity, observed coverage, as-of precision/source, five retained status aggregates and optionally five window aggregates. Timestamp extrema may be null when not recovered. Counts do not appear for a projection before their aggregate as-of watermark. The current adapter replaces a reporting snapshot for this exact broadcast only; it does not merge native/provider histories or deduplicate a combined native/provider inventory. Do not combine independently acquired campaign rows without a separately verified relationship.

## Manual acquisition and import

Use an already-authorised database read route. The verified allowed-network Render SSH route is documented externally in `allowed-network-recovery.md`; no network/access changes are part of this implementation. Protected bindings:

- `CEE_REPORTING_DATABASE_URL`, with certificate verification for remote connections
- `RESULTS_TENANT_ID`: exact tenant UUID
- `CEE_RECEIPT_ACCOUNT`: exact provider account
- `CEE_RECEIPT_BROADCAST_ID`: exact broadcast UUID

```sh
node scripts/campaign-results-receipts-read.js /private/observed-candidate.json 2026-10-31T13:00:00Z 2026-11-01T13:00:00Z
# Omit both date bounds for retained-only reporting.
# Explicit existing importer, after examining candidate coverage:
node scripts/campaign-results-import.js /private/observed-candidate.json /private/local-reports
# Or existing reporting PostgreSQL importer, once its schema is installed:
node scripts/campaign-results-pg.js import /private/observed-candidate.json
```

Acquisition writes a non-existing absolute file exclusively, mode0600. It never installs the candidate, schedules refreshes, accesses provider APIs or changes roles. stdout contains only aggregate campaign/coverage indicators; errors omit source credentials. Existing immutable archives, tenant/watermark protections, staff role separation and rollback apply unchanged. No production acquisition/import was run for this change.

## Recovered aggregate fixture

`test/fixtures/campaign-results-recovered-receipts.js` transcribes the observed aggregate recovery report for broadcast `ef90b61c-bb72-45b9-a859-9c4382831026`, account `resend-figandbloom`. It is neither a fabricated message ledger nor a live dashboard import. Retained counts: accepted31,245, delivered31,202, bounced52, complained3. Melbourne1 November window: accepted31,245, delivered30,548, bounced34, complained0. Suppressed counts and unrecovered timestamp extrema remain null.

The report gives a read interval of2 November14:30–14:50 AEDT, not an exact database watermark. The fixture records03:50Z as an explicitly labelled **upper bound**, never as exact query time. Actual acquisition uses the transaction watermark with exact precision. No person IDs, destinations or secrets are in the fixture. Browser acceptance mounts this aggregate through the real importer and HTTP/UI. PostgreSQL tests use separate clearly synthetic messages to verify source SQL, duplicate/overlap semantics, account/tenant/broadcast isolation and occurrence/received timestamp boundaries. These checks are implementation-owner verification, not independent review or live business acceptance.

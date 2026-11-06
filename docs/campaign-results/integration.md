# Native integration and deployment proposal

Update, 2 November 2026: allowed-network read-only acquisition has since succeeded. Native publication records were empty for the recovered broadcast. The separate [observed provider-receipt adapter](provider-receipts.md) supports its retained ledger without inventing native bindings. The read-route section below is historical investigation evidence, not the current network blocker. No deployment or live import is implied.

Issue business-os#258. Prepared 2 November 2026. Local code only, no deployment, source import, sends, scheduling or paid service creation. Definition remains explicitly provisional.

## Verified contracts, not invented events

Render reports CEE API `srv-db41bcui0phs73ekfegg` live at `37c081a39c01f02cc5d3e5cfb85982ab00b878b9`; builder `srv-d8dtg2cm0tmc73ea5fg0` remains at `b2b5bc2086c322b8de92632302dbd2f093fd5505`. Source inspected from the existing CEE checkout at `/home/dan/Code/cee-pr48-fresh-rereview-20261102/head`, using `git show` for the deployed revision. The referenced contracts are unchanged between deployed CEE and that checkout:

| Contract | Actual source | Adapter treatment |
| --- | --- | --- |
| Publication and frozen members | migrations `122-broadcast-publications.sql` | Namespace by publication, join campaign and pinned revision. No draft becomes a sent campaign. Audience remains unknown rather than calling approved maximum the actual send count. |
| Observed broadcast send | `144-broadcast-operation-observations.sql`, operation attempts | Require sent status, send action and matching tenant/account/broadcast/publication. Preparation or bulk acceptance is not a per-message sent event. |
| Native email outcomes | `151-broadcast-outcomes.sql` | Join email binding, account, publication, contact and frozen customer. Accepted → sent, delivered → delivered, bounced → bounced. Complaints/failures are not relabelled as unsubscribes. |
| Recipient API observations | `153-broadcast-recipient-scans.sql`, `154-broadcast-recipient-matches.sql`, `packages/providers/src/resend-broadcast-recipients.ts` | Distinct matched contacts per type. Store directional aggregate observations separately, never fabricate message/link IDs or occurrence time from row cursors/scan timestamps. |
| Explicit Shopify identity | `002-identity-policy.sql`, `packages/sources/src/shopify.ts` | Exact configured source ID and `gid://shopify/Customer/<digits>` mapping to CEE canonical customer. Exclude deleted/merged identities; unsupported/ambiguous mappings fail. No email, name or timestamp correlation. |

Native recipient clicked rows contain cursor, optional contact ID, destination and count, **not click occurrence time, link identity, link purpose or bot classification**. Native webhook outcomes do not include click events. This source cannot alone satisfy the proposed attribution definition. All CEE-generated candidates therefore retain `coverage.clicks=unavailable`, revenue/purchasers/qualifying clickers unavailable, and a visible explanation. Directional counts are not unique qualifying clickers. Native test-send classification is also not established. No claim of complete source recovery, non-bot detection or live identity coverage is made.

## Manual acquisition, no sending dependency

`lib/campaignResultsCee.js` reads retained PostgreSQL facts inside one `REPEATABLE READ READ ONLY` transaction, fixed tenant, 30-second per-statement timeout. SQL names and columns are grounded in the deployed schema above. No call imports the CEE runtime or dispatch code. There are no provider API writes or native reconciliation calls.

```sh
node scripts/campaign-results-cee-read.js /private/candidate.json
# Optional bounded Shopify updated-since delta using exact source identities:
node scripts/campaign-results-cee-read.js /private/candidate-with-orders.json 2026-10-25T00:00:00Z
```

Required protected bindings: `CEE_REPORTING_DATABASE_URL`, `RESULTS_TENANT_ID` (CEE tenant UUID), `CEE_SHOPIFY_SOURCE_ID` (actual native registered source ID, not guessed). Optional Shopify read uses existing `SHOPIFY_STORE_DOMAIN` and `SHOPIFY_ADMIN_API_TOKEN`. Files must be absolute, non-existing private output paths; creation uses exclusive mode0600. Identity map exists only in process memory, never stdout or its own file. Stdout is aggregate counts only; failures do not print database/provider errors or credentials. A candidate is not automatically installed.

Optional Shopify read is still a **delta**, not full retained historical orders/refunds. Do not replace a historical candidate with only a recent delta and declare complete coverage. Historical merge/reconciliation and all competing campaigns remain outstanding. CEE-only data is explicitly labelled incomplete against Klaviyo and individual sends.

## Existing storage and exact proposed configuration

Render's existing `email-builder-db`, `dpg-da6p6lou01pc738s174g-a`, is available on `basic_256mb` in Oregon. Its protected `DATABASE_URL` is already configured in the builder. A TLS-certificate-verified read-only connection succeeded. The blueprint's old `free` description is not the current inventory. **Reuse this database; do not apply a new blueprint or buy storage.** No production schema changes were performed.

`lib/campaignResultsStore.js` adds an opt-in durable backend with separate lazy connection handling and certificate verification enabled for remote hosts. It does not call the existing builder `db.ready()` or its automatic migrations. Page loads run SELECT only. Body hash is verified on read. Content-addressed archive bodies cannot be updated/deleted through ordinary SQL because of an immutable trigger. Tenant-specific current heads are updated atomically with the archive insertion. Transaction locks prevent concurrent older imports from winning; equal-watermark conflicting content fails. Identical replay is idempotent. Unsupported/corrupt/wrong-tenant snapshots fail closed without zero inference or silent fallback.

Proposed deployment environment (values populated only in the protected service store):

| Setting | Proposal |
| --- | --- |
| `RESULTS_STORAGE` | `postgres` |
| `RESULTS_DATABASE_URL` | Existing builder database, preferably a dedicated SELECT-only reporting connection for the web process. The existing `DATABASE_URL` is an explicit fallback only after `RESULTS_STORAGE=postgres`. |
| `RESULTS_TENANT_ID` | Verified fixed CEE tenant UUID, not browser input |
| `RESULTS_VIEW_CREDENTIAL` | Separate random32+ character staff aggregate capability |
| `RESULTS_EVIDENCE_CREDENTIAL` | Different random32+ character capability, only for order-evidence staff |
| `RESULTS_SNAPSHOT_FILE` | Unset for PostgreSQL, retain old file config privately for rollback if previously used |

Staff capabilities grant only reporting reads, not sending or builder export. They remain page-memory only; no browser storage, URLs or logs. Sharing a capability is not individual SSO/auditable membership. Named staff distribution and optional reverse-proxy/SSO integration remain deployment decisions; existing CEE OIDC cookies are not portable to builder. Do not reuse its send/editor/operator session or export key.

After authorised deployment, the separate migration invocation uses the existing database owner. The importer uses a writer connection, never the web viewer's connection:

```sh
node scripts/campaign-results-pg.js migrate
node scripts/campaign-results-pg.js import /private/validated-candidate.json
```

Suggested privileges on the two new tables only: web reporting role SELECT on snapshots/heads; importer SELECT,INSERT on snapshots and SELECT,INSERT,UPDATE on heads; schema ownership/migration held by the existing database administrator. No runtime UPDATE/DELETE on archive and no source-system write grants. CEE source reader needs SELECT on only the tables listed in `SQL`, connection permission and the tenant RLS policy applicable to its dedicated role. The source reader is never the dashboard's web credential. No production roles or grants were created.

Installation sequence: retain current deployment/config references; apply schema once with operator connection; validate native source binding on CEE's allowed network; generate a candidate and inspect only aggregate coverage; explicitly import; configure web reporting read access; deploy the exact reviewed builder SHA; check unauthenticated401, viewer overview/no evidence, evidence-role detail, wrong-tenant503, persisted history after restart and failed-refresh last-good preservation. No cron is supplied or enabled. This sequence still needs Daniel's merge/deploy approval; no new gate is introduced by this document.

Rollback: restore prior builder deployment and remove the reporting environment bindings. Preserve snapshot history and existing application tables. Do not drop or rewrite reporting evidence. To correct data, import a newly validated snapshot with a strictly later watermark; never mutate old archives.

## Read routes checked and next recovery owner

- Service catalogue gateway egress substitution used for Render REST. No credentials printed or copied to files.
- Render service/env-variable names, secret-file names and database inventory were readable. Protected provider credentials were consumed only in memory for GET probes.
- CEE external PostgreSQL connection terminated twice during connection establishment. Database is available but its allowlist contains a temporary setup operator and Render Singapore egress, not a world-open rule. No firewall/config modification attempted. CTO can run this same read-only adapter from the already-allowed CEE network, or provision a narrowly scoped source read connection. A new paid service is not needed.
- Resend MCP remains unavailable due to OAuth, but this was not treated as exhaustion. Existing API `consent-resend.key` file content was not a usable raw Resend key; GET `/broadcasts` returned400 `validation_error / API key is invalid`. Existing worker `resend-send.key` was accepted as a key but GET `/broadcasts` returned401 `restricted_api_key / This API key is restricted to only send emails`. It was not used to send. CMO/CTO must supply an existing reporting/full-read key or acquire retained native records through the permitted CEE database route. Do not broaden the send-only key or activate the send path.
- Canonical CEE staff API401 and provider OAuth were already documented in `recovery-20261102.md`. Deployed source confirms staff OIDC in-memory sessions, not an undocumented reporting bearer endpoint. No fixture login or impersonation was attempted.
- Shopify aggregate read access was previously verified. This follow-up does not need new Shopify credentials and has not recovered actual Shopify-to-CEE identity rows.

The specific1 November send, customer identity coverage and qualifying click history remain **unverified**, not proven irrecoverable. Local fixture replay replaces identities with synthetic values and verifies real source column/response contracts. It is not a redacted live campaign replay, because no native customer ledger was acquired. Parent retains the goal and dispatches exact-SHA independent review separately.

### Retained local file importer

File imports serialise through an atomic `.import-lock` directory, recheck the current tenant and watermark while locked, reject stale/equal-conflicting candidates and preserve the prior head on failed publication. Concurrent importers wait up to five seconds, then fail without publishing; retry explicitly. A crashed importer may leave the lock: confirm no importer is running before manually removing that directory. Locks are never automatically stolen. A corrupt current head fails closed; restore a verified archive explicitly before importing. This backend is intended for a local filesystem with atomic directory creation and rename, not distributed/network filesystems. PostgreSQL remains the durable deployment proposal.

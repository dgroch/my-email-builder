# Native Resend Broadcast publishing through the engagement engine

**Approved flow scope, 13 October 2026:** Dan curated the live list in Klaviyo and instructed “approve them all”. The approved porting baseline is the **27 live flows** in the latest refetch, recorded by source ID in the [flow transfer register](https://github.com/dgroch/customer-engagement-engine/blob/main/docs/migrations/klaviyo-flow-transfer-register.md). The nine draft flows, one manual flow and ten historical live candidates absent from that refetch are outside porting scope. Actual data migration remains required, including explicit disposition of historical records and pending obligations. Newly live flows or material behavior changes need a new scope decision. This approval permits recording the migration scope; it does not activate sending or independently approve retirement of a retained flow.

Proposed integration, 13 October 2026. Dan selected native Resend Broadcasts with the engagement engine managing approval and audience eligibility. This is a documentation change; no provider connection, contact import or send is performed.

The principal specification and build plan live in `dgroch/customer-engagement-engine`:

- [Migration architecture](https://github.com/dgroch/customer-engagement-engine/blob/main/docs/superpowers/specs/2026-10-13-klaviyo-retirement-and-broadcasts-design.md)
- [Cross-repository build plan](https://github.com/dgroch/customer-engagement-engine/blob/main/docs/superpowers/plans/2026-10-13-klaviyo-retirement-and-broadcasts.md)
- [Actual data and active flow migration execution plan](https://github.com/dgroch/customer-engagement-engine/blob/main/docs/superpowers/plans/2026-10-13-klaviyo-data-and-flow-migration.md)
- [Per-flow transfer acceptance register](https://github.com/dgroch/customer-engagement-engine/blob/main/docs/migrations/klaviyo-flow-transfer-register.md)
- [Builder campaign artifact v1](https://github.com/dgroch/customer-engagement-engine/blob/main/docs/contracts/builder-campaign-artifact-v1.md)

The engine owns the contract and migration register on its main branch. Do not maintain a competing audience/consent/scheduling system here.

## Required programme scope

The owner requires three delivered outcomes: native campaign publishing, porting **every approved live Klaviyo flow**, and **executing the Klaviyo data migration**. The engine plan includes actual exports, protected rehearsal, production import, ongoing deltas, per-flow cutover and final reconciliation/archive. Profiles, custom properties, consent/suppressions, list/segment rules and membership, required history, actual templates, in-progress journeys and issued benefits all receive an explicit migration disposition. Scripts, a generic flow runtime and a Resend contact upload do not establish completion.

Flows continue through individual Resend email and Twilio SMS routes under engine policy. Porting includes their real triggers, filters, waits, branches, exits, content and non-message actions, plus customers already partway through them. Preserve Birthday Club's existing product/scheduling ownership. The flow tracker records the 27 live source IDs in Dan’s curated, approved list. The 37-flow audit is historical; newly live flows require a new scope decision.

The builder's campaign artifact v1 is fixed creative content with a typed legal-footer slot. Dynamic flow templates use a separate engine-owned `FlowTemplateV1` with verified profile/event/catalog/issued-benefit inputs and explicit missing-value behavior. Do not put arbitrary Klaviyo Liquid or coupon generation into the campaign artifact. Any later builder authoring support for flow templates must adopt that contract explicitly; actual flow porting is already required in the engine workstream.

## User workflow

Save a design, select **Publish to Resend**, and open the authenticated engine import screen. The engine imports a frozen copy, creates an unsent native Resend draft, and presents audience selection, exclusions, approval, scheduling and results. The design remains editable here; later edits create a new campaign revision and require fresh approval. The engine keeps the enduring artifact, asset URLs and provider linkage.

The initial handoff is a top-level navigation to the configured engine origin with saved design ID and expected update timestamp. Navigation itself does not write. The engine's CSRF-protected editor action initiates a dedicated authenticated export job here. This avoids granting a currently unauthenticated builder route a privileged provider credential. No customer lists, approver role or sending key enter the builder. Existing `approvalStatus` remains editorial metadata, not engine send permission.

## Builder work

| Area | Change |
| --- | --- |
| `server.js` | Extract reusable publishing assembly; add service-authenticated export-job start/result endpoints; leave provider release in the engine |
| New `lib/publishAssembly.js` | Compose optimised per-block slices, columns, GIFs and supported live fragments without coupling to Klaviyo upload |
| New `lib/campaignArtifact.js` | Freeze resolved design/component/brand inputs; emit versioned rows/media/hash/subject/preheader/plain text and one legal-footer slot |
| New `lib/publishArtifacts.js` | Persist snapshot/job identity via `recordStore`, enforce idempotency/auth/bounds, recover interrupted rendering from frozen inputs |
| `lib/render.js`, `lib/validate.js` | Preserve current quality checks; add explicit artifact handling and reject unsupported provider-specific/dynamic blocks |
| `lib/klaviyo.js` | Reuse extracted row composition during coexistence; keep legacy publishing behavior until its route is retired |
| `public/app.js`, `public/index.html` | Add the configured engine handoff with stale-design protection and a clear draft outcome |
| `test/run.js`, new `test/fixtures/artifact-v1/` | Hash, GIF/columns, footer, auth, duplicate/restart, unsafe markup and stale-version regressions |

Preserve 600px composition, supported mobile/Outlook behavior, image-weight/glyph checks, per-block links and meaningful alt/plain text. Host new publication assets permanently in the engine-owned object store/CDN; do not use Klaviyo uploads, data URLs, temporary Render files or expiring recipient-facing URLs. Convert only the known legal footer into a typed slot. Unsupported Liquid/coupons/profile personalisation must be reported, not silently rendered incorrectly.

The current engine HTML renderer does not accept this builder's layout: it rejects inline CSS and strips tables. The new `email-table-v1` contract therefore has its own narrow engine validator/compiler. The engine generates the shell and the live Resend unsubscribe footer. Do not send raw exported HTML into the existing renderer or disable its protections.

## Integration acceptance and rollout

Pin the engine contract version and copy its synthetic compatibility fixtures. Verify the same saved design at 390px/600px through builder export and engine preview, including GIF columns, preheader, legal footer and links. Tests must prove that editing a component/brand after import cannot change the older artifact. Run `npm test`, whitespace checks and paired browser verification; no actual campaign sending is required to validate the builder change.

First deliverable: an authenticated, idempotent, visually verified design-to-engine import and unsent native draft. Engine readiness covers the provider/account capabilities. Later engine tasks add contact/topic projection, final audience checks, local scheduling, native release/cancel and receipt reconciliation. Full Klaviyo retirement also covers forms, consent/history authority, all retained SMS and journeys, coupons, stock subscriptions, pending steps and historical links/assets; see the principal migration specification.

The existing Klaviyo audience picker and `lib/liveContext.js` audience context must eventually read engine audience definitions. Make that a separate compatibility change after the engine exposes its versioned definitions; generator context receives names/rules, never permission to select recipients or send. Remove Klaviyo keys/calls only after all builder dependencies are accounted for and the legacy workflow is explicitly retired.

## 13 October implementation checkpoint

The first local preparation slice is on `codex/engine-artifact-publishing`; [scope/checks](publishing-slice.md) records the paired engine branch and limitations. Frozen export now captures supported image/background/CSS resources and blocks uncaptured render requests. The engine remains the approval/audience/provider owner. Neither repository has installed this publishing path in hosted operation. The source-flow and actual-data migration workstreams remain separately unfinished.

## 14 October installation continuation

The [concrete paired installation operation](https://github.com/dgroch/customer-engagement-engine/blob/codex/klaviyo-broadcast-publishing/docs/operations/publishing-installation.md) prepares a dedicated campaign asset host/private R2 bucket/read-only gateway, protected export credential, worker-only publishing binding and exact unsent readback sequence. Existing Namecheap and media-library configuration is preserved. Compatible engine release precedes enabling builder navigation; hosted PostgreSQL persistence and preservation of existing designs/components/brand are required. Deployment/configuration authority and actual installed pipeline verification remain distinct from the local tests and connector-only draft probe.

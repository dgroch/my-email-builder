# Fig & Bloom — Email Builder

A local token-editor **UI + render server** for building on-brand Fig & Bloom campaign
emails from the locked design-system templates. Pick blocks, fill their tokens in a form
that **generates itself from the templates**, watch a live preview, then rasterise a
production-accurate PNG with Puppeteer — the same pipeline the campaigns ship through.

![overview](docs/ui-overview.png)

## Why this instead of a drag-and-drop builder
The design system has three hard constraints generic builders (Unlayer / GrapesJS / Stripo /
MJML) fight: **custom fonts** (Cervanttis / Lust / NeuzeitGro), **designed blocks that must be
rasterised to PNG** (rotate/overlap/script-over-serif don't survive as live email HTML), and
**locked palette presets + case rules**. This tool is built around those constraints instead
of against them, and the form **auto-syncs** with the templates because every token is already
self-described in each template's `<!-- COMPONENT … TOKENS: … -->` header.

## Quick start
```bash
npm install        # installs puppeteer (downloads a Chromium)
npm start          # serves http://localhost:4321
```
Then open <http://localhost:4321>, click **Sample** to load the “When the card is the hard
part” campaign, and start editing.

> If you already have a system Chromium, set `CHROMIUM_PATH=/path/to/chromium` to skip the
> puppeteer download (`PUPPETEER_SKIP_DOWNLOAD=1 npm install`).

## Deploy to Render.com
The repo ships a `Dockerfile` (Node + system Chromium) and a `render.yaml` Blueprint, so the
PNG renderer works in the cloud with no code changes. Render injects `$PORT` automatically.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/dgroch/my-email-builder)

1. Push this folder to your GitHub repo (see below) — Render deploys from Git.
2. In Render: **New → Blueprint**, pick the repo. `render.yaml` is auto-detected (free plan,
   Docker, health check `/`). Click **Apply**.
3. First build takes a few minutes (it installs Chromium). You get a public `*.onrender.com` URL.

Notes: the **free** plan spins the service down after inactivity, so the first hit after idle
is a slow cold start — fine for an internal tool. Unlike a sandboxed environment, Render has
normal outbound internet, so the PNG renderer loads your CDN product images correctly.

To get the code into your repo first:
```bash
unzip my-email-builder.zip && cd my-email-builder
git init && git add . && git commit -m "Fig & Bloom email builder"
git branch -M main
git remote add origin https://github.com/dgroch/my-email-builder.git
git push -u origin main
```

## What it does
- **Auto-generated forms** — fields, help text, palette-preset dropdowns, layout-lever
  enums and `lowercase` / `Sentence case` chips are all parsed from the template headers +
  `design-system/manifest.json`. Add a new template and it appears automatically.
- **Live preview** — assembles the real shell (fonts embedded) and shows it in an iframe.
- **Component library** (the **Library** tab) — every component rendered *alive* with on-brand
  sample data (no fields to fill), with live **palette + lever** switching, a **variant-compare**
  strip (all palette presets / lever options side-by-side), search/filter (group, objective,
  designed-only, drafts-only), per-component intent, **Copy JSON**, and a **Coverage & gaps**
  lens that maps objectives → components and surfaces DRAFT blocks, missing intent and orphans
  to drive new/extended components. Sample data is the single source of truth in
  `lib/sampleData.js` (the test suite asserts every component renders a clean, fully-filled sample).
- **Render PNG** — rasterises designed blocks exactly like the production `slice.js`.
- **Slices** — rasterises **one PNG per block** and bundles them as a `.zip`, so you can drop
  each block into its own Klaviyo image block (each with its own link/alt) instead of pasting
  one giant PNG.
- **Push to Klaviyo** — creates a **draft** campaign in Klaviyo straight from the builder
  (template + campaign + message, all draft — nothing is ever sent).
- **Saved designs** — **Save** a design to the server and reopen, **clone** or delete it later
  from **My designs**. Click a block in the preview to jump to its card on the left.
- **Case validation** — warns + one-click fixes Cervanttis/Lust case violations as you type.
- **Import / Export** — round-trip a `campaign.json`, or export the assembled HTML.

## Layout
```
server.js                 zero-dependency HTTP server (UI + /api/{schema,assemble,render,render-slices,export,klaviyo-draft,designs})
lib/parseTemplates.js     derives the token schema from templates + manifest
lib/render.js             assembles the shell and rasterises (full PNG + per-block slices) via Puppeteer
lib/klaviyo.js            pushes the assembled HTML to Klaviyo as a draft campaign
lib/designs.js            designs backend: local-disk JSON store (fallback)
lib/notionStore.js        designs backend: Notion database store (used when NOTION_TOKEN is set)
public/                   editor UI (index.html, app.js, style.css)
design-system/            bundled copy of the template library, shells, fonts, assets, manifest
```

## API
| Method | Path | Body | Returns |
|---|---|---|---|
| GET  | `/api/schema`   | — | components + tokens (types, presets, case rules), per-component **intent** metadata, a `draft` flag, ordering & token rules, and the campaign **objectives** taxonomy |
| GET  | `/api/gallery`  | — | `{components:[{name, group, designed, static, draft, sampleTokens, variants}]}` — every component with a complete set of on-brand **sample tokens** + its variant axes (palette presets + first enum lever). Powers the interactive **component library** |
| POST | `/api/assemble` | `{campaign, markBlocks?}` | `{html, unfilled, validation}` — assembled preview HTML (`markBlocks` adds `data-eb-block` anchors); `validation` is the structured report (see `/api/validate`) |
| POST | `/api/validate` | `{campaign}` | `{ok, errorCount, warningCount, blocks, issues}` — actionable validation **without rendering** (unknown/bare component → group-prefixed suggestion, casing violations, unfilled tokens) |
| POST | `/api/render`   | `{campaign}` | `{pngBase64, brokenImages, height}` |
| POST | `/api/render-slices` | `{campaign}` | `{slices:[{index, component, width, height, pngBase64, link, keepHtml}], brokenImages}` |
| POST | `/api/export`   | `{campaign}` | `{html, unfilled, campaign}` (HTML keeps `{{ASSETS_BASE}}` + Klaviyo tags) |
| GET  | `/api/klaviyo-audiences` | — | `{lists:[{id,name}], segments:[{id,name}]}` for the audience picker |
| POST | `/api/klaviyo-draft` | `{campaign, listId, fromEmail, fromLabel?, replyToEmail?, subject?, previewText?, links?}` | `{campaignId, messageId, templateId, editUrl, sliceCount}` — draft built from uploaded per-block slices |
| GET  | `/api/examples` | `?objective=` (optional) | `{examples:[…]}` — approved exemplars (designs flagged `isExample` + committed seeds), each with full `campaign` + metadata |
| GET  | `/api/designs`        | — | `{designs:[{id, name, createdAt, updatedAt, isExample, objective, approvalStatus, componentsUsed, …}]}` (metadata only) |
| POST | `/api/designs`        | `{name?, campaign, …metadata}` | the saved design (incl. metadata) |
| GET  | `/api/designs/:id`    | — | the full saved design |
| PUT  | `/api/designs/:id`    | `{name?, campaign?, …metadata}` | the updated design |
| POST | `/api/designs/:id/clone` | `{name?}` | a new design copied from `:id` (starts as a fresh draft, not an example) |
| DELETE | `/api/designs/:id`  | — | `{ok:true}` |

A `campaign` is `{ campaignName, bodyBg, blocks:[{ component, tokens:{…}, palette? }] }`.

### Inline formatting in token values

Text tokens accept a tiny inline-markdown subset so you can emphasise words — e.g. make
bouquet names bold — without touching templates: `**bold**`, `*italic*`, and
`[text](https://link)`. Escape a literal marker with a backslash (`\*`). Formatting renders in
visible text and in the rasterised PNG/Klaviyo output, but is automatically flattened to plain
text where a token feeds an HTML attribute (e.g. image `alt`). The schema marks which tokens
support it with `markdown: true` (text tokens only — not URLs, colours, or enum levers), and the
builder shows a **markdown** chip on those fields. See `lib/markdown.js`.

### Agent-facing metadata

`/api/schema` carries two additive layers that help an agent reason about component choice
from the contract itself (sourced from the shared table in `lib/componentStrategy.js`, the
builder-side mirror of `references/component-strategy.md` in `dgroch/skills` — keep the two in
sync):

- **Per-component intent** — optional `bestFor` / `avoidFor` (objective ids), `visualRole`,
  `requiresImage`, `imageRatio`, `tone`. Components without an entry simply omit these keys.
- **`objectives`** — the canonical campaign-objective taxonomy (`farewell_sellthrough`,
  `range_launch`, …, plus the recurring `editorial_digest` monthly newsletter) with a
  recommended block sequence, hero options, proof modules, CTA style, urgency, modules to
  avoid, and a set of restrained `subjectPatterns` (subject-line templates) per objective.

**Design metadata** (persisted on every saved design, parity across the disk + Notion
backends): `isExample`, `objective`, `campaignType`, `audienceAwareness`, `primaryCTA`,
`subjectLine`, `previewText`, `emotionalTone`, `approvalStatus` (`draft`|`approved`|`sent`),
`componentsUsed` (derived), `sourceBriefLink`, `klaviyoLink`, `resultNotes`. Flag a design
`isExample:true` to surface it through `/api/examples`. The persisted `subjectLine` /
`previewText` are used as the fallback subject/preview when `/api/klaviyo-draft` is called
without them. See *Saving designs* for how the Notion backend stores these.

> **Note — `/api/agent-contract` was intentionally not built.** The execution contract is
> `/api/schema` (now including intent + objectives) and the workflow rules live in the skill;
> a second contract source would only add drift risk. See `docs/backend-tasks.md`.

## Tests
`npm test` (zero-dependency runner). It asserts the two standing guardrails — every
`/api/schema` component `name` resolves to a real template file, and every `isExample` design
assembles with zero `(missing template)` and zero unfilled tokens — plus the intent/objective
table integrity and the validation behaviour.

## Saving designs (persistence)
**Save** stores the current design; **My designs** lists them to reopen, **clone**, or delete.
Clicking a block in the live preview scrolls to and highlights its card in the builder. There are
two interchangeable backends (same `/api/designs` API) — the server picks one at startup and logs
which:

### Notion database (recommended — survives redeploys, no paid plan)
Set both env vars and the app stores each design as a page in a Notion database:

- `NOTION_TOKEN` — an **internal integration** secret (create at
  <https://www.notion.so/my-integrations>).
- `NOTION_DESIGNS_DB` — the **Email Designs** database id.

Then **share the database with the integration**: open the database in Notion → `•••` →
*Connections* → add your integration. Each design becomes a row (Name / Updated / Created visible
as properties) with the full campaign JSON stored as chunked ```json code blocks in the page body
(Notion caps a single text run at 2000 chars), followed by a second ```json block holding the
design metadata. Durable across redeploys, and you can browse the designs in Notion. Required
integration capabilities: read + insert + update content.

**Optional native columns.** The metadata always round-trips via the page body, so nothing extra
is required. But if you add matching columns to the database, the metadata is *also* mirrored into
them so designs become filterable/searchable in Notion: `Is Example` (checkbox), `Objective`
(select), `Approval Status` (select), `Campaign Type`, `Audience Awareness`, `Primary CTA`,
`Emotional Tone`, `Components Used` (multi-select), `Source Brief` (url), `Klaviyo Link` (url),
`Result Notes` (rich text). Columns that don't exist are simply skipped.

### Local disk (fallback)
If `NOTION_TOKEN` is unset, designs are written as JSON files under `DATA_DIR` (default `./data`).
On Render this is **ephemeral** unless you add a persistent disk on a paid plan, so designs would be
lost on redeploy — which is why the Notion backend is preferred.

Either way, Export/Import JSON remains the portable, storage-independent backup.

## Production handoff
The exported HTML keeps `{{ASSETS_BASE}}` and the footer's Klaviyo merge tags. To ship:
upload the rasterised PNGs of designed blocks to the Klaviyo media library, swap the
`design-system/assets` line-art for hosted URLs, and use `design-system/shell/shell-production.html`.

## Slices (one PNG per block)
The **Slices** tab rasterises every block to its *own* PNG instead of one tall image. Click
**Render slices** to preview them, then **Download all (.zip)** for a `…-slices.zip` of
`01-header.png`, `02-blocks-editorial-hero.png`, … (numbered in send order). Drop each PNG into
its own Klaviyo image block so every section keeps its own click-through URL and alt text — the
classic "sliced email" build, but generated for you. The zip is built in the browser (no extra
dependency); the PNGs are 2× for retina.

Each slice also shows an editable **Link URL** (pre-filled from the block's tokens). These are the
same per-block links used by **Push to Klaviyo** below, so set them here once. The unsubscribe
footer is flagged as live HTML rather than an image.

## Push draft to Klaviyo
The **Push to Klaviyo** button creates a **draft** campaign in your Klaviyo account — it never
sends. The draft is built from **per-block image slices, not one giant PNG**, so each block is its
own image with its own click-through link. Under the hood it:

1. rasterises each block to its own PNG (same engine as the **Slices** tab);
2. uploads each PNG to your Klaviyo **media library** (`POST /api/image-upload`), getting a hosted
   `image_url`;
3. assembles a `CODE` template where every block is a `<tr>` with that hosted image wrapped in its
   own `<a href>` link;
4. creates a draft campaign + message and assigns the template.

The **footer stays live HTML** (not an image) so its `{% unsubscribe %}` merge tag still works —
rasterising it would break the legally-required unsubscribe link. You then finish/schedule/send the
draft inside Klaviyo.

**Per-block links:** open the **Slices** tab and click **Render slices** first — each image block
gets an editable *Link URL* (pre-filled from its tokens: `CTA_URL` / `PRODUCT_URL` / `HERO_LINK_URL`).
Those overrides are sent with the push, so each block links wherever you want.

Setup:
1. Create a Klaviyo **private API key** with `campaigns:write` + `templates:write` + `images:write`
   (upload the slices) + `lists:read` + `segments:read` (populate the audience picker) scopes.
2. Give it to the **server** as an env var (never the browser): `KLAVIYO_API_KEY=pk_xxx`.
   On Render, add it under the service's *Environment*. Optionally pin `KLAVIYO_REVISION`
   (defaults to a recent stable revision).
3. In the dialog, pick the **audience** from the list/segment dropdown (or paste an ID),
   set the **from email**, and optionally from-label / reply-to / subject / preview text.
   Audience + sender are remembered in your browser's localStorage for next time.

Note: line-art assets in the slices are baked into the uploaded PNGs, so they don't depend on the
server being reachable. Push from the deployed (Render) instance rather than localhost so Chromium
can load your CDN product imagery while rasterising. For a fully hand-tuned build, the **Slices**
tab also lets you download the PNGs and place them in Klaviyo yourself.

## Generating campaigns in future (and the "email builder skill")
This interface is **template-driven**, not an exporter you upload *into*. The campaign you build
here *is* a `campaign.json` — `{ campaignName, bodyBg, blocks:[{ component, tokens, palette? }] }`.
So the round-trip for future campaigns is:

- **By hand:** build in the UI → **Export JSON** to save it, **Import JSON** to reload/iterate.
- **With the creative email-campaign-builder skill:** that skill writes the *same* `campaign.json`
  shape against these components/tokens. Have it emit a `campaign.json`, then **Import JSON** here
  to preview, render PNGs/slices, or push the draft to Klaviyo. It does **not** export a special
  proprietary file — the `campaign.json` *is* the interchange format, and the form auto-syncs to
  whatever components/tokens exist in `design-system/`. (See `/api/schema` for the current list of
  components and their tokens, which is exactly what the skill should target.)

## Note on sandboxed environments
If Puppeteer renders show remote images as “broken”, the host is blocking Chromium's outbound
network. On a normal machine (and in every browser live-preview) the CDN images load fine; the
local line-art assets always resolve via `file://`.

## Keeping the design system in sync
`design-system/` is a bundled copy of `creative-email-campaign-builder/references/`
(templates, shells, assets, manifest). Re-copy that folder to pick up template changes.

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
- **Render PNG** — rasterises designed blocks exactly like the production `slice.js`.
- **Case validation** — warns + one-click fixes Cervanttis/Lust case violations as you type.
- **Import / Export** — round-trip a `campaign.json`, or export the assembled HTML.

## Layout
```
server.js                 zero-dependency HTTP server (UI + /api/{schema,assemble,render,export})
lib/parseTemplates.js     derives the token schema from templates + manifest
lib/render.js             assembles the shell and rasterises via Puppeteer
public/                   editor UI (index.html, app.js, style.css)
design-system/            bundled copy of the template library, shells, fonts, assets, manifest
```

## API
| Method | Path | Body | Returns |
|---|---|---|---|
| GET  | `/api/schema`   | — | components + tokens (types, presets, case rules), ordering & token rules |
| POST | `/api/assemble` | `{campaign}` | `{html, unfilled}` — assembled preview HTML |
| POST | `/api/render`   | `{campaign}` | `{pngBase64, brokenImages, height}` |
| POST | `/api/export`   | `{campaign}` | `{html, unfilled, campaign}` (HTML keeps `{{ASSETS_BASE}}` + Klaviyo tags) |

A `campaign` is `{ campaignName, bodyBg, blocks:[{ component, tokens:{…}, palette? }] }`.

## Production handoff
The exported HTML keeps `{{ASSETS_BASE}}` and the footer's Klaviyo merge tags. To ship:
upload the rasterised PNGs of designed blocks to the Klaviyo media library, swap the
`design-system/assets` line-art for hosted URLs, and use `design-system/shell/shell-production.html`.

## Note on sandboxed environments
If Puppeteer renders show remote images as “broken”, the host is blocking Chromium's outbound
network. On a normal machine (and in every browser live-preview) the CDN images load fine; the
local line-art assets always resolve via `file://`.

## Keeping the design system in sync
`design-system/` is a bundled copy of `creative-email-campaign-builder/references/`
(templates, shells, assets, manifest). Re-copy that folder to pick up template changes.

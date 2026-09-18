# Image optimisation stage

Every rasterised block slice passes through an encode stage on its way to Klaviyo. The design
system, the component templates, the footer markup and every saved campaign JSON are untouched —
only the exported bytes change. That does not mean the pixels are byte-identical: JPEG and palette
PNG are lossy, so an encoded slice can differ from the original render. What's guaranteed is a
floor on how far it may differ — the quality gate (below) rejects any lossy candidate that drops
below SSIM 0.98 against the render, and the measured results section has the actual numbers this
produces (visually indistinguishable, not pixel-for-pixel the same).

## Why per image, never global

The pipeline used to upload Puppeteer's PNG screenshots verbatim, so a photograph shipped as a
truecolour PNG — the wrong container for photography, at roughly five times the bytes of the same
picture at JPEG q82. Flat graphics are the opposite case: JPEG makes several of them *bigger*, and
a 256-colour palette PNG wins. So the stage encodes every candidate, measures each one, and keeps
the smallest that passes the quality gate.

## Where it sits

```
assemble → render.renderSlices (Puppeteer) → lib/imageOptimiser → klaviyo.uploadImage
```

`lib/imageOptimiser.js` is called by both surfaces that produce images: `POST /api/render-slices`
(what the editor previews and downloads) and `POST /api/klaviyo-draft` (what gets uploaded). There
is no per-campaign opt-out — a slice that reaches Klaviyo has been through the stage.

## The rules

- **Candidates.** Lossless PNG re-encode (maximum compression, `effort 10`, adaptive filtering),
  256-colour palette PNG, and JPEG q82 progressive/optimised with 4:2:0 chroma. WebP is a fourth
  candidate behind `IMAGE_OPT_WEBP`, **off by default**: it measured 87% smaller than the PNG
  originals, but Outlook on Windows will not render it and email has no reliable `<picture>`
  fallback.
- **Alpha.** An image with a *meaningful* alpha channel (measured from the pixels, not the channel
  count — Puppeteer screenshots carry an alpha channel that is fully opaque) is never a JPEG
  candidate.
- **Quality gate.** Windowed SSIM (11×11 Gaussian, σ 1.5) between the render and each lossy
  candidate, on greyscale composited over white. A candidate below `IMAGE_OPT_SSIM` (default
  `0.98`) is rejected and logged. If every lossy candidate fails, the losslessly optimised PNG
  ships — never an unmeasured encode.
- **Ties go to PNG**, for the broader set of edge-case clients that render it without a fallback.
- **Retina and metadata.** Slices render at 2× the block's display width and are hard-capped at
  1200px (anything wider is downscaled with Lanczos before encoding). EXIF, text chunks and any
  non-sRGB profile are dropped; everything is converted to sRGB.

## Weight budget

The optimised bytes of every image in the email are summed and judged:

| Total | Verdict |
|---|---|
| ≤ 600 KB | pass |
| 600 KB – 1 MB | pass with a warning naming the three heaviest images |
| > 1 MB | **fail — the push endpoint refuses to create the draft** |

Thresholds are config, not literals, and every surface that assembles images carries the total and
the per-image table: `imageWeight` on the `/api/render-slices` and `/api/klaviyo-draft` responses,
and the **Slices** tab shows the same total before anything is pushed. A live GIF passes through by
reference (rasterising one would freeze it), so it is reported as a passthrough row and carries no
bytes.

## Caching

Encoding is deterministic, so the output is cached on a SHA-256 of the source bytes plus the
encoder settings and the libvips build. Tiers: an in-process LRU, then a disk cache under
`IMAGE_OPT_CACHE_DIR` (default `$TMPDIR/eb-image-optimiser-cache`) so a restarted instance still
hits. A second run of an unchanged email returns byte-identical images with `cacheHit: true` and
skips encoding entirely. Set `IMAGE_OPT_CACHE=0` to disable.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `IMAGE_OPT_MAX_WIDTH` | `1200` | Hard cap on the encoded width (2× the 600px display width) |
| `IMAGE_OPT_SCALE` | `2` | Target retina scale |
| `IMAGE_OPT_SSIM` | `0.98` | Quality gate for lossy candidates |
| `IMAGE_OPT_JPEG_QUALITY` | `82` | JPEG quality |
| `IMAGE_OPT_PNG_COLOURS` | `256` | Palette PNG colour count |
| `IMAGE_OPT_WEBP` | `0` | Add WebP as a candidate (off: Outlook) |
| `IMAGE_OPT_WEBP_QUALITY` | `80` | WebP quality when enabled |
| `IMAGE_OPT_CACHE` | `1` | In-process + disk cache |
| `IMAGE_OPT_CACHE_DIR` | `$TMPDIR/eb-image-optimiser-cache` | Disk cache location |
| `IMAGE_WEIGHT_PASS_BYTES` | `614400` (600 KB) | Below this the email passes |
| `IMAGE_WEIGHT_WARN_BYTES` | `1048576` (1 MB) | Above this the push is refused |

## Verification

`scripts/measure-image-weights.js` runs the real pipeline — Puppeteer rasterisation through
`render.renderSlices`, then the optimiser — over one or more designs and prints the before/after
table, the budget verdict, and (with `--visual-diff`) a pixel diff of the email re-rendered from
the optimised images against the original renders at 600px and 375px. It exits non-zero when a
design breaks the weight budget, so it can gate a release.

```sh
npm test                                                          # includes the optimiser suite
node scripts/measure-image-weights.js --assets test/fixtures/campaign-assets --visual-diff
node scripts/measure-image-weights.js --design examples/farewell_sellthrough.json \
  --assets test/fixtures/campaign-assets --visual-diff
node scripts/measure-image-weights.js --campaign /tmp/c.json --assets https://cdn.example.com/dir
```

`test/fixtures/campaign-assets/` is committed to the repo — it's what `{{ASSETS_BASE}}` in the
committed seeds resolves to when you pass it as `--assets`, and is exactly what produced the
numbers below, so the measured-results section is reproducible from a clean checkout. It holds
three synthetic photographic images (a gradient-and-noise generator, not real photography — see
the git history for the generating script), standing in for the seeds' actual hero/portrait/product
placeholders; the *shape* of the results (which slices land on JPEG vs. palette PNG, roughly how
much each saves) is representative, but the exact bytes are specific to these fixtures, not to Fig
& Bloom's real imagery.

Two components in both seeds — `header` (the logo mark) and `sections/trust-bar` (partner badges)
— reference live `cdn.shopify.com` / CloudFront URLs baked directly into the seed's own tokens,
independent of `--assets`. They load in the numbers below; behind a restrictive proxy or firewall
with no route to those hosts they will not, and the harness will report them as broken images and
fail the run (see "Verification" above) — pass `--allow-broken` to see the (now partial) numbers
anyway.

### Measured results (18 September 2026)

Both committed seed designs, run against the committed fixtures above (`--assets
test/fixtures/campaign-assets --visual-diff --allow-broken`; `--allow-broken` was not needed on a
machine with ordinary internet access to the two CDN-hosted components described above). Totals
count only images actually uploaded to Klaviyo — a block that stays live HTML (the unsubscribe
footer, and any `html_only` component) is rasterised here like everything else so its row still
prints below, but it is excluded from these totals and from the weight budget, because Klaviyo
never receives those bytes:

| Design | Uploaded images | Before | After | Saved | Budget |
|---|---|---|---|---|---|
| `seed-editorial-digest` (F&B 2026-06 In Bloom) | 10 (of 12 rasterised) | 2.41 MB | 719.1 KB | 70.9% | WARN |
| `seed-farewell` (2026-06 Farewell Weekend) | 5 (of 7 rasterised) | 1.53 MB | 357.1 KB | 77.3% | PASS |
| **Both** | **15 (of 19 rasterised)** | **3.95 MB** | **1.05 MB** | **73.4%** | — |

Per image — the ratio a photographic slice gets from JPEG q82 depends heavily on its own content
(from 2.5× to nearly 11× here), and several photographic slices in this run — the product card in
both seeds, all three `journal-tile` regions — failed the SSIM gate as JPEG and fell back to
palette PNG instead, at a worse ratio than JPEG would have given if it had passed. "Photographic →
JPEG" is the common case, not a rule; what's guaranteed is only that whatever ships passed the
gate:

`seed-editorial-digest`:

| Image | Before | After | Format | SSIM | Uploaded |
|---|---|---|---|---|---|
| `01-header` | 5.5 KB | 3.0 KB | png-palette | 1.0000 | yes |
| `02-blocks-caption-bar-hero` | 791.7 KB | 72.4 KB | jpeg | 0.9801 | yes |
| `03-blocks-story` | 427.0 KB | 72.3 KB | jpeg | 0.9910 | yes |
| `04-sections-section-headline` | 17.5 KB | 8.7 KB | png-palette | 1.0000 | no — stays live HTML |
| `05-products-card-horizontal` | 406.2 KB | 193.6 KB | png-palette | 0.9939 | yes |
| `06-blocks-journal-tile-header` | 13.8 KB | 6.7 KB | png-palette | 1.0000 | yes |
| `06-blocks-journal-tile-1` | 240.7 KB | 109.6 KB | png-palette | 0.9951 | yes |
| `06-blocks-journal-tile-2` | 248.3 KB | 111.7 KB | png-palette | 0.9950 | yes |
| `06-blocks-journal-tile-3` | 244.4 KB | 112.2 KB | png-palette | 0.9957 | yes |
| `07-sections-upsell-noir` | 82.1 KB | 33.1 KB | jpeg | 0.9953 | yes |
| `08-sections-trust-bar` | 9.2 KB | 4.5 KB | png-palette | 0.9999 | yes |
| `09-footer` | 44.6 KB | 18.9 KB | png-palette | 0.9999 | no — stays live HTML |

`seed-farewell`:

| Image | Before | After | Format | SSIM | Uploaded |
|---|---|---|---|---|---|
| `01-header` | 5.5 KB | 3.0 KB | png-palette | 1.0000 | yes |
| `02-blocks-editorial-hero` | 734.6 KB | 91.6 KB | jpeg | 0.9884 | yes |
| `03-sections-body-copy-plain` | 58.9 KB | 26.0 KB | png-palette | 1.0000 | no — stays live HTML |
| `04-products-card-horizontal` | 405.5 KB | 193.9 KB | png-palette | 0.9939 | yes |
| `05-blocks-story` | 416.6 KB | 64.2 KB | jpeg | 0.9896 | yes |
| `06-sections-trust-bar` | 9.0 KB | 4.4 KB | png-palette | 0.9999 | yes |
| `07-footer` | 44.6 KB | 18.9 KB | png-palette | 0.9999 | no — stays live HTML |

Visual diff of the email rebuilt from the optimised (uploaded) images against the same email
rebuilt from the original PNG renders (mean absolute channel difference out of 255) — this is a
genuine pixel difference, not zero, because the JPEG and palette-PNG candidates are lossy; the
quality gate bounds how large it's allowed to get:

| Design | Width | SSIM | Mean channel diff | Channels off by >8 |
|---|---|---|---|---|
| `seed-editorial-digest` | 600px | 0.9867 | 0.63 | 0.66% |
| `seed-editorial-digest` | 375px | 0.9924 | 0.49 | 0.45% |
| `seed-farewell` | 600px | 0.9850 | 0.69 | 0.78% |
| `seed-farewell` | 375px | 0.9915 | 0.54 | 0.57% |

Visually indistinguishable at both widths, not pixel-identical. Budget behaviour was confirmed both
ways: `seed-editorial-digest` lands in the warn band and names its three heaviest images (the
product card and two of the journal-tile regions); `seed-farewell` passes; and a design pushed
synthetically past the fail threshold (`IMAGE_WEIGHT_WARN_BYTES` set low) returns `422` from
`/api/klaviyo-draft` with the table attached and no Klaviyo object created — this exact path also
has an HTTP-level integration test in `test/run.js`, not just this manual check.

### Still to run with Klaviyo access, and with real photography

The reference measurement for Klaviyo template `WzAesL` (the preference-seed email, 17 images,
1.60 MB) needs a server with `KLAVIYO_API_KEY` and the saved design, because the assets are hosted
in that account. The results above use synthetic fixtures, not Fig & Bloom's real photography —
real images will compress differently (real photographs typically have more fine detail than a
smooth synthetic gradient, so expect somewhat less dramatic JPEG savings than the ratios above).
Re-run against the real assets once they're available, ideally committing them the way
`test/fixtures/campaign-assets/` is committed here, so the results stay reproducible:

```sh
KLAVIYO_API_KEY=… node scripts/measure-image-weights.js --campaign /path/to/wzaesl.json
```

# Image optimisation stage

Every rasterised block slice passes through an encode stage on its way to Klaviyo. Only the bytes
change: the design system, the component templates, the footer markup and every saved campaign
JSON are untouched, and the rendered pixels are the same.

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
npm test                                                   # includes the optimiser suite
node scripts/measure-image-weights.js --assets /path/to/assets
node scripts/measure-image-weights.js --design examples/farewell_sellthrough.json --visual-diff
node scripts/measure-image-weights.js --campaign /tmp/c.json --assets https://cdn.example.com/dir
```

The committed seeds point at placeholder filenames that are not in the repo, so a faithful
measurement needs `--assets` pointed at a directory (or URL) that actually serves them.

### Measured results (19 September 2026)

Both committed seed designs, rendered with real Fig & Bloom photography supplied for the
placeholders, measured on this machine:

| Design | Images | Before | After | Saved |
|---|---|---|---|---|
| `seed-editorial-digest` (F&B 2026-06 In Bloom) | 12 | 2.55 MB | 455.5 KB | 82.6% |
| `seed-farewell` (2026-06 Farewell Weekend) | 7 | 1.95 MB | 357.2 KB | 82.1% |
| **Both** | **19** | **4.50 MB** | **812.7 KB** | **82.4%** |

Per image, `seed-farewell` — the photographic slices land on JPEG q82 at 5–9× smaller, the flat
ones land on palette PNG:

| Image | Before | After | Format | SSIM |
|---|---|---|---|---|
| `02-blocks-editorial-hero` | 979.2 KB | 132.3 KB | JPEG q82 | 0.9963 |
| `05-blocks-story` | 397.9 KB | 76.6 KB | JPEG q82 | 0.9971 |
| `04-products-card-horizontal` | 283.6 KB | 32.7 KB | JPEG q82 | 0.9897 |
| `06-sections-trust-bar` | 185.4 KB | 44.6 KB | JPEG q82 | 0.9988 |
| `07-footer` | 89.8 KB | 40.8 KB | JPEG q82 | 0.9998 |
| `03-sections-body-copy-plain` | 53.8 KB | 26.2 KB | PNG 256-colour | lossless |
| `01-header` | 7.8 KB | 4.0 KB | PNG 256-colour | lossless |

Visual diff of the email rebuilt from the optimised images against the same email rebuilt from the
original PNG renders (mean absolute channel difference out of 255):

| Design | Width | SSIM | Mean channel diff | Channels off by >8 |
|---|---|---|---|---|
| `seed-editorial-digest` | 600px | 0.9927 | 0.64 | 1.14% |
| `seed-editorial-digest` | 375px | 0.9967 | 0.49 | 0.46% |
| `seed-farewell` | 600px | 0.9933 | 0.63 | 1.11% |
| `seed-farewell` | 375px | 0.9970 | 0.48 | 0.44% |

No perceptible difference at either width. Budget behaviour was confirmed both ways: an email
between the two thresholds logs the warning and names its three heaviest images, and one over the
fail threshold returns `422` from `/api/klaviyo-draft` with the table attached and no Klaviyo object
created.

### Still to run with Klaviyo access

The reference measurement for Klaviyo template `WzAesL` (the preference-seed email, 17 images,
1.60 MB) needs a server with `KLAVIYO_API_KEY` and the saved design, because the assets are hosted
in that account. The encoder settings above reproduce its shape — photographic slices ~5× smaller
as JPEG q82, flat graphics smaller as palette PNG — but the exact totals have not been re-measured
here. Run it once credentials are available:

```sh
KLAVIYO_API_KEY=… node scripts/measure-image-weights.js --campaign /path/to/wzaesl.json
```

# Campaign dark theme — business-os #212 S7

Implemented on `codex/212-s7-dark` from `2782d75`, without commits, pushes, deploys or external API calls. Build plan: [.plan-212-s7.md](../../.plan-212-s7.md).

## Use

Select **Dark** in the builder, or send a campaign with `"theme": "dark"` to the existing `/api/assemble`, `/api/validate`, `/api/export`, render or slices paths. Omit theme or set `"light"` to retain the existing output. The sliced Klaviyo draft path passes the theme through to its production shell; it has not been called against Klaviyo.

The optional **Dark theme logo and social assets** panel edits `campaign.themeTokens`. The same values can be set in campaign JSON:

```json
{
  "theme": "dark",
  "themeTokens": {
    "DARK_LOGO_URL": "{{ASSETS_BASE}}/F_B_Logo_Horizontal_CREAM_914x200.png",
    "DARK_FACEBOOK_URL": "{{ASSETS_BASE}}/F_B_Social_Facebook_CREAM_300x120.png",
    "DARK_INSTAGRAM_URL": "{{ASSETS_BASE}}/F_B_Social_Instagram_CREAM_300x120.png",
    "DARK_PINTEREST_URL": "{{ASSETS_BASE}}/F_B_Social_Pinterest_CREAM_300x120.png",
    "DARK_YOUTUBE_URL": "{{ASSETS_BASE}}/F_B_Social_Youtube_CREAM_300x120.png"
  }
}
```

Those values are defaults; campaigns do not need to repeat them. The supplied cream and white horizontal logos and four cream social icons were copied unchanged from `/workspace/email-3x-week/black-friday/assets/` to `design-system/assets/`. The logo displays at 120px wide in both header and footer; its 914px source exceeds 2x retina resolution. Social icons display at 150px on desktop, with 300px source width (2x), and shrink on phones. The white alternative is `F_B_Logo_Horizontal_WHT_914x200.png`.

The existing black header logo uses a Shopify CDN URL; uploading to that host is outside this task. New defaults therefore use the repo's existing `/design-system/assets` serving route and `ASSETS_BASE` resolution. When the user deploys these changes, all six new PNGs must be served at the selected public asset base. If `PUBLIC_ASSETS_BASE` points at a separate CDN, copy these files there or override the five tokens with public hosted URLs. No upload has been performed.

Noir background is `#000000`; body and unsubscribe text are `#d9d4ce` (14.26:1 contrast against noir); headings and links are `#ffffff`. Navigation is live text, with light rules. Dark buttons have a noir fill, a light outline and light underlined labels, including their Outlook VML fallback. The dark adapter adds CSS backgrounds and `bgcolor` to tables/cells, plus CSS backgrounds to div wrappers. Dark shell meta, media rules, Outlook `[data-ogsc]`/`[data-ogsb]` selectors and a black gradient background lock are emitted only under dark theme.

Caps controls are available on hero-d-noir, hero-b-noir, hero-c1-noir, hero-c2-noir, upsell-noir and section-headline: `HEADLINE_STYLE: "caps"`, `HEADLINE_LETTER_SPACING: "0.06em"` by default. Copy is preserved verbatim; there is no uppercase conversion or lowercase forcing. `pdffonts art-direction.pdf` identified **Didot** in the reference deck (page 1 inspected). The implementation uses **Lust**, the closest already bundled display serif, rather than introducing an unavailable Didot font. Validation and glyph checks use Lust in caps mode; default casing rules remain active otherwise.

## Recovered dark-test payload

No source campaign JSON existed beside `dark-test/assembled.html`. Recovered its six blocks from the component markers and already substituted TOKENS comments, checked against live text and links:

1. header
2. hero-d-noir: Black Friday / after dark / Test subheadline. / Test CTA
3. body-copy-plain: Test headline / Body copy on the dark shell.
4. button: Shop, linking to `https://figandbloom.com`
5. upsell-noir: Test / last call / Test body. / Shop CTA
6. footer

The source HTML SHA-256 is `58f3637b794b5ba1906c1293e89e145761edb99605093bdabf4ee9e94019e983`. Its button used literal `noir`/`white`/`noir` palette values: `noir` is not a CSS colour, which caused the blue link. The recovered fixture uses valid hex colours; the dark adapter also enforces light link text and noir button fills independently of supplied palette values.

Fixtures: [recovered campaign](../../test/fixtures/212-s7-dark-test.json), [caps campaign](../../test/fixtures/212-s7-dark-caps.json). The caps fixture sets the hero headline to `AFTER DARK` and the upsell headline to `BLACK FRIDAY IS ABOUT TO BLOOM`, exactly as typed. The renderer also creates a separate specimen email containing all six caps-enabled components, each with the entire `AFTER DARK / BLACK FRIDAY IS ABOUT TO BLOOM` headline.

These JSON campaigns go through `render.assemble()` and `validateCampaign()` directly, the same functions used by the builder endpoints. Assemble-only output was generated at `/tmp/eb212-s7-assembled`: preview and production HTML for all three campaigns, plus validation JSON. All three have zero errors, warnings and unfilled tokens; all 36 image references resolve to local files. Specimen photography uses the committed local placeholder image; the recovered test has no photographic image to substitute.

## Offline screenshots — run outside this sandbox

```bash
CHROMIUM_PATH=/path/to/chromium \
EB212S7_RENDER_DIR=/tmp/212-s7-renders \
node scripts/render-212-s7.js
```

The runner launches one browser and closes it in `finally`. Every page request is intercepted. Bundled images are served from local files; the caps specimen's known sample photo URL maps to `test/fixtures/campaign-assets/placeholder-hero.jpg`. Preview fonts are embedded in the existing shell. All other remote/file requests are aborted and reported; nothing is fetched from an external service. Image-off mode aborts all image requests, and distinguishes their expected broken-image entries in the report.

It writes 24 PNGs: three campaigns × two widths (600 and 390) × images on/off × emulated light/dark client modes. Names include `dark-test-caps-390-images-off-dark.png`. `report.json` lists computed blue text, every opaque non-noir background, broken images, local stubs, denied requests, caps text/font/transform/spacing and horizontal overflow. Blue means `b > r + 40 && b > g + 40`. Unexpected blue, backgrounds, images, requests, missing caps or overflow fail the process. The primary caps campaign checks both exact headline strings in every mode.

For HTML/validation only:

```bash
EB212S7_RENDER_DIR=/tmp/212-s7-html node scripts/render-212-s7.js --assemble-only
```

`node --check scripts/render-212-s7.js` passed. The runner has only been executed with `--assemble-only`; screenshots and computed browser results remain for the user to run. Emulating colour-scheme in Chromium does not prove every proprietary Gmail/Outlook inversion behavior; a real-client review remains necessary to confirm that part visually.

## Verification and revert proof

- **68/68 S7 tests pass**: [implementation TAP](implementation.tap). Includes all 57 shipped components, explicit CSS/background attributes, light text and links, client-mode shell handling, asset defaults/overrides, clean recovered campaigns, all six caps variants and unsupported-authored-block warnings.
- **Byte identity:** captured the complete unmodified bytes before editing into [212-s7-baseline.json](../../test/fixtures/212-s7-baseline.json). This stores complete gzip-compressed HTML, with repeated embedded font URLs deduplicated losslessly, rather than hashes. All 105 sample/palette/example/default/full campaigns pass for absent and explicit light theme: **630 full-render byte comparisons plus 210 sets of block-byte comparisons**. Includes preview, marked preview, production, every committed assembled example, and an email containing every component.
- **Main revert proof:** `git archive 2782d75` was extracted to `/tmp/212-s7-main`; only the node_modules symlink was shared. Ran `EB212S7_TEST_ROOT=/tmp/212-s7-main node test/212-s7.test.js`. **67 feature tests fail on main**, and the compatibility control passes on main as it must. [Per-test results](revert-main.tap). The working implementation was never removed; no checkout/reset/stash was used. Re-ran all 68 against the implementation successfully.
- **3,304 existing assertions pass:** [legacy output](legacy-browser-free.log). Ran `test/run.js` through a temporary in-memory harness that skips only `cardLiveSuite()` and `integrationSuite()`, which require a browser. Studio and image optimisation suites ran normally; the repository's test runner was not edited.
- **Six existing test files pass:** artifact, publish-assembly, fixture-compatibility, publishing-handoff, notion-revision and selected-design. [Results](existing-tests.tap).
- `artifact-media` attempted browser launch and hit the sandbox crashpad/socket restriction (2 passed, 7 browser-dependent failures). `export-http` failed on `listen EPERM` for localhost. These environmental failures are not presented as passing tests. Full `npm test` still requires a host that permits Chromium and localhost sockets; S7 is included at the start of that command.
- Syntax checks for the new render script, theme module, render module and browser app, and `git diff --check`, pass. No PNGs were generated in this sandbox.

## Changed-file map

| File and line | Change |
| --- | --- |
| [.plan-212-s7.md:1](../../.plan-212-s7.md#L1) | Build plan written before implementation. |
| [lib/campaignTheme.js:1](../../lib/campaignTheme.js#L1) | Noir adapter, caps styling, asset resolution, client-mode shell protection. |
| [lib/render.js:216](../../lib/render.js#L216) | Theme integration in full/block assembly and production wrapping. |
| [design-system/theme/footer-dark.html:1](../../design-system/theme/footer-dark.html#L1) | Cream logo/icons, live navigation and legal text. |
| [design-system/manifest.json:134](../../design-system/manifest.json#L134) | Caps controls/defaults; campaign theme and asset defaults at line 1297. |
| [lib/parseTemplates.js:254](../../lib/parseTemplates.js#L254) | Optional runtime controls in component schema, plus campaign theme schema. |
| [lib/validate.js:269](../../lib/validate.js#L269) | Theme validation, missing-dark warnings, caps case/glyph behavior. |
| [lib/glyphs.js:276](../../lib/glyphs.js#L276) | Caps uses Lust for campaign glyph audit. |
| [lib/sampleData.js:259](../../lib/sampleData.js#L259) | Caps sample generation preserves supplied case. |
| [public/index.html:21](../../public/index.html#L21) | Theme selector and asset drawer. |
| [public/app.js:139](../../public/app.js#L139) | Asset inputs, caps field behavior, theme persistence and stale-preview key. |
| [server.js:546](../../server.js#L546) | Preserve dark theme in sliced production shell. |
| [scripts/render-212-s7.js:1](../../scripts/render-212-s7.js#L1) | Offline screenshot and computed-style audit runner. |
| [test/212-s7.test.js:1](../../test/212-s7.test.js#L1) | Regression and compatibility tests. |
| [test/fixtures/212-s7-baseline.json:1](../../test/fixtures/212-s7-baseline.json#L1) | Pre-edit expected output bytes. |
| [test/fixtures/212-s7-dark-test.json:1](../../test/fixtures/212-s7-dark-test.json#L1) | Recovered six-block source campaign. |
| [test/fixtures/212-s7-dark-caps.json:1](../../test/fixtures/212-s7-dark-caps.json#L1) | Exact uppercase test campaign. |
| [package.json:10](../../package.json#L10) | S7 tests in npm test; render:212-s7 command. |
| `design-system/assets/F_B_Logo_Horizontal_{CREAM,WHT}_914x200.png` | Two original supplied raster logos (binary files). |
| `design-system/assets/F_B_Social_{Facebook,Instagram,Pinterest,Youtube}_CREAM_300x120.png` | Four original supplied raster social icons (binary files). |
| `docs/212-s7/{README.md,implementation.tap,revert-main.tap,existing-tests.tap,legacy-browser-free.log}` | Handoff and recorded verification. |


## S7b follow-on — B-G5 and B-G6

Plan: [.plan-212-s7b.md](../../.plan-212-s7b.md). Builds on S7 without restructuring it.

Hero-a now exposes `HEADLINE_FONT` in the same enum-control UI as the S7 caps levers. Allowed values are `cervanttis` (default) and `lust`; unknown values produce `invalid_enum`. Omitted and explicit `cervanttis` retain the original bytes, lowercase validation, and font/glyph behavior. `lust` uses the bundled display serif, removes the script descender pad, and preserves case/punctuation verbatim in preview, production and block assembly. Validation, sample generation, UI casing hints and glyph auditing use the selected face. Set `HEADLINE: "The Christmas table, done."` and `HEADLINE_FONT: "lust"`.

Only the `fine_print` colour token changes: light `#aaaaaa` → `#4d4d4d` (70% black, rounded to an opaque sRGB value). The dark adapter already supplies `#d9d4ce`, so its value stays unchanged. Existing immutable/shipped template literals resolve through the brand token layer; only `color:#aaaaaa` declarations change, leaving template comments, other colours, supplied copy and other tokens alone. The Studio impact list also recognises the original literal.

WCAG relative luminance contrast (sRGB linearisation; asserted from actual assembled light/dark text colours):

| Background | Old muted | New muted | Old ratio | New ratio |
| --- | --- | --- | --- | --- |
| Cream / 50% clay `#EBE5DF` | `#aaaaaa` | `#4d4d4d` | 1.859129:1 | **6.764841:1** |
| Full clay `#D8CCBE` (additional check) | `#aaaaaa` | `#4d4d4d` | 1.471364:1 | **5.353873:1** |
| S7 noir `#000000` | `#d9d4ce` | `#d9d4ce` | 14.258982:1 | **14.258982:1** |

### Exact byte-baseline exceptions

The original compressed baseline is untouched. [212-s7b-muted-baseline.json](../../test/fixtures/212-s7b-muted-baseline.json) is an explicit delta overlay for precisely the following **39** cases. The compatibility test checks the list against the original fixture and replaces only the old muted colour declaration in expected HTML. **396 of 630 full renders remain identical to the original; 234 change solely at muted colour declarations.** Of the 210 block-byte comparison sets, 132 remain original and 78 receive the same delta. Hero-a's original baseline remains unchanged. No committed example source HTML is rewritten.

- `blocks/annotated-product`
- `blocks/annotated-product:white`
- `blocks/caption-bar-hero`
- `blocks/caption-bar-hero:white`
- `blocks/caption-bar-hero:noir`
- `blocks/comparison-vs`
- `blocks/comparison-vs:white`
- `blocks/designed-product-card`
- `blocks/designed-product-card:white`
- `blocks/editorial-collage`
- `blocks/editorial-collage:white`
- `blocks/editorial-hero`
- `blocks/event-gallery`
- `blocks/event-gallery:white`
- `blocks/feature-list`
- `blocks/howto-steps`
- `blocks/howto-steps:white`
- `blocks/image-text`
- `blocks/image-text:white`
- `blocks/offer-panel`
- `blocks/offer-panel:white`
- `blocks/story`
- `blocks/story:white`
- `heroes/hero-b-white`
- `heroes/hero-c1`
- `heroes/hero-c2`
- `heroes/hero-d-white`
- `products/card-horizontal`
- `products/card-horizontal-reversed`
- `products/card-lifestyle-studio`
- `products/card-single-testimonial`
- `sections/body-copy`
- `sections/body-copy-plain`
- `sections/delivery-cutoffs`
- `sections/promo-code`
- `sections/section-headline`
- `email:seed-editorial-digest`
- `email:seed-farewell`
- `email:all-components`


All listed cases change because their assembled HTML uses the muted token. Cases with `:white`/`:noir` are the corresponding palette samples; the unqualified names are the default samples. `sections/section-headline` contains the token in its source/assembled token documentation. The two seed campaigns and all-components email contain affected components. Other palette variants retain their original bytes.

### B3 Sunday note rendering

```bash
CHROMIUM_PATH=/opt/google/chrome/chrome \
EB212S7_RENDER_DIR=/tmp/212-s7b-b3 \
node scripts/render-212-s7b.js
```

The sibling runner reads `/workspace/email-3x-week/month-2026-11/build/B3/design-payload.json`, applies only the hero-a font choice and requested headline, validates, and writes `b3-sunday.json`, preview/production HTML and `b3-report.json`. Override the source folder with `EB212S7_B3_SOURCE`. It renders four PNGs: 600/390, each images on/off. The audit checks exact headline text, computed Lust font family, no text transform, overflow, failed requests and broken images. Images-off aborts image requests, including the hero background. Unlike the original offline S7 runner, this B3 runner uses the source campaign's hosted images and fonts; bundled illustration requests are served locally. Browser closes in `finally`, and launch/render errors are recorded in the report.

`EB212S7_RENDER_DIR=/tmp/212-s7b-b3 node scripts/render-212-s7b.js --assemble-only` passed with zero validation errors, warnings or unfilled tokens. A real browser run was attempted: Chrome fails before page creation with `crashpad ... setsockopt: Operation not permitted`. **No new PNGs or computed browser results are claimed; 600/390 and images-off visual verification remains pending on a host that permits Chromium.** See [browser failure](browser-s7b.txt). A final pipe-transport launch with single-process/no-zygote also failed (`Target closed`).

### Follow-on verification

- **70/70 S7 tests pass**, including the original 68 and two new tests covering font selection/default identity/enum rejection/case preservation and both theme contrast ratios. [TAP](implementation-s7b.tap).
- **Main revert proof:** using the already extracted `/tmp/212-s7-main` (`2782d75`), `EB212S7_TEST_ROOT=/tmp/212-s7-main node test/212-s7.test.js` fails both new feature tests: main lacks the enum and retains the pale token. With the new baseline delta, all 70 tests fail against main (the former compatibility control now intentionally expects the muted-token correction). [TAP](revert-main-s7b.tap). No working code was removed or reverted.
- **3,309 browser-free legacy assertions pass** with the same temporary in-memory harness described above, excluding only `cardLiveSuite()` and `integrationSuite()`. [Log](legacy-browser-free-s7b.txt).
- **Six existing test files pass:** artifact, publish-assembly, fixture-compatibility, publishing-handoff, notion-revision and selected-design. [TAP](existing-tests-s7b.tap).
- Full `npm test` was attempted: S7 passed, then `test/run.js` exited 1 in this sandbox; a direct full legacy rerun confirms `listen EPERM` in `integrationSuite()` ([failure](full-legacy-s7b.txt)). Full browser/HTTP suites remain unverified. [Output](npm-test-s7b.txt). Syntax checks and `git diff --check` pass.
- No Git write commands were run. HEAD changed externally during this session to `7f3eaf5`; that state was left untouched.

### Follow-on changed-file map

| File and line | Follow-on change |
| --- | --- |
| [.plan-212-s7b.md:1](../../.plan-212-s7b.md#L1) | Initial plan. |
| [design-system/manifest.json:95](../../design-system/manifest.json#L95) | Font enum/default; fine_print at line 1255. |
| [lib/campaignTheme.js:20](../../lib/campaignTheme.js#L20) | Verbatim headline selection and hero-a Lust styling. |
| [lib/brandTokens.js:225](../../lib/brandTokens.js#L225) | Resolve only muted colour declarations; impact discovery at line 258. |
| [lib/validate.js:327](../../lib/validate.js#L327) | Selected face casing/glyph validation. |
| [lib/glyphs.js:277](../../lib/glyphs.js#L277) | Campaign glyph auditing uses selected font. |
| [lib/sampleData.js:259](../../lib/sampleData.js#L259) | Preserve exact copy with Lust. |
| [public/app.js:173](../../public/app.js#L173) | Font-aware headline field and control refresh. |
| [scripts/render-212-s7b.js:1](../../scripts/render-212-s7b.js#L1) | B3 renderer and browser audit. |
| [test/212-s7.test.js:28](../../test/212-s7.test.js#L28) | Narrow baseline delta; new tests at lines 152 and 190. |
| [test/fixtures/212-s7b-muted-baseline.json:1](../../test/fixtures/212-s7b-muted-baseline.json#L1) | Exact 39-case baseline overlay. |
| [docs/212-s7/README.md](README.md) | Ratios, exception list, rendering instructions and evidence. |
| `docs/212-s7/{implementation-s7b.tap,revert-main-s7b.tap,existing-tests-s7b.tap,legacy-browser-free-s7b.txt,browser-s7b.txt,npm-test-s7b.txt,full-legacy-s7b.txt}` | Verification outputs. |

## S7b box verification (outside the Codex sandbox)

The sandbox browser and `listen EPERM` failures recorded above do not apply on the box. On 25 Oct 2026 the full `npm test` passed with Chromium (70/70 S7 + S7b tests, all 3,331 legacy assertions, 28/28 publishing tests; [summary](npm-test-s7b-box.txt)). `scripts/render-212-s7.js` passed its offline visual audit (24 PNGs) and `scripts/render-212-s7b.js` rendered the B3 Sunday note at 600, 390 and images-off ([600](../212-s7-renders/b3-sunday-600.png), [390](../212-s7-renders/b3-sunday-390.png), [600 images-off](../212-s7-renders/b3-sunday-600-images-off.png), [390 images-off](../212-s7-renders/b3-sunday-390-images-off.png)). "The Christmas table, done." renders exactly as typed in Lust on hero-a in all three.


## Rebased on main 2cb23d5

Completed the working-tree merge of main `2cb23d5` into S7/S7b (`733c07ce`). The three conflicted files were resolved as follows:

- `design-system/manifest.json`: retained main's optional trust-bar, ordering rules, P2 components and lever metadata, plus S7 theme declarations, caps controls, hero-a HEADLINE_FONT and fine_print `#4d4d4d`. Added card-feature, text-band and top-line to the dark support list.
- `lib/render.js`: composed main's component-lever preparation with S7 template/headline handling before token substitution in both full and block assembly; retained main's contextual markdown colour and escaped hero alt handling. Dark transformation follows token/brand resolution, including VML image text. Dark footer image wrappers now have main's readable 14px alt typography.
- `package.json`: runs S7 tests, the legacy runner, and every test file from main, retaining main's serial test execution.

Regenerated the complete byte fixture from a clean `git archive 2cb23d5` extraction under `/tmp`, removed after generation. `git worktree add` was attempted but could not write the parent repository's read-only worktree metadata. All previous 105 input cases remain; seven added cases cover card-feature, top-line, and text-band's sample plus four palettes. The all-components campaign also includes all three new components. Expected HTML comes exclusively from main's renderer. The fixture contains **112 campaigns: 672 full-render byte comparisons and 224 block-output comparison sets**, covering absent and explicit light theme, preview, production and marked output. **73 cases retain main bytes exactly; 39 differ solely by `color:#aaaaaa` → `color:#4d4d4d`.** Main's P1/P2 compatibility tests retain their original fixtures and assertions with only this same colour correction allowed.

Exact muted-token fixture list (39, in fixture order):

```text
blocks/annotated-product
blocks/annotated-product:white
blocks/caption-bar-hero
blocks/caption-bar-hero:white
blocks/caption-bar-hero:noir
blocks/comparison-vs
blocks/comparison-vs:white
blocks/designed-product-card
blocks/designed-product-card:white
blocks/editorial-collage
blocks/editorial-collage:white
blocks/editorial-hero
blocks/event-gallery
blocks/event-gallery:white
blocks/feature-list
blocks/howto-steps
blocks/howto-steps:white
blocks/image-text
blocks/image-text:white
blocks/offer-panel
blocks/offer-panel:white
blocks/story
blocks/story:white
heroes/hero-b-white
heroes/hero-c1
heroes/hero-c2
heroes/hero-d-white
products/card-horizontal
products/card-horizontal-reversed
products/card-lifestyle-studio
products/card-single-testimonial
sections/body-copy
sections/body-copy-plain
sections/delivery-cutoffs
sections/promo-code
sections/section-headline
email:seed-editorial-digest
email:seed-farewell
email:all-components
```

Verification for this merged tree:

- **74/74 S7 tests pass**, including all 60 shipped components and a new light/dark markdown-link and images-off typography regression: [node --test result](implementation-merge.tap), [individual test results](implementation-merge-detail.tap). This environment's `node --test` reporter groups each file into one subtest; the direct test log records all 74.
- **3,461 browser-free legacy assertions pass**, using an in-memory copy of `test/run.js` that skips only `cardLiveSuite()` and `integrationSuite()`; studio and image optimisation suites run unchanged: [log](legacy-browser-free-merge.txt).
- **45 additional non-browser tests pass**: P1 10, P2 8, images-off 9, and six existing files 18: [P1](p1-merge.tap), [P2](p2-merge.tap), [images-off](images-off-merge.tap), [existing test details](existing-tests-merge-detail.tap), [combined eight-file invocation](existing-tests-merge.tap).
- Full `npm test` reaches legacy integration and is blocked by `listen EPERM`: [log](npm-test-merge.txt). Main's P2 browser geometry test cannot create a page (`Target closed`): [log](browser-blocker-merge.tap). Artifact-media has 2 passing tests and 7 blocked by Chromium launch (`crashpad setsockopt: Operation not permitted`): [log](artifact-media-blocker-merge.tap). Export HTTP also fails in this sandbox: [four-file invocation](sandbox-blockers-merge.tap). Full npm/browser/HTTP verification and visual screenshots remain for the operator outside the sandbox.
- Renderer/theme syntax checks and conflict-marker scan pass. No commit, staging, push, abort, checkout, stash, reset or rebase was performed; node_modules was untouched. Git's index deliberately still reports the three conflicted paths until the operator runs `git add` and commits the merge.

### Merge box verification (outside the Codex sandbox)

The sandbox `listen EPERM`, `Target closed` and crashpad failures above do not apply on the box. On 25 Oct 2026 the full `npm test` for the merged tree passed with Chromium: 74/74 S7 tests, all 3,483 legacy assertions (including `cardLiveSuite()` and `integrationSuite()`), and 56/56 tests across main's P1, P2, images-off and publishing files ([summary](npm-test-merge-box.txt)). `scripts/render-212-s7.js` passed its offline visual audit (24 PNGs) and `scripts/render-212-s7b.js` re-rendered the B3 Sunday note; the PNGs in [212-s7-renders](../212-s7-renders/) are from this merged tree.

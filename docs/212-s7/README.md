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

# Product carousel feasibility: do not release scrolling

Evidence collected 13 October 2026. This is a draft research component, not an approved email carousel. **No client is approved to receive scrolling.** Normal production HTML and Klaviyo exports always use one static stack of linked products. The `scroll` inspection mode works in a browser, but that is not email-client evidence.

Klaviyo removed the candidate's `@supports` enhancement when storing the template. Moving the style into the document head with `type="text/css" data-embed` did not preserve it either. The received Gmail candidate was consequently static. In addition, deliberately stripping only the overflow declaration from the browser candidate caused page-wide overflow. These failures prevent the dependable enhancement and fallback required for release.

## Client matrix

“Fallback” below is the HTML selected by the builder, not a claim that native rendering has been verified in every client. Versions/dates in the research column are the source's tested entries; they are not current installed versions.

| Client | Researched support and source entries | Received-email evidence | Current export |
| --- | --- | --- | --- |
| Apple Mail, iPhone | Caniemail: `@supports` supported, iOS 13 entry; flex supported, iOS 12.1. Overflow iOS 12.1 supported; 2024-10 partial note concerns logical overflow properties, not physical `overflow-x`. Potential candidate only. | Two preview jobs included the approved iCloud test destination. Receipt and interaction in native Apple Mail not verified; installed iOS/Mail version unknown. An iCloud account alone does not prove Apple Mail behaviour. | Static fallback; native rendering unverified. |
| Apple Mail, macOS | `@supports` supported, Mail 13 entry; flex supported, Mail 12.4. Overflow Mail 12.4 has “cannot scroll through to hidden content”; 2024-10 partial entry concerns logical properties. Historical differences require current native testing. | No macOS Mail device available. Version and interaction unverified. | Static fallback; native rendering unverified. |
| Gmail, web | `@supports` unsupported, 2020-05 entry. Flex supported, 2019-02; overflow 2024-10 partial note concerns logical properties. Property support alone does not establish this gated enhancement. | Candidate and fallback received. All three products visible once, images loaded, distinct tracking links working. Candidate horizontal input left `scrollLeft` at 0; region `display:block`, `overflow-x:visible`, client width and scroll width both 552px. Scrolling **failed**. Observed Gmail web build reference `gmail.pinto-server_20261007.17_p0`; desktop Chrome version not captured. | Static fallback; three-product light rendering verified in received mail. |
| Gmail, iPhone | `@supports` unsupported, 2020-05. Flex 2026-03 partial: non-Google accounts unsupported. Overflow 2024-10 partial note concerns logical properties. | No Gmail iOS app available. App/iOS versions, touch, dark mode and fallback rendering unverified. | Static fallback; native rendering unverified. |
| Gmail, Android | `@supports` unsupported, 2020-05. Flex 2026-03 partial for non-Google accounts. Overflow 2025-07 explicitly cannot scroll hidden content. | No Gmail Android app available. App/Android versions and interaction unverified. | Static fallback; native rendering unverified. |
| Outlook classic, Windows | Flex unsupported, 2007–2019 entries; `@supports` unsupported, 2003–2019; overflow unsupported, 2013–2024. | No Outlook account/client available. Windows/Outlook versions and fallback rendering unverified. The repository's Outlook HTML scanner passed; it is not native Outlook verification. | Static fallback; native rendering unverified. |
| New Outlook, Windows | No separate current new-Outlook entry in the cited feature data. Do not substitute Outlook.com research for native new-Outlook proof. | No account/client available. Version and interaction unverified. | Static fallback; native rendering unverified. |
| Outlook web | Outlook.com `@supports` unsupported, 2020-05; flex supported, 2019-02; overflow 2025-05 partial note concerns logical properties. | No Outlook web test account available. Web build and interaction unverified. | Static fallback; received rendering unverified. |

The read-only audience analysis for the preceding 90 days did not provide client versions or reliably distinguish Gmail platforms or Outlook variants. Machine/privacy opens and generic browser/proxy classifications prevent defensible client-share estimates. It does not justify reducing the requested test matrix. No profile-level data, recipient addresses or audience counts are included in this public repository.

To check the approved iCloud test inbox later, open the received test in the **Mail app on an iPhone or Mac**, rather than iCloud webmail. On iPhone record the iOS version from Settings → General → About; on Mac record macOS and Mail → About Mail. These already-sent templates are expected to show a static stack because Klaviyo removed the enhancement. Confirm all three names, images and product links, then repeat with images disabled and dark mode. A future enhanced candidate requires an actual horizontal swipe/trackpad action that reveals the next product, with a position or card-change record. Outlook needs a test account/client or an approved testing service offering real interaction; screenshot rendering alone cannot verify scrolling. No account creation or paid testing service was undertaken.

## Evidence and reproducibility

| Evidence | Artifact / method | What it establishes |
| --- | --- | --- |
| Exact outgoing test email | [sent-candidate.html](sent-candidate.html), [sent-fallback.html](sent-fallback.html), [sent-export-evidence.json](sent-export-evidence.json) | Full email through the existing live-block and production-shell path, before Klaviyo. The sent candidate contains `@supports` and overflow CSS. |
| Klaviyo storage and rendering | [klaviyo-stored-candidate.html](klaviyo-stored-candidate.html), [klaviyo-rendered-candidate.html](klaviyo-rendered-candidate.html) | Actual API readback after template creation and rendering, not a guessed sanitizer. The enhancement is absent in both. A second head-style preservation probe also lost it; that probe was not sent. |
| Received Gmail | [gmail-received-evidence.json](gmail-received-evidence.json) | Decoded received MIME and actual inbox DOM/interaction measurements. Candidate and fallback each had three linked cards and 21,892 HTML bytes. Three real Klaviyo tracking URLs returned HTTP 200 to the correct product, retained each distinct UTM, and added Klaviyo's `_kx` parameter. Recipient identifiers and raw tracking URLs are omitted. |
| Browser interaction and failures | [browser-evidence.json](browser-evidence.json), `npm run carousel:check` | Chrome/152.0.7977.82 renderer simulation at 320/375/600px. Wheel input moved the candidate 400/397/172px; Tab reached all products in order. This is browser evidence only. |
| Current editable sample and exports | [campaign.json](campaign.json), [fallback.html](fallback.html), [candidate-test-only.html](candidate-test-only.html), [export-evidence.json](export-evidence.json) | Regeneratable current prototype. Subsequent changes standardised card colours to existing brand black/grey and removed a redundant inline width cap. These exact current bytes were not resent. Preserve the `sent-*` snapshots when regenerating. |
| Builder production HTML download | [builder-production.html](builder-production.html), included in [export-evidence.json](export-evidence.json) | The UI download contained three cards, retained all distinct product UTMs, and omitted the enhancement even with scrolling selected in preview. The regeneratable artifact matches that downloaded file byte for byte. |

Two authorised preview templates were submitted to each of the two approved test destinations, four messages total. The preview-send API reported both jobs queued; both Gmail messages were received and inspected. iCloud receipt remains unverified. No customer campaign was created, scheduled or sent during the live feasibility test. The automated Klaviyo handler test stubs its external network writes.

Research, retrieved 13 October 2026:

- [Caniemail overflow](https://www.caniemail.com/features/css-overflow/), feature test date 2025-05-27; includes later individual entries such as Gmail Android 2025-07.
- [Caniemail `@supports`](https://www.caniemail.com/features/css-at-supports/), feature test date 2020-05-25. This is dated research, not current native testing.
- [Caniemail flex](https://www.caniemail.com/features/css-display-flex/), feature test date 2021-11-02; includes later individual entries.
- [Source data extract](researched-support.json), dataset last updated 2026-09-16.
- [Google's Gmail CSS documentation](https://developers.google.com/workspace/gmail/design/css), supported CSS reference, not interaction proof.
- [Klaviyo custom HTML/CSS troubleshooting](https://help.klaviyo.com/hc/en-us/articles/115005254488), updated 5 August 2025. Its general limitations supplement the actual roundtrip evidence above.

## Design and fallback

The cart reference was inspected at `https://figandbloom.com/cart?preview_theme_id=188818850025`. Cards use rectangular portrait images, white backgrounds, restrained borders, 8px rounding, readable names and optional prices. There is one anchor around each whole card, no separate details button, and one copy of every available product. The section uses the builder's 600px email shell with 24px side padding; cards are 228px wide, with images approximately 226 × 283px. The browser candidate exposes part of the next card. Production exports have no scrolling cue.

Shopify CDN images request actual 456 × 570 crops so unsupported `object-fit` is not the sole source of portrait dimensions. Other image hosts must supply pre-cropped 4:5 images. The optional heading uses Lust with Georgia/Times fallbacks; card text uses NeuzeitGro with Arial fallback. Section palettes use the existing white, clay and noir presets. Cards remain white across presets.

Inline block styles provide a static stack without depending on a second hidden version. Product links, the collection link outside the product region, and the separate campaign CTA remain in ordinary reading order. Scrolling is never necessary in normal exports. Text is escaped; merge-token braces and HTML in product fields cannot inject markup. Storefront destinations are restricted to HTTPS on `figandbloom.com`.

Known failures and gaps:

- **Partial CSS stripping:** retain flex but remove `overflow-x:auto`; a 375px browser page expands to 748px. The candidate does not meet the strict fail-safe requirement. It is available only for inspection and opt-in CLI test export.
- **Whole-email style-block stripping:** the normal fallback's inherited fixed-width production shell/footer expands a 375px simulation to 600px when all style blocks are removed. This is an existing shell dependency, outside this component's scoped implementation, and prevents claiming the complete email survives arbitrary CSS stripping.
- **Existing export-path difference:** the sliced Klaviyo path's `stripDocComments` also removes downlevel-revealed Outlook markers from the sample's standalone button; the full builder HTML export preserves them. This pre-existing transformation is visible in the artifacts and could expose both button versions in classic Outlook. Native Outlook rendering of the main CTA remains unverified; the component itself has one set of product anchors.
- **Native dark mode:** the existing shell declares a light colour scheme. Browser dark preference and forced Arial remain readable with black text on white cards. Gmail/Outlook colour inversion and Apple Mail dark rendering have not been verified in received emails.
- **Images disabled:** a browser simulation with unavailable images retains names, prices, alt descriptions and working product anchors. Native images-off rendering is unverified.
- **Accessibility:** browser Tab reaches all three cards in array order; links expose the image description and product name. No reordered CSS or duplicated fallback is used. Native screen-reader behaviour and keyboard interaction in mail apps remain unverified. The received Gmail accessibility tree exposes the same ordered product links.

## Adding and editing the draft component

1. Open the builder on this branch, select **products → carousel-prototype** in **Add a block**, or import [campaign.json](campaign.json). The Library contains realistic samples with available and price-free products.
2. Enter an optional section heading. Click **Add product**, then fill image URL, image description, product name and product URL. Price is optional. Use HTTPS `figandbloom.com` destinations. The limit is six cards.
3. Use **Move up**, **Move down** and **Remove product** to manage the ordered list. Fields are plain text. Choose the section's existing palette preset.
4. **Load store products** uses the existing Shopify context source; choose a product from its selector. It also refreshes availability for matching URLs. The existing source reads a maximum of 250 products, not a complete catalogue. Unmatched products retain their saved status; missing stock data is unknown.
5. Products explicitly marked unavailable are omitted on assembly or after refresh. Unknown status is retained for author review. Stock and displayed prices are snapshots: an already-delivered email cannot reliably reflect later stock changes.
6. Optionally provide both collection-link text and URL. Keep essential campaign content and its main CTA outside the product region, as the sample does.
7. `PREVIEW_MODE=fallback` inspects the stack; `scroll` inspects the browser candidate. **Export HTML** and **Push to Klaviyo** always export the static fallback regardless of saved mode. Keep this component in research/test designs until the release gaps are resolved.

Run `npm run carousel:export` to regenerate current JSON and both full-email HTML artifacts. Open `/carousel-probe` for a side-by-side interactive comparison, with desktop/mobile inspection widths. This comparison page uses iframes only to display standalone artifacts; the exported emails contain no JavaScript, iframe, Slick or AMP dependency. `npm run carousel:check` records browser simulations and screenshots under ignored `render-out/carousel/`.

For an isolated local preview, use Node 22 and a scratch store:

```sh
env -u KLAVIYO_API_KEY -u DATABASE_URL -u NOTION_TOKEN -u NOTION_DESIGNS_DB \
  PORT=4331 DATA_DIR=/tmp/email-carousel-designs node server.js
```

## Validation and release gates

The existing suite passed 3,318 assertions, and seven new tests passed. The new real HTTP test covers save/reopen, clone independence, JSON serialization, static production export even with an attempted probe flag, malformed/off-store destinations returning 422, and the real sliced Klaviyo export handler with external writes stubbed. The handler retains distinct product URLs and unsubscribe markup without rasterising or uploading the live product cards.

Browser authoring checks exercised add/remove/reorder, save and reopen, source loading, availability refresh and adding a product from the existing source. The UI's Export JSON download was read back from disk with all three ordered products and the saved preview mode intact; the browser automation download event timed out despite the successful download. The browser JSON-upload check was blocked because upload permission was declined, so UI import remains unverified; automated JSON roundtrip passed. Empty, single and six-product lists, known unavailable products, escaped names, missing prices, and collection-link pairing are covered by tests. Long-name rendering, missing images and fallback fonts were inspected in browser simulations. [Preview screenshot](preview.jpg) shows the browser candidate and its release warning; it does not establish email interaction.

The current three-product complete Klaviyo-path fallback is 20,778 bytes before tracking; the full builder HTML export is 23,646 bytes. The received three-product test was 21,892 bytes and Gmail did not clip it. Complete Klaviyo-path sample variants with a 200-character first title measured 17,563 / 18,826 / 24,170 bytes for zero / one / six products. These are below Gmail's approximately 102KB clipping threshold, but additional campaign blocks and tracking transformations increase size. Measure the complete final received campaign, not just this component.

Before any scrolling release, demonstrate a CSS strategy that survives the actual Klaviyo production path, fails safely under partial stripping, and passes touch/keyboard interaction in received mail on current named versions of every intended enhanced client. Record a swipe/wheel/keyboard action plus a measurable position or visible-card change, and verify the remaining products and collection/CTA links are reachable. Screenshots alone cannot pass this gate. Verify current native fallback, images-off, dark mode and screen-reader behaviour in the other matrix clients, and resolve the shell's stripping dependency separately. Until then, the recommendation is **do not release an email carousel**.

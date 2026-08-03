# Outlook degradation

Outlook 2007+ on Windows lays out mail with **Microsoft Word**, not a browser engine. Word
silently ignores a set of CSS properties: the declaration is dropped, nothing errors, and the
block reflows. This document says which properties, which components lean on them, and how to
see the damage before you send.

## Preview it

```
POST /api/render?client=outlook
{ "campaign": { … } }
```

Returns the usual `pngBase64`, plus:

```jsonc
{
  "client": "outlook",
  "outlookRisks": [
    {
      "index": 0,
      "component": "blocks/polaroid-collage",
      "rasterisedOnPublish": true,   // Outlook receives a PNG — the CSS never runs
      "hasVmlFallback": false,
      "atRisk": false,               // the field to read
      "unsupported": [ { "property": "position:absolute", "effect": "…" } ]
    }
  ]
}
```

The PNG and the report answer different halves of the question. The PNG shows how the layout
reflows; `outlookRisks` names the CSS that caused it and, crucially, whether it matters.

## Read `atRisk`, not the picture

The degraded PNG on its own cries wolf. Across the 55 components in the system, **46 declare CSS
Word drops and none are currently exposed.** The difference is what happens at publish:

- **Rasterised blocks are immune.** Every designed block is flattened to a PNG slice on push.
  Outlook receives an image. `position:absolute`, `transform`, `opacity` and `box-shadow` in
  `blocks/polaroid-collage` are irrelevant to Outlook because Outlook never sees that HTML.
- **Blocks with a VML fallback are covered.** `sections/button`, `heroes/hero-a` and
  `heroes/hero-image-only` ship Microsoft's vector markup inside `<!--[if gte mso 9]>`, so
  Outlook gets purpose-built markup rather than the CSS version.
- **The genuine exposure is the intersection**: a block that stays live HTML on publish *and*
  declares unsupported CSS *and* has no VML fallback. That is what `atRisk: true` means.

### Currently at risk

**Nothing.** The set is empty and a test pins it there, so a block that picks up unsupported CSS
fails the suite rather than quietly joining a list.

### What was exposed, and how it was closed

| Component | Was | Now |
|---|---|---|
| `sections/opt-out` | The "Opt Out" button was a padded `<a>` with no fallback, so Word rendered it as bare uppercase text carrying `text-decoration:none` — it did not even read as a link. The body measure also blew out from 380px to **504px**. | VML `roundrect` (outline style preserved via `strokecolor`, no fill), and a fixed-width 380px table. Measured 380px with and without the CSS. |
| `sections/body-copy-plain` | Body measure ran from 440px out to **472px**. | Fixed-width 440px table. Measured 440px either way. |
| `sections/full-width-image` | Reported for `max-width`. | **Was never a real risk** — the `<img>` carries `width="600"` inside a 600px container, so dropping the cap changes nothing. Measured 600px both ways. The scanner no longer reports `max-width` on an element that also has a `width` attribute. |

`sections/opt-out` was the one that mattered: it is the control offering people a way out of
Mother's Day, Father's Day and memorial sends, exactly where an obviously-clickable opt-out is
the entire point.

## The properties Word ignores

| Property | Effect when dropped |
|---|---|
| `position:absolute` | No positioning context — absolutely positioned elements fall back into normal flow and stack vertically. This is what destroys the polaroid collage. |
| `position:relative` | Ignored, so it cannot anchor a positioned child. |
| `transform` | Rotated/scaled elements render straight and unscaled. |
| `opacity` | A faint watermark renders at full strength. |
| `filter` | Grayscale/blur render as the original image. |
| `box-shadow` | Edges render flat. |
| `border-radius` | Rounded corners render square. |
| `max-width` | Ignored on block elements, so width-capped text runs full width. Constrain a measure with a fixed-width table instead. Not reported when the element also carries a `width` attribute, which Word honours — the cap is then redundant, not load-bearing. |
| `background-image` | Only supported via VML — a CSS background image does not paint. |
| `object-fit` | Images stretch to their width/height attributes instead of cropping. |
| `padding` + `display:inline-block` on an `<a>` | The commonest failure of the lot, and the reason `sections/button` ships VML: Word ignores both on an inline element, so a CSS button loses its box, colour and shape and becomes bare underlined text. Detected separately from the property list, since it is a markup pattern rather than one declaration. |

`text-transform` is **not** on this list — Word supports it. (It is close enough to `transform`
to be worth stating: an earlier version of the scanner matched it and reported every component
with an uppercase micro-label as broken.)

## What the preview cannot show

Two honest limits, both erring pessimistic:

1. **VML is not painted.** `v:roundrect` and `v:rect` are a Microsoft vector language no browser
   implements, so Chromium cannot render the Outlook fallback. The preview therefore shows the
   *non-VML* rendering — the worst case — for blocks that actually look correct in Outlook.
   `hasVmlFallback: true` marks them.
2. **Rasterised blocks are shown as live HTML.** The preview degrades the assembled HTML, but on
   publish those blocks become PNGs. `rasterisedOnPublish: true` marks them.

Neither limit is simulated away, because guessing would be worse than saying so. Read the PNG
for blocks where `atRisk` is `true`; for the rest it is illustrative, not predictive.

## Also unfixed: the decorative rose

Separate from the CSS list, `blocks/editorial-hero` positions a decorative rose with
`position:absolute` + `opacity`. It is a designed block, so publish rasterises it and Outlook is
fine — but if that block is ever moved to the html-only list, the decoration has to be baked into
the background artwork first.

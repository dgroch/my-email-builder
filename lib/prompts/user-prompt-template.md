# Fig & Bloom — Email Campaign User Prompt Template

> **The user-side message** that pairs with the system prompt. The host substitutes the brief into `{{BRIEF}}` and the audience into `{{AUDIENCE}}` before sending. The LLM is told to return **only the campaign JSON object** — no prose, no fences.

---

## The template

```
You are drafting a Fig & Bloom email campaign.

AUDIENCE (the Klaviyo list or segment this email will be sent to — may be "default" or "all subscribers" if not specified):
{{AUDIENCE}}

BRIEF (free-form, from the user — could be one sentence or a paragraph):
{{BRIEF}}

---

Return a single JSON object that exactly matches the Fig & Bloom campaign schema. No commentary, no markdown fences, no surrounding prose.

The schema is:

{
  "campaignName": "string — match the brief's campaign (use the naming convention from the system prompt)",
  "subjectLine": "string — under 50 chars, on-brand, no caps/emoji/exclamation",
  "previewText": "string — second line that extends (never repeats) the subject",
  "bodyBg": "string — hex colour, default #2c2825 (Noir) for premium beats, lighter for editorial/digest",
  "objective": "string — one of: farewell_sellthrough, range_launch, product_spotlight, occasion_gifting, discount_offer, value_prop, education_howto, social_proof, lifecycle, editorial_digest",
  "persona": "string — the primary persona + any cross-occasion layers (First-time sender, Long-distance sender)",
  "lensRouting": "string — the named lens blend, weights included (e.g. 'Ziglar 60 / Robbins 40')",
  "awarenessState": "string — what the reader already knows → what's new",
  "blocks": [
    { "component": "string (group-prefixed: heroes/, sections/, products/, blocks/ — or header/footer top-level)", "tokens": { "TOKEN_NAME": "string", ... } }
  ],
  "notes": "string (optional) — anything the agent or designer should know at review; inferences; product/price caveats"
}

Rules:
- Use ONLY components the schema recognises. Bare names like 'hero-d-clay' will fail validation — always use the group prefix ('heroes/hero-d-clay').
- HEADLINE casing follows the component's font: Cervanttis = lowercase, Lust = Sentence case. The validator enforces this.
- One primary CTA per email. Body copy: max 2 short paragraphs. Subject: under 50 chars. Australian English.
- If the brief is too thin to act on without guessing, return exactly: {"needsClarification": "<one short question>"}. Nothing else.
- Otherwise, return the complete JSON object. Self-check against the system prompt's 13-point QA bar before returning.
```

---

## Worked example — what the host sends to the LLM

`POST /v1/messages` body (Anthropic) or equivalent:

```json
{
  "model": "claude-sonnet-4",
  "max_tokens": 4096,
  "system": "<contents of system-prompt.md>",
  "messages": [
    {
      "role": "user",
      "content": "<contents of user-prompt-template.md, with BRIEF and AUDIENCE substituted>"
    }
  ]
}
```

After substituting:

```
You are drafting a Fig & Bloom email campaign.

AUDIENCE (the Klaviyo list or segment this email will be sent to):
RH | All Email Subscribers (Tww9G6) — default broad marketing audience.

BRIEF (free-form, from the user):
Farewell weekend for seven designs (Lucerne, Lisbon, Savoie, Genoa, Umbria, Paris, Pink Rose Bouquet) — they take their final bow Friday 5 and Saturday 6 June. Warm, fond tone, not a clearance. Soft tease of a glow up coming next week — don't reveal new products, just signal that something better is on the way. No discount framing. The 20% more stems upgrade is live for subscribers — frame as "more, not off". Stems+ woven into the glow up module.

---

Return a single JSON object ...
```

The LLM's response is then parsed as JSON, validated via `POST /api/validate`, and saved via `POST /api/designs`.

---

## What the host does with the response

1. Strip any leading/trailing whitespace or markdown fences (the LLM occasionally wraps the JSON in ```json ... ```).
2. Parse the JSON. If it fails, retry **once** with the LLM (system prompt + user template, plus an error note: *"The previous response failed JSON parse. Return ONLY the JSON object, no fences, no commentary."*).
3. If the response has `needsClarification`, surface that to the user in the UI.
4. Otherwise, call `POST /api/validate` on the builder with the campaign. If `ok: false`, retry **once** with the LLM, including the structured issues: *"Your previous response failed validation. Fix these issues and return the JSON again. Issues: <paste issues array>."*
5. If validation passes, call `POST /api/designs` with `{ name, campaign, subjectLine, previewText, isExample: false, objective }` to save. Capture the design `id`.
6. Return `{ designId, campaign, validation }` to the UI. The UI shows the JSON in the builder for review and edits.

---

## Edge cases

- **Brief mentions a specific blog URL.** Include the blog as a hero destination (CTA → blog), and add a secondary module tying the product to the blog's subject. Don't quote blog copy verbatim unless the user pastes it.
- **Brief asks for a discount / offer.** Route to `discount_offer`, use `blocks/offer-panel`, but **never** claim "best price" or "lowest ever" — frame the offer plainly as the value.
- **Brief is a recurring monthly edition.** Name it `EDM | YYYY-MM <Edition Name>`, route to `editorial_digest`, use the digest's block sequence, and **vary the open-block + palette from the previous edition** (track this in `notes`).
- **Brief mentions a sensitive occasion** (Mother's, Father's, Valentine's, pregnancy/baby, memorial). Include `sections/opt-out` immediately after the hero, and write the body with restraint — no guilt, no urgency.
- **Brief is a farewell / final sell-through.** Route to `farewell_sellthrough`, no `offer-panel`, no `promo-code`, no countdown timers, no "FINAL SALE" treatment. The tone is a fond send-off, not a fire sale.
- **Brief is for a range launch / tease.** Route to `range_launch`, use `blocks/editorial-hero` or `blocks/caption-bar-hero` as the open, *never* show specific new products the brief hasn't named.
- **Brief asks for sympathy.** Quietest visual treatment. No bright colour, no countdowns, no sale modules. Restrained, dignified, card-message help.
- **Brief mentions a same-day / "forgot it" panic.** This routes to **Whoosh**, not Fig & Bloom. If the user insists on Fig & Bloom, soften: "today, with care" / "we'll do our best" / "available in many areas". Do not promise same-hour delivery.

---

## Variable substitution reference

| Token | Replaced with |
|---|---|
| `{{BRIEF}}` | The user's free-form brief, verbatim, as captured from the textarea. |
| `{{AUDIENCE}}` | The Klaviyo list/segment name (user-supplied, or "default — RH \| All Email Subscribers" if unspecified). |

The host may also inject additional context not in this template — e.g. the current month's active product set, or a recent newsletter's design for tone reference. These are prepended to the system prompt, not the user template.

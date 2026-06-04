# Builder Backend — Task Spec & Status

The agent-facing backend tasks for this builder, with implementation status. The original
spec lives alongside the skill in `creative/creative-email-campaign-builder/references/` in
[`dgroch/skills`](https://github.com/dgroch/skills); this is the builder-repo copy so the
agent-facing and builder-facing sides stay coherent.

## Status summary

| Task | Verdict | Status |
|---|---|---|
| 1 — `GET /api/agent-contract` | **Skip** | Not built (by design). `/api/schema` + the skill are the contract. |
| 2 — `GET /api/examples` as tagged designs | Build (data, not a new subsystem) | ✅ Done |
| 3 — Intent metadata in `/api/schema` | Build (additive) | ✅ Done |
| 4 — Campaign objective taxonomy | Build (shared) | ✅ Done |
| 5 — Teaching validation errors | Build (highest value) | ✅ Done |
| 6 — Rich Notion metadata per design | Build | ✅ Done |

## Task 1 — Skip `/api/agent-contract`
Not added. The execution contract is `/api/schema` (now also carrying per-component intent +
the objectives taxonomy); the workflow/MUST-rules live in the skill. A second contract source
would be a drift risk for no new information.

## Task 2 — `GET /api/examples` as tagged designs
Examples are designs flagged `isExample:true` (no parallel system). `GET /api/examples` returns
committed seed exemplars (`examples/*.json`) merged with any store designs flagged `isExample`,
each with its full campaign + metadata. `?objective=` filters by objective.

- Seed: **"RH | 2026-06 Farewell Weekend + Glow Up Tease"** (`examples/farewell_sellthrough.json`),
  the `farewell_sellthrough` exemplar. Its source is the Notion design
  `375fdc24-425f-8185-87fd-e75630c999eb`; the committed seed is a rebuilt, group-prefixed copy
  (the live design was not reachable from the builder repo) and should be reconciled with the
  exported original.
- **Invariant** (enforced by `npm test`): every `isExample` design assembles with zero
  `(missing template)` and zero unfilled tokens.

## Task 3 — Intent metadata in `/api/schema`
Per-component optional fields (`bestFor`, `avoidFor`, `visualRole`, `requiresImage`,
`imageRatio`, `tone`) merged onto each component by `lib/parseTemplates.js`. Purely additive —
unknown keys are ignored by existing consumers, and components without an entry omit them.
Values come from the shared table `lib/componentStrategy.js` (mirror of
`references/component-strategy.md` — keep in sync; the test asserts no drift).

## Task 4 — Campaign objective taxonomy
Canonical objective list + per-objective guidance (block sequence, hero options, proof modules,
CTA style, urgency, modules to avoid) in `lib/componentStrategy.js`, surfaced under
`/api/schema` as `objectives` and used to filter `/api/examples`.

## Task 5 — Teaching validation errors
`lib/validate.js` → structured report. `POST /api/validate` returns it without rendering;
`/api/assemble` includes it as `validation`. Covers:
- **Bare/unknown component name** → `unknown_component` issue with a group-prefixed
  `suggestion` (e.g. `hero-d-clay` → `heroes/hero-d-clay`). This is the regression class that
  caused the original hand-coded-HTML bug.
- **Casing violations** → Cervanttis tokens must be lowercase, Lust tokens Sentence case;
  issue carries component, token, rule, and a corrected `suggestion`.
- **Unfilled tokens** → every `{{TOKEN}}` the template needs but the block didn't supply.

## Task 6 — Rich design metadata
`campaignType`, `objective`, `audienceAwareness`, `primaryCTA`, `emotionalTone`,
`componentsUsed` (derived from blocks), `approvalStatus` (`draft`|`approved`|`sent`),
`sourceBriefLink`, `klaviyoLink`, `resultNotes`. Shared by both backends via
`lib/designMeta.js`. Disk store persists them in the JSON record; Notion store persists them in
a metadata code block (always) and mirrors them into native columns when those columns exist
(see README → *Saving designs*).

## Guardrails
- **Design system is one-directional**: templates/shells/assets/manifest are sourced from
  `dgroch/skills`; `design-system/` mirrors it. Never edit templates only here.
- **Disk and Notion stores stay at interface parity** (`list/get/create/update/clone/remove`).
- **`npm test`** asserts every `/api/schema` component `name` resolves to a real template file
  (prevents the prefix-bug class) and the Task 2 example invariant.

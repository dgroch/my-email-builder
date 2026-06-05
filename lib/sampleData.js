'use strict';
// sampleData.js — realistic, on-brand sample token values for every component, so the
// interactive component library (GET /api/gallery) can render each component "alive" without
// the user having to fill a single field.
//
// Design goals:
//   1. COVERAGE BY CONSTRUCTION — we iterate each component's schema token list and fill
//      *every* token, so a sample campaign always assembles with zero unfilled tokens and
//      validates clean (the test suite asserts this for all components). New components are
//      covered automatically by the type/name heuristics; curated overrides only add polish.
//   2. LOCKED SYSTEM — palette tokens come from the component's own presets; enum levers from
//      the schema's enumOptions; case rules from the schema. The final pass normalises text to
//      the token's case rule so the library never shows a casing violation.
//   3. NO INVENTED BRAND — copy mirrors the existing "card is the hard part" sample voice and
//      the locked Cervanttis(lowercase)/Lust(sentence)/NeuzeitGro language.

// Public Fig & Bloom imagery (same CDN the in-app SAMPLE uses) — reachable from the preview
// iframe. Grouped by the role a token plays so collages/steps get distinct photos.
const P = 'https://cdn.shopify.com/s/files/1/0657/8723/2489/files/';
const IMG = {
  hero: P + 'WithLoveCard.jpg?v=1771723389',
  heroCU: P + 'WithLoveCardCU.jpg?v=1771723389',
  portrait: P + 'WithLoveCardCU.jpg?v=1771723389',
  products: [P + 'Lucerne-Large_2.jpg?v=1764283956', P + 'MonacoVaseArrangementPink_9.jpg?v=1764284295', P + 'Savoie-Cover.webp?v=1764284279'],
  squares: [P + 'GreetingCard-ThankYou.webp?v=1709067806', P + 'TulipGreetingCard.jpg?v=1732250184', P + 'ThinkingofYouDoveGreetingCard.jpg?v=1732250194'],
  steps: [P + 'SingleStemCardCU.jpg?v=1726026290', P + 'TulipGreetingCard.jpg?v=1732250184', P + 'FlowersCardCU.jpg?v=1726026071'],
  strip: P + 'WithLoveCard.jpg?v=1771723389',
};
const SITE = 'https://figandbloom.com.au';
const BLOG = 'https://figandbloom.com/blogs/news/what-to-write-on-flower-card';

// Trailing digit of a token name (PHOTO_2_URL → 2), else 1. Used to spread collage/step photos.
function indexOf(name) { const m = name.match(/_(\d+)/); return m ? Math.max(1, parseInt(m[1], 10)) : 1; }
function pick(arr, i) { return arr[(i - 1) % arr.length]; }

// A sample image URL appropriate to the token's role.
function sampleImage(name) {
  const n = name.toUpperCase();
  if (/PORTRAIT/.test(n)) return IMG.portrait;
  if (/LIFESTYLE/.test(n)) return IMG.hero;
  if (/STUDIO/.test(n)) return pick(IMG.products, 1);
  if (/HERO/.test(n)) return IMG.hero;
  if (/DIVIDER/.test(n)) return IMG.strip;
  if (/STEP/.test(n)) return pick(IMG.steps, indexOf(n));
  if (/PRODUCT/.test(n)) return pick(IMG.products, indexOf(n));
  if (/FRAME|PHOTO|LEFT|RIGHT|POLAROID/.test(n)) return pick(IMG.squares, indexOf(n));
  return pick(IMG.squares, 1);
}

// A sample click-through / link URL appropriate to the token's role.
function sampleUrl(name) {
  const n = name.toUpperCase();
  if (/UNSUBSCRIBE/.test(n)) return '{{ unsubscribe_url }}';
  if (/PRODUCT/.test(n)) return SITE + '/products/lucerne';
  if (/HERO|READ|GUIDE/.test(n)) return BLOG;
  return SITE + '/collections/bouquets';
}

// Curated text by exact token name (pre-case). The case pass at the end conforms each value to
// the token's rule, so the same HEADLINE reads sentence-case in Lust templates and lowercase in
// Cervanttis ones (upsell-noir/opt-out) without separate entries.
const TEXT = {
  SUPER_LABEL: 'FIG & BLOOM · NOTES',
  SECTION_SUPER: 'WHY THE WORDS MATTER',
  HEADLINE: 'When the card is the hard part',
  SUBHEADLINE: 'The flowers say a great deal before the card is even opened — here is how to write the few words they keep.',
  INTRO: 'Stuck at the message box? Decide what you want them to feel, then keep it this simple.',
  BODY: 'Choose the flowers, add your note at checkout, and we hand-write it onto a quality card — free with every order.',
  BODY_P1: 'When we first dreamed this up, we wanted it to feel like a slow Sunday morning — soft, generous and a little wild.',
  BODY_P2: 'This is your gentle reminder to send the ones you have been meaning to.',
  CTA_TEXT: 'Read the guide',
  ACCENT_SCRIPT: 'with love,',
  SIGNATURE: '— dan & kellie',
  CAPTION: 'peonies are back',
  BADGE_TEXT: 'bestseller',
  QUOTE_ACCENT: 'in their words',
  PULL_QUOTE: 'The flowers were beautiful, and the card said exactly what I couldn’t.',
  QUOTE_ATTRIBUTION: '— Sarah, Brisbane',
  PRODUCT_LABEL: 'SYMPATHY · THANK YOU',
  PRODUCT_NAME: 'Lucerne',
  PRODUCT_OCCASION: 'Contemporary white blooms for the gentlest moments.',
  PRODUCT_DESC: 'Hand-tied by our florists the morning it’s sent, with stems chosen to last.',
  PRODUCT_PRICE: 'From $105',
  REVIEW_STARS: '★★★★★',
  REVIEW_TEXT: 'Ordered from interstate for my mum and they were perfect — the note made her cry (the good kind).',
  REVIEWER_NAME: '— Sarah, Brisbane',
  OFFER_VALUE: 'Free delivery',
  ACCENT_RIBBON: 'this week only',
  CODE_LABEL: 'USE CODE AT CHECKOUT',
  PROMO_LABEL: 'A LITTLE THANK-YOU',
  PROMO_CODE: 'BLOOM',
  PROMO_TERMS: 'One use per customer. Excludes same-day. Ends Sunday.',
  OPT_OUT_HEADLINE: 'a gentle note',
  OPT_OUT_BODY: 'This send touches on a tender occasion. If it’s not the right time, you can step out of just this series — no hard feelings.',
  REGION_1: 'METRO',
  CUTOFF_1: 'Order by 1pm for same-day',
  REGION_2: 'NATIONWIDE',
  CUTOFF_2: 'Allow 2–3 days',
  CUTOFF_NOTE: 'Cut-offs tighten in peak weeks — order early where you can.',
  VS_ACCENT: 'vs',
  LEFT_LABEL: 'SUPERMARKET',
  RIGHT_LABEL: 'FIG & BLOOM',
  LEFT_CAPTION: 'wrapped in plastic',
  RIGHT_CAPTION: 'hand-tied, by name',
};

// Pattern fallbacks for families of tokens not listed by exact name.
function patternText(name) {
  const n = name.toUpperCase();
  if (/_NUMBER$/.test(n)) return String(indexOf(n));
  if (/STEP_\d+_TITLE$/.test(n)) return ['NAME THEM', 'SAY WHY', 'ADD ONE TRUE THOUGHT'][(indexOf(n) - 1) % 3];
  if (/STEP_\d+_TEXT$/.test(n)) return ['Open with their name — it makes the note feel meant for them.', 'One honest reason: celebrating you, thinking of you, thank you.', 'A single specific line they’ll remember, then sign off in your own voice.'][(indexOf(n) - 1) % 3];
  if (/FEATURE_\d+_TITLE$/.test(n)) return ['THE RIGHT WORDS', 'HANDWRITTEN, FREE', 'SAME-DAY DELIVERY'][(indexOf(n) - 1) % 3];
  if (/FEATURE_\d+_TEXT$/.test(n)) return ['Message ideas for every occasion, ready to make your own.', 'We write your note by hand on a quality card with every order.', 'Order before 1pm for same-day delivery across the city.'][(indexOf(n) - 1) % 3];
  if (/_CAPTION$/.test(n)) return ['thank you,', 'with love,', 'thinking of you,'][(indexOf(n) - 1) % 3];
  if (/CHIP_\d+_TEXT$/.test(n)) return ['locally grown', 'lasts 10+ days', 'hand-tied'][(indexOf(n) - 1) % 3];
  if (/_TITLE$/.test(n)) return 'A few words they keep';
  if (/_LABEL$/.test(n) || /_SUPER$/.test(n)) return 'FIG & BLOOM · NOTES';
  if (/_NAME$/.test(n)) return 'Lucerne';
  if (/_PRICE$/.test(n)) return 'From $105';
  if (/_TEXT$/.test(n) || /BODY|DESC|QUOTE|SUB/.test(n)) return TEXT.SUBHEADLINE;
  return 'Fig & Bloom';
}

// Conform a text value to the token's case rule so the library never shows a violation.
function conformCase(value, rule) {
  if (!value || !/[A-Za-z]/.test(value)) return value;
  if (rule === 'lower') return value.toLowerCase();
  if (rule === 'sentence') {
    const i = value.search(/[A-Za-z]/);
    // all-lowercase fails the Sentence-case rule → capitalise the first letter
    if (!/[A-Z]/.test(value)) return value.slice(0, i) + value[i].toUpperCase() + value.slice(i + 1);
  }
  return value;
}

// Per-component overrides — the richest, most representative copy for the marquee components.
// These layer over the generated defaults; anything they omit still gets a generated value.
const COMPONENT_SAMPLES = {
  'blocks/editorial-hero': {
    HERO_IMAGE_URL: IMG.hero, SUPER_LABEL: 'FIG & BLOOM · NOTES', ACCENT_SCRIPT: 'with love,',
    HEADLINE: 'When the card is the hard part',
    SUBHEADLINE: 'The flowers say a great deal before the card is even opened. Here is how to write the few words they keep.',
    CTA_TEXT: 'Read the guide', CTA_URL: BLOG,
  },
  'blocks/caption-bar-hero': {
    HERO_IMAGE_URL: IMG.hero, SUPER_LABEL: 'FLOWER OF THE MONTH', CAPTION: 'peonies are back', CTA_TEXT: 'Shop the bloom', CTA_URL: SITE + '/collections/bouquets',
  },
  'blocks/story': {
    SUPER_LABEL: 'FROM THE FOUNDERS', HEADLINE: 'A note from our family to yours',
    BODY_P1: 'Retiring a range we love is never easy, but it’s how we keep every bouquet feeling fresh and seasonal for you.',
    BODY_P2: 'Something new is already on the bench — a little glow-up we can’t wait to show you.',
    SIGNATURE: '— dan & kellie', CTA_TEXT: 'Read our note',
  },
  'blocks/designed-product-card': {
    BADGE_TEXT: 'bestseller', PRODUCT_LABEL: 'SPOTLIGHT', PRODUCT_NAME: 'Lucerne',
    PRODUCT_OCCASION: 'Contemporary white blooms for the gentlest moments.', PRODUCT_PRICE: 'From $105', CTA_TEXT: 'Shop Lucerne',
  },
  'blocks/offer-panel': {
    SUPER_LABEL: 'A LITTLE THANK-YOU', OFFER_VALUE: 'Free delivery', HEADLINE: 'On us, this week',
    SUBHEADLINE: 'Our small way of saying thanks for being here.', ACCENT_RIBBON: 'this week only',
    CODE_LABEL: 'USE CODE AT CHECKOUT', PROMO_CODE: 'BLOOM', CTA_TEXT: 'Send flowers',
  },
  'blocks/polaroid-collage': {
    PHOTO_1_CAPTION: 'thank you,', PHOTO_2_CAPTION: 'with love,', PHOTO_3_CAPTION: 'thinking of you,',
    QUOTE_ACCENT: 'in their words', PULL_QUOTE: 'The flowers were beautiful, and the card said exactly what I couldn’t.', QUOTE_ATTRIBUTION: '— Sarah, Brisbane',
  },
  'blocks/editorial-collage': {
    SUPER_LABEL: 'THE EDIT', ACCENT_SCRIPT: 'this month,', PULL_QUOTE: 'Three frames, one quiet story about slowing down with flowers.', CTA_TEXT: 'Read the edit',
  },
  'blocks/annotated-product': {
    PRODUCT_LABEL: 'SPOTLIGHT', PRODUCT_NAME: 'Lucerne', PRODUCT_OCCASION: 'Contemporary white blooms for the gentlest moments.', PRODUCT_PRICE: 'From $105',
    CHIP_1_TEXT: 'locally grown', CHIP_2_TEXT: 'lasts 10+ days', CHIP_3_TEXT: 'hand-tied', CTA_TEXT: 'Shop Lucerne',
  },
  'blocks/comparison-vs': {
    HEADLINE: 'The difference is in the details', LEFT_LABEL: 'SUPERMARKET', RIGHT_LABEL: 'FIG & BLOOM',
    LEFT_CAPTION: 'wrapped in plastic', RIGHT_CAPTION: 'hand-tied, by name', VS_ACCENT: 'vs', CTA_TEXT: 'See the difference',
  },
  'blocks/feature-list': {
    SECTION_SUPER: 'WHY THE WORDS MATTER', HEADLINE: 'A few words they will keep', POLAROID_CAPTION: 'with love,', CTA_TEXT: 'Read the guide',
  },
  'sections/testimonial': { REVIEW_STARS: '★★★★★', REVIEW_TEXT: 'Ordered from interstate and they were perfect — the note made her cry (the good kind).', REVIEWER_NAME: '— Sarah, Brisbane' },
  'sections/upsell-noir': { SUPER_LABEL: 'READY WHEN YOU ARE', HEADLINE: 'for the moment they feel what you meant', BODY: 'Choose the flowers, add your note at checkout, and we hand-write it onto a card — free with every order.', CTA_TEXT: 'Send with a note' },
};

// Build the complete sample token set for a component. opts.palette selects a palette preset by
// name; opts.levers overrides specific enum tokens (used by the library's live-variation +
// variant-compare controls). Everything not overridden is filled from curated/generated values.
function sampleTokensFor(comp, opts = {}) {
  const tokens = {};
  const presets = comp.palettePresets || [];
  const preset = (opts.palette && presets.find((p) => p.name === opts.palette)) || presets[0];

  for (const t of comp.tokens) {
    let v;
    if (t.type === 'palette') {
      v = preset ? preset.values[t.name] : '#000000';
    } else if (t.type === 'enum') {
      v = (opts.levers && opts.levers[t.name]) || (t.enumOptions && t.enumOptions[0]) || '';
    } else if (t.type === 'image') {
      v = sampleImage(t.name);
    } else if (t.type === 'url') {
      v = sampleUrl(t.name);
    } else {
      v = (TEXT[t.name] != null ? TEXT[t.name] : patternText(t.name));
    }
    tokens[t.name] = v;
  }

  // Layer curated per-component copy (text/image specifics) over the generated base.
  const curated = COMPONENT_SAMPLES[comp.name];
  if (curated) for (const [k, val] of Object.entries(curated)) if (k in tokens) tokens[k] = val;

  // Palette + levers always win (so variant-compare can hold copy steady while swapping these).
  if (preset) for (const [k, val] of Object.entries(preset.values)) if (k in tokens) tokens[k] = val;
  if (opts.levers) for (const [k, val] of Object.entries(opts.levers)) if (k in tokens) tokens[k] = val;

  // Final case pass — guarantees zero casing violations in the library.
  for (const t of comp.tokens) {
    if (t.case && typeof tokens[t.name] === 'string') tokens[t.name] = conformCase(tokens[t.name], t.case);
  }
  return tokens;
}

// A one-block sample campaign for a component (drops straight into /api/assemble or /api/validate).
function sampleCampaignFor(comp, opts = {}) {
  return {
    campaignName: comp.name + ' — sample',
    bodyBg: '#2c2825',
    blocks: [{ component: comp.name, tokens: sampleTokensFor(comp, opts) }],
  };
}

// The variant axes a component supports, for the library's variant-compare strip:
//   - palette presets (white/clay/50clay/noir), and
//   - the first enum lever's options (ROTATION/TYPE_SCALE/DENSITY/IMG_HEIGHT/…).
function variantsFor(comp) {
  const palettes = (comp.palettePresets || []).map((p) => p.name);
  const leverToken = comp.tokens.find((t) => t.type === 'enum');
  const lever = leverToken ? { name: leverToken.name, options: leverToken.enumOptions || [] } : null;
  return { palettes, lever };
}

module.exports = { sampleTokensFor, sampleCampaignFor, variantsFor, IMG, P };

'use strict';
// componentStrategy.js — the builder-side mirror of the campaign-strategy knowledge that
// lives in `creative/creative-email-campaign-builder/references/component-strategy.md`
// inside `dgroch/skills`. It is the single shared table that feeds both:
//   • the per-component intent metadata exposed on /api/schema (bestFor / avoidFor / …), and
//   • the campaign-objective taxonomy exposed on /api/schema (`objectives`).
//
// Why it lives here: the design-system is one-directional (templates are sourced from the
// skills repo and mirrored into design-system/), so this strategy layer is *additive*
// builder metadata. Keep it in sync with component-strategy.md — the OBJECTIVES list and
// the per-component verdicts must not disagree with the skill. parseTemplates.js merges
// COMPONENT_INTENT onto the matching component by its group-prefixed `name`, and the build
// asserts (see test/) that every intent key and every bestFor/avoidFor value is valid.

// ── Task 4: canonical campaign-objective taxonomy ────────────────────────────
// Mirror of component-strategy.md. The order is the canonical order.
const OBJECTIVES = [
  'farewell_sellthrough',
  'range_launch',
  'product_spotlight',
  'occasion_gifting',
  'discount_offer',
  'value_prop',
  'education_howto',
  'social_proof',
  'lifecycle',
  'editorial_digest',
];

// Per-objective recommendations: a block sequence skeleton, hero options, proof modules,
// CTA style, urgency level, modules to avoid, and 3–5 subject-line patterns. Component names
// are group-prefixed so they match /api/schema `name` values directly. subjectPatterns are
// restrained curiosity-gap templates ({placeholders} the agent fills) — no clickbait, no
// discount-leading, no manufactured urgency (brand guardrail).
const OBJECTIVE_GUIDANCE = {
  farewell_sellthrough: {
    label: 'Farewell / final sell-through of a discontinued range',
    blockSequence: ['header', 'blocks/editorial-hero', 'sections/body-copy-plain', 'products/card-horizontal', 'blocks/story', 'sections/trust-bar', 'footer'],
    heroOptions: ['blocks/editorial-hero', 'heroes/hero-d-clay', 'blocks/caption-bar-hero'],
    proofModules: ['blocks/story', 'sections/testimonial'],
    ctaStyle: 'Direct, scarcity-aware — "Shop while they last", square black button.',
    urgency: 'high',
    avoid: ['blocks/offer-panel', 'sections/promo-code'],
    subjectPatterns: [
      'The last weekend for {range}',
      '{range} is retiring — one final gather',
      'Before {range} says goodbye',
      'A farewell to {range}',
    ],
  },
  range_launch: {
    label: 'Launch a new range or collection',
    blockSequence: ['header', 'blocks/editorial-hero', 'sections/body-copy-plain', 'products/card-lifestyle-studio', 'blocks/polaroid-collage', 'sections/trust-bar', 'footer'],
    heroOptions: ['blocks/editorial-hero', 'heroes/hero-image-only', 'blocks/caption-bar-hero'],
    proofModules: ['blocks/polaroid-collage', 'blocks/feature-list'],
    ctaStyle: 'Aspirational discovery — "Explore the range".',
    urgency: 'low',
    avoid: ['blocks/offer-panel'],
    subjectPatterns: [
      'Introducing {range}',
      'Something new is blooming: {range}',
      'Meet {range}',
      '{range} has arrived',
    ],
  },
  product_spotlight: {
    label: 'Spotlight a single hero product',
    blockSequence: ['header', 'blocks/caption-bar-hero', 'blocks/designed-product-card', 'products/card-single-testimonial', 'sections/trust-bar', 'footer'],
    heroOptions: ['blocks/caption-bar-hero', 'heroes/hero-image-only', 'blocks/editorial-hero'],
    proofModules: ['products/card-single-testimonial', 'sections/testimonial'],
    ctaStyle: 'Singular and confident — "Shop {product}".',
    urgency: 'low',
    avoid: ['blocks/comparison-vs', 'blocks/howto-steps'],
    subjectPatterns: [
      'A closer look at {product}',
      'The story behind {product}',
      'Why we keep coming back to {product}',
      '{product}, in one word',
    ],
  },
  occasion_gifting: {
    label: 'Occasion / seasonal gifting (Mother’s Day, Valentines, etc.)',
    blockSequence: ['header', 'heroes/hero-a', 'sections/opt-out', 'sections/body-copy-plain', 'products/card-horizontal', 'sections/delivery-cutoffs', 'sections/trust-bar', 'footer'],
    heroOptions: ['heroes/hero-a', 'blocks/editorial-hero', 'blocks/caption-bar-hero'],
    proofModules: ['blocks/polaroid-collage', 'sections/testimonial'],
    ctaStyle: 'Warm and timely — "Shop the edit". Pair with delivery-cutoffs.',
    urgency: 'medium',
    avoid: ['blocks/offer-panel'],
    subjectPatterns: [
      'The {occasion} edit is here',
      'What to send this {occasion}',
      'Sorted for {occasion}',
      '{occasion} is closer than you think',
    ],
  },
  discount_offer: {
    label: 'Discount / promotional offer',
    blockSequence: ['header', 'blocks/offer-panel', 'sections/body-copy-plain', 'products/card-horizontal', 'sections/trust-bar', 'footer'],
    heroOptions: ['blocks/offer-panel', 'heroes/hero-d-clay'],
    proofModules: ['sections/testimonial'],
    ctaStyle: 'Action-first with the code visible — "Use BLOOM20".',
    urgency: 'high',
    avoid: ['blocks/editorial-hero', 'blocks/story', 'blocks/comparison-vs'],
    // Brand guardrail: subjects stay value-led, never discount-leading or urgency-faking.
    subjectPatterns: [
      'A little thank-you, just for you',
      'We saved you something',
      'Your reason to send flowers this week',
      'Something for your next bouquet',
    ],
  },
  value_prop: {
    label: 'Communicate why we’re different (value proposition)',
    blockSequence: ['header', 'heroes/hero-d-clay', 'blocks/feature-list', 'blocks/comparison-vs', 'sections/trust-bar', 'footer'],
    heroOptions: ['heroes/hero-d-clay', 'blocks/editorial-hero'],
    proofModules: ['blocks/comparison-vs', 'blocks/feature-list', 'sections/testimonial'],
    ctaStyle: 'Reassuring — "See the difference".',
    urgency: 'low',
    avoid: ['blocks/offer-panel'],
    subjectPatterns: [
      'What makes a Fig & Bloom bouquet',
      'The difference is in the details',
      'Why our flowers last longer',
      'Not all bouquets are made the same',
    ],
  },
  education_howto: {
    label: 'Educational / how-to / care content',
    blockSequence: ['header', 'blocks/caption-bar-hero', 'blocks/howto-steps', 'sections/trust-bar', 'footer'],
    heroOptions: ['blocks/caption-bar-hero', 'heroes/hero-image-only'],
    proofModules: ['sections/testimonial'],
    ctaStyle: 'Soft and helpful — "Read the guide".',
    urgency: 'low',
    avoid: ['blocks/offer-panel', 'sections/promo-code'],
    subjectPatterns: [
      'How to make your blooms last',
      "A florist's guide to {topic}",
      'Three steps to {outcome}',
      'The secret to {topic}',
    ],
  },
  social_proof: {
    label: 'Reviews / testimonials / customer stories',
    blockSequence: ['header', 'blocks/caption-bar-hero', 'blocks/polaroid-collage', 'sections/testimonial', 'products/card-single-testimonial', 'sections/trust-bar', 'footer'],
    heroOptions: ['blocks/caption-bar-hero', 'heroes/hero-a'],
    proofModules: ['sections/testimonial', 'products/card-single-testimonial', 'blocks/comparison-vs'],
    ctaStyle: 'Confidence-borrowing — "See why they love us".',
    urgency: 'low',
    avoid: ['blocks/offer-panel'],
    subjectPatterns: [
      'In their words',
      'What our customers are saying',
      'Why they keep coming back',
      'The reviews are in',
    ],
  },
  lifecycle: {
    label: 'Lifecycle / nurture (welcome, re-engagement, post-purchase)',
    blockSequence: ['header', 'blocks/story', 'blocks/howto-steps', 'sections/upsell-noir', 'sections/trust-bar', 'footer'],
    heroOptions: ['blocks/story', 'heroes/hero-d-clay'],
    proofModules: ['blocks/story', 'sections/testimonial'],
    ctaStyle: 'Relationship-led — "Welcome" / "We’d love you back".',
    urgency: 'low',
    avoid: ['blocks/offer-panel'],
    subjectPatterns: [
      'Welcome to Fig & Bloom',
      "We've been thinking of you",
      'A little note, just for you',
      "Here's where to begin",
    ],
  },
  editorial_digest: {
    label: 'Recurring editorial digest / monthly newsletter',
    blockSequence: ['header', 'blocks/caption-bar-hero', 'blocks/story', 'sections/section-headline', 'products/card-horizontal', 'sections/upsell-noir', 'sections/trust-bar', 'footer'],
    heroOptions: ['blocks/caption-bar-hero', 'blocks/editorial-hero'],
    proofModules: ['blocks/story', 'blocks/polaroid-collage'],
    ctaStyle: 'Soft, curiosity-led — "Read this month’s edit".',
    urgency: 'low',
    avoid: ['blocks/offer-panel', 'sections/promo-code', 'sections/delivery-cutoffs'],
    subjectPatterns: [
      'This month in bloom',
      'Your {month} edit',
      'Notes from the studio',
      "What's blooming this {month}",
      'The {month} edition',
    ],
  },
};

// ── Task 3: per-component intent metadata ────────────────────────────────────
// Keyed by the group-prefixed component `name` (matching /api/schema). Every field is
// optional from a consumer's perspective; unknown components simply carry no intent.
const COMPONENT_INTENT = {
  'blocks/editorial-hero': {
    bestFor: ['range_launch', 'occasion_gifting', 'product_spotlight', 'farewell_sellthrough'],
    avoidFor: ['discount_offer', 'value_prop'],
    visualRole: 'high-impact opening: photo + serif headline + script accent on an overlapping plate',
    requiresImage: true, imageRatio: '600x440', tone: 'editorial, premium, calm',
  },
  'blocks/caption-bar-hero': {
    bestFor: ['product_spotlight', 'range_launch', 'occasion_gifting', 'education_howto'],
    avoidFor: ['discount_offer'],
    visualRole: 'full-bleed lifestyle photo with a caption/label bar — photo-led opener',
    requiresImage: true, imageRatio: '600x600 or 600x440', tone: 'editorial, photographic',
  },
  'blocks/offer-panel': {
    bestFor: ['discount_offer'],
    avoidFor: ['education_howto', 'social_proof', 'farewell_sellthrough', 'range_launch'],
    visualRole: 'bold designed offer hero: large display value, dashed code box, rotated script ribbon',
    requiresImage: false, imageRatio: null, tone: 'bold, urgent, promotional',
  },
  'blocks/feature-list': {
    bestFor: ['value_prop', 'product_spotlight', 'range_launch'],
    avoidFor: ['discount_offer'],
    visualRole: 'tilted polaroid + clay-disc icon-bullet feature list',
    requiresImage: true, imageRatio: '192x216', tone: 'editorial, informative',
  },
  'blocks/comparison-vs': {
    bestFor: ['value_prop', 'social_proof'],
    avoidFor: ['discount_offer', 'occasion_gifting'],
    visualRole: 'side-by-side "vs" comparison of two photos with a script badge between',
    requiresImage: true, imageRatio: '210x210', tone: 'confident, proof-led',
  },
  'blocks/howto-steps': {
    bestFor: ['education_howto', 'lifecycle'],
    avoidFor: ['discount_offer'],
    visualRole: 'vertical numbered how-to / care sequence with per-step photos',
    requiresImage: true, imageRatio: 'square step photos', tone: 'helpful, instructional',
  },
  'blocks/polaroid-collage': {
    bestFor: ['social_proof', 'occasion_gifting', 'range_launch'],
    avoidFor: ['discount_offer'],
    visualRole: 'tilted polaroid collage + Lust pull-quote',
    requiresImage: true, imageRatio: '168x168', tone: 'warm, candid',
  },
  'blocks/story': {
    bestFor: ['farewell_sellthrough', 'lifecycle', 'social_proof'],
    avoidFor: ['discount_offer'],
    visualRole: 'portrait photo + narrative paragraphs + script signature',
    requiresImage: true, imageRatio: '240x300', tone: 'intimate, narrative',
  },
  'blocks/designed-product-card': {
    bestFor: ['product_spotlight', 'range_launch'],
    avoidFor: ['education_howto'],
    visualRole: 'product spotlight with tilted script badge + price plate',
    requiresImage: true, imageRatio: '280x350 (4:5)', tone: 'premium, product-led',
  },
  'heroes/hero-a': {
    bestFor: ['occasion_gifting', 'range_launch'],
    avoidFor: ['discount_offer'],
    visualRole: 'text over a full-bleed lifestyle image',
    requiresImage: true, imageRatio: '600x500', tone: 'warm, editorial',
  },
  'heroes/hero-image-only': {
    bestFor: ['product_spotlight', 'range_launch'],
    avoidFor: ['discount_offer', 'value_prop'],
    visualRole: 'full-width image, no text — the image tells the story',
    requiresImage: true, imageRatio: '600x750 (4:5)', tone: 'photographic, minimal',
  },
  'heroes/hero-d-clay': {
    bestFor: ['discount_offer', 'value_prop', 'farewell_sellthrough', 'lifecycle'],
    avoidFor: ['product_spotlight'],
    visualRole: 'dark, type-forward hero with no photo',
    requiresImage: false, imageRatio: null, tone: 'bold, dramatic',
  },
  'products/card-horizontal': {
    bestFor: ['product_spotlight', 'occasion_gifting', 'farewell_sellthrough'],
    avoidFor: ['education_howto'],
    visualRole: 'horizontal product card: image left, info + price + CTA right',
    requiresImage: true, imageRatio: '280x350 (4:5)', tone: 'clean, product-led',
  },
  'products/card-single-testimonial': {
    bestFor: ['social_proof', 'product_spotlight'],
    avoidFor: ['education_howto'],
    visualRole: 'product photo left + customer review right',
    requiresImage: true, imageRatio: '340x425 (4:5)', tone: 'trustworthy, proof-led',
  },
  'products/card-lifestyle-studio': {
    bestFor: ['product_spotlight', 'range_launch'],
    avoidFor: ['discount_offer'],
    visualRole: 'lifestyle photo above + studio product photo below',
    requiresImage: true, imageRatio: '600x400 / 600x500', tone: 'editorial, product-led',
  },
  'sections/promo-code': {
    bestFor: ['discount_offer', 'occasion_gifting'],
    avoidFor: ['education_howto'],
    visualRole: 'inline dashed promo-code box (live HTML, no slice)',
    requiresImage: false, imageRatio: null, tone: 'promotional',
  },
  'sections/upsell-noir': {
    bestFor: ['lifecycle', 'occasion_gifting'],
    avoidFor: ['discount_offer'],
    visualRole: 'dark closing-beat upsell on a noir background',
    requiresImage: false, imageRatio: null, tone: 'premium, closing',
  },
  'sections/testimonial': {
    bestFor: ['social_proof', 'product_spotlight', 'value_prop'],
    avoidFor: ['discount_offer'],
    visualRole: 'full-width star review on a 50%-clay background',
    requiresImage: false, imageRatio: null, tone: 'trustworthy',
  },
};

module.exports = { OBJECTIVES, OBJECTIVE_GUIDANCE, COMPONENT_INTENT };

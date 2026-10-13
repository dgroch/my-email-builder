'use strict';
// Research prototype. Shipping paths deliberately omit the enhancement until received-mail
// interaction and sanitisation evidence meet docs/product-carousel/compatibility.md.
const COMPONENT = 'products/carousel-prototype';
const MAX_PRODUCTS = 6;
const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
function validUrl(value, storefront = false) {
  if (typeof value !== 'string' || /[\s<>"{}]/.test(value)) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password
      && (!storefront || u.hostname === 'figandbloom.com');
  } catch (_) { return false; }
}
function problems(tokens = {}) {
  const out = [];
  const add = (token, message) => out.push({ token, message });
  const products = tokens.PRODUCTS ?? [];
  if (!Array.isArray(products)) add('PRODUCTS', 'PRODUCTS must be an ordered array.');
  else {
    if (products.length > MAX_PRODUCTS) add('PRODUCTS', `Use at most ${MAX_PRODUCTS} products.`);
    products.forEach((p, i) => {
      const key = `PRODUCTS[${i}]`;
      if (!p || typeof p !== 'object' || Array.isArray(p)) return add(key, 'Each product must be an object.');
      if (p.available != null && typeof p.available !== 'boolean') add(key, 'Product availability must be true, false or null (unknown).');
      // Known unavailable products are removed before layout, including incomplete saved rows.
      if (p.available === false) return;
      for (const field of ['title', 'alt']) {
        if (typeof p[field] !== 'string' || !p[field].trim() || p[field].length > 240)
          add(`${key}.${field}`, `Product ${field} must contain 1–240 characters.`);
      }
      if (!validUrl(p.image)) add(`${key}.image`, 'Product image must be an absolute HTTPS URL.');
      if (!validUrl(p.url, true)) add(`${key}.url`, 'Product destination must use https://figandbloom.com.');
      if (p.price != null && (typeof p.price !== 'string' || p.price.length > 80)) add(`${key}.price`, 'Optional product price must be text of at most 80 characters.');
    });
  }
  if (!!tokens.COLLECTION_TEXT !== !!tokens.COLLECTION_URL) add('COLLECTION_URL', 'Provide both collection-link text and URL, or leave both empty.');
  if (tokens.COLLECTION_URL && !validUrl(tokens.COLLECTION_URL, true)) add('COLLECTION_URL', 'Collection destination must use https://figandbloom.com.');
  return out;
}

// Shopify's existing image service supplies actual 4:5 pixels even where object-fit is ignored.
// Custom image hosts should be supplied pre-cropped to 4:5; do not invent a second upload service.
function portraitUrl(src) {
  const u = new URL(src);
  if (u.hostname === 'cdn.shopify.com') {
    u.searchParams.set('width', '456'); u.searchParams.set('height', '570'); u.searchParams.set('crop', 'center');
  }
  return u.href;
}

const enhancement = `<style data-carousel-experiment="unverified">
@supports (display:flex) and (overflow-x:auto) and (-webkit-appearance:none) {
  .fbc-products { display:flex!important; width:552px!important; max-width:calc(100vw - 48px)!important; overflow-x:auto!important; gap:20px!important; padding-bottom:12px!important; }
  .fbc-products .fbc-card { flex:0 0 228px!important; margin:0!important; }
}
</style>`;

function prepare(html, tokens, opts = {}) {
  html = html.replace(/^<!--[\s\S]*?-->/, '');
  const issues = problems(tokens);
  if (issues.length) throw Object.assign(new Error(issues.map(i => i.message).join(' ')), { code: 'INVALID_PRODUCTS' });
  const products = (tokens.PRODUCTS || []).filter(p => p.available !== false);
  const cards = products.map((p, i) => `<a class="fbc-card" data-carousel-card="${i + 1}" href="${esc(p.url)}" target="_blank" style="display:block;width:228px;max-width:100%;margin:0 auto 24px;box-sizing:border-box;border:1px solid #e8e2da;border-radius:8px;background:#ffffff;color:#000000;text-decoration:none;white-space:normal;overflow-wrap:anywhere;">
<img src="${esc(portraitUrl(p.image))}" width="226" height="283" alt="${esc(p.alt)}" style="display:block;width:100%;max-width:226px;height:auto;aspect-ratio:4/5;object-fit:cover;border:0;border-radius:7px 7px 0 0;">
<span style="display:block;padding:18px 16px 20px;font-family:'NeuzeitGro',Arial,sans-serif;font-size:17px;line-height:1.4;text-align:left;color:#000000;">${esc(p.title)}${p.price ? `<span style="display:block;margin-top:8px;font-size:15px;color:#444444;">${esc(p.price)}</span>` : ''}</span></a>`).join('\n');
  // carouselProbe is an in-process research option, never accepted from the HTTP request or
  // campaign JSON. assembleBlocks() defaults to shipping, regardless of the saved preview mode.
  const experimental = products.length > 1 && (opts.carouselProbe === true || (!opts.production && tokens.PREVIEW_MODE === 'scroll'));
  html = html.replace('<!-- CAROUSEL_ENHANCEMENT -->', experimental ? enhancement : '')
    .split('{{PRODUCTS}}').join(cards);
  const safe = { ...tokens, PRODUCTS: '' };
  for (const key of ['SECTION_HEADING', 'COLLECTION_TEXT', 'COLLECTION_URL']) safe[key] = esc(tokens[key]);
  // Palette tokens are not free-form CSS. The normal brand preset/override path still applies.
  for (const key of ['PANEL_BG', 'PANEL_TEXT']) {
    if (!/^#[0-9a-f]{6}$/i.test(tokens[key] || '')) throw new Error(`Invalid product carousel palette ${key}.`);
  }
  return { html, tokens: safe };
}
module.exports = { COMPONENT, MAX_PRODUCTS, problems, prepare, portraitUrl };

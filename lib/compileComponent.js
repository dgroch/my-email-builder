'use strict';
// compileComponent.js — turn a Studio canvas document into a real design-system template.
//
// This is the load-bearing idea of the whole Studio: an authored component compiles down to
// exactly the same artefact a hand-written template is — table HTML with {{TOKEN}} slots and a
// leading `<!-- COMPONENT … TOKENS: … -->` header. Because the output is not a special case,
// everything downstream (schema generation, the auto-generated form, validation, slicing, the
// Klaviyo push) works on a designer-authored component with no code that knows it exists.
//
// The compiler is also where the brand invariants stop being things a person must remember:
//   - script text gets its 0.65em descender padding automatically (see README);
//   - font stacks come from the locked roles, never from a free font field;
//   - colours resolve through the brand palette;
//   - a tokenised button compiles inside {{#TOKEN}}…{{/TOKEN}} so a blank label can't ship
//     a half-filled button;
//   - live-HTML components are refused the layout tricks that only survive rasterisation.

const { getBrand } = require('./brandTokens');

const CANVAS_WIDTH = 600;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(s) { return esc(s); }
function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function px(v) { return `${Math.round(num(v))}px`; }

const TOKEN_RE = /^[A-Z][A-Z0-9_]{1,39}$/;

// ---------------------------------------------------------------------------
// Colour + type resolution
// ---------------------------------------------------------------------------

function resolveColour(brand, key, fallbackHex, warnings, where) {
  if (key && Object.prototype.hasOwnProperty.call(brand.colours, key)) return brand.colours[key];
  const hex = key || fallbackHex;
  if (/^#[0-9a-fA-F]{3,8}$/.test(String(hex))) {
    const known = Object.values(brand.colours).map(c => String(c).toLowerCase());
    if (!known.includes(String(hex).toLowerCase()) && String(hex).toLowerCase() !== '#ffffff') {
      warnings.push({ level: 'warn', code: 'off_palette', where, message: `${hex} is not in the brand palette. It will render, but it is outside the locked colour set.` });
    }
    return hex;
  }
  return fallbackHex || '#000000';
}

function resolveType(brand, styleKey) {
  const step = brand.typeScale[styleKey] || brand.typeScale['body-m'];
  const role = brand.fontRoles[step.role] || brand.fontRoles.body;
  return { step, role };
}

// Inline CSS for a text run, per its locked type role.
function textCss(brand, el) {
  const { step, role } = resolveType(brand, el.typeStyle);
  const size = num(el.fontSize, step.size);
  const lh = num(el.lineHeight, step.lineHeight);
  const colour = resolveColour(brand, el.colorKey, '#000000', [], '');
  const bits = [
    `font-family:${role.stack}`,
    `font-weight:${role.weight}`,
    role.extra ? role.extra.replace(/;$/, '') : '',
    `font-size:${size}px`,
    `line-height:${lh}`,
    `color:${colour}`,
    el.letterSpacing != null && !role.extra.includes('letter-spacing') ? `letter-spacing:${num(el.letterSpacing)}em` : '',
    `text-align:${el.align || 'left'}`,
    'margin:0',
    // Cervanttis ink overshoots its own line box by ~0.74em, so CSS lays the next element
    // against a boundary the glyph has already crossed. Applied here so it cannot be forgotten.
    role.descenderPad ? `padding-bottom:${role.descenderPad}` : '',
  ].filter(Boolean);
  return bits.join(';') + ';';
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

// A token's declared description drives the generated form: parseTemplates reads the case rule
// and the field type straight out of this line, so the phrasing is contract, not prose.
function tokenDescription(kind, el, brand) {
  if (kind === 'text') {
    const { step, role } = resolveType(brand, el.typeStyle);
    const caseBit = role.caseRule === 'lower' ? ' — MUST be lowercase'
      : role.caseRule === 'sentence' ? ' — Sentence case' : '';
    return `${role.label.split(' — ')[0]} ${step.label.toLowerCase()}${caseBit}`;
  }
  if (kind === 'image') return `image URL (${num(el.w, 600)}×${num(el.h, 400)}px display)`;
  if (kind === 'url') return 'destination URL';
  if (kind === 'alt') return 'alt text for the image';
  return '';
}

function addToken(ctx, name, kind, el, sampleValue) {
  if (!name) return null;
  const upper = String(name).toUpperCase();
  if (!TOKEN_RE.test(upper)) {
    ctx.warnings.push({ level: 'error', code: 'bad_token_name', where: el && el.name, message: `"${name}" is not a valid token name. Use A–Z, 0–9 and underscores, e.g. HEADLINE or PHOTO_1_URL.` });
    return null;
  }
  if (kind === 'image' && !/_URL$/.test(upper)) {
    ctx.warnings.push({ level: 'warn', code: 'token_suffix', where: el && el.name, message: `Image token ${upper} should end in _URL so the builder renders it as an image field.` });
  }
  const existing = ctx.tokens.find(t => t.name === upper);
  if (existing) return upper;
  ctx.tokens.push({ name: upper, kind, desc: tokenDescription(kind, el || {}, ctx.brand) });
  if (sampleValue != null && sampleValue !== '') ctx.sampleTokens[upper] = sampleValue;
  return upper;
}

// ---------------------------------------------------------------------------
// Element rendering
// ---------------------------------------------------------------------------

function renderText(ctx, el) {
  const content = el.token
    ? `{{${addToken(ctx, el.token, 'text', el, el.content)}}}`
    : esc(el.content);
  const tag = el.tag === 'h1' ? 'h1' : 'p';
  const style = textCss(ctx.brand, el);
  const maxW = el.maxWidth ? `max-width:${px(el.maxWidth)};margin-left:auto;margin-right:auto;` : '';
  // A script line whose sample copy carries capitals is a case violation the designer can see
  // on canvas but not in the compiled output — surface it at compile time.
  const { role } = resolveType(ctx.brand, el.typeStyle);
  if (role.caseRule === 'lower' && el.content && el.content !== el.content.toLowerCase()) {
    ctx.warnings.push({ level: 'warn', code: 'case_violation', where: el.name, message: `"${el.content}" is set in ${role.label.split(' — ')[0]}, which must be lowercase.` });
  }
  return `<${tag} style="${style}${maxW}">${content}</${tag}>`;
}

function renderImage(ctx, el) {
  const src = el.token
    ? `{{${addToken(ctx, el.token, 'image', el, el.src)}}}`
    : escAttr(el.src || '');
  const altTok = el.altToken ? addToken(ctx, el.altToken, 'alt', el, el.alt) : null;
  const alt = altTok ? `{{${altTok}}}` : escAttr(el.alt || '');
  if (!alt) {
    ctx.warnings.push({ level: 'warn', code: 'missing_alt', where: el.name, message: 'Image has no alt text. Inbox previews scrape the first alt they find, and screen readers announce it.' });
  }
  const w = num(el.w, CANVAS_WIDTH), h = num(el.h, 400);
  const radius = num(el.radius, 0) ? `border-radius:${px(el.radius)};` : '';
  const style = `display:block;width:${px(w)};height:${px(h)};object-fit:${el.fit || 'cover'};object-position:${el.position || 'center'};${radius}`;
  const img = `<img src="${src}" width="${Math.round(w)}" height="${Math.round(h)}" alt="${alt}" style="${style}">`;
  if (el.linkToken) {
    const t = addToken(ctx, el.linkToken, 'url', el, el.link);
    return `<a href="{{${t}}}" style="text-decoration:none;">${img}</a>`;
  }
  return img;
}

function renderButton(ctx, el) {
  const brand = ctx.brand;
  const bg = resolveColour(brand, el.bgKey || 'primary', '#000000', ctx.warnings, el.name);
  const fg = /^#/.test(el.textKey || '') ? el.textKey : (el.textKey === 'white' ? '#ffffff' : resolveColour(brand, el.textKey, '#ffffff', ctx.warnings, el.name));
  const labelTok = el.labelToken ? addToken(ctx, el.labelToken, 'text', { ...el, typeStyle: 'micro' }, el.label) : null;
  const urlTok = el.urlToken ? addToken(ctx, el.urlToken, 'url', el, el.url) : null;
  const label = labelTok ? `{{${labelTok}}}` : esc(el.label || '');
  const href = urlTok ? `{{${urlTok}}}` : escAttr(el.url || '#');
  if (num(el.radius, 0) > 0) {
    ctx.warnings.push({ level: 'warn', code: 'button_radius', where: el.name, message: 'Square buttons are a locked brand style — a corner radius departs from the shipped system.' });
  }
  const radius = num(el.radius, 0) ? `border-radius:${px(el.radius)};` : '';
  const { role } = resolveType(brand, 'micro');
  const style = `font-family:${role.stack};font-weight:${role.weight};font-size:${num(el.fontSize, 10)}px;letter-spacing:.16em;text-transform:uppercase;background:${bg};color:${fg};text-decoration:none;padding:${px(num(el.padY, 14))} ${px(num(el.padX, 40))};display:inline-block;${radius}`;
  const anchor = `<a href="${href}" style="${style}">${label}</a>`;
  // Wrapping in the conditional section means a campaign that leaves the label blank drops the
  // whole button instead of shipping an empty black rectangle pointing at a raw {{CTA_URL}}.
  return labelTok ? `{{#${labelTok}}}${anchor}{{/${labelTok}}}` : anchor;
}

function renderRule(ctx, el) {
  const colour = resolveColour(ctx.brand, el.colorKey || 'border', '#e8e2da', ctx.warnings, el.name);
  return `<div style="width:100%;height:${px(num(el.thickness, 1))};background:${colour};line-height:0;font-size:0;">&nbsp;</div>`;
}

function renderIllo(ctx, el) {
  const asset = String(el.asset || 'HandFlower_Black.png').replace(/[^A-Za-z0-9_.-]/g, '');
  // A background-image, never an <img>: the accent must degrade to nothing rather than to a
  // broken-image icon if the asset host is unreachable at render time.
  return `<div style="width:${px(num(el.w, 120))};height:${px(num(el.h, 120))};background:url('{{ASSETS_BASE}}/${asset}') no-repeat center/contain;opacity:${num(el.opacity, 0.08)};"></div>`;
}

function renderSpacer(ctx, el) {
  return `<div style="height:${px(num(el.h, 24))};line-height:0;font-size:0;">&nbsp;</div>`;
}

function renderLeaf(ctx, el) {
  switch (el.type) {
    case 'text': return renderText(ctx, el);
    case 'image': return renderImage(ctx, el);
    case 'button': return renderButton(ctx, el);
    case 'rule': return renderRule(ctx, el);
    case 'illo': return renderIllo(ctx, el);
    case 'spacer': return renderSpacer(ctx, el);
    case 'panel': return '';
    default:
      ctx.warnings.push({ level: 'warn', code: 'unknown_element', where: el.name, message: `Unknown element type "${el.type}" was skipped.` });
      return '';
  }
}

function panelStyle(ctx, el, extra) {
  const bg = el.bgKey || el.bgHex ? resolveColour(ctx.brand, el.bgKey || el.bgHex, '#ffffff', ctx.warnings, el.name) : 'transparent';
  const border = num(el.borderWidth, 0) > 0
    ? `border:${px(el.borderWidth)} solid ${resolveColour(ctx.brand, el.borderKey || 'border', '#e8e2da', ctx.warnings, el.name)};` : '';
  const radius = num(el.radius, 0) ? `border-radius:${px(el.radius)};` : '';
  return `background:${bg};${border}${radius}padding:${px(num(el.padding, 0))};${extra || ''}`;
}

// ---------------------------------------------------------------------------
// DESIGNED mode — free canvas. Rasterised to PNG on publish, so absolute positioning,
// overlap and rotation are all safe: the inbox receives an image, not this CSS.
// ---------------------------------------------------------------------------

function compileDesigned(ctx, doc) {
  const els = (doc.elements || []).filter(e => !e.hidden);
  const roots = els.filter(e => !e.parent);
  const childrenOf = id => els.filter(e => e.parent === id);
  const height = num(doc.canvas && doc.canvas.height, 480);

  // Top-level elements are absolutely positioned on the stage — that is the free canvas.
  // A panel's *children* stack in flow inside it, because that is how the shipped plate
  // components behave and because absolutely positioning text inside a plate would make
  // every copy-length change a manual re-layout.
  function flowChild(el) {
    const inner = renderLeaf(ctx, el);
    const mt = num(el.marginTop, 0), mb = num(el.marginBottom, 12);
    const marker = ctx.markers ? ` data-el="${escAttr(el.id)}" data-el-type="${escAttr(el.type)}"` : '';
    return `<div${marker} style="margin:${px(mt)} 0 ${px(mb)};text-align:${el.align || 'center'};">${inner}</div>`;
  }

  function place(el, depth) {
    const inner = el.type === 'panel'
      ? childrenOf(el.id).sort((a, b) => num(a.order) - num(b.order)).map(flowChild).join('\n')
      : renderLeaf(ctx, el);
    const rot = num(el.rotation, 0);
    const transform = rot ? `transform:rotate(${rot}deg);transform-origin:center center;` : '';
    const size = el.type === 'image'
      ? '' // the <img> carries its own width/height
      : `width:${px(num(el.w, CANVAS_WIDTH))};${el.type === 'panel' || el.h ? `min-height:${px(num(el.h, 0))};` : ''}`;
    const box = el.type === 'panel' ? panelStyle(ctx, el, '') : '';
    return `<div${ctx.markers ? ` data-el="${escAttr(el.id)}" data-el-type="${escAttr(el.type)}"` : ''} style="position:absolute;left:${px(num(el.x, 0))};top:${px(num(el.y, 0))};${size}${box}${transform}z-index:${Math.round(num(el.z, 0))};">\n${inner}\n</div>`;
  }

  const body = roots.sort((a, b) => num(a.z) - num(b.z)).map(e => place(e, 0)).join('\n');
  const bg = resolveColour(ctx.brand, (doc.canvas && doc.canvas.backgroundKey) || (doc.canvas && doc.canvas.background) || '#ffffff', '#ffffff', ctx.warnings, 'canvas');

  // Overflow is a real defect here: the stage is a fixed-height box, so anything past it is
  // simply cropped out of the PNG.
  for (const el of roots) {
    const bottom = num(el.y) + num(el.h, 0);
    if (bottom > height + 1) {
      ctx.warnings.push({ level: 'warn', code: 'overflow', where: el.name, message: `"${el.name || el.type}" extends ${Math.round(bottom - height)}px past the bottom of the canvas and will be cropped.` });
    }
  }

  return `<tr><td style="padding:0;background:${bg};">
<table width="${CANVAS_WIDTH}" cellpadding="0" cellspacing="0" border="0" align="center" style="width:${CANVAS_WIDTH}px;">
  <tr>
    <td style="padding:0;">
      <div style="position:relative;width:${CANVAS_WIDTH}px;height:${px(height)};background:${bg};overflow:hidden;">
${body}
      </div>
    </td>
  </tr>
</table>
</td></tr>`;
}

// ---------------------------------------------------------------------------
// LIVE mode — real email HTML. Stacked flow, nested tables, no absolute positioning and no
// transforms, because this markup is what Outlook's Word engine actually has to lay out.
// ---------------------------------------------------------------------------

function compileLive(ctx, doc) {
  const els = (doc.elements || []).filter(e => !e.hidden);
  const roots = els.filter(e => !e.parent).sort((a, b) => num(a.order) - num(b.order));
  const childrenOf = id => els.filter(e => e.parent === id).sort((a, b) => num(a.order) - num(b.order));

  for (const el of els) {
    if (num(el.rotation, 0)) {
      ctx.warnings.push({ level: 'error', code: 'live_rotation', where: el.name, message: 'Rotation does not survive as live email HTML. Switch this component to a designed (rasterised) block, or remove the rotation.' });
    }
  }

  function flow(el) {
    const mt = num(el.marginTop, 0), mb = num(el.marginBottom, 0);
    const align = el.align || 'center';
    if (el.type === 'panel') {
      const inner = childrenOf(el.id).map(flow).join('\n');
      return `<table${ctx.markers ? ` data-el="${escAttr(el.id)}" data-el-type="panel"` : ''} width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:${px(mt)} 0 ${px(mb)};"><tr><td style="${panelStyle(ctx, el, `text-align:${align};`)}">\n${inner}\n</td></tr></table>`;
    }
    return `<div${ctx.markers ? ` data-el="${escAttr(el.id)}" data-el-type="${escAttr(el.type)}"` : ''} style="margin:${px(mt)} 0 ${px(mb)};text-align:${align};">${renderLeaf(ctx, el)}</div>`;
  }

  const body = roots.map(flow).join('\n');
  const c = doc.canvas || {};
  const bg = resolveColour(ctx.brand, c.backgroundKey || c.background || '#ffffff', '#ffffff', ctx.warnings, 'canvas');
  const padTop = c.paddingTop != null ? px(c.paddingTop) : '40px';
  const padBottom = c.paddingBottom != null ? px(c.paddingBottom) : '40px';
  const padSide = c.paddingSide != null ? px(c.paddingSide) : '50px';

  return `<tr><td style="padding:${padTop} ${padSide} ${padBottom};background:${bg};">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td style="padding:0;">
${body}
    </td>
  </tr>
</table>
</td></tr>`;
}

// ---------------------------------------------------------------------------
// Header comment — the machine-readable contract parseTemplates() reads back.
// ---------------------------------------------------------------------------

function buildHeader(meta, tokens, mode, extraRules) {
  const kind = mode === 'designed' ? 'DESIGNED BLOCK' : 'LIVE HTML';
  const lines = [];
  lines.push(`<!-- COMPONENT: ${meta.name} | ${kind} — ${(meta.title || meta.slug || '').toUpperCase()}`);
  if (tokens.length) {
    lines.push('TOKENS:');
    const pad = Math.max(...tokens.map(t => t.name.length)) + 4;
    for (const t of tokens) lines.push(`  {{${t.name}}}${' '.repeat(Math.max(1, pad - t.name.length))}— ${t.desc}`);
  }
  lines.push('RULES:');
  if (mode === 'designed') {
    lines.push('  - DESIGNED BLOCK: slice to PNG. Free-canvas layout (overlap / rotation / absolute');
    lines.push('    position) does not survive as live email HTML, and does not need to — the inbox');
    lines.push('    receives an image.');
  } else {
    lines.push('  - LIVE HTML: ships as real markup, so it stays selectable, accessible and');
    lines.push('    responsive. Flow layout only — no overlap, rotation or absolute positioning.');
  }
  lines.push('  - Fonts, palette and the script descender padding are applied by the Studio');
  lines.push('    compiler from the locked brand roles. Do not hand-edit this file: it is');
  lines.push('    regenerated from its canvas document on every publish.');
  for (const r of extraRules || []) lines.push(`  - ${r}`);
  if (meta.description) lines.push(`INTENT:\n  ${meta.description}`);
  lines.push(`AUTHORED: Studio version ${meta.version || 1}${meta.author ? ' by ' + meta.author : ''}`);
  lines.push('-->');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// doc  — the canvas document
// meta — { name, title, slug, description, author, version, mode }
// Returns { html, tokens, sampleTokens, warnings, errorCount }.
function compileComponent(doc = {}, meta = {}) {
  const brand = getBrand();
  const mode = meta.mode === 'live' || doc.mode === 'live' ? 'live' : 'designed';
  // editorMarkers stamps data-el ids onto the compiled output so the Studio canvas can render
  // the *real* compiled HTML and still attach selection/drag handles to each element. The canvas
  // is therefore never an approximation of the output — it is the output.
  const ctx = { brand, tokens: [], sampleTokens: {}, warnings: [], markers: !!meta.editorMarkers };

  let body = mode === 'designed' ? compileDesigned(ctx, doc) : compileLive(ctx, doc);

  // On the canvas, show the copy the designer actually typed rather than the {{TOKEN}} slot it
  // compiles to — she is laying out a real headline, not a placeholder. The published template
  // is always the tokenised version; this substitution is editor-only.
  if (meta.editorMarkers) {
    for (const [k, v] of Object.entries(ctx.sampleTokens)) {
      body = body.split(`{{#${k}}}`).join('').split(`{{/${k}}}`).join('').split(`{{${k}}}`).join(esc(v));
    }
    body = body.replace(/\{\{#([A-Z0-9_]+)\}\}[\s\S]*?\{\{\/\1\}\}/g, '');
  }

  // A Klaviyo merge tag inside a rasterised block ships every recipient a picture of the tag.
  // This is the failure mode the promo-code block exists to avoid, so refuse it outright.
  if (mode === 'designed' && /\{%\s*(unsubscribe|coupon_code)\s*%\}/.test(body)) {
    ctx.warnings.push({ level: 'error', code: 'merge_tag_in_raster', message: 'This block contains a Klaviyo merge tag but is set to rasterise. Every recipient would receive a picture of the literal tag. Switch it to a live-HTML component.' });
  }
  if (!ctx.tokens.length && (doc.elements || []).length) {
    ctx.warnings.push({ level: 'info', code: 'no_tokens', message: 'Nothing on this canvas is marked as a fillable slot, so every campaign using it gets identical copy. Mark the headline or image as a token to make it reusable.' });
  }

  const html = buildHeader({ ...meta, mode }, ctx.tokens, mode, doc.rules || []) + '\n' + body + '\n';

  return {
    html,
    tokens: ctx.tokens,
    sampleTokens: ctx.sampleTokens,
    warnings: ctx.warnings,
    errorCount: ctx.warnings.filter(w => w.level === 'error').length,
    mode,
  };
}

module.exports = { compileComponent, CANVAS_WIDTH };

'use strict';
// Opt-in layout controls for legacy templates. The default path returns the original bytes,
// including documentation, so existing saved campaigns and published versions do not churn.
function escapeText(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function prepare(component, html, tokens) {
  if (component === 'sections/body-copy-plain') {
    if (tokens.TOP_RULE === 'off') html = html.replace('border-top:1px solid #e8e2da;', 'border-top:0;');
    if (tokens.ALIGN !== 'center') html = html.replace(/text-align:center;/g, `text-align:${tokens.ALIGN};`).replace(/align="center"/g, `align="${tokens.ALIGN}"`).replace('margin:0 auto;', 'margin:0;');
    if (tokens.PADDING_TOP !== '44px' || tokens.PADDING_BOTTOM !== '44px' || tokens.PADDING_X !== '64px') {
      html = html.replace('padding:44px 64px;', `padding:${tokens.PADDING_TOP} ${tokens.PADDING_X} ${tokens.PADDING_BOTTOM};`);
    }
    const mobileClass = `bcp-${tokens.MOBILE_ALIGN}-${String(tokens.MOBILE_PADDING_X).replace(/\W/g, '')}`;
    const mobile = [];
    if (tokens.MOBILE_ALIGN !== 'inherit') mobile.push(`.${mobileClass},.${mobileClass} td{text-align:${tokens.MOBILE_ALIGN}!important;}`);
    if (tokens.MOBILE_PADDING_X !== '24px') mobile.push(`.${mobileClass}{padding-left:${tokens.MOBILE_PADDING_X}!important;padding-right:${tokens.MOBILE_PADDING_X}!important;}`);
    if (mobile.length) html = html.replace('class="sp"', `class="sp ${mobileClass}"`).replace('<tr><td>', `<tr><td><style>@media only screen and (max-width:599px){${mobile.join('')}}</style>`);
    // Use table rows for paragraph breaks: Word honours cell padding, unlike paragraph margins.
    for (const name of ['BODY_P1', 'BODY_P2']) {
      const parts = String(tokens[name] || '').split(/\r?\n\s*\r?\n/);
      if (parts.length < 2) continue;
      const re = new RegExp(`<tr>\\s*<td([^>]*)>\\{\\{${name}\\}\\}</td>\\s*</tr>`);
      html = html.replace(re, (_row, attrs) => parts.map((part, i) => {
        const key = `${name}_PARAGRAPH_${i}`;
        tokens[key] = part;
        return `<tr><td${i ? attrs.replace(/padding:[^;]*;/, 'padding:14px 0 0 0;') : attrs}>{{${key}}}</td></tr>`;
      }).join('\n'));
    }
  }
  if (component === 'sections/full-width-image' && (tokens.PADDING_TOP !== '0' || tokens.PADDING_BOTTOM !== '0')) {
    // A separately selectable edge stays zero; 24px art direction steps down to 16px on phones.
    const mobile = v => v === '24px' ? '16px' : v;
    const cls = `fwi-${String(tokens.PADDING_TOP).replace(/\W/g, '')}-${String(tokens.PADDING_BOTTOM).replace(/\W/g, '')}`;
    html = html.replace('<tr><td style="padding:0;', `<tr><td class="${cls}" style="padding:${tokens.PADDING_TOP} 0 ${tokens.PADDING_BOTTOM};`);
    html = html.replace('{{#LINK_URL}}', `<style>@media only screen and (max-width:599px){.${cls}{padding-top:${mobile(tokens.PADDING_TOP)}!important;padding-bottom:${mobile(tokens.PADDING_BOTTOM)}!important;}}</style>\n{{#LINK_URL}}`);
  }
  if (component === 'sections/top-line') {
    html = html.split('{{TEXT}}').join(escapeText(tokens.TEXT));
  }
  if (component === 'products/card-feature') {
    html = html.split('{{IMAGE_ALT}}').join(escapeText(tokens.IMAGE_ALT));
    html = html.replace('dir="{{IMG_SIDE}}"', `dir="${tokens.IMG_SIDE === 'right' ? 'rtl' : 'ltr'}"`);
  }
  return html;
}
module.exports = { prepare };

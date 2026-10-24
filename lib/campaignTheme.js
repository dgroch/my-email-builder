'use strict';
// Opt-in theme adapter. The light path returns the original bytes without parsing HTML.
const fs = require('fs');
const path = require('path');
const manifest = require('../design-system/manifest.json');
const NOIR = '#000000';
const BODY = '#d9d4ce';
const HEAD = '#ffffff';
const CAPS_COMPONENTS = new Set([
  'heroes/hero-d-noir', 'heroes/hero-b-noir', 'heroes/hero-c1-noir',
  'heroes/hero-c2-noir', 'sections/upsell-noir', 'sections/section-headline',
]);
function isDark(campaign) { return campaign && campaign.theme === 'dark'; }
function supports(component, def) {
  return !def?.authored && manifest.campaign_themes.dark.components.includes(component);
}
function caps(component, tokens) {
  return CAPS_COMPONENTS.has(component) && tokens?.HEADLINE_STYLE === 'caps';
}
function verbatimHeadline(component, tokens) {
  return caps(component, tokens) || (component === 'heroes/hero-a' && tokens?.HEADLINE_FONT === 'lust');
}
function headline(html, component, tokens) {
  if (component === 'heroes/hero-a' && tokens?.HEADLINE_FONT === 'lust') {
    return html.replace(/<h1\b[^>]*>\{\{HEADLINE\}\}<\/h1>/g, element =>
      element.replace(/style="([^"]*)"/, (_m, css) => {
        css = css.replace(/(?:font-family|text-transform|padding-bottom|line-height):[^;]*;/gi, '');
        return `data-eb-headline-font="lust" style="${css}font-family:'Lust',Georgia,'Times New Roman',serif;text-transform:none;padding-bottom:0;line-height:1.15;overflow-wrap:break-word;"`;
      }));
  }
  if (!caps(component, tokens)) return html;
  // Only the headline element: preserve the value and every unrelated script accent.
  const spacing = /^(?:0|\d+(?:\.\d+)?(?:px|em|rem))$/.test(String(tokens.HEADLINE_LETTER_SPACING || ''))
    ? tokens.HEADLINE_LETTER_SPACING : '0.06em';
  return html.replace(/<h[12]\b[^>]*>\{\{HEADLINE\}\}<\/h[12]>/g, element =>
    element.replace(/style="([^"]*)"/, (_m, css) => {
      css = css.replace(/(?:font-family|text-transform|letter-spacing|padding-bottom|line-height):[^;]*;/gi, '');
      return `data-eb-caps="true" style="${css}font-family:'Lust',Didot,'Bodoni MT',Georgia,serif;text-transform:none;letter-spacing:${spacing};padding-bottom:0;line-height:1.15;overflow-wrap:break-word;"`;
    }));
}
function assetTokens(campaign) {
  return { ...manifest.campaign_themes.dark.token_defaults, ...(campaign.themeTokens || {}) };
}
function template(html, component, campaign) {
  if (!isDark(campaign)) return html;
  if (component === 'footer') return fs.readFileSync(path.join(__dirname, '../design-system/theme/footer-dark.html'), 'utf8');
  if (component === 'header' || /^heroes\/hero-b-/.test(component)) {
    html = html.replace(/src="[^"]*F_B_Logo_Horizontal_BLK[^"]*"/g, 'src="{{DARK_LOGO_URL}}"')
      .replace(/filter:invert\(1\);?/g, '');
  }
  return html;
}
// Transform only markup/style declarations, never token values, URLs or visible copy.
// Every wrapper has a real background (including divs); every table/td has bgcolor too.
function noirMarkup(html) {
  return html.replace(/<(table|td|th|body|div|p|h[1-6]|a|span|cite|center|img|v:roundrect)\b[^>]*>/gi, (tag, name) => {
    const wrapper = /^(table|td|th|body|div|center)$/i.test(name);
    const heading = /^h[1-6]$/i.test(name);
    const link = name.toLowerCase() === 'a';
    const button = link && /(?:background(?:-color)?\s*:|display\s*:\s*inline-block)/i.test(tag);
    let css = (tag.match(/\bstyle="([^"]*)"/i) || [,''])[1];
    css = css.replace(/(^|;)\s*background(?:-color)?\s*:[^;]*(;|$)/gi, '$1background:#000000$2')
      .replace(/(^|;)\s*color\s*:[^;]*(;|$)/gi, `$1color:${heading ? HEAD : BODY}$2`)
      .replace(/(border(?:-(?:top|bottom|left|right))?\s*:[^;]*?)(#[\da-f]{3,8}|rgba?\([^)]*\))(?=;|$)/gi, '$1#888888');
    if (css && !css.endsWith(';')) css += ';';
    if (wrapper) {
      css = css.replace(/background(?:-color)?:[^;]*;/gi, '') + `background:${NOIR};background-image:linear-gradient(#000000,#000000);`;
      tag = tag.replace(/\sbgcolor="[^"]*"/gi, '').replace(/>$/, ` bgcolor="${NOIR}">`);
    }
    if (!/^(img|v:roundrect)$/i.test(name)) css += `color:${heading ? HEAD : BODY};`;
    if (link) css += `color:${HEAD};text-decoration:underline;`;
    if (button) css += `background:${NOIR};color:${HEAD};border:1px solid #d9d4ce;`;
    if (name.toLowerCase() === 'v:roundrect') tag = tag.replace(/fillcolor="[^"]*"/gi, 'fillcolor="#000000"').replace(/stroke="f"/i, 'stroke="t" strokecolor="#d9d4ce"');
    if (/\bstyle="/i.test(tag)) return tag.replace(/\bstyle="[^"]*"/i, () => `style="${css}"`);
    return tag.replace(/\s*\/?>$/, end => ` style="${css}"${end}`);
  });
}
function block(html, component, campaign, source) {
  return isDark(campaign) && supports(component, { authored: source?.source === 'authored' }) ? noirMarkup(html) : html;
}
function shell(html, campaign) {
  if (!isDark(campaign)) return html;
  // Keep one authoritative declaration in both preview and sendable shells.
  html = html.replace(/<meta name="(?:color-scheme|supported-color-schemes)"[^>]*>/gi, '')
    .replace(/:root\{color-scheme:light;supported-color-schemes:light;\}/g, '');
  const lock = '.eb-dark,.eb-dark table,.eb-dark td,.eb-dark th,.eb-dark div{background-color:#000000!important;} '
    + '.eb-dark{color:#d9d4ce!important;} .eb-dark a{color:#ffffff!important;text-decoration:underline;} '
    + '.eb-dark h1,.eb-dark h2,.eb-dark h3{color:#ffffff!important;}';
  const outlook = lock.replace(/\.eb-dark/g, '[data-ogsc] .eb-dark') + lock.replace(/\.eb-dark/g, '[data-ogsb] .eb-dark');
  const head = '<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">\n'
    + '<style data-eb-dark>:root{color-scheme:dark;supported-color-schemes:dark;} '
    + lock + outlook + '@media (prefers-color-scheme:dark){' + lock + '} '
    + '.eb-dark [data-eb-caps]{text-transform:none!important;} '
    + '@media only screen and (max-width:600px){.eb-dark .eb-dark-social{max-width:25vw!important;}}@media only screen and (max-width:480px){.eb-dark [data-eb-caps]{font-size:30px!important;line-height:1.15!important;}}'
    + '</style>\n';
  html = html.replace('</head>', head + '</head>');
  html = html.replace(/<body\b([^>]*)>/i, (_m, attrs) => '<body' + attrs.replace(/\sclass="([^"]*)"/i, '') + ' class="eb-dark">');
  // Protect shell wrappers separately. Unsupported blocks retain their inline declarations
  // and receive a validation warning; client-mode rules still lock their wrapper backgrounds.
  const start = html.indexOf('<body');
  const body = html.slice(start);
  const componentStart = body.indexOf('<!-- COMPONENTS_START -->');
  const componentEnd = body.indexOf('<!-- COMPONENTS_END -->');
  if (componentStart >= 0 && componentEnd >= 0) {
    html = html.slice(0, start) + noirMarkup(body.slice(0, componentStart))
      + body.slice(componentStart, componentEnd) + noirMarkup(body.slice(componentEnd));
  }
  return html;
}
module.exports = { verbatimHeadline, isDark, supports, caps, headline, template, assetTokens, block, shell, noirMarkup, NOIR, BODY, HEAD };

'use strict';
// lib/campaignGenerator.js — generate a Fig & Bloom campaign JSON from a free-form brief.
//
// The brand + persona + lens-routing + schema context is pre-baked into
// lib/prompts/system-prompt.md (mirrored from the dgroch/skills repo). The user
// supplies a brief (from the email-builder "Create Campaign" button, or an
// agent), and we ship the system prompt + a filled user template to the LLM.
//
// The LLM is called via the Anthropic API (or any OpenAI-compatible endpoint).
// Config: CAMPAIGN_LLM_API_KEY, CAMPAIGN_LLM_MODEL, CAMPAIGN_LLM_BASE_URL,
// CAMPAIGN_LLM_MAX_TOKENS. Defaults: Anthropic Claude Sonnet 4.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const PROMPTS_DIR = path.join(__dirname, 'prompts');

function loadPrompt(name) {
  return fs.readFileSync(path.join(PROMPTS_DIR, name), 'utf8');
}

const SYSTEM_PROMPT = loadPrompt('system-prompt.md');
const USER_TEMPLATE = loadPrompt('user-prompt-template.md');

const LLM_PROVIDER = (process.env.CAMPAIGN_LLM_PROVIDER || 'anthropic').toLowerCase();
const LLM_API_KEY = process.env.CAMPAIGN_LLM_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const LLM_MODEL = process.env.CAMPAIGN_LLM_MODEL || 'claude-sonnet-4-20250514';
const LLM_BASE_URL = process.env.CAMPAIGN_LLM_BASE_URL || 'https://api.anthropic.com';
const LLM_MAX_TOKENS = parseInt(process.env.CAMPAIGN_LLM_MAX_TOKENS || '4096', 10);
const LLM_TEMPERATURE = parseFloat(process.env.CAMPAIGN_LLM_TEMPERATURE || '0.7');


/** Render the live context as a compact, LLM-readable block. */
function renderLiveContextBlock(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    return '// (live context not provided by the caller)';
  }
  const lines = [];
  if (ctx.asOf) lines.push('As of: ' + ctx.asOf);
  const status = ctx.contextStatus || {};
  if (Array.isArray(ctx.products) && ctx.products.length) {
    lines.push('');
    lines.push('ACTIVE PRODUCTS (curated from Shopify, with current from-prices and image URLs):');
    for (const p of ctx.products.slice(0, 60)) {
      const price = p.priceText || (p.fromPrice ? ('From ' + p.fromPrice) : '');
      const tag = p.productType ? ' [' + p.productType + ']' : '';
      lines.push('- ' + p.title + (price ? ' — ' + price : '') + tag
        + (p.url ? ' — ' + p.url : '')
        + (p.imageUrl ? '\n    image: ' + p.imageUrl : ''));
    }
    if (ctx.products.length > 60) lines.push('  … and ' + (ctx.products.length - 60) + ' more');
  } else if (status.products === 'unavailable') {
    lines.push('');
    lines.push('PRODUCTS: // unavailable — Shopify public feed unreachable or NOTION_DESIGNS_DB not configured.');
  }
  if (Array.isArray(ctx.audiences) && ctx.audiences.length) {
    lines.push('');
    lines.push('KLAVIYO AUDIENCES (use the real ID when populating the audience field):');
    for (const a of ctx.audiences) lines.push('- ' + a.id + ' — ' + a.name + ' (' + (a.type || 'list') + ')');
  } else if (status.audiences === 'unavailable') {
    lines.push('');
    lines.push('AUDIENCES: // unavailable — KLAVIYO_API_KEY not set or the Klaviyo call failed.');
  }
  if (Array.isArray(ctx.blogPosts) && ctx.blogPosts.length) {
    lines.push('');
    lines.push('BLOG POSTS (canonical URLs — use as hero destinations if the brief touches them):');
    for (const b of ctx.blogPosts) lines.push('- "' + b.title + '" — ' + b.url + (b.publishedAt ? ' (' + b.publishedAt + ')' : ''));
  } else if (status.blogPosts === 'unavailable') {
    lines.push('');
    lines.push('BLOG POSTS: // unavailable — NOTION_TOKEN not set, or the blog index query failed.');
  }
  return lines.join('\n');
}


/** Substitute the brief, audience, and live context into the user template. */
function renderUserPrompt(brief, audience, liveContext) {
  // Use a global, case-insensitive regex for placeholders so all occurrences
  // (including any references in the template's own documentation block) are
  // either substituted or replaced with an explicit gap marker. The LLM never
  // sees the literal `{{...}}` text in its user message.
  const safeBrief = (brief || '').trim();
  const safeAudience = (audience || 'default — RH | All Email Subscribers').trim();
  return USER_TEMPLATE
    .replace(/\{\{BRIEF\}\}/g, safeBrief || '// (no brief provided)')
    .replace(/\{\{AUDIENCE\}\}/g, safeAudience || '// (no audience specified)')
    .replace(/\{\{LIVE_CONTEXT\}\}/g, renderLiveContextBlock(liveContext));
}


/** Make an HTTPS POST that returns parsed JSON. */
function postJson(urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = JSON.stringify(body);
    const reqHeaders = Object.assign(
      { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      headers
    );
    const req = https.request(
      { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST', headers: reqHeaders },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          try {
            const parsed = buf ? JSON.parse(buf) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
            const detail = parsed && parsed.error && parsed.error.message ? parsed.error.message : buf.slice(0, 600);
            reject(new Error(`LLM ${res.statusCode}: ${detail}`));
          } catch (e) {
            reject(new Error('LLM non-JSON response: ' + buf.slice(0, 600)));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}


/** Call the LLM with the system + user messages. Returns the assistant text. */
async function callLlm({ system, user, maxTokens, temperature }) {
  if (!LLM_API_KEY) {
    throw new Error('CAMPAIGN_LLM_API_KEY (or ANTHROPIC_API_KEY) is not set on the server. Add it as an env var and restart.');
  }
  if (LLM_PROVIDER !== 'anthropic') {
    // OpenAI-compatible path kept simple; expand if needed.
    throw new Error('Only the anthropic provider is wired up in this build. Set CAMPAIGN_LLM_PROVIDER=anthropic.');
  }
  const path = '/v1/messages';
  const url = LLM_BASE_URL.replace(/\/$/, '') + path;
  const body = {
    model: LLM_MODEL,
    max_tokens: maxTokens || LLM_MAX_TOKENS,
    temperature: typeof temperature === 'number' ? temperature : LLM_TEMPERATURE,
    system,
    messages: [{ role: 'user', content: user }],
  };
  const headers = {
    'x-api-key': LLM_API_KEY,
    'anthropic-version': '2023-06-01',
  };
  const resp = await postJson(url, headers, body);
  // Anthropic message shape: { content: [{ type: 'text', text: '...' }] }
  const text = (resp && resp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return text;
}


/** Strip markdown fences + surrounding prose. Return the first JSON object. */
function extractJson(text) {
  if (!text) return null;
  // Strip code fences
  let s = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // Try to grab the first {...} block
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch (_) { return null; }
      }
    }
  }
  // Fallback: try parsing the whole stripped string
  try { return JSON.parse(s); } catch (_) { return null; }
}


/** Generate a campaign JSON from a brief. Returns the parsed object. */
async function generate({ brief, audience, liveContext, maxTokens, temperature }) {
  if (!brief || !brief.trim()) {
    const err = new Error('Brief is empty. Tell me what the campaign is for.');
    err.code = 'EMPTY_BRIEF';
    throw err;
  }
  const user = renderUserPrompt(brief, audience, liveContext);
  const text = await callLlm({ system: SYSTEM_PROMPT, user, maxTokens, temperature });
  const parsed = extractJson(text);
  if (!parsed) {
    const err = new Error('LLM returned no parseable JSON. Raw text starts with: ' + text.slice(0, 200));
    err.code = 'BAD_JSON';
    err.raw = text;
    throw err;
  }
  return parsed;
}


/** Retry-on-validation wrapper — call generate, then validate, then retry once if needed. */
async function generateValidated({ brief, audience, liveContext, validateFn, maxTokens, temperature }) {
  let parsed = await generate({ brief, audience, liveContext, maxTokens, temperature });
  // The model may have returned a clarification request — surface it.
  if (parsed && typeof parsed === 'object' && parsed.needsClarification) {
    return { needsClarification: String(parsed.needsClarification) };
  }
  // First validation pass.
  if (validateFn) {
    const v1 = await validateFn(parsed);
    if (v1 && v1.ok) return { campaign: parsed, validation: v1 };
    // Retry once with the issues.
    const user2 = renderUserPrompt(brief, audience, liveContext)
      + '\n\n---\nNOTE: Your previous response failed validation. Fix these issues and return the JSON again. Issues:\n'
      + JSON.stringify(v1 && v1.issues ? v1.issues : v1, null, 2);
    const text2 = await callLlm({ system: SYSTEM_PROMPT, user: user2, maxTokens, temperature });
    const parsed2 = extractJson(text2);
    if (parsed2 && parsed2.needsClarification) return { needsClarification: String(parsed2.needsClarification) };
    if (!parsed2) {
      const err = new Error('LLM retry returned no parseable JSON.');
      err.code = 'BAD_JSON_RETRY';
      err.raw = text2;
      err.firstValidation = v1;
      throw err;
    }
    const v2 = await validateFn(parsed2);
    if (v2 && v2.ok) return { campaign: parsed2, validation: v2, firstValidation: v1 };
    // Both attempts failed — return the best we have.
    const err = new Error('Validation still failing after retry.');
    err.code = 'VALIDATION_FAILED';
    err.firstValidation = v1;
    err.secondValidation = v2;
    err.lastCampaign = parsed2;
    throw err;
  }
  return { campaign: parsed };
}


module.exports = {
  generate,
  generateValidated,
  extractJson,
  renderUserPrompt,
  renderLiveContextBlock,
  // Exposed for tests
  _internal: { SYSTEM_PROMPT, USER_TEMPLATE, LLM_PROVIDER, LLM_MODEL, LLM_BASE_URL },
};

'use strict';
// brandTokens.js — the brand primitives the Studio exposes to the designer, and the
// runtime override layer that lets her change them without a code change.
//
// The manifest's `locked_styles` is the *shipped* baseline (fonts, palette, body background).
// A designer editing brand primitives writes an override file; every consumer reads the
// merged view through getBrand(), so one edit reaches every component at once.
//
// This is the highest blast-radius surface in the Studio: changing `clay` restyles every
// component that references it. `affectedBy()` exists so the UI can say exactly what a
// pending change touches before it is published.
//
// Overrides live in Postgres when DATABASE_URL is set, and in a JSON file under DATA_DIR
// otherwise. getBrand() has to stay synchronous — the component compiler resolves colours
// through it inside a sync call stack — so the overrides are held in memory and refreshed
// after every write and on a short TTL, exactly like the component snapshot.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const OVERRIDE_FILE = path.join(DATA_DIR, 'brand-tokens.json');
const DS = path.join(__dirname, '..', 'design-system');

// The four brand faces. A designer picks a *role*, never a font stack — the stack (with its
// email fallbacks) is locked, because a fallback chain is an email-deliverability decision,
// not an aesthetic one.
const FONT_ROLES = {
  script: {
    label: 'Cervanttis — script accent',
    stack: "'Cervanttis','Palatino Linotype',Palatino,Georgia,serif",
    weight: 400,
    extra: "font-style:normal;font-synthesis:none;-webkit-font-smoothing:antialiased;",
    // Cervanttis ink overshoots its line box by ~0.74em; see README. Applied automatically
    // by the compiler so the designer can never ship the overlap bug by hand.
    descenderPad: '0.65em',
    caseRule: 'lower',
    caseNote: 'Cervanttis is a script face — copy MUST be lowercase.',
  },
  display: {
    label: 'Lust — display headline',
    stack: "'Lust',Georgia,'Times New Roman',serif",
    weight: 'normal',
    extra: 'font-style:normal;',
    caseRule: 'sentence',
    caseNote: 'Lust is the display serif — copy is Sentence case.',
  },
  body: {
    label: 'NeuzeitGro Light — body copy',
    stack: "'NeuzeitGro','Gill Sans','Gill Sans MT',Calibri,sans-serif",
    weight: 300,
    extra: '',
    caseRule: null,
    caseNote: '',
  },
  micro: {
    label: 'NeuzeitGro Bold — micro label',
    stack: "'NeuzeitGro','Gill Sans','Gill Sans MT',Calibri,sans-serif",
    weight: 700,
    extra: 'letter-spacing:.20em;text-transform:uppercase;',
    caseRule: null,
    caseNote: 'Rendered uppercase by the type role itself.',
  },
};

// Default type ramp, per role. Editable as a brand primitive.
const DEFAULT_TYPE_SCALE = {
  'display-xl': { role: 'display', size: 46, lineHeight: 1.05, label: 'Display XL' },
  'display-l': { role: 'display', size: 40, lineHeight: 1.05, label: 'Display L' },
  'display-m': { role: 'display', size: 30, lineHeight: 1.15, label: 'Display M' },
  'display-s': { role: 'display', size: 22, lineHeight: 1.25, label: 'Display S' },
  'script-xl': { role: 'script', size: 62, lineHeight: 1.0, label: 'Script XL' },
  'script-l': { role: 'script', size: 44, lineHeight: 1.0, label: 'Script L' },
  'script-m': { role: 'script', size: 30, lineHeight: 1.0, label: 'Script M' },
  'script-s': { role: 'script', size: 22, lineHeight: 1.0, label: 'Script S' },
  'body-l': { role: 'body', size: 16, lineHeight: 1.75, label: 'Body L' },
  'body-m': { role: 'body', size: 14, lineHeight: 1.75, label: 'Body M' },
  'body-s': { role: 'body', size: 12, lineHeight: 1.7, label: 'Body S' },
  'micro': { role: 'micro', size: 9, lineHeight: 1.4, label: 'Micro label' },
  'micro-l': { role: 'micro', size: 11, lineHeight: 1.4, label: 'Micro label L' },
};

function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(DS, 'manifest.json'), 'utf8'));
}

const db = require('./db');

let _overrides = null;      // in-memory copy, the only thing getBrand() reads
let _at = 0;
let _refreshing = null;

function readOverridesDisk() {
  try { return JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8')); } catch (_) { return {}; }
}

async function loadOverrides() {
  if (!db.enabled) return readOverridesDisk();
  const r = await db.query('SELECT record FROM studio_brand WHERE id = $1', ['brand']);
  return r.rows.length ? r.rows[0].record : {};
}

async function storeOverrides(o) {
  if (!db.enabled) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(OVERRIDE_FILE, JSON.stringify(o, null, 2));
    return o;
  }
  await db.query(
    `INSERT INTO studio_brand (id, record, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET record = EXCLUDED.record, updated_at = now()`,
    ['brand', JSON.stringify(o)],
  );
  return o;
}

function refresh() {
  if (_refreshing) return _refreshing;
  _refreshing = loadOverrides()
    .then((o) => { _overrides = o || {}; _at = Date.now(); return _overrides; })
    .catch((e) => { console.error('[brandTokens] refresh failed:', e.message); _overrides = _overrides || {}; return _overrides; })
    .finally(() => { _refreshing = null; });
  return _refreshing;
}

const STALE_MS = Number(process.env.STUDIO_CACHE_MS || 5000);
function refreshIfStale(maxAgeMs = STALE_MS) {
  if (_overrides && Date.now() - _at < maxAgeMs) return Promise.resolve(_overrides);
  return refresh();
}

// Synchronous accessor. Before the first refresh this reads the disk file directly, so a
// disk-backed deployment (and any sync caller that runs before hydrate) still sees overrides.
function readOverrides() {
  if (_overrides) return _overrides;
  if (!db.enabled) { _overrides = readOverridesDisk(); _at = Date.now(); return _overrides; }
  return {};
}

// The merged brand: shipped baseline + designer overrides.
function getBrand() {
  const locked = readManifest().locked_styles || {};
  const ov = readOverrides();
  return {
    colours: { ...(locked.colours || {}), ...(ov.colours || {}) },
    bodyBackground: ov.bodyBackground || locked.body_background || '#2c2825',
    typeScale: { ...DEFAULT_TYPE_SCALE, ...(ov.typeScale || {}) },
    fontRoles: FONT_ROLES,
    // The hosted brand faces, so the Studio canvas renders in Cervanttis / Lust / NeuzeitGro
    // rather than a fallback serif — a script headline judged in Georgia is not judged at all.
    fontCdn: readManifest().font_cdn || {},
    // The brand line-art set, so the Studio can offer the illustration accents as a picker
    // rather than a filename the designer has to know.
    assets: (() => {
      try { return fs.readdirSync(path.join(DS, 'assets')).filter(f => /\.(png|jpe?g|webp|svg)$/i.test(f)).sort(); }
      catch (_) { return []; }
    })(),
    // Provenance, so the UI can show "changed from #D8CCBE" next to an edited swatch.
    baseline: { colours: locked.colours || {}, bodyBackground: locked.body_background || '#2c2825', typeScale: DEFAULT_TYPE_SCALE },
    overridden: {
      colours: Object.keys(ov.colours || {}),
      typeScale: Object.keys(ov.typeScale || {}),
      bodyBackground: !!ov.bodyBackground,
    },
    updatedAt: ov.updatedAt || null,
  };
}

// Merge a patch into the overrides. Only known keys are accepted, so a typo can't
// invent a brand colour that no component references.
async function setBrand(patch = {}) {
  const brand = getBrand();
  const ov = readOverrides();
  if (patch.colours) {
    ov.colours = ov.colours || {};
    for (const [k, v] of Object.entries(patch.colours)) {
      if (!Object.prototype.hasOwnProperty.call(brand.baseline.colours, k)) continue;
      if (!/^#[0-9a-fA-F]{3,8}$/.test(String(v))) continue;
      if (String(v).toLowerCase() === String(brand.baseline.colours[k]).toLowerCase()) delete ov.colours[k];
      else ov.colours[k] = String(v);
    }
    if (!Object.keys(ov.colours).length) delete ov.colours;
  }
  if (patch.bodyBackground && /^#[0-9a-fA-F]{3,8}$/.test(String(patch.bodyBackground))) {
    if (String(patch.bodyBackground).toLowerCase() === String(brand.baseline.bodyBackground).toLowerCase()) delete ov.bodyBackground;
    else ov.bodyBackground = String(patch.bodyBackground);
  }
  if (patch.typeScale) {
    ov.typeScale = ov.typeScale || {};
    for (const [k, v] of Object.entries(patch.typeScale)) {
      const base = DEFAULT_TYPE_SCALE[k];
      if (!base) continue;
      const size = Number(v && v.size);
      const lh = Number(v && v.lineHeight);
      if (!(size > 0) || !(lh > 0)) continue;
      if (size === base.size && lh === base.lineHeight) delete ov.typeScale[k];
      else ov.typeScale[k] = { ...base, size, lineHeight: lh };
    }
    if (!Object.keys(ov.typeScale).length) delete ov.typeScale;
  }
  ov.updatedAt = new Date().toISOString();
  await storeOverrides(ov);
  await refresh();
  return getBrand();
}

async function resetBrand() {
  await storeOverrides({ updatedAt: new Date().toISOString() });
  await refresh();
  return getBrand();
}

// Rewrite an assembled document's baseline brand colours into their current overrides.
//
// Compiled templates — shipped ones on disk and authored versions alike — always speak the
// *baseline* palette, so a published version's HTML never has to change for the brand to
// change. The override is applied here, at assembly, which is what makes a palette edit reach
// the whole library at once while leaving immutable versions untouched.
//
// One pass with a single alternation, not a replace per colour: sequential replacement would
// cascade when one colour's override happens to equal another colour's baseline.
function applyOverrides(html) {
  if (!html) return html;
  const brand = getBrand();
  const map = new Map();
  for (const [k, baseHex] of Object.entries(brand.baseline.colours || {})) {
    const now = brand.colours[k];
    if (now && String(now).toLowerCase() !== String(baseHex).toLowerCase()) {
      map.set(String(baseHex).toLowerCase(), now);
    }
  }
  const baseBg = brand.baseline.bodyBackground;
  if (brand.bodyBackground && String(brand.bodyBackground).toLowerCase() !== String(baseBg).toLowerCase()) {
    map.set(String(baseBg).toLowerCase(), brand.bodyBackground);
  }
  if (!map.size) return html;
  const re = new RegExp([...map.keys()].map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  return html.replace(re, (m) => map.get(m.toLowerCase()) || m);
}

// Which shipped templates reference a given brand colour literal. Powers the Studio's
// "this change touches N components" warning before a brand primitive is published.
function affectedBy(colourKey) {
  const brand = getBrand();
  const hex = brand.baseline.colours[colourKey];
  if (!hex) return [];
  const tdir = path.join(DS, 'templates');
  const hits = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.name.endsWith('.html')) {
        const html = fs.readFileSync(fp, 'utf8');
        if (html.toLowerCase().includes(String(hex).toLowerCase())) {
          hits.push(path.relative(tdir, fp).replace(/\.html$/, '').split(path.sep).join('/'));
        }
      }
    }
  })(tdir);
  return hits.sort();
}

module.exports = {
  getBrand, setBrand, resetBrand, affectedBy, applyOverrides, refresh, refreshIfStale,
  FONT_ROLES, DEFAULT_TYPE_SCALE,
  get backend() { return db.enabled ? 'postgres' : 'disk'; },
};

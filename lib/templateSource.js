'use strict';
// templateSource.js — one place that answers "what HTML is this component?".
//
// Before the Studio, that answer was always a file on disk. Now it can also be a version
// published from the Studio, and resolution order matters:
//
//   1. `blocks/x@3`  — an explicit version pin. A saved or sent campaign records the version it
//                      was built against, so publishing version 4 today cannot restyle it.
//   2. `blocks/x`    — the currently published authored version, if there is one. This is how an
//                      authored component *upgrades* a shipped template of the same name.
//   3. `blocks/x`    — the template file on disk: the shipped baseline, and the thing an
//                      unpublish falls back to.
//
// Everything that renders a campaign goes through here, so a designer's published work reaches
// the live preview, the PNG, the slices and the Klaviyo push without any of them knowing that
// Studio components exist.

const fs = require('fs');
const path = require('path');
const store = require('./componentStore');

const DS = path.join(__dirname, '..', 'design-system');
const TPL = path.join(DS, 'templates');

// `blocks/editorial-hero@3` → { name:'blocks/editorial-hero', version:3 }
function splitPin(component) {
  const m = String(component || '').match(/^(.+?)@(\d+)$/);
  return m ? { name: m[1], version: Number(m[2]) } : { name: String(component || ''), version: null };
}

function diskPath(name) {
  // Confine to the templates dir — a component name arrives from a campaign JSON.
  const p = path.normalize(path.join(TPL, name + '.html'));
  return p.startsWith(TPL) ? p : null;
}

function resolve(component) {
  const { name, version } = splitPin(component);

  if (version) {
    const pinned = store.pinnedTemplate(name, version);
    if (pinned) return { name, html: pinned.html, source: 'authored', version, mode: pinned.mode };
  }

  const published = store.publishedTemplates().find(t => t.name === name);
  if (published) return { name, html: published.html, source: 'authored', version: published.version, mode: published.mode };

  const fp = diskPath(name);
  if (fp && fs.existsSync(fp)) return { name, html: fs.readFileSync(fp, 'utf8'), source: 'disk', version: null, mode: null };

  return null;
}

function exists(component) { return !!resolve(component); }

// Published authored components that ship as live HTML rather than a PNG. Fed into the same
// basename list the manifest uses, so the slice/push path treats them identically.
function htmlOnlyExtras() {
  return store.publishedTemplates().filter(t => t.mode === 'live').map(t => t.name.split('/').pop());
}

// Shape buildSchema() wants for its `extraTemplates` option.
function publishedForSchema() {
  return store.publishedTemplates().map(t => ({
    name: t.name, html: t.html, version: t.version, id: t.id,
    shadowsShipped: t.shadowsShipped, intent: t.intent,
  }));
}

// Sample tokens for published authored components, so the Library can render them alive.
function publishedSamples() {
  const out = {};
  for (const t of store.publishedTemplates()) out[t.name] = t.sampleTokens || {};
  return out;
}

// A cheap fingerprint of everything the Studio can change. server.js caches the derived schema
// against this, so publishing a component or a brand edit invalidates the cache without a restart.
function revision() {
  const parts = store.publishedTemplates().map(t => `${t.name}@${t.version}`).sort();
  let brandStamp = '';
  try {
    brandStamp = require('./brandTokens').getBrand().updatedAt || '';
  } catch (_) { /* brand file absent — baseline only */ }
  return parts.join(',') + '|' + brandStamp;
}

module.exports = { resolve, exists, splitPin, htmlOnlyExtras, publishedForSchema, publishedSamples, revision, TPL, DS };

'use strict';
// assetBase.js — where the bundled design-system images are served from, and whether that URL
// is one a RECIPIENT can reach.
//
// The distinction is the whole module. Two kinds of consumer read the assembled HTML:
//
//   the preview and the rasteriser, which run on this machine and should fetch the images from
//   whichever host just served them;
//
//   the export and the Klaviyo push, whose output leaves the building and is opened later, by
//   someone else, somewhere else.
//
// Deriving the base from the request's Host header is right for the first and wrong for the
// second, and it fails in the quietest way available: the markup is well-formed, every token is
// filled, the export gate passes it, and the images are simply dead in every inbox. That is the
// same class of fault as a font that folds Ø onto O — correct-looking output, wrong result, no
// error anywhere — so it gets the same treatment: name it, and refuse.

// Hosts that resolve only on the machine or network that asked for them.
const LOCAL_HOST_RE = /^(?:localhost|127\.|0\.0\.0\.0$|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.)/i;
const LOCAL_TLD_RE = /\.(?:local|internal|localhost|test|invalid)$/i;

// Absolute, externally-reachable base for the bundled assets.
//
// PUBLIC_ASSETS_BASE wins when set. The Host header is only the right answer while the machine
// serving the HTML is also the machine the images will be fetched from — true for the editor's
// iframe, false for a CDN, and false for anything exported off a laptop.
function assetsBaseFor(req) {
  const configured = String(process.env.PUBLIC_ASSETS_BASE || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  const headers = (req && req.headers) || {};
  const proto = String(headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = headers.host;
  return host ? `${proto}://${host}/design-system/assets` : '/design-system/assets';
}

// Why this base cannot be reached from outside, or null when it can. Callers on the paths whose
// output stays local should not consult this at all.
function unreachableAssetBase(base) {
  const raw = String(base == null ? '' : base);
  if (!/^https?:\/\//i.test(raw)) return 'is not an absolute http(s) URL';
  let url;
  try { url = new URL(raw); } catch (_) { return 'is not a valid URL'; }
  // IPv6 literals arrive bracketed; ::1 is loopback however it is spelt.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return 'points at the IPv6 loopback, which resolves only on this machine';
  if (LOCAL_HOST_RE.test(host) || LOCAL_TLD_RE.test(host)) return `points at ${host}, which resolves only on this network`;
  if (!host.includes('.')) return `points at the bare hostname ${host}, which will not resolve outside this network`;
  return null;
}

module.exports = { assetsBaseFor, unreachableAssetBase };

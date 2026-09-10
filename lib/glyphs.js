'use strict';
// glyphs.js — does the brand face actually have the letter, or is it only pretending?
//
// The failure this exists for is not a missing glyph. A missing glyph is loud: the client
// falls back to another face and the mismatch is obvious in review. The dangerous one is a
// cmap that maps an accented codepoint onto its PLAIN BASE GLYPH. Cervanttis does this for all
// 48 accented Latin-1 letters — U+00D8 Ø resolves to the glyph for O, U+00E3 ã to a, U+00EE î
// to i — so "Økar" typesets as a clean, well-set "Okar". Nothing errors. `document.fonts.check`
// returns true, because the codepoint IS in the cmap. The email ships with a maker's name
// misspelt, and in the same document NeuzeitGro renders ØKAR correctly, so one send can spell
// it two different ways.
//
// So this reads the cmap directly and reports two kinds of miss:
//   missing — the codepoint is absent; the client will substitute another face.
//   folded  — the codepoint resolves to the same glyph as its unaccented base letter, so the
//             mark silently disappears and the text reads as a different word.
//
// Faces are read from the preview shell's embedded @font-face data: URIs — the exact bytes
// renderToPng rasterises with, so what the guard checks is what the render draws.

const fs = require('fs');
const path = require('path');

const DS = path.join(__dirname, '..', 'design-system');
const SHELL = path.join(DS, 'shell', 'shell-preview.html');

// ── sfnt / cmap reader ────────────────────────────────────────────────────────────────
// TrueType (0x00010000) and CFF/OpenType ('OTTO') differ only in how outlines are stored; the
// cmap is byte-identical between them, and the cmap is all we need.

// WOFF2, which is what the production shell links, is a Brotli-compressed container with its
// own table directory. Undoing it in general means reversing the glyf/loca transforms — but
// WOFF2 only ever transforms glyf, loca and hmtx, so `cmap` comes through verbatim and can be
// lifted straight out of the decompressed stream. That is enough to audit a live font rather
// than trust it, which is the whole point after Cervanttis.
const WOFF2_KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca',
  'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea',
  'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL',
  'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
];

// UIntBase128: 1–5 bytes, 7 bits each, high bit continues.
function readBase128(buf, p) {
  let v = 0;
  for (let i = 0; i < 5; i++) {
    const b = buf.readUInt8(p + i);
    v = (v << 7) | (b & 0x7f);
    if (!(b & 0x80)) return [v >>> 0, p + i + 1];
  }
  throw new Error('malformed UIntBase128');
}

// Pull the raw cmap table out of a WOFF2 container, or null if there isn't one.
function woff2Cmap(buf) {
  if (buf.readUInt32BE(0) !== 0x774f4632) return null;   // 'wOF2'
  const numTables = buf.readUInt16BE(12);
  let p = 48;
  const entries = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf.readUInt8(p); p += 1;
    let tag;
    if ((flags & 0x3f) === 0x3f) { tag = buf.toString('latin1', p, p + 4); p += 4; }
    else tag = WOFF2_KNOWN_TAGS[flags & 0x3f];
    let origLength; [origLength, p] = readBase128(buf, p);
    // Only glyf/loca/hmtx are ever transformed; for everything else a non-null transform
    // version still means "no transform", so the stream carries origLength bytes.
    const xform = (flags >> 6) & 0x03;
    let length = origLength;
    if ((tag === 'glyf' || tag === 'loca') ? xform === 0 : xform !== 0) {
      [length, p] = readBase128(buf, p);
    }
    entries.push({ tag, length });
  }
  const compressed = buf.subarray(p);
  const stream = require('zlib').brotliDecompressSync(compressed);
  let at = 0;
  for (const e of entries) {
    if (e.tag === 'cmap') return stream.subarray(at, at + e.length);
    at += e.length;
  }
  return null;
}

function tableOffsets(buf) {
  const tag = buf.readUInt32BE(0);
  if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return null; // not sfnt
  const numTables = buf.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const p = 12 + i * 16;
    if (p + 16 > buf.length) break;
    tables[buf.toString('latin1', p, p + 4)] = { offset: buf.readUInt32BE(p + 8), length: buf.readUInt32BE(p + 12) };
  }
  return tables;
}

// Read one cmap subtable into codepoint → glyph id.
function readSubtable(buf, off, out) {
  const format = buf.readUInt16BE(off);
  if (format === 0) {
    for (let c = 0; c < 256; c++) out.set(c, buf.readUInt8(off + 6 + c));
  } else if (format === 4) {
    const segCount = buf.readUInt16BE(off + 6) / 2;
    const endP = off + 14, startP = endP + segCount * 2 + 2;
    const deltaP = startP + segCount * 2, rangeP = deltaP + segCount * 2;
    for (let s = 0; s < segCount; s++) {
      const end = buf.readUInt16BE(endP + s * 2);
      const start = buf.readUInt16BE(startP + s * 2);
      if (start > end) continue;
      const delta = buf.readInt16BE(deltaP + s * 2);
      const rangeOff = buf.readUInt16BE(rangeP + s * 2);
      for (let c = start; c <= end && c !== 0x10000; c++) {
        let g;
        if (rangeOff === 0) g = (c + delta) & 0xffff;
        else {
          const gp = rangeP + s * 2 + rangeOff + (c - start) * 2;
          if (gp + 2 > buf.length) continue;
          g = buf.readUInt16BE(gp);
          if (g !== 0) g = (g + delta) & 0xffff;
        }
        if (g !== 0) out.set(c, g);
      }
    }
  } else if (format === 6) {
    const first = buf.readUInt16BE(off + 6), count = buf.readUInt16BE(off + 8);
    for (let i = 0; i < count; i++) {
      const g = buf.readUInt16BE(off + 10 + i * 2);
      if (g !== 0) out.set(first + i, g);
    }
  } else if (format === 12) {
    const nGroups = buf.readUInt32BE(off + 12);
    for (let i = 0; i < nGroups; i++) {
      const p = off + 16 + i * 12;
      const start = buf.readUInt32BE(p), end = buf.readUInt32BE(p + 4), startGid = buf.readUInt32BE(p + 8);
      // A pathological group can span the whole plane; the brand faces are Latin, and a guard
      // that walks 1.1M codepoints per face on every render is not worth the completeness.
      for (let c = start; c <= end && c - start < 0x10000; c++) out.set(c, startGid + (c - start));
    }
  }
  return out;
}

// Unicode → glyph id for a font's best available subtable set. Later (more capable) subtables
// are read last so they win.
const SUBTABLE_RANK = (plat, enc) =>
  (plat === 3 && enc === 10) ? 4 : (plat === 0) ? 3 : (plat === 3 && enc === 1) ? 2 : (plat === 3 && enc === 0) ? 1 : 0;

// Accepts a bare sfnt (TTF/OTF, and the base64 faces in the preview shell) or a WOFF2
// container (what the production shell links), so one reader audits both surfaces.
//
// TOTAL BY CONTRACT: returns null for anything it cannot read, and never throws. Every caller
// is handling bytes it did not produce — a base64 blob in a shell, or whatever a CDN returned
// this morning — and the most important caller is check-fonts.js, which exists precisely for
// the days when a font URL stops serving a font. A parser that threw on an HTML error page
// would crash the check instead of reporting it, at exactly the moment the check matters.
function readCmap(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    const lifted = woff2Cmap(buf);
    if (lifted) return readCmapTable(lifted, 0);
    const tables = tableOffsets(buf);
    if (!tables || !tables.cmap) return null;
    return readCmapTable(buf, tables.cmap.offset);
  } catch (_) {
    return null;   // malformed, truncated, or not a font at all
  }
}

function readCmapTable(buf, base) {
  const n = buf.readUInt16BE(base + 2);
  const subs = [];
  for (let i = 0; i < n; i++) {
    const p = base + 4 + i * 8;
    subs.push({
      rank: SUBTABLE_RANK(buf.readUInt16BE(p), buf.readUInt16BE(p + 2)),
      off: base + buf.readUInt32BE(p + 4),
    });
  }
  const out = new Map();
  for (const s of subs.sort((a, b) => a.rank - b.rank)) {
    try { readSubtable(buf, s.off, out); } catch (_) { /* a malformed subtable must not kill the guard */ }
  }
  return out.size ? out : null;
}

// ── base-letter folding ───────────────────────────────────────────────────────────────

// Letters whose accent is part of the outline rather than a combining mark, so NFD leaves them
// alone. These are exactly the ones a lazy cmap is most likely to alias to the bare letter.
const STROKE_BASE = {
  'Ø': 'O', 'ø': 'o', 'Đ': 'D', 'đ': 'd', 'Ð': 'D', 'ð': 'd',
  'Ł': 'L', 'ł': 'l', 'Ħ': 'H', 'ħ': 'h', 'Ŧ': 'T', 'ŧ': 't',
  'Ɨ': 'I', 'ɨ': 'i', 'Ƚ': 'L', 'Ɵ': 'O', 'Ꝑ': 'P',
};

// The unaccented letter a codepoint would collapse to, or null when it has no base form.
function baseLetter(ch) {
  if (STROKE_BASE[ch]) return STROKE_BASE[ch];
  const stripped = ch.normalize('NFD').replace(/\p{M}/gu, '');
  return (stripped.length === 1 && stripped !== ch) ? stripped : null;
}

// ── faces ─────────────────────────────────────────────────────────────────────────────

// family name as written in the shell → the schema's font key
const FAMILY_KEY = { cervanttis: 'cervanttis', lust: 'lust', neuzeitgro: 'neuzeitgro' };

let _faces = null;
// { cervanttis: {family, cmap, bytes}, … } — one entry per brand face. Where a family ships
// several weights (NeuzeitGro Light + Bold) the first is kept: they are cut from one source and
// carry the same character set, and a per-weight report would say the same thing twice.
function faces() {
  if (_faces) return _faces;
  _faces = {};
  let shell = '';
  try { shell = fs.readFileSync(SHELL, 'utf8'); } catch (_) { return _faces; }
  const re = /@font-face\s*\{[^}]*?font-family:\s*'([^']+)'[^}]*?url\(\s*'data:font\/[a-z0-9]+;base64,([A-Za-z0-9+/=]+)'/g;
  for (const m of shell.matchAll(re)) {
    const key = FAMILY_KEY[m[1].toLowerCase()];
    if (!key || _faces[key]) continue;
    try {
      const cmap = readCmap(Buffer.from(m[2], 'base64'));
      if (cmap) _faces[key] = { family: m[1], cmap };
    } catch (_) { /* an unreadable face is reported as unknown, never as a failure */ }
  }
  return _faces;
}

// ── the check ─────────────────────────────────────────────────────────────────────────

// Codepoints every face is expected to carry regardless of the copy — kept out of the report so
// a headline of ordinary English never produces noise.
const ALWAYS_FINE = /[ -]/;

// Inspect one string in one face. Returns [{ char, codepoint, kind, rendersAs? }].
function inspect(text, fontKey) {
  const face = faces()[fontKey];
  if (!face || typeof text !== 'string') return [];
  const seen = new Set();
  const out = [];
  for (const ch of text) {
    if (ALWAYS_FINE.test(ch) || seen.has(ch)) continue;
    seen.add(ch);
    const cp = ch.codePointAt(0);
    // Marks, punctuation and symbols are not the brand's problem — the fallback for a stray
    // ellipsis is invisible. Only letters carry meaning that a fold can destroy.
    if (!/\p{L}/u.test(ch)) continue;
    const gid = face.cmap.get(cp);
    const base = baseLetter(ch);
    if (gid === undefined) {
      out.push({ char: ch, codepoint: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'), kind: 'missing' });
    } else if (base && face.cmap.get(base.codePointAt(0)) === gid) {
      out.push({
        char: ch, codepoint: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'),
        kind: 'folded', rendersAs: base,
      });
    }
  }
  return out;
}

// Audit every token value in a campaign against the face that typesets it.
//
// Returns [{ component, index, token, face, codepoint, char, kind, rendersAs?, message }],
// ordered by block. A token the schema cannot attribute to a brand face (a URL, a colour, a
// value that only ever lands in an attribute) is skipped — there is no face to check it against.
function auditCampaign(campaign, schema) {
  const byName = new Map((schema && schema.components || []).map((c) => [c.name, c]));
  const misses = [];
  ((campaign && campaign.blocks) || []).forEach((block, index) => {
    const def = byName.get(block.component);
    if (!def) return;
    for (const tok of def.tokens || []) {
      if (!tok.font) continue;
      const value = (block.tokens || {})[tok.name];
      for (const hit of inspect(value, tok.font)) {
        misses.push({
          component: block.component, index, token: tok.name, face: tok.font,
          char: hit.char, codepoint: hit.codepoint, kind: hit.kind,
          ...(hit.rendersAs ? { rendersAs: hit.rendersAs } : {}),
          message: hit.kind === 'folded'
            ? `'${tok.name}' contains ${hit.char} (${hit.codepoint}), which ${tok.font} maps to its base glyph — it renders as ${hit.rendersAs}, silently changing the word.`
            : `'${tok.name}' contains ${hit.char} (${hit.codepoint}), which ${tok.font} has no glyph for — the client will substitute another face.`,
        });
      }
    }
  });
  return misses;
}

// Which brand faces CAN set a character properly. This is what makes the validator's advice
// actionable: the answer to "Cervanttis cannot set ø" is almost never "drop the ø", it is "set
// that word in one of these faces instead".
function facesThatCanSet(ch) {
  const cp = ch.codePointAt(0);
  const base = baseLetter(ch);
  return Object.entries(faces())
    .filter(([, f]) => {
      const gid = f.cmap.get(cp);
      return gid !== undefined && !(base && f.cmap.get(base.codePointAt(0)) === gid);
    })
    .map(([key]) => key);
}

// Which codepoints a face folds or lacks across a range — the audit behind the report, and what
// the regression test asserts against so a re-cut font is checked rather than trusted.
function faceCoverage(fontKey, from = 0x00a0, to = 0x024f) {
  const face = faces()[fontKey];
  if (!face) return null;
  const folded = [], missing = [];
  for (let cp = from; cp <= to; cp++) {
    const ch = String.fromCodePoint(cp);
    if (!/\p{L}/u.test(ch) || !baseLetter(ch)) continue;
    const gid = face.cmap.get(cp);
    if (gid === undefined) missing.push(ch);
    else if (face.cmap.get(baseLetter(ch).codePointAt(0)) === gid) folded.push(ch);
  }
  return { face: face.family, mapped: face.cmap.size, folded, missing };
}

module.exports = { auditCampaign, inspect, faceCoverage, facesThatCanSet, faces, readCmap, baseLetter };

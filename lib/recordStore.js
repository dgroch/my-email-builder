'use strict';
// recordStore.js — one small collection API over two drivers.
//
// The Studio stores (components, layouts) are collections of JSON records addressed by id.
// That is all they need from persistence, so the storage decision lives here rather than
// being duplicated in each store: Postgres when DATABASE_URL is set, JSON files under
// DATA_DIR otherwise. Both drivers return plain records, so nothing above this file knows
// which one it is talking to.

const fs = require('fs');
const path = require('path');
const db = require('./db');

const DATA_DIR = () => process.env.DATA_DIR || path.join(__dirname, '..', 'data');

// spec = { table, dir, columns: { column_name: recordKey | fn }, snapshot?: { where, predicate } }
// `columns` are values promoted out of the JSONB so listing is indexed and the rows are
// legible in psql. The record itself always remains the source of truth.
function collection(spec) {
  const { table, dir, columns = {}, snapshot } = spec;
  const colNames = Object.keys(columns);
  const valueOf = (rec, col) => {
    const src = columns[col];
    const v = typeof src === 'function' ? src(rec) : rec[src];
    return v === undefined ? null : v;
  };

  // ── disk driver ───────────────────────────────────────────────────────────
  const diskDir = () => path.join(DATA_DIR(), dir);
  function diskFile(id) { return path.join(diskDir(), id + '.json'); }

  const disk = {
    async list() {
      const d = diskDir();
      if (!fs.existsSync(d)) return [];
      const out = [];
      for (const f of fs.readdirSync(d)) {
        if (!f.endsWith('.json')) continue;
        try { out.push(JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))); } catch (_) { /* skip unreadable */ }
      }
      return out;
    },
    async get(id) {
      try { return JSON.parse(fs.readFileSync(diskFile(id), 'utf8')); } catch (_) { return null; }
    },
    async put(rec) {
      fs.mkdirSync(diskDir(), { recursive: true });
      fs.writeFileSync(diskFile(rec.id), JSON.stringify(rec, null, 2));
      return rec;
    },
    async del(id) {
      try { fs.unlinkSync(diskFile(id)); return true; } catch (_) { return false; }
    },
    async listSnapshot() {
      const all = await disk.list();
      return snapshot && snapshot.predicate ? all.filter(snapshot.predicate) : all;
    },
  };

  // ── postgres driver ───────────────────────────────────────────────────────
  const pg = {
    async list() {
      const r = await db.query(`SELECT record FROM ${table} ORDER BY updated_at DESC`);
      return r.rows.map((x) => x.record);
    },
    async get(id) {
      const r = await db.query(`SELECT record FROM ${table} WHERE id = $1`, [id]);
      return r.rows.length ? r.rows[0].record : null;
    },
    async put(rec) {
      const cols = ['id', ...colNames, 'record', 'updated_at'];
      const vals = [rec.id, ...colNames.map((c) => valueOf(rec, c)), JSON.stringify(rec)];
      const placeholders = vals.map((_, i) => `$${i + 1}`).concat('now()');
      // The record is rewritten wholesale on every save — these are small documents, and a
      // whole-record upsert keeps the JSONB and its promoted columns from ever disagreeing.
      const updates = [...colNames, 'record'].map((c) => `${c} = EXCLUDED.${c}`).concat('updated_at = now()');
      await db.query(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})
         ON CONFLICT (id) DO UPDATE SET ${updates.join(', ')}`,
        vals,
      );
      return rec;
    },
    async del(id) {
      const r = await db.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
      return r.rowCount > 0;
    },
    // Only the rows the render path could ever resolve. Without this, refreshing the snapshot
    // would pull every draft and every version history into memory on a short TTL.
    async listSnapshot() {
      const where = snapshot && snapshot.where ? `WHERE ${snapshot.where}` : '';
      const r = await db.query(`SELECT record FROM ${table} ${where}`);
      return r.rows.map((x) => x.record);
    },
  };

  // Resolved per call, not at module load: the tests exercise both drivers in one process.
  const driver = () => (db.enabled ? pg : disk);

  return {
    list: (...a) => driver().list(...a),
    get: (...a) => driver().get(...a),
    put: (...a) => driver().put(...a),
    del: (...a) => driver().del(...a),
    listSnapshot: (...a) => driver().listSnapshot(...a),
    get backend() { return db.enabled ? 'postgres' : 'disk'; },
  };
}

module.exports = { collection };

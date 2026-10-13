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
    async pending(tenantId,limit=21){
      if(db.enabled){const r=await db.query(`SELECT record FROM ${table} WHERE record->>'tenantId'=$1 AND record->>'state' IN ('freezing','queued','rendering') ORDER BY updated_at LIMIT $2`,[tenantId,limit]);return r.rows.map(r=>r.record);}
      const out=[];if(!fs.existsSync(diskDir()))return out;for(const file of fs.readdirSync(diskDir())){if(!file.endsWith('.json'))continue;const record=await disk.get(file.slice(0,-5));if(record&&record.tenantId===tenantId&&['freezing','queued','rendering'].includes(record.state)){out.push(record);if(out.length>=limit)break;}}return out;
    },
    // Reserve before snapshot I/O. The hosted admission lock is shared by every process.
    async reserve(rec, limit) {
      if (db.enabled)
        return db.transaction(async (client) => {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,123457))",
            [table + ":" + rec.tenantId],
          );
          const existing = (
            await client.query(`SELECT record FROM ${table} WHERE id=$1`, [
              rec.id,
            ])
          ).rows[0];
          if (existing) return { status: "exists", record: existing.record };
          const count = (
            await client.query(
              `SELECT count(*)::int n FROM ${table} WHERE record->>'tenantId'=$1 AND record->>'state' IN ('freezing','queued','rendering')`,
              [rec.tenantId],
            )
          ).rows[0].n;
          if (count >= limit) return { status: "full" };
          await client.query(
            `INSERT INTO ${table}(id,record,updated_at) VALUES($1,$2,now())`,
            [rec.id, JSON.stringify(rec)],
          );
          return { status: "reserved" };
        });
      // Disk is single-process local storage; no await may split admission and insertion.
      fs.mkdirSync(diskDir(), { recursive: true });
      if (fs.existsSync(diskFile(rec.id)))
        return {
          status: "exists",
          record: JSON.parse(fs.readFileSync(diskFile(rec.id), "utf8")),
        };
      let pending = 0;
      for (const file of fs.readdirSync(diskDir())) {
        if (!file.endsWith(".json")) continue;
        const item = JSON.parse(
          fs.readFileSync(path.join(diskDir(), file), "utf8"),
        );
        if (
          item.tenantId === rec.tenantId &&
          ["freezing", "queued", "rendering"].includes(item.state)
        )
          pending++;
      }
      if (pending >= limit) return { status: "full" };
      fs.writeFileSync(diskFile(rec.id), JSON.stringify(rec), { flag: "wx" });
      return { status: "reserved" };
    },
    async insert(rec) {
      if(db.enabled) { const r=await db.query(`INSERT INTO ${table}(id,record,updated_at) VALUES($1,$2,now()) ON CONFLICT(id) DO NOTHING RETURNING record`,[rec.id,JSON.stringify(rec)]);return !!r.rowCount; }
      fs.mkdirSync(diskDir(),{recursive:true});try {fs.writeFileSync(diskFile(rec.id),JSON.stringify(rec),{flag:'wx'});return true;}catch(e){if(e.code==='EEXIST')return false;throw e;}
    },
    async compareAndSwap(id,revision,rec) {
      if(db.enabled){const r=await db.query(`UPDATE ${table} SET record=$3,updated_at=now() WHERE id=$1 AND (record->>'revision')::int=$2 RETURNING id`,[id,revision,JSON.stringify(rec)]);return !!r.rowCount;}
      let current;try{current=JSON.parse(fs.readFileSync(diskFile(id),'utf8'));}catch(_){return false;}if(current.revision!==revision)return false;const temporary=diskFile(id)+'.tmp';fs.writeFileSync(temporary,JSON.stringify(rec));fs.renameSync(temporary,diskFile(id));return true;
    },
    get backend() { return db.enabled ? 'postgres' : 'disk'; },
  };
}

module.exports = { collection };

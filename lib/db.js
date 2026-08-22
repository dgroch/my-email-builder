'use strict';
// db.js — the Postgres backing store, and the schema it owns.
//
// Set DATABASE_URL and every Studio record (components, their versions, layouts, brand
// overrides) and — unless Notion is configured — saved designs move into Postgres. Unset it
// and the app falls back to JSON files under DATA_DIR exactly as before, so a local checkout
// still runs with no database at all.
//
// Records are stored as JSONB with a handful of columns promoted out of them (name, status,
// published_version, updated_at). The JSONB is the source of truth; the columns exist so
// listing and lookup are indexed, and so the data is legible to anyone with a psql prompt.

const CONN = process.env.DATABASE_URL || '';
const enabled = !!CONN;

let _pool = null;
let _ready = null;

function pool() {
  if (_pool) return _pool;
  const { Pool } = require('pg');
  _pool = new Pool({
    connectionString: CONN,
    // Render's managed Postgres terminates TLS with a certificate the default CA bundle does
    // not chain to. Hosted providers generally need this; a local socket does not.
    ssl: /localhost|127\.0\.0\.1|\/tmp\//.test(CONN) ? false : { rejectUnauthorized: false },
    max: Number(process.env.PGPOOL_MAX || 5),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  // A pool error with no listener takes the process down; an internal tool should log and
  // let the next query re-establish instead.
  _pool.on('error', (e) => console.error('[db] idle client error:', e.message));
  return _pool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS studio_components (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  group_name        TEXT,
  slug              TEXT,
  status            TEXT NOT NULL DEFAULT 'draft',
  published_version INTEGER,
  -- True once ANY version of this component has been published. A version-pinned reference
  -- must keep resolving after the component is unpublished or archived, so this — not
  -- published_version — is what the snapshot query filters on.
  ever_published    BOOLEAN NOT NULL DEFAULT false,
  record            JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- CREATE TABLE IF NOT EXISTS is a no-op against a table that already exists, so a column
-- added after the first deploy only ever arrives through an ALTER. This runs before the
-- indexes below, which reference it.
ALTER TABLE studio_components ADD COLUMN IF NOT EXISTS ever_published BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS studio_components_name_idx      ON studio_components (name);
CREATE INDEX IF NOT EXISTS studio_components_published_idx ON studio_components (published_version) WHERE published_version IS NOT NULL;
CREATE INDEX IF NOT EXISTS studio_components_ever_idx      ON studio_components (ever_published) WHERE ever_published;

CREATE TABLE IF NOT EXISTS studio_layouts (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  objective  TEXT,
  status     TEXT NOT NULL DEFAULT 'draft',
  record     JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row, id='brand'. Kept as a table rather than a settings blob so the override history
-- is queryable and a future per-brand row costs nothing.
CREATE TABLE IF NOT EXISTS studio_brand (
  id         TEXT PRIMARY KEY,
  record     JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS designs (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  record     JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS designs_updated_idx ON designs (updated_at DESC);
`;

// Idempotent: safe on every boot, and the single place the schema is declared.
function ready() {
  if (!enabled) return Promise.resolve(false);
  if (!_ready) {
    _ready = pool().query(SCHEMA).then(() => true).catch((e) => {
      _ready = null; // let a later request retry rather than pinning the failure forever
      throw e;
    });
  }
  return _ready;
}

async function query(text, params) {
  await ready();
  return pool().query(text, params);
}

async function close() {
  if (_pool) { const p = _pool; _pool = null; _ready = null; await p.end().catch(() => {}); }
}

// Surfaced on the health endpoint so a misconfigured DATABASE_URL is visible without
// reading logs.
async function health() {
  if (!enabled) return { backend: 'disk', ok: true };
  try {
    const r = await query('SELECT count(*)::int AS n FROM studio_components');
    return { backend: 'postgres', ok: true, components: r.rows[0].n };
  } catch (e) {
    return { backend: 'postgres', ok: false, error: e.message };
  }
}

module.exports = { enabled, query, ready, close, health, SCHEMA };

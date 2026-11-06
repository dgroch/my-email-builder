'use strict';
// Separate lazy pool: serving reports never runs application schema migrations.
const crypto = require('crypto');
const { validate, project } = require('./campaignResults');
const SCHEMA = `
CREATE TABLE IF NOT EXISTS campaign_results_snapshots (
 tenant_id text NOT NULL, hash text NOT NULL CHECK(hash ~ '^[a-f0-9]{64}$'),
 refreshed_at timestamptz NOT NULL, definition_id text NOT NULL, body text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,hash)
);
CREATE TABLE IF NOT EXISTS campaign_results_heads (
 tenant_id text PRIMARY KEY, hash text NOT NULL,
 FOREIGN KEY(tenant_id,hash) REFERENCES campaign_results_snapshots(tenant_id,hash)
);
CREATE OR REPLACE FUNCTION campaign_results_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Reporting snapshots are immutable'; END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='campaign_results_immutable' AND tgrelid='campaign_results_snapshots'::regclass) THEN
 CREATE TRIGGER campaign_results_immutable BEFORE UPDATE OR DELETE ON campaign_results_snapshots FOR EACH ROW EXECUTE FUNCTION campaign_results_immutable();
 END IF;
END $$;`;
let pool;
function connection(connectionString) {
 if (!connectionString) throw Error('Reporting database is not configured');
 const u = new URL(connectionString);
 // Do not allow URL sslmode options to override certificate verification.
 for (const key of ['sslmode','sslcert','sslkey','sslrootcert']) u.searchParams.delete(key);
 return { connectionString:u.href, ssl:['localhost','127.0.0.1','[::1]'].includes(u.hostname)?false:{rejectUnauthorized:true}, connectionTimeoutMillis:10000, max:2 };
}
function database() {
 if (!pool) { const {Pool}=require('pg'); pool=new Pool(connection(process.env.RESULTS_DATABASE_URL || process.env.DATABASE_URL)); pool.on('error',()=>{}); }
 return pool;
}
function encode(snapshot) {
 validate(snapshot); project(snapshot);
 const body=JSON.stringify(snapshot);
 return {body,hash:crypto.createHash('sha256').update(body).digest('hex')};
}
async function save(snapshot, db=database()) {
 const {body,hash}=encode(snapshot); const c=await db.connect();
 try {
  await c.query('BEGIN');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,258))',[snapshot.tenantId]);
  const old=(await c.query('SELECT s.hash,s.refreshed_at FROM campaign_results_heads h JOIN campaign_results_snapshots s USING(tenant_id,hash) WHERE h.tenant_id=$1',[snapshot.tenantId])).rows[0];
  if(old && (Date.parse(old.refreshed_at)>Date.parse(snapshot.refreshedAt) || (Date.parse(old.refreshed_at)===Date.parse(snapshot.refreshedAt) && old.hash!==hash))) throw Error('Reporting watermark cannot regress or conflict');
  await c.query('INSERT INTO campaign_results_snapshots(tenant_id,hash,refreshed_at,definition_id,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[snapshot.tenantId,hash,snapshot.refreshedAt,snapshot.definitionId,body]);
  await c.query('INSERT INTO campaign_results_heads VALUES($1,$2) ON CONFLICT(tenant_id) DO UPDATE SET hash=excluded.hash',[snapshot.tenantId,hash]);
  await c.query('COMMIT'); return {hash};
 } catch(e) {await c.query('ROLLBACK');throw e;} finally {c.release();}
}
async function read(tenant, db=database()) {
 if(!tenant)throw Error('Reporting tenant is not configured');
 const row=(await db.query('SELECT s.body,s.hash FROM campaign_results_heads h JOIN campaign_results_snapshots s USING(tenant_id,hash) WHERE h.tenant_id=$1',[tenant])).rows[0];
 if(!row)throw Error('Reporting snapshot unavailable');
 if(crypto.createHash('sha256').update(row.body).digest('hex')!==row.hash)throw Error('Reporting snapshot integrity failure');
 const s=validate(JSON.parse(row.body));if(s.tenantId!==tenant)throw Error('Reporting tenant mismatch');return s;
}
async function close(){if(pool){const p=pool;pool=null;await p.end();}}
module.exports={SCHEMA,connection,database,encode,save,read,close};

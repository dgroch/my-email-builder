'use strict';
// CEE 37c081a3: migrations 005,016,020,038,150. Reporting only.
// provider_id is the provider MESSAGE identity, not a contact/customer identity.
const STATUSES=['accepted','delivered','bounced','complained','suppressed'];
const stamp=v=>{if(v==null||!Number.isFinite(new Date(v).getTime()))throw Error('Invalid receipt timestamp');return new Date(v).toISOString();};
const binding=v=>{if(typeof v!=='string'||!v.length||v.length>300)throw Error('Invalid receipt binding');return v;};
const campaignId=(account,id)=>'provider-receipts:resend:'+encodeURIComponent(account)+':'+id;
const SQL=`WITH scoped AS (
 SELECT status,provider_id,occurred_at FROM provider_receipts
 WHERE tenant_id=$1 AND provider='resend' AND account=$2 AND broadcast_id=$3
 AND occurred_at <= $4::timestamptz AND received_at <= $4::timestamptz
), scopes AS (SELECT 'retained' AS scope UNION ALL SELECT 'window' WHERE $5::timestamptz IS NOT NULL),
 statuses AS (SELECT unnest(ARRAY['accepted','delivered','bounced','complained','suppressed']) AS status)
 SELECT scopes.scope,statuses.status,count(DISTINCT r.provider_id)::text AS messages,
 min(r.occurred_at) AS first_at,max(r.occurred_at) AS last_at
 FROM scopes CROSS JOIN statuses LEFT JOIN scoped r ON r.status=statuses.status
 AND (scopes.scope='retained' OR (r.occurred_at >= $5::timestamptz AND r.occurred_at < $6::timestamptz))
 GROUP BY scopes.scope,statuses.status ORDER BY scopes.scope,statuses.status`;
function validateReceipts(c,s){
 const p=c.providerReceipts;
 if(p.provider!=='resend'||p.coverage!=='observed'||!['exact','upper-bound'].includes(p.asOfPrecision)||!p.source||c.id!==campaignId(binding(p.account),binding(p.broadcastId)))throw Error('Invalid provider receipt contract');
 if(stamp(p.asOf)!==stamp(s.refreshedAt)||Date.parse(c.sentAt)>Date.parse(p.asOf)||c.sentAtBasis!=='First retained acceptance receipt'||c.subject!=null||c.previewHtml!=null||c.audienceSize!=null||c.test!=null||c.nativeObservations!=null||c.coverage.delivery!=='partial'||c.coverage.clicks!=='unavailable'||s.events.some(e=>e.campaignId===c.id))throw Error('Provider receipts cannot supply native metadata, identity or click evidence');
 function stats(rows,window){
  if(!Array.isArray(rows)||rows.length!==STATUSES.length||new Set(rows.map(r=>r.status)).size!==STATUSES.length)throw Error('Invalid receipt statuses');
  for(const r of rows){
   if(!STATUSES.includes(r.status)||(r.messages!==null&&(!Number.isSafeInteger(r.messages)||r.messages<0)))throw Error('Invalid receipt message count');
   for(const k of ['firstAt','lastAt'])if(r[k]!=null){const t=Date.parse(stamp(r[k]));if(!r.messages||t>Date.parse(p.asOf)||(window&&(t<Date.parse(window.from)||t>=Date.parse(window.to))))throw Error('Receipt timestamp outside coverage');}
   if(r.firstAt!=null&&r.lastAt!=null&&Date.parse(r.firstAt)>Date.parse(r.lastAt))throw Error('Invalid receipt timestamp order');
  }
 }
 stats(p.retained);
 const accepted=p.retained.find(r=>r.status==='accepted');
 if(!accepted.messages||stamp(accepted.firstAt)!==stamp(c.sentAt))throw Error('Missing observed acceptance anchor');
 if(p.window){if(Date.parse(stamp(p.window.from))>=Date.parse(stamp(p.window.to)))throw Error('Invalid receipt window');stats(p.window.statuses,p.window);for(const r of p.window.statuses){const total=p.retained.find(x=>x.status===r.status).messages;if(r.messages!=null&&total!=null&&r.messages>total)throw Error('Receipt window exceeds retained count');}}
}
function normaliseReceiptAggregate({tenantId,account,broadcastId,asOf,asOfPrecision='exact',source='CEE retained provider_receipts',retained,window=null}){
 const {VERSION,validate}=require('./campaignResults');binding(tenantId);binding(account);binding(broadcastId);
 const accepted=retained.find(r=>r.status==='accepted');
 const campaigns=accepted?.messages?[{id:campaignId(account,broadcastId),name:'Observed Resend broadcast '+broadcastId,sentAt:stamp(accepted.firstAt),sentAtBasis:'First retained acceptance receipt',subject:null,previewHtml:null,audienceSize:null,coverage:{delivery:'partial',clicks:'unavailable'},providerReceipts:{provider:'resend',account,broadcastId,coverage:'observed',asOf:stamp(asOf),asOfPrecision,source,retained,window},gaps:['Distinct provider messages per status, not unique recipients. Status populations may overlap and must not be summed. Observed retained receipts are not exhaustive provider totals.','Subject, content, audience, customer identity, configured launch time, test classification and native publication binding are unavailable.','Qualifying clicks and revenue are unavailable from receipts; no identity or purchase joins are inferred.']}]:[];
 return validate({schema:1,tenantId,definitionId:VERSION,refreshedAt:stamp(asOf),shopCurrency:'AUD',coverage:{orders:'unavailable',refunds:'unavailable'},campaigns,events:[],orders:[],gaps:['Provider-receipt-only reporting. No native publication or commerce reconciliation.']});
}
async function readProviderReceipts({db,tenantId,account,broadcastId,from,to}){
 if(!/^[a-f0-9-]{36}$/i.test(tenantId)||!binding(account)||!/^[a-f0-9-]{36}$/i.test(broadcastId))throw Error('Exact receipt tenant/account/broadcast binding required');
 if((from==null)!==(to==null))throw Error('Both receipt window bounds required');
 if(from!=null){from=stamp(from);to=stamp(to);if(Date.parse(from)>=Date.parse(to))throw Error('Invalid receipt window');}
 const c=await db.connect();try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
  await c.query("SET LOCAL statement_timeout='30s'");
  const asOf=stamp((await c.query('SELECT transaction_timestamp() AS at')).rows[0].at);
  const rows=(await c.query(SQL,[tenantId,account,broadcastId,asOf,from||null,to||null])).rows;
  const stats=scope=>rows.filter(r=>r.scope===scope).map(r=>({status:r.status,messages:Number(r.messages),firstAt:r.first_at==null?null:stamp(r.first_at),lastAt:r.last_at==null?null:stamp(r.last_at)}));
  const snapshot=normaliseReceiptAggregate({tenantId,account,broadcastId,asOf,retained:stats('retained'),window:from?{from,to,statuses:stats('window')}:null});
  await c.query('COMMIT');return snapshot;
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
module.exports={STATUSES,SQL,campaignId,validateReceipts,normaliseReceiptAggregate,readProviderReceipts};

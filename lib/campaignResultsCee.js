'use strict';
// Contract: deployed CEE 37c081a3 migrations 002,122,144,151,153,154.
// Reads retained facts only. No worker, provider request, receipt reconciliation or send.
const {VERSION,validate}=require('./campaignResults');
const SQL={
 publications:`SELECT p.id,p.campaign_id,p.account,c.name,r.content->>'subject' AS subject,r.content->>'html' AS html,
 (SELECT min(t.at) FROM (
 SELECT o.occurred_at AS at FROM broadcast_outcomes o
 JOIN broadcast_email_bindings b ON b.tenant_id=o.tenant_id AND b.account=o.account AND b.email_id=o.email_id AND b.publication_id=o.publication_id AND b.contact_id=o.contact_id
 JOIN broadcast_members m ON m.tenant_id=o.tenant_id AND m.publication_id=o.publication_id AND m.contact_id=o.contact_id
 WHERE o.tenant_id=p.tenant_id AND o.publication_id=p.id AND o.account=p.account AND o.status='accepted'
 UNION ALL SELECT o.sent_at FROM broadcast_operation_observations o JOIN broadcast_operation_attempts a ON a.tenant_id=o.tenant_id AND a.operation_id=o.operation_id
 WHERE a.tenant_id=p.tenant_id AND a.publication_id=p.id AND a.campaign_id=p.campaign_id AND a.provider_broadcast_id=p.provider_broadcast_id AND a.action='send' AND a.account=p.account AND o.account=p.account AND o.provider_broadcast_id=p.provider_broadcast_id AND o.status='sent'
 ) t) AS sent_at
 FROM broadcast_publications p JOIN campaigns c ON c.tenant_id=p.tenant_id AND c.id=p.campaign_id
 JOIN campaign_revisions r ON r.tenant_id=p.tenant_id AND r.id=p.revision_id WHERE p.tenant_id=$1 ORDER BY p.id`,
 outcomes:`SELECT o.event_id,o.email_id,o.publication_id,o.account,o.status,o.occurred_at,m.customer_id
 FROM broadcast_outcomes o JOIN broadcast_publications p ON p.tenant_id=o.tenant_id AND p.id=o.publication_id AND p.account=o.account
 JOIN broadcast_email_bindings b ON b.tenant_id=o.tenant_id AND b.account=o.account AND b.email_id=o.email_id AND b.publication_id=o.publication_id AND b.contact_id=o.contact_id
 JOIN broadcast_members m ON m.tenant_id=o.tenant_id AND m.publication_id=o.publication_id AND m.contact_id=o.contact_id
 JOIN customers c ON c.tenant_id=m.tenant_id AND c.id=m.customer_id AND c.deleted_at IS NULL AND c.merged_into IS NULL
 WHERE o.tenant_id=$1 ORDER BY o.account,o.event_id`,
 observations:`SELECT s.publication_id,s.event_type,count(DISTINCT m.contact_id)::int AS people,max(p.observed_at) AS observed_at
 FROM broadcast_recipient_matches m JOIN broadcast_recipient_scans s ON s.tenant_id=m.tenant_id AND s.id=m.scan_id AND s.publication_id=m.publication_id
 JOIN broadcast_recipient_pages p ON p.tenant_id=m.tenant_id AND p.scan_id=m.scan_id AND p.page_number=m.page_number
 JOIN broadcast_publications b ON b.tenant_id=s.tenant_id AND b.id=s.publication_id AND b.account=s.account
 JOIN broadcast_members bm ON bm.tenant_id=m.tenant_id AND bm.publication_id=m.publication_id AND bm.contact_id=m.contact_id
 JOIN customers c ON c.tenant_id=bm.tenant_id AND c.id=bm.customer_id AND c.deleted_at IS NULL AND c.merged_into IS NULL
 WHERE m.tenant_id=$1 GROUP BY s.publication_id,s.event_type ORDER BY s.publication_id,s.event_type`,
 identities:`SELECT s.external_id,s.customer_id FROM source_identities s JOIN customers c ON c.tenant_id=s.tenant_id AND c.id=s.customer_id WHERE s.tenant_id=$1 AND s.source_id=$2 AND c.deleted_at IS NULL AND c.merged_into IS NULL ORDER BY s.external_id`
};
const iso=v=>{const d=new Date(v);if(v==null||!Number.isFinite(d.getTime()))throw Error('Invalid CEE timestamp');return d.toISOString();};
const stable=v=>{if(typeof v!=='string'||!v.length||v.length>300)throw Error('Missing CEE identity');return v;};
function normalise(rows,{tenantId,refreshedAt}) {
 stable(tenantId);const campaigns=[],events=[],identityMap=Object.create(null),seen=new Set();
 for(const p of rows.publications){
  if(p.sent_at==null)continue; // Drafts and bulk acceptance are not sent facts.
  const id='cee:'+stable(p.id);if(seen.has(id))throw Error('Duplicate CEE publication');seen.add(id);
  const observations=rows.observations.filter(o=>o.publication_id===p.id).map(o=>{
   if(!['sent','delivered','opened','clicked','bounced','complained','unsubscribed','suppressed'].includes(o.event_type)||!Number.isSafeInteger(o.people)||o.people<0)throw Error('Invalid CEE observation');
   return {type:o.event_type,people:o.people,observedAt:iso(o.observed_at)};
  });
  campaigns.push({id,name:stable(p.name),sentAt:iso(p.sent_at),subject:p.subject||null,previewHtml:p.html||null,audienceSize:null,
   coverage:{delivery:'partial',clicks:'unavailable'},nativeObservations:observations,
   gaps:['Native recipient observations are directional, not event timestamps or message identities. Click bot classification and commerce-link evidence are unavailable.','Delivery receipts are observed facts, not complete delivery coverage. Test-send classification is not established; revenue attribution is unavailable.']});
  for(const o of rows.outcomes.filter(o=>o.publication_id===p.id)){
   if(o.account!==p.account)throw Error('CEE provider account mismatch');
   const type={accepted:'sent',delivered:'delivered',bounced:'bounced'}[o.status];if(!type)continue;
   events.push({id:'cee:'+stable(o.account)+':'+stable(o.event_id),messageId:'cee:'+o.account+':'+stable(o.email_id),campaignId:id,personId:'cee:'+stable(o.customer_id),type,at:iso(o.occurred_at)});
  }
 }
 for(const row of rows.identities){
  // Exact source identity, never destination/email equality or name/time matching.
  const m=/^gid:\/\/shopify\/Customer\/(\d+)$/.exec(row.external_id);if(!m)throw Error('Unsupported Shopify source identity');
  const person='cee:'+stable(row.customer_id);if(identityMap[m[1]]&&identityMap[m[1]]!==person)throw Error('Ambiguous Shopify identity');identityMap[m[1]]=person;
 }
 const snapshot=validate({schema:1,tenantId,definitionId:VERSION,refreshedAt:iso(refreshedAt),shopCurrency:'AUD',coverage:{orders:'unavailable',refunds:'unavailable'},campaigns,events,orders:[],gaps:['CEE native broadcasts only. Competing Klaviyo and individual-send click lineage has not been reconciled.']});
 return {snapshot,identityMap};
}
async function readCee({db,tenantId,shopifySourceId}){
 if(!/^[a-f0-9-]{36}$/i.test(tenantId)||!shopifySourceId)throw Error('CEE tenant and exact Shopify source binding required');
 const c=await db.connect();try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
  await c.query("SET LOCAL statement_timeout='30s'");
  const watermark=(await c.query('SELECT transaction_timestamp() AS at')).rows[0].at;
  const rows={};for(const key of Object.keys(SQL))rows[key]=(await c.query(SQL[key],key==='identities'?[tenantId,shopifySourceId]:[tenantId])).rows;
  const result=normalise(rows,{tenantId,refreshedAt:watermark});await c.query('COMMIT');return result;
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
module.exports={SQL,normalise,readCee};

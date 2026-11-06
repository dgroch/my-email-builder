'use strict';
// Manual read only; writes a private local candidate, never installs or schedules it.
const fs=require('fs');const path=require('path');const {Pool}=require('pg');const {connection}=require('../lib/campaignResultsStore');const {readCee}=require('../lib/campaignResultsCee');const {readOrders}=require('../lib/campaignResultsShopify');
(async()=>{let db;try{
 const [output,since]=process.argv.slice(2);if(!output||!path.isAbsolute(output)||process.argv.length>4)throw Error('Private absolute output required');
 db=new Pool(connection(process.env.CEE_REPORTING_DATABASE_URL));
 const {snapshot,identityMap}=await readCee({db,tenantId:process.env.RESULTS_TENANT_ID,shopifySourceId:process.env.CEE_SHOPIFY_SOURCE_ID});
 if(since){const delta=await readOrders({shop:process.env.SHOPIFY_STORE_DOMAIN,token:process.env.SHOPIFY_ADMIN_API_TOKEN,since,identityMap});snapshot.orders=delta.orders;snapshot.coverage.orders='partial';snapshot.coverage.refunds='partial';snapshot.gaps.push(delta.note);}
 fs.writeFileSync(output,JSON.stringify(snapshot,null,2)+'\n',{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({campaigns:snapshot.campaigns.length,events:snapshot.events.length,orders:snapshot.orders.length,qualifyingClickCoverage:'unavailable'}));
 }catch{console.error('CEE reporting read failed. Check read-only source binding, schema, identity source and private output. No snapshot installed.');process.exitCode=1;}finally{if(db)await db.end();}})();

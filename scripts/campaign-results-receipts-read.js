'use strict';
// Manual, read-only aggregate acquisition. No identities, provider calls or import.
const fs=require('fs'),path=require('path');const {Pool}=require('pg');
const {connection}=require('../lib/campaignResultsStore');const {readProviderReceipts}=require('../lib/campaignResultsReceipts');
(async()=>{let db;try{
 const [output,from,to]=process.argv.slice(2);if(!output||!path.isAbsolute(output)||process.argv.length>5)throw Error('Private absolute output required');
 db=new Pool(connection(process.env.CEE_REPORTING_DATABASE_URL));
 const snapshot=await readProviderReceipts({db,tenantId:process.env.RESULTS_TENANT_ID,account:process.env.CEE_RECEIPT_ACCOUNT,broadcastId:process.env.CEE_RECEIPT_BROADCAST_ID,from,to});
 fs.writeFileSync(output,JSON.stringify(snapshot,null,2)+'\n',{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({campaigns:snapshot.campaigns.length,coverage:'observed',revenue:'unavailable'}));
 }catch{console.error('Provider receipt read failed. Check exact source bindings, window and private output. No snapshot installed.');process.exitCode=1;}finally{if(db)await db.end();}})();

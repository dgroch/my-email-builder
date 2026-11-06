'use strict';
// Explicit operator command. Never invoked by server startup or page reads.
const fs=require('fs');const store=require('../lib/campaignResultsStore');
(async()=>{const [command,input]=process.argv.slice(2);try{
 if(command==='migrate'&&!input)await store.database().query(store.SCHEMA);
 else if(command==='import'&&input){const s=JSON.parse(fs.readFileSync(input,'utf8'));if(!process.env.RESULTS_TENANT_ID||s.tenantId!==process.env.RESULTS_TENANT_ID)throw Error('Tenant mismatch');console.log(JSON.stringify(await store.save(s)));}
 else throw Error('Usage: campaign-results-pg.js migrate | import PRIVATE_SNAPSHOT');
}catch{console.error('Reporting database command failed; configuration, tenant, schema and watermark must be valid.');process.exitCode=1;}finally{await store.close();}})();

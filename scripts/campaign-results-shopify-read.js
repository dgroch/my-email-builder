'use strict';
// Explicit operator read, never run by the web server. Output only to a protected file.
const fs=require('fs');const {readOrders}=require('../lib/campaignResultsShopify');
(async()=>{const [mapFile,since,out]=process.argv.slice(2);if(!mapFile||!since||!out)throw new Error('Usage: node scripts/campaign-results-shopify-read.js IDENTITY_MAP SINCE OUTPUT');const result=await readOrders({shop:process.env.SHOPIFY_STORE_DOMAIN,token:process.env.SHOPIFY_ADMIN_API_TOKEN,since,identityMap:JSON.parse(fs.readFileSync(mapFile,'utf8'))});fs.writeFileSync(out,JSON.stringify(result,null,2),{mode:0o600,flag:'wx'});console.log('Read-only Shopify delta written; coverage remains partial until reconciled.');})().catch(e=>{console.error(e.message);process.exitCode=1;});

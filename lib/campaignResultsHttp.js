'use strict';
const fs = require('fs/promises');
const { timingSafeEqual } = require('crypto');
const { project, DEFINITION } = require('./campaignResults');
function matches(header, secret) {
 if (!secret || secret.length<32 || typeof header!=='string') return false;
 const a=Buffer.from(header), b=Buffer.from('Bearer '+secret);
 return a.length===b.length&&timingSafeEqual(a,b);
}
async function handle(req,res,url) {
 if (!url.pathname.startsWith('/api/results')) return false;
 const reply=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));return true;};
 if(req.method!=='GET')return reply(405,{error:'Reporting is read-only'});
 if(process.env.RESULTS_VIEW_CREDENTIAL && process.env.RESULTS_VIEW_CREDENTIAL===process.env.RESULTS_EVIDENCE_CREDENTIAL)return reply(503,{error:'Reporting role configuration unavailable'});
 const evidence=matches(req.headers.authorization,process.env.RESULTS_EVIDENCE_CREDENTIAL);
 if(!evidence&&!matches(req.headers.authorization,process.env.RESULTS_VIEW_CREDENTIAL))return reply(401,{error:'Staff reporting access required'});
 const match=url.pathname.match(/^\/api\/results(?:\/([^/]+))?$/);if(!match)return reply(404,{error:'Not found'});
 for(const key of ['from','to']){const v=url.searchParams.get(key);if(v&&(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v))return reply(400,{error:'Invalid send date'});}
 if(url.searchParams.get('from')&&url.searchParams.get('to')&&url.searchParams.get('from')>url.searchParams.get('to'))return reply(400,{error:'Start date is after end date'});
 if(!['revenue','orders','efficiency'].includes(url.searchParams.get('sort')||'revenue'))return reply(400,{error:'Invalid sort'});
 if(!process.env.RESULTS_SNAPSHOT_FILE && !process.env.RESULTS_STORAGE)return reply(200,{definition:DEFINITION,trackingStatus:'Unavailable',lastSuccessfulRefresh:null,rows:[],error:'Reporting source is not connected',canViewEvidence:evidence});
 try {
  if(process.env.RESULTS_STORAGE && process.env.RESULTS_STORAGE!=='postgres')throw new Error('Unsupported results storage');
  const raw=process.env.RESULTS_STORAGE==='postgres' ? await require('./campaignResultsStore').read(process.env.RESULTS_TENANT_ID) : JSON.parse(await fs.readFile(process.env.RESULTS_SNAPSHOT_FILE,'utf8'));
  // This deployment's fixed tenant binding is never accepted from request input.
  if(!process.env.RESULTS_TENANT_ID||raw.tenantId!==process.env.RESULTS_TENANT_ID)throw new Error('Tenant binding mismatch');
  const report=project(raw,{from:url.searchParams.get('from'),to:url.searchParams.get('to'),sort:url.searchParams.get('sort')||'revenue'});
  const rows=report.rows.map(row=>{const {evidence:orders,previewHtml,...summary}=row;return {...summary,...match[1]?{previewHtml,...evidence?{evidence:orders}:{}}:{}};});
  if(match[1]){const row=rows.find(r=>r.id===decodeURIComponent(match[1]));if(!row)return reply(404,{error:'Campaign not found'});return reply(200,{...report,rows:undefined,campaign:row,canViewEvidence:evidence});}
  return reply(200,{...report,rows,canViewEvidence:evidence});
 }catch{return reply(503,{error:'Reporting refresh unavailable. No zero results inferred.',trackingStatus:'Unavailable',definition:DEFINITION,rows:[]});}
}
module.exports={handle};

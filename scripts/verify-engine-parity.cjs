'use strict';
// Generate representative, synthetic export compositions with the real frozen
// raster worker. No source account, saved customer campaign or network is used.
const fs=require('node:fs/promises');
const path=require('node:path');
const sharp=require('sharp');
const assembly=require('../lib/publishAssembly');
const render=require('../lib/render');
const klaviyo=require('../lib/klaviyo');
async function main(out){
 await fs.mkdir(out,{recursive:true});
 const png=await sharp({create:{width:300,height:120,channels:3,background:'#123456'}}).png().toBuffer();
 const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==','base64');
 const designs=[
  {id:'representative-rows',blocks:['hero','copy'],templates:{hero:'<tr><td><a href="https://figandbloom.com/collections/bouquets"><img src="https://cdn.shopify.com/fixture.png" width="600" height="240" alt="Fixture image"></a></td></tr>',copy:'<tr><td style="padding:24px;background:#eeeeee;font:18px Arial">Synthetic raster copy</td></tr>'}},
  {id:'representative-columns',columnBackground:'#e00000',blocks:['columns','copy'],templates:{columns:'<tr><td width="300" bgcolor="#e00000"><img src="https://cdn.shopify.com/fixture.gif" width="300" height="150" alt="Fixture animation"></td><td width="300" style="padding:24px;background:#e00000;font:18px Arial">Synthetic column copy<img src="https://cdn.shopify.com/fixture.png" width="150" height="60"></td></tr>',copy:'<tr><td style="padding:24px;background:#eeeeee;font:18px Arial">Synthetic raster copy</td></tr>'}},
 ];
 try{
 for(const spec of designs){
  const d={id:spec.id,updatedAt:'2026-10-13T00:00:00.000Z',name:spec.id,subjectLine:'Fixture subject',previewText:'Fixture preview',campaign:{blocks:[...spec.blocks.map(n=>({component:'blocks/'+n,tokens:{ALT:'Fixture image',URL:'https://figandbloom.com/collections/bouquets'}})),{component:'footer',tokens:{}}]}};
  const frozen=await assembly.freezeSavedDesign(d,{brand:{colours:{},baseline:{}},resolve:n=>({html:n==='footer'?'<tr><td>{% unsubscribe %}</td></tr>':spec.templates[n.replace('blocks/','')],version:1}),loadImage:async src=>src.endsWith('.gif')?gif:png});
  const exported=await assembly.renderFrozenArtifact(frozen,new AbortController().signal);
  const urls=new Map(exported.artifact.assets.map(a=>[a.id,'https://assets.figandbloom.com/campaign-assets/v1/'+a.sha256+'.'+({'image/png':'png','image/jpeg':'jpg','image/gif':'gif'}[a.mime])]));
  // The expected background is hand-derived from the source fixture, not the artifact.
  const rows=exported.artifact.rows.filter(r=>r.kind!=='legal_footer').map(r=>r.kind==='image'?klaviyo.imageRow(urls.get(r.assetId),{alt:r.alt,href:r.href}):r.kind==='columns'?klaviyo.columnRow(r.cells.map(c=>({url:urls.get(c.assetId),widthPx:c.width,pct:c.width/6,bg:spec.columnBackground})),{alt:r.cells[0].alt,href:r.cells[0].href}):r.html).join('');
  // Same neutral fixture wrapper; row composition remains the legacy publisher's.
  const html='<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}table{border-collapse:collapse}td{padding:0}.ew{width:100%;max-width:600px}img{max-width:100%}</style></head><body><table role="presentation" width="100%"><tr><td align="center"><table class="ew" width="600" cellpadding="0" cellspacing="0">'+rows+'</table></td></tr></table></body></html>';
  await fs.writeFile(path.join(out,spec.id+'.json'),JSON.stringify(exported));
  await fs.writeFile(path.join(out,spec.id+'.html'),html);
  console.log(JSON.stringify({designId:spec.id,artifactHash:exported.artifact.artifactHash,rows:exported.artifact.rows.map(r=>r.kind),assets:exported.artifact.assets.length}));
 }
 }finally{await render.closeBrowser();}
}
if(require.main===module)main(process.argv[2]).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={main};

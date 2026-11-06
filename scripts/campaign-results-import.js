'use strict';
// Explicit local import only. No scheduler and no HTTP writes.
const fs=require('fs');const path=require('path');const crypto=require('crypto');const {validate,project}=require('../lib/campaignResults');
const encode=s=>JSON.stringify(s,null,2)+'\n';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function importSnapshot(input,directory){
 const snapshot=validate(JSON.parse(fs.readFileSync(input,'utf8')));project(snapshot);
 fs.mkdirSync(directory,{recursive:true,mode:0o700});
 const lock=path.join(directory,'.import-lock'),deadline=Date.now()+5000;
 // Atomic directory creation serialises independent processes. Never steal a lock:
 // after a crashed writer, an operator must confirm it exited before removing it.
 while(true){try{fs.mkdirSync(lock,{mode:0o700});break;}catch(e){if(e.code!=='EEXIST')throw e;if(Date.now()>=deadline)throw Error('Reporting import locked');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}}
 const bytes=encode(snapshot),hash=digest(bytes),file=path.join(directory,'latest.json');let temp;
 try{
  let previous;
  try{previous=validate(JSON.parse(fs.readFileSync(file,'utf8')));project(previous);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(previous){
   if(previous.tenantId!==snapshot.tenantId)throw Error('Reporting tenant mismatch');
   const old=Date.parse(previous.refreshedAt),next=Date.parse(snapshot.refreshedAt);
   if(old>next || (old===next && digest(encode(previous))!==hash))throw Error('Reporting watermark cannot regress or conflict');
  }
  const archive=path.join(directory,hash+'.json');
  try{fs.writeFileSync(archive,bytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;if(fs.readFileSync(archive,'utf8')!==bytes)throw Error('Reporting archive integrity failure');}
  temp=path.join(directory,'.latest-'+crypto.randomUUID());fs.writeFileSync(temp,bytes,{flag:'wx',mode:0o600});fs.renameSync(temp,file);temp=null;
  return {hash,file};
 }finally{if(temp)fs.rmSync(temp,{force:true});fs.rmdirSync(lock);}
}
module.exports={importSnapshot};if(require.main===module){if(process.argv.length!==4)throw new Error('Usage: node scripts/campaign-results-import.js INPUT_JSON PRIVATE_DIRECTORY');console.log(JSON.stringify(importSnapshot(process.argv[2],process.argv[3])));}

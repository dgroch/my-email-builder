'use strict';
// Synthetic cross-population cases; timestamps remain inside acquisition/window bounds.
const fixture=require('./campaign-results-recovered-receipts');
const {STATUSES}=require('../../lib/campaignResultsReceipts');
function invalid(){
 const cases=[];
 for(const status of STATUSES)for(const endpoint of ['firstAt','lastAt'])for(const bound of ['firstAt','lastAt']){
  const s=fixture(),p=s.campaigns[0].providerReceipts;
  const total=p.retained.find(r=>r.status===status),subset=p.window.statuses.find(r=>r.status===status);
  Object.assign(total,{messages:10,firstAt:null,lastAt:null});
  Object.assign(subset,{messages:5,firstAt:null,lastAt:null});
  total[bound]=bound==='firstAt'?'2026-11-01T12:00:00Z':'2026-11-01T12:30:00Z';
  if(status==='accepted'){total.firstAt=total.firstAt||'2026-11-01T12:00:00Z';s.campaigns[0].sentAt=total.firstAt;}
  subset[endpoint]=bound==='firstAt'?'2026-11-01T11:59:59.999Z':'2026-11-01T12:30:00.001Z';
  cases.push({name:`${status}: window ${endpoint} outside retained ${bound}`,snapshot:s});
 }
 return cases;
}
function valid(){
 const cases=[fixture()];
 // Every combination of known/unknown endpoints, including both cross-end-only
 // pairs, equality and a genuinely narrower window population.
 for(let mask=0;mask<16;mask++)for(const equal of [false,true]){
  const s=fixture(),p=s.campaigns[0].providerReceipts;
  const total=p.retained.find(r=>r.status==='delivered'),subset=p.window.statuses.find(r=>r.status==='delivered');
  const times=equal?Array(4).fill('2026-11-01T12:00:00Z'):['2026-11-01T11:00:00Z','2026-11-01T12:30:00Z','2026-11-01T11:30:00Z','2026-11-01T12:00:00Z'];
  [total.firstAt,total.lastAt,subset.firstAt,subset.lastAt]=times.map((t,i)=>mask&(1<<i)?t:null);
  cases.push(s);
 }
 return cases;
}
module.exports={invalid,valid};

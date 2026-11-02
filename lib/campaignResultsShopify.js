'use strict';
// Read-only Shopify adapter. Only GET is possible; credentials never enter snapshots.
function minor(amount,currency){
 const digits=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;
 const value=String(amount);if(!new RegExp('^\\d+(?:\\.\\d{1,'+Math.max(1,digits)+'})?$').test(value))throw new Error('Invalid Shopify amount');
 const [whole,fraction='']=value.split('.');if(fraction.length>digits)throw new Error('Unsupported money precision');
 const result=Number(whole)*10**digits+Number(fraction.padEnd(digits,'0'));if(!Number.isSafeInteger(result))throw new Error('Unsafe Shopify amount');return result;
}
function normaliseOrder(order,transactions,identityMap){
 if (!['paid','refunded','partially_refunded'].includes(order.financial_status)) return null;
 const personId=identityMap[String(order.customer?.id)];if(!personId)return null; // no guessed recipient joins
 const paid=transactions.filter(t=>['sale','capture'].includes(t.kind)&&t.status==='success');
 if(!paid.length)return null;
 const currency=order.currency;
 if(transactions.some(t=>t.status==='success'&&t.currency&&t.currency!==currency))throw new Error('Transaction currency mismatch');
 const dedupe=list=>{const map=new Map();for(const t of list){if(!t.id)throw new Error('Missing Shopify transaction ID');const old=map.get(String(t.id));if(old&&JSON.stringify(old)!==JSON.stringify(t))throw new Error('Conflicting Shopify transaction');map.set(String(t.id),t);}return [...map.values()];};
 const captures=dedupe(paid);const paidMinor=captures.reduce((n,t)=>n+minor(t.amount,currency),0);
 if(!Number.isSafeInteger(paidMinor))throw new Error('Unsafe Shopify total');
 return {id:String(order.id),source:'shopify',personId,currency,paidMinor,paidAt:captures.map(t=>t.processed_at||t.created_at).sort().at(-1),status:'paid',test:!!order.test||captures.some(t=>t.test),cancelled:!!order.cancelled_at,refunds:dedupe(transactions.filter(t=>t.kind==='refund'&&t.status==='success')).map(t=>({id:String(t.id),amountMinor:minor(t.amount,currency),currency,status:'success',at:t.processed_at||t.created_at}))};
}
async function readOrders({shop,token,since,identityMap,fetchImpl=fetch}){
 if(!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)||!token||!Number.isFinite(Date.parse(since)))throw new Error('Invalid Shopify read binding');
 const base='https://'+shop+'/admin/api/2025-10/';let next=base+'orders.json?status=any&limit=250&updated_at_min='+encodeURIComponent(since);const result=[];let unmatched=0;const seen=new Set();
 async function get(url){const u=new URL(url);if(u.origin!=='https://'+shop||!u.pathname.startsWith('/admin/api/2025-10/'))throw new Error('Unsafe Shopify pagination');const r=await fetchImpl(u,{method:'GET',redirect:'error',headers:{'X-Shopify-Access-Token':token},signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error('Shopify read failed: HTTP '+r.status);return r;}
 while(next){if(seen.has(next))throw new Error('Shopify pagination cycle');seen.add(next);const r=await get(next);const data=await r.json();if(!Array.isArray(data.orders))throw new Error('Invalid Shopify orders response');
 for(const order of data.orders){const tx=await(await get(base+'orders/'+encodeURIComponent(order.id)+'/transactions.json')).json();if(!Array.isArray(tx.transactions))throw new Error('Missing Shopify transactions');const n=normaliseOrder(order,tx.transactions,identityMap);if(n)result.push(n);else unmatched++;}
 next=(r.headers.get('link')||'').split(',').map(s=>s.match(/<([^>]+)>;\s*rel="next"/)).find(Boolean)?.[1]||null;
 }
 return {orders:result,unmatchedOrders:unmatched,coverage:'partial',note:'Updated-since read is a delta, not a complete historical snapshot. Merge with retained orders by stable ID and retain explicit source coverage. Identity-unmatched purchases are not attributed.'};
}
module.exports={minor,normaliseOrder,readOrders};

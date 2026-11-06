'use strict';
// Pure reporting projection. No provider writes, timers or dispatch dependencies.
const VERSION = 'last-qualifying-click-7d-paid-total-v1-provisional';
const WINDOW = 7 * 86400000;
const DEFINITION = Object.freeze({ id: VERSION, status: 'Proposed, not yet agreed', attribution: 'Last verified non-bot email click in the inclusive seven days before payment. One campaign per order; opens never qualify. Equal-time clicks use the stable event ID as a deterministic tie-break.', revenue: 'Shopify successfully captured order total after discounts, including shipping and tax, less successful refunds of that total. Shop currency; currencies never combined. Test and cancelled orders excluded.', interpretation: 'Attributed revenue, not proven incremental revenue. Refunds can change closed-window results.' });
const time = x => { const n = Date.parse(x); if (!Number.isFinite(n)) throw new Error('Invalid reporting timestamp'); return n; };
function unique(rows, key) {
 const map = new Map();
 for (const row of rows) { const id = key(row); if (!id) throw new Error('Missing stable identifier'); const old = map.get(id); if (old && JSON.stringify(old) !== JSON.stringify(row)) throw new Error('Conflicting duplicate reporting record'); map.set(id, row); }
 return [...map.values()];
}
function validate(s) {
 if (s?.schema !== 1 || s.definitionId !== VERSION || !s.tenantId || !Array.isArray(s.campaigns) || !Array.isArray(s.events) || !Array.isArray(s.orders)) throw new Error('Unsupported reporting snapshot');
 time(s.refreshedAt); if (!s.coverage || !['complete','partial','unavailable'].includes(s.coverage.orders) || !['complete','partial','unavailable'].includes(s.coverage.refunds)) throw new Error('Missing order/refund coverage');
 for (const c of s.campaigns) { if (!c.id || !c.name || !c.coverage || !['complete','partial','unavailable'].includes(c.coverage.delivery) || !['complete','partial','unavailable'].includes(c.coverage.clicks)) throw new Error('Missing campaign coverage'); if(c.nativeObservations!=null && (!Array.isArray(c.nativeObservations)||c.nativeObservations.some(o=>!['sent','delivered','opened','clicked','bounced','complained','unsubscribed','suppressed'].includes(o.type)||!Number.isSafeInteger(o.people)||o.people<0||!Number.isFinite(Date.parse(o.observedAt)))))throw new Error('Invalid native observations'); if(c.providerReceipts)require('./campaignResultsReceipts').validateReceipts(c,s); time(c.sentAt); if (c.clickTrackingEndsAt) time(c.clickTrackingEndsAt); if (c.audienceSize != null && (!Number.isSafeInteger(c.audienceSize) || c.audienceSize < 0)) throw new Error('Invalid audience size'); }
 for (const e of s.events) { if (!e.id || !e.campaignId || !e.messageId || !e.personId || !['sent','delivered','bounced','unsubscribed','clicked','opened'].includes(e.type)) throw new Error('Invalid email event'); time(e.at); if (e.type === 'clicked' && !e.linkId) throw new Error('Missing stable link identifier'); }
 for (const o of s.orders) { if (!o.id || o.source !== 'shopify' || !o.personId || !/^[A-Z]{3}$/.test(o.currency) || !Number.isSafeInteger(o.paidMinor) || o.paidMinor < 0 || !Array.isArray(o.refunds)) throw new Error('Invalid Shopify money evidence'); time(o.paidAt); for (const r of o.refunds) { if (!r.id || !Number.isSafeInteger(r.amountMinor) || r.amountMinor < 0 || r.currency !== o.currency) throw new Error('Invalid refund evidence'); time(r.at); } }
 return s;
}
function project(input, { now = Date.now(), from, to, sort = 'revenue' } = {}) {
 const s = validate(input); const asOf = Math.min(now, time(s.refreshedAt));
 const campaigns = unique(s.campaigns, c => c.id).filter(c => !c.test && time(c.sentAt) <= asOf);
 const campaignMap = new Map(campaigns.map(c => [c.id,c]));
 const events = unique(s.events, e => e.id).filter(e => !e.test && campaignMap.has(e.campaignId) && time(e.at) <= asOf && time(e.at) >= time(campaignMap.get(e.campaignId).sentAt));
 // A test message remains excluded even if a later receipt omits its test flag.
 const testMessages = new Set(s.events.filter(e => e.test).map(e => e.messageId));
 const clean = events.filter(e => !testMessages.has(e.messageId));
 const clicks = clean.filter(e => e.type === 'clicked' && e.verified === true && e.bot === false && e.linkPurpose === 'commerce');
 for (const c of campaigns) if (c.clickTrackingEndsAt && clicks.some(e=>e.campaignId===c.id && time(e.at)>time(c.clickTrackingEndsAt))) throw new Error('Click exceeds declared tracking end');
 const orders = unique(s.orders, o => o.id).filter(o => !o.test && !o.cancelled && o.status === 'paid' && time(o.paidAt) <= asOf);
 const evidence = new Map(campaigns.map(c => [c.id, []]));
 for (const o of orders) {
  const at = time(o.paidAt); const matches = clicks.filter(e => e.personId === o.personId && time(e.at) <= at && time(e.at) >= at - WINDOW).sort((a,b) => time(b.at)-time(a.at) || a.id.localeCompare(b.id));
  if (!matches.length) continue;
  const click = matches[0]; const refunds = unique(o.refunds, r => r.id).filter(r => r.status === 'success' && time(r.at) <= asOf);
  const refundedMinor = refunds.reduce((n,r) => n+r.amountMinor,0);
  if (refundedMinor > o.paidMinor) throw new Error('Refund exceeds paid total');
  evidence.get(click.campaignId).push({ orderId:o.id, personId:o.personId, paidAt:o.paidAt, currency:o.currency, paidMinor:o.paidMinor, refundedMinor, revenueMinor:o.paidMinor-refundedMinor, clickId:click.id, clickedAt:click.at, linkId:click.linkId, messageId:click.messageId, refundIds:refunds.map(r=>r.id), definitionId:VERSION });
 }
 const rows = campaigns.map(c => {
  const activity=clean.filter(e=>e.campaignId===c.id); const attributed=evidence.get(c.id);
  const receipts=c.providerReceipts;
  const receiptCount=type=>Date.parse(receipts.asOf)<=asOf?receipts.retained.find(r=>r.status===(type==='sent'?'accepted':type))?.messages??null:null;
  const count=type=>receipts?receiptCount(type):c.coverage.delivery==='unavailable'?null:new Set(activity.filter(e=>e.type===type).map(e=>type==='unsubscribed'?e.personId:e.messageId)).size;
  const delivered=count('delivered'); const uniqueClickers=c.coverage.clicks==='unavailable'?null:new Set(clicks.filter(e=>e.campaignId===c.id).map(e=>e.personId)).size;
  // Attribution requires the competing campaigns' click coverage as well as this one's.
  const states=[s.coverage.orders,s.coverage.refunds,...campaigns.map(x=>x.coverage.clicks)];
  const unavailable=states.includes('unavailable'); const partial=states.some(x=>x!=='complete') || c.coverage.delivery!=='complete';
  const money={}; const timeline={};
  for(const o of attributed){ money[o.currency]=(money[o.currency]||0)+o.revenueMinor; const day=o.paidAt.slice(0,10); const k=day+':'+o.currency; const t=timeline[k] ||= {day,currency:o.currency,orders:0,revenueMinor:0};t.orders++;t.revenueMinor+=o.revenueMinor; }
  const purchasers=unavailable?null:new Set(attributed.map(o=>o.personId)).size;
  const currencies=Object.keys(money); const currency=currencies.length===1?currencies[0]:(!currencies.length?s.shopCurrency:null);
  const revenueMinor=unavailable?null:(currency?money[currency]||0:null);
  const trackingStatus=unavailable?'Unavailable':partial?'Partial coverage':'Complete coverage';
  const close=c.clickTrackingEndsAt?time(c.clickTrackingEndsAt)+WINDOW:null;
  const closed=close!==null && asOf>=close && !partial && !unavailable;
  return {id:c.id,name:c.name,sentAt:c.sentAt,audienceSize:c.audienceSize??null,subject:c.subject||null,sentAtBasis:c.sentAtBasis||null,providerReceipts:receipts&&Date.parse(receipts.asOf)<=asOf?receipts:null,nativeObservations:c.nativeObservations||null,previewHtml:c.previewHtml||null,sent:count('sent'),delivered,bounced:count('bounced'),complained:receipts?receiptCount('complained'):null,unsubscribed:count('unsubscribed'),uniqueClickers,clickRate:delivered&&uniqueClickers!==null?uniqueClickers/delivered:null,orders:unavailable?null:attributed.length,purchasers,purchaseConversionRate:delivered&&purchasers!==null?purchasers/delivered:null,clickToPurchaseRate:uniqueClickers&&purchasers!==null?purchasers/uniqueClickers:null,currency,revenueMinor,revenueByCurrency:unavailable?null:money,revenuePerDelivered:delivered&&revenueMinor!==null?revenueMinor/delivered:null,trackingStatus,gaps:[...(s.gaps||[]),...(c.gaps||[]),...states.includes('unavailable')?['Order, refund or competing campaign click coverage is unavailable.']:[]],lastUpdated:s.refreshedAt,windowStatus:closed?'Closed; later refunds may change results':'Provisional',windowClosesAt:close?new Date(close).toISOString():null,timeline:unavailable?null:Object.values(timeline).sort((a,b)=>a.day.localeCompare(b.day)),evidence:unavailable?[]:attributed};
 });
 let filtered=rows.filter(c=>(!from||c.sentAt.slice(0,10)>=from)&&(!to||c.sentAt.slice(0,10)<=to));
 const key={orders:'orders',revenue:'revenueMinor',efficiency:'revenuePerDelivered'}[sort];if(!key)throw new Error('Invalid sort');
 filtered.sort((a,b)=> key==='orders' ? (b[key]??-1)-(a[key]??-1)||a.id.localeCompare(b.id) : (a.currency||'').localeCompare(b.currency||'') || (b[key]??-1)-(a[key]??-1)||a.id.localeCompare(b.id));
 return {schema:1,definition:DEFINITION,lastSuccessfulRefresh:s.refreshedAt,delaySeconds:Math.max(0,Math.floor((now-time(s.refreshedAt))/1000)),refreshFailure:s.refreshFailure||null,rows:filtered};
}
module.exports={VERSION,DEFINITION,WINDOW,validate,project};

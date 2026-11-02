'use strict';
// Actual observed AGGREGATES only, not a synthetic event/identity ledger.
// Source: allowed-network-recovery.md, business-os#258, 2 Nov 2026 14:30–14:50 AEDT.
// 03:50Z is the documented read interval's upper bound, NOT an exact query watermark.
// Missing status counts/timestamp extrema remain null, never invented as zero.
const {normaliseReceiptAggregate,STATUSES}=require('../../lib/campaignResultsReceipts');
module.exports=()=>normaliseReceiptAggregate({
 tenantId:'7eb8e214-699a-43b8-84d3-9617f7af606f',account:'resend-figandbloom',broadcastId:'ef90b61c-bb72-45b9-a859-9c4382831026',
 asOf:'2026-11-02T03:50:00Z',asOfPrecision:'upper-bound',source:'Observed aggregate recovery report, business-os#258, 2 November 2026, 14:30–14:50 AEDT. Not a live import or exact read watermark.',
 retained:STATUSES.map(status=>({status,messages:({accepted:31245,delivered:31202,bounced:52,complained:3})[status]??null,
 firstAt:status==='accepted'?'2026-11-01T12:04:15.391Z':null,
 lastAt:({accepted:'2026-11-01T12:30:20.456Z',delivered:'2026-11-01T22:56:40.346Z',bounced:'2026-11-02T02:30:47.353Z'})[status]||null})),
 window:{from:'2026-10-31T13:00:00Z',to:'2026-11-01T13:00:00Z',statuses:STATUSES.map(status=>({status,messages:({accepted:31245,delivered:30548,bounced:34,complained:0})[status]??null,firstAt:status==='accepted'?'2026-11-01T12:04:15.391Z':null,lastAt:status==='accepted'?'2026-11-01T12:30:20.456Z':null}))}
});

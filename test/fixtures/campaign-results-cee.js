'use strict';
// Synthetic substitution of verified native columns. No live customer rows.
module.exports=()=>({
 publications:[{id:'publication-1',campaign_id:'campaign-1',account:'account-1',name:'Native contract replay',subject:'Synthetic native replay',html:'<p>Contract preview</p>',sent_at:'2026-10-01T00:00:00Z'},
 {id:'draft-1',campaign_id:'draft-1',account:'account-1',name:'Not sent',sent_at:null}],
 outcomes:[{event_id:'receipt-1',email_id:'email-1',publication_id:'publication-1',account:'account-1',status:'accepted',occurred_at:'2026-10-01T00:00:00Z',customer_id:'person-1'},
 {event_id:'receipt-2',email_id:'email-1',publication_id:'publication-1',account:'account-1',status:'delivered',occurred_at:'2026-10-01T00:01:00Z',customer_id:'person-1'}],
 observations:[{publication_id:'publication-1',event_type:'clicked',people:1,observed_at:'2026-10-02T00:00:00Z'}],
 identities:[{external_id:'gid://shopify/Customer/123',customer_id:'person-1'}]
});

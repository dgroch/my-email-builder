# Campaign Revenue Dashboard — Business Requirements and User Stories

## Business requirements

**Goal:** Give Daniel a clear view of which email campaigns generate orders and revenue, within **emails.figandbloom.com**.

**Success criteria:** Yesterday’s campaign is assessed for recoverable results, and future campaigns have consistent, auditable revenue reporting.

### 1. Campaign results overview

Add a **Results** section showing one row per campaign:

- Campaign name, send date and audience size.
- Sent, delivered, bounced and unsubscribed.
- Unique clickers and click rate.
- Attributed orders and revenue.
- Purchase conversion rate and revenue per delivered email.
- Tracking status and last updated time.

Users can filter by send date and sort by revenue, orders or revenue per delivered email. Metric labels must explain their denominators.

### 2. Individual campaign results

Clicking a campaign opens:

- Email preview and campaign details.
- Delivery and engagement metrics.
- Funnel: **delivered → unique clickers → purchasers**.
- Attributed orders and revenue over time.
- Order-level attribution evidence, accessible only to authorised staff.
- Visible tracking gaps and attribution-window status.

Revenue results remain **provisional** until the attribution window closes; later refunds may still change them.

### 3. Revenue attribution

**Proposed v1 rule, subject to agreement:**

- Attribute a purchase to the **most recent qualifying email click within seven days before purchase**.
- Count each order against only one email campaign.
- Do not attribute revenue based on opens.
- Use Shopify as the source of truth for paid orders and refunds.
- Display the currency and agreed revenue definition, including treatment of discounts, shipping, tax and refunds.
- Apply the same rules across campaigns, with the definition visible in the dashboard.

Recipient purchases without a qualifying click may be shown separately as **“recipient purchases—not attributed”**. They must not inflate campaign revenue.

This measures attributed revenue, not proven incremental revenue.

### 4. Tracking and data quality

- Every campaign and tracked link has a stable identifier.
- Email activity can be connected to purchases where evidence permits.
- Repeat events do not inflate totals.
- Test sends and test orders are excluded.
- Missing tracking displays **“Unavailable”** or **“Partial coverage”**, never a misleading zero.
- Show last successful data refresh and any reporting delay.
- Historical results retain the attribution definition used.

### 5. Recover yesterday’s campaign

- Inspect available send, click and Shopify order records.
- Recover attributed results where supporting evidence exists.
- Clearly state the available coverage and unrecoverable gaps.
- Do not infer campaign attribution solely because a recipient purchased after sending.

## User stories and acceptance criteria

| User story | Acceptance criteria |
|---|---|
| **As Daniel, I want to see which campaigns generated revenue**, so I can judge performance. | Results overview shows orders, revenue and revenue per delivered email, with clear tracking status. |
| **As Daniel, I want to compare campaigns fairly**, so audience size does not determine the apparent winner. | Campaigns show consistent conversion and revenue-efficiency metrics using the same definitions. |
| **As a marketer, I want to understand where customers drop out**, so I can improve targeting, creative and the purchase journey. | Campaign detail shows delivered, unique clickers and purchasers, with clearly labelled conversion rates. |
| **As Daniel, I want to trust the revenue number**, so I can use it for decisions. | Each attributed order has a qualifying click; overlapping campaigns cannot both claim it; totals reconcile to the agreed Shopify revenue definition. |
| **As a marketer, I want to know when tracking is incomplete**, so I do not mistake missing data for poor performance. | Partial coverage, missing data, refresh failures and provisional results are visibly distinguished from genuine zero results. |
| **As Daniel, I want results for yesterday’s send**, so the first campaign is not lost from reporting. | The campaign has either evidence-backed recovered results or an explicit explanation of what cannot be recovered. |

## MVP scope and definition of done

**Include:** Results overview, campaign detail, click-based attribution, Shopify revenue/refund reconciliation, tracking-health indicators and assessment of yesterday’s send.

**Defer:** Open-based attribution, multi-touch modelling, predictive lifetime value and cross-channel reporting.

**Done when:**

- An authorised user can view results inside emails.figandbloom.com.
- A verified click-to-purchase journey appears correctly.
- Duplicate events and overlapping campaign clicks do not double-count orders.
- Refunds update the reported revenue correctly.
- Missing tracking cannot masquerade as zero revenue.
- Yesterday’s campaign has a documented recovery outcome.
- Revenue definitions and attribution rules are agreed and visible.

**Scope boundary:** Reporting only—this build must not send campaigns or change existing sending behaviour.

'use strict';
// klaviyo.js — push an assembled campaign to Klaviyo as a *draft* email campaign.
// Zero-dependency: talks to the Klaviyo REST API over Node's built-in https.
//
// Flow (all draft, nothing is ever sent):
//   1. POST /api/templates/                       → create a CODE template from the HTML
//   2. POST /api/campaigns/                        → create the draft campaign (+ its message)
//   3. POST /api/campaign-message-assign-template/ → attach the template to the message
//
// Auth: a Klaviyo *private* API key with `campaigns:write` + `templates:write` scopes,
// supplied to the server as the KLAVIYO_API_KEY env var (never sent to the browser).

const https = require('https');

const HOST = 'a.klaviyo.com';
// Pin an API revision so payload shapes stay stable. Override with KLAVIYO_REVISION.
const REVISION = process.env.KLAVIYO_REVISION || '2026-04-15';

function request(method, apiPath, apiKey, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'Authorization': 'Klaviyo-API-Key ' + apiKey,
      'Accept': 'application/vnd.api+json',
      'revision': REVISION,
    };
    if (payload) {
      headers['Content-Type'] = 'application/vnd.api+json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request({ hostname: HOST, path: apiPath, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (_) { /* non-JSON error body */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        const detail = parsed && parsed.errors && parsed.errors[0] && (parsed.errors[0].detail || parsed.errors[0].title);
        reject(new Error(`Klaviyo ${method} ${apiPath} → ${res.statusCode}${detail ? ': ' + detail : ': ' + data.slice(0, 400)}`));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Create a draft email campaign in Klaviyo from already-assembled HTML.
// opts: { apiKey, listId, name, subject, previewText, fromEmail, fromLabel, replyToEmail, html }
async function createDraftCampaign(opts = {}) {
  const { apiKey, listId, name, subject, previewText, fromEmail, fromLabel, replyToEmail, html } = opts;
  if (!apiKey) throw new Error('KLAVIYO_API_KEY is not configured on the server.');
  if (!listId) throw new Error('A Klaviyo audience (list or segment ID) is required.');
  if (!fromEmail) throw new Error('A "from" email address is required.');
  if (!html) throw new Error('Nothing to push — assembled HTML is empty.');

  const campaignName = name || 'Untitled campaign';

  // 1. Template (raw HTML → CODE editor).
  const tpl = await request('POST', '/api/templates/', apiKey, {
    data: {
      type: 'template',
      attributes: {
        name: `${campaignName} (email builder ${new Date().toISOString().slice(0, 16).replace('T', ' ')})`,
        editor_type: 'CODE',
        html,
      },
    },
  });
  const templateId = tpl && tpl.data && tpl.data.id;
  if (!templateId) throw new Error('Klaviyo did not return a template id.');

  // 2. Draft campaign with a single email message. No send_strategy ⇒ stays a draft.
  const content = {
    subject: subject || campaignName,
    preview_text: previewText || '',
    from_email: fromEmail,
    from_label: fromLabel || fromEmail,
  };
  if (replyToEmail) content.reply_to_email = replyToEmail;

  const camp = await request('POST', '/api/campaigns/', apiKey, {
    data: {
      type: 'campaign',
      attributes: {
        name: campaignName,
        audiences: { included: [listId], excluded: [] },
        'campaign-messages': {
          data: [{
            type: 'campaign-message',
            attributes: { definition: { channel: 'email', label: campaignName, content } },
          }],
        },
      },
    },
  });
  const campaignId = camp && camp.data && camp.data.id;
  if (!campaignId) throw new Error('Klaviyo did not return a campaign id.');

  // Resolve the auto-created message id (from the create response, else fetch it).
  let messageId =
    camp.data.relationships &&
    camp.data.relationships['campaign-messages'] &&
    camp.data.relationships['campaign-messages'].data &&
    camp.data.relationships['campaign-messages'].data[0] &&
    camp.data.relationships['campaign-messages'].data[0].id;
  if (!messageId) {
    const msgs = await request('GET', `/api/campaigns/${campaignId}/campaign-messages/`, apiKey);
    messageId = msgs && msgs.data && msgs.data[0] && msgs.data[0].id;
  }
  if (!messageId) throw new Error('Could not resolve the campaign message id from Klaviyo.');

  // 3. Attach the template to the message so the draft opens with our HTML.
  await request('POST', '/api/campaign-message-assign-template/', apiKey, {
    data: {
      type: 'campaign-message',
      id: messageId,
      relationships: { template: { data: { type: 'template', id: templateId } } },
    },
  });

  return {
    campaignId,
    messageId,
    templateId,
    editUrl: `https://www.klaviyo.com/campaign/${campaignId}/edit`,
  };
}

module.exports = { createDraftCampaign, REVISION };

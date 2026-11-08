'use strict';
// providerTokens.js — template tokens that are resolved by the sending provider, not by the
// builder. They must survive assembly verbatim. Kept in one module so render.js and
// exportTargets.js cannot drift apart.
const PROVIDER_TOKENS = new Set(['RESEND_UNSUBSCRIBE_URL']);

module.exports = { PROVIDER_TOKENS };

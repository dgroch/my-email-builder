'use strict';
// Decode HTML entities before checking all Klaviyo/Liquid opening delimiters.
const { decodeHTML } = require('entities');
const MERGE_TAG_OPEN = /{{|{%|\{#/;
function decode(value) { return decodeHTML(String(value)); }
function hasMergeTags(value) { return MERGE_TAG_OPEN.test(decode(value)); }
// Builder placeholders use the same UPPER_SNAKE syntax as render.applyTokens.
function unresolvedBuilderTokens(value) {
  return [...new Set([...decode(value).matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map(m => m[1]))];
}
module.exports = { MERGE_TAG_OPEN, hasMergeTags, unresolvedBuilderTokens };

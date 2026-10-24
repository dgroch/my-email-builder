'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
test('600/390 browser geometry', async () => {
  const report = await require('../scripts/render-207-p2').verify({ screenshots:false });
  assert.equal(report.topLine390.oneLine,38);
  assert.equal(report.topLine390.twoLines,56);
});

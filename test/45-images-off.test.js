'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { Parser } = require('htmlparser2');
const { captureAssembly, ALT } = require('./helpers/45-assembly');
let captures;
before(async () => { ({ captures } = await captureAssembly()); });
function readable(style) {
  assert.match(style, /font-size:14px;/);
  assert.match(style, /line-height:normal;/);
  assert.match(style, /color:#444444;/);
  assert.match(style, /font-family:'NeuzeitGro','Gill Sans','Gill Sans MT',Calibri,sans-serif;/);
}
function assertAlt(html) {
  const stack = [], found = [];
  const parser = new Parser({
    onopentag(name, attrs) {
      const context = [...stack, { name, attrs }];
      if (name === 'img' && attrs.alt === ALT) {
        // Resolve the effective inline declarations along the ancestor chain.
        const effective = {};
        for (const el of context) for (const d of (el.attrs.style || '').split(';')) {
          const colon = d.indexOf(':');
          if (colon > 0) effective[d.slice(0, colon).trim()] = d.slice(colon + 1).trim();
        }
        readable(Object.entries(effective).map(([k,v]) => `${k}:${v};`).join(''));
        found.push(attrs);
      }
      stack.push({ name, attrs });
    },
    onclosetag() { stack.pop(); },
  });
  parser.write(html); parser.end();
  assert.ok(found.length, 'Final HTML lost HERO_IMAGE_ALT');
  assert.doesNotMatch(html, /alt="Pink roses & "/, 'Alt must be escaped');
}
for (const mode of ['direct', 'sliced', 'gif', 'columns', 'fallback']) {
  test(`final ${mode} email preserves readable HERO_IMAGE_ALT`, () => assertAlt(captures[mode]));
}
for (const mode of ['direct', 'fallback']) test(`final ${mode} MSO/VML branch preserves readable alt`, () => {
  const mso = captures[mode].match(/<!--\[if gte mso 9\]>([\s\S]*?)<!\[endif\]-->/);
  assert.ok(mso, 'Expected Outlook image branch in final email');
  const image = mso[1].match(/<v:image\b[\s\S]*?\/>/);
  assert.ok(image);
  assert.match(image[0], /alt="Pink roses in a seasonal bouquet"/);
  readable(image[0].match(/style="([^"]*)"/)[1]);
});
test('final sliced images also reach Outlook without a conditional exclusion', () => {
  const outlook = captures.sliced.replace(/<!--\[if !gte mso 9\]><!-->[\s\S]*?<!--<!\[endif\]-->/g, '');
  assertAlt(outlook);
});

test('final HTML and VML alt attributes escape quotes and ampersands', () => {
  assert.equal((captures.escaped.match(/alt="Pink roses &amp; &quot;seasonal&quot; blooms"/g) || []).length, 2);
});

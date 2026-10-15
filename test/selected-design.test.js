const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
process.env.DATA_DIR = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'selected-design-'));
const { selectedDesignHash } = require('../lib/campaignArtifact');
const design = { id:'fixture-design', name:'Fixture', updatedAt:'2026-10-15T00:00:00.000Z', subjectLine:'Subject', previewText:'Preview', campaign:{ blocks:[{component:'footer',tokens:{A:'a',B:'b'}}] } };
test('selected hash binds creative but ignores presentation metadata and key order', () => {
  assert.equal(typeof selectedDesignHash, 'function');
  const h = selectedDesignHash(design);
  assert.equal(h, "5ca25be6c7431ea03710d82fa9f24a7f5faed1ce0490133d872a3e4b8e967884");
  assert.equal(h, selectedDesignHash({...design, link:'https://example.test', resultNotes:'changed', campaign:{blocks:[{tokens:{B:'b',A:'a'},component:'footer'}]}}));
  for (const key of ['name','subjectLine','previewText','updatedAt','id']) assert.notEqual(h, selectedDesignHash({...design,[key]: 'changed'}));
  assert.notEqual(selectedDesignHash({...design,campaign:{blocks:[1,2]}}), selectedDesignHash({...design,campaign:{blocks:[2,1]}}));
});
test('same-timestamp changed design is rejected before freezing or reserving', async () => {
  const { createArtifactService } = require('../lib/publishArtifacts');
  let freezes = 0;
  const service = createArtifactService({binding:{tenantId:'selected-design',credential:'a'.repeat(40)}, getDesign:async()=>({...design,subjectLine:'Changed'}),freeze:async()=>{freezes++;throw Error('must not freeze')},render:async()=>{throw Error('must not render')}});
  const request={schema:1,requestId:'20000000-0000-4000-8000-000000000001',designId:design.id,expectedUpdatedAt:design.updatedAt,expectedDesignHash:require('../lib/campaignArtifact').hash({id:design.id,name:design.name,updatedAt:design.updatedAt,subjectLine:design.subjectLine,previewText:design.previewText,campaign:design.campaign})};
  await assert.rejects(service.start(request), /DESIGN_CHANGED/);
  assert.equal(freezes,0);
  for (const value of [undefined,'', 'x'.repeat(64)]) await assert.rejects(service.start({...request,expectedDesignHash:value}),/INVALID_EXPORT_REQUEST/);
});
after(async()=>require('../lib/db').close());

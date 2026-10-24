'use strict';
// Offline evidence: one cached Chrome, local artwork only; closed even on assertion failure.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const render = require('../lib/render');
const sample = require('../lib/sampleData');
const schema = require('../lib/parseTemplates').buildSchema(render.DS);
const { validateCampaign } = require('../lib/validate');
const localImage = fs.readFileSync(path.join(__dirname, '../test/fixtures/207-p2-photo.png'));
const imageUrl = 'data:image/png;base64,' + localImage.toString('base64');
const offlineHtml = html => html.replace(/(<img\b[^>]*\bsrc=")[^"]*/g, (_match,prefix) => prefix+imageUrl);
const OUT = process.env.EB207_RENDER_DIR || path.join(__dirname, '../render-out/eb207-p2');
function chromePath() {
  const puppeteer = require('puppeteer');
  let configured;
  try { configured = puppeteer.executablePath(); } catch (_) { /* packaged Puppeteer may lack a cache configuration */ }
  const cached = path.join(require('os').homedir(), '.cache/ms-playwright');
  const candidates = [process.env.CHROMIUM_PATH, configured, '/usr/bin/chromium', '/opt/google/chrome/chrome', '/opt/ungoogled-chromium/chrome',
    ...(fs.existsSync(cached) ? fs.readdirSync(cached).filter(n => /^chromium-/.test(n)).map(n => path.join(cached,n,'chrome-linux64/chrome')) : [])];
  const executable = candidates.find(p => p && fs.existsSync(p));
  if (!executable) throw new Error('Chrome not found; set CHROMIUM_PATH to a local Chrome executable.');
  return executable;
}
function historicalBlock(html) {
  return render.assemble({blocks:[{component:'evidence/baseline',tokens:{}}]}, {
    markBlocks:true,templateOverrides:{'evidence/baseline':html},
  }).html;
}
const campaign = name => sample.sampleCampaignFor(schema.components.find(c => c.name === name));
const copy = 'Flowers for your own table.\n\nA little colour for the week ahead.\n\n[Find your flowers](https://example.test/flowers).';
const notices = {
  oneLine: () => 'Flowers for the moments that matter',
  twoLines: width => width === 390
    ? 'Thoughtfully arranged flowers, delivered with care for the moments that matter.'
    : 'Thoughtfully arranged flowers, delivered with care for the moments that matter. A little colour and a handwritten note for someone you love.',
};
function afterCampaign(item, variant, width) {
  if (item === 10) {
    const c = campaign('heroes/hero-image-only');
    c.blocks.unshift({component:'sections/top-line', tokens:{TEXT:notices[variant](width)}});
    return c;
  }
  const c = campaign({1:'products/card-feature',2:'sections/text-band',4:'sections/body-copy-plain',8:'sections/body-copy-plain',9:'sections/full-width-image'}[item]);
  const t = c.blocks[0].tokens;
  if (item === 1) Object.assign(t,{TITLE:'For your own table',IMAGE_ALT:'Pink flowers in a ceramic vase',SUPER_LABEL:'THE COLOUR EDIT',LINK_LABEL:'Colourful, from $125',BODY_P1:'A little colour for the week ahead.',BODY_P2:'Arranged by hand, just for you.',LINK_ROW:'[Shop pink](https://example.test/pink) / [Shop white](https://example.test/white)'});
  if (item === 2) Object.assign(t,{HEADLINE:'Your own table',BODY_P1:'A little colour for the week ahead.',LINK_ROW:'[Shop pink](https://example.test/pink) / [Shop white](https://example.test/white)'});
  if (item === 4) Object.assign(t,{SUPER_LABEL:'',HEADLINE:'',BODY_P1:copy,BODY_P2:'',ALIGN:'left',MOBILE_ALIGN:'left',TOP_RULE:'off',PADDING_TOP:'24px',PADDING_BOTTOM:'24px',PADDING_X:'32px',MOBILE_PADDING_X:'24px'});
  if (item === 9) Object.assign(t,{PADDING_TOP:'24px',PADDING_BOTTOM:'24px'});
  if (item === 8) c.blocks.push({component:'footer',tokens:{}});
  return c;
}
function fixtures(write = true) {
  if(write)fs.mkdirSync(OUT,{recursive:true});
  const cases=[];
  for (const width of [600,390]) for (const item of [1,2,4,8,9,10]) for (const variant of item === 10 ? ['oneLine','twoLines'] : ['sample']) {
      const c = afterCampaign(item,variant,width);
      const validation = validateCampaign(c,schema,{requireUnsubscribe:item===8});
      assert.equal(validation.ok,true,JSON.stringify(validation.issues));
      const after = render.assemble(c,{markBlocks:true}).html;
      let before;
      if (item === 10) before = render.assemble({...c,blocks:c.blocks.slice(1)},{markBlocks:true}).html;
      else if (item === 8) before = after;
      else if (item === 4 || item === 9) {
        before = historicalBlock(require('../test/fixtures/207-p2-before-blocks.json').blocks[item].html);
      } else {
        const original = require('../test/fixtures/207-p2-baseline.json').find(b => b.component === (item === 1 ? 'products/card-live' : 'sections/body-copy-plain'));
        before = historicalBlock(original.html);
      }
      for (const phase of ['before','after']) {
        const html = offlineHtml(phase === 'after' ? after : before);
        const stem = `item-${item}-${variant}-${phase}-${width}`;
        if (write) fs.writeFileSync(path.join(OUT,stem+'.html'),html);
        cases.push({width,item,variant,phase,html,stem});
      }
    }
  return cases;
}
async function verify({screenshots=true}={}) {
  const cases=fixtures(screenshots);
  const report = {baseCommit:'575e1a4',assets:'Offline embedded local 4:5 placeholder; embedded brand fonts; all network requests intercepted.', captures:[],topLine390:{},changedExistingDefaultComponents:[]};
  const browser = await require('puppeteer').launch({executablePath:chromePath(),headless:true,pipe:true,args:['--no-sandbox','--disable-dev-shm-usage','--font-render-hinting=none']});
  try {
    for (const {width,item,variant,phase,html,stem} of cases.filter(c=>screenshots || c.phase==='after')) {
        const page = await browser.newPage();
        try {
          await page.setViewport({width,height:800,deviceScaleFactor:1});
          await page.setRequestInterception(true);
          page.on('request',r=>r.resourceType()==='image' ? r.respond({contentType:'image/png',body:localImage}) : r.url().startsWith('data:') ? r.continue() : r.abort());
          await page.setContent(html,{waitUntil:'load'});
          await page.evaluate(async()=>{
            // Image-only fixtures never trigger font loading through text layout.
            await document.fonts.load('12px NeuzeitGro');
            await document.fonts.ready;
          });
          const geometry = await page.evaluate(()=>{
            const b=document.querySelector('[data-eb-block="0"]');
            const td=b?.querySelector('td');
            const css=td && getComputedStyle(td);
            const copy=document.querySelector('.sp');
            const copyCss=copy && getComputedStyle(copy);
            const photo=document.querySelector('.cf-img img');
            return {documentWidth:document.documentElement.scrollWidth,blockHeight:b?.getBoundingClientRect().height,blockWidth:b?.getBoundingClientRect().width,paddingTop:css?.paddingTop,paddingBottom:css?.paddingBottom,textAlign:css?.textAlign,bodyCells:[...document.querySelectorAll('.bcp-left-24px td')].map(el=>getComputedStyle(el).textAlign),image:photo?{width:photo.getBoundingClientRect().width,height:photo.getBoundingClientRect().height}:null,copy:copyCss?{paddingTop:copyCss.paddingTop,paddingBottom:copyCss.paddingBottom,textAlign:copyCss.textAlign}:null,fontLoaded:document.fonts.check('12px NeuzeitGro')};
          });
          report.captures.push({stem,...geometry});
          if (phase==='after') {
            assert.ok(geometry.documentWidth<=width,`${stem}: horizontal overflow ${geometry.documentWidth}`);
            assert.ok(geometry.fontLoaded,`${stem}: brand font missing`);
            if (item===10) {
              assert.equal(geometry.blockHeight,variant==='oneLine'?38:56,`${stem}: notice height`);
              if(width===390) report.topLine390[variant]=geometry.blockHeight;
            }
            if(item===4){assert.equal(geometry.copy.textAlign,'left');assert.equal(geometry.copy.paddingTop,'24px');assert.equal(geometry.copy.paddingBottom,'24px');}
            if(item===2){assert.equal(geometry.copy.textAlign,'center');assert.equal(geometry.copy.paddingTop,'32px');}
            if(item===9) {assert.equal(geometry.paddingTop,width===600?'24px':'16px');assert.equal(geometry.paddingBottom,width===600?'24px':'16px');}
            if(item===4 && width===390) {assert.ok(geometry.bodyCells.length>0);assert.ok(geometry.bodyCells.every(align=>align==='left'));}
            if(item===1) {assert.ok(Math.abs(geometry.image.height/geometry.image.width-1.25)<0.01);if(width===600)assert.equal(geometry.image.width,280);}
          }
          if(screenshots)await page.screenshot({path:path.join(OUT,stem+'.png'),fullPage:true});
        } finally {await page.close();}
    }
    return report;
  } finally {
    await browser.close();
    if(screenshots)fs.writeFileSync(path.join(OUT,'visual-report.json'),JSON.stringify(report,null,2)+'\n');
  }
}
if(require.main===module && process.argv.includes('--html-only')) { fixtures(); console.log('HTML fixtures written to '+OUT); }
else if(require.main===module)verify().then(r=>console.log(JSON.stringify(r.topLine390))).catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={verify,fixtures};

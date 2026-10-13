'use strict';
// Browser simulations only. No result here is evidence of a received email client.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const render = require('../lib/render');
const dir = path.join(__dirname, '../docs/product-carousel');
const out = process.env.CAROUSEL_EVIDENCE_DIR || path.join(__dirname, '../render-out/carousel');
fs.mkdirSync(out, { recursive: true });
const read = name => fs.readFileSync(path.join(dir, name + '.html'), 'utf8');
const results = [];
async function measure(name, html, width, interaction = false) {
  const { page, cleanup, broken } = await render.openPage(html, { width: width - 40, scale: 1 });
  try {
    if (name.includes('dark-preference')) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    const metrics = await page.evaluate(() => {
      const r = document.querySelector('.fbc-products');
      const links = [...r.querySelectorAll('a')];
      return { viewport:innerWidth, documentWidth:document.documentElement.scrollWidth,
        regionWidth:r.clientWidth, regionScrollWidth:r.scrollWidth, scrollLeft:r.scrollLeft,
        display:getComputedStyle(r).display, overflowX:getComputedStyle(r).overflowX,
        cards:links.map(a=>({title:a.innerText,top:a.offsetTop,left:a.offsetLeft,width:a.getBoundingClientRect().width,
          name:a.textContent.trim(),alt:a.querySelector('img').alt,ratio:a.querySelector('img').getBoundingClientRect().height/a.querySelector('img').getBoundingClientRect().width})),
        collectionOutside:!r.contains(document.querySelector('[data-carousel-collection]')),
        hasScripts:document.scripts.length>0,hasIframes:!!document.querySelector('iframe'),
        darkPreference:matchMedia('(prefers-color-scheme: dark)').matches,
        cardTextColour:getComputedStyle(links[0]).color,cardBackground:getComputedStyle(links[0]).backgroundColor };
    });
    const entry = { name, browser:await page.browser().version(), ...metrics, brokenImages:broken.length };
    assert.equal(metrics.cards.length, 3, name + ': each product occurs once');
    assert.ok(metrics.cards.every(c => c.name && c.alt), name + ': accessible link names survive');
    assert.ok(metrics.collectionOutside && !metrics.hasScripts && !metrics.hasIframes);
    if (interaction) {
      const b = await page.$eval('.fbc-products', e=>{const r=e.getBoundingClientRect();return {x:r.x+60,y:r.y+60};});
      await page.mouse.move(b.x,b.y);
      await page.mouse.wheel({ deltaX: 400, deltaY:0 });
      await page.waitForFunction(() => document.querySelector('.fbc-products').scrollLeft > 0, { timeout:3000 });
      entry.scrollAfterWheel = await page.$eval('.fbc-products',e=>e.scrollLeft);
      await page.focus('.fbc-products');
      const keyboardOrder=[];
      for (let i=0;i<3;i++) { await page.keyboard.press('Tab'); keyboardOrder.push(await page.evaluate(()=>document.activeElement.textContent.trim())); }
      entry.keyboardOrder=keyboardOrder;
      entry.scrollAfterTabbing=await page.$eval('.fbc-products',e=>e.scrollLeft);
      assert.ok(entry.scrollAfterWheel>0 && keyboardOrder[2].includes('Cocoon'));
    }
    entry.pageOverflow = metrics.documentWidth > width;
    await page.screenshot({path:path.join(out,name+'-'+width+'.png'),fullPage:true});
    results.push(entry);
  } finally { await cleanup(); }
}
(async()=>{
  try {
    for (const width of [320,375,600]) {
      await measure('fallback',read('fallback'),width);
      await measure('candidate-browser-only',read('candidate-test-only'),width,true);
    }
    await measure('images-unavailable',read('fallback').replace(/src="[^"]*"/g,'src="data:image/png;base64,"'),375);
    await measure('long-product-name',read('fallback').replace('Cloud Vase Icy Pink (XL)', 'A sculptural ceramic vase with a softly rounded profile and a very long product name for testing narrow mobile reading sizes'),320);
    await measure('style-blocks-stripped',read('fallback').replace(/<style\b[^>]*>[\s\S]*?<\/style>/g,''),375);
    await measure('partial-overflow-stripped',read('candidate-test-only').replace(/overflow-x:auto!important;/g,''),375);
    await measure('klaviyo-stored-candidate',read('klaviyo-stored-candidate'),375);
    const dark=read('fallback').replace('</head>', '<style>body{color-scheme:dark} .fbc-card,.fbc-card span{font-family:Arial,sans-serif!important}</style></head>');
    await measure('fallback-fonts-dark-preference-simulation',dark,375);
    fs.writeFileSync(path.join(dir,'browser-evidence.json'),JSON.stringify({classification:'Browser simulations, not email-client verification',generatedAt:new Date().toISOString(),results},null,2)+'\n');
    console.log(JSON.stringify(results.map(r=>({name:r.name,width:r.viewport,overflow:r.pageOverflow,wheel:r.scrollAfterWheel,brokenImages:r.brokenImages})),null,2));
  } finally { await render.closeBrowser(); }
})().catch(e=>{console.error(e);process.exitCode=1;});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const puppeteerPath = require.resolve('puppeteer');
const renderPath = require.resolve('../lib/render');
async function fixture(work) {
  const previous = require.cache[puppeteerPath];
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const browsers = [];
  require.cache[puppeteerPath] = { exports: { launch: async () => {
    const browser = { connected: true, closes: 0,
      newPage: async () => ({ setViewport: async () => {}, goto: async () => {},
        evaluate: async fn => String(fn).includes('scrollHeight') ? 100 : [], close: async () => {} }),
      close: async () => { browser.closes++; browser.connected = false; },
    };
    browsers.push(browser);
    await ready;
    return browser;
  } } };
  delete require.cache[renderPath];
  const render = require('../lib/render');
  try { await work({ render, browsers, release }); }
  finally {
    release();
    await render.closeBrowser();
    delete require.cache[renderPath];
    if (previous) require.cache[puppeteerPath] = previous;
    else delete require.cache[puppeteerPath];
  }
}
test('concurrent raster requests share one pending browser launch and cleanup closes it', async () => {
  await fixture(async ({render,browsers,release}) => {
    const pages = [render.openPage('<html></html>'),render.openPage('<html></html>')];
    await new Promise(setImmediate);
    release();
    const opened = await Promise.all(pages);
    await Promise.all(opened.map(page => page.cleanup()));
    await render.closeBrowser();
    assert.equal(browsers.length,1);
    assert.equal(browsers[0].closes,1);
  });
});
test('cleanup waits for an in-flight launch instead of orphaning its browser', async () => {
  await fixture(async ({render,browsers,release}) => {
    const page = render.openPage('<html></html>');
    await new Promise(setImmediate);
    const closing = render.closeBrowser();
    release();
    const opened = await page;
    await opened.cleanup();
    await closing;
    assert.equal(browsers.length,1);
    assert.equal(browsers[0].closes,1);
  });
});
test('cleanup closes a pending replacement after the previous browser disconnected', async () => {
  await fixture(async ({render,browsers,release}) => {
    const first = render.openPage('<html></html>');
    release();
    await (await first).cleanup();
    browsers[0].connected = false;
    const replacement = render.openPage('<html></html>');
    const closing = render.closeBrowser();
    await (await replacement).cleanup();
    await closing;
    assert.equal(browsers.length,2);
    assert.equal(browsers[1].closes,1);
  });
});

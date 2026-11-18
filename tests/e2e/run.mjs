import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.resolve(HERE, '../..');
const OUT = path.join(HERE, 'out');
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? 'http://100.64.114.83:8891/v1';
const KANA = /[ぁ-ヿ]/;
const JAPANESE = /[ぁ-ヿ一-鿿]/;
const TIMEOUT = 60_000;
const TAG_TEXT = /<\/?g\b/;

const fixture = fs.readFileSync(path.join(HERE, 'fixture.html'));
const server = http.createServer((req, res) => {
  const known = req.url === '/page' || req.url === '/reference';
  res.writeHead(known ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(known ? fixture : 'not found');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const PAGE_URL = `${ORIGIN}/page`;

fs.mkdirSync(OUT, { recursive: true });
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plamo-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: !process.env.HEADED,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`);
  }
}

const textOf = (page, selector) => page.locator(selector).evaluate((el) => el.textContent.replace(/\s+/g, ' ').trim());
const waitTranslated = (page) =>
  page.locator('plamo-translator-ui .status .label', { hasText: /^翻訳済み$/ }).waitFor({ timeout: TIMEOUT });
const hrefsById = (page) => page.$$eval('a', (as) => as.map((a) => [a.id, a.getAttribute('href')]));

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  const toggleFixturePage = () =>
    worker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      return chrome.tabs.sendMessage(tab.id, { type: 'toggle-page' });
    }, PAGE_URL);

  await check('options page saves settings and the connection test succeeds', async () => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
    await options.fill('input[name=baseUrl]', LLM_BASE_URL);
    await options.click('#fetch-models');
    await options.locator('#message.ok').waitFor({ timeout: TIMEOUT });
    assert.notEqual(await options.inputValue('input[name=model]'), '', 'model filled from /models');
    await options.uncheck('input[name=autoTranslate]');
    await options.click('button[type=submit]');
    await options.locator('#message', { hasText: '保存しました' }).waitFor();
    await options.click('#test');
    await options.locator('#message', { hasText: /成功|失敗/ }).waitFor({ timeout: TIMEOUT });
    const message = await options.textContent('#message');
    assert.match(message, /成功/, message);
    assert.match(message.split('→')[1] ?? '', KANA, 'connection test returns Japanese');
    const stored = await worker.evaluate(() => chrome.storage.sync.get(null));
    assert.equal(stored.baseUrl, LLM_BASE_URL.replace(/\/+$/, ''));
    await options.close();
  });

  const reference = await context.newPage();
  await reference.goto(`${ORIGIN}/reference`);
  await reference.locator('#late').waitFor();
  const original = await reference.evaluate(() => ({ title: document.title, body: document.body.innerHTML }));

  const page = await context.newPage();
  await page.goto(PAGE_URL);
  const before = {
    preText: await page.textContent('#code-block'),
    noTranslate: await page.textContent('#no-translate'),
    japanese: await page.textContent('#japanese'),
    hrefs: new Map(await hrefsById(page)),
  };
  await toggleFixturePage();

  await check('page translation turns English paragraphs into Japanese', async () => {
    await page.waitForFunction(() => /[ぁ-ヿ]/.test(document.getElementById('late')?.textContent), null, {
      timeout: TIMEOUT,
    });
    await waitTranslated(page);
    for (const id of ['#heading', '#intro', '#plain', '#broken-tags', '#nested', '#nested-format', '#with-code']) {
      const text = await textOf(page, id);
      assert.match(text, KANA, `${id}: ${text}`);
    }
    assert.notEqual(await page.title(), original.title, 'document.title is translated');
  });

  await check('links keep their href and inline code stays as written', async () => {
    for (const [id, href] of await hrefsById(page)) assert.equal(href, before.hrefs.get(id), `#${id} href`);
    assert.match(await textOf(page, '#doc-link'), JAPANESE, 'link text is translated in place');
    assert.match(await textOf(page, '#intro strong'), JAPANESE, 'bold text is translated');
    assert.equal(await textOf(page, '#with-code code'), 'npm install rivers');
  });

  await check('sentences whose tags the model breaks still read as Japanese', async () => {
    for (const id of ['#broken-tags', '#nested']) {
      console.log(`     ${id}: ${await page.locator(id).innerHTML()}`);
      assert.match(await textOf(page, id), KANA, id);
      for (const link of await page.locator(`${id} a`).all()) {
        assert.match(await link.textContent(), JAPANESE, `${id} link text`);
      }
    }
  });

  await check('no tag marks show up as text', async () => {
    const text = await page.evaluate(() => document.body.innerText);
    assert.doesNotMatch(text, TAG_TEXT);
  });

  await check('a paragraph inside a closed details is translated once opened', async () => {
    await page.evaluate(() => (document.getElementById('more').open = true));
    await page.waitForFunction(() => /[ぁ-ヿ]/.test(document.getElementById('hidden').textContent), null, {
      timeout: TIMEOUT,
    });
    await page.evaluate(() => (document.getElementById('more').open = false));
  });

  await check('after scrolling to the bottom, paragraphs in view are translated first', async () => {
    await page.evaluate(() => {
      window.translatedOrder = [];
      window.orderObserver = new MutationObserver((records) => {
        for (const { target } of records) {
          if (target.id?.startsWith('long-') && !translatedOrder.includes(target.id)) translatedOrder.push(target.id);
        }
      });
      orderObserver.observe(document.getElementById('long'), { childList: true, subtree: true });
      window.scrollTo(0, document.body.scrollHeight);
    });
    const started = Date.now();
    await page.waitForFunction(() => /[ぁ-ヿ]/.test(document.getElementById('long-60').textContent), null, {
      timeout: 10_000,
    });
    console.log(`     #long-60 translated after ${((Date.now() - started) / 1000).toFixed(1)} s`);
    await waitTranslated(page);
    const { order, inView } = await page.evaluate(() => {
      orderObserver.disconnect();
      const visible = (p) => p.getBoundingClientRect().bottom > 0 && p.getBoundingClientRect().top < innerHeight;
      return { order: translatedOrder, inView: [...document.querySelectorAll('#long p')].filter(visible).map((p) => p.id) };
    });
    assert.ok(inView.includes(order[0]), `first translated ${order[0]}, in view ${inView.join(' ')}`);
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), TAG_TEXT);
    await page.screenshot({ path: path.join(OUT, 'page-scrolled.png') });
    await page.evaluate(() => window.scrollTo(0, 0));
  });

  await check('formatting-only sentences come out as Japanese text', async () => {
    console.log(`     #nested-format: ${await page.locator('#nested-format').innerHTML()}`);
    assert.match(await textOf(page, '#nested-format'), KANA);
  });

  await check('pre, translate="no" and Japanese text are untouched', async () => {
    assert.equal(await page.textContent('#code-block'), before.preText);
    assert.equal(await page.textContent('#no-translate'), before.noTranslate);
    assert.equal(await page.textContent('#japanese'), before.japanese);
  });

  await check('content added after load is translated', async () => {
    const text = await textOf(page, '#late');
    assert.match(text, KANA, text);
  });

  await page.screenshot({ path: path.join(OUT, 'page-translated.png') });

  await check('restore brings back the exact original page', async () => {
    await page.locator('plamo-translator-ui .status button.restore').click();
    await page.waitForFunction(() => document.querySelector('plamo-translator-ui').shadowRoot.querySelector('.status').hidden);
    const restored = await page.evaluate(() => ({ title: document.title, body: document.body.innerHTML }));
    assert.equal(restored.title, original.title);
    assert.equal(restored.body, original.body);
  });

  await check('selecting text shows the button and the card shows Japanese', async () => {
    await reference.bringToFront();
    await reference.click('#plain', { clickCount: 3 });
    const trigger = reference.locator('plamo-translator-ui .trigger');
    await trigger.waitFor({ state: 'visible' });
    const box = await trigger.boundingBox();
    const clip = { x: Math.max(0, box.x - 160), y: Math.max(0, box.y - 60), width: 220, height: 110 };
    await reference.screenshot({ path: path.join(OUT, 'selection-button.png'), clip });
    await reference.emulateMedia({ colorScheme: 'dark' });
    await reference.screenshot({ path: path.join(OUT, 'selection-button-dark.png'), clip });
    await reference.emulateMedia({ colorScheme: 'light' });
    await trigger.click();
    const body = reference.locator('plamo-translator-ui .card .body:not(.loading)');
    await body.waitFor({ timeout: TIMEOUT });
    const text = await body.textContent();
    assert.match(text, KANA, text);
    assert.equal(await reference.locator('plamo-translator-ui .card footer button').textContent(), 'コピー');
    await reference.screenshot({ path: path.join(OUT, 'selection-card.png') });
    await reference.emulateMedia({ colorScheme: 'dark' });
    await reference.screenshot({ path: path.join(OUT, 'selection-card-dark.png') });
    await reference.emulateMedia({ colorScheme: 'light' });
  });

  await check('Escape closes the card', async () => {
    await reference.keyboard.press('Escape');
    await reference.locator('plamo-translator-ui .card').waitFor({ state: 'hidden' });
  });
} finally {
  await context.close();
  server.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed. Screenshots: ${OUT}`);
process.exit(failed ? 1 : 0);

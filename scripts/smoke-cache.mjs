// Persistent-cache regression with a local OpenAI-compatible stub; no real LLM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const extension = path.resolve(import.meta.dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'plamo-cache-'));
const paragraphs = [
  'This is the first English paragraph about a persistent translation cache.',
  'This is the second English paragraph about revisiting an interesting article.',
  'This is the third English paragraph which will remain unchanged during this test.',
];
const changed = 'This is an updated second paragraph with new information for the reader.';
const title = 'Persistent cache fixture';
const translation = 'これはキャッシュ検証用の日本語訳です。';
const requests = [];
let updated = false;
const server = http.createServer(async (req, res) => {
  if (req.url === '/v1/chat/completions') {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body).messages[0].content);
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ choices: [{ message: { content: translation } }] }));
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="en"><head><title>${title}</title></head><body>${
    paragraphs.map((text, i) => `<p id="p${i}">${updated && i === 1 ? changed : text}</p>`).join('')
  }</body></html>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.CHROMIUM_PATH
  ?? (fs.existsSync(chromium.executablePath()) ? chromium.executablePath() : '/opt/meta-chromium/chrome');
let context;
let worker;
let options;
let page;
async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--no-sandbox', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const id = new URL(worker.url()).host;
  options = await context.newPage();
  await options.goto(`chrome-extension://${id}/src/options/options.html`);
  await options.waitForFunction(() => !!document.querySelector('[name=baseUrl]')?.value);
}
const send = (message) => options.evaluate((message) => chrome.runtime.sendMessage(message), message);
const tabMessage = (type, text) => worker.evaluate(async ({ url, type, text }) => {
  const [tab] = await chrome.tabs.query({ url });
  return chrome.tabs.sendMessage(tab.id, { type, text });
}, { url: page.url(), type, text });
async function save() {
  await options.click('[type=submit]');
  await options.locator('#message.ok', { hasText: '保存しました' }).waitFor();
}
async function translated() {
  await page.locator('plamo-translator-ui .status .label', { hasText: /^翻訳済み$/ }).waitFor();
  for (let i = 0; i < 3; i++) assert.equal(await page.textContent(`#p${i}`), translation);
  assert.equal(await page.title(), translation);
}
async function manualPass({ reload = true } = {}) {
  if (reload) await page.reload();
  await page.locator('plamo-translator-ui').waitFor({ state: 'attached' });
  await tabMessage('toggle-page');
  await translated();
}

try {
  await launch();
  await options.fill('[name=baseUrl]', `${origin}/v1`);
  await options.fill('[name=model]', 'mock-cache-model');
  await options.uncheck('[name=autoTranslate]');
  assert.equal(await options.isChecked('[name=cacheEnabled]'), true);
  await save();
  page = await context.newPage();
  await page.goto(`${origin}/fixture`);
  await manualPass({ reload: false });
  assert.deepEqual([...requests].sort(), [...paragraphs, title].sort());
  assert.equal((await send({ type: 'translation-cache', operation: 'status' })).count, 4);
  console.log('PASS initial page: 4 engine requests (3 paragraphs + title)');

  requests.length = 0;
  await manualPass();
  assert.equal(requests.length, 0);
  console.log('PASS reload and translate: ZERO engine requests');

  await context.close();
  await launch();
  page = await context.newPage();
  await page.goto(`${origin}/fixture`);
  await manualPass({ reload: false });
  assert.equal(requests.length, 0);
  console.log('PASS full browser restart with same profile: ZERO engine requests');

  updated = true;
  await manualPass();
  assert.deepEqual(requests, [changed]);
  console.log('PASS changed paragraph at same URL: exactly 1 engine request; unchanged segments hit');

  requests.length = 0;
  await tabMessage('translate-selection', paragraphs[0]);
  await page.locator('plamo-translator-ui .card .body', { hasText: translation }).waitFor();
  assert.equal(requests.length, 0);
  console.log('PASS selection shares the persistent segment cache: ZERO engine requests');

  await options.uncheck('[name=cacheEnabled]');
  await save();
  for (let i = 0; i < 2; i++) {
    requests.length = 0;
    await manualPass();
    assert.deepEqual([...requests].sort(), [paragraphs[0], changed, paragraphs[2], title].sort());
  }
  assert.equal((await send({ type: 'translation-cache', operation: 'status' })).count, 5);
  console.log('PASS cache disabled: all 4 engine requests on each reload, store unchanged');

  await options.check('[name=cacheEnabled]');
  await options.check('[name=autoTranslate]');
  await save();
  requests.length = 0;
  await page.reload();
  await translated();
  assert.equal(requests.length, 0);
  console.log('PASS automatic translation also uses cached segments: ZERO engine requests');

  await options.reload();
  await options.locator('#cache-status', { hasText: '保存済み: 5 件' }).waitFor();
  options.once('dialog', (dialog) => dialog.dismiss());
  await options.click('#clear-cache');
  assert.equal((await send({ type: 'translation-cache', operation: 'status' })).count, 5);
  options.once('dialog', (dialog) => dialog.accept());
  await options.click('#clear-cache');
  await options.locator('#cache-status', { hasText: '保存済み: 0 件' }).waitFor();
  requests.length = 0;
  await page.reload();
  await translated();
  assert.equal(requests.length, 4);
  console.log('PASS options count, cancel/confirm clear, and engine requests after clear');

  // Check the production 20,000-entry cap and real IndexedDB LRU index in Chrome.
  await send({ type: 'translation-cache', operation: 'clear' });
  await options.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('plamo-translate-cache', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('segments', 'readwrite');
      for (let i = 0; i < 20_000; i++) {
        tx.objectStore('segments').put({ text: `old ${i}`, translation: '古い訳', targetLang: 'ja', engineKey: 'seed', lastUsed: i }, `seed-${i}`);
      }
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  });
  assert.equal((await send({ type: 'translate', text: 'A new segment to trigger eviction.' })).ok, true);
  assert.equal((await send({ type: 'translation-cache', operation: 'status' })).count, 20_000);
  const oldestExists = await options.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const request = indexedDB.open('plamo-translate-cache', 1);
      request.onsuccess = () => resolve(request.result);
    });
    const value = await new Promise((resolve) => {
      const request = db.transaction('segments').objectStore('segments').get('seed-0');
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    return value !== undefined;
  });
  assert.equal(oldestExists, false);
  console.log('PASS real IndexedDB eviction: capped at 20,000; least-recently-used entry removed');
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(profile, { recursive: true, force: true });
}

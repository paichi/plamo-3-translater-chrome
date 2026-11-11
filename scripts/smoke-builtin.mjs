// Standalone, no external LLM. Optional real download/inference: REAL_MODEL=1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';

const extension = path.resolve(import.meta.dirname, '..');
// Keep OPFS/model storage off small /tmp tmpfs mounts. Always remove the profile on exit.
const profile = fs.mkdtempSync(path.resolve(extension, '..', '.plamo-smoke-'));
const requests = [];
const sample = 'The quick brown fox jumps over the lazy dog.';
const original = 'This is a simple English article about browsers and local translation. '.repeat(4);
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'mock-plamo' }] }));
  if (req.url === '/v1/chat/completions') {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ body: JSON.parse(body), authorization: req.headers.authorization });
    return res.end(JSON.stringify({ choices: [{ message: { content: 'これはテストの訳文です。' } }] }));
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<html lang="en"><body><p id="text">${original}</p></body></html>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const proxy = proxyUrl ? new URL(proxyUrl) : null;
const executablePath = process.env.CHROMIUM_PATH
  ?? (fs.existsSync(chromium.executablePath()) ? chromium.executablePath() : '/opt/meta-chromium/chrome');
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: true, ignoreHTTPSErrors: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    ...(proxy ? { proxy: {
      server: `${proxy.protocol}//${proxy.host}`, username: decodeURIComponent(proxy.username),
      password: decodeURIComponent(proxy.password), bypass: '127.0.0.1,localhost',
    } } : {}),
    args: ['--no-sandbox', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const id = new URL(worker.url()).host;
  const options = await context.newPage();
  options.on('pageerror', (e) => console.log('page error:', e.message));
  await options.goto(`chrome-extension://${id}/src/options/options.html`);
  await options.waitForFunction(() => !!document.querySelector('[name=baseUrl]')?.value);
  const send = (message) => options.evaluate((message) => chrome.runtime.sendMessage(message), message);
  await options.fill('[name=baseUrl]', `${origin}/v1`);
  await options.fill('[name=apiKey]', 'mock-key');
  await options.click('#fetch-models');
  await options.locator('#message:is(.ok, .error)').waitFor();
  assert.equal(await options.locator('#message').getAttribute('class'), 'ok', await options.textContent('#message'));
  await options.click('#test');
  await options.locator('#message.ok', { hasText: '成功' }).waitFor();
  assert.equal(requests[0].body.messages[0].content, sample);
  assert.deepEqual(requests[0].body.chat_template_kwargs, { target_lang: 'ja' });
  assert.equal(requests[0].authorization, 'Bearer mock-key');
  await options.uncheck('[name=autoTranslate]');
  await options.click('[type=submit]');
  console.log('PASS options server model list / unsaved selected-engine test / exact API payload');

  const page = await context.newPage();
  await page.goto(`${origin}/manual`);
  const tabMessage = (type, text) => worker.evaluate(async ({ url, type, text }) => {
    const [tab] = await chrome.tabs.query({ url });
    return chrome.tabs.sendMessage(tab.id, { type, text });
  }, { url: page.url(), type, text });
  await tabMessage('toggle-page');
  await page.waitForFunction(() => document.querySelector('#text').textContent.includes('訳文'));
  await page.locator('plamo-translator-ui .status button.restore').click();
  assert.equal(await page.textContent('#text'), original);
  await tabMessage('translate-selection', sample);
  await page.locator('plamo-translator-ui .card .body', { hasText: '訳文' }).waitFor();
  await options.check('[name=autoTranslate]');
  await options.click('[type=submit]');
  await page.goto(`${origin}/auto`);
  await page.waitForFunction(() => document.querySelector('#text').textContent.includes('訳文'));
  console.log('PASS server manual page / restore / selection / auto regression (mock API, not real LLM)');

  // Disable UI polling, then explicitly remove a warmed-up host so these six
  // simultaneous requests must race creation rather than reuse an existing one.
  await options.selectOption('[name=engine]', 'server');
  assert.equal((await send({ type: 'builtin-model', operation: 'status', quant: 'Q2_K' })).ok, true);
  await worker.evaluate(() => chrome.offscreen.closeDocument());
  assert.equal((await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }))).length, 0);
  const statuses = await options.evaluate(() => Promise.all(Array.from({ length: 6 }, () =>
    chrome.runtime.sendMessage({ type: 'builtin-model', operation: 'status', quant: 'Q2_K' }))));
  assert.ok(statuses.every((r) => r.ok && r.status.state === 'not-downloaded' && r.status.backend === null));
  const contexts = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
  assert.equal(contexts.length, 1);
  await options.selectOption('[name=engine]', 'builtin');
  await options.selectOption('[name=builtinModel]', 'Q2_K');
  await options.locator('#model-status', { hasText: '未ダウンロード' }).waitFor();
  assert.equal(await options.locator('[name=baseUrl]').isVisible(), true);
  assert.equal(await options.locator('.backend-lamp.is-active').count(), 0);
  console.log('PASS builtin UI / concurrent offscreen creation / OPFS empty status');

  // Stub only status responses in a separate options page, never inference or
  // the actual host. Exercise the real options module, DOM, CSS and polling.
  const lamps = await context.newPage();
  const lampErrors = [];
  lamps.on('pageerror', (e) => lampErrors.push(e.message));
  await lamps.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.backendStatus = { state: 'cached', backend: null };
    chrome.runtime.sendMessage = (message) => message.type === 'builtin-model' && message.operation === 'status'
      ? Promise.resolve({ ok: true, status: { quant: message.quant, pending: 0, ...window.backendStatus } })
      : send(message);
  });
  await lamps.goto(`chrome-extension://${id}/src/options/options.html`);
  await lamps.waitForFunction(() => !!document.querySelector('[name=baseUrl]')?.value);
  await lamps.selectOption('[name=engine]', 'builtin');
  for (const colorScheme of ['light', 'dark']) {
    await lamps.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    for (const backend of ['webgpu', 'wasm', null]) {
      await lamps.evaluate((backend) => {
        window.backendStatus = {
          state: backend ? 'ready' : 'cached', backend,
          ...(backend === 'webgpu' ? { gpuAdapter: 'Test <GPU>' } : {}),
        };
      }, backend);
      await lamps.waitForFunction((backend) => {
        const active = [...document.querySelectorAll('.backend-lamp.is-active')];
        return backend ? active.length === 1 && active[0].id === `backend-${backend}` : active.length === 0;
      }, backend);
      const appearance = await lamps.locator('.backend-lamp').evaluateAll((items) => items.map((item) => ({
        active: item.classList.contains('is-active'),
        glow: getComputedStyle(item.querySelector('.lamp-dot')).boxShadow,
        opacity: getComputedStyle(item.querySelector('.lamp-label')).opacity,
        label: item.getAttribute('aria-label'),
      })));
      for (const item of appearance) {
        assert.equal(item.glow !== 'none', item.active, 'only the active dot glows');
        assert.equal(Number(item.opacity) === 1, item.active, 'only the active label has full opacity');
        assert.match(item.label, item.active ? /: 使用中$/ : /: 未使用$/);
      }
      assert.equal(await lamps.locator('#gpu-adapter').isVisible(), backend === 'webgpu');
      if (backend === 'webgpu') {
        assert.equal(await lamps.textContent('#gpu-adapter'), 'Test <GPU>');
        assert.equal(await lamps.locator('#gpu-adapter > *').count(), 0, 'adapter name is plain text');
      }
      const detail = backend === 'webgpu' ? '準備完了（WebGPU 自動選択）'
        : backend === 'wasm' ? '準備完了（WASM / CPU）' : '保存済み（未読み込み）';
      assert.equal(await lamps.textContent('#model-status'), `Q4_K_M: ${detail}`, 'existing status text is preserved');
    }
  }
  assert.deepEqual(lampErrors, []);
  await lamps.close();
  console.log('PASS options backend lamps: stubbed webgpu / wasm / null, adapter text, glow and labels (light + dark)');

  // Probe from the actual extension/browser, not curl or Node.
  const reachable = await options.evaluate(async () => {
    try {
      const res = await fetch('https://huggingface.co/api/models/pfnet/plamo-3-translate-0.8b-GGUF', { signal: AbortSignal.timeout(15_000) });
      return { ok: res.ok, status: res.status };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  console.log('HF browser probe:', JSON.stringify(reachable));

  // Native runtime smoke: a tiny invalid local GGUF exercises packaged JS, static workers,
  // WASM compilation and failure cleanup without downloading a model or faking inference.
  await options.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('plamo-1cf96ae02133958a20074bfdfab76517bb737d00', { create: true });
    for (const [name, data] of [['Q2_K.gguf', 'GGUF' + '\0'.repeat(60)], ['Q2_K.json', JSON.stringify({ size: 64 })]]) {
      const out = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await out.write(data);
      await out.close();
    }
  });
  const before = requests.length;
  await options.click('#test');
  await options.locator('#message.error', { hasText: '失敗' }).waitFor({ timeout: 60_000 });
  assert.equal(requests.length, before, 'unsaved builtin choice must not call server');
  const nativeError = await options.textContent('#message');
  assert.match(nativeError, /GGUF にチャットテンプレートがありません/, 'native WASM initialization reached metadata validation');
  console.log('Native invalid-GGUF result:', nativeError);
  options.once('dialog', (dialog) => dialog.accept());
  await options.click('#delete-model');
  await options.locator('#model-status', { hasText: '未ダウンロード' }).waitFor();
  assert.deepEqual(await options.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('plamo-1cf96ae02133958a20074bfdfab76517bb737d00');
    return Array.fromAsync(dir.keys());
  }), []);
  console.log('PASS selected builtin error routing / real OPFS cache delete');

  if (process.env.REAL_MODEL === '1' && reachable.ok) {
    console.log('Attempting real Q2_K download + inference (bounded to 240s; fresh disposable profile).');
    const result = await Promise.race([
      send({ type: 'test-translate', settings: { engine: 'builtin', builtinModel: 'Q2_K', targetLang: 'ja' }, text: 'Hello, world.' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Real-model smoke exceeded 240 seconds')), 240_000).unref()),
    ]);
    console.log('Real model result:', JSON.stringify(result));
    assert.equal(result.ok, true, result.error);
    assert.match(result.text, /[ぁ-ヿ一-鿿]/);
    console.log('PASS real one-sentence translation');
  } else {
    console.log('SKIP real inference:', reachable.ok ? 'set REAL_MODEL=1 to opt into a several-hundred-MB download' : 'HF unreachable in browser');
  }
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(profile, { recursive: true, force: true });
}

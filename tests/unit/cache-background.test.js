import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { normalizeSettings } from '../../src/shared/settings.js';

test('background caches both engines, bypasses disabled cache and never caches errors', async () => {
  const original = { chrome: globalThis.chrome, fetch: globalThis.fetch, indexedDB: globalThis.indexedDB };
  globalThis.indexedDB = new IDBFactory();
  let settings = normalizeSettings({ model: 'test' });
  let listener;
  let calls = 0;
  let fail = false;
  let finish;
  const noOp = { addListener() {} };
  const optionsUrl = 'chrome-extension://test/src/options/options.html';
  globalThis.chrome = {
    runtime: {
      onInstalled: noOp,
      onMessage: { addListener(fn) { listener = fn; } },
      getURL: (path) => `chrome-extension://test/${path}`,
      getContexts: async () => [{}],
      async sendMessage() {
        calls++;
        return fail ? { ok: false, error: 'builtin failed' } : { ok: true, text: '内蔵訳' };
      },
    },
    contextMenus: { onClicked: noOp }, commands: { onCommand: noOp },
    storage: { sync: { get: async () => settings } },
  };
  globalThis.fetch = async () => {
    calls++;
    if (finish) await new Promise((resolve) => { finish = resolve; });
    return fail ? new Response('failed', { status: 500 })
      : Response.json({ choices: [{ message: { content: '訳文' } }] });
  };
  const send = (message, url = optionsUrl) => new Promise((resolve) => {
    assert.equal(listener(message, { url }, resolve), true);
  });
  const translate = (text) => send({ type: 'translate', text });
  const status = () => send({ type: 'translation-cache', operation: 'status' });
  try {
    await import('../../src/background.js?cache-test');
    assert.deepEqual(await translate('Hello'), { ok: true, text: '訳文' });
    assert.deepEqual(await translate('Hello'), { ok: true, text: '訳文' });
    assert.equal(calls, 1);
    assert.equal((await status()).count, 1);

    settings = { ...settings, cacheEnabled: false };
    await translate('Hello');
    await translate('Not stored');
    assert.equal(calls, 3);
    assert.equal((await status()).count, 1);
    settings = { ...settings, cacheEnabled: true };
    await translate('Not stored');
    assert.equal(calls, 4);

    fail = true;
    assert.equal((await translate('Failure')).ok, false);
    assert.equal((await translate('Failure')).ok, false);
    assert.equal(calls, 6, 'server failures are retried, not cached');
    fail = false;
    await translate('Failure');
    await translate('Failure');
    assert.equal(calls, 7);

    settings = { ...settings, engine: 'builtin' };
    await translate('Hello');
    await translate('Hello');
    assert.equal(calls, 8, 'builtin has its own identity and hits before host invocation');
    fail = true;
    await translate('Builtin failure');
    await translate('Builtin failure');
    assert.equal(calls, 10, 'builtin error responses are not cached');
    fail = false;

    assert.equal((await send({ type: 'translation-cache', operation: 'clear' }, 'https://page.test')).ok, false);
    assert.equal((await send({ type: 'translation-cache', operation: 'unknown' })).ok, false);
    assert.equal((await send({ type: 'translation-cache', operation: 'clear' })).count, 0);

    settings = { ...settings, engine: 'server' };
    finish = true;
    const pending = translate('In flight during clear');
    while (typeof finish !== 'function') await new Promise((resolve) => setTimeout(resolve, 1));
    await send({ type: 'translation-cache', operation: 'clear' });
    finish();
    finish = undefined;
    assert.equal((await pending).ok, true);
    assert.equal((await status()).count, 0, 'clear prevents in-flight results from repopulating the cache');
  } finally {
    Object.assign(globalThis, original);
  }
});

test('unavailable IndexedDB does not block translation', async () => {
  const original = { chrome: globalThis.chrome, fetch: globalThis.fetch, indexedDB: globalThis.indexedDB };
  let listener;
  let calls = 0;
  const noOp = { addListener() {} };
  globalThis.indexedDB = { open() { throw new Error('storage unavailable'); } };
  globalThis.chrome = {
    runtime: { onInstalled: noOp, onMessage: { addListener(fn) { listener = fn; } } },
    contextMenus: { onClicked: noOp }, commands: { onCommand: noOp },
    storage: { sync: { get: async () => normalizeSettings({}) } },
  };
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ choices: [{ message: { content: '訳文' } }] });
  };
  try {
    await import('../../src/background.js?cache-unavailable-test');
    for (let i = 0; i < 2; i++) {
      const result = await new Promise((resolve) => listener({ type: 'translate', text: 'Hello' }, {}, resolve));
      assert.deepEqual(result, { ok: true, text: '訳文' });
    }
    assert.equal(calls, 2);
  } finally {
    Object.assign(globalThis, original);
  }
});

test('unreachable server falls back to the builtin translation and recovers on the next request', async (t) => {
  const original = { chrome: globalThis.chrome, fetch: globalThis.fetch, indexedDB: globalThis.indexedDB };
  t.after(() => Object.assign(globalThis, original));
  globalThis.indexedDB = new IDBFactory();
  let settings = normalizeSettings({});
  let listener;
  let builtinCalls = 0;
  let server = 'unreachable';
  const noOp = { addListener() {} };
  const optionsUrl = 'chrome-extension://test/src/options/options.html';
  globalThis.chrome = {
    runtime: {
      onInstalled: noOp,
      onMessage: { addListener(fn) { listener = fn; } },
      getURL: (path) => `chrome-extension://test/${path}`,
      getContexts: async () => [{}],
      async sendMessage() {
        builtinCalls++;
        return { ok: true, text: '内蔵の訳' };
      },
    },
    contextMenus: { onClicked: noOp }, commands: { onCommand: noOp },
    storage: { sync: { get: async () => settings } },
  };
  globalThis.fetch = async () => {
    if (server === 'unreachable') throw new TypeError('Failed to fetch');
    if (server === 'unauthorized') return new Response('', { status: 401 });
    if (server === 'timeout') throw new DOMException('Timed out', 'TimeoutError');
    if (server === 'body-timeout') {
      return new Response(new ReadableStream({
        start(controller) { controller.error(new DOMException('Timed out', 'TimeoutError')); },
      }));
    }
    if (server === 'invalid-json') return new Response('{');
    return Response.json({ choices: [{ message: { content: 'サーバーの訳' } }] });
  };
  await import('../../src/background.js?connection-fallback-test');
  const send = (message) => new Promise((resolve) => listener(message, { url: optionsUrl }, resolve));
  const translate = (text) => send({ type: 'translate', text });

  assert.deepEqual(await translate('Hello'), { ok: true, text: '内蔵の訳' });
  assert.deepEqual(await translate('Hello'), { ok: true, text: '内蔵の訳' });
  assert.equal(builtinCalls, 1);

  const probe = await send({ type: 'test-translate', settings, text: 'Hello' });
  assert.equal(probe.ok, false);
  assert.match(probe.error, /接続できません/);
  assert.equal(builtinCalls, 1);

  server = 'available';
  assert.deepEqual(await translate('Hello'), { ok: true, text: 'サーバーの訳' });

  settings = { ...settings, cacheEnabled: false };
  server = 'unauthorized';
  const denied = await translate('Hello');
  assert.equal(denied.ok, false);
  assert.match(denied.error, /HTTP 401/);
  assert.equal(builtinCalls, 1);

  server = 'timeout';
  assert.deepEqual(await translate('Hello'), { ok: true, text: '内蔵の訳' });
  assert.equal(builtinCalls, 2);

  server = 'body-timeout';
  assert.deepEqual(await translate('Hello'), { ok: true, text: '内蔵の訳' });
  assert.equal(builtinCalls, 3);

  server = 'invalid-json';
  assert.equal((await translate('Hello')).ok, false);
  assert.equal(builtinCalls, 3);
});

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

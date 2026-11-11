import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { createCacheKey, createTranslationCache } from '../../src/cache.js';
import { DEFAULTS, normalizeSettings } from '../../src/shared/settings.js';

// Exercise the actual IndexedDB adapter/transactions/eviction against a fake
// IndexedDB store, rather than duplicating the eviction algorithm in a mock.
beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });
const settings = normalizeSettings({ model: 'plamo' });

test('cache setting defaults to true unless explicitly false', () => {
  assert.equal(DEFAULTS.cacheEnabled, true);
  for (const cacheEnabled of [undefined, null, 0, '', 'false', true]) {
    assert.equal(normalizeSettings({ cacheEnabled }).cacheEnabled, true);
  }
  assert.equal(normalizeSettings({ cacheEnabled: false }).cacheEnabled, false);
});

test('SHA-256 keys are stable and separate exact text, language and engine identity', async () => {
  const key = await createCacheKey(settings, 'Hello');
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(await createCacheKey({ ...settings }, 'Hello'), key);
  for (const changed of [
    { targetLang: 'fr' }, { model: 'other' }, { baseUrl: 'https://other/v1' },
    { engine: 'builtin' },
  ]) {
    assert.notEqual(await createCacheKey({ ...settings, ...changed }, 'Hello'), key);
  }
  assert.notEqual(await createCacheKey(settings, 'hello'), key);
  assert.notEqual(await createCacheKey(settings, 'Hello '), key);
  assert.equal(await createCacheKey({ ...settings, url: 'https://other/page', apiKey: 'secret', concurrency: 1 }, 'Hello'), key);
  const builtin = { ...settings, engine: 'builtin' };
  assert.notEqual(await createCacheKey(builtin, 'Hello'), await createCacheKey({ ...builtin, builtinModel: 'Q2_K' }, 'Hello'));
  assert.equal(await createCacheKey(builtin, 'Hello'), await createCacheKey({ ...builtin, model: 'ignored', baseUrl: 'ignored' }, 'Hello'));
  assert.notEqual(await createCacheKey({ ...settings, baseUrl: 'a,b', model: 'c' }, 'Hello'),
    await createCacheKey({ ...settings, baseUrl: 'a', model: 'b,c' }, 'Hello'));
});

test('get/set persist across cache instances, replace keys, retain empty translations and clear', async () => {
  const cache = createTranslationCache();
  assert.equal(await cache.get(settings, 'Hello'), undefined);
  assert.equal(await cache.count(), 0);
  await cache.set(settings, 'Hello', 'こんにちは');
  assert.equal(await cache.get(settings, 'Hello'), 'こんにちは');
  await cache.set(settings, 'Hello', 'やあ');
  assert.equal(await cache.count(), 1);
  const reopened = createTranslationCache();
  assert.equal(await reopened.get(settings, 'Hello'), 'やあ');
  assert.equal(await reopened.get({ ...settings, targetLang: 'fr' }, 'Hello'), undefined);
  await cache.set(settings, 'Empty', '');
  assert.equal(await reopened.get(settings, 'Empty'), '');
  await reopened.clear();
  assert.equal(await cache.count(), 0);
  assert.equal(await cache.get(settings, 'Hello'), undefined);
});

test('LRU evicts oldest entries down to cap and hits refresh lastUsed', async () => {
  let clock = 0;
  const cache = createTranslationCache({ maxEntries: 3, now: () => ++clock });
  for (const text of ['A', 'B', 'C']) await cache.set(settings, text, `訳${text}`);
  await cache.get(settings, 'A');
  await cache.set(settings, 'D', '訳D');
  assert.equal(await cache.count(), 3);
  assert.equal(await cache.get(settings, 'B'), undefined, 'B is oldest after A was touched');
  assert.equal(await cache.get(settings, 'A'), '訳A');
  assert.equal(await cache.get(settings, 'C'), '訳C');
  assert.equal(await cache.get(settings, 'D'), '訳D');
});

test('atomic concurrent writes never leave the store above the cap', async () => {
  let clock = 0;
  const cache = createTranslationCache({ maxEntries: 5, now: () => ++clock });
  await Promise.all(Array.from({ length: 30 }, (_, i) => cache.set(settings, `Segment ${i}`, `訳${i}`)));
  assert.equal(await cache.count(), 5);
  await cache.set(settings, 'Last', '最新');
  assert.equal(await cache.count(), 5);
  assert.equal(await cache.get(settings, 'Last'), '最新');
});

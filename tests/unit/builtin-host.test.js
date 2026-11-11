import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Wllama } from '../../vendor/wllama/index.js';

// Exercise the actual host/queue/cache with in-memory OPFS and a mocked inference
// boundary. This is not a claim of real GGUF inference (see smoke-builtin.mjs).
test('offscreen queue, OPFS commit/reuse/delete, failure recovery and CPU retry', async () => {
  const files = new Map();
  const missing = () => new DOMException('not found', 'NotFoundError');
  const directory = {
    async getDirectoryHandle() { return this; },
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) throw missing();
        files.set(name, new Blob());
      }
      return {
        async getFile() { return new File([files.get(name)], name); },
        async createWritable() {
          const chunks = [];
          const stream = new WritableStream({
            write(chunk) { chunks.push(chunk); },
            close() { files.set(name, new Blob(chunks)); },
          });
          stream.write = async (chunk) => { chunks.push(chunk); };
          return stream;
        },
      };
    },
    async removeEntry(name) { if (!files.delete(name)) throw missing(); },
  };
  const originals = {
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    chrome: globalThis.chrome, fetch: globalThis.fetch, suspending: WebAssembly.Suspending,
    load: Wllama.prototype.loadModel, exit: Wllama.prototype.exit,
    completion: Wllama.prototype.createCompletion, template: Wllama.prototype.getChatTemplate,
    setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
  };
  let listener;
  let fetches = 0;
  let active = 0;
  let maxActive = 0;
  let interrupted = false;
  let failGPU = false;
  const loads = [];
  const events = [];
  const timers = new Set();
  const keepalives = [];
  let unrefs = 0;
  globalThis.setInterval = (callback, ms) => {
    assert.equal(ms, 20_000);
    const timer = { callback, unref() { unrefs++; } };
    timers.add(timer);
    return timer;
  };
  globalThis.clearInterval = (timer) => { timers.delete(timer); };
  const template = readFileSync(new URL('../fixtures/plamo-chat-template.jinja', import.meta.url), 'utf8');
  const delay = () => new Promise((resolve) => setTimeout(resolve, 5));
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    storage: { getDirectory: async () => directory }, userAgent: 'Chrome/157.0',
  } });
  globalThis.chrome = { runtime: {
    id: 'test-extension', getURL: (p) => `chrome-extension://test-extension/${p}`,
    onMessage: { addListener(fn) { listener = fn; } },
    async sendMessage(message) { keepalives.push(message); return { ok: true }; },
  } };
  WebAssembly.Suspending ??= function () {};
  globalThis.fetch = async (url) => {
    fetches++;
    assert.match(url, /huggingface.co\/pfnet\/plamo-3-translate-0.8b-GGUF\/resolve\/1cf96ae/);
    await delay();
    if (interrupted) {
      interrupted = false;
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error('interrupted')); } }));
    }
    return new Response('mock model bytes', { headers: { 'content-length': '16' } });
  };
  Wllama.prototype.loadModel = async function (blobs, params) {
    loads.push(params.n_gpu_layers);
    assert.equal(blobs[0].size, 16);
    assert.equal(params.n_threads, 1);
    await delay();
    if (failGPU && params.n_gpu_layers > 0) throw new Error('GPU unavailable');
  };
  Wllama.prototype.exit = async function () { events.push('exit'); };
  Wllama.prototype.getChatTemplate = () => template;
  Wllama.prototype.createCompletion = async function (params) {
    active++;
    maxActive = Math.max(maxActive, active);
    assert.equal(params.stop.length, 5);
    assert.equal(params.temperature, 0);
    try {
      events.push('start');
      await delay();
      if (params.prompt.includes('fail inference')) throw new Error('inference error');
      events.push('end');
      return { choices: [{ text: ' 訳文<|plamo:tag|>ignored', finish_reason: 'stop' }] };
    } finally { active--; }
  };
  const call = (operation, quant = 'Q4_K_M', text = 'Hello') => new Promise((resolve) => {
    assert.equal(listener({ target: 'plamo-offscreen', operation, quant, text, targetLang: 'ja' },
      { id: 'test-extension' }, resolve), true);
  });
  try {
    await import('../../src/offscreen/host.js?unit');
    assert.equal((await call('status')).status.state, 'not-downloaded');
    assert.equal((await call('status')).status.backend, null);
    assert.equal(Object.hasOwn((await call('status')).status, 'gpuAdapter'), false);
    const replies = await Promise.all([
      call('translate'), call('translate', 'Q4_K_M', 'fail inference'), call('translate'),
    ]);
    assert.deepEqual(replies.map((r) => r.ok), [true, false, true], JSON.stringify(replies));
    assert.equal(replies[0].text, '訳文');
    assert.equal(fetches, 1, 'concurrent requests download once');
    assert.equal(loads.length, 1, 'single model instance');
    assert.equal(maxActive, 1, 'inference serialized');
    assert.equal((await call('status')).status.state, 'ready', 'successful retry clears error');
    assert.equal((await call('status')).status.backend, 'wasm', 'no adapter maps to CPU');
    assert.ok(files.has('Q4_K_M.json'), 'complete marker committed');

    const running = call('translate');
    const deleting = call('delete');
    assert.equal((await call('status')).status.pending, 2, 'status bypasses queue');
    assert.equal(timers.size, 1, 'one heartbeat only while queue is pending');
    for (const timer of timers) timer.callback();
    assert.deepEqual(keepalives, [{ type: 'builtin-keepalive' }]);
    assert.ok(unrefs > 0, 'heartbeat does not hold Node open');
    await Promise.all([running, deleting]);
    await delay();
    assert.equal(timers.size, 0, 'heartbeat clears when queue drains');
    assert.deepEqual(events.slice(-3), ['start', 'end', 'exit'], 'unload/delete waits for inference');
    assert.equal(files.size, 0);
    assert.equal((await call('status')).status.state, 'not-downloaded');
    assert.equal((await call('status')).status.backend, null, 'delete clears the loaded backend');

    interrupted = true;
    assert.equal((await call('load', 'Q3_K_M')).ok, false);
    assert.equal(files.has('Q3_K_M.json'), false, 'partial download never committed');
    assert.equal(files.has('Q3_K_M.gguf'), false, 'partial file removed');
    assert.equal((await call('load', 'Q3_K_M')).ok, true, 'failed download does not poison queue');
    const beforeReload = fetches;
    await import('../../src/offscreen/host.js?restart');
    assert.equal((await call('status', 'Q3_K_M')).status.state, 'cached');
    assert.equal((await call('status', 'Q3_K_M')).status.backend, null, 'disk cache is not a loaded model');
    assert.equal((await call('load', 'Q3_K_M')).ok, true);
    assert.equal(fetches, beforeReload, 'OPFS reuse needs no network');

    navigator.gpu = { requestAdapter: async () => ({ info: { description: 'Test GPU' } }) };
    failGPU = true;
    assert.equal((await call('load', 'Q2_K')).ok, true);
    assert.deepEqual(loads.slice(-2), [99999, 0], 'GPU load failure retries CPU');
    assert.equal((await call('status', 'Q2_K')).status.backend, 'wasm');
    assert.equal((await call('status', 'Q2_K')).status.gpuAdapter, 'Test GPU');
    assert.equal((await call('status', 'Q3_K_M')).status.backend, null, 'previous quant is unloaded');
    assert.equal(Object.hasOwn((await call('status', 'Q3_K_M')).status, 'gpuAdapter'), false);

    failGPU = false;
    const gpuLoad = await call('load');
    assert.equal(gpuLoad.status.backend, 'webgpu', 'successful auto offload maps to WebGPU');
    assert.equal(gpuLoad.status.gpuAdapter, 'Test GPU');
    assert.equal((await call('status')).status.backend, 'webgpu');
    await call('translate');
    assert.equal((await call('status')).status.backend, 'webgpu', 'reuse preserves backend mapping');

    navigator.gpu.requestAdapter = async () => ({
      get info() { throw new Error('info unavailable'); },
      requestAdapterInfo: async () => ({ vendor: 'Legacy GPU', architecture: 'test' }),
    });
    assert.equal((await call('load', 'Q3_K_M')).status.gpuAdapter, 'Legacy GPU · test');
    navigator.gpu.requestAdapter = async () => ({
      get info() { throw new Error('info unavailable'); },
      requestAdapterInfo: async () => { throw new Error('info denied'); },
    });
    const noInfo = await call('load', 'Q2_K');
    assert.equal(noInfo.status.backend, 'webgpu', 'metadata failure does not affect loading');
    assert.equal(Object.hasOwn(noInfo.status, 'gpuAdapter'), false);
    navigator.gpu.requestAdapter = () => { throw new Error('GPU unavailable'); };
    assert.equal((await call('load')).status.backend, 'wasm', 'probe failure uses CPU');
    const deleted = await call('delete');
    assert.equal(deleted.status.backend, null);
    assert.equal(Object.hasOwn(deleted.status, 'gpuAdapter'), false);
    assert.equal((await call('load', '../bad')).ok, false);
  } finally {
    globalThis.setInterval = originals.setInterval;
    globalThis.clearInterval = originals.clearInterval;
    Object.defineProperty(globalThis, 'navigator', originals.navigator);
    globalThis.chrome = originals.chrome;
    globalThis.fetch = originals.fetch;
    if (originals.suspending === undefined) delete WebAssembly.Suspending;
    else WebAssembly.Suspending = originals.suspending;
    Object.assign(Wllama.prototype, {
      loadModel: originals.load, exit: originals.exit, createCompletion: originals.completion,
      getChatTemplate: originals.template,
    });
  }
});

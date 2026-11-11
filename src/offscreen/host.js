import { Wllama } from '../../vendor/wllama/index.js';
import { BUILTIN_MODELS } from '../shared/settings.js';
import { buildPrompt, cleanCompletion, verifyTemplate, STOP_TOKENS } from './prompt.js';

const REVISION = '1cf96ae02133958a20074bfdfab76517bb737d00';
const REPO = 'https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF';
const states = new Map();
let model;
let loadedQuant;
let loadedBackend;
let tail = Promise.resolve();
let pending = 0;
let keepaliveTimer;

function setState(quant, state, detail = {}) {
  states.set(quant, { quant, state, ...detail });
}

// All mutations, including unload/delete and quant changes, share this queue.
// A rejected request must not poison subsequent requests. Status never waits on it.
function enqueue(fn) {
  pending++;
  if (!keepaliveTimer) {
    // Offscreen runtime messages reset the MV3 worker's idle timer. Only run
    // while work is pending; this does not bypass Chrome's event lifetime limit.
    keepaliveTimer = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'builtin-keepalive' }).catch(() => {});
    }, 20_000);
    keepaliveTimer.unref?.(); // Do not keep Node unit tests alive.
  }
  const result = tail.then(fn);
  tail = result.catch(() => {}).finally(() => {
    if (--pending === 0) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = undefined;
    }
  });
  return result;
}

async function cacheDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(`plamo-${REVISION}`, { create: true });
}

async function cachedFile(quant) {
  const dir = await cacheDir();
  try {
    const marker = await (await dir.getFileHandle(`${quant}.json`)).getFile();
    const { size } = JSON.parse(await marker.text());
    const file = await (await dir.getFileHandle(`${quant}.gguf`)).getFile();
    return size > 0 && file.size === size ? file : null;
  } catch (e) {
    if (e.name === 'NotFoundError' || e instanceof SyntaxError) return null;
    throw e;
  }
}

async function removeFiles(quant) {
  const dir = await cacheDir();
  for (const suffix of ['json', 'gguf']) {
    await dir.removeEntry(`${quant}.${suffix}`).catch((e) => {
      if (e.name !== 'NotFoundError') throw e;
    });
  }
}

async function download(quant) {
  const cached = await cachedFile(quant);
  if (cached) return cached;
  setState(quant, 'downloading', { loaded: 0, total: 0 });
  const dir = await cacheDir();
  try {
    // No executable code is fetched: only the pinned GGUF model data.
    const url = `${REPO}/resolve/${REVISION}/plamo-3-translate-0.8b-${quant}.gguf`;
    const response = await fetch(url, { signal: AbortSignal.timeout(240_000) });
    if (!response.ok || !response.body) throw new Error(`モデルの取得: HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length')) || 0;
    let loaded = 0;
    const file = await dir.getFileHandle(`${quant}.gguf`, { create: true });
    const writable = await file.createWritable();
    try {
      await response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          loaded += chunk.byteLength;
          setState(quant, 'downloading', { loaded, total });
          controller.enqueue(chunk);
        },
      })).pipeTo(writable);
    } catch (e) {
      await writable.abort().catch(() => {});
      throw e;
    }
    if (!loaded || (total && loaded !== total)) throw new Error('モデルのダウンロードが不完全です');
    // Commit marker last. Interrupted/failed downloads are never reused.
    const marker = await (await dir.getFileHandle(`${quant}.json`, { create: true })).createWritable();
    await marker.write(JSON.stringify({ size: loaded }));
    await marker.close();
    return await cachedFile(quant);
  } catch (e) {
    await removeFiles(quant).catch(() => {});
    throw e;
  }
}

async function unload() {
  if (model) await model.exit();
  if (loadedQuant) setState(loadedQuant, 'cached');
  model = undefined;
  loadedQuant = undefined;
}

function newModel() {
  const instance = new Wllama({ default: chrome.runtime.getURL('vendor/wllama/wasm/wllama.wasm') }, {
    suppressNativeLog: true,
  });
  // Older browsers must fail locally, not silently fetch executable compat code from a CDN.
  instance.setCompat(null);
  return instance;
}

async function ensureModel(quant) {
  if (model && loadedQuant === quant) {
    setState(quant, 'ready', { backend: loadedBackend });
    return;
  }
  if (!WebAssembly.Suspending) throw new Error('内蔵エンジンには JSPI 対応の Chrome 137 以降が必要です');
  await unload();
  const file = await download(quant);
  setState(quant, 'loading');
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
  const params = { n_ctx: 4096, n_batch: 256, n_threads: 1, n_parallel: 1, n_gpu_layers: adapter ? 99999 : 0 };
  model = newModel();
  try {
    await model.loadModel([file], params);
    await verifyTemplate(model.getChatTemplate());
  } catch (e) {
    await model.exit().catch(() => {});
    model = undefined;
    if (!adapter) throw e;
    // A detected GPU may still lack memory/features. Retry on CPU once.
    model = newModel();
    await model.loadModel([file], { ...params, n_gpu_layers: 0 });
    await verifyTemplate(model.getChatTemplate());
    params.n_gpu_layers = 0;
  }
  loadedQuant = quant;
  loadedBackend = params.n_gpu_layers ? 'auto' : 'wasm';
  setState(quant, 'ready', { backend: loadedBackend });
}

async function status(quant) {
  const saved = states.get(quant);
  return { ...(saved ?? { quant, state: await cachedFile(quant) ? 'cached' : 'not-downloaded' }), pending };
}

async function run({ operation, quant, text, targetLang }) {
  if (!BUILTIN_MODELS.includes(quant)) throw new Error('未対応の量子化モデルです');
  if (operation === 'status') return { ok: true, status: await status(quant) };
  return enqueue(async () => {
    try {
      if (operation === 'delete') {
        if (loadedQuant === quant) await unload();
        await removeFiles(quant);
        setState(quant, 'not-downloaded');
        return { ok: true, status: await status(quant) };
      }
      if (!['load', 'translate'].includes(operation)) throw new Error('不明な内蔵エンジン操作です');
      // Validate before a potentially large download; preserve source whitespace.
      const prompt = operation === 'translate' ? buildPrompt(text, targetLang) : null;
      await ensureModel(quant);
      if (operation === 'load') return { ok: true, status: await status(quant) };
      const result = await model.createCompletion({
        prompt, temperature: 0, max_tokens: 2048, stop: [...STOP_TOKENS],
        abortSignal: AbortSignal.timeout(180_000),
      });
      if (result.choices?.[0]?.finish_reason === 'length') {
        throw new Error('内蔵モデルの出力上限に達しました。短い文章で再試行してください');
      }
      const translated = cleanCompletion(result.choices?.[0]?.text);
      setState(quant, 'ready', { backend: loadedBackend });
      return { ok: true, text: translated };
    } catch (e) {
      // A failed initialization can leave a worker behind; release it before retrying.
      if (!loadedQuant && model) {
        await model.exit().catch(() => {});
        model = undefined;
      }
      setState(quant, 'error', { error: e.message });
      throw e;
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'plamo-offscreen' || sender.id !== chrome.runtime.id) return false;
  run(message).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});

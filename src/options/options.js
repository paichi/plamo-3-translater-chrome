import { loadSettings, saveSettings, normalizeSettings, BUILTIN_MODELS } from '../shared/settings.js';
import { LANGUAGES, listModels } from '../llm.js';

const form = document.getElementById('form');
const message = document.getElementById('message');
const fields = form.elements;
const builtinPanel = document.getElementById('builtin');
const modelStatus = document.getElementById('model-status');
const backendWebgpu = document.getElementById('backend-webgpu');
const backendWasm = document.getElementById('backend-wasm');
const gpuAdapter = document.getElementById('gpu-adapter');
const loadButton = document.getElementById('load-model');
const deleteButton = document.getElementById('delete-model');
const cacheStatus = document.getElementById('cache-status');
const clearCacheButton = document.getElementById('clear-cache');
let modelAction = false;
let polling = false;

for (const quant of BUILTIN_MODELS) fields.builtinModel.append(new Option(quant, quant));

for (const { code, label } of LANGUAGES) {
  fields.targetLang.append(new Option(`${label}（${code}）`, code));
}

function show(text, kind = '') {
  message.textContent = text;
  message.className = kind;
}

function readForm() {
  return normalizeSettings({
    engine: fields.engine.value,
    builtinModel: fields.builtinModel.value,
    baseUrl: fields.baseUrl.value,
    apiKey: fields.apiKey.value,
    model: fields.model.value,
    targetLang: fields.targetLang.value,
    concurrency: fields.concurrency.value,
    showSelectionButton: fields.showSelectionButton.checked,
    autoTranslate: fields.autoTranslate.checked,
    cacheEnabled: fields.cacheEnabled.checked,
    excludeDomains: fields.excludeDomains.value.split(/[\n,]+/),
  });
}

function fillForm(settings) {
  for (const [key, value] of Object.entries(settings)) {
    const field = fields[key];
    if (field?.type === 'checkbox') field.checked = value;
    else if (field) field.value = Array.isArray(value) ? value.join('\n') : value;
  }
}

async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error ?? '応答がありません');
  return result;
}

function renderBackend(status = {}) {
  for (const [lamp, backend, label] of [[backendWebgpu, 'webgpu', 'WebGPU'], [backendWasm, 'wasm', 'CPU (WASM)']]) {
    const active = status.backend === backend;
    lamp.classList.toggle('is-active', active);
    lamp.setAttribute('aria-label', `${label}: ${active ? '使用中' : '未使用'}`);
  }
  gpuAdapter.textContent = status.gpuAdapter || '';
  gpuAdapter.hidden = !status.gpuAdapter;
}

async function refreshModelStatus() {
  if (builtinPanel.hidden || polling) return;
  polling = true;
  const quant = fields.builtinModel.value;
  try {
    const { status } = await send({ type: 'builtin-model', operation: 'status', quant });
    if (quant !== fields.builtinModel.value || builtinPanel.hidden) return;
    renderBackend(status);
    const labels = {
      'not-downloaded': '未ダウンロード', cached: '保存済み（未読み込み）',
      downloading: 'ダウンロード中', loading: '読み込み中', ready: '準備完了', error: 'エラー',
    };
    let detail = '';
    if (status.state === 'downloading') {
      detail = status.total
        ? ` ${Math.floor(status.loaded / status.total * 100)}%`
        : ` ${(status.loaded / 1024 / 1024).toFixed(1)} MB`;
    }
    if (status.backend) detail += status.backend === 'wasm' ? '（WASM / CPU）' : '（WebGPU 自動選択）';
    if (status.error) detail += `: ${status.error}`;
    if (status.pending) detail += ` · 処理中／待機 ${status.pending} 件`;
    modelStatus.textContent = `${quant}: ${labels[status.state] ?? status.state}${detail}`;
    const busy = modelAction || status.pending > 0;
    loadButton.disabled = busy;
    deleteButton.disabled = busy;
  } catch (e) {
    renderBackend();
    modelStatus.textContent = `エラー: ${e.message}`;
  } finally {
    polling = false;
  }
}

async function refreshCacheStatus() {
  try {
    const { count } = await send({ type: 'translation-cache', operation: 'status' });
    cacheStatus.textContent = `保存済み: ${count.toLocaleString()} 件`;
  } catch (e) {
    cacheStatus.textContent = `エラー: ${e.message}`;
  }
}

clearCacheButton.addEventListener('click', async () => {
  if (!confirm('保存済みの翻訳キャッシュをすべて削除しますか？')) return;
  clearCacheButton.disabled = true;
  try {
    await send({ type: 'translation-cache', operation: 'clear' });
    show('翻訳キャッシュを削除しました。', 'ok');
  } catch (e) {
    show(e.message, 'error');
  } finally {
    clearCacheButton.disabled = false;
    await refreshCacheStatus();
  }
});

function updateEngine() {
  builtinPanel.hidden = fields.engine.value !== 'builtin';
  modelStatus.textContent = '';
  renderBackend();
  void refreshModelStatus();
}

fillForm(await loadSettings());
updateEngine();
void refreshCacheStatus();
window.addEventListener('focus', () => { void refreshCacheStatus(); });
fields.engine.addEventListener('change', updateEngine);
fields.builtinModel.addEventListener('change', () => {
  renderBackend();
  void refreshModelStatus();
});
// Polling is read-only and bypasses the inference queue so progress remains live.
setInterval(() => { void refreshModelStatus(); }, 1000);

for (const [button, operation] of [[loadButton, 'load'], [deleteButton, 'delete']]) {
  button.addEventListener('click', async () => {
    if (operation === 'delete' && !confirm('選択したモデルのキャッシュを削除しますか？')) return;
    modelAction = true;
    loadButton.disabled = deleteButton.disabled = true;
    const quant = fields.builtinModel.value;
    try {
      await send({ type: 'builtin-model', operation, quant });
      show(operation === 'load' ? `${quant}: 準備完了` : `${quant}: キャッシュを削除しました。`, 'ok');
    } catch (e) {
      show(e.message, 'error');
    } finally {
      modelAction = false;
      loadButton.disabled = deleteButton.disabled = false;
      await refreshModelStatus();
    }
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  fillForm(await saveSettings(readForm()));
  show('保存しました。', 'ok');
});

document.getElementById('fetch-models').addEventListener('click', async () => {
  show('モデル一覧を取得中…');
  try {
    const models = await listModels(readForm());
    document.getElementById('models').replaceChildren(...models.map((id) => new Option(id, id)));
    if (models.length === 1 && !fields.model.value) fields.model.value = models[0];
    show(models.length ? `${models.length} 件: ${models.join(', ')}` : 'モデルが見つかりませんでした。', 'ok');
  } catch (e) {
    show(`取得できませんでした。\n${e.message}`, 'error');
  }
});

document.getElementById('test').addEventListener('click', async () => {
  const settings = readForm();
  const sample = 'The quick brown fox jumps over the lazy dog.';
  show('接続テスト中…');
  const started = performance.now();
  try {
    const { text: result } = await send({ type: 'test-translate', settings, text: sample });
    const seconds = ((performance.now() - started) / 1000).toFixed(2);
    show(`成功（${seconds} 秒）\n${sample}\n→ ${result}`, 'ok');
  } catch (e) {
    show(`失敗しました。\n${e.message}`, 'error');
  }
});

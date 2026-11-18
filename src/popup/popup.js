import { loadSettings } from '../shared/settings.js';

const statusEl = document.getElementById('status');
const toggle = document.getElementById('toggle');

const CONTENT_SCRIPTS = chrome.runtime.getManifest().content_scripts[0].js;

const LABELS = {
  idle: ['未翻訳', 'このページを翻訳'],
  translating: ['翻訳中', '原文に戻す'],
  translated: ['翻訳済み', '原文に戻す'],
};

function render(status) {
  const [label, action] = LABELS[status.state] ?? LABELS.idle;
  statusEl.textContent = status.failed ? `${label}（${status.failed} 件失敗）` : label;
  toggle.textContent = action;
  toggle.disabled = false;
}

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

try {
  render(await chrome.tabs.sendMessage(tab.id, { type: 'get-state' }));
} catch {
  if (/^(https?|file):/.test(tab?.url ?? '')) render({ state: 'idle' });
  else statusEl.textContent = 'このページでは使えません。';
}

toggle.addEventListener('click', async () => {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle-page' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_SCRIPTS });
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle-page' });
  }
  window.close();
});

let hostname = '';
try {
  const url = new URL(tab?.url ?? '');
  if (['http:', 'https:'].includes(url.protocol)) hostname = url.hostname.toLowerCase();
} catch {}
for (const [id, key] of [['exclude-site', 'excludeDomains'], ['force-site', 'forceDomains']]) {
  const button = document.getElementById(id);
  button.disabled = !hostname;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const settings = await loadSettings();
      await chrome.storage.sync.set({ [key]: [...new Set([...settings[key], hostname])] });
      window.close();
    } catch (e) {
      statusEl.textContent = `保存できませんでした。\n${e.message}`;
      button.disabled = false;
    }
  });
}

document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

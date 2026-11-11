import { loadSettings, normalizeSettings } from './shared/settings.js';
import { translate } from './llm.js';
import { createTranslationCache } from './cache.js';

const translationCache = createTranslationCache();
let cacheGeneration = 0;

const CONTENT_SCRIPTS = [
  'src/content/markup.js',
  'src/content/page-translator.js',
  'src/content/selection-popup.js',
  'src/content/main.js',
];

const BADGES = {
  idle: { text: '' },
  translating: { text: '…', color: '#6b7280' },
  translated: { text: '訳', color: '#2563eb' },
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'translate-page',
      title: 'このページを翻訳／原文に戻す',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: 'translate-selection',
      title: '選択した文章を翻訳',
      contexts: ['selection'],
    });
  });
});

// Tabs opened before the extension was installed or reloaded have no content script yet.
async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPTS });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

const COMMANDS = {
  'translate-page': (tab) => sendToTab(tab.id, { type: 'toggle-page' }),
  'translate-selection': (tab, info) =>
    sendToTab(tab.id, { type: 'translate-selection', text: info?.selectionText }),
};

function runCommand(command, tab, info) {
  if (!tab?.id || !COMMANDS[command]) return;
  COMMANDS[command](tab, info).catch((e) => console.warn(`${command}: ${e.message}`));
}

chrome.contextMenus.onClicked.addListener((info, tab) => runCommand(info.menuItemId, tab, info));
chrome.commands.onCommand.addListener((command, tab) => runCommand(command, tab));

let creatingOffscreen;
async function builtin(operation, settings, text) {
  if (!creatingOffscreen) {
    creatingOffscreen = (async () => {
      const url = chrome.runtime.getURL('src/offscreen/host.html');
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
      if (!contexts.length) {
        await chrome.offscreen.createDocument({
          url: 'src/offscreen/host.html', reasons: ['WORKERS', 'BLOBS'],
          justification: 'Run the local translation model and its WASM workers with an OPFS model cache.',
        });
      }
    })().finally(() => { creatingOffscreen = undefined; });
  }
  await creatingOffscreen;
  const result = await chrome.runtime.sendMessage({
    target: 'plamo-offscreen', operation, quant: settings.builtinModel, targetLang: settings.targetLang, text,
  });
  if (!result) throw new Error('内蔵エンジンから応答がありません');
  return result;
}

async function translateWithEngine(settings, text) {
  return settings.engine === 'builtin'
    ? builtin('translate', settings, text)
    : { ok: true, text: await translate(settings, text) };
}

function requireOptions(sender) {
  if (sender.url !== chrome.runtime.getURL('src/options/options.html')) throw new Error('設定ページから操作してください');
}

const HANDLERS = {
  async 'builtin-keepalive'(_message, sender) {
    if (sender.url !== chrome.runtime.getURL('src/offscreen/host.html')) throw new Error('不明な推論ホストです');
    return { ok: true };
  },
  async translate({ text }) {
    const settings = await loadSettings();
    if (!settings.cacheEnabled) return translateWithEngine(settings, text);
    const generation = cacheGeneration;
    try {
      const cached = await translationCache.get(settings, text);
      if (cached !== undefined) return { ok: true, text: cached };
    } catch (e) {
      console.warn(`Translation cache lookup: ${e.message}`);
    }
    const result = await translateWithEngine(settings, text);
    if (result.ok && typeof result.text === 'string' && generation === cacheGeneration) {
      try {
        await translationCache.set(settings, text, result.text);
      } catch (e) {
        console.warn(`Translation cache store: ${e.message}`);
      }
    }
    return result;
  },
  async 'translation-cache'({ operation }, sender) {
    requireOptions(sender);
    if (operation === 'clear') {
      cacheGeneration++;
      await translationCache.clear();
    } else if (operation !== 'status') {
      throw new Error('不明な翻訳キャッシュ操作です');
    }
    return { ok: true, count: await translationCache.count() };
  },
  async 'test-translate'({ settings, text }, sender) {
    requireOptions(sender);
    return translateWithEngine(normalizeSettings(settings), text);
  },
  async 'builtin-model'({ operation, quant }, sender) {
    requireOptions(sender);
    if (!['status', 'load', 'delete'].includes(operation)) throw new Error('不明な内蔵エンジン操作です');
    return builtin(operation, normalizeSettings({ builtinModel: quant }));
  },
  async 'get-settings'() {
    return { ok: true, settings: await loadSettings() };
  },
  async state({ state }, sender) {
    const badge = BADGES[state] ?? BADGES.idle;
    const tabId = sender.tab?.id;
    if (tabId != null) {
      await chrome.action.setBadgeText({ tabId, text: badge.text });
      if (badge.color) await chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color });
    }
    return { ok: true };
  },
  async 'open-options'() {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target) return false;
  const handler = HANDLERS[message?.type];
  if (!handler) return false;
  handler(message, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});

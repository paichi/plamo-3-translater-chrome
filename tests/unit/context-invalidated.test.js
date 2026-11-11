import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const mainScript = await readFile(new URL('../../src/content/main.js', import.meta.url), 'utf8');
const pageScript = await readFile(new URL('../../src/content/page-translator.js', import.meta.url), 'utf8');
const RELOAD_MESSAGE = '拡張機能が更新されました。ページを再読み込みしてください';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function loadMain() {
  let pageDeps;
  let selectionDeps;
  const chrome = {
    runtime: {
      id: 'test',
      sendMessage: async () => ({ ok: false }),
      onMessage: { addListener() {} },
    },
    storage: { onChanged: { addListener() {} } },
  };
  runInNewContext(mainScript, {
    chrome,
    document: {
      documentElement: { append() {} },
      createElement: () => ({ attachShadow: () => ({ append() {} }) }),
    },
    PlamoPageTranslator: {
      createStatusView: () => () => {},
      createPageTranslator(deps) { pageDeps = deps; return {}; },
    },
    PlamoSelectionPopup: {
      createSelectionPopup(_shadow, deps) { selectionDeps = deps; return {}; },
    },
  });
  assert.equal(pageDeps.translate, selectionDeps.translate, 'page and selection share error conversion');
  return { chrome, ...pageDeps };
}

const isInvalidated = (error) => error.message === RELOAD_MESSAGE && error.contextInvalidated === true;

test('translate converts missing runtime or runtime id without sending a message', async () => {
  for (const missingRuntime of [false, true]) {
    const { chrome, translate } = loadMain();
    chrome.runtime.sendMessage = () => assert.fail('must not send from a dead context');
    if (missingRuntime) delete chrome.runtime;
    else delete chrome.runtime.id;
    await assert.rejects(translate('Hello'), isInvalidated);
  }
});

test('translate converts synchronous and asynchronous context invalidation errors', async () => {
  const { chrome, translate, onUpdate } = loadMain();
  for (const asyncFailure of [false, true]) {
    chrome.runtime.sendMessage = () => {
      const error = new Error('Extension context invalidated.');
      if (asyncFailure) return Promise.reject(error);
      throw error;
    };
    await assert.rejects(translate('Hello'), isInvalidated);
  }
  chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated.'); };
  assert.doesNotThrow(() => onUpdate({ state: 'translated' }), 'state notifications must not throw either');
});

test('translate preserves other errors and successful responses', async () => {
  const { chrome, translate } = loadMain();
  const original = new Error('Connection failed');
  chrome.runtime.sendMessage = () => Promise.reject(original);
  await assert.rejects(translate('Hello'), (error) => error === original);
  chrome.runtime.sendMessage = () => { throw original; };
  await assert.rejects(translate('Hello'), (error) => error === original);
  chrome.runtime.sendMessage = async () => ({ ok: false, error: 'Server failed' });
  await assert.rejects(translate('Hello'), (error) => error.message === 'Server failed' && !error.contextInvalidated);
  chrome.runtime.sendMessage = async () => ({ ok: true, text: 'こんにちは' });
  assert.equal(await translate('Hello'), 'こんにちは');
});

function loadPage() {
  let reportIntersections;
  let intersectionDisconnects = 0;
  let mutationDisconnects = 0;
  const requests = [];
  const elements = Array.from({ length: 5 }, (_, i) => {
    const el = {
      nodeType: 1, localName: 'p',
      getAttribute: () => null,
      classList: { contains: () => false },
      getBoundingClientRect: () => ({ top: 0, bottom: 10 }),
    };
    el.childNodes = [{ nodeType: 3, nodeValue: `Sentence ${i}`, parentNode: el }];
    return el;
  });
  const body = {
    nodeType: 1, localName: 'body', childNodes: elements,
    getAttribute: () => null,
    classList: { contains: () => false },
  };
  const context = {
    document: { body, title: '' },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    innerHeight: 800,
    setTimeout, clearTimeout,
    IntersectionObserver: class {
      constructor(callback) { reportIntersections = callback; }
      observe() {}
      unobserve() {}
      disconnect() { intersectionDisconnects++; }
    },
    MutationObserver: class {
      observe() {}
      disconnect() { mutationDisconnects++; }
    },
    // Text-only segments: these tests exercise scheduling and errors, not DOM replacement.
    PlamoMarkup: {
      isInline: () => false,
      serialize: ([node]) => ({ source: node.nodeValue, text: node.nodeValue, tags: [] }),
    },
  };
  runInNewContext(pageScript, context);
  const page = context.PlamoPageTranslator.createPageTranslator({
    translate: (text) => new Promise((resolve, reject) => requests.push({ text, resolve, reject })),
    getSettings: () => ({ targetLang: 'ja', concurrency: 3 }),
    isOwnUi: () => false,
    onUpdate() {},
  });
  return {
    page, requests,
    report: (indices) => reportIntersections(indices.map((i) => ({ target: elements[i], isIntersecting: true }))),
    get disconnects() { return { intersectionDisconnects, mutationDisconnects }; },
    createStatusView: context.PlamoPageTranslator.createStatusView,
    document: context.document,
  };
}

test('context invalidation stops queued work, ignores in-flight failures and resets on restart', async () => {
  const harness = loadPage();
  const { page, requests, report } = harness;
  page.start();
  report([0, 1, 2, 3]);
  assert.equal(requests.length, 3);
  requests[0].reject(Object.assign(new Error(RELOAD_MESSAGE), { contextInvalidated: true }));
  await flush();
  assert.equal(page.status().failed, 0);
  assert.equal(page.status().error, RELOAD_MESSAGE);
  assert.deepEqual(harness.disconnects, { intersectionDisconnects: 1, mutationDisconnects: 1 });
  report([4]); // An already-queued observer callback must not restart translation.
  requests[1].reject(new Error('Another connection error'));
  requests[2].reject(new Error('Extension context invalidated.'));
  await flush();
  assert.equal(requests.length, 3, 'neither queued nor newly visible segments start');
  assert.equal(page.status().state, 'translated');
  assert.equal(page.status().failed, 0);
  assert.equal(page.status().error, RELOAD_MESSAGE);

  page.restore();
  page.start();
  assert.equal(page.status().error, '');
  report([0]);
  assert.equal(requests.length, 4);
  requests[3].reject(new Error('Normal failure after restart'));
  await flush();
  assert.equal(page.status().failed, 1);
  assert.equal(page.status().error, 'Normal failure after restart');
});

test('raw invalidation messages abort without counting a failure or erasing earlier failures', async () => {
  const { page, requests, report } = loadPage();
  page.start();
  report([0, 1, 2, 3, 4]);
  requests[0].reject(new Error('Normal failure'));
  await flush();
  assert.equal(page.status().failed, 1);
  assert.equal(requests.length, 4);
  requests[1].reject(new Error('Error: Extension context invalidated.'));
  await flush();
  requests[2].reject(new Error('Late failure'));
  requests[3].reject(new Error('Late failure'));
  await flush();
  assert.equal(requests.length, 4);
  assert.equal(page.status().failed, 1);
  assert.equal(page.status().error, RELOAD_MESSAGE);
});

test('failures from a previous run do not affect a restarted run', async () => {
  const { page, requests, report } = loadPage();
  page.start();
  report([0]);
  page.restore();
  page.start();
  requests[0].reject(new Error('Extension context invalidated.'));
  await flush();
  assert.equal(page.status().failed, 0);
  assert.equal(page.status().error, '');
  report([0]);
  assert.equal(requests.length, 2);
});

test('status view displays standalone guidance and retains the counted failure format', () => {
  const { createStatusView, document } = loadPage();
  const parts = Object.fromEntries(['.label', '.error', '.restore', '.close'].map((selector) => [
    selector, { addEventListener() {} },
  ]));
  document.createElement = () => ({ dataset: {}, querySelector: (selector) => parts[selector] });
  const render = createStatusView({ append() {} }, { onRestore() {} });
  render({ state: 'translated', done: 1, total: 5, failed: 0, error: RELOAD_MESSAGE });
  assert.equal(parts['.error'].textContent, RELOAD_MESSAGE);
  assert.equal(parts['.error'].title, RELOAD_MESSAGE);
  render({ state: 'translated', done: 1, total: 5, failed: 2, error: 'Connection failed' });
  assert.equal(parts['.error'].textContent, '2 件失敗: Connection failed');
  render({ state: 'translated', done: 1, total: 1, failed: 0, error: '' });
  assert.equal(parts['.error'].textContent, '');
});

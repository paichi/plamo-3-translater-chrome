import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { DEFAULTS, normalizeSettings } from '../../src/shared/settings.js';

const contentScript = await readFile(new URL('../../src/content/main.js', import.meta.url), 'utf8');

test('excluded domains are normalized, deduplicated and validated', () => {
  assert.deepEqual(DEFAULTS.excludeDomains, []);
  assert.deepEqual(normalizeSettings({ excludeDomains: [
    ' Example.COM ', '*.example.com', ' SUB.Example.COM ', '', '  ',
    'two words.com', 'tab\tname.com', 'https://example.com', 'example.com/path', null, 42,
  ] }).excludeDomains, ['example.com', 'sub.example.com']);
  for (const excludeDomains of [undefined, null, 'example.com', {}]) {
    assert.deepEqual(normalizeSettings({ excludeDomains }).excludeDomains, []);
  }
});

async function startPage(hostname, excludeDomains, {
  settings = {},
  text = 'An English sentence with enough text to trigger automatic translation. '.repeat(5),
  protocol = 'https:',
  topFrame = true,
  state = 'idle',
} = {}) {
  let autoCheck;
  let onMessage;
  let onChange;
  let toggles = 0;
  let selections = 0;
  const location = { hostname, protocol };
  const window = { location };
  window.top = topFrame ? window : {};
  runInNewContext(contentScript, {
    window,
    location,
    setTimeout(callback) { autoCheck = callback; },
    document: {
      body: { innerText: text },
      documentElement: { append() {} },
      createElement: () => ({ attachShadow: () => ({ append() {} }) }),
    },
    chrome: {
      runtime: {
        sendMessage: async () => ({ ok: true, settings: normalizeSettings({ excludeDomains, ...settings }) }),
        onMessage: { addListener(callback) { onMessage = callback; } },
      },
      storage: { onChanged: { addListener(callback) { onChange = callback; } } },
    },
    PlamoPageTranslator: {
      createStatusView: () => () => {},
      createPageTranslator: () => ({
        status: () => ({ state }),
        toggle() { toggles++; },
      }),
    },
    PlamoSelectionPopup: {
      createSelectionPopup: () => ({ translateSelection() { selections++; } }),
    },
  });
  await Promise.resolve();
  return {
    autoCheck: () => autoCheck(),
    manualTranslate: () => {
      onMessage({ type: 'toggle-page' }, {}, () => {});
      onMessage({ type: 'translate-selection', text: 'Hello' }, {}, () => {});
    },
    updateExclusions: (newValue) => onChange({ excludeDomains: { newValue } }, 'sync'),
    updateForced: (newValue) => onChange({ forceDomains: { newValue } }, 'sync'),
    get toggles() { return toggles; },
    get selections() { return selections; },
  };
}

test('auto-translate excludes exact domains and subdomains, not lookalikes', async () => {
  for (const hostname of ['example.com', 'SUB.Example.COM', 'deep.sub.example.com']) {
    const page = await startPage(hostname, ['example.com']);
    page.autoCheck();
    assert.equal(page.toggles, 0, hostname);
    page.manualTranslate();
    assert.equal(page.toggles, 1, 'manual page translation still works');
    assert.equal(page.selections, 1, 'selection translation still works');
  }
  for (const hostname of ['notexample.com', 'example.com.evil.test', 'other.test']) {
    const page = await startPage(hostname, ['example.com']);
    page.autoCheck();
    assert.equal(page.toggles, 1, hostname);
  }
});

test('auto-translate uses exclusions changed during its startup delay', async () => {
  const page = await startPage('example.com', []);
  page.updateExclusions(['example.com']);
  page.autoCheck();
  assert.equal(page.toggles, 0);
});

test('forced domains use the same normalization and validation as excluded domains', () => {
  const domains = [
    ' X.COM ', '*.x.com', ' SUB.Twitter.COM ', '', '  ',
    'two words.com', 'tab\tname.com', 'https://x.com', 'x.com/path', null, 42,
  ];
  const settings = normalizeSettings({ excludeDomains: domains, forceDomains: domains });
  assert.deepEqual(settings.forceDomains, ['x.com', 'sub.twitter.com']);
  assert.deepEqual(settings.forceDomains, settings.excludeDomains);
  for (const forceDomains of [undefined, null, 'x.com', {}, []]) {
    assert.deepEqual(normalizeSettings({ forceDomains }).forceDomains, []);
  }
});

test('forced domains default to X and Twitter when the setting is absent', async () => {
  assert.deepEqual(DEFAULTS.forceDomains, ['x.com', 'twitter.com']);
  assert.deepEqual(normalizeSettings({}).forceDomains, ['x.com', 'twitter.com']);
  assert.deepEqual(normalizeSettings().forceDomains, ['x.com', 'twitter.com']);
  for (const hostname of ['x.com', 'twitter.com']) {
    const page = await startPage(hostname, [], { text: '日本語の投稿ばかりです。'.repeat(30) });
    page.autoCheck();
    assert.equal(page.toggles, 1, hostname);
  }
});

test('forced domain matcher accepts exact domains and subdomains, not lookalikes', async () => {
  for (const hostname of ['example.com', 'SUB.Example.COM', 'deep.sub.example.com',
    'notexample.com', 'example.com.evil.test', 'other.test']) {
    const page = await startPage(hostname, [], {
      settings: { forceDomains: ['example.com'] }, text: '日本語が中心のページです。',
    });
    page.autoCheck();
    assert.equal(page.toggles, ['example.com', 'SUB.Example.COM', 'deep.sub.example.com'].includes(hostname) ? 1 : 0, hostname);
  }
});

test('forced domains bypass both language heuristics and the global auto-translate toggle', async () => {
  for (const autoTranslate of [true, false]) {
    for (const text of ['', 'Short English post.', '日本語の投稿です。'.repeat(30),
      'English text. '.repeat(20) + '日本語の投稿です。'.repeat(30)]) {
      const page = await startPage('x.com', [], { settings: { autoTranslate }, text });
      page.autoCheck();
      assert.equal(page.toggles, 1, `autoTranslate=${autoTranslate}, text=${text.slice(0, 30)}`);
    }
  }
});

test('exclusions take precedence over forced domains, including parent domain matches', async () => {
  for (const [hostname, excluded, forced] of [
    ['x.com', 'x.com', 'x.com'],
    ['sub.x.com', 'x.com', 'sub.x.com'],
    ['sub.x.com', 'sub.x.com', 'x.com'],
  ]) {
    const page = await startPage(hostname, [excluded], {
      settings: { forceDomains: [forced], autoTranslate: false }, text: '日本語の投稿です。',
    });
    page.autoCheck();
    assert.equal(page.toggles, 0, hostname);
    page.manualTranslate();
    assert.equal(page.toggles, 1, 'manual page translation still works');
    assert.equal(page.selections, 1, 'selection translation still works');
  }
});

test('forced domains still require top frame, HTTP(S), idle state and Japanese target', async () => {
  for (const options of [
    { topFrame: false }, { protocol: 'file:' }, { protocol: 'chrome:' },
    { state: 'translating' }, { state: 'translated' }, { settings: { targetLang: 'en' } },
  ]) {
    const page = await startPage('x.com', [], options);
    page.autoCheck();
    assert.equal(page.toggles, 0, JSON.stringify(options));
  }
  const page = await startPage('x.com', [], { protocol: 'http:', text: '日本語の投稿です。' });
  page.autoCheck();
  assert.equal(page.toggles, 1, 'HTTP is allowed too');
});

test('unforced domains retain the global toggle and page-language heuristics', async () => {
  for (const options of [
    { settings: { autoTranslate: false } },
    { text: 'Short English post.' },
    { text: '日本語の投稿です。'.repeat(30) },
    { text: 'English text. '.repeat(20) + '日本語の投稿です。'.repeat(30) },
    { text: '日本語の投稿です。'.repeat(500) + 'English text. '.repeat(20) },
  ]) {
    const page = await startPage('other.test', [], options);
    page.autoCheck();
    assert.equal(page.toggles, 0, JSON.stringify(options));
  }
});

test('auto-translate uses forced domains changed during its startup delay', async () => {
  const page = await startPage('example.com', [], {
    settings: { autoTranslate: false }, text: '日本語の投稿です。',
  });
  page.updateForced(['example.com']);
  page.autoCheck();
  assert.equal(page.toggles, 1);

  const removed = await startPage('x.com', [], { text: '日本語の投稿です。' });
  removed.updateForced([]);
  removed.autoCheck();
  assert.equal(removed.toggles, 0);

  const excluded = await startPage('x.com', [], { text: '日本語の投稿です。' });
  excluded.updateExclusions(['x.com']);
  excluded.autoCheck();
  assert.equal(excluded.toggles, 0);
});

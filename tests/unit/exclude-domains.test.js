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

async function startPage(hostname, excludeDomains) {
  let autoCheck;
  let onMessage;
  let onChange;
  let toggles = 0;
  let selections = 0;
  const location = { hostname, protocol: 'https:' };
  const window = { location };
  window.top = window;
  runInNewContext(contentScript, {
    window,
    location,
    setTimeout(callback) { autoCheck = callback; },
    document: {
      body: { innerText: 'An English sentence with enough text to trigger automatic translation. '.repeat(5) },
      documentElement: { append() {} },
      createElement: () => ({ attachShadow: () => ({ append() {} }) }),
    },
    chrome: {
      runtime: {
        sendMessage: async () => ({ ok: true, settings: normalizeSettings({ excludeDomains }) }),
        onMessage: { addListener(callback) { onMessage = callback; } },
      },
      storage: { onChanged: { addListener(callback) { onChange = callback; } } },
    },
    PlamoPageTranslator: {
      createStatusView: () => () => {},
      createPageTranslator: () => ({
        status: () => ({ state: 'idle' }),
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

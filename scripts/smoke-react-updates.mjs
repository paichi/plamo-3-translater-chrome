// Browser smoke: a React-ish volatile element (insert fresh text nodes into a
// persistent container) must never accumulate translations — the X "new posts"
// pill regression test.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const extension = path.resolve('.');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'plamo-smoke-react-'));
const failures = [];
const check = (ok, label) => {
  if (!ok) failures.push(label);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
};

const server = http.createServer(async (req, res) => {
  if (req.url === '/v1/chat/completions') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const content = JSON.parse(body).messages[0].content;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ choices: [{ message: { content: `訳:${content}` } }] }));
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="en"><head><title>react-updates</title></head><body>
<div id="pill">Show 0 new posts</div>
<script>
const pill = document.getElementById('pill');
const tracked = { pill: pill.firstChild };
let n = 0;
window.tick = () => {
  n++;
  const text = 'Show ' + n + ' new posts';
  const t2 = document.createTextNode(text);
  pill.insertBefore(t2, pill.firstChild);
  try { if (tracked.pill) pill.removeChild(tracked.pill); } catch (e) {}
  tracked.pill = t2;
};
</script>
</body></html>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext(profile, {
  executablePath: chromium.executablePath(), headless: true,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--no-sandbox', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/src/options/options.html`);
  await options.waitForFunction(() => !!document.querySelector('[name=baseUrl]')?.value);
  await options.fill('[name=baseUrl]', `${origin}/v1`);
  await options.uncheck('[name=autoTranslate]');
  await options.click('[type=submit]');
  await options.locator('#message.ok').waitFor();

  const page = await context.newPage();
  await page.goto(`${origin}/`);
  await page.locator('plamo-translator-ui').waitFor({ state: 'attached' });
  const [tab] = await worker.evaluate(async (url) => (await chrome.tabs.query({ url })).map((t) => t.id), page.url());
  await worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: 'toggle-page' }), tab);
  await page.locator('plamo-translator-ui .status .label', { hasText: /^翻訳済み$/ }).waitFor();

  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.tick());
    await page.waitForTimeout(1200);
  }
  const text = await page.evaluate(() => document.getElementById('pill').textContent);
  check(text === '訳:Show 4 new posts', `volatile pill holds exactly one latest translation (got ${JSON.stringify(text)})`);

  // restore must not resurrect wiped generations
  await worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: 'toggle-page' }), tab);
  await page.waitForTimeout(800);
  const restored = await page.evaluate(() => document.getElementById('pill').textContent);
  check(!restored.includes('Show 0 new posts'), `restore does not pile up stale generations (got ${JSON.stringify(restored)})`);
} finally {
  await context.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`smoke-react-updates: ${failures.length} FAILURE(S)`);
  process.exit(1);
}
console.log('smoke-react-updates: ALL PASS');

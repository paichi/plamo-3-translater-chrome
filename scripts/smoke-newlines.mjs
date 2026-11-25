// Line-break structure regression with a local OpenAI-compatible stub; no real LLM.
// The fixture mimics x.com: visible line breaks come from `\n` characters inside
// white-space-preserving text, not from <br> or block elements.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const extension = path.resolve(import.meta.dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'plamo-newlines-'));
const out = path.resolve(import.meta.dirname, '../tests/e2e/out');
fs.mkdirSync(out, { recursive: true });

const lines = [
  'DeepSeek Harness privacy alert: your conversations may be sent out',
  '',
  'I unpacked the installer and read the modules one by one.',
  '• Every message you send and every reply',
  '• The system prompt',
  'Mention @user end of the line',
  'final line',
];
const requests = [];
const server = http.createServer(async (req, res) => {
  if (req.url === '/v1/chat/completions') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const content = JSON.parse(body).messages[0].content;
    requests.push(content);
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ choices: [{ message: { content: `訳:${content}` } }] }));
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="en"><head><title>改行フィクスチャ</title></head><body>
<div data-testid="tweetText" style="white-space: break-spaces; width: 560px; font: 15px/1.4 sans-serif; border: 1px solid #ccc; padding: 12px;"><span>⚠️ ${lines[0]}

${lines[2]}
${lines[3]}
${lines[4]}
Mention <a href="/user" style="color:#1d9bf0">@user</a> end of the line
final line</span></div>
<p style="width: 560px;">This control paragraph
uses normal white-space, so its newlines
must collapse as before.</p>
</body></html>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.CHROMIUM_PATH
  ?? (fs.existsSync(chromium.executablePath()) ? chromium.executablePath() : '/opt/meta-chromium/chrome');

const context = await chromium.launchPersistentContext(profile, {
  executablePath, headless: true, ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--no-sandbox', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const id = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/src/options/options.html`);
  await options.waitForFunction(() => !!document.querySelector('[name=baseUrl]')?.value);
  await options.fill('[name=baseUrl]', `${origin}/v1`);
  await options.fill('[name=model]', 'mock-newline-model');
  await options.uncheck('[name=autoTranslate]');
  await options.click('[type=submit]');
  await options.locator('#message.ok', { hasText: '保存しました' }).waitFor();

  const page = await context.newPage();
  await page.goto(`${origin}/fixture`);
  await page.locator('plamo-translator-ui').waitFor({ state: 'attached' });

  const tweet = page.locator('[data-testid=tweetText]');
  const before = await tweet.evaluate((el) => ({ text: el.textContent, lines: el.innerText.split('\n').length }));
  assert.equal(before.text.split('\n').length - 1, 6, 'fixture sanity: 6 newline characters');

  const [tab] = await worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({ url });
    return tabs.map((t) => t.id);
  }, page.url());
  await worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: 'toggle-page' }), tab);
  await page.locator('plamo-translator-ui .status .label', { hasText: /^翻訳済み$/ }).waitFor();

  const nonEmptyLines = lines.filter((line) => line && !line.startsWith('Mention')).length + 1;
  const newlineRequests = requests.filter((r) => !r.includes('control paragraph'));
  assert.equal(newlineRequests.length, nonEmptyLines, 'one request per line');
  for (const request of newlineRequests) assert.ok(!request.includes('\n'), 'no newlines in requests');
  assert.equal(
    requests.filter((r) => r.includes('control paragraph')).length, 1,
    'control paragraph stays a single collapsed request',
  );

  const after = await tweet.evaluate((el) => ({ text: el.textContent, lines: el.innerText.split('\n').length }));
  assert.equal(after.text.split('\n').length - 1, 6, 'all 6 newline characters survive translation');
  assert.ok(after.text.includes('\n\n'), 'the blank line survives');
  assert.ok(after.text.startsWith('訳:'), 'lines are translated');
  assert.equal(await tweet.locator('a').count(), 1, 'the mention link element survives');
  assert.equal(after.lines, before.lines, 'rendered line count is preserved');
  console.log('PASS newline structure: lines translated separately, breaks and link preserved');
  console.log('---- translated textContent ----');
  console.log(after.text);
  console.log('--------------------------------');

  await page.screenshot({ path: path.join(out, 'newlines-translated.png') });

  await worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: 'toggle-page' }), tab);
  await page.waitForFunction(
    (original) => document.querySelector('[data-testid=tweetText]').textContent === original,
    before.text,
  );
  console.log('PASS restore returns the exact original text');
} finally {
  await context.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
console.log('smoke-newlines: ALL PASS');

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildPrompt, cleanCompletion, verifyTemplate, STOP_TOKENS } from '../../src/offscreen/prompt.js';
import { DEFAULTS, normalizeSettings } from '../../src/shared/settings.js';

const fixtures = JSON.parse(readFileSync(new URL('../fixtures/plamo-prompts.json', import.meta.url)));

test('single-user PFML3 matches golden renders of the real HF Jinja fixture', () => {
  // Golden outputs rendered using Python Jinja2 3.1.6, not buildPrompt.
  const template = readFileSync(new URL('../fixtures/plamo-chat-template.jinja', import.meta.url));
  assert.equal(createHash('sha256').update(template).digest('hex'),
    '633ae24b5166d2c958d9b0a39523f2cc5bd6832752ec2ab0285793cab6415323');
  for (const { text, targetLang, prompt } of fixtures) {
    assert.equal(buildPrompt(text, targetLang), prompt);
    assert.equal(prompt.split('<|plamo:bos|>').length, 2, 'one explicit BOS');
    assert.ok(prompt.includes(`<|plamo:msg|>${text}<|plamo:tag|>output`), 'whitespace and markup preserved');
    assert.ok(!prompt.includes('input<|plamo:key|>lang'), 'source auto: no source_lang field');
  }
});

test('GGUF template verification accepts official fixture and rejects unknown or missing templates', async () => {
  const template = readFileSync(new URL('../fixtures/plamo-chat-template.jinja', import.meta.url), 'utf8');
  await verifyTemplate(template);
  await verifyTemplate(template.replace(/\n/g, '\r\n').trim());
  await assert.rejects(verifyTemplate(null));
  await assert.rejects(verifyTemplate('invented chat template'));
});

test('template validation rejects empty text, reserved PFML and malformed language codes', () => {
  for (const text of ['', ' \n\t', null, '<|plamo:tag|>input']) assert.throws(() => buildPrompt(text, 'ja'));
  for (const lang of ['', 'auto', 'JA', 'en-US', 'zh-hans-extra', null, 'ja<|plamo:tag|>']) {
    assert.throws(() => buildPrompt('hello', lang));
  }
  assert.ok(buildPrompt('hello', 'ja-easy').includes('<|plamo:val|>ja-easy'));
});

test('all documented PFML3 stop tokens terminate output, earliest wins', () => {
  assert.deepEqual(STOP_TOKENS, ['</s>', '<|plamo:tag|>', '<|plamo:bos|>', '<|plamo:eos|>', '<|endoftext|>']);
  for (const stop of STOP_TOKENS) assert.equal(cleanCompletion(`  訳文。 ${stop}extra`), '訳文。');
  assert.equal(cleanCompletion('訳文<|endoftext|>bad</s>'), '訳文');
  assert.equal(cleanCompletion(' <g id="1">訳文</g> '), '<g id="1">訳文</g>');
  assert.throws(() => cleanCompletion(undefined));
  assert.throws(() => cleanCompletion('<|plamo:bos|>'));
});

test('builtin settings are opt-in and invalid quants normalize safely', () => {
  assert.equal(DEFAULTS.engine, 'server');
  assert.equal(normalizeSettings({}).builtinModel, 'Q4_K_M');
  for (const builtinModel of ['Q4_K_M', 'Q4_0', 'Q3_K_M', 'Q2_K']) {
    const settings = normalizeSettings({ engine: 'builtin', builtinModel, excludeDomains: ['Example.COM'] });
    assert.equal(settings.engine, 'builtin');
    assert.equal(settings.builtinModel, builtinModel);
    assert.deepEqual(settings.excludeDomains, ['example.com']);
  }
  assert.equal(normalizeSettings({ engine: 'other' }).engine, 'server');
  assert.equal(normalizeSettings({ builtinModel: '../../x' }).builtinModel, 'Q4_K_M');
});

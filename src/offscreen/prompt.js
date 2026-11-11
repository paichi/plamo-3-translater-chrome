// Exact single-user, target_lang-only subset of the upstream HF Jinja template.
// Fixture/provenance: tests/fixtures/plamo-chat-template.jinja and README.md.
// source_lang is deliberately absent (automatic detection), as in the server request.
export const STOP_TOKENS = Object.freeze([
  '</s>', '<|plamo:tag|>', '<|plamo:bos|>', '<|plamo:eos|>', '<|endoftext|>',
]);

// Refuse an unexpected GGUF template rather than silently use the wrong format.
// Hashes of normalized official HF and llama.cpp/GGUF templates at the pinned revisions.
export async function verifyTemplate(template) {
  if (typeof template !== 'string') throw new Error('GGUF にチャットテンプレートがありません');
  const bytes = new TextEncoder().encode(template.replace(/\r\n/g, '\n').trim());
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (![
    '03f1a1cbcd86da0258d7e6fe61e8e218df96027db5fb7e6ce4ac1c6e71b45597',
    '00ac74f045fd8456dd45c7fd4953b051e78108757062ef824bd2d92446938b72',
  ].includes(hash)) throw new Error('GGUF のチャットテンプレートが対応する公式版と一致しません');
}

export function buildPrompt(text, targetLang) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('message content must not be empty.');
  if (text.includes('<|plamo:')) throw new Error('message content must not contain reserved PFML tokens.');
  const lang = targetLang === 'ja(easy)' ? 'ja-easy' : targetLang;
  if (typeof lang !== 'string' || !/^[a-z]{2,3}(?:-[a-z]{4})?$/.test(lang)) {
    throw new Error('target_lang must be a lowercase language code, e.g. ja or zh-hans.');
  }
  return '<|plamo:bos|><|plamo:tag|>dataset<|plamo:msg|>translation'
    + '<|plamo:tag|>input<|plamo:msg|>' + text
    + '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>' + lang + '<|plamo:msg|>';
}

export function cleanCompletion(text) {
  if (typeof text !== 'string') throw new Error('応答に訳文が含まれていません');
  // Defensive stripping as well as the native stop list: never leak a PFML suffix.
  const end = STOP_TOKENS.reduce((end, token) => {
    const index = text.indexOf(token);
    return index < 0 ? end : Math.min(end, index);
  }, text.length);
  const result = text.slice(0, end).trim();
  if (!result) throw new Error('応答に訳文が含まれていません');
  return result;
}

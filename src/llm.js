export const LANGUAGES = [
  { code: 'ja', label: '日本語' },
  { code: 'en', label: '英語' },
  { code: 'zh-hans', label: '中国語（簡体字）' },
  { code: 'zh-hant', label: '中国語（繁体字）' },
  { code: 'ko', label: '韓国語' },
  { code: 'fr', label: 'フランス語' },
  { code: 'de', label: 'ドイツ語' },
  { code: 'es', label: 'スペイン語' },
];

export class ServerConnectionError extends Error {}

function headers(settings) {
  const h = { 'Content-Type': 'application/json' };
  if (settings.apiKey) h.Authorization = `Bearer ${settings.apiKey}`;
  return h;
}

async function request(url, init) {
  const signal = init.signal ?? AbortSignal.timeout(60_000);
  let res;
  try {
    res = await fetch(url, { ...init, signal });
    if (res.ok) return await res.json();
  } catch (e) {
    const timedOut = e.name === 'TimeoutError' || signal.reason?.name === 'TimeoutError';
    if (init.signal?.aborted || (!timedOut && !(e instanceof TypeError))) throw e;
    const reason = timedOut ? '応答がありません（60 秒）' : e.message;
    throw new ServerConnectionError(`${url} に接続できません: ${reason}`, { cause: e });
  }
  const detail = (await res.text().catch(() => '')).slice(0, 300);
  throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
}

export async function translate(settings, text, { signal } = {}) {
  const body = {
    ...(settings.model ? { model: settings.model } : {}),
    temperature: 0,
    messages: [{ role: 'user', content: text }],
    chat_template_kwargs: { target_lang: settings.targetLang },
  };
  const data = await request(`${settings.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(settings),
    body: JSON.stringify(body),
    signal,
  });
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('応答に訳文が含まれていません');
  return content.trim();
}

export async function listModels(settings) {
  const data = await request(`${settings.baseUrl}/models`, { headers: headers(settings) });
  return (data?.data ?? []).map((m) => m.id).filter(Boolean);
}

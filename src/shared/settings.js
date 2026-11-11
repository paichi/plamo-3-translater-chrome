export const BUILTIN_MODELS = ['Q4_K_M', 'Q4_0', 'Q3_K_M', 'Q2_K'];

export const DEFAULTS = Object.freeze({
  engine: 'server',
  builtinModel: 'Q4_K_M',
  baseUrl: 'http://localhost:8080/v1',
  apiKey: '',
  model: '',
  targetLang: 'ja',
  concurrency: 4,
  showSelectionButton: true,
  autoTranslate: true,
  cacheEnabled: true,
  excludeDomains: [],
});

export function normalizeSettings(raw) {
  const s = { ...DEFAULTS, ...raw };
  return {
    engine: s.engine === 'builtin' ? 'builtin' : DEFAULTS.engine,
    builtinModel: BUILTIN_MODELS.includes(s.builtinModel) ? s.builtinModel : DEFAULTS.builtinModel,
    baseUrl: String(s.baseUrl).trim().replace(/\/+$/, '') || DEFAULTS.baseUrl,
    apiKey: String(s.apiKey).trim(),
    model: String(s.model).trim(),
    targetLang: String(s.targetLang).trim().toLowerCase() || DEFAULTS.targetLang,
    concurrency: Math.min(16, Math.max(1, Math.round(Number(s.concurrency)) || DEFAULTS.concurrency)),
    showSelectionButton: s.showSelectionButton !== false,
    autoTranslate: s.autoTranslate !== false,
    cacheEnabled: s.cacheEnabled !== false,
    excludeDomains: [...new Set((Array.isArray(s.excludeDomains) ? s.excludeDomains : [])
      .filter((domain) => typeof domain === 'string')
      .map((domain) => domain.trim().toLowerCase().replace(/^\*\./, ''))
      .filter((domain) => domain && !/[\s/]/.test(domain)))],
  };
}

export async function loadSettings() {
  return normalizeSettings(await chrome.storage.sync.get(DEFAULTS));
}

export async function saveSettings(settings) {
  const normalized = normalizeSettings(settings);
  await chrome.storage.sync.set(normalized);
  return normalized;
}

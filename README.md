# PLaMo Translator (Chrome extension)

A Chrome extension (v0.5.0) that translates web pages in place with PLaMo: either through an OpenAI-compatible API (e.g. llama.cpp), or entirely inside Chrome using PLaMo 3 Translate 0.8B and wllama. The built-in engine requires Chrome 137 or later; server mode does not impose that new requirement.

- **Page translation.** Replaces the text of the current page with its translation. Links and bold text stay in place, and one click restores the original.
- **Selection translation.** Select some text and a small button with the extension's icon appears. Click it to open a card with the translation below the selection.

The extension's UI is in Japanese, so the labels below are quoted as they appear on screen, with an English gloss.

## Install

No build step is needed.

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this repository's folder (the one containing `manifest.json`).
4. Pin **PLaMo 翻訳** from the puzzle icon in the toolbar for quick access.

Tabs that were already open before installing also work from the popup, the context menu, and the keyboard shortcuts. The extension injects itself into the tab at that moment.

## Settings

Click the toolbar icon and choose **設定を開く** (Open settings), or open **Extension options** from **Details** on `chrome://extensions`.

| Setting | Description |
| --- | --- |
| Engine | **サーバー接続** (default) or **ブラウザ内蔵** (in-browser) |
| Built-in model | `Q4_K_M` (default), `Q4_0`, `Q3_K_M`, or `Q2_K` |
| API URL | Everything before `/chat/completions`, e.g. `http://localhost:8080/v1` |
| API key | Sent as `Authorization: Bearer` when not empty |
| Model | Omitted from requests when empty. **モデル一覧を取得** (Fetch models) lists the models from `GET /models` |
| Target language | Japanese by default |
| Concurrent requests | Maximum number of requests page translation sends at once (1 to 16, default 4) |
| Show translate button | When off, selecting text shows no button. The context menu and the shortcut still work |
| Translation cache | **翻訳キャッシュを使う**, on by default. Reuses saved segment translations for both engines |

Each request sends only the text to translate as the user message, and passes the target language as `chat_template_kwargs: { target_lang }` to the PLaMo chat template.

When you have filled in the form, click **選択エンジンの接続テスト** (Test selected engine) to translate a short English sentence using the current, **unsaved** form values, then click **保存** (Save). Server fields remain editable in either mode; their URL/key/model are never used by built-in inference.

### Persistent translation cache

Page, automatic and selection translation share a background IndexedDB cache (`plamo-translate-cache`, store `segments`). Re-visiting a page reuses matching segments without calling the engine; only new/changed segments need translation. Keys are SHA-256 of a versioned JSON tuple containing the **exact source text**, target language and engine identity (server URL + model, or builtin + quantization), never the page URL. Inline markup is part of the source text. Entries contain the source, translation, target language, engine identity and last-used timestamp. Successful results only are cached; connection tests deliberately bypass the cache.

The cache survives browser/extension restarts and does not sync. Hits refresh last-used time; atomic writes evict the least-recently-used entries above **20,000**. In options, **翻訳キャッシュ** shows the count and **翻訳キャッシュを削除** clears saved translations after confirmation (separate from the built-in model cache). Disabling the checkbox and saving skips both cache reads and writes, but does not delete saved entries. The existing content-side memory cache is unchanged; reload a page when testing disabled/cleared persistent caching.

**Privacy/storage:** source text and translations are stored locally in the browser profile, so clear the cache on shared browsers when appropriate. No `unlimitedStorage` permission is requested: this bounded, disposable cache uses normal IndexedDB quota and falls back to translation if storage fails. The entry cap is not a byte limit; browser storage pressure/uninstall can remove entries. If you replace a model behind the same server URL/model name, clear translations manually (the server identity has not changed).

### Browser built-in engine

1. Select **ブラウザ内蔵** and a quantization. `Q4_K_M` favors quality; smaller quants reduce download/memory costs, potentially reducing quality.
2. Click **ダウンロード／読み込み**. The first use downloads several hundred MB from [pfnet/plamo-3-translate-0.8b-GGUF](https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF). Status reports not downloaded, download progress, cached, loading, ready, or errors. Translation/test also loads lazily if needed.
3. Test and save. Page translation, automatic translation and selection translation use the same background route as server mode. No text is sent to Hugging Face or an inference server; HF only serves model data.
4. **選択モデルのキャッシュを削除** unloads the selected model and deletes its OPFS files. Other quants remain cached. Changes are serialized behind pending translations; the buttons are disabled while work is pending.

The model cache is private to the extension's origin/browser profile. Completed downloads are reused **without any network request** (loading into memory still takes time; it is not instantaneous). A completion marker plus size check prevents partial downloads being reused. Reloading the extension/browser loses the in-memory model, not the cache. Uninstalling/clearing site storage may remove the cache; downloads can fail if disk quota is exhausted. Only one model is in memory; changing quants unloads it. Normal settings use sync storage, but models do not sync.

**Runtime limits:** wllama **3.13.0 does contain WebGPU support**; this is verified from the actual package/API, not assumed from the reference extension. We try a WebGPU adapter and automatic layer offloading, retrying with `n_gpu_layers: 0` on load failure. With no usable GPU, inference uses WASM/CPU. Actual GPU offloading/performance depends on the browser, adapter and available memory and has not been verified here. The status “WebGPU 自動選択” indicates an attempted automatic backend, not measured GPU use. This MV3 adaptation intentionally uses **one worker/CPU thread**, so CPU-only page translation can be slow. JSPI/Memory64-capable Chrome is required; no CDN compatibility scripts are downloaded. The context is 4,096 tokens, output is limited to 2,048 tokens, and generation has a 180-second timeout. Long inputs, low-memory devices, GPU loss, unsupported model operations, or interrupted browser/service-worker lifetimes may fail; errors surface normally. Use shorter text or server mode. Increasing page concurrency queues requests; it does not run multiple built-in inferences in parallel. Initial download timeout is 240 seconds; preload from options for large pages. While the inference queue is nonempty, a 20-second offscreen heartbeat prevents ordinary MV3 service-worker idle termination even with options closed; it stops when the queue drains. This is not a workaround for Chrome's per-event lifetime limits (typically five minutes), browser shutdown, extension reload or crashes: very long queued requests can still lose their response.

## Usage

### Page translation

Start it in any of these ways. Doing the same again restores the original.

- Click the toolbar icon, then **このページを翻訳** (Translate this page)
- Choose **このページを翻訳／原文に戻す** (Translate this page / Restore original) from the page's context menu
- Press `Alt+Shift+T`

Only text near the screen is translated, starting with the paragraphs currently in view. As you scroll, the text further down gets translated too. Text the page adds after translation starts is translated as well. A small panel at the bottom right shows progress and a **原文に戻す** (Restore original) button.

The following is never translated.

- `pre`, `script`, `style`, `textarea`, form fields, and editable regions
- Elements with `translate="no"` or the `notranslate` class
- Text that contains kana when the target language is Japanese (it is already Japanese)
- The contents of inline `code`, `kbd`, `samp`, and `var` (the surrounding sentence is translated and these parts stay as written)

### Selection translation

Select some text and a button with the extension's icon appears at the bottom right of the selection. Click it to open a card with the translation below the selection. **コピー** (Copy) on the card copies the translation.

You can also open the card with **選択した文章を翻訳** (Translate selected text) in the context menu or with `Alt+Shift+S`. The card closes on `Escape`, on a click outside it, or on a new selection.

Change the shortcuts at `chrome://extensions/shortcuts`.

## Tests

```sh
npm install
npx playwright install chromium
npm test
npm run e2e
```

- `npm test` covers inline markup, domain exclusions, settings, real-template golden prompt renders and stop tokens, and the offscreen queue/cache/failure recovery using mocked inference + in-memory OPFS (not real model inference). Translation-cache tests exercise key separation, get/set, LRU eviction, concurrency and clearing against `fake-indexeddb`, plus background routing/error/disabled-storage behavior.
- `npm run e2e` loads the extension into Playwright's Chromium, opens `tests/e2e/fixture.html`, and runs these against a real LLM: the connection test on the options page, page translation, restoring the original, and selection translation. Page translation covers sentences whose tags the model tends to break, a paragraph inside a closed `details`, and scrolling to the end of a long page. Pass the LLM URL in `LLM_BASE_URL` (default `http://100.64.114.83:8891/v1`). Screenshots of the translated page and the selection card are saved to `tests/e2e/out/`. Set `HEADED=1` to watch the browser.

```sh
LLM_BASE_URL=http://localhost:8080/v1 npm run e2e
```

`npm run measure-tags` sends 20 sentences containing inline elements to the LLM. It prints how many sentences came back with their tags intact and how many tags could be read from the translations, as `intact sentences N/20, tags kept K/M`. It also prints the broken translations.

`npm run smoke` translates real pages in Chromium with the extension loaded. It reports the elapsed seconds and the visible paragraphs left untranslated, once at the top of the page and once after scrolling to the end. By default it opens one Wikipedia page and one MDN page. Pass other URLs as arguments. Screenshots are saved to `tests/e2e/out/`.

```sh
npm run smoke -- https://example.com/article
```

`LLM_BASE_URL` also sets the LLM URL for `npm run measure-tags` and `npm run smoke`. `LLM_MODEL` sets the model name for `npm run smoke` (default `plamo-3-translate-0.8b`).

The icon source is `icons/icon.svg`. `npm run icons` renders it into the PNG sizes `manifest.json` uses, with Playwright's Chromium. The selection button draws the same SVG from a copy in `src/content/selection-popup.js`, so update both when the icon changes.

### Persistent-cache browser smoke (local mock server, no real LLM)

```sh
CHROMIUM_PATH=/path/to/chrome npm run smoke:cache
```

Uses a disposable profile and checks initial requests, zero requests on reload and full browser restart, exactly one request for a changed paragraph at the same URL, selection/automatic cache hits, full requests with caching disabled, count/confirm-clear controls, and real IndexedDB eviction at 20,000 entries. Verified with standard Chromium in this VM; this validates cache behavior, not real-model inference or latency guarantees.

### Standalone browser/offscreen smoke (no LLM server needed)

```sh
CHROMIUM_PATH=/path/to/chrome npm run smoke:builtin
# Optional several-hundred-MB download + one real sentence, only after a successful browser HF probe:
REAL_MODEL=1 CHROMIUM_PATH=/path/to/chrome npm run smoke:builtin
```

This uses a disposable profile **beside the repository, not on /tmp tmpfs**, and removes it on exit. It checks the server API payload with a local mock, options/model listing, manual/automatic page translation, restore, selection, builtin unsaved-engine routing, concurrent offscreen creation, and real OPFS deletion. A tiny invalid cached GGUF exercises the static worker/WASM initialization and error cleanup; it does **not** count as successful inference. A browser-side HF probe gates the optional real-model test, bounded to 240 seconds. `HTTPS_PROXY` is supported with credentials (never printed), but some proxies reject Chromium CONNECT requests. `ignoreHTTPSErrors` is for this disposable verification browser only; the extension does not relax TLS validation. The fallback system browser path is `/opt/meta-chromium/chrome`; set `CHROMIUM_PATH` for other installations.

Verified in this VM with Playwright Chromium **156.0.8078.4**:

- Standalone offline/mock smoke passed, including native worker/WASM initialization on invalid GGUF, selected-engine error routing and cache deletion. Its HF probe failed with the direct authenticated proxy configuration.
- A **separate browser verification**, using a temporary local CONNECT bridge that injected the environment proxy's authentication, successfully reached HF and downloaded the real **410,138,816-byte Q2_K** into OPFS. Actual CPU/WASM inference translated `The sky is blue.` → `空は青い。` in **57.269 seconds**, including first download/load. This disposable test browser alone used `--ignore-certificate-errors` for the VM's MITM CA; no such bypass is in the extension.
- After browser restart, the cached model translated the same sentence in **18.064 seconds** without downloading. After another restart with **`context.setOffline(true)` before model loading**, the cached model and actual GGUF-template verification worked completely offline, producing the same result in **19.67 seconds**.
- A further real Q2_K run with **saved builtin settings and the normal `translate` message path** passed manual page translation of a small local five-sentence fixture, exact restoration, selection translation (`The sky is blue.` → `空は青い。`), and automatic page translation of that fixture. This was not a broad test of real internet pages.
- **GPU execution was not verified** (no usable adapter); other quants/languages were not exercised. The timings above are one-sentence VM measurements, not performance guarantees.

Playwright's normal browser downloader timed out; the system Muse browser required a platform-specific startup policy, so a separately downloaded standard Playwright Chromium was used. `npm test`, JS syntax checks and `git diff --check` also pass.

## Vendored runtime and prompt provenance

- Runtime: [`@wllama/wllama` **3.13.0**](https://www.npmjs.com/package/@wllama/wllama/v/3.13.0), obtained with `npm pack @wllama/wllama@3.13.0`. npm integrity: `sha512-ZvoRdQAn+E+18EvQ9qS036gudiI9rbZRBJgG/qNICPPwrA0Y6SMMdbziz/j7K/0WxcbJlhaRraVIYsnEy732NA==`.
- `vendor/wllama/index.js`: package `esm/index.js`, patched for MV3 static workers. `vendor/wllama/wasm/wllama.wasm`: **unmodified** `esm/wasm/wllama.wasm` (SHA-256 `79ac5be917b71d50571a4f584436a9f6baf6b6e57719d094ed8bd950e9a65780`). No source maps, CJS, TypeScript, CDN loader, or build tooling are required at runtime.
- `vendor/wllama/llama-worker.js` and `opfs-worker.js`: extracted from the package's `src/workers-code/generated.ts` string constants. The llama worker statically wraps the shipped Emscripten JS, receives bootstrap options through the initial message, and supports CPU-only initialization. The entry uses packaged worker URLs; unexpected dynamic workers, pthreads, external worker overrides and compatibility runtimes are rejected. **Chrome MV3 forbids Blob workers**: simply adding `worker-src blob:` makes the extension fail to load. No Blob script, eval, sandbox, remote executable code or web-accessible resources are used by this adaptation. The manifest only needs `offscreen`, `wasm-unsafe-eval`, and same-origin workers.
- Reproduce these changes without a bundler: unpack the npm tarball, then run `node scripts/vendor-wllama.mjs /path/to/package`. This is a maintainer vendoring step, **not an install/application build**. Keep the checked-in vendor files for Load unpacked.
- `vendor/wllama/LICENSE`: the npm tarball's `package/LICENCE` (MIT, copyright Xuan Son NGUYEN), copied automatically by the vendoring script. SHA-256: `5866e3bd7e3cbd3f7c8bea6efd8a1e7fa7cc8de68c30f428aff7c6584a0fb720`, matching the existing vendored license and the matching upstream git checkout. npm records git commit `6647c1ea3837b2f0205a300c3bf5ff644aaa06bf` in `ngxson/wllama`.
- Model data is not bundled. URLs are pinned to GGUF revision **`1cf96ae02133958a20074bfdfab76517bb737d00`**, filename `plamo-3-translate-0.8b-{quant}.gguf`. See the HF model's [license](https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/tree/1cf96ae02133958a20074bfdfab76517bb737d00/LICENSE) and usage terms.
- `tests/fixtures/plamo-chat-template.jinja` is the **unmodified official** [HF template](https://huggingface.co/pfnet/plamo-3-translate-0.8b/blob/8b4d42855622093e610ba9b90c2d2b59f8d5c15d/chat_template.jinja) at base-model revision `8b4d42855622093e610ba9b90c2d2b59f8d5c15d`. BOS comes from that revision's `tokenizer_config.json`: `<|plamo:bos|>`. The renderer implements precisely our server request's subset: **one user message, explicit `target_lang`, no source language/context/glossary/form**. It preserves text whitespace, maps `ja(easy)` to `ja-easy`, and rejects invalid languages/reserved PFML. It is not a general-purpose Jinja interpreter.
- After loading, we **read the actual GGUF chat-template metadata using `getChatTemplate()` and verify it** against the normalized SHA-256 of either the pinned official HF or GGUF/llama.cpp template before inference. Unknown/missing templates fail clearly. The pinned GGUF template renders the same single-user/explicit-target subset. Hashes (CRLF normalized, outer whitespace trimmed): HF `03f1a1cbcd86da0258d7e6fe61e8e218df96027db5fb7e6ce4ac1c6e71b45597`; GGUF `00ac74f045fd8456dd45c7fd4953b051e78108757062ef824bd2d92446938b72`.
- `tests/fixtures/plamo-prompts.json` contains independent golden outputs rendered with **Python Jinja2 3.1.6**, `messages=[{role:'user', content:text}]`, `target_lang=targetLang`, `bos_token='<|plamo:bos|>'`, `add_generation_prompt=True`. Unit tests compare our renderer byte-for-byte, including whitespace/markup, source auto and target-language aliasing. Native completion receives all documented stops: `</s>`, `<|plamo:tag|>`, `<|plamo:bos|>`, `<|plamo:eos|>`, `<|endoftext|>`; defensive output stripping also uses the earliest stop.
- The [PLaMo_Translate_EX README](https://github.com/highants/PLaMo_Translate_EX) was consulted for the Mode B approach. Application/host code here is independently written; the runtime, license and official template are the copied upstream material listed above.

## Files

The design is described in [docs/design.md](docs/design.md).

| File | Role |
| --- | --- |
| `manifest.json` | Permissions, content scripts, commands |
| `src/background.js` | Service worker: LLM calls, context menu, shortcuts, badge |
| `src/llm.js` | Builds requests to the OpenAI-compatible API and reads the responses (unchanged server transport) |
| `src/cache.js` | Versioned segment keys, persistent IndexedDB translations and LRU eviction |
| `src/offscreen/` | Serialized model host, OPFS cache, PFML3 renderer and metadata verification |
| `vendor/wllama/` | Packaged ESM, static workers, WASM and license |
| `src/shared/settings.js` | Setting defaults, reading and writing |
| `src/content/markup.js` | Conversion between inline elements and tag strings |
| `src/content/page-translator.js` | Page translation and the progress panel at the bottom right |
| `src/content/selection-popup.js` | Selection translation UI |
| `src/content/main.js` | Content script entry point and message handlers |
| `src/popup/` | Toolbar popup |
| `src/options/` | Options page |

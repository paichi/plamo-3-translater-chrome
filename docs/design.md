# Design

A Manifest V3 Chrome extension. There is no build step. The sources are loaded as they are, as an unpacked extension.

## Features

1. **Page translation.** Replaces the text of the current page in place with its translation into the configured target language (Japanese by default). The original can be restored.
2. **Selection translation.** Selecting text shows a small translate button at the bottom right of the selection. Clicking it opens a card with the translation below the selection, the same flow as the DeepL extension. The context menu and a shortcut open it too.
3. **Options page.** Sets the API URL, API key, model name, target language, number of concurrent requests, and whether the selection button is shown.

The translation model is a PLaMo translation model served through an OpenAI-compatible API (for example llama.cpp). Other chat models are not supported.

## Structure

| File | Role |
| --- | --- |
| `manifest.json` | Permissions, content scripts, commands |
| `src/shared/settings.js` | Setting defaults and loading. An ES module imported by the background and the options page |
| `src/background.js` | Service worker: LLM calls, context menu, shortcuts, badge |
| `src/llm.js` | Builds requests to the OpenAI-compatible API and reads the responses |
| `src/content/markup.js` | Conversion between inline elements and tag strings (pure functions, tested with node) |
| `src/content/page-translator.js` | Page translation |
| `src/content/selection-popup.js` | Selection translation UI (Shadow DOM) |
| `src/content/main.js` | Content script entry point and message handlers |
| `src/popup/` | Toolbar popup (start or undo page translation, link to the options page) |
| `src/options/` | Options page |

Content scripts cannot be loaded as modules. They are listed in order in `content_scripts.js` of `manifest.json` and share globals in the same isolated world.

## Talking to the LLM

Only the service worker talks to the LLM. A content script sends `chrome.runtime.sendMessage({ type: 'translate', text })` and receives `{ ok: true, text }` or `{ ok: false, error }`. This keeps requests free of the page's CSP and mixed-content restrictions.

`POST {baseUrl}/chat/completions` receives `messages: [{ role: 'user', content: text }]`, `chat_template_kwargs: { target_lang }`, and `temperature: 0`, plus `model` when one is set.

What the PLaMo translation model (served by llama.cpp) does:

- A leading system message is ignored. The chat template raises an error unless the messages end with a user message.
- `target_lang` is a lowercase language code such as `ja`, `en`, or `zh-hans`.
- Tags of the form `<g id="0">…</g>` mostly survive. With nested tags, the inner opening tag is sometimes dropped while its closing tag remains.

## Page translation

### Unit of translation

The unit of translation (Segment) is a run of consecutive inline nodes inside one parent.

```js
/** @typedef {{ nodes: Node[], parent: Element, source: string, tags: Element[], lead: boolean, trail: boolean }} Segment */
```

- `nodes` are consecutive text nodes and inline elements directly under the parent. A run of whitespace only is not a unit.
- An inline element is one whose tag name is in the inline table and whose descendants are all text or inline elements. An element containing a block, such as `<a><div>…</div></a>`, is not treated as inline. The walk descends into it instead.
- Elements without text, such as `br`, `img`, and `input`, split a run.
- In elements whose computed `white-space` preserves newlines (`pre`, `pre-wrap`, `pre-line`, `break-spaces`), newline characters split a run too: text nodes are cut at each newline, the newline-only nodes stay in place untranslated, and each line becomes its own unit. An inline element containing newlines is then not treated as inline either; the walk descends into it (except `code`, `kbd`, `samp`, and `var`, which are always kept whole). Sites like x.com render line breaks from newline characters rather than `<br>`, and the model cannot be trusted to reproduce them — whitespace collapses before translation — so they are kept out of the translated text entirely.
- Nothing is translated inside `script`, `style`, `noscript`, `textarea`, `pre`, `code` (when it stands alone as a block), `svg`, `math`, `contenteditable`, `translate="no"`, `.notranslate`, or the extension's own UI.

### Tag strings

`markup.js` turns a Segment into a tagged string (`serialize`). Inline elements are numbered in order of appearance and wrapped in `<g id="0">…</g>`. Closing tags carry no number. Runs of whitespace collapse to one space, and `lead` and `trail` record whether there was whitespace at the start and end.

`parse` turns the translation back into a tree. Small models often break nested tags while translating the sentence well, so the parser uses as many tags as it can read instead of rejecting the translation.

- `</g>` closes the innermost open tag. It is ignored when no tag is open.
- An opening tag with an unknown number, or with a number already seen, is ignored.
- A tag still open at the end is unwrapped, and its contents move to its parent.
- An element whose tag never appears is not rebuilt. The words the model translated remain as plain text.
- Tag-like text is never left in the output, including malformed forms such as `<g>` or `<g id=1>`.

`parse` returns the tree, the number of tags that could not be rebuilt (`dropped`), and the number of tags it ignored (`ignored`). `build` creates nodes from the tree. It makes a shallow copy of each original element (`cloneNode(false)`) to keep attributes such as `href`, and fills it with the translated contents. `code`, `kbd`, `samp`, and `var` are not translated. A deep copy of the original element is used instead. When the model breaks a tag, only that tag's formatting or link is lost. The sentence stays one connected translation.

### Scheduling

- Only Segments near the screen are translated. An `IntersectionObserver` (with a `rootMargin` of one screen height) watches each Segment's parent and queues the Segments that come into range. Segments that are not displayed, such as those inside a closed `details`, are queued when they become visible. The progress total is the number of Segments queued.
- The next Segment taken from the queue is the one whose parent is closest to the screen (distance 0 when on screen). After scrolling, the paragraph in view is translated before the ones prefetched earlier.
- At most `concurrency` requests run at once (default 16).
- When the target language is Japanese, Segments that contain kana are not translated. Segments without letters (`\p{L}`) are not translated either.
- Translations of identical source text are reused through a per-page `Map`.
- DOM added while translation is on is picked up by a `MutationObserver`. Nodes the extension inserted are remembered in a `WeakSet` and skipped.
- `document.title` is translated too.
- Restoring removes the inserted nodes and puts the saved original nodes back in the same place. The originals are kept as they are, not copied, so their event listeners survive.
- There are three states: `idle`, `translating`, and `translated`. The state is shown by the toolbar badge and by a small panel at the bottom right of the page (progress and a restore button). Until the `IntersectionObserver` first reports, the state is `translating`, because the queue is still empty at that point and would otherwise read as finished.

## Selection translation

- If there is a selection after `mouseup`, a translate button showing the extension's icon appears at the bottom right of the selection's last rectangle. The icon's SVG is written into the content script instead of loaded from `icons/`, because loading it would require listing the file in `web_accessible_resources`, which lets any page detect the extension. Selections inside form fields and inside the extension's UI are ignored.
- Clicking the button opens a card below the selection with the translation, a copy button, and a close button. It shows a loading state while waiting. On failure it shows the reason and a link to the options page.
- A long selection is split into paragraphs at blank lines and translated in chunks of about 1500 characters, one after another, then joined.
- `Escape`, a click outside the card, or a new selection closes it. Scrolling does not close it, and it stays attached to the selection.
- The UI lives in Shadow DOM, so the page's CSS does not affect it. It supports both light and dark color schemes.

## Settings

Stored in `chrome.storage.sync`.

| Key | Default |
| --- | --- |
| `baseUrl` | `http://127.0.0.1:18080/v1` |
| `apiKey` | Empty. Sent as `Authorization: Bearer` when not empty |
| `model` | `plamo-08b` for the default local URL. When empty, `model` is not sent (llama.cpp uses the loaded model) |
| `targetLang` | `ja` |
| `concurrency` | `16` |
| `showSelectionButton` | `true` |

The options page has a button that fetches the model list (`GET {baseUrl}/models`) and a connection test button (translates a short English sentence).

In server mode, normal translation uses the built-in model on a network error or timeout. The result is cached under the built-in model's key, so subsequent uncached requests still try the server. The connection test reports the selected engine's result directly.

## Verification

- `npm test` runs the unit tests for `markup.js`.
- `npm run e2e` loads the extension into Playwright's Chromium, opens a test page, and runs page translation, restoring the original, and selection translation against a real LLM. For page translation it checks sentences whose tags the model tends to break, a paragraph inside a closed `details`, that the paragraph in view is translated first after scrolling to the end of a long page, and that no tag-like text shows on screen. The LLM URL comes from the `LLM_BASE_URL` environment variable.
- `npm run measure-tags` sends 20 sentences containing inline elements to the LLM the same way the extension does. It prints how many sentences came back with their tags intact and how many tags `parse` kept. Use it as the yardstick when changing the tag format or `parse`.
- `npm run smoke` translates real pages in Chromium with the extension loaded (one Wikipedia page and one MDN page by default, or URLs passed as arguments). It prints the seconds until the page reaches `translated`, the number of visible `<p>` left untranslated, and page errors, once at the top of the page and once after scrolling to the end. It also checks that restoring works, and saves screenshots to `tests/e2e/out/`.

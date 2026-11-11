(() => {
  const { serialize, parse, build, isInline } = globalThis.PlamoMarkup;

  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'textarea', 'pre', 'svg', 'math', 'template', 'iframe',
    'canvas', 'video', 'audio', 'select', 'input', 'object', 'head',
  ]);
  const EXCLUDED_SELECTOR =
    'script,style,noscript,textarea,pre,svg,math,template,[translate="no"],.notranslate';
  const LETTER = /\p{L}/u;
  const KANA = /[ぁ-ヿ]/;

  /** @typedef {{ nodes: Node[], parent: Element, source: string, tags: Element[], lead: boolean, trail: boolean }} Segment */
  /** @typedef {'idle' | 'translating' | 'translated'} PageState */

  /**
   * @param {{
   *   translate: (text: string) => Promise<string>,
   *   getSettings: () => { targetLang: string, concurrency: number },
   *   isOwnUi: (node: Node) => boolean,
   *   onUpdate: (status: { state: PageState, done: number, total: number, failed: number, error: string }) => void,
   * }} deps
   */
  function createPageTranslator({ translate, getSettings, isOwnUi, onUpdate }) {
    let active = false;
    let contextInvalidated = false;
    let generation = 0;
    let claimed = new WeakSet();
    let inserted = new WeakSet();
    let records = [];
    let pendingByParent = new Map();
    let queue = [];
    let running = 0;
    // The queue stays empty until the observer's first report, which would read as finished.
    let awaitingFirstReport = false;
    let progress = { done: 0, total: 0, failed: 0, error: '' };
    let originalTitle = null;
    let mutationRoots = new Set();
    let mutationTimer = 0;
    const cache = new Map();

    const intersection = new IntersectionObserver(
      (entries) => {
        if (!active || contextInvalidated) return;
        awaitingFirstReport = false;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          intersection.unobserve(entry.target);
          const segments = pendingByParent.get(entry.target) ?? [];
          pendingByParent.delete(entry.target);
          queue.push(...segments);
          progress.total += segments.length;
        }
        pump();
      },
      { rootMargin: '100% 0px' },
    );

    const mutations = new MutationObserver((list) => {
      for (const record of list) {
        if (record.type !== 'childList') continue;
        const fresh = [...record.addedNodes].some((n) => !inserted.has(n) && !isOwnUi(n));
        if (fresh) mutationRoots.add(record.target);
      }
      if (mutationRoots.size && !mutationTimer) mutationTimer = setTimeout(flushMutations, 200);
    });

    function state() {
      if (!active) return 'idle';
      return running || queue.length || awaitingFirstReport ? 'translating' : 'translated';
    }

    function update() {
      onUpdate({ state: state(), ...progress });
    }

    function cached(text) {
      if (!cache.has(text)) {
        cache.set(
          text,
          translate(text).catch((e) => {
            cache.delete(text);
            throw e;
          }),
        );
      }
      return cache.get(text);
    }

    function shouldTranslate(text) {
      if (!LETTER.test(text)) return false;
      return !(getSettings().targetLang === 'ja' && KANA.test(text));
    }

    function canEnter(el) {
      return !(
        SKIP_TAGS.has(el.localName) ||
        el.getAttribute('translate') === 'no' ||
        el.classList.contains('notranslate') ||
        el.isContentEditable ||
        inserted.has(el) ||
        isOwnUi(el)
      );
    }

    function isAllowedRoot(el) {
      for (let n = el; n; n = n.parentElement) {
        if (inserted.has(n) || isOwnUi(n)) return false;
      }
      return !el.closest(EXCLUDED_SELECTOR) && !el.isContentEditable;
    }

    /** @param {Element} el @param {Segment[]} out */
    function collect(el, out) {
      if (!canEnter(el)) return;
      let run = [];
      const flush = () => {
        if (run.length) addSegment(el, run, out);
        run = [];
      };
      for (const child of el.childNodes) {
        if (claimed.has(child) || inserted.has(child)) {
          flush();
        } else if (child.nodeType === Node.TEXT_NODE) {
          run.push(child);
        } else if (child.nodeType === Node.ELEMENT_NODE && isInline(child) && !isOwnUi(child)) {
          run.push(child);
        } else {
          flush();
          if (child.nodeType === Node.ELEMENT_NODE) collect(child, out);
        }
      }
      flush();
    }

    function addSegment(parent, nodes, out) {
      const { source, tags, text, lead, trail } = serialize(nodes);
      if (!shouldTranslate(text)) return;
      nodes.forEach((n) => claimed.add(n));
      out.push({ nodes, parent, source, tags, lead, trail });
    }

    function register(root) {
      const segments = [];
      collect(root, segments);
      for (const segment of segments) {
        const list = pendingByParent.get(segment.parent);
        if (list) list.push(segment);
        else {
          pendingByParent.set(segment.parent, [segment]);
          intersection.observe(segment.parent);
        }
      }
    }

    function flushMutations() {
      mutationTimer = 0;
      if (!active || contextInvalidated) return;
      const roots = [...mutationRoots];
      mutationRoots = new Set();
      for (const root of roots) {
        if (root.isConnected && root.nodeType === Node.ELEMENT_NODE && isAllowedRoot(root)) register(root);
      }
    }

    /** How far the segment's parent is from the viewport, in pixels; 0 when on screen. */
    function distance(segment) {
      const rect = segment.parent.getBoundingClientRect();
      return Math.max(0, rect.top - innerHeight, -rect.bottom);
    }

    function pump() {
      const limit = getSettings().concurrency;
      while (active && !contextInvalidated && running < limit && queue.length) {
        const distances = queue.map(distance);
        const [segment] = queue.splice(distances.indexOf(Math.min(...distances)), 1);
        const gen = generation;
        running++;
        translateSegment(segment, gen)
          .catch((e) => {
            if (gen !== generation || contextInvalidated) return;
            if (e.contextInvalidated || e.message?.includes('Extension context invalidated')) {
              contextInvalidated = true;
              queue = [];
              pendingByParent.clear();
              awaitingFirstReport = false;
              intersection.disconnect();
              mutations.disconnect();
              clearTimeout(mutationTimer);
              mutationTimer = 0;
              mutationRoots.clear();
              progress.error = '拡張機能が更新されました。ページを再読み込みしてください';
              return;
            }
            progress.failed++;
            progress.error = e.message;
          })
          .finally(() => {
            if (gen !== generation) return;
            running--;
            progress.done++;
            update();
            pump();
          });
      }
      update();
    }

    function isIntact(segment) {
      return segment.nodes.every((n) => n.parentNode === segment.parent);
    }

    /** @param {Segment} segment */
    async function translateSegment(segment, gen) {
      if (!isIntact(segment)) return;
      const { tree } = parse(await cached(segment.source), segment.tags.length);
      if (gen !== generation || contextInvalidated || !isIntact(segment)) return;
      const replacements = build(tree, segment.tags, document);
      if (segment.lead) replacements.unshift(document.createTextNode(' '));
      if (segment.trail) replacements.push(document.createTextNode(' '));
      const first = segment.nodes[0];
      for (const node of replacements) {
        inserted.add(node);
        segment.parent.insertBefore(node, first);
      }
      segment.nodes.forEach((n) => n.remove());
      records.push({ parent: segment.parent, originals: segment.nodes, replacements });
    }

    async function translateTitle(gen) {
      const title = document.title.trim();
      if (!shouldTranslate(title)) return;
      try {
        const translated = await cached(title);
        if (gen !== generation) return;
        originalTitle = document.title;
        document.title = parse(translated, 0).tree.join('');
      } catch {
        // The body's progress view already reports connection errors.
      }
    }

    function start() {
      if (active) return;
      active = true;
      contextInvalidated = false;
      generation++;
      progress = { done: 0, total: 0, failed: 0, error: '' };
      awaitingFirstReport = true;
      register(document.body);
      awaitingFirstReport = pendingByParent.size > 0;
      update();
      mutations.observe(document.body, { childList: true, subtree: true });
      translateTitle(generation);
      pump();
    }

    function restore() {
      if (!active) return;
      active = false;
      generation++;
      mutations.disconnect();
      intersection.disconnect();
      clearTimeout(mutationTimer);
      mutationTimer = 0;
      mutationRoots = new Set();
      pendingByParent = new Map();
      queue = [];
      running = 0;
      for (const { parent, originals, replacements } of records.reverse()) {
        const anchor = replacements.find((n) => n.parentNode === parent);
        if (!anchor) continue;
        for (const node of originals) parent.insertBefore(node, anchor);
        replacements.forEach((n) => n.parentNode === parent && n.remove());
      }
      records = [];
      claimed = new WeakSet();
      inserted = new WeakSet();
      if (originalTitle !== null) document.title = originalTitle;
      originalTitle = null;
      update();
    }

    return {
      start,
      restore,
      toggle: () => (active ? restore() : start()),
      status: () => ({ state: state(), ...progress }),
    };
  }

  const STATUS_CSS = `
    .status {
      position: fixed; right: 16px; bottom: 16px;
      display: flex; align-items: center; gap: 10px;
      padding: 8px 10px 8px 14px; border-radius: 999px;
      background: var(--bg); color: var(--fg); border: 1px solid var(--border);
      box-shadow: var(--shadow); font: 13px/1.4 var(--font);
    }
    .status[hidden] { display: none; }
    .status .error { color: var(--danger); max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status button {
      font: inherit; border: 1px solid var(--border); background: var(--subtle); color: var(--fg);
      border-radius: 999px; padding: 3px 10px; cursor: pointer;
    }
    .status button:hover { border-color: var(--accent); }
    .status .close { border: none; background: none; padding: 0 4px; color: var(--muted); font-size: 16px; }
  `;

  /** The small view at the bottom right: progress and the restore button. */
  function createStatusView(shadow, { onRestore }) {
    const style = document.createElement('style');
    style.textContent = STATUS_CSS;
    const box = document.createElement('div');
    box.className = 'status';
    box.hidden = true;
    box.innerHTML = `
      <span class="label"></span>
      <span class="error"></span>
      <button type="button" class="restore">原文に戻す</button>
      <button type="button" class="close" aria-label="閉じる">×</button>`;
    shadow.append(style, box);
    const label = box.querySelector('.label');
    const error = box.querySelector('.error');
    let dismissed = false;
    box.querySelector('.restore').addEventListener('click', onRestore);
    box.querySelector('.close').addEventListener('click', () => {
      dismissed = true;
      box.hidden = true;
    });

    return function render({ state, done, total, failed, error: message }) {
      if (state === 'idle') {
        dismissed = false;
        box.hidden = true;
        return;
      }
      box.hidden = dismissed;
      box.dataset.state = state;
      label.textContent = state === 'translating' ? `翻訳中 ${done}/${total}` : '翻訳済み';
      error.textContent = failed ? `${failed} 件失敗: ${message}` : message;
      error.title = message;
    };
  }

  globalThis.PlamoPageTranslator = { createPageTranslator, createStatusView };
})();

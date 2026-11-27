import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const markupScript = await readFile(new URL('../../src/content/markup.js', import.meta.url), 'utf8');
const pageScript = await readFile(new URL('../../src/content/page-translator.js', import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

class FakeText {
  constructor(value) {
    this.nodeType = 3;
    this.nodeValue = value;
    this.parentNode = null;
  }
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node.localName === 'body';
  }
  get textContent() {
    return this.nodeValue;
  }
  cloneNode() {
    return new FakeText(this.nodeValue);
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
}

class FakeElement {
  constructor(localName, attrs = {}, children = []) {
    this.nodeType = 1;
    this.localName = localName;
    this.attrs = { ...attrs };
    this.childNodes = [];
    this.parentNode = null;
    this.isContentEditable = false;
    children.forEach((c) => this.appendChild(typeof c === 'string' ? new FakeText(c) : c));
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  get classList() {
    return { contains: (name) => (this.attrs.class ?? '').split(/\s+/).includes(name) };
  }
  getAttribute(name) {
    return this.attrs[name] ?? null;
  }
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node.localName === 'body';
  }
  closest(selector) {
    const tags = selector.split(',').map((s) => s.trim()).filter((s) => /^[a-z]+$/.test(s));
    let node = this;
    while (node) {
      if (node.nodeType === 1) {
        if (tags.includes(node.localName)) return node;
        if (selector.includes('[translate="no"]') && node.getAttribute('translate') === 'no') return node;
        if (selector.includes('.notranslate') && node.classList.contains('notranslate')) return node;
      }
      node = node.parentNode;
    }
    return null;
  }
  appendChild(child) {
    return this.insertBefore(child, null);
  }
  insertBefore(node, ref) {
    if (node.parentNode) node.remove();
    if (ref === null) this.childNodes.push(node);
    else this.childNodes.splice(this.childNodes.indexOf(ref), 0, node);
    node.parentNode = this;
    return node;
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
  cloneNode(deep) {
    const copy = new FakeElement(this.localName, this.attrs);
    if (deep) for (const child of this.childNodes) copy.appendChild(child.cloneNode(true));
    return copy;
  }
  getBoundingClientRect() {
    return { top: 0, bottom: 10 };
  }
}

const h = (name, attrs, children) => new FakeElement(name, attrs, children);
const t = (value) => new FakeText(value);

function loadPage() {
  let reportIntersections;
  let reportMutations;
  const observed = [];
  const requests = [];
  const body = h('body');
  const context = {
    document: {
      body,
      title: '',
      createTextNode: (value) => new FakeText(value),
    },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    innerHeight: 800,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout,
    getComputedStyle: (el) => {
      const match = /white-space:\s*([a-z-]+)/.exec(el?.attrs?.style ?? '');
      return { whiteSpace: match ? match[1] : 'normal' };
    },
    IntersectionObserver: class {
      constructor(callback) {
        reportIntersections = callback;
      }
      observe(target) {
        observed.push(target);
      }
      unobserve() {}
      disconnect() {}
    },
    MutationObserver: class {
      constructor(callback) {
        reportMutations = callback;
      }
      observe() {}
      disconnect() {}
    },
  };
  runInNewContext(`${markupScript}\n${pageScript}`, context);
  const page = context.PlamoPageTranslator.createPageTranslator({
    translate: (text) => {
      requests.push(text);
      return Promise.resolve(`T:${text}`);
    },
    getSettings: () => ({ targetLang: 'ja', concurrency: 16 }),
    isOwnUi: () => false,
    onUpdate() {},
  });
  return {
    page,
    body,
    requests,
    reportAll() {
      const targets = [...observed];
      observed.length = 0;
      reportIntersections(targets.map((target) => ({ target, isIntersecting: true })));
    },
    mutate(target, addedNodes) {
      reportMutations([{ type: 'childList', target, addedNodes }]);
    },
    async settle() {
      for (let i = 0; i < 20; i++) await flush();
      // mutation debounce is 200ms in real time; run timers forward by waiting
      await new Promise((r) => setTimeout(r, 250));
      for (let i = 0; i < 20; i++) await flush();
    },
  };
}

test('fresh original content in a translated parent regenerates instead of accumulating', async () => {
  const harness = loadPage();
  const div = h('div', {}, [t('Show 0 new posts')]);
  harness.body.appendChild(div);
  harness.page.start();
  harness.reportAll();
  await harness.settle();
  assert.equal(div.textContent, 'T:Show 0 new posts');

  // React-ish update: insert a fresh text node into the same parent (the tracked original is gone)
  const fresh = t('Show 1 new posts');
  div.insertBefore(fresh, div.childNodes[0]);
  harness.mutate(div, [fresh]);
  await harness.settle();
  harness.reportAll();
  await harness.settle();

  assert.equal(
    div.textContent,
    'T:Show 1 new posts',
    `expected exactly one translation, got: ${JSON.stringify(div.textContent)}`,
  );

  // further cycles: still exactly one generation, never accumulating
  for (let n = 2; n <= 4; n++) {
    const node = t(`Show ${n} new posts`);
    div.insertBefore(node, div.childNodes[0]);
    harness.mutate(div, [node]);
    await harness.settle();
    harness.reportAll();
    await harness.settle();
    assert.equal(div.textContent, `T:Show ${n} new posts`, `cycle ${n}: ${JSON.stringify(div.textContent)}`);
  }
});

test('Japanese lines in a mixed parent do not churn regeneration', async () => {
  const harness = loadPage();
  // multi-line post: English line translated, Japanese line stays (kana -> untranslatable)
  const div = h('div', { style: 'white-space: pre-wrap' }, [t('Hello world\nこんにちは')]);
  harness.body.appendChild(div);
  harness.page.start();
  harness.reportAll();
  await harness.settle();
  const before = div.textContent;
  assert.ok(before.includes('T:Hello world'), `setup: ${JSON.stringify(before)}`);
  const requestsBefore = harness.requests.length;

  // unrelated mutation elsewhere in the parent: re-collect must not wipe anything
  const extra = t('\n');
  div.appendChild(extra);
  harness.mutate(div, [extra]);
  await harness.settle();
  harness.reportAll();
  await harness.settle();

  assert.equal(div.textContent, before + '\n');
  assert.equal(harness.requests.length, requestsBefore, 'no retranslation should happen');
});

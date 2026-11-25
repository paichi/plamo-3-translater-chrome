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

/** Serializes a fake tree, marking element tags, so structure and text can be asserted. */
function html(node) {
  if (node.nodeType === 3) return node.nodeValue;
  const attrs = Object.entries(node.attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
  return `<${node.localName}${attrs}>${node.childNodes.map(html).join('')}</${node.localName}>`;
}

function loadPage() {
  let reportIntersections;
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
    setTimeout,
    clearTimeout,
    // white-space inherits: the fake resolves the nearest ancestor with an explicit value.
    getComputedStyle(el) {
      for (let n = el; n; n = n.parentNode) {
        if (n._ws) return { whiteSpace: n._ws };
      }
      return { whiteSpace: 'normal' };
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
    async settle() {
      for (let i = 0; i < 10; i++) await flush();
    },
  };
}

async function translateTree(root) {
  const harness = loadPage();
  harness.body.appendChild(root);
  harness.page.start();
  harness.reportAll();
  await harness.settle();
  return harness;
}

for (const whiteSpace of ['pre', 'pre-wrap', 'pre-line', 'break-spaces']) {
  test(`newlines split translation units in white-space: ${whiteSpace} containers`, async () => {
    const div = h('div', {}, [t('First line\n\nSecond line')]);
    div._ws = whiteSpace;
    const { body, requests, page } = await translateTree(div);
    assert.deepEqual([...requests].sort(), ['First line', 'Second line']);
    assert.equal(body.textContent, 'T:First line\n\nT:Second line');
    assert.equal(page.status().state, 'translated');
  });
}

test('newlines are collapsed as before in white-space: normal containers', async () => {
  const div = h('div', {}, [t('First line\n\nSecond line')]);
  const { body, requests } = await translateTree(div);
  assert.deepEqual(requests, ['First line Second line']);
  assert.equal(body.textContent, 'T:First line Second line');
});

test('newlines inside nested inline elements split units but keep the elements in place', async () => {
  const link = h('a', { href: '/x' }, [t('link')]);
  const span = h('span', {}, [t('alpha '), link, t('\nbeta')]);
  const div = h('div', {}, [span]);
  div._ws = 'pre-wrap';
  const { body, requests } = await translateTree(div);
  assert.deepEqual([...requests].sort(), ['alpha <g id="0">link</g>', 'beta']);
  assert.equal(
    html(div),
    '<div><span>T:alpha <a href="/x">link</a>\nT:beta</span></div>',
  );
  assert.equal(body.textContent, 'T:alpha link\nT:beta');
});

test('code elements with newlines stay atomic and untranslated inside', async () => {
  const div = h('div', {}, [t('look '), h('code', {}, [t('x\ny')])]);
  div._ws = 'pre-wrap';
  const { body, requests } = await translateTree(div);
  assert.deepEqual(requests, ['look <g id="0">x y</g>']);
  assert.equal(html(div), '<div>T:look <code>x\ny</code></div>');
  assert.equal(body.textContent, 'T:look x\ny');
});

test('restore returns the original text after newline splitting', async () => {
  const div = h('div', {}, [t('First line\n\nSecond line')]);
  div._ws = 'pre-wrap';
  const { body, page } = await translateTree(div);
  assert.notEqual(body.textContent, 'First line\n\nSecond line');
  page.restore();
  assert.equal(body.textContent, 'First line\n\nSecond line');
});

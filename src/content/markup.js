(() => {
  const INLINE_TAGS = new Set([
    'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i',
    'ins', 'kbd', 'label', 'mark', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong',
    'sub', 'sup', 'time', 'tt', 'u', 'var',
  ]);
  const KEEP_TAGS = new Set(['code', 'kbd', 'samp', 'var']);
  const TEXT_NODE = 3;
  const ELEMENT_NODE = 1;
  const TAG = /<(\/?)g\b([^>]*)>/g;
  const ID = /\bid="?(\d+)/;

  function tagName(el) {
    return (el.localName || el.tagName || '').toLowerCase();
  }

  /** An inline element whose content is sent with a tag but rebuilt from the original. */
  function isKeep(el) {
    return (
      KEEP_TAGS.has(tagName(el)) ||
      el.getAttribute?.('translate') === 'no' ||
      Boolean(el.classList?.contains('notranslate'))
    );
  }

  /**
   * Elements without visible text (icons, empty spans) are not inline: they act as
   * separators and stay in place, so the model never has to reproduce an empty tag.
   */
  function isInline(el) {
    if (!INLINE_TAGS.has(tagName(el))) return false;
    if (!/\S/.test(el.textContent)) return false;
    if (isKeep(el)) return true;
    for (const child of el.childNodes) {
      if (child.nodeType === ELEMENT_NODE && !isInline(child)) return false;
    }
    return true;
  }

  /**
   * @param {Node[]} nodes consecutive text nodes and inline elements of one parent
   * @returns {{ source: string, tags: Element[], text: string, lead: boolean, trail: boolean }}
   *   `source` is the tag string sent to the model, `text` the translatable text only.
   */
  function serialize(nodes) {
    const tags = [];
    let source = '';
    let text = '';
    const visit = (node) => {
      if (node.nodeType === TEXT_NODE) {
        source += node.nodeValue;
        text += node.nodeValue;
        return;
      }
      if (node.nodeType !== ELEMENT_NODE) return;
      const id = tags.push(node) - 1;
      source += `<g id="${id}">`;
      if (isKeep(node)) source += node.textContent;
      else node.childNodes.forEach(visit);
      source += '</g>';
    };
    nodes.forEach(visit);
    const collapse = (s) => s.replace(/\s+/g, ' ').trim();
    return {
      source: collapse(source),
      tags,
      text: collapse(text),
      lead: /^\s/.test(source),
      trail: /\s$/.test(source),
    };
  }

  /**
   * Reads the model's output leniently, because small models often break nested tags while
   * translating the sentence well. An opening tag with an unknown or repeated id and a `</g>`
   * with nothing open are ignored; a tag still open at the end is unwrapped into its parent.
   * Tags that never come back are dropped, leaving their translated words as plain text.
   * @typedef {string | { id: number, children: Tree }} TreeItem
   * @typedef {TreeItem[]} Tree
   * @returns {{ tree: Tree, dropped: number, ignored: number }}
   *   `dropped` counts source tags missing from the tree, `ignored` the tag marks discarded.
   */
  function parse(translated, count) {
    const root = { children: [] };
    const stack = [root];
    const seen = new Set();
    let ignored = 0;
    let unwrapped = 0;
    let last = 0;
    const pushText = (end) => {
      if (end > last) stack.at(-1).children.push(translated.slice(last, end));
    };
    for (const m of translated.matchAll(TAG)) {
      pushText(m.index);
      last = m.index + m[0].length;
      if (m[1]) {
        if (stack.length > 1) stack.pop();
        else ignored++;
        continue;
      }
      const id = Number(ID.exec(m[2])?.[1]);
      if (!(id < count) || seen.has(id)) {
        ignored++;
        continue;
      }
      seen.add(id);
      const item = { id, children: [] };
      stack.at(-1).children.push(item);
      stack.push(item);
    }
    pushText(translated.length);
    while (stack.length > 1) {
      const item = stack.pop();
      stack.at(-1).children.splice(-1, 1, ...item.children);
      unwrapped++;
    }
    return { tree: root.children, dropped: count - seen.size + unwrapped, ignored };
  }

  /** Rebuilds DOM nodes from a parsed tree, keeping attributes such as href from `tags`. */
  function build(tree, tags, doc) {
    return tree.map((item) => {
      if (typeof item === 'string') return doc.createTextNode(item);
      const original = tags[item.id];
      if (isKeep(original)) return original.cloneNode(true);
      const el = original.cloneNode(false);
      for (const child of build(item.children, tags, doc)) el.appendChild(child);
      return el;
    });
  }

  globalThis.PlamoMarkup = { serialize, parse, build, isInline, isKeep };
})();

// tests/fixtures/email-intel/fake-dom.js — tiny hand-written DOM stub.
// The repo has no jsdom and none is added. Renderer tests call pure render
// functions in node; this stub exists ONLY for event-wiring checks (a registered
// element, addEventListener, dispatch). It does not parse HTML.

export class FakeElement {
  constructor(id, tag) {
    this.id = id || '';
    this.tagName = (tag || 'div').toUpperCase();
    this.innerHTML = '';
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.dataset = {};
    this.attributes = {};
    this.children = [];
    this.listeners = {};
    const classes = new Set();
    this.classList = {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, force) => { const on = force === undefined ? !classes.has(c) : !!force; if (on) classes.add(c); else classes.delete(c); return on; },
      contains: (c) => classes.has(c),
    };
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  dispatch(type, evt) { const e = Object.assign({ type, target: this, preventDefault() {}, stopPropagation() {} }, evt); (this.listeners[type] || []).slice().forEach((fn) => fn(e)); return e; }
  click() { return this.dispatch('click'); }
}

export function createFakeDom() {
  const byId = new Map();
  const document = {
    head: new FakeElement('head', 'head'),
    body: new FakeElement('body', 'body'),
    createElement: (tag) => new FakeElement('', tag),
    getElementById: (id) => byId.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  /** Register an element so getElementById finds it. */
  const add = (id, tag) => { const el = new FakeElement(id, tag); byId.set(id, el); return el; };
  return { document, add, byId };
}

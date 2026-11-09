// tests/fixtures/zoom/fake-dom-ext.js — extends the read-only email-intel fake DOM with what the Zoom hub
// shell needs: style, simple selectors (#id, .class, [data-x], [data-x="v"], tag), closest(), tree-wide
// getElementById, createTextNode and a count of every appended node. It still does not parse HTML.
import { FakeElement } from '../email-intel/fake-dom.js';

export class ExtElement extends FakeElement {
  constructor(id, tag, dom) {
    super(id, tag);
    this.style = {};
    this.className = '';
    this.parentNode = null;
    this._dom = dom;
  }
  appendChild(c) {
    super.appendChild(c);
    if (c && typeof c === 'object') c.parentNode = this;
    if (this._dom) this._dom.appended.push(c);
    return c;
  }
  remove() {
    const p = this.parentNode;
    if (p) p.children = p.children.filter((x) => x !== this);
    this.parentNode = null;
  }
  _classes() {
    const out = new Set(String(this.className || '').split(/\s+/).filter(Boolean));
    return out;
  }
  matches(sel) {
    const s = String(sel).trim();
    if (s.startsWith('#')) return this.id === s.slice(1);
    if (s.startsWith('.')) return this._classes().has(s.slice(1)) || this.classList.contains(s.slice(1));
    const m = /^\[data-([a-z0-9-]+)(?:="([^"]*)")?\]$/i.exec(s);
    if (m) {
      const k = m[1].replace(/-([a-z])/g, (_x, c) => c.toUpperCase());
      if (!Object.prototype.hasOwnProperty.call(this.dataset, k)) return false;
      return m[2] === undefined ? true : String(this.dataset[k]) === m[2];
    }
    return this.tagName === s.toUpperCase();
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children || []) {
        if (c && typeof c.matches === 'function' && c.matches(sel)) out.push(c);
        if (c && c.children) walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) {
    let n = this;
    while (n) { if (typeof n.matches === 'function' && n.matches(sel)) return n; n = n.parentNode; }
    return null;
  }
}

export function createExtDom() {
  const dom = { appended: [] };
  const head = new ExtElement('head', 'head', null);
  const body = new ExtElement('body', 'body', null);
  head._dom = dom; body._dom = dom;
  const registered = new Map();
  const document = {
    head,
    body,
    createElement: (tag) => new ExtElement('', tag, dom),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    getElementById: (id) => {
      if (registered.has(id)) return registered.get(id);
      for (const root of [head, body]) { const f = root.querySelector('#' + id); if (f) return f; }
      return null;
    },
    querySelector: (sel) => body.querySelector(sel) || head.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel).concat(head.querySelectorAll(sel)),
  };
  const add = (id, tag) => { const el = new ExtElement(id, tag, dom); registered.set(id, el); return el; };
  return { document, add, dom, head, body };
}

/** createBus() — minimal bus with on/emit/off. */
export function createBus() {
  const subs = new Map();
  return {
    on(ev, fn) { if (!subs.has(ev)) subs.set(ev, []); subs.get(ev).push(fn); return () => this.off(ev, fn); },
    off(ev, fn) { subs.set(ev, (subs.get(ev) || []).filter((f) => f !== fn)); },
    emit(ev, p) { for (const fn of (subs.get(ev) || []).slice()) fn(p); },
    count(ev) { return (subs.get(ev) || []).length; },
  };
}

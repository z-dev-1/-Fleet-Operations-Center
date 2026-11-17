// tests/fixtures/mini-dom.js — a small HTML-parsing fake DOM for renderer DOM
// tests (no jsdom in this repo). innerHTML is parsed with htmlparser2; supports
// compound selectors (tag#id.class[attr="v"]) with descendant combinators,
// classList, dataset, hidden/disabled, closest, bubbling events and
// document-level listeners. Only what the status bar / auth-health / settings
// tests need.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseDocument } = require('htmlparser2');

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

class TextNode {
  constructor(data) { this.nodeType = 3; this.data = String(data); this.parentNode = null; }
  get textContent() { return this.data; }
  remove() { if (this.parentNode) this.parentNode._detach(this); }
}

function parseCompound(s) {
  const m = /^([a-z0-9-]+|\*)?((?:#[\w-]+|\.[\w-]+|\[[^\]]+\])*)$/i.exec(s);
  if (!m) throw new Error('mini-dom: unsupported selector ' + s);
  const out = { tag: m[1] && m[1] !== '*' ? m[1].toLowerCase() : null, id: null, classes: [], attrs: [] };
  const re = /#([\w-]+)|\.([\w-]+)|\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;
  let t;
  while ((t = re.exec(m[2] || ''))) {
    if (t[1]) out.id = t[1];
    else if (t[2]) out.classes.push(t[2]);
    else out.attrs.push({ name: t[3].trim().toLowerCase(), value: t[4] ?? t[5] ?? t[6] });
  }
  return out;
}

function matchCompound(el, c) {
  if (c.tag && el.tagName.toLowerCase() !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const k of c.classes) if (!el.classList.contains(k)) return false;
  for (const a of c.attrs) {
    if (!el.hasAttribute(a.name)) return false;
    if (a.value !== undefined && el.getAttribute(a.name) !== a.value) return false;
  }
  return true;
}

function matchSelector(el, sel) {
  return String(sel).split(',').some((one) => {
    const parts = one.trim().split(/\s+/).map(parseCompound);
    if (!matchCompound(el, parts[parts.length - 1])) return false;
    let i = parts.length - 2;
    let n = el.parentNode;
    while (i >= 0 && n && n.nodeType === 1) {
      if (matchCompound(n, parts[i])) i--;
      n = n.parentNode;
    }
    return i < 0;
  });
}

export class MiniElement {
  constructor(tag, doc) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.childNodes = [];
    this.parentNode = null;
    this.style = {};
    this._attrs = {};
    this._listeners = {};
    this.value = '';
  }
  // attributes
  getAttribute(n) { n = String(n).toLowerCase(); return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null; }
  setAttribute(n, v) { this._attrs[String(n).toLowerCase()] = String(v); }
  hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, String(n).toLowerCase()); }
  removeAttribute(n) { delete this._attrs[String(n).toLowerCase()]; }
  _boolAttr(n, v) { if (v) this.setAttribute(n, ''); else this.removeAttribute(n); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get title() { return this.getAttribute('title') || ''; }
  set title(v) { this.setAttribute('title', v); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { this._boolAttr('hidden', v); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { this._boolAttr('disabled', v); }
  get classList() {
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    const set = (arr) => { self.className = arr.join(' '); };
    return {
      contains: (c) => list().includes(c),
      add: (...cs) => { const l = list(); for (const c of cs) if (!l.includes(c)) l.push(c); set(l); },
      remove: (...cs) => set(list().filter((x) => !cs.includes(x))),
      toggle: (c, force) => {
        const has = list().includes(c);
        const want = force === undefined ? !has : !!force;
        if (want && !has) set([...list(), c]);
        if (!want && has) set(list().filter((x) => x !== c));
        return want;
      },
    };
  }
  get dataset() {
    const out = {};
    for (const [k, v] of Object.entries(this._attrs)) {
      if (k.startsWith('data-')) out[k.slice(5).replace(/-([a-z])/g, (_x, ch) => ch.toUpperCase())] = v;
    }
    return out;
  }
  // tree
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  _detach(n) { this.childNodes = this.childNodes.filter((x) => x !== n); n.parentNode = null; }
  appendChild(n) {
    if (n.parentNode) n.parentNode._detach(n);
    this.childNodes.push(n);
    n.parentNode = this;
    return n;
  }
  remove() { if (this.parentNode) this.parentNode._detach(this); }
  contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) { this.childNodes = []; this.appendChild(new TextNode(v == null ? '' : v)); }
  get innerHTML() { return this.childNodes.map(serialize).join(''); }
  set innerHTML(html) {
    for (const n of this.childNodes) n.parentNode = null;
    this.childNodes = [];
    const parsed = parseDocument(String(html == null ? '' : html), { decodeEntities: true });
    for (const c of parsed.children) { const n = convert(c, this.ownerDocument); if (n) this.appendChild(n); }
  }
  get outerHTML() { return serialize(this); }
  // selectors
  matches(sel) { return matchSelector(this, sel); }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) { let n = this; while (n && n.nodeType === 1) { if (n.matches(sel)) return n; n = n.parentNode; } return null; }
  // events
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn); }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    let stopped = false;
    ev.stopPropagation = () => { stopped = true; };
    ev.preventDefault = () => { ev.defaultPrevented = true; };
    const results = [];
    const d = this.ownerDocument;
    const attached = !!(d && d.documentElement && d.documentElement.contains(this));
    let n = this;
    while (n && !stopped) {
      ev.currentTarget = n;
      for (const fn of [...(n._listeners[ev.type] || [])]) results.push(fn.call(n, ev));
      n = n.parentNode;
    }
    if (attached && !stopped) {
      ev.currentTarget = d;
      for (const fn of [...(d._listeners[ev.type] || [])]) results.push(fn.call(d, ev));
    }
    return results;
  }
  click() { return this.dispatchEvent({ type: 'click' }); }
  focus() { this.ownerDocument.activeElement = this; }
}

function convert(node, doc) {
  if (node.type === 'text') return new TextNode(node.data);
  if (node.type === 'tag' || node.type === 'script' || node.type === 'style') {
    const el = new MiniElement(node.name, doc);
    for (const [k, v] of Object.entries(node.attribs || {})) el.setAttribute(k, v);
    for (const c of node.children || []) { const n = convert(c, doc); if (n) el.appendChild(n); }
    return el;
  }
  return null; // comments, directives
}

function serialize(n) {
  if (n.nodeType === 3) return escText(n.data);
  const tag = n.tagName.toLowerCase();
  const attrs = Object.entries(n._attrs).map(([k, v]) => (v === '' ? ' ' + k : ' ' + k + '="' + escAttr(v) + '"')).join('');
  if (VOID.has(tag)) return '<' + tag + attrs + '>';
  return '<' + tag + attrs + '>' + n.childNodes.map(serialize).join('') + '</' + tag + '>';
}

export function createMiniDocument() {
  const doc = { _listeners: {}, activeElement: null };
  doc.createElement = (tag) => new MiniElement(tag, doc);
  doc.documentElement = new MiniElement('html', doc);
  doc.body = new MiniElement('body', doc);
  doc.documentElement.appendChild(doc.body);
  doc.getElementById = (id) => doc.body.querySelector('#' + id);
  doc.querySelector = (s) => doc.body.querySelector(s);
  doc.querySelectorAll = (s) => doc.body.querySelectorAll(s);
  doc.addEventListener = (type, fn) => { (doc._listeners[type] ||= []).push(fn); };
  doc.removeEventListener = (type, fn) => { doc._listeners[type] = (doc._listeners[type] || []).filter((f) => f !== fn); };
  doc.dispatchEvent = (ev) => {
    ev.target = ev.target || doc;
    const results = [];
    for (const fn of [...(doc._listeners[ev.type] || [])]) results.push(fn.call(doc, ev));
    return results;
  };
  return doc;
}

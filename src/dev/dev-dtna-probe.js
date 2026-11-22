'use strict';
/**
 * dev/dev-dtna-probe.js — DEV-ONLY, env-gated, READ-ONLY live discovery probe for the DTNA Service
 * Tracker Aura API (plan step 14, findings "Live discovery" D0-D4 and P1-P2).
 *
 * Inert unless process.env.FLEET_DEV_DTNA_PROBE === '1'. When set, start() subscribes to the DTNA
 * session status and runs run() ONCE per process on the first 'connected' status (that is, right
 * after the user's own sign-in click). Never required by product code.
 *
 * READ-ONLY everywhere:
 *  - Apex reads go through src/dtna/client.js and aura._callApexRaw, and only for methods named
 *    get* / list* / fetch* on E2E_* classes. WRITE_RE names and postComment are never called; other
 *    names are listed under needsConfirmation and not called.
 *  - D0 / P1 read the portal's own script bundles (Network.getResponseBody); zero calls.
 *  - P2 runs a DOM-reading script on the Comments tab: it never clicks, types, focuses or sends.
 *  - No page console listener (the portal prints its OIDC token there).
 *
 *  - Stage mode (FLEET_DEV_DTNA_PROBE_MODE=stage) reads the changeStatus call sites and the stepper
 *    DOM (S2, read-only) and makes one getCaseRecord read; it never calls changeStatus.
 *
 * Output: <getDataDir()>/dev/dtna-probe-<YYYY-MM-DD>.json (emails masked; no token, context,
 * pageURI, cookies or URLs with a query). The logger gets counts only, and always a
 * `[dtna-probe] done ...` line (also on timeout or error, with code=...). The probe window is always closed.
 */
const fs = require('fs');
const path = require('path');
const C = require('../dtna/constants');
const { shapeOf, caseTag, maskEmail } = require('../dtna/redact');
const { safeJson } = require('../dtna/safe-json');
const { stripHtml } = require('../dtna/thread');

const ENV_FLAG = 'FLEET_DEV_DTNA_PROBE';
// FLEET_DEV_DTNA_PROBE_MODE=post: postComment discovery only (P1b call sites + P2 composer on the RO
// test case). The probe itself makes no Apex calls in this mode; output dtna-post-probe-<date>.json.
// FLEET_DEV_DTNA_PROBE_MODE=stage: changeStatus discovery only (Phase C). Reads the
// E2E_CaseDetailsLWCController.changeStatus call sites from the portal bundles (escaped-string aware),
// the status literals and handler names around them, the stage stepper DOM (S2, read-only) and ONE
// getCaseRecord read for the current-stage fields. No write, no click, no _callApexRaw. Output:
// <worktree>/.agents/tasks/dtna-aura/phase-c/stage-probe.json and <dataDir>/dev/dtna-stage-probe-<date>.json.
const MODE_FLAG = 'FLEET_DEV_DTNA_PROBE_MODE';
const STAGE_OUT_FILE = path.resolve(__dirname, '..', '..', '.agents', 'tasks', 'dtna-aura', 'phase-c', 'stage-probe.json');
const WINDOW_TITLE = 'DTNA discovery probe (dev, read-only)';
const OVERALL_TIMEOUT_MS = 10 * 60e3;
const SETTLE_MS = 8000;
const LOAD_TIMEOUT_MS = 30e3;
const BODY_MAX = 25 * 1024 * 1024;
const HIT_WINDOW = 400;
const D2_CAP = 15;
const D3_CAP = 250;
const D3_CONCURRENCY = 3;
const COMMENTS_TAB_QS = '?tabset-032e7=5194e';
// Test cases named in findings §6: unit 122269 / serial NP6923 / RO R101048154, and a no-RO case.
const TARGETS = Object.freeze(['500gx000002E4U5AAK', '500gx000003ZOQoAAO']);
const KNOWN_UNIT = '122269';
const KNOWN_SERIAL = 'NP6923';

const READ_RE = /^(get|list|fetch)/;
const D1_KEY_RE = /unit|serial|vin|dealer|status|estimate|amount|total|approv|ro|repair/i;
const D2_NAME_RE = /RepairOrder|Estimate|EA\b|Approval|Fault/;
const MONEY_KEY_RE = /amount|total|price|cost|labor|parts|tax/i;
const STATUS_KEY_RE = /status|state|approv|pending|declin|reject/i;
const MONEY_TEXT_RE = /\$\s?\d[\d,]*(\.\d{2})?/;
const ESTIMATE_TEXT_RE = /approv|pending|declin|estimate/i;
const FAULTS = Object.freeze({ classname: 'E2E_CaseDetailsLWCController', method: 'getFaultsFromDataStream' });
const META_KEYS = new Set(['classname', 'method', 'namespace', 'params', 'cacheable', 'isContinuation', 'descriptor', 'callingDescriptor', 'id']);
const APEX_DESCRIPTOR = 'aura://ApexActionController/ACTION$execute';

// READ-ONLY composer inspection (P2). Reads tags, attributes and text only.
const P2_SCRIPT = [
  '(function(){',
  '  var out = { fields: [], labels: [], options: [], buttons: [], hosts: [], roots: 0 };',
  '  function hostChain(el){ var n = el, chain = []; for (var k = 0; k < 60 && n; k++) { var tg = String(n.tagName || "").toLowerCase();',
  '    if (tg.indexOf("-") > 0 && chain.indexOf(tg) < 0 && chain.length < 12) chain.push(tg);',
  '    n = n.parentNode || null; if (n && n.nodeType === 11) n = n.host || null; } return chain.join(" < "); }',
  '  var seen = 0;',
  '  function txt(s){ return String(s == null ? "" : s).replace(/\\s+/g, " ").trim().slice(0, 120); }',
  '  function add(arr, v){ if (v && arr.indexOf(v) < 0 && arr.length < 80) arr.push(v); }',
  '  function attr(el, n){ try { return el.getAttribute(n) || ""; } catch (e) { return ""; } }',
  '  function walk(root, depth){',
  '    if (!root || depth > 25 || seen > 20000) return;',
  '    out.roots++;',
  '    var els = root.querySelectorAll("*");',
  '    for (var i = 0; i < els.length; i++) {',
  '      var el = els[i]; seen++;',
  '      var tag = String(el.tagName || "").toLowerCase();',
  '      if (tag === "label" || tag === "legend") add(out.labels, txt(el.textContent));',
  '      if (tag === "textarea" || (tag === "button" && txt(el.textContent) === "Post")) add(out.hosts, tag + ": " + hostChain(el));',
  '      if (tag === "textarea" || tag === "input" || tag === "select" || /combobox|textarea|rich-text|input-field/.test(tag)) {',
  '        if (out.fields.length < 80) out.fields.push({ tag: tag, type: attr(el, "type"), name: attr(el, "name"),',
  '          label: txt(attr(el, "label") || attr(el, "aria-label") || attr(el, "placeholder")),',
  '          maxlength: attr(el, "maxlength") || attr(el, "max-length"), required: el.hasAttribute ? el.hasAttribute("required") : false });',
  '        var opts = null; try { opts = el.options; } catch (e) { opts = null; }',
  '        if (opts && typeof opts.length === "number") { for (var j = 0; j < opts.length && j < 60; j++) { var o = opts[j]; add(out.options, txt(o && (o.label || o.text || ""))); } }',
  '      }',
  '      if (tag === "option" || attr(el, "role") === "option") add(out.options, txt(attr(el, "data-value") || el.textContent));',
  '      if (tag === "button" || tag === "lightning-button" || attr(el, "role") === "button") add(out.buttons, txt(attr(el, "label") || attr(el, "title") || el.textContent));',
  '      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);',
  '    }',
  '  }',
  '  walk(document, 0);',
  '  return out;',
  '})()',
].join('\n');

// READ-ONLY stage stepper inspection (S2, stage mode). Reads tags, attributes, classes and text only.
const S2_SCRIPT = [
  '(function(){',
  '  var out = { items: [], buttons: [], hosts: [], roots: 0 };',
  '  var STEP_RE = /progress|path|step|stage|status/;',
  '  function hostChain(el){ var n = el, chain = []; for (var k = 0; k < 60 && n; k++) { var tg = String(n.tagName || "").toLowerCase();',
  '    if (tg.indexOf("-") > 0 && chain.indexOf(tg) < 0 && chain.length < 12) chain.push(tg);',
  '    n = n.parentNode || null; if (n && n.nodeType === 11) n = n.host || null; } return chain.join(" < "); }',
  '  var seen = 0;',
  '  function txt(s){ return String(s == null ? "" : s).replace(/\\s+/g, " ").trim().slice(0, 120); }',
  '  function add(arr, v){ if (v && arr.indexOf(v) < 0 && arr.length < 80) arr.push(v); }',
  '  function attr(el, n){ try { return el.getAttribute(n) || ""; } catch (e) { return ""; } }',
  '  function inStepper(el){ var n = el.parentNode || null; for (var k = 0; k < 30 && n; k++) { if (n.nodeType === 11) { n = n.host || null; if (!n) break; }',
  '    var tg = String(n.tagName || "").toLowerCase(); if (tg.indexOf("-") > 0 && STEP_RE.test(tg)) return true; n = n.parentNode || null; } return false; }',
  '  function walk(root, depth){',
  '    if (!root || depth > 25 || seen > 20000) return;',
  '    out.roots++;',
  '    var els = root.querySelectorAll("*");',
  '    for (var i = 0; i < els.length; i++) {',
  '      var el = els[i]; seen++;',
  '      var tag = String(el.tagName || "").toLowerCase();',
  '      var role = attr(el, "role");',
  '      var cls = attr(el, "class");',
  '      var step = (tag.indexOf("-") > 0 && STEP_RE.test(tag)) || /slds-path__item|slds-progress__item/.test(cls)',
  '        || ((role === "option" || role === "listitem" || role === "tab") && inStepper(el));',
  '      if (step && out.items.length < 80) {',
  '        var cur = attr(el, "aria-current");',
  '        out.items.push({ tag: tag, label: txt(attr(el, "title") || attr(el, "aria-label") || attr(el, "data-value") || el.textContent),',
  '          current: (!!cur && cur !== "false") || attr(el, "aria-selected") === "true" || /slds-is-current|slds-is-active/.test(cls),',
  '          complete: /slds-is-complete/.test(cls) });',
  '        add(out.hosts, tag + ": " + hostChain(el));',
  '      }',
  '      if (tag === "button" || tag === "lightning-button" || role === "button") add(out.buttons, txt(attr(el, "label") || attr(el, "title") || el.textContent));',
  '      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);',
  '    }',
  '  }',
  '  walk(document, 0);',
  '  return out;',
  '})()',
].join('\n');

// ── masking / scrubbing ───────────────────────────────────────────────────
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const QUERY_URL_RE = /\bhttps?:\/\/[^\s"'<>]*\?[^\s"'<>]*/gi;

function _mask(s) { return String(s == null ? '' : s).replace(EMAIL_RE, (m) => maskEmail(m) || '***'); }
function _cap(s, n) { return _mask(s).slice(0, n); }

/** _scrubDeep(value, secrets) — masks emails, drops query URLs and any captured auth value in every string. */
function _scrubDeep(v, secrets, depth) {
  const d = depth || 0;
  if (typeof v === 'string') {
    let s = v;
    for (const x of secrets) if (x && s.includes(x)) s = s.split(x).join('<redacted>');
    return _mask(s).replace(QUERY_URL_RE, '<url>');
  }
  if (!v || typeof v !== 'object' || d > 30) return v;
  if (Array.isArray(v)) return v.map((x) => _scrubDeep(x, secrets, d + 1));
  const o = {};
  for (const k of Object.keys(v)) o[_scrubDeep(k, secrets, d + 1)] = _scrubDeep(v[k], secrets, d + 1);
  return o;
}

function _kind(method) {
  if (C.WRITE_RE.test(method) || method === 'postComment') return 'write';
  if (READ_RE.test(method)) return 'read';
  return 'unknown';
}

/** _isSafeRead(classname, method) — the only gate in front of aura._callApexRaw. */
function _isSafeRead(classname, method) {
  return typeof method === 'string' && typeof classname === 'string'
    && /^\w{1,80}$/.test(method) && /^E2E_\w{1,80}$/.test(classname)
    && method !== 'postComment' && !C.WRITE_RE.test(method) && READ_RE.test(method);
}

// ── D0 / P1: bundle + page census ─────────────────────────────────────────
function _paramKeysIn(win) {
  const open = win.indexOf('{');
  if (open < 0) return [];
  let depth = 0;
  let end = win.length;
  for (let i = open; i < win.length; i++) {
    if (win[i] === '{') depth++;
    else if (win[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = win.slice(open + 1, end);
  const keys = [];
  const re = /["']?([A-Za-z_$][\w$]{0,39})["']?\s*:/g;
  let m;
  while ((m = re.exec(body)) && keys.length < 20) if (!META_KEYS.has(m[1]) && !keys.includes(m[1])) keys.push(m[1]);
  return keys;
}

// ── P1b: map the postComment import to its factory parameter and read the call sites (zero calls) ──
const POST_IMPORT = '@salesforce/apex/E2E_UTP_CommentController.postComment';
const STAGE_IMPORT = '@salesforce/apex/E2E_CaseDetailsLWCController.changeStatus';
const STAGE_WINDOW = 6000;
const STAGE_WORD_RE = /stage|status|repair|pick\s*-?up|arriv|clos/i;
const FEED_WRITE_RE = /^(post|add|create|insert|save|submit|share|update|edit)/i;

function _balanced(t, open) {
  const o = t[open];
  const cl = o === '{' ? '}' : o === '(' ? ')' : ']';
  let depth = 0;
  let q = '';
  for (let i = open; i < t.length && i < open + 20000; i++) {
    const ch = t[i];
    if (q) { if (ch === '\\') i++; else if (ch === q) q = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
    if (ch === o) depth++;
    else if (ch === cl) { depth--; if (depth === 0) return t.slice(open, i + 1); }
  }
  return '';
}

/** _entries('{a:x,b,"c":y}') -> [{ key, value }] at depth 0 (value = code expression, capped). */
function _entries(obj) {
  const body = obj.slice(1, -1);
  const parts = [];
  let depth = 0;
  let q = '';
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (q) { cur += ch; if (ch === '\\') { cur += body[i + 1] || ''; i++; } else if (ch === q) q = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; cur += ch; continue; }
    if ('{[('.includes(ch)) depth++;
    if ('}])'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const out = [];
  for (const p of parts.slice(0, 20)) {
    const m = /^\s*["']?([\w$]{1,60})["']?\s*(?::\s*([\s\S]*))?$/.exec(p);
    if (m) out.push({ key: m[1], value: _cap((m[2] == null ? m[1] : m[2]).replace(/\s+/g, ' ').trim(), 160) });
  }
  return out;
}

function _excerpt(t, at, before, after) {
  return _cap(t.slice(Math.max(0, at - before), at + after).replace(/\s+/g, ' '), before + after);
}

/**
 * analyzeImportCalls(text, spec?) -> [{ ident, aliases, calls:[{ argKind, keys, entries, excerpt }] }]
 * Finds module dependency arrays that list `spec`, maps it to the factory parameter at the same index,
 * then reads every call of that identifier (or an interop alias of it) in the module body.
 */
function analyzeImportCalls(text, spec) {
  const t = String(text || '');
  const imp = spec || POST_IMPORT;
  const out = [];
  let idx = 0;
  while ((idx = t.indexOf(imp, idx)) >= 0 && out.length < 10) {
    const at = idx;
    idx += imp.length;
    const open = t.lastIndexOf('[', at);
    if (open < 0 || at - open > 4000) continue;
    if (!/^(\s*["'][^"']*["']\s*,)*\s*["']$/.test(t.slice(open + 1, at))) continue;
    const arr = _balanced(t, open);
    if (!arr) continue;
    const deps = Array.from(arr.matchAll(/["']([^"']+)["']/g)).map((m) => m[1]);
    const pos = deps.indexOf(imp);
    const close = open + arr.length;
    const fm = /^\s*,\s*\(?\s*(?:function\s*[\w$]*\s*\(([^)]*)\)|\(([^)]*)\)\s*=>|([\w$]+)\s*=>)/.exec(t.slice(close, close + 400));
    if (!fm || pos < 0) { out.push({ ident: '', deps: deps.length, pos, calls: [] }); continue; }
    const params = String(fm[1] != null ? fm[1] : fm[2] != null ? fm[2] : fm[3]).split(',').map((s) => s.trim());
    const ident = params[pos] || '';
    if (!/^[\w$]{1,40}$/.test(ident)) { out.push({ ident: '', deps: deps.length, pos, calls: [] }); continue; }
    const bodyStart = close + fm[0].length;
    let bodyEnd = Math.min(t.length, bodyStart + 400000);
    for (const marker of ['define(', 'addModule(']) {
      const n = t.indexOf(marker, bodyStart);
      if (n > 0 && n < bodyEnd) bodyEnd = n;
    }
    const body = t.slice(bodyStart, bodyEnd);
    const esc = (s) => s.replace(/\$/g, '\\$');
    const names = [ident];
    const are = new RegExp('([\\w$]{1,40})\\s*=\\s*[\\w$.]{1,60}\\(\\s*' + esc(ident) + '\\s*\\)', 'g');
    let am;
    while ((am = are.exec(body)) && names.length < 6) if (!names.includes(am[1])) names.push(am[1]);
    const calls = [];
    for (const name of names) {
      // Matches name(...), name.default(...) and the compiled (0, name.default)(...) form.
      const cre = new RegExp('(?<![\\w$.])' + esc(name) + '(?:\\.default)?\\s*\\)?\\s*\\(', 'g');
      let cm;
      while ((cm = cre.exec(body)) && calls.length < 12) {
        const argAt = cm.index + cm[0].length;
        const rest = body.slice(argAt).replace(/^\s+/, '');
        const lead = body.length - argAt - rest.length;
        const rec = { via: name, argKind: 'other', keys: [], entries: [], excerpt: _excerpt(body, cm.index, 500, 700) };
        if (rest[0] === '{') {
          const obj = _balanced(body, argAt + lead);
          rec.argKind = 'object';
          rec.entries = obj ? _entries(obj) : [];
        } else {
          const v = /^([\w$]{1,40})\s*[,)]/.exec(rest);
          if (v) {
            rec.argKind = 'var:' + v[1];
            const back = body.slice(Math.max(0, cm.index - 6000), cm.index);
            const vre = new RegExp('(?<![\\w$.])' + esc(v[1]) + '\\s*=\\s*\\{', 'g');
            let vm;
            let last = -1;
            while ((vm = vre.exec(back))) last = vm.index + vm[0].length - 1;
            if (last >= 0) {
              const obj = _balanced(back, last);
              if (obj) rec.entries = _entries(obj);
            }
          }
        }
        rec.keys = rec.entries.map((e) => e.key);
        calls.push(rec);
      }
    }
    out.push({ ident, aliases: names.slice(1), deps: deps.length, pos, calls });
  }
  return out;
}

/** _unescaped(t) — bundles may carry module source as an escaped string literal (\" and \n); read it unescaped. */
function _unescaped(t) {
  return t.includes('\\"') ? t.replace(/\\\\/g, '\u0000').replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, ' ').replace(/\u0000/g, '\\') : t;
}

function createCensus() {
  const bundle = new Map(); // 'cls.method' -> { classname, method, kind, paramKeys, hits }
  const page = new Map();
  const postSites = [];
  const postCalls = [];
  const postImports = [];
  // Stage mode (changeStatus): call-site records, import positions, nearby status literals and handler names.
  const stageCalls = [];
  const stageImports = [];
  const stageLiterals = [];
  const stageHandlers = [];

  function _scanStage(u) {
    const at = [];
    let i = 0;
    while ((i = u.indexOf(STAGE_IMPORT, i)) >= 0 && at.length < 20) { at.push(i); i += STAGE_IMPORT.length; }
    const cre = /(?<![\w$])changeStatus\b/g;
    let cm;
    while ((cm = cre.exec(u)) && at.length < 40) at.push(cm.index);
    for (const p of at) {
      const win = u.slice(Math.max(0, p - STAGE_WINDOW), p + STAGE_WINDOW);
      // No code punctuation inside a literal, so a window that starts mid-string resyncs on the next quote.
      const lre = /"([^"\\\n{}[\]();=]{1,60})"|'([^'\\\n{}[\]();=]{1,60})'/g;
      let m;
      while ((m = lre.exec(win)) && stageLiterals.length < 60) {
        const lit = (m[1] != null ? m[1] : m[2]).trim();
        if (!lit || /^@salesforce\/|^c\//.test(lit) || stageLiterals.includes(lit)) continue;
        if (C.caseStageOf(lit) || STAGE_WORD_RE.test(lit)) stageLiterals.push(_cap(lit, 60));
      }
      const hre = /(?<![\w$])(handle[\w$]{0,40}|on[\w$]{0,40}click)\b/gi;
      while ((m = hre.exec(win)) && stageHandlers.length < 20) if (!stageHandlers.includes(m[1])) stageHandlers.push(m[1]);
    }
  }
  // Every non-Apex Aura action descriptor the page sends: descriptor + param key names (+ key types). No values.
  const descriptors = new Map();
  // Bundle literals of feed/community controller actions, write-like ones with a code excerpt.
  const feedActions = new Map();

  function noteDescriptor(desc, prm) {
    if (typeof desc !== 'string' || desc.length > 300) return;
    const e = descriptors.get(desc) || { descriptor: desc, calls: 0, paramKeys: [], paramShape: null };
    e.calls++;
    const p = prm && typeof prm === 'object' ? prm : {};
    for (const k of Object.keys(p)) if (/^\w{1,60}$/.test(k) && !e.paramKeys.includes(k) && e.paramKeys.length < 30) e.paramKeys.push(k);
    if (!e.paramShape) e.paramShape = shapeOf(p, 3);
    descriptors.set(desc, e);
  }

  // Code excerpts around every use of the comment/file Apex bindings and the file-upload wiring (code only).
  const uses = {};
  const USE_TERMS = ['postComment__default', 'getFileDetails__default', 'getAttachment__default', 'getFilesOnCase__default',
    'uploadfinished', 'onuploadfinished', 'ContentVersion', 'contentDocumentId', 'documentId', 'fileUploader', 'handlePost', 'handleUpload'];
  function _scanUses(u) {
    for (const term of USE_TERMS) {
      let i = 0;
      const arr = uses[term] || (uses[term] = []);
      while ((i = u.indexOf(term, i)) >= 0 && arr.length < 8) {
        arr.push(_excerpt(u, i, 500, 1200));
        i += term.length + 1200;
      }
    }
  }

  function _scanFeed(t) {
    const re = /((?:serviceComponent|aura|apex):\/\/[\w.]{1,200}\/ACTION\$(\w{1,80}))/g;
    let m;
    while ((m = re.exec(t)) && feedActions.size < 200) {
      const d = m[1];
      if (!/Feed|Chatter|Comment|Community/i.test(d)) continue;
      const e = feedActions.get(d) || { descriptor: d, action: m[2], write: FEED_WRITE_RE.test(m[2]), hits: 0, excerpts: [] };
      e.hits++;
      if (e.write && e.excerpts.length < 3) e.excerpts.push(_excerpt(t, m.index, 300, 900));
      feedActions.set(d, e);
    }
  }
  const scripts = { seen: 0, scanned: 0, skippedLarge: 0, failed: 0 };

  function _addBundle(cls, meth, win) {
    const key = cls + '.' + meth;
    let e = bundle.get(key);
    if (!e) { e = { classname: cls, method: meth, kind: _kind(meth), paramKeys: [], hits: 0 }; bundle.set(key, e); }
    e.hits++;
    for (const k of _paramKeysIn(win)) if (!e.paramKeys.includes(k) && e.paramKeys.length < 20) e.paramKeys.push(k);
  }

  function _addPostSite(win, before) {
    if (postSites.length >= 20) return;
    const valueSources = [];
    const vre = /["']?([A-Za-z_$][\w$]{0,39})["']?\s*:\s*([A-Za-z_$][\w$.]{0,79})/g;
    let m;
    while ((m = vre.exec(win)) && valueSources.length < 20) if (!META_KEYS.has(m[1])) valueSources.push(m[1] + ': ' + m[2]);
    const maxLength = [];
    const mre = /max-?length["']?\s*[=:]\s*["']?(\d{1,6})|\bmax["']?\s*[=:]\s*["']?(\d{1,6})/gi;
    while ((m = mre.exec(win)) && maxLength.length < 10) maxLength.push(Number(m[1] || m[2]));
    const typeLiterals = [];
    const lre = /["']([A-Z][\w \-/]{1,59})["']/g;
    while ((m = lre.exec(win)) && typeLiterals.length < 20) if (!/^E2E_/.test(m[1]) && !typeLiterals.includes(m[1])) typeLiterals.push(_cap(m[1], 60));
    postSites.push({ paramKeys: _paramKeysIn(win), valueSources, maxLength, typeLiterals, excerpt: before ? _cap(before.replace(/\s+/g, ' '), 400) + ' ⟨@⟩ ' + _cap(win.replace(/\s+/g, ' '), HIT_WINDOW) : '' });
  }

  /** scan(text) — extract @salesforce/apex imports, classname/method literals and postComment call sites. */
  function scan(text) {
    const t = String(text || '');
    scripts.scanned++;
    const res = [
      /@salesforce\/apex\/(\w{1,80})\.(\w{1,80})/g,
      /["']?classname["']?\s*:\s*["'](\w{1,80})["']\s*,\s*["']?method["']?\s*:\s*["'](\w{1,80})["']/g,
      /apex:\/\/(\w{1,80})\/ACTION\$(\w{1,80})/g,
    ];
    for (const re of res) {
      let m;
      while ((m = re.exec(t))) {
        const win = t.slice(m.index + m[0].length, m.index + m[0].length + HIT_WINDOW);
        _addBundle(m[1], m[2], win);
      }
    }
    const pre = /\bpostComment\b/g;
    let m;
    while ((m = pre.exec(t)) && postSites.length < 20) _addPostSite(t.slice(m.index, m.index + m[0].length + HIT_WINDOW), t.slice(Math.max(0, m.index - 400), m.index));
    _scanFeed(t);
    if (t.includes(STAGE_IMPORT)) {
      const u = _unescaped(t);
      for (const src of (u !== t ? [u, t] : [t])) for (const r of analyzeImportCalls(src, STAGE_IMPORT)) if (stageCalls.length < 20) stageCalls.push(r);
      _scanStage(u);
      let sx = 0;
      while ((sx = t.indexOf(STAGE_IMPORT, sx)) >= 0 && stageImports.length < 12) {
        stageImports.push({ len: t.length, at: sx, excerpt: _excerpt(t, sx, 400, 900) });
        sx += STAGE_IMPORT.length;
      }
    }
    if (t.includes(POST_IMPORT)) {
      const u = _unescaped(t);
      if (u !== t && postCalls.length < 20) for (const r of analyzeImportCalls(u)) if (postCalls.length < 20) postCalls.push(r);
      _scanUses(u);
    }
    let ix = 0;
    while ((ix = t.indexOf(POST_IMPORT, ix)) >= 0 && postImports.length < 12) {
      postImports.push({ len: t.length, at: ix, excerpt: _excerpt(t, ix, 400, 900) });
      ix += POST_IMPORT.length;
    }
    if (t.includes(POST_IMPORT) && postCalls.length < 20) {
      for (const r of analyzeImportCalls(t)) if (postCalls.length < 20) postCalls.push(r);
    }
  }

  /** notePageCall(classname, method, paramKeys) — an Apex call the page itself made (names only). */
  function notePageCall(cls, meth, keys) {
    if (!/^\w{1,80}$/.test(cls) || !/^\w{1,80}$/.test(meth)) return;
    const key = cls + '.' + meth;
    const e = page.get(key) || { classname: cls, method: meth, kind: _kind(meth), paramKeys: [], calls: 0 };
    e.calls++;
    for (const k of keys || []) if (/^\w{1,40}$/.test(k) && !e.paramKeys.includes(k) && e.paramKeys.length < 20) e.paramKeys.push(k);
    page.set(key, e);
  }

  function all() {
    const out = new Map();
    for (const e of page.values()) out.set(e.classname + '.' + e.method, { classname: e.classname, method: e.method, kind: e.kind, paramKeys: e.paramKeys.slice() });
    for (const e of bundle.values()) {
      const k = e.classname + '.' + e.method;
      const cur = out.get(k);
      if (cur) { for (const p of e.paramKeys) if (!cur.paramKeys.includes(p)) cur.paramKeys.push(p); } else out.set(k, { classname: e.classname, method: e.method, kind: e.kind, paramKeys: e.paramKeys.slice() });
    }
    return Array.from(out.values());
  }

  function result() {
    const methods = all();
    return {
      scripts: Object.assign({}, scripts),
      bundleMethods: Array.from(bundle.values()),
      pageCalls: Array.from(page.values()),
      reads: methods.filter((m) => m.kind === 'read').map((m) => m.classname + '.' + m.method),
      writes: methods.filter((m) => m.kind === 'write').map((m) => m.classname + '.' + m.method),
      unknown: methods.filter((m) => m.kind === 'unknown').map((m) => m.classname + '.' + m.method),
    };
  }

  return {
    scan, notePageCall, noteDescriptor, all, result, postSites, postCalls, postImports, descriptors, feedActions, uses, scripts, page, bundle,
    stageCalls, stageImports, stageLiterals, stageHandlers,
  };
}

/** _attachNetwork(webContents, census) -> { pending:Set<Promise>, detach } — the probe's own Network listener. */
function _attachNetwork(wc, census) {
  const dbg = wc && wc.debugger;
  const scriptReqs = new Set();
  const pending = new Set();
  const track = (p) => { pending.add(p); p.finally(() => pending.delete(p)); };

  function _isScript(params) {
    const url = params && params.response && params.response.url;
    let u;
    try { u = new URL(String(url || '')); } catch (_) { return false; }
    if (u.hostname !== C.HOST) return false;
    return params.type === 'Script' || /\/s\/sfsites\/l\/|\/components\/|\/modules\//.test(u.pathname);
  }

  function _readAura(body) {
    const p = new URLSearchParams(String(body || ''));
    const m = safeJson(p.get('message') || '');
    const actions = m.ok && m.value && Array.isArray(m.value.actions) ? m.value.actions : [];
    for (const a of actions) {
      if (!a || typeof a !== 'object' || typeof a.descriptor !== 'string') continue;
      const prm = a.params && typeof a.params === 'object' ? a.params : {};
      if (a.descriptor === APEX_DESCRIPTOR) {
        const keys = prm.params && typeof prm.params === 'object' ? Object.keys(prm.params) : [];
        census.notePageCall(String(prm.classname || ''), String(prm.method || ''), keys);
      } else {
        const d = /^apex:\/\/(\w+)\/ACTION\$(\w+)$/.exec(a.descriptor);
        if (d) census.notePageCall(d[1], d[2], Object.keys(prm));
        census.noteDescriptor(a.descriptor, prm);
      }
    }
  }

  function onMessage(_e, method, params) {
    try {
      if (method === 'Network.requestWillBeSent') {
        const rq = params && params.request;
        if (!rq || String(rq.method || '').toUpperCase() !== 'POST') return;
        let u;
        try { u = new URL(String(rq.url || '')); } catch (_) { return; }
        if (u.hostname !== C.HOST || u.pathname !== C.AURA_PATH) return;
        if (typeof rq.postData === 'string' && rq.postData) _readAura(rq.postData);
        else if (rq.hasPostData === true) {
          track(Promise.resolve()
            .then(() => dbg.sendCommand('Network.getRequestPostData', { requestId: params.requestId }))
            .then((r) => { if (r && typeof r.postData === 'string') _readAura(r.postData); })
            .catch(() => {}));
        }
      } else if (method === 'Network.responseReceived') {
        if (_isScript(params)) { scriptReqs.add(params.requestId); census.scripts.seen++; }
      } else if (method === 'Network.loadingFinished') {
        const id = params && params.requestId;
        if (!scriptReqs.has(id)) return;
        scriptReqs.delete(id);
        if (Number(params.encodedDataLength) > BODY_MAX) { census.scripts.skippedLarge++; return; }
        track(Promise.resolve()
          .then(() => dbg.sendCommand('Network.getResponseBody', { requestId: id }))
          .then((r) => {
            let text = r && typeof r.body === 'string' ? r.body : '';
            if (r && r.base64Encoded) text = Buffer.from(text, 'base64').toString('utf8');
            if (text.length > BODY_MAX) { census.scripts.skippedLarge++; return; }
            census.scan(text);
          })
          .catch(() => { census.scripts.failed++; }));
      }
    } catch (_) { /* metadata only */ }
  }

  if (dbg && typeof dbg.on === 'function') dbg.on('message', onMessage);
  return {
    pending,
    detach() { try { if (dbg && typeof dbg.removeListener === 'function') dbg.removeListener('message', onMessage); } catch (_) {} },
  };
}

// ── value walkers (D1 / D2) ───────────────────────────────────────────────
function _walk(v, p, depth, visit) {
  if (depth > 5 || v == null || typeof v !== 'object') return;
  if (Array.isArray(v)) { v.slice(0, 5).forEach((x, i) => { visit(p + '[' + i + ']', '', x); _walk(x, p + '[' + i + ']', depth + 1, visit); }); return; }
  for (const k of Object.keys(v).slice(0, 200)) {
    const kp = p ? p + '.' + k : k;
    visit(kp, k, v[k]);
    _walk(v[k], kp, depth + 1, visit);
  }
}

function _scalar(v) {
  if (typeof v === 'string') return _cap(v, 200);
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
  return undefined;
}

function _pathOf(value, needle) {
  let found = null;
  _walk(value, '', 0, (p, _k, v) => { if (!found && typeof v === 'string' && v.trim() === needle) found = p; });
  if (found) return found;
  _walk(value, '', 0, (p, _k, v) => { if (!found && typeof v === 'string' && v.includes(needle)) found = p; });
  return found;
}

function _d1Of(value) {
  const fields = {};
  const statusValues = [];
  const nullPaths = [];
  let steps = null;
  _walk(value, '', 0, (p, k, v) => {
    if (k && D1_KEY_RE.test(k)) {
      const s = _scalar(v);
      if (s !== undefined && Object.keys(fields).length < 80) fields[p] = s;
      if (/status/i.test(k) && typeof v === 'string' && statusValues.length < 20 && !statusValues.includes(_cap(v, 80))) statusValues.push(_cap(v, 80));
    }
    if (v === null && nullPaths.length < 40) nullPaths.push(p);
    if (!steps && k && /step|milestone/i.test(k) && Array.isArray(v)) steps = { path: p, count: v.length, itemShape: v.length ? shapeOf(v[0], 2) : null };
  });
  return {
    shape: shapeOf(value, 3), fields, unitPath: _pathOf(value, KNOWN_UNIT), serialPath: _pathOf(value, KNOWN_SERIAL),
    statusValues, steps, nullPaths,
  };
}

function _d2Values(value) {
  const money = [];
  const status = [];
  _walk(value, '', 0, (p, k, v) => {
    if (!k) return;
    if (MONEY_KEY_RE.test(k) && money.length < 30 && (typeof v === 'number' || (typeof v === 'string' && /^\s*\$?\s?-?[\d,]+(\.\d+)?\s*$/.test(v)))) money.push({ path: p, value: _scalar(v) });
    if (STATUS_KEY_RE.test(k) && status.length < 30 && (typeof v === 'string' || typeof v === 'boolean')) status.push({ path: p, value: _scalar(v) });
  });
  return { money, status };
}

// ── run state ─────────────────────────────────────────────────────────────
let _armed = false;
let _ran = false;
let _running = false;
let _lastRun = null;

function _logger(log) {
  if (log && typeof log.info === 'function') return log;
  try { return require('../utils/logger')('dtna-probe'); } catch (_) { return { info() {}, warn() {}, error() {} }; }
}
function _errName(e) { return String((e && typeof e === 'object' && e.name) || 'Error').replace(/[^\w.]/g, '').slice(0, 40); }
function _sleep(ms) { return new Promise((r) => { const t = setTimeout(r, Math.max(0, ms)); if (t && t.unref) t.unref(); }); }
function _isDestroyed(w) { try { return !w || !!w.isDestroyed(); } catch (_) { return true; } }

function _resolveDeps(d) {
  const x = d || {};
  return {
    electron: x.electron || null,
    session: x.session || require('../dtna/session'),
    capture: x.capture || require('../dtna/capture'),
    client: x.client || require('../dtna/client'),
    aura: x.aura || require('../dtna/aura'),
    getDataDir: x.getDataDir || (() => require('../config/paths').getDataDir()),
    now: typeof x.now === 'function' ? x.now : () => Date.now(),
    settleMs: Number.isFinite(x.settleMs) ? x.settleMs : SETTLE_MS,
    loadTimeoutMs: Number.isFinite(x.loadTimeoutMs) ? x.loadTimeoutMs : LOAD_TIMEOUT_MS,
    timeoutMs: Number.isFinite(x.timeoutMs) ? x.timeoutMs : OVERALL_TIMEOUT_MS,
    mode: x.mode === 'post' || x.mode === 'stage' ? x.mode : 'full',
    stageOutFile: typeof x.stageOutFile === 'string' && x.stageOutFile ? x.stageOutFile : STAGE_OUT_FILE,
  };
}

function _modeOf(v) { return v === 'post' || v === 'stage' ? v : 'full'; }

/**
 * start({ log, env, _deps }) — the only entry point. Inert (returns false, creates nothing) unless
 * env.FLEET_DEV_DTNA_PROBE === '1'. Otherwise subscribes to the DTNA session status and runs once on
 * the first 'connected'.
 */
function start(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  if (!env || env[ENV_FLAG] !== '1') return false;
  if (_armed) return true;
  const log = _logger(o.log);
  const deps = o._deps || {};
  const session = deps.session || require('../dtna/session');
  _armed = true;
  let unsub = null;
  let stopped = false;
  const onStatus = (s) => {
    if (stopped || _ran || !s || s.state !== 'connected') return;
    stopped = true;
    _ran = true;
    try { if (unsub) unsub(); } catch (_) {}
    _lastRun = run(Object.assign({ mode: _modeOf(env[MODE_FLAG]) }, deps, { log })).catch((e) => { log.warn('[dtna-probe] run threw: ' + _errName(e)); });
  };
  unsub = session.onStatus(onStatus);
  if (stopped) { try { unsub(); } catch (_) {} }
  log.info('[dtna-probe] armed (runs after DTNA sign-in)');
  return true;
}

/** run(deps) — one discovery pass inside a single deadline. Always closes its window and logs done. */
async function run(deps) {
  const log = _logger(deps && deps.log);
  if (_running) { log.info('[dtna-probe] already running'); return { ok: false, code: 'DTNA_PROBE_BUSY' }; }
  _running = true;
  const D = _resolveDeps(deps);
  const at = new Date(D.now()).toISOString();
  const date = at.slice(0, 10);
  const fileName = (D.mode === 'post' ? 'dtna-post-probe-' : D.mode === 'stage' ? 'dtna-stage-probe-' : 'dtna-probe-') + date + '.json';
  const out = {
    version: 1, at, mode: D.mode, targets: (D.mode === 'full' ? TARGETS : TARGETS.slice(0, 1)).map(caseTag),
    d0: null, d1: [], d2: { repairOrders: [], calls: [], skipped: [], needsConfirmation: [] },
    d3: null, d4: null, p1: { sites: [] }, p1b: [], p2: [], classes: {},
  };
  const state = { aborted: false, win: null, cap: null, net: null };
  const census = createCensus();
  let code = null;

  const closeWin = () => {
    try { if (state.net) state.net.detach(); } catch (_) {}
    try { if (state.cap) state.cap.detach(); } catch (_) {}
    try { if (state.win && !_isDestroyed(state.win)) state.win.close(); } catch (_) {}
  };

  let hardTimer = null;
  const hardStop = new Promise((resolve) => {
    hardTimer = setTimeout(() => { state.aborted = true; resolve({ timedOut: true }); }, D.timeoutMs);
    if (hardTimer && typeof hardTimer.unref === 'function') hardTimer.unref();
  });

  try {
    const r = await Promise.race([_steps(D, state, census, out), hardStop]);
    if (r && r.timedOut) code = 'DTNA_PROBE_TIMEOUT';
    else if (r && r.code) code = r.code;
  } catch (e) {
    code = 'DTNA_PROBE_ERROR:' + _errName(e);
  } finally {
    clearTimeout(hardTimer);
    state.aborted = true;
    closeWin();
  }

  if (!out.d0) out.d0 = census.result();
  if (!out.p1.sites.length) out.p1.sites = census.postSites.slice();
  out.p1b = census.postCalls.slice();
  out.p1imports = census.postImports.slice();
  out.pageDescriptors = Array.from(census.descriptors.values());
  out.feedActions = Array.from(census.feedActions.values());
  out.uses = census.uses;
  out.winClosedAtMs = state.closedAt ? state.closedAt - Date.parse(at) : null;
  if (code) out.code = code;
  if (D.mode === 'stage') out.stage = _stageOut(census, state);

  let written = false;
  let stageWritten = false;
  try {
    const cur = D.capture.current ? D.capture.current() : null;
    const secrets = cur ? [cur.context, cur.token, cur.pageURI].filter((s) => typeof s === 'string' && s.length >= 8) : [];
    const json = JSON.stringify(_scrubDeep(out, secrets), null, 1);
    if (D.mode === 'stage') {
      try {
        fs.mkdirSync(path.dirname(D.stageOutFile), { recursive: true });
        fs.writeFileSync(D.stageOutFile, json);
        stageWritten = true;
      } catch (e) {
        code = code || ('DTNA_PROBE_WRITE:' + _errName(e));
      }
    }
    const dir = path.join(D.getDataDir(), 'dev');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileName), json);
    written = true;
  } catch (e) {
    code = code || ('DTNA_PROBE_WRITE:' + _errName(e));
  }

  if (D.mode === 'stage') {
    const s = out.stage || { paramKeys: [], statusLiterals: [] };
    const sline = '[dtna-probe] done mode=stage keys=' + s.paramKeys.length + ' values=' + s.statusLiterals.length
      + ' file=' + (stageWritten ? path.basename(D.stageOutFile) : '-') + (code ? ' code=' + code : '');
    if (code) log.warn(sline); else log.info(sline);
    _running = false;
    return { ok: !code, code: code || undefined, file: written ? fileName : null };
  }

  const d3 = out.d3 || { cases: 0, comments: 0 };
  const line = '[dtna-probe] done d0=' + census.all().length + ' d1=' + out.d1.filter((x) => x.code === 'OK').length
    + ' d2=' + out.d2.calls.filter((x) => x.code === 'OK').length + ' d3=' + (d3.cases || 0) + '/' + (d3.comments || 0)
    + ' p1=' + out.p1.sites.length + ' p1b=' + out.p1b.reduce((n, x) => n + x.calls.length, 0) + ' p2=' + out.p2.reduce((n, x) => n + ((x.fields && x.fields.length) || 0), 0)
    + ' file=' + (written ? fileName : '-') + (code ? ' code=' + code : '');
  if (code) log.warn(line); else log.info(line);
  _running = false;
  return { ok: !code, code: code || undefined, file: written ? fileName : null };
}

async function _load(D, state, url) {
  if (state.aborted || _isDestroyed(state.win)) return;
  await Promise.race([Promise.resolve().then(() => state.win.loadURL(url)).catch(() => {}), _sleep(D.loadTimeoutMs)]);
  await _sleep(D.settleMs);
}

async function _p2(D, state, id) {
  if (state.aborted || _isDestroyed(state.win)) return { caseTag: caseTag(id), code: 'DTNA_PROBE_NO_WINDOW' };
  try {
    const r = await Promise.race([state.win.webContents.executeJavaScript(P2_SCRIPT, true), _sleep(D.loadTimeoutMs).then(() => null)]);
    if (!r || typeof r !== 'object') return { caseTag: caseTag(id), code: 'DTNA_PROBE_NO_RESULT' };
    const list = (a, n) => (Array.isArray(a) ? a.slice(0, n).map((x) => (typeof x === 'string' ? _cap(x, 120) : x)) : []);
    const fields = (Array.isArray(r.fields) ? r.fields.slice(0, 80) : []).filter((f) => f && typeof f === 'object').map((f) => ({
      tag: _cap(f.tag, 60), type: _cap(f.type, 40), name: _cap(f.name, 80), label: _cap(f.label, 120), maxlength: _cap(f.maxlength, 10), required: !!f.required,
    }));
    const hosts = (Array.isArray(r.hosts) ? r.hosts.slice(0, 20) : []).map((x) => _cap(x, 600));
    return { caseTag: caseTag(id), code: 'OK', roots: Number(r.roots) || 0, fields, labels: list(r.labels, 80), options: list(r.options, 80), buttons: list(r.buttons, 80), hosts };
  } catch (e) {
    return { caseTag: caseTag(id), code: 'DTNA_PROBE_SCRIPT:' + _errName(e) };
  }
}

async function _s2(D, state, id) {
  if (state.aborted || _isDestroyed(state.win)) return { caseTag: caseTag(id), code: 'DTNA_PROBE_NO_WINDOW' };
  try {
    const r = await Promise.race([state.win.webContents.executeJavaScript(S2_SCRIPT, true), _sleep(D.loadTimeoutMs).then(() => null)]);
    if (!r || typeof r !== 'object') return { caseTag: caseTag(id), code: 'DTNA_PROBE_NO_RESULT' };
    const items = (Array.isArray(r.items) ? r.items.slice(0, 80) : []).filter((x) => x && typeof x === 'object').map((x) => ({
      tag: _cap(x.tag, 60), label: _cap(x.label, 120), current: !!x.current, complete: !!x.complete,
    }));
    const list = (a, n, c) => (Array.isArray(a) ? a.slice(0, n).filter((x) => typeof x === 'string').map((x) => _cap(x, c)) : []);
    return { caseTag: caseTag(id), code: 'OK', roots: Number(r.roots) || 0, items, buttons: list(r.buttons, 80, 120), hosts: list(r.hosts, 20, 600) };
  } catch (e) {
    return { caseTag: caseTag(id), code: 'DTNA_PROBE_SCRIPT:' + _errName(e) };
  }
}

/** _stageFields(value) -> scalar fields whose key names a status / stage (dotted paths, capped). */
function _stageFields(value) {
  const out = {};
  _walk(value, '', 0, (p, k, v) => {
    if (!k || !/status|stage|step|milestone/i.test(k) || Object.keys(out).length >= 40) return;
    const s = _scalar(v);
    if (s !== undefined) out[p] = s;
  });
  return out;
}

/** _stageOut(census, state) -> the sanitized stage-mode result (key names, literals, DOM labels). */
function _stageOut(census, state) {
  const st = state.stage || {};
  const calls = [];
  for (const rec of census.stageCalls) {
    for (const c of (rec && rec.calls) || []) {
      if (calls.length < 20) calls.push({ via: c.via, argKind: c.argKind, keys: c.keys.slice(), entries: c.entries.slice(), excerpt: c.excerpt });
    }
  }
  const paramKeys = [];
  const addKey = (k) => { if (typeof k === 'string' && /^[\w$]{1,60}$/.test(k) && !paramKeys.includes(k) && paramKeys.length < 30) paramKeys.push(k); };
  for (const c of calls) c.keys.forEach(addKey);
  const b = census.bundle.get('E2E_CaseDetailsLWCController.changeStatus');
  if (b) b.paramKeys.forEach(addKey);
  return {
    imports: { count: census.stageImports.length, at: census.stageImports.map((x) => ({ len: x.len, at: x.at })) },
    calls,
    paramKeys,
    statusLiterals: census.stageLiterals.slice(),
    handlers: census.stageHandlers.slice(),
    dom: st.dom || null,
    caseStageFields: st.record && st.record.caseStageFields ? st.record.caseStageFields : {},
    currentStage: st.record && st.record.currentStage ? st.record.currentStage : null,
    recordCode: st.record ? st.record.code : null,
    pageCalledChangeStatus: Array.from(census.page.values()).some((e) => e.method === 'changeStatus'),
    scripts: Object.assign({}, census.scripts),
  };
}

async function _steps(D, state, census, out) {
  // ── Window: visible, sandboxed, popups denied, capture + own Network listener before the first load. ──
  const electron = D.electron || require('electron');
  const win = new electron.BrowserWindow({
    title: WINDOW_TITLE, width: 1200, height: 900, show: true, autoHideMenuBar: true,
    webPreferences: { partition: C.PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  state.win = win;
  try { win.on('closed', () => { if (!state.aborted) state.closedAt = Date.now(); }); } catch (_) {}
  const wc = win.webContents;
  try { win.on('page-title-updated', (e) => { try { e.preventDefault(); } catch (_) {} }); } catch (_) {}
  try { wc.setWindowOpenHandler(() => ({ action: 'deny' })); } catch (_) {}
  let capCode = null;
  try {
    state.cap = D.capture.createCapture(wc, {});
    state.cap.attach();
  } catch (_) { capCode = 'DTNA_CAPTURE_FAILED'; }
  state.net = _attachNetwork(wc, census);

  await _load(D, state, C.LIST_URL);
  if (D.mode === 'post') {
    // postComment discovery only: the RO test case's Comments tab, DOM read + bundle call sites. No Apex calls.
    // Disable the HTTP cache for this window so the component bundles are re-downloaded and their bodies readable.
    try { await wc.debugger.sendCommand('Network.setCacheDisabled', { cacheDisabled: true }); } catch (_) {}
    const id = TARGETS[0];
    await _load(D, state, C.caseUrl(id));
    await _load(D, state, C.caseUrl(id) + COMMENTS_TAB_QS);
    // Wait (read-only polling) until the composer textarea has rendered.
    let p2 = null;
    for (let i = 0; i < 15 && !state.aborted; i++) {
      p2 = await _p2(D, state, id);
      if (p2 && Array.isArray(p2.fields) && p2.fields.some((f) => f.tag === 'textarea')) break;
      await _sleep(Math.min(3000, D.settleMs || 0));
    }
    if (p2) out.p2.push(p2);
    if (state.net.pending.size) await Promise.allSettled(Array.from(state.net.pending));
    out.d0 = census.result();
    out.p1 = { sites: census.postSites.slice(), sources: census.all().filter((m) => m.method === 'postComment').map((m) => ({ classname: m.classname, paramKeys: m.paramKeys })) };
    return { code: capCode };
  }
  if (D.mode === 'stage') {
    // changeStatus discovery only: the RO test case page, stepper DOM read + bundle call sites, then ONE
    // getCaseRecord read. No write, no click, no _callApexRaw.
    try { await wc.debugger.sendCommand('Network.setCacheDisabled', { cacheDisabled: true }); } catch (_) {}
    const id = TARGETS[0];
    state.stage = { dom: null, record: null };
    await _load(D, state, C.caseUrl(id));
    for (let i = 0; i < 10 && !state.aborted; i++) {
      state.stage.dom = await _s2(D, state, id);
      if (state.stage.dom && Array.isArray(state.stage.dom.items) && state.stage.dom.items.length) break;
      await _sleep(Math.min(3000, D.settleMs || 0));
    }
    if (state.net.pending.size) await Promise.allSettled(Array.from(state.net.pending));
    out.d0 = census.result();
    if (state.aborted) return { code: capCode };
    const r = await D.client.getCaseRecord(id);
    if (r && r.ok) {
      const v = r.value && typeof r.value === 'object' ? r.value : {};
      state.stage.record = { code: 'OK', caseStageFields: _stageFields(v), currentStage: C.caseStageOf(v.Status) };
    } else {
      state.stage.record = { code: String((r && r.code) || 'DTNA_PROBE_NO_RESULT').slice(0, 60) };
    }
    return { code: capCode };
  }
  for (const id of TARGETS) {
    if (state.aborted) break;
    await _load(D, state, C.caseUrl(id));
    await _load(D, state, C.caseUrl(id) + COMMENTS_TAB_QS);
    if (state.aborted) break;
    out.p2.push(await _p2(D, state, id));
  }
  if (state.net.pending.size) await Promise.allSettled(Array.from(state.net.pending));
  if (state.aborted) return { code: null };

  // ── D0 (zero calls) ──
  out.d0 = census.result();
  const methods = census.all();

  // ── D1 ──
  for (const id of TARGETS) {
    if (state.aborted) return {};
    const r = await D.client.getCaseRecord(id);
    out.d1.push(r && r.ok ? Object.assign({ caseTag: caseTag(id), code: 'OK' }, _d1Of(r.value)) : { caseTag: caseTag(id), code: (r && r.code) || 'DTNA_PROBE_NO_RESULT' });
  }

  // ── D2 ──
  const ctx = {};
  for (const id of TARGETS) {
    if (state.aborted) return {};
    const ro = await D.client.getRepairOrderId(id);
    out.d2.repairOrders.push({ caseTag: caseTag(id), code: ro && ro.ok ? 'OK' : ((ro && ro.code) || 'DTNA_PROBE_NO_RESULT'), hasRo: !!(ro && ro.ok && ro.value && ro.value.Id), shape: ro && ro.ok ? shapeOf(ro.value, 2) : null });
    const cm = await D.client.getComments(id);
    let estimateNo = '';
    if (cm && cm.ok && Array.isArray(cm.value)) {
      for (const c of cm.value) { const e = c && (c.EstimateNo || c.EstimateNumber); if (e) { estimateNo = String(e); break; } }
    }
    ctx[id] = { repairOrderId: ro && ro.ok && ro.value && ro.value.Id ? String(ro.value.Id) : '', estimateNo };
  }
  const candidates = [{ classname: FAULTS.classname, method: FAULTS.method, paramKeys: ['caseId'] }];
  for (const m of methods) {
    const matches = D2_NAME_RE.test(m.method) || m.paramKeys.some((k) => D2_NAME_RE.test(k));
    if (!matches) continue;
    if (m.classname === FAULTS.classname && m.method === FAULTS.method) continue;
    if (m.kind !== 'read') {
      if (m.kind === 'unknown') out.d2.needsConfirmation.push(m.classname + '.' + m.method);
      continue;
    }
    candidates.push(m);
  }
  let calls = 0;
  for (const m of candidates) {
    if (!_isSafeRead(m.classname, m.method)) { out.d2.skipped.push({ method: m.classname + '.' + m.method, reason: 'not-a-safe-read' }); continue; }
    for (const id of TARGETS) {
      if (state.aborted) return {};
      if (calls >= D2_CAP) { out.d2.skipped.push({ method: m.classname + '.' + m.method, caseTag: caseTag(id), reason: 'cap' }); continue; }
      const params = {};
      for (const k of m.paramKeys) {
        if (/^caseId$/i.test(k)) params[k] = id;
        else if (/repairOrderId|^roId$/i.test(k) && ctx[id].repairOrderId) params[k] = ctx[id].repairOrderId;
        else if (/estimateNo|estimateNumber/i.test(k) && ctx[id].estimateNo) params[k] = ctx[id].estimateNo;
      }
      if (!Object.keys(params).length) params.caseId = id;
      calls++;
      const r = await D.aura._callApexRaw(m.classname, m.method, params);
      const rec = { method: m.classname + '.' + m.method, caseTag: caseTag(id), paramKeys: Object.keys(params), code: r && r.ok ? 'OK' : ((r && r.code) || 'DTNA_PROBE_NO_RESULT') };
      if (r && r.ok) Object.assign(rec, { shape: shapeOf(r.value, 3) }, _d2Values(r.value));
      out.d2.calls.push(rec);
    }
  }

  // ── D3 ──
  const list = await D.client.listCaseIds();
  if (state.aborted) return {};
  if (!list || !list.ok) out.d3 = { code: (list && list.code) || 'DTNA_PROBE_NO_RESULT', cases: 0, comments: 0, byType: {} };
  else {
    const ids = list.ids.slice(0, D3_CAP);
    const byType = {};
    const sys = { hasEntered: 0, closedThisCase: 0 };
    let comments = 0;
    let cases = 0;
    let failed = 0;
    let next = 0;
    const worker = async () => {
      while (!state.aborted && next < ids.length) {
        const id = ids[next++];
        const r = await D.client.getComments(id);
        if (!r || !r.ok) { failed++; continue; }
        cases++;
        for (const c of r.value) {
          comments++;
          const type = _cap((c && c.CommentType) || '(none)', 80);
          const text = stripHtml(c && c.CommentText);
          const t = byType[type] || (byType[type] = { count: 0, money: 0, estimateWords: 0, examples: [] });
          t.count++;
          const money = MONEY_TEXT_RE.test(text);
          const est = ESTIMATE_TEXT_RE.test(text);
          if (money) t.money++;
          if (est) t.estimateWords++;
          if ((money || est) && t.examples.length < 3) t.examples.push(_cap(text, 300));
          if (/has entered/i.test(text)) sys.hasEntered++;
          if (/closed this case/i.test(text)) sys.closedThisCase++;
        }
      }
    };
    await Promise.all(Array.from({ length: D3_CONCURRENCY }, worker));
    out.d3 = { code: 'OK', listed: list.ids.length, cases, failed, comments, byType, systemPosts: sys };
  }
  if (state.aborted) return {};

  // ── D4 (decision, no calls) ──
  out.d4 = _decide(out);
  // ── P1 (zero calls) ──
  out.p1 = { sites: census.postSites.slice(), sources: census.all().filter((m) => m.method === 'postComment').map((m) => ({ classname: m.classname, paramKeys: m.paramKeys })) };
  // ── classes actually used per read method ──
  for (const m of Object.keys(C.READ_METHODS)) {
    const seen = D.capture.classFor ? D.capture.classFor(m) : null;
    const pageHit = Array.from(census.page.values()).find((e) => e.method === m && /^E2E_/.test(e.classname));
    const bundleHit = Array.from(census.bundle.values()).find((e) => e.method === m && /^E2E_/.test(e.classname));
    if (seen) out.classes[m] = { classname: seen, source: 'capture' };
    else if (pageHit) out.classes[m] = { classname: pageHit.classname, source: 'page' };
    else if (bundleHit) out.classes[m] = { classname: bundleHit.classname, source: 'bundle' };
    else out.classes[m] = { classname: C.APEX_CLASS[m], source: 'default' };
  }
  return { code: capCode };
}

/** _decide(out) -> D4 decision in the findings priority order. */
function _decide(out) {
  const ok = out.d2.calls.filter((c) => c.code === 'OK');
  const structured = ok.find((c) => c.money && c.money.length && c.status && c.status.length);
  if (structured) {
    return { source: 'structured', estimateFields: { method: structured.method, amountPath: structured.money[0].path, statusPath: structured.status[0].path }, note: '' };
  }
  const d1 = out.d1.find((x) => x.code === 'OK' && x.statusValues && x.statusValues.length);
  const amount = ok.find((c) => c.money && c.money.length);
  if (d1 && amount) {
    const statusPath = Object.keys(d1.fields || {}).find((p) => /status/i.test(p)) || null;
    return { source: 'case+amount', estimateFields: { caseStatusPath: statusPath, method: amount.method, amountPath: amount.money[0].path }, note: '' };
  }
  const types = out.d3 && out.d3.byType ? Object.keys(out.d3.byType).filter((t) => out.d3.byType[t].money > 0 && out.d3.byType[t].estimateWords > 0) : [];
  if (types.length) {
    return { source: 'comment', estimateFields: { commentTypes: types.slice(0, 10), amountRe: MONEY_TEXT_RE.source, amountSource: 'comment' }, note: '' };
  }
  return { source: 'none', estimateFields: null, note: "Phase B ships DTNA Total = '—' with status from case" };
}

function _resetForTests() { _armed = false; _ran = false; _running = false; _lastRun = null; }
function _lastRunForTests() { return _lastRun; }

module.exports = {
  start, run, ENV_FLAG, MODE_FLAG, WINDOW_TITLE, analyzeImportCalls, TARGETS, COMMENTS_TAB_QS, P2_SCRIPT, S2_SCRIPT,
  STAGE_IMPORT, STAGE_OUT_FILE,
  createCensus, _isSafeRead, _decide, _scrubDeep, _resetForTests, _lastRunForTests,
};

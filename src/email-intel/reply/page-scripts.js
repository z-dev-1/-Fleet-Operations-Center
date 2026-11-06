'use strict';
/**
 * email-intel/reply/page-scripts.js — in-page scripts for the real Outlook thread reply (design 6.4; R5.4, R5.6,
 * R5.9, F-11, F-21). Each builder returns a JavaScript source string for webContents.executeJavaScript.
 *
 *   buildReplyControlClickScript(mode)   clicks Reply / Reply all inside the NEWEST expanded message block of the
 *                                        open conversation; only when that block has no such control does it use
 *                                        the reading-pane toolbar control. Never a control inside an older block.
 *                                        -> JSON { status:'clicked'|'no-control'|'error', where? }
 *   buildComposeRecipientsCollector()    reads the inline compose form's To / Cc wells (read-only)
 *                                        -> JSON { to:[cand], cc:[cand], found:{ to, cc } }
 *   buildPrependScript(html, { minAdded }) inserts the reply at the TOP of the compose editor and keeps the quoted
 *                                        conversation that OWA put below it: it records the editor text and its hash,
 *                                        collapses a range to the start of the editor and runs insertHTML there
 *                                        (fallback insertAdjacentHTML 'afterbegin' + input events). It never selects
 *                                        the whole editor, never clears it and never pastes.
 *                                        -> JSON { status, quoteHash, afterQuoteHash, added, markerFound, beforeLen, afterLen }
 *
 * Pure helpers shared with the main process (and serialized into the scripts with Function.prototype.toString):
 *   exactLabel(label, mode)                  exact-label rule: 'Reply' never matches 'Reply all'
 *   hasReplyControl(buttons, mode)           capability check on the pane snapshot's button labels
 *   pickReplyControl(blocks, toolbar, mode)  F-21 choice: { where:'block', block, index } | { where:'toolbar', index } | null
 *   textHash(s)                              whitespace-collapsed djb2 hash (hex)
 *   verifyPrepend(result, minAdded)          -> { ok:true } | { ok:false, code:'INSERT_UNVERIFIED', why }
 * The live behavior of insertHTML at the caret start in OWA's editor is unverified until probe P-REPLY-EDIT; until
 * then any unverified insertion ends failed-before-send (the UI offers the labeled non-threaded fallback).
 */
const { EDITOR_SELECTOR } = require('../../scrapers/owa-mailer');
const capturePs = require('../capture/page-scripts');

const BLOCK_SEL = '[role="listitem"], [role="region"], [data-app-section], [aria-expanded]';
const TO_WELLS = Object.freeze(['div[aria-label="To"]', '[role="textbox"][aria-label="To"]', 'div[aria-label^="To" i]', '[aria-label^="To recipients" i]']);
const CC_WELLS = Object.freeze(['div[aria-label="Cc"]', '[role="textbox"][aria-label="Cc"]', 'div[aria-label^="Cc" i]', '[aria-label^="Cc recipients" i]']);

/* eslint-disable no-var */
function exactLabel(label, mode) {
  var n = String(label == null ? '' : label).replace(/\s+/g, ' ').trim().toLowerCase();
  return mode === 'reply-all' ? n === 'reply all' : n === 'reply';
}

function hasReplyControl(buttons, mode) {
  var list = Array.isArray(buttons) ? buttons : [];
  for (var i = 0; i < list.length; i++) if (exactLabel(list[i], mode)) return true;
  return false;
}

/** blocks: [{ collapsed, labels:[string] }] in document order; toolbar: [string] (controls outside every block). */
function pickReplyControl(blocks, toolbar, mode) {
  var bs = Array.isArray(blocks) ? blocks : [];
  var newest = -1;
  for (var i = bs.length - 1; i >= 0; i--) { if (bs[i] && !bs[i].collapsed) { newest = i; break; } }
  if (newest !== -1) {
    var labels = bs[newest].labels || [];
    for (var j = 0; j < labels.length; j++) if (exactLabel(labels[j], mode)) return { where: 'block', block: newest, index: j };
  }
  var tb = Array.isArray(toolbar) ? toolbar : [];
  for (var k = 0; k < tb.length; k++) if (exactLabel(tb[k], mode)) return { where: 'toolbar', index: k };
  return null;
}

function textHash(s) {
  var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  var h = 5381;
  for (var i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
  return h.toString(16);
}
/* eslint-enable no-var */

function verifyPrepend(r, minAdded) {
  if (!r || typeof r !== 'object') return { ok: false, code: 'INSERT_UNVERIFIED', why: 'no-result' };
  if (r.status !== 'ok') return { ok: false, code: 'INSERT_UNVERIFIED', why: String(r.status || 'error').slice(0, 30) };
  if (!r.quoteHash || r.quoteHash !== r.afterQuoteHash) return { ok: false, code: 'INSERT_UNVERIFIED', why: 'quote-changed' };
  if (!(Number(r.added) >= Number(minAdded || 0))) return { ok: false, code: 'INSERT_UNVERIFIED', why: 'too-short' };
  if (r.markerFound !== true) return { ok: false, code: 'INSERT_UNVERIFIED', why: 'no-marker' };
  return { ok: true };
}

const _src = (fn) => fn.toString();

function buildReplyControlClickScript(mode) {
  const m = JSON.stringify(mode === 'reply-all' ? 'reply-all' : 'reply');
  return '(function(){ /*ei-reply:click*/\n' +
    '  try {\n' +
    '    var MODE = ' + m + ';\n' +
    '    var BLOCK_SEL = ' + JSON.stringify(BLOCK_SEL) + ', BODY_SELS = ' + JSON.stringify(capturePs.BODY_SELECTORS) + ', PANE_SELS = ' + JSON.stringify(capturePs.PANE_SELECTORS) + ';\n' +
    '    var exactLabel = ' + _src(exactLabel) + ';\n' +
    '    var pickReplyControl = ' + _src(pickReplyControl) + ';\n' +
    '    var pane = null; for (var p=0;p<PANE_SELS.length && !pane;p++) pane = document.querySelector(PANE_SELS[p]);\n' +
    '    pane = pane || document.body;\n' +
    '    var bodies = pane.querySelectorAll(BODY_SELS.join(","));\n' +
    '    var conts = [];\n' +
    '    for (var i=0;i<bodies.length;i++){ var c = bodies[i].closest ? (bodies[i].closest(BLOCK_SEL) || null) : null; if (c && conts.indexOf(c) === -1) conts.push(c); }\n' +
    '    var blocks = [], els = [];\n' +
    '    for (var b=0;b<conts.length;b++){\n' +
    '      var ct = conts[b]; var txt = (ct.innerText || "").trim();\n' +
    '      var btns = ct.querySelectorAll(\'button[aria-label], [role="button"][aria-label]\');\n' +
    '      var labels = [], list = [];\n' +
    '      for (var q=0;q<btns.length;q++){ labels.push(btns[q].getAttribute("aria-label") || ""); list.push(btns[q]); }\n' +
    '      blocks.push({ collapsed: ct.getAttribute("aria-expanded") === "false" || !txt, labels: labels }); els.push(list);\n' +
    '    }\n' +
    '    var all = document.querySelectorAll(\'button[aria-label], [role="button"][aria-label]\');\n' +
    '    var tLabels = [], tEls = [];\n' +
    '    for (var z=0;z<all.length;z++){ var inside = false; for (var y=0;y<conts.length;y++){ if (conts[y].contains(all[z])) { inside = true; break; } } if (!inside){ tLabels.push(all[z].getAttribute("aria-label") || ""); tEls.push(all[z]); } }\n' +
    '    var r = pickReplyControl(blocks, tLabels, MODE);\n' +
    '    if (!r) return JSON.stringify({ status: "no-control" });\n' +
    '    var el = r.where === "block" ? els[r.block][r.index] : tEls[r.index];\n' +
    '    el.click();\n' +
    '    return JSON.stringify({ status: "clicked", where: r.where });\n' +
    '  } catch(e){ return JSON.stringify({ status: "error" }); }\n' +
    '})();';
}

function buildComposeRecipientsCollector() {
  return '(function(){ /*ei-reply:recipients*/\n' +
    '  try {\n' +
    '    var TO = ' + JSON.stringify(TO_WELLS) + ', CC = ' + JSON.stringify(CC_WELLS) + ';\n' +
    '    function cap(s, n){ s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) : s; }\n' +
    '    function pick(sels){ for (var i=0;i<sels.length;i++){ var el = document.querySelector(sels[i]); if (el) return el; } return null; }\n' +
    '    function read(well){\n' +
    '      var out = []; if (!well) return out;\n' +
    '      var chips = well.querySelectorAll(\'[title], [aria-label], [role="listitem"], span\');\n' +
    '      for (var i=0;i<chips.length && out.length<250;i++){ var c = chips[i]; if (c === well) continue; out.push({ title: cap(c.getAttribute("title"), 200), aria: cap(c.getAttribute("aria-label"), 200), text: cap(c.children && c.children.length ? "" : (c.innerText || c.textContent), 200) }); }\n' +
    '      return out;\n' +
    '    }\n' +
    '    var to = pick(TO), cc = pick(CC);\n' +
    '    return JSON.stringify({ to: read(to), cc: read(cc), found: { to: !!to, cc: !!cc } });\n' +
    '  } catch(e){ return JSON.stringify({ error: "collector-failed" }); }\n' +
    '})();';
}

function buildPrependScript(html, o) {
  const opts = o || {};
  return '(function(){ /*ei-reply:prepend*/\n' +
    '  try {\n' +
    '    var HTML = ' + JSON.stringify(String(html == null ? '' : html)) + ', MARKER = ' + JSON.stringify(String(opts.marker || '')) + ';\n' +
    '    var textHash = ' + _src(textHash) + ';\n' +
    '    function nonWs(s){ return String(s == null ? "" : s).replace(/\\s+/g, "").length; }\n' +
    '    function norm(s){ return String(s == null ? "" : s).replace(/\\s+/g, " ").trim(); }\n' +
    '    var ed = document.querySelector(' + JSON.stringify(EDITOR_SELECTOR) + ');\n' +
    '    if (!ed) return JSON.stringify({ status: "no-editor" });\n' +
    '    var before = norm(ed.innerText);\n' +
    '    var quoteHash = textHash(before);\n' +
    '    var beforeNonWs = nonWs(ed.innerText);\n' +
    '    ed.focus();\n' +
    '    var inserted = false;\n' +
    '    try {\n' +
    '      var sel = window.getSelection(); sel.removeAllRanges();\n' +
    '      var range = document.createRange(); range.setStart(ed, 0); range.collapse(true); sel.addRange(range);\n' +
    '      inserted = document.execCommand("insertHTML", false, HTML) === true;\n' +
    '    } catch (e) { inserted = false; }\n' +
    '    if (!inserted) ed.insertAdjacentHTML("afterbegin", HTML);\n' +
    '    ["input","change"].forEach(function(t){ try { ed.dispatchEvent(new Event(t, { bubbles: true })); } catch(_){} });\n' +
    '    var after = norm(ed.innerText);\n' +
    '    var tail = before.length ? after.slice(Math.max(0, after.length - before.length)) : "";\n' +
    '    var afterQuoteHash = before.length ? textHash(tail) : quoteHash;\n' +
    '    var markerFound = !MARKER || String(ed.innerHTML || "").indexOf(MARKER) !== -1;\n' +
    '    return JSON.stringify({ status: "ok", via: inserted ? "insertHTML" : "afterbegin", quoteHash: quoteHash, afterQuoteHash: afterQuoteHash, added: nonWs(ed.innerText) - beforeNonWs, markerFound: markerFound, beforeLen: before.length, afterLen: after.length });\n' +
    '  } catch(e){ return JSON.stringify({ status: "error" }); }\n' +
    '})();';
}

module.exports = {
  exactLabel, hasReplyControl, pickReplyControl, textHash, verifyPrepend,
  buildReplyControlClickScript, buildComposeRecipientsCollector, buildPrependScript, TO_WELLS, CC_WELLS,
};

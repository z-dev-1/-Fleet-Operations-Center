'use strict';
/**
 * email-intel/capture/page-scripts.js — in-page collectors for the hidden OWA window (design 2.2, 2.3).
 *
 * Every function returns a JavaScript source string for webContents.executeJavaScript. The scripts
 * are READ-ONLY with one exception that the legacy reader also has: the open-row script clicks a
 * message row so the reading pane shows it (OWA may mark it read). Nothing here ever clicks Reply,
 * Reply all, Forward, Delete, Move, Flag or any compose control, and nothing calls a service endpoint.
 * The collectors make no parsing decisions: they return plain JSON that parse-snapshot.js interprets.
 *
 *   buildWaitScript(selector)                 -> "yes" | "no"
 *   buildRowCollector({max, scrollPages})     -> JSON { rows:[rowDesc], reachedEnd, error? }
 *   buildOpenRowScript({convId, ariaKey, scrollTries}) -> JSON { status:'opened'|'row-not-found'|'error', error? }
 *   buildPaneCollector({maxBlocks, rawCap})   -> JSON Snapshot (design 2.3) | { error }
 *
 * The runtime behavior against a live OWA build is validated by the P-DOM probe (emailIntel:dom-probe);
 * tests cover syntax (new Function) and the selector lists.
 */
const owaReader = require('../../scrapers/owa_reader');

const ROW_SELECTOR = owaReader.ROW_SELECTOR;
const BODY_SELECTORS = Object.freeze(['div[aria-label*="Message body" i]', 'div[id*="UniqueMessageBody"]', 'div[role="document"]']);
const PANE_SELECTORS = Object.freeze(['div[aria-label*="Reading Pane" i]', 'div[data-app-section="ConversationContainer"]', 'div[role="main"] div[role="region"]', 'div[role="document"]']);
const BLOCK_CONTAINER_SELECTOR = '[role="listitem"], [role="region"], [data-app-section], [aria-expanded]';
const CONTROL_LABEL_RE = 'show more|view entire|expand|trimmed';

const _int = (v, d, lo, hi) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

function buildWaitScript(selector) {
  return '(function(){return document.querySelector(' + JSON.stringify(String(selector)) + ') ? "yes" : "no";})();';
}

/** Row descriptors for up to `max` rows, scrolling the list at most `scrollPages` times. */
function buildRowCollector(o) {
  o = o || {};
  const max = _int(o.max, 150, 1, 400);
  const pages = _int(o.scrollPages, 3, 0, 10);
  return '(async function(){\n' +
    '  try {\n' +
    '    var ROW_SEL = ' + JSON.stringify(ROW_SELECTOR) + ';\n' +
    '    var MAX = ' + max + ', PAGES = ' + pages + ';\n' +
    '    var out = [], seen = {};\n' +
    '    function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }\n' +
    '    function dataAttrs(el){ var d = {}; if (!el.attributes) return d; for (var i=0;i<el.attributes.length;i++){ var a = el.attributes[i]; if (/^data-(item|msg|message)/i.test(a.name)) d[a.name] = String(a.value||"").slice(0,120); } return d; }\n' +
    '    function collect(){\n' +
    '      var rows = document.querySelectorAll(ROW_SEL), added = 0;\n' +
    '      for (var i=0;i<rows.length && out.length<MAX;i++){\n' +
    '        var r = rows[i];\n' +
    '        var aria = (r.getAttribute("aria-label")||"").trim();\n' +
    '        var txt = (r.innerText||"").trim();\n' +
    '        if (!aria && !txt) continue;\n' +
    '        var convId = r.getAttribute("data-convid") || "";\n' +
    '        var key = convId || (aria||txt).slice(0,120);\n' +
    '        if (seen[key]) continue; seen[key] = 1;\n' +
    '        var hasAttach = !!r.querySelector(\'[aria-label*="attachment" i], [title*="attachment" i], i[data-icon-name*="Attach" i], span[data-icon-name*="Attach" i]\');\n' +
    '        var unread = /^unread\\b/i.test(aria) || !!r.querySelector(\'[aria-label*="unread" i]\');\n' +
    '        var tEl = r.querySelector("time, span[title*=\\":\\"]");\n' +
    '        var tok = tEl ? (tEl.getAttribute("datetime")||tEl.getAttribute("title")||tEl.innerText||"").trim().slice(0,80) : "";\n' +
    '        out.push({ index: out.length, convId: convId, aria: aria.slice(0,600), preview: txt.slice(0,400), hasAttach: hasAttach, unread: unread, itemIdCandidates: { dataAttrs: dataAttrs(r), ids: r.id ? [String(r.id).slice(0,120)] : [] }, timeTokenRaw: tok });\n' +
    '        added++;\n' +
    '      }\n' +
    '      return added;\n' +
    '    }\n' +
    '    function scroller(){\n' +
    '      var r = document.querySelector(ROW_SEL); var el = r ? r.parentElement : null;\n' +
    '      while (el && el !== document.body){ var cs = getComputedStyle(el); if (el.scrollHeight > el.clientHeight + 20 && /(auto|scroll)/.test(cs.overflowY)) return el; el = el.parentElement; }\n' +
    '      return null;\n' +
    '    }\n' +
    '    collect();\n' +
    '    var reachedEnd = false;\n' +
    '    var sc = scroller();\n' +
    '    for (var p=0; p<PAGES && out.length<MAX; p++){\n' +
    '      if (!sc){ reachedEnd = true; break; }\n' +
    '      var before = sc.scrollTop;\n' +
    '      sc.scrollTop = before + sc.clientHeight;\n' +
    '      await sleep(700);\n' +
    '      var n = collect();\n' +
    '      if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4 || sc.scrollTop === before){ reachedEnd = (n === 0); if (n === 0) break; }\n' +
    '    }\n' +
    '    if (sc && PAGES > 0 && out.length < MAX && sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4) reachedEnd = true;\n' +
    '    if (sc){ try { sc.scrollTop = 0; } catch(e){} }\n' +
    '    return JSON.stringify({ rows: out, reachedEnd: reachedEnd });\n' +
    '  } catch(e){ return JSON.stringify({ error: String(e && e.message || e) }); }\n' +
    '})();';
}

/**
 * Open one row in the reading pane. The row is found by its data-convid, else by the first 120
 * characters of its aria label; if it is not rendered (virtualized list) the list is scrolled down up
 * to `scrollTries` times. Only a plain click on the row's own label element, never a toolbar control.
 */
function buildOpenRowScript(o) {
  o = o || {};
  const convId = JSON.stringify(String(o.convId || ''));
  const ariaKey = JSON.stringify(String(o.ariaKey || '').slice(0, 120));
  const tries = _int(o.scrollTries, 6, 0, 12);
  return '(async function(){\n' +
    '  try {\n' +
    '    var ROW_SEL = ' + JSON.stringify(ROW_SELECTOR) + ';\n' +
    '    var CID = ' + convId + ', AK = ' + ariaKey + ';\n' +
    '    function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }\n' +
    '    function find(){\n' +
    '      var rows = document.querySelectorAll(ROW_SEL);\n' +
    '      for (var i=0;i<rows.length;i++){\n' +
    '        var r = rows[i];\n' +
    '        if (CID){ if (r.getAttribute("data-convid") === CID) return r; }\n' +
    '        else if (AK && (r.getAttribute("aria-label")||"").trim().slice(0,120) === AK) return r;\n' +
    '      }\n' +
    '      return null;\n' +
    '    }\n' +
    '    function scroller(){\n' +
    '      var r = document.querySelector(ROW_SEL); var el = r ? r.parentElement : null;\n' +
    '      while (el && el !== document.body){ var cs = getComputedStyle(el); if (el.scrollHeight > el.clientHeight + 20 && /(auto|scroll)/.test(cs.overflowY)) return el; el = el.parentElement; }\n' +
    '      return null;\n' +
    '    }\n' +
    '    var row = find();\n' +
    '    for (var t=0; !row && t<' + tries + '; t++){\n' +
    '      var sc = scroller(); if (!sc) break;\n' +
    '      sc.scrollTop = sc.scrollTop + sc.clientHeight; await sleep(500); row = find();\n' +
    '    }\n' +
    '    if (!row) return JSON.stringify({ status: "row-not-found" });\n' +
    '    try { row.scrollIntoView({ block: "center" }); } catch(e){}\n' +
    '    var target = row.querySelector(\'[role="button"], a, span\') || row;\n' +
    '    target.click();\n' +
    '    return JSON.stringify({ status: "opened" });\n' +
    '  } catch(e){ return JSON.stringify({ status: "error", error: String(e && e.message || e) }); }\n' +
    '})();';
}

/** Snapshot of the open reading pane (design 2.3). No parsing decisions. */
function buildPaneCollector(o) {
  o = o || {};
  const maxBlocks = _int(o.maxBlocks, 12, 1, 12);
  const rawCap = _int(o.rawCap, 60000, 1000, 200000);
  return '(function(){\n' +
    '  try {\n' +
    '    var MAXB = ' + maxBlocks + ', RAW = ' + rawCap + ';\n' +
    '    var PANE_SELS = ' + JSON.stringify(PANE_SELECTORS) + ', BODY_SELS = ' + JSON.stringify(BODY_SELECTORS) + ';\n' +
    '    var BLOCK_SEL = ' + JSON.stringify(BLOCK_CONTAINER_SELECTOR) + ';\n' +
    '    var CTRL_RE = /' + CONTROL_LABEL_RE + '/i;\n' +
    '    var EMAIL_RE = /[\\w.+\'-]+@[\\w-]+(?:\\.[\\w-]+)+/;\n' +
    '    function cap(s, n){ s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) : s; }\n' +
    '    function pick(sels, root){ for (var i=0;i<sels.length;i++){ var el = (root||document).querySelector(sels[i]); if (el) return el; } return null; }\n' +
    '    function attrs(el){ var d = {}; if (!el || !el.attributes) return d; for (var i=0;i<el.attributes.length;i++){ var a = el.attributes[i]; if (/^data-/i.test(a.name) || a.name === "id") d[a.name] = cap(a.value, 120); } return d; }\n' +
    '    function cand(el){ return { title: cap(el.getAttribute("title"), 200), aria: cap(el.getAttribute("aria-label"), 200), text: cap(el.innerText || el.textContent, 400), href: cap(el.getAttribute("href"), 300) }; }\n' +
    '    var pane = pick(PANE_SELS); var paneFallback = false;\n' +
    '    if (!pane){ pane = document.body; paneFallback = true; }\n' +
    '    var bodies = pane.querySelectorAll(BODY_SELS.join(","));\n' +
    '    var uniq = []; for (var i=0;i<bodies.length;i++){ var b = bodies[i]; var dup = false; for (var j=0;j<uniq.length;j++){ if (uniq[j] === b || uniq[j].contains(b) || b.contains(uniq[j])) { dup = true; break; } } if (!dup) uniq.push(b); }\n' +
    '    if (uniq.length) paneFallback = false;\n' +
    '    var blocks = [];\n' +
    '    var list = uniq.length ? uniq.slice(0, MAXB) : [pane];\n' +
    '    for (var k=0;k<list.length;k++){\n' +
    '      var body = list[k];\n' +
    '      var cont = (body !== pane && body.closest) ? (body.closest(BLOCK_SEL) || pane) : pane;\n' +
    '      var text = (body.innerText || "").trim();\n' +
    '      var full = (cont.innerText || "");\n' +
    '      var idx = text ? full.indexOf(text.slice(0, 40)) : -1;\n' +
    '      var header = cap(idx > 0 ? full.slice(0, idx) : full.slice(0, 400), 600);\n' +
    '      var from = [], to = [], cc = [], times = [], atts = [], ctrls = [];\n' +
    '      var mails = cont.querySelectorAll(\'a[href^="mailto:"]\');\n' +
    '      for (var m=0; m<mails.length && from.length<6; m++){ if (!mails[m].closest || !body.contains(mails[m])) from.push(cand(mails[m])); }\n' +
    '      var withAt = cont.querySelectorAll(\'[title*="@"], [aria-label*="@"]\');\n' +
    '      for (var w=0; w<withAt.length && from.length<12; w++){ if (!body.contains(withAt[w])) from.push(cand(withAt[w])); }\n' +
    '      var labels = cont.querySelectorAll("span, div");\n' +
    '      for (var l=0; l<labels.length && l<400; l++){\n' +
    '        var lt = (labels[l].children.length === 0 ? (labels[l].textContent||"") : "").trim();\n' +
    '        var kind = /^to\\s*:?$/i.test(lt) ? "to" : (/^cc\\s*:?$/i.test(lt) ? "cc" : "");\n' +
    '        if (!kind || body.contains(labels[l])) continue;\n' +
    '        var sib = labels[l].nextElementSibling || (labels[l].parentElement && labels[l].parentElement.nextElementSibling);\n' +
    '        if (!sib) continue;\n' +
    '        var targets = sib.querySelectorAll(\'[title], [aria-label], a, span\');\n' +
    '        var dest = kind === "to" ? to : cc;\n' +
    '        if (!targets.length) dest.push(cand(sib));\n' +
    '        for (var x=0; x<targets.length && dest.length<250; x++) dest.push(cand(targets[x]));\n' +
    '      }\n' +
    '      var tEls = cont.querySelectorAll(\'time, [datetime], span[title*=":"], [aria-label*="received" i]\');\n' +
    '      for (var t=0; t<tEls.length && times.length<6; t++){ if (body.contains(tEls[t])) continue; times.push({ tag: tEls[t].tagName.toLowerCase(), datetime: cap(tEls[t].getAttribute("datetime"), 80), title: cap(tEls[t].getAttribute("title"), 120), aria: cap(tEls[t].getAttribute("aria-label"), 120), text: cap(tEls[t].innerText, 80) }); }\n' +
    '      var chips = cont.querySelectorAll(\'[aria-label*="attachment" i], [data-attachmentid], div[role="listitem"][title], button[title*="."]\');\n' +
    '      for (var c=0; c<chips.length && atts.length<20; c++){ var ch = chips[c]; var hrefs = []; var as = ch.querySelectorAll ? ch.querySelectorAll("a[href]") : []; for (var h=0; h<as.length && hrefs.length<3; h++) hrefs.push(cap(as[h].getAttribute("href"), 300)); atts.push({ aria: cap(ch.getAttribute("aria-label"), 200), title: cap(ch.getAttribute("title"), 200), text: cap(ch.innerText, 200), attrs: attrs(ch), hrefs: hrefs }); }\n' +
    '      var btns = cont.querySelectorAll("button, a[role=\\"button\\"], span[role=\\"button\\"]");\n' +
    '      for (var q=0; q<btns.length && ctrls.length<10; q++){ var lb = (btns[q].getAttribute("aria-label") || btns[q].innerText || "").trim(); if (CTRL_RE.test(lb)) ctrls.push(cap(lb, 80)); }\n' +
    '      var collapsed = (cont.getAttribute && cont.getAttribute("aria-expanded") === "false") || (!text && ctrls.length > 0);\n' +
    '      blocks.push({ aria: cap(cont.getAttribute && cont.getAttribute("aria-label"), 200), id: cap(cont.id, 120), idAttrs: Object.assign(attrs(cont), attrs(body)), text: cap(text, RAW), textLen: text.length, collapsed: !!collapsed, headerText: header, fromCandidates: from, toCandidates: to, ccCandidates: cc, timeCandidates: times, attachments: atts, controls: ctrls });\n' +
    '    }\n' +
    '    var subjEl = pick(["div[role=\\"heading\\"][aria-level=\\"2\\"]", "span[role=\\"heading\\"]", "div[aria-label^=\\"Subject\\" i]", "h1", "h2"]);\n' +
    '    var subject = subjEl ? cap((subjEl.innerText || subjEl.textContent || "").trim(), 300) : "";\n' +
    '    var im = location.search.match(/[?&]ItemID=([^&]*)/i);\n' +
    '    var url = location.pathname + (im ? "?ItemID=" + im[1] : "");\n' +
    '    var btnLabels = []; var allBtn = document.querySelectorAll("button[aria-label]");\n' +
    '    for (var z=0; z<allBtn.length && btnLabels.length<12; z++){ var al = allBtn[z].getAttribute("aria-label") || ""; if (/^(reply|reply all|forward)\\b/i.test(al)) btnLabels.push(cap(al, 40)); }\n' +
    '    return JSON.stringify({ url: cap(url, 300), subject: subject, blocks: blocks, paneFallback: paneFallback, buttons: btnLabels });\n' +
    '  } catch(e){ return JSON.stringify({ error: String(e && e.message || e) }); }\n' +
    '})();';
}

module.exports = { ROW_SELECTOR, BODY_SELECTORS, PANE_SELECTORS, buildWaitScript, buildRowCollector, buildOpenRowScript, buildPaneCollector };

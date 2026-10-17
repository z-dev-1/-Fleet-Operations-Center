'use strict';
/**
 * scrapers/dtna_enrich.js — DTNA (Daimler/Freightliner) Servicetracker case
 * comment-thread extractor for the repair timeline.
 *
 * DTNA's Servicetracker (dtna.my.site.com/Servicetracker/s/case/<sfId>) is a
 * Salesforce Lightning community. Its case comment feed is rendered by a custom
 * Lightning component (c:e2E_CaseComments) fed by session-bound Aura/Apex calls
 * — replaying those directly is brittle (live fwuid + aura.token + descriptor
 * UIDs that change on every Salesforce deploy). So, exactly like Decisiv's
 * fallback path, we SCRAPE THE RENDERED comment feed from the page DOM inside
 * the app's warm DTNA vendor partition (vendor_session keeps it logged in).
 * This is the durable approach for Salesforce — no token reverse-engineering.
 *
 * The feed renders as a Chatter-style list: each item has an author line
 * ("AFP FAS (Partner - Y16782)", "CRM Admin (Employee) closed this case...",
 * "<name> updated this record."), a date ("September 24, 2026 at 6:56 AM"),
 * optional status transitions ("Status / In-Repair to Closed"), and body text
 * (often a dated coordinator log like "07/28 — Work order created ..."). We
 * strip the UI chrome (Like / Comment / Write a comment... / Actions for this
 * Feed Item / Expand Post / Sort by / Refresh this feed / End of Feed) and
 * return a clean, timeline-ready thread in the same shape asist_enrich returns.
 *
 * Returns: { ok, caseUrl, source:'dtna', scrapedAt, offsiteText, statusText,
 *            estimateComments, offsiteStage, error }
 * Opt out with DTNA_ENRICH=0.
 */

const { BrowserWindow } = require('electron');
const { partitionForUrl, attachAutoLogin } = require('../orcha/auto-login');
const logger = require('../utils/logger')('dtna-enrich');

const DTNA_CASE_RE = /https?:\/\/dtna\.my\.site\.com\/Servicetracker\/s\/case\/([A-Za-z0-9]+)/i;
const PAGE_LOAD_TIMEOUT = 30000;
const POLL_INTERVAL = 1500;
const POLL_MAX = 24;              // ~36s for the Lightning feed to render

function _empty(caseUrl, err) {
  return { ok: false, caseUrl: caseUrl || '', source: caseUrl ? 'dtna' : 'none',
    scrapedAt: new Date().toISOString(), offsiteText: '', statusText: '',
    estimateComments: '', offsiteStage: '', error: err || null };
}

// In-page script: grab the rendered comment-feed text. The custom component +
// common Salesforce feed containers; fall back to main-region text. Also report
// whether the feed looks READY (has the feed sentinel or enough content) so the
// poller can wait for the lazy Lightning render instead of grabbing a spinner.
const FEED_SCRAPE = String.raw`
(function(){
  function grab(sel){ try { var e=document.querySelector(sel); return e?(e.innerText||''):''; } catch(_){ return ''; } }
  var cands = ['c-e2-e_case-comments','[data-component-id*="e2E_CaseComments"]',
    '.forceChatterFeed','.cuf-feed','[class*="caseComment"]','[class*="CaseComment"]',
    '[role="feed"]','.slds-feed'];
  var best='';
  for (var i=0;i<cands.length;i++){ var t=grab(cands[i]); if(t.length>best.length) best=t; }
  if (best.length < 40) best = grab('main') || (document.body?document.body.innerText:'');
  var ready = /Chatter Feed Items|End of Feed|Write a comment/i.test(best) && best.length > 120;
  return { text: best.slice(0, 20000), ready: ready, len: best.length };
})()
`;

// Lines that are pure Lightning/Chatter UI chrome — never real content.
const _CHROME_RE = /^(sort by:|latest posts|most recent activity|refresh this feed|skip feed|actions for this feed item|like|comment|write a comment\.*|expand post|show more actions|show more|end of feed|\d+\s+chatter feed items|unread|\u00a0|follow|unfollow|add to case)$/i;

// Clean the raw rendered feed text into a dated, timeline-ready thread.
// Groups each feed item: "<author>" + "<date>" + optional "Status <a> to <b>"
// + body text. Drops chrome. Produces lines like:
//   "September 24, 2026 — AFP FAS (Partner): 07/28 — Work order created ... "
//   "October 13, 2026 — CRM Admin: closed this case (In-Repair to Closed)"
function parseFeed(raw) {
  const lines = String(raw || '').split('\n').map(l => l.replace(/\u00a0/g, ' ').trim()).filter(Boolean);
  const DATE_RE = /^[A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4}(\s+at\s+\d{1,2}:\d{2}\s*[AP]M)?$/;
  // An author/action line: "<Name> (Partner...)", "<Name> updated this record.",
  // "<Name> (Employee) closed this case as <X>.", "<Name> (Partner - Y#####)".
  const AUTHOR_RE = /\((Partner|Employee|Customer|Portal)\b|updated this record|closed this case|created this case|changed/i;
  const STATUS_RE = /^Status$/i;

  const entries = [];
  let cur = null;
  const flush = () => {
    if (cur && (cur.body.length || cur.status || cur.action)) {
      const who = cur.author.replace(/\s*\(.*$/, '').trim();
      const bits = [];
      if (cur.action) bits.push(cur.action);
      if (cur.status) bits.push('(' + cur.status + ')');
      if (cur.body.length) bits.push(cur.body.join(' ').replace(/\s+/g, ' ').trim());
      const content = bits.join(' ').trim();
      if (content) entries.push((cur.date ? cur.date + ' \u2014 ' : '') + (who ? who + ': ' : '') + content);
    }
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (_CHROME_RE.test(ln)) continue;
    // Author/action line starts a new feed item.
    if (AUTHOR_RE.test(ln) && ln.length < 120) {
      flush();
      // Capture a trailing action phrase ("closed this case as Closed.", "updated this record.")
      let action = '';
      const am = ln.match(/\b(closed this case[^.]*|created this case[^.]*|updated this record)\b/i);
      if (am) action = am[1].replace(/\.$/, '').trim();
      cur = { author: ln, date: '', status: '', action, body: [] };
      continue;
    }
    if (!cur) continue; // skip preamble before the first author line
    if (DATE_RE.test(ln)) { cur.date = ln.replace(/\s+at\s+.*$/, ''); continue; }
    // Status transition block: "Status" then "<from> to <to>".
    if (STATUS_RE.test(ln)) {
      const nxt = lines[i + 1];
      if (nxt && /\bto\b/i.test(nxt) && nxt.length < 60) { cur.status = nxt.trim(); i++; }
      continue;
    }
    // Attachment noise ("Adobe PDF", a filename) — skip obvious file rows.
    if (/^(adobe pdf|image\/\w+|\d{3,}_\d{6,}_\d+|.*\.(pdf|png|jpe?g|docx?|xlsx?))$/i.test(ln)) continue;
    cur.body.push(ln);
  }
  flush();

  // Newest-first in the DOM; keep chronological-ish order as rendered (Salesforce
  // default is latest-first). Cap length for the timeline.
  return entries.join('\n').slice(0, 8000);
}

// Expand the lazy Lightning feed so the FULL thread renders: scroll to the
// bottom (triggers infinite-scroll loads) and click every "Expand Post" /
// "View More" / "Show more" control. The feed renders collapsed by default, so
// without this an automated scrape only catches the top (latest) item. Safe:
// these are read-only UI toggles, never a submit/comment action.
const EXPAND_SCRIPT = String.raw`
(function(){
  try {
    window.scrollTo(0, document.body.scrollHeight);
    var clicked = 0;
    var els = document.querySelectorAll('a,button,span,[role="button"]');
    for (var i=0;i<els.length;i++){
      var t=(els[i].textContent||'').trim().toLowerCase();
      if (t==='expand post' || t==='view more' || t==='show more' || t==='show more comments' || t==='load more') {
        try { els[i].click(); clicked++; } catch(_){}
      }
    }
    return clicked;
  } catch(e){ return -1; }
})()
`;

async function _pollScrape(win) {
  for (let i = 0; i < POLL_MAX; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
    if (!win || win.isDestroyed()) return null;
    // Every couple ticks, expand/scroll so the full feed loads before scraping.
    if (i % 2 === 0) { try { await win.webContents.executeJavaScript(EXPAND_SCRIPT, true); } catch (_) {} }
    try {
      const d = await win.webContents.executeJavaScript(
        '(function(){try{return ' + FEED_SCRAPE.trim() + '}catch(e){return{text:"",ready:false,len:0};}})()', true);
      // Keep the best (longest) snapshot — the feed grows as items expand.
      if (d && d.text && (!this._best || d.text.length > this._best.length)) this._best = d;
      // Only accept as DONE once ready AND it looks like the full thread settled
      // (give expansion a few ticks; a tiny "ready" snapshot is the collapsed view).
      if (d && d.ready && d.text && d.text.length > 300 && i >= 3) return d;
    } catch (_) {}
  }
  return this._best || null;
}

/**
 * enrichDtna(caseUrl) -> { ok, offsiteText, ... } — scrape a DTNA case's
 * rendered comment feed and return a timeline-ready thread. Mirrors
 * asist_enrich.enrichVolvoAsist's return shape so deep-scan can treat them the
 * same. Never throws — returns _empty(...) on any failure so the caller falls
 * back cleanly.
 */
async function enrichDtna(caseUrl) {
  if (process.env.DTNA_ENRICH === '0') return _empty(caseUrl, 'dtna enrich disabled');
  if (!caseUrl || !DTNA_CASE_RE.test(caseUrl)) return _empty(caseUrl, 'not a DTNA Servicetracker case URL');
  const part = partitionForUrl(caseUrl);
  if (!part) return _empty(caseUrl, 'no DTNA partition');
  logger.info('[dtna] START ' + caseUrl.slice(0, 90));

  return new Promise((resolve) => {
    // Salesforce Lightning needs a real painted viewport to render the feed —
    // size it like a real window, positioned offscreen so it never flashes.
    const win = new BrowserWindow({
      show: false, width: 1400, height: 950, x: -4000, y: -4000,
      paintWhenInitiallyHidden: true,
      webPreferences: { partition: part, nodeIntegration: false, contextIsolation: true, webSecurity: true, backgroundThrottling: false },
    });
    let res = false;
    const done = (v) => { if (!res) { res = true; try { if (!win.isDestroyed()) win.destroy(); } catch (_) {} resolve(v); } };
    const t = setTimeout(() => { logger.warn('[dtna] timeout ' + caseUrl.slice(0, 60)); done(_empty(caseUrl, 'timeout')); },
      PAGE_LOAD_TIMEOUT + POLL_MAX * POLL_INTERVAL + 5000);

    try { attachAutoLogin(win, caseUrl, { maxRetries: 2 }); } catch (_) {}

    win.webContents.once('did-finish-load', async () => {
      try {
        const ctx = { _best: null };
        const d = await _pollScrape.call(ctx, win);
        clearTimeout(t);
        if (!d || !d.text || d.text.length < 40) { logger.warn('[dtna] feed did not render'); return done(_empty(caseUrl, 'feed not rendered')); }
        const thread = parseFeed(d.text);
        if (!thread) { logger.warn('[dtna] feed had no parseable comments'); return done(_empty(caseUrl, 'no comments parsed')); }
        // Infer a coarse stage from the status transitions / closing text.
        let stage = '';
        if (/closed this case|to Closed|Repairs?\s+(are\s+)?completed|Asset Ready/i.test(d.text)) stage = 'ready';
        else if (/In-?Repair|to In-?Repair/i.test(d.text)) stage = 'repair';
        else if (/Arrived|to Arrived/i.test(d.text)) stage = 'arrival';
        logger.info('[dtna] DONE ' + caseUrl.slice(0, 60) + ' | thread ' + thread.length + 'ch | stage ' + (stage || '-'));
        done({
          ok: true, caseUrl, source: 'dtna', scrapedAt: new Date().toISOString(),
          offsiteText: thread, statusText: thread, estimateComments: thread,
          offsiteStage: stage, bestUrl: caseUrl, bestLabel: 'DTNA Case', error: null,
        });
      } catch (e) {
        clearTimeout(t);
        logger.warn('[dtna] scrape error: ' + e.message);
        done(_empty(caseUrl, e.message));
      }
    });
    win.webContents.on('did-fail-load', (_e, code) => { if (code !== -3) { clearTimeout(t); logger.warn('[dtna] did-fail-load ' + code); done(_empty(caseUrl, 'load ' + code)); } });
    win.loadURL(caseUrl);
  });
}

module.exports = { enrichDtna, parseFeed, DTNA_CASE_RE };

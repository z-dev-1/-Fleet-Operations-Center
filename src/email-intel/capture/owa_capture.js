'use strict';
/**
 * email-intel/capture/owa_capture.js — message-level OWA reader (design 2.2).
 *
 *   readMailbox({ folders, plan, checkpoints, onBatch, onFolderDone, signal, deadlineAt, timeoutMs,
 *                 caps, lookbackDays, now, tzMinutes, authGraceMs, _electron, _warm, _sleep })
 *     -> { ok, authBlocked, aborted, timedOut, folders:[FolderOutcome], opened, rowsExamined, rawChars, error? }
 *
 * One hidden window per scan, built like the legacy readInbox (show:false, offscreen, popups denied,
 * default session) and driven through the existing owa_reader / owa-mailer exports only. An auth wall
 * does NOT discard collected data: every batch was already streamed through `onBatch`, which the
 * orchestrator commits (ledger + checkpoint) before the reader continues, so an auth wall, abort or
 * crash loses at most the batch in flight.
 *
 * The reader never clicks Reply, Forward, Delete, Move, Flag or a compose control. Opening a row can
 * mark it read in OWA (existing, documented side effect). Error values are enum codes, never text
 * from the page. Nothing here is logged with message content.
 *
 * FolderOutcome = { folder, status, requested, examined, opened, ingested, skippedKnown, caughtUp,
 *                   backlog, backlogRemaining, newestSeenAt, retried, error? }
 *   status: ok | skipped-budget | partial | timeout | not-found | not-reached | error
 */
const C = require('../constants');
const owaReader = require('../../scrapers/owa_reader');
const owaMailer = require('../../scrapers/owa-mailer');
const identity = require('../ingest/identity');
const fp = require('./folder-plan');
const ps = require('./page-scripts');
const { parseSnapshot } = require('./parse-snapshot');
const { parseReceived } = require('./received-time');
let logger;
try { logger = require('../../utils/logger')('email-intel'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

const { MAILBOX_RE, AUTH_HOST_RE, OUTLOOK_HOST_RE } = owaMailer;
const DAY = 86_400_000;
const AUTH_POLL_MS = 25;

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAuthUrl = (u) => AUTH_HOST_RE.test(u || '') && !OUTLOOK_HOST_RE.test(u || '');

function _freshOutcome(folder, requested, ck) {
  return {
    folder, status: 'not-reached', requested: requested || 0, examined: 0, opened: 0, ingested: 0, skippedKnown: 0, caughtUp: false,
    backlog: !!(ck && ck.backlog), backlogRemaining: (ck && ck.backlogRemaining) || 0, newestSeenAt: (ck && ck.newestReceivedAt) || null, retried: 0,
  };
}

/**
 * openSession(opts, driver) -> result. Warms the OWA session, opens the hidden window, runs
 * `await driver(ctx)` once the mailbox has loaded and settles with whatever the driver left in
 * ctx.state. Shared by readMailbox and the read-only DOM probe.
 * ctx: { exec, execJson, sleep, alive, stopped, selectFolder, state, win, now }
 */
async function openSession(opts, driver) {
  opts = opts || {};
  const electron = opts._electron || require('electron');
  const { BrowserWindow, session } = electron;
  const sleep = opts._sleep || realSleep;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : C.WINDOW_HARD_MS;
  const graceMs = Number.isFinite(opts.authGraceMs) ? opts.authGraceMs : C.AUTH_GRACE_MS;
  const state = { ok: false, authBlocked: false, aborted: false, timedOut: false, error: null };
  const finalize = (extra) => Object.assign({}, state, extra || {});

  try {
    const warm = await (opts._warm || owaMailer.warmOwaSession)({ _electron: electron, timeoutMs: opts.warmupTimeoutMs || 60_000 });
    if (warm && warm.authWall) { state.authBlocked = true; state.error = 'auth-wall-warmup'; return { state, win: null, settled: finalize() }; }
  } catch (e) {
    logger.warn('[email-intel] owa warmup threw (non-fatal) ' + String((e && e.name) || 'Error'));
  }
  if (opts.signal && opts.signal.aborted) { state.aborted = true; return { state, win: null, settled: finalize() }; }

  return new Promise((resolve) => {
    let win = null; let done = false; let started = false; let authGrace = null; let hardTimeout = null;
    const timers = new Set();
    const cleanup = () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      try { if (win && !win.isDestroyed()) win.close(); } catch (_) { /* closing */ }
    };
    const settle = (over) => {
      if (done) return;
      done = true;
      if (hardTimeout) clearTimeout(hardTimeout);
      if (authGrace) clearTimeout(authGrace);
      cleanup();
      Object.assign(state, over || {});
      resolve({ state, win, settled: finalize() });
    };
    const alive = () => !done && !!win && !win.isDestroyed();
    const stopped = () => done || (opts.signal && opts.signal.aborted === true) || state.authBlocked || state.aborted || state.timedOut;
    const curUrl = () => { try { return win && !win.isDestroyed() ? win.webContents.getURL() : ''; } catch (_) { return ''; } };

    // Never act on a login page: wait out an SSO hop (the grace timer settles a real wall).
    const ensureMailbox = async () => {
      while (alive() && isAuthUrl(curUrl())) await new Promise((r) => { const t = setTimeout(r, AUTH_POLL_MS); timers.add(t); });
    };
    const exec = async (script) => {
      if (!alive()) throw new Error('window-gone');
      await ensureMailbox();
      if (!alive()) throw new Error('window-gone');
      return win.webContents.executeJavaScript(script);
    };
    const execJson = async (script) => {
      const raw = await exec(script);
      if (raw && typeof raw === 'object') return raw;
      try { return JSON.parse(String(raw)); } catch (_) { return null; }
    };
    const waitFor = async (selector, attempts, intervalMs) => {
      for (let i = 0; i < attempts; i++) {
        if (!alive()) return false;
        if ((await exec(ps.buildWaitScript(selector))) === 'yes') return true;
        await sleep(intervalMs);
      }
      return false;
    };
    // Folder selection: Inbox by URL, any other folder by clicking its nav label; one retry, then not-found.
    const selectFolder = async (folder) => {
      if (/^inbox$/i.test(folder)) {
        if (!/\/mail\/inbox/i.test(curUrl())) { win.loadURL(owaReader.INBOX_URL); await sleep(2500); }
        return 'selected';
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await exec(owaReader._buildFolderClickScript(folder));
        if (r === 'clicked') { await sleep(C.FOLDER_SWITCH_WAIT_MS); return 'selected'; }
        if (attempt === 0) await sleep(1500);
      }
      return 'not-found';
    };

    const ctx = { exec, execJson, sleep, alive, stopped, selectFolder, waitFor, state, now: Number.isFinite(opts.now) ? opts.now : Date.now(), get win() { return win; } };

    try {
      win = new BrowserWindow({
        width: 1280, height: 900, show: false, x: -32000, y: -32000, skipTaskbar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, session: session.defaultSession },
      });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.on('show', () => { try { win.hide(); } catch (_) { /* hidden window */ } });

      hardTimeout = setTimeout(() => settle({ timedOut: true, error: 'timeout' }), timeoutMs);
      if (opts.signal && typeof opts.signal.addEventListener === 'function') {
        opts.signal.addEventListener('abort', () => settle({ aborted: true, error: 'aborted' }), { once: true });
      }

      // Auth wall: an SSO hop may pass a login host; blocked only if STILL stuck after the grace window.
      const onNav = (_e, url) => {
        if (done) return;
        if (OUTLOOK_HOST_RE.test(url || '')) { if (authGrace) { clearTimeout(authGrace); authGrace = null; } return; }
        if (AUTH_HOST_RE.test(url || '')) {
          if (authGrace) return;
          authGrace = setTimeout(() => {
            authGrace = null;
            if (done) return;
            if (isAuthUrl(curUrl())) settle({ authBlocked: true, error: 'auth-wall' });
          }, graceMs);
        }
      };
      win.webContents.on('did-navigate', onNav);
      win.webContents.on('did-redirect-navigation', onNav);
      win.webContents.on('did-fail-load', (_e, code) => {
        if (code === -3 || done) return;          // -3: normal SPA abort
        logger.warn('[email-intel] owa load failed code=' + code);
      });
      win.webContents.on('did-finish-load', async () => {
        if (done || started) return;
        const url = curUrl();
        if (isAuthUrl(url)) return;                // wait for the grace timer / redirect
        if (!MAILBOX_RE.test(url)) return;         // wait for the real mailbox
        started = true;
        try {
          await driver(ctx);
          settle({});
        } catch (e) {
          if (!done) settle({ error: (e && e.message === 'window-gone') ? 'window-gone' : 'exception' });
        }
      });
      win.loadURL(owaReader.INBOX_URL);
    } catch (_) {
      settle({ error: 'window-error' });
    }
  });
}

/**
 * readMailbox: pass 1 reads each folder (rotated order) up to its quota, pass 2 hands leftover
 * budget to folders that still have unseen rows (backlog folders first).
 */
async function readMailbox(opts) {
  opts = opts || {};
  const folders = Array.isArray(opts.folders) && opts.folders.length ? opts.folders : ['Inbox'];
  const plan = opts.plan || fp.planFolderBudgets({ folders, max: C.MAX_EMAILS_DEFAULT });
  const cps = opts.checkpoints || {};
  const caps = Object.assign({ maxOpen: C.MAX_OPEN_DEFAULT, rawCap: C.SCAN_RAW_CAP }, opts.caps || {});
  const lookbackMs = (Number.isFinite(opts.lookbackDays) ? opts.lookbackDays : C.LOOKBACK_DAYS_DEFAULT) * DAY;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const softMs = Number.isFinite(opts.folderSoftMs) ? Math.min(opts.folderSoftMs, C.FOLDER_SOFT_MS) : C.FOLDER_SOFT_MS;   // tests may only lower it
  const outcomes = {};
  for (const f of plan.order) outcomes[f] = _freshOutcome(f, plan.quota[f], cps[f]);
  const totals = { opened: 0, rowsExamined: 0, rawChars: 0, ingested: 0 };
  const cache = {};            // folder -> { rows, reachedEnd, cursor }
  const seenLocal = {};        // folder -> { convKey: sig } rows committed during THIS scan

  const driver = async (ctx) => {
    const alive = () => ctx.alive() && !ctx.stopped();
    const deadlineNear = () => Number.isFinite(opts.deadlineAt) && opts.deadlineAt - Date.now() < C.DEADLINE_MARGIN_MS;
    const known = (folder, row) => fp.classifyRow(cps[folder], row.convKey, row.sig) === 'known' || (seenLocal[folder] && seenLocal[folder][row.convKey] === row.sig);

    async function collectRows(folder) {
      const j = await ctx.execJson(ps.buildRowCollector({ max: C.ROWS_EXAMINED_PER_FOLDER, scrollPages: C.SCROLL_PAGES }));
      const list = j && Array.isArray(j.rows) ? j.rows : [];
      const rows = list.map((r) => {
        const parsed = owaReader._parseAriaLabel(r.aria || '');
        const convKey = r.convId ? identity.conversationKey(r.convId) : identity.conversationKeyFromAria(r.aria || '');
        const tok = r.timeTokenRaw || parsed.receivedText || '';
        r.timeTokenRaw = tok;
        const t = parseReceived(tok, { now, tzMinutes: opts.tzMinutes });
        return Object.assign({}, r, { convKey, sig: fp.rowSig({ convKey, preview: parsed.preview, msgCountToken: fp.parseMsgCount(r.aria) }), timeIso: t.iso });
      });
      return { rows, reachedEnd: !!(j && j.reachedEnd), cursor: 0, failed: !j || !!j.error };
    }

    async function readFolder(folder, budget) {
      const fo = outcomes[folder];
      const ck = cps[folder] || fp.emptyFolderCheckpoint(folder);
      if (!alive()) return;
      fo.status = 'reading';
      if (!cache[folder]) {
        const sel = await ctx.selectFolder(folder);
        if (sel === 'not-found') { fo.status = 'not-found'; fo.backlog = ck.backlog; return; }
        if (!(await ctx.waitFor(ps.ROW_SELECTOR, 30, 1000))) { fo.status = 'ok'; fo.caughtUp = true; fo.backlog = false; cache[folder] = { rows: [], reachedEnd: true, cursor: 0 }; return; }
        await ctx.sleep(1200);
        cache[folder] = await collectRows(folder);
        if (cache[folder].failed) { fo.status = 'error'; fo.error = 'row-scan-failed'; return; }
        fo.examined = cache[folder].rows.length;
        totals.rowsExamined += fo.examined;
      } else {
        const sel = await ctx.selectFolder(folder);          // pass 2: come back to the folder
        if (sel === 'not-found') { fo.status = 'not-found'; return; }
        await ctx.waitFor(ps.ROW_SELECTOR, 30, 1000);
        await ctx.sleep(800);
      }
      const c = cache[folder];
      let consecutiveKnown = 0; let ingestedHere = 0;
      let stoppedOnKnown = false; let reachedHorizon = false; let budgetExhausted = false; let rawCapHit = false; let openCapHit = false; let deadlineHit = false; let softHit = false;
      let batch = []; let batchMessages = 0;
      const flush = async () => {
        if (!batch.length) return;
        const items = batch; batch = []; batchMessages = 0;
        if (!ctx.alive() || ctx.stopped()) return;           // window gone: the batch in flight is dropped (at most one batch is lost)
        await opts.onBatch(folder, items);
        fo.ingested += items.length; totals.ingested += items.length;
      };
      const firstEver = !ck.lastOkAt && !ck.newestReceivedAt && !Object.keys(ck.seenRows || {}).length;
      const folderStart = Date.now();

      while (c.cursor < c.rows.length) {
        if (!alive()) break;
        const row = c.rows[c.cursor];
        if (known(folder, row)) {
          fo.skippedKnown++; consecutiveKnown++; c.cursor++;
          if (fp.shouldStopOnKnown(consecutiveKnown, ck.backlog)) { stoppedOnKnown = true; break; }
          continue;
        }
        consecutiveKnown = 0;
        if (firstEver && row.timeIso && Date.parse(row.timeIso) < now - lookbackMs) { reachedHorizon = true; break; }
        if (ingestedHere >= budget) { budgetExhausted = true; break; }
        if (totals.opened >= caps.maxOpen) { openCapHit = true; budgetExhausted = true; break; }
        if (totals.rawChars >= caps.rawCap) { rawCapHit = true; budgetExhausted = true; break; }
        if (deadlineNear()) { deadlineHit = true; budgetExhausted = true; break; }
        if ((fo.elapsedMs || 0) + (Date.now() - folderStart) > softMs) { softHit = true; budgetExhausted = true; break; }   // per-folder soft time (both passes): the rest is a backlog

        let snap = null;
        try {
          const o = await ctx.execJson(ps.buildOpenRowScript({ convId: row.convId, ariaKey: row.aria }));
          if (o && o.status === 'opened') {
            await ctx.sleep(C.OPEN_WAIT_MS);
            snap = await ctx.execJson(ps.buildPaneCollector({ maxBlocks: C.MAX_PANE_BLOCKS, rawCap: C.RAW_BODY_CAP }));
          }
        } catch (e) {
          if (!alive()) break;               // the window went away: stop, do not count it as a failed row
          snap = null;
        }
        if (!alive()) break;
        totals.opened++; fo.opened++;
        const { captures, stubs } = parseSnapshot(snap, row, now, { tzMinutes: opts.tzMinutes, folder });
        const previewOnly = captures.length === 1 && captures[0].bodyStatus === 'preview-only';
        if (previewOnly && !fp.shouldCommitPreviewOnly(ck, row.convKey)) {
          fo.retried++; c.cursor++;           // not checkpointed, not committed: retried on a later scan (F-03)
          (outcomes[folder].retryKeys || (outcomes[folder].retryKeys = [])).push(row.convKey);
          continue;
        }
        const real = captures.filter((x) => !x.stub);
        for (const cap of real) {
          cap.rowTimeIso = row.timeIso || null;
          cap.threadContextIncomplete = stubs > 0;
          totals.rawChars += (cap.bodyText || '').length;
          if (cap.receivedAt && (!fo.newestSeenAt || cap.receivedAt > fo.newestSeenAt)) fo.newestSeenAt = cap.receivedAt;
        }
        batch.push({ rowKey: row.convKey, rowSig: row.sig, captures: real, stubs, unread: !!row.unread });
        batchMessages += real.length;
        ingestedHere++; c.cursor++;
        (seenLocal[folder] || (seenLocal[folder] = {}))[row.convKey] = row.sig;
        if (batchMessages >= C.BATCH_MESSAGES) await flush();
      }
      await flush();
      fo.elapsedMs = (fo.elapsedMs || 0) + (Date.now() - folderStart);
      if (!alive()) return;                                          // interrupted: the folder is reported partial

      let leftUnseen = 0;
      for (let i = c.cursor; i < c.rows.length; i++) if (!known(folder, c.rows[i])) leftUnseen++;
      const reachedEnd = c.cursor >= c.rows.length && c.reachedEnd;
      const examinedCap = c.cursor >= c.rows.length && c.rows.length >= C.ROWS_EXAMINED_PER_FOLDER && !budgetExhausted;
      fo.backlog = fp.computeBacklog({ prevBacklog: ck.backlog, budgetExhausted, leftUnseen: reachedHorizon ? 0 : leftUnseen, reachedEnd, reachedHorizon, examinedCap, stoppedOnKnown });
      fo.backlogRemaining = reachedHorizon ? 0 : leftUnseen;
      fo.caughtUp = !fo.backlog;
      fo.hasMore = leftUnseen > 0 && !reachedHorizon && !softHit;
      fo.status = (fo.backlog && fo.backlogRemaining > 0) || rawCapHit || openCapHit || deadlineHit ? 'skipped-budget' : 'ok';
      if (deadlineHit) fo.deadline = true;
      if (typeof opts.onFolderDone === 'function') { try { await opts.onFolderDone(folder, Object.assign({}, fo)); } catch (_) { /* progress hook only */ } }
    }

    // Pass 1.
    for (const f of plan.order) {
      if (!alive()) return;
      await readFolder(f, plan.quota[f]);
    }
    // Pass 2: leftover budget (unused quota + spill) goes to folders that still have unseen rows.
    if (!alive()) return;
    const leftover = Math.max(0, (plan.max || 0) - totals.ingested);
    const hasMore = {};
    for (const f of plan.order) hasMore[f] = !!outcomes[f].hasMore;
    const extra = fp.allocateSpill({ order: plan.order, spill: leftover, hasMore, checkpoints: cps });
    for (const e of extra) {
      if (!alive()) return;
      await readFolder(e.folder, e.extra);
    }
  };

  const session = await openSession(opts, driver);
  const st = session.settled;
  const list = plan.order.map((f) => {
    const o = Object.assign({}, outcomes[f]);
    if (o.status === 'reading') {
      // The folder was being read when the window was closed: committed batches stay, the rest is a backlog.
      o.status = st.timedOut ? 'timeout' : 'partial';
      o.backlog = true; o.caughtUp = false;
    }
    delete o.hasMore; delete o.elapsedMs;
    return o;
  });
  const okFolders = list.filter((f) => f.status === 'ok' || f.status === 'skipped-budget' || f.status === 'partial' || f.status === 'timeout');
  return {
    ok: !st.authBlocked && okFolders.length > 0, authBlocked: !!st.authBlocked, aborted: !!st.aborted, timedOut: !!st.timedOut,
    folders: list, opened: totals.opened, rowsExamined: totals.rowsExamined, rawChars: totals.rawChars, ingested: totals.ingested,
    error: st.error || (okFolders.length ? null : 'no-folder-read'),
  };
}

module.exports = { openSession, readMailbox, isAuthUrl };

'use strict';
/**
 * email-intel/transport/reader.js — readMailbox over the Outlook REST API with the exact owa_capture.readMailbox
 * result contract (design 5.3, 5.4).
 *
 *   readMailbox({ folders, plan, checkpoints, onBatch, signal, deadlineAt, caps, lookbackDays, now,
 *                 apiCursors, isKnownSeed, onApiCursor, attachments?, reextract?, onReextract?, _transport })
 *     -> { ok, authBlocked, aborted, timedOut, folders:[FolderOutcome], opened, rowsExamined, rawChars, ingested, error }
 *
 * Fairness: pass 1 visits plan.order with plan.quota, pass 2 hands leftover budget to folders with more (folder-plan).
 * A budget unit is one conversation group. Per folder the cursor { v, folderId, wm, wmIds, backfillBefore, horizon,
 * orderby } drives seed (newest first), forward (ReceivedDateTime ge wm, oldest first) and backfill modes; the
 * cursor handed to onApiCursor never passes an uncommitted message (it is written only after onBatch, I-3).
 * Conversation context: the 11 newest members through the filter-first ordered query (bounded unordered fallback),
 * newest 10 captured, Deleted Items / Junk members dropped unless that folder is configured (R4-L10).
 * Nothing here logs ids, subjects, addresses or bodies.
 */
const crypto = require('crypto');
const C = require('../constants');
const { TC } = require('./constants');
const endpoints = require('./endpoints');
const E = require('./errors');
const map = require('./map');
const fp = require('../capture/folder-plan');
const identity = require('../ingest/identity');
let logger;
try { logger = require('../../utils/logger')('email-intel'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

const DAY = 86_400_000;
const ORDERBY_CODES = new Set(['InefficientFilter', 'ErrorInvalidProperty']);
const hashId = (id) => crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 12);
const tms = (it) => Date.parse(it && it.ReceivedDateTime) || 0;
const isoOf = (ms) => new Date(ms).toISOString();
const ascCmp = (a, b) => (tms(a) - tms(b)) || String(a.Id).localeCompare(String(b.Id));
const descCmp = (a, b) => -ascCmp(a, b);
const validItem = (it) => !!it && typeof it.Id === 'string' && !!it.Id && it.Id.length <= TC.ITEM_ID_MAX && typeof it.ConversationId === 'string' && !!it.ConversationId && Number.isFinite(Date.parse(it.ReceivedDateTime));

class Stop extends Error { constructor(kind) { super('stop'); this.kind = kind; } }

function _freshOutcome(folder, requested, ck) {
  return {
    folder, status: 'not-reached', requested: requested || 0, examined: 0, opened: 0, ingested: 0, skippedKnown: 0, caughtUp: false,
    backlog: !!(ck && ck.backlog), backlogRemaining: (ck && ck.backlogRemaining) || 0, newestSeenAt: (ck && ck.newestReceivedAt) || null, retried: 0,
  };
}

function _validCursor(c) {
  return !!c && typeof c === 'object' && c.v === 1 && typeof c.folderId === 'string' && c.folderId;
}

async function readMailbox(opts) {
  opts = opts || {};
  const deps = opts._transport || require('./index').deps();
  const http = deps.http;
  const folderRes = deps.folders;
  const owaRe = deps.owaRe || _owaRe();
  const folders = Array.isArray(opts.folders) && opts.folders.length ? opts.folders : ['Inbox'];
  const plan = opts.plan || fp.planFolderBudgets({ folders, max: C.MAX_EMAILS_DEFAULT });
  const cps = opts.checkpoints || {};
  const caps = Object.assign({ maxOpen: C.MAX_OPEN_DEFAULT, rawCap: C.SCAN_RAW_CAP }, opts.caps || {});
  const lookbackMs = (Number.isFinite(opts.lookbackDays) ? opts.lookbackDays : C.LOOKBACK_DAYS_DEFAULT) * DAY;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const softMs = Number.isFinite(opts.folderSoftMs) ? Math.min(opts.folderSoftMs, C.FOLDER_SOFT_MS) : C.FOLDER_SOFT_MS;
  const att = opts.attachments && opts.attachments.flagOn === true && opts.attachments.budget ? opts.attachments : null;
  const isKnownSeed = typeof opts.isKnownSeed === 'function' ? opts.isKnownSeed : () => false;
  const spec = { signal: opts.signal };
  const outcomes = {};
  for (const f of plan.order) outcomes[f] = _freshOutcome(f, plan.quota[f], cps[f]);
  const totals = { opened: 0, rowsExamined: 0, rawChars: 0, ingested: 0 };
  const st = { authBlocked: false, aborted: false, tokenUnavailable: false, refused: false };
  const cursors = {};
  for (const f of plan.order) cursors[f] = _validCursor(opts.apiCursors && opts.apiCursors[f]) ? JSON.parse(JSON.stringify(opts.apiCursors[f])) : null;
  const seenSeeds = new Set();
  const doneConvs = new Set();
  const stats = { dropped: 0, badId: 0, skippedFolder: 0 };
  let convOrderby = true;
  let excluded = null;            // Set of Deleted Items / Junk folder ids not configured for this scan (R4-L10)
  const resolvedIds = {};

  const stopped = () => st.authBlocked || st.aborted || st.tokenUnavailable || st.refused;
  const deadlineNear = () => Number.isFinite(opts.deadlineAt) && opts.deadlineAt - Date.now() < C.DEADLINE_MARGIN_MS;
  const labelOf = (id) => folderRes.labelOf(id);
  const get = (path, op) => http.get(path, Object.assign({ op }, spec));

  async function _excluded() {
    if (excluded) return excluded;
    excluded = new Set();
    for (const label of ['Deleted Items', 'Junk Email']) {
      try {
        const id = await folderRes.resolve(label);
        if (id && id !== 'not-found' && !Object.values(resolvedIds).includes(id)) {
          let configured = false;
          for (const f of folders) {
            if (folderRes.wellKnownName && folderRes.wellKnownName(f) && folderRes.wellKnownName(f) === folderRes.wellKnownName(label)) configured = true;
          }
          if (!configured) excluded.add(id);
        }
      } catch (e) {
        if (e instanceof E.ApiAuthBlockedError || e instanceof E.TokenUnavailableError || e instanceof E.AbortedError) throw e;
        /* unknown: nothing excluded for this folder */
      }
    }
    return excluded;
  }

  /** Pages of a list query (nextLink through rebaseNextLink), up to maxPages. */
  async function _pages(first, maxPages, op) {
    const items = []; let path = first; let pages = 0; let nextLeft = false;
    while (path && pages < maxPages) {
      const r = await get(path, op);
      pages++;
      for (const it of (r && r.json && Array.isArray(r.json.value) ? r.json.value : [])) items.push(it);
      const next = r && r.json && r.json['@odata.nextLink'];
      if (!next) { path = null; break; }
      const p = endpoints.rebaseNextLink(next, owaRe && owaRe.OUTLOOK_HOST_RE);
      if (!p) { logger.info('[email-api] op=' + op + ' err=nextlink-host'); nextLeft = true; path = null; break; }
      path = p;
    }
    if (path) nextLeft = true;
    return { items, nextLeft };
  }

  async function _orderedOrFallback(cur, fid, build, op) {
    if (cur.orderby !== false) {
      try { return await _pages(build(true), TC.FORWARD_MAX_PAGES, op); } catch (e) {
        if (!(e instanceof E.ApiHttpError && e.status === 400 && ORDERBY_CODES.has(e.apiCode))) throw e;
        cur.orderby = false;
      }
    }
    return _pages(build(false), TC.FORWARD_MAX_PAGES, op);
  }

  async function buildGroup(item, label, fo) {
    let members = []; let incomplete = false;
    const cid = item.ConversationId;
    if (convOrderby) {
      try {
        const r = await get(endpoints.conversation(cid, true), 'conv');
        members = r && r.json && Array.isArray(r.json.value) ? r.json.value : [];
        if (r && r.json && r.json['@odata.nextLink']) incomplete = true;
      } catch (e) {
        if (!(e instanceof E.ApiHttpError && e.status === 400 && ORDERBY_CODES.has(e.apiCode))) throw e;
        convOrderby = false;
      }
    }
    if (!convOrderby) {
      const p = await _pages(endpoints.conversation(cid, false), TC.CONVERSATION_FALLBACK_PAGES, 'conv');
      members = p.items;
      if (p.nextLeft) incomplete = true;
    }
    const ex = await _excluded();
    const kept = [];
    for (const m of members) {
      if (!validItem(m) || m.IsDraft === true) continue;
      if (typeof m.ParentFolderId === 'string' && ex.has(m.ParentFolderId)) { stats.skippedFolder++; continue; }
      kept.push(m);
    }
    if (!kept.some((m) => m.Id === item.Id)) kept.push(item);
    kept.sort(ascCmp);
    if (kept.length > TC.CONTEXT_MAX) incomplete = true;
    let ctxList = kept.slice(-TC.CONTEXT_MAX);
    if (!ctxList.some((m) => m.Id === item.Id)) ctxList = [item].concat(ctxList.slice(1));
    const latestId = kept[kept.length - 1].Id;
    const convKey = identity.conversationKey(map.legacyConvId(cid));
    const captures = [];
    for (let i = 0; i < ctxList.length; i++) {
      const m = ctxList[i];
      const seed = map.keySeedOf(m);
      if (isKnownSeed(seed) || seenSeeds.has(seed)) continue;
      if (totals.opened >= caps.maxOpen) { incomplete = true; break; }
      let full = null; let preview = false;
      try {
        full = (await get(endpoints.message(m.Id), 'get')).json;
      } catch (e) {
        if (!(e instanceof E.ResponseTooLargeError)) throw e;
        full = (await get(endpoints.messageLite(m.Id), 'get')).json;
        preview = true;
      }
      totals.opened++; fo.opened++;
      let atts = [];
      if (full && full.HasAttachments === true) {
        const r = await get(endpoints.attachments(m.Id), 'att-list');
        atts = r && r.json && Array.isArray(r.json.value) ? r.json.value : [];
      }
      const cap = map.toCapture(full, { folderLabel: label, labelOf, isLatest: m.Id === latestId, blockIndex: i, attachments: atts, preview, stats });
      if (!cap) continue;
      if (att && cap.isLatest && (cap.attachments || []).some((x) => x && !x.placeholder && x.name)) {
        const r = await require('../attach/extract').analyzeAttachments({
          attachments: cap.attachments, budget: att.budget, flagOn: true, unitIds: att.unitIds, signal: opts.signal, deps: att.deps,
          fetchOne: typeof att.apiFetchOne === 'function' ? att.apiFetchOne : require('./attachments').createFetchOne({ http, itemId: cap.itemId, signal: opts.signal }),
        });
        cap.attachments = r.attachments;
        if (r.excerpts && r.excerpts.length) cap.attachmentExcerpts = r.excerpts;
        if (r.authBlocked) throw new E.ApiAuthBlockedError();
      }
      seenSeeds.add(seed);
      captures.push(cap);
    }
    for (const cap of captures) {
      cap.threadContextIncomplete = incomplete;
      cap.rowTimeIso = cap.receivedAt;
      totals.rawChars += (cap.bodyText || '').length;
      if (cap.receivedAt && (!fo.newestSeenAt || cap.receivedAt > fo.newestSeenAt)) fo.newestSeenAt = cap.receivedAt;
    }
    return { rowKey: convKey, rowSig: map.rowSigOf(convKey, kept), captures, stubs: 0, unread: item.IsRead === false };
  }

  async function readFolder(label, budget, retried) {
    const fo = outcomes[label];
    if (stopped()) return;
    fo.status = 'reading';
    const folderStart = Date.now();
    let fid;
    try { fid = await folderRes.resolve(label, spec); } catch (e) { _globalError(e, fo); return; }
    if (!fid || fid === 'not-found') { fo.status = 'not-found'; return; }
    resolvedIds[label] = fid;
    const horizonMs = now - lookbackMs;
    const horizon = isoOf(horizonMs);
    let cur = cursors[label];
    if (cur && cur.folderId !== fid) cur = null;
    const mode0 = !cur ? 'seed' : 'forward';
    if (!cur) cur = { v: 1, folderId: fid, wm: null, wmIds: [], backfillBefore: null, horizon, orderby: true };
    cur.horizon = horizon;

    let groupsHere = 0; let batch = []; let batchMessages = 0;
    let stopReason = null; let hasMore = false; let backlogRemaining = 0;
    const flush = async (commitFn) => {
      if (batch.length) {
        const items = batch; batch = []; batchMessages = 0;
        await opts.onBatch(label, items);
        fo.ingested += items.length; totals.ingested += items.length;
      }
      if (commitFn) commitFn();
      cursors[label] = cur;
      if (typeof opts.onApiCursor === 'function') await opts.onApiCursor(label, JSON.parse(JSON.stringify(cur)));
    };
    const capStop = () => {
      if (groupsHere >= budget) return 'budget';
      if (totals.opened >= caps.maxOpen) return 'open-cap';
      if (totals.rawChars >= caps.rawCap) return 'raw-cap';
      if (deadlineNear()) return 'deadline';
      if ((fo.elapsedMs || 0) + (Date.now() - folderStart) > softMs) return 'soft';
      if (opts.signal && opts.signal.aborted) return 'aborted';
      return null;
    };

    /**
     * process(ordered, commit): walks the candidates in processing order; commit(prefix) updates `cur` for the
     * committed prefix (indexes 0..k). Returns the count of unprocessed candidates.
     */
    const processList = async (ordered, commit) => {
      let committedIdx = -1; let pendingFrom = -1; let i = 0;
      const doCommit = (k) => { if (k >= 0) commit(ordered.slice(0, k + 1)); };
      try {
        for (; i < ordered.length; i++) {
          const item = ordered[i];
          const seed = map.keySeedOf(item);
          const convKey = identity.conversationKey(map.legacyConvId(item.ConversationId));
          if (isKnownSeed(seed) || seenSeeds.has(seed)) { fo.skippedKnown++; if (pendingFrom === -1) committedIdx = i; continue; }
          if (doneConvs.has(convKey)) { if (pendingFrom === -1) committedIdx = i; continue; }
          const why = capStop();
          if (why) { stopReason = why; break; }
          const g = await buildGroup(item, label, fo);
          doneConvs.add(convKey);
          seenSeeds.add(seed);
          batch.push(g);
          batchMessages += g.captures.length;
          groupsHere++;
          if (pendingFrom === -1) pendingFrom = i;
          if (batchMessages >= C.BATCH_MESSAGES) {
            const k = i;
            await flush(() => doCommit(k));
            committedIdx = k; pendingFrom = -1;
          }
        }
        const k = pendingFrom === -1 ? committedIdx : i - 1;
        await flush(() => doCommit(k));
        committedIdx = k;
      } catch (e) {
        // every group in the batch is complete: keep it, then stop
        if (batch.length && !(e instanceof Stop)) {
          const k = i - 1;
          try { await flush(() => doCommit(k)); } catch (_) { /* store failure: the error below wins */ }
        }
        throw e;
      }
      return ordered.length - 1 - committedIdx;
    };

    try {
      if (mode0 === 'seed') {
        const top = Math.max(1, Math.min(TC.SEED_TOP_MAX, budget * 3));
        const r = await get(endpoints.listSeed(fid, top), 'list');
        const listed = (r && r.json && Array.isArray(r.json.value) ? r.json.value : []).filter(validItem).filter((it) => it.IsDraft !== true);
        const nextLink = !!(r && r.json && r.json['@odata.nextLink']);
        fo.examined += listed.length; totals.rowsExamined += listed.length;
        const inWindow = listed.filter((it) => tms(it) >= horizonMs).sort(descCmp);
        const olderDropped = inWindow.length < listed.length;
        const newest = listed.length ? listed.slice().sort(descCmp)[0] : null;
        const left = await processList(inWindow, (prefix) => {
          if (newest) { cur.wm = isoOf(tms(newest)); cur.wmIds = listed.filter((it) => tms(it) === tms(newest)).map((it) => hashId(it.Id)).slice(0, TC.WM_IDS_MAX); }
          const rest = inWindow.length > prefix.length || (nextLink && !olderDropped);
          cur.backfillBefore = rest && prefix.length ? isoOf(tms(prefix[prefix.length - 1])) : (rest ? cur.backfillBefore : null);
        });
        if (!listed.length) { cur.wm = cur.wm || null; await flush(null); }
        backlogRemaining = left;
        hasMore = left > 0 || cur.backfillBefore != null;
      } else {
        // forward: everything at or after the watermark, oldest first
        const p = await _orderedOrFallback(cur, fid, (ob) => endpoints.listForward(fid, cur.wm || horizon, ob), 'list');
        const wmMs = cur.wm ? Date.parse(cur.wm) : -1;
        const wmSet = new Set(cur.wmIds || []);
        const listed = p.items.filter(validItem).filter((it) => it.IsDraft !== true);
        fo.examined += listed.length; totals.rowsExamined += listed.length;
        const cands = listed.filter((it) => !(tms(it) === wmMs && wmSet.has(hashId(it.Id)))).sort(ascCmp);
        const canAdvance = cur.orderby !== false || !p.nextLeft;
        const left = await processList(cands, (prefix) => {
          if (!canAdvance || !prefix.length) return;
          const last = tms(prefix[prefix.length - 1]);
          const ids = prefix.filter((it) => tms(it) === last).map((it) => hashId(it.Id));
          const merged = last === wmMs ? Array.from(new Set((cur.wmIds || []).concat(ids))) : ids;
          cur.wm = isoOf(last);
          cur.wmIds = merged.slice(-TC.WM_IDS_MAX);
        });
        backlogRemaining = left;
        hasMore = left > 0 || p.nextLeft;
        // backfill toward the lookback horizon once forward is drained
        if (!hasMore && !stopReason && cur.backfillBefore && groupsHere < budget) {
          if (Date.parse(cur.backfillBefore) <= horizonMs) cur.backfillBefore = null;
          else {
            const before = cur.backfillBefore;
            const b = await _orderedOrFallback(cur, fid, (ob) => endpoints.listBackfill(fid, horizon, before, ob), 'list');
            const bl = b.items.filter(validItem).filter((it) => it.IsDraft !== true).sort(descCmp);
            fo.examined += bl.length; totals.rowsExamined += bl.length;
            const advance = cur.orderby !== false || !b.nextLeft;
            const bleft = await processList(bl, (prefix) => {
              if (!advance) return;
              if (prefix.length === bl.length && !b.nextLeft) { cur.backfillBefore = null; return; }
              if (prefix.length) cur.backfillBefore = isoOf(tms(prefix[prefix.length - 1]));
            });
            if (!bl.length) { cur.backfillBefore = null; await flush(null); }
            backlogRemaining += bleft;
          }
          hasMore = backlogRemaining > 0 || cur.backfillBefore != null;
        }
      }
    } catch (e) {
      if (e instanceof E.ApiHttpError && e.status === 404 && !retried) {
        folderRes.invalidate(label);
        fo.elapsedMs = (fo.elapsedMs || 0) + (Date.now() - folderStart);
        return readFolder(label, budget - groupsHere, true);
      }
      fo.elapsedMs = (fo.elapsedMs || 0) + (Date.now() - folderStart);
      if (_folderError(e, fo)) { fo.hasMore = true; return; }
      _globalError(e, fo);
      return;
    }
    fo.elapsedMs = (fo.elapsedMs || 0) + (Date.now() - folderStart);
    fo.hasMore = hasMore && stopReason !== 'soft';
    fo.backlog = hasMore;
    fo.backlogRemaining = backlogRemaining;
    fo.caughtUp = !hasMore;
    if (stopReason === 'aborted') { st.aborted = true; fo.status = 'partial'; return; }
    fo.status = stopReason && hasMore ? 'skipped-budget' : 'ok';
    if (stopReason === 'deadline') fo.deadline = true;
  }

  /** Folder-level errors: the next folder still runs. Returns false for read-level errors. */
  function _folderError(e, fo) {
    if (e instanceof E.ThrottledError) { fo.status = 'partial'; fo.error = 'throttled'; fo.backlog = true; fo.caughtUp = false; return true; }
    if (e instanceof E.ApiHttpError) { fo.status = 'error'; fo.error = 'http-' + e.status; return true; }
    if (e instanceof E.ApiTimeoutError) { fo.status = 'error'; fo.error = 'timeout'; return true; }
    if (e instanceof E.ApiNetworkError) { fo.status = 'error'; fo.error = 'network'; return true; }
    if (e instanceof E.ResponseTooLargeError) { fo.status = 'error'; fo.error = 'too-large'; return true; }
    if (e instanceof E.RequestRefusedError) { fo.status = 'error'; fo.error = 'refused'; return true; }
    return false;
  }
  function _globalError(e, fo) {
    if (e instanceof E.ApiAuthBlockedError) { st.authBlocked = true; fo.status = 'partial'; return; }
    if (e instanceof E.TokenUnavailableError) { st.tokenUnavailable = true; fo.status = 'partial'; return; }
    if (e instanceof E.AbortedError) {
      if (e.reason === 'deadline') { fo.status = 'skipped-budget'; fo.deadline = true; return; }
      st.aborted = true; fo.status = 'partial'; return;
    }
    if (_folderError(e, fo)) return;
    throw e;                                            // store / programming errors reach the orchestrator
  }

  // Pass 1.
  for (const f of plan.order) {
    if (stopped()) break;
    await readFolder(f, plan.quota[f], false);
  }
  // Pass 2: leftover budget (unused quota + spill) goes to folders that still have more.
  if (!stopped()) {
    const leftover = Math.max(0, (plan.max || 0) - totals.ingested);
    const hasMore = {};
    for (const f of plan.order) hasMore[f] = !!outcomes[f].hasMore && (outcomes[f].status === 'ok' || outcomes[f].status === 'skipped-budget');
    const extra = fp.allocateSpill({ order: plan.order, spill: leftover, hasMore, checkpoints: cps });
    for (const x of extra) {
      if (stopped() || deadlineNear()) break;
      await readFolder(x.folder, x.extra, false);
    }
  }
  // Re-extract (F-14): targets with a REST item id; DOM records without one are not reachable (no DOM fallback).
  if (!stopped() && att && Array.isArray(opts.reextract) && opts.reextract.length) await _reextract();

  async function _reextract() {
    const report = async (t, r) => { if (typeof opts.onReextract === 'function') { try { await opts.onReextract(t, r); } catch (_) { /* commit hook only */ } } };
    for (const t of opts.reextract) {
      if (stopped() || deadlineNear() || totals.opened >= caps.maxOpen || att.budget.used >= att.budget.policy.maxPerScan) break;
      if (typeof t.itemId !== 'string' || !t.itemId) { await report(t, { status: 'not-found' }); continue; }
      try {
        await get(endpoints.attachments(t.itemId), 'att-list');
      } catch (e) {
        if (e instanceof E.ApiHttpError && e.status === 404) { await report(t, { status: 'not-found' }); continue; }
        if (e instanceof E.ApiAuthBlockedError) { st.authBlocked = true; break; }
        await report(t, { status: 'open-failed' });
        continue;
      }
      totals.opened++;
      const r = await require('../attach/extract').analyzeAttachments({
        attachments: t.attachments, only: new Set(t.indexes), reextract: true, budget: att.budget, flagOn: true, unitIds: att.unitIds,
        signal: opts.signal, deps: att.deps,
        fetchOne: typeof att.apiFetchOne === 'function' ? att.apiFetchOne : require('./attachments').createFetchOne({ http, itemId: t.itemId, signal: opts.signal }),
      });
      await report(t, { status: 'ok', attachments: r.attachments, excerpts: r.excerpts, stats: r.stats });
      if (r.authBlocked) { st.authBlocked = true; break; }
    }
  }

  const list = plan.order.map((f) => {
    const o = Object.assign({}, outcomes[f]);
    if (o.status === 'reading') { o.status = 'partial'; o.backlog = true; o.caughtUp = false; }
    delete o.hasMore; delete o.elapsedMs;
    return o;
  });
  const error = st.tokenUnavailable ? 'api-token-unavailable' : (st.refused ? 'refused' : null);
  const timedOut = list.some((f) => f.deadline === true);
  const ok = !st.authBlocked && !st.aborted && !error && list.some((f) => ['ok', 'skipped-budget', 'partial'].includes(f.status));
  if (stats.dropped || stats.badId || stats.skippedFolder) logger.info('[email-api] read dropped=' + stats.dropped + ' badId=' + stats.badId + ' skippedFolder=' + stats.skippedFolder);
  return {
    ok, authBlocked: st.authBlocked, aborted: st.aborted, timedOut,
    folders: list, opened: totals.opened, rowsExamined: totals.rowsExamined, rawChars: totals.rawChars, ingested: totals.ingested,
    error: error || (ok ? null : (st.authBlocked ? 'auth-wall' : (st.aborted ? 'aborted' : 'no-folder-read'))),
  };
}

function _owaRe() { try { return require('../../scrapers/owa-mailer'); } catch (_) { return null; } }

module.exports = { readMailbox, hashId };

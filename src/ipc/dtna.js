'use strict';
/**
 * ipc/dtna.js — DTNA Service Tracker IPC (user-initiated Aura reads only).
 *
 * Channels: dtna:status, dtna:login, dtna:pull-unit, dtna:list-cases, dtna:bulk-pull (+ dtna:progress
 * events), dtna:bulk-cancel, dtna:export, dtna:draft-comment (AI text only, no network to DTNA) and
 * dtna:post-comment (dealer-visible, ALWAYS through the write gate's approval modal; returns
 * DTNA_POST_NOT_CONFIGURED until constants.POST_COMMENT_PARAMS is filled), dtna:stage-options (cache
 * only, no network), dtna:change-stage (forward-only stage change: dealer-visible, ALWAYS through the
 * write gate's approval modal; DTNA_STAGE_NOT_CONFIGURED until constants.STAGE_CHANGE_PARAMS is filled)
 * and dtna:session-time (the SessionTimeServlet seconds left; user-initiated).
 * Before a stage change, a comment post or a bulk pull, a session pre-flight checks the session; when it
 * is (nearly) expired, one gated hidden background sign-in runs and the pre-flight is read again, and
 * only if it still blocks is the user asked to sign in. A failed pre-flight read never blocks.
 * Session status changes are pushed on dtna:status-changed.
 * Every handler returns {ok:false, code[, field]} on failure and never an error message or stack.
 * Results carry ids, counts and codes only: comment text stays in dtnaCaseCache / fleetData rows and
 * in a file the user exports. Nothing here runs on a timer. "Pull DTNA" here is the on-demand force
 * refresh; the normal sync pass reads DTNA separately, through the session-gated src/dtna/auto.js.
 */
const path = require('path');
const fs = require('fs');
const { caseTag, safeErr } = require('../dtna/redact');
const log = require('../utils/logger')('dtna');

const EQUIPMENT_MAX = 40;
const FILTER_ID_RE = /^[A-Za-z0-9]{15,18}$/;
const JOB_ID_RE = /^j[a-z0-9]{1,15}$/;
const MAX_JOBS = 3;

function _bad(field) { return { ok: false, code: 'DTNA_INVALID_INPUT', field }; }
function _payload(p) {
  if (p == null) return {};
  return typeof p === 'object' && !Array.isArray(p) ? p : null;
}

/**
 * registerDtnaIPC(ctx, deps)
 * deps (tests): { handle, client, session, store, electron, rowApply, deepScan, writeGate, writes, commentDraft, dtnaStore,
 *   sessionTime, pending }
 */
function registerDtnaIPC(ctx, deps) {
  const d = deps || {};
  const handle = d.handle || require('./_safe').handle;
  const client = () => d.client || require('../dtna/client');
  const session = () => d.session || require('../dtna/session');
  const store = () => d.store || require('../store');
  const electron = () => d.electron || require('electron');
  const rowApply = () => d.rowApply || require('../dtna/row-apply');
  const deepScan = () => d.deepScan || require('../orcha/deep-scan');
  const writeGate = () => d.writeGate || require('../writes/write-gate');
  const writes = () => d.writes || require('../dtna/writes');
  const commentDraft = () => d.commentDraft || require('../dtna/comment-draft');
  const dtnaStore = () => d.dtnaStore || require('../dtna/store');
  const sessionTime = () => d.sessionTime || require('../dtna/session-time');
  const pending = () => d.pending || require('../dtna/pending');
  const join = require('../dtna/join');
  const C = require('../dtna/constants');

  const send = (ch, payload) => {
    try { if (ctx && typeof ctx.sendToWindow === 'function') ctx.sendToWindow(ch, payload); } catch (e) { log.warn('[dtna] send', safeErr(e)); }
  };

  // Session status -> renderer.
  try { session().onStatus((s) => send('dtna:status-changed', s)); } catch (e) { log.warn('[dtna] status subscribe', safeErr(e)); }

  const wrap = (channel, fn) => handle(channel, async (_e, payload) => {
    try {
      return await fn(payload);
    } catch (e) {
      log.warn('[dtna] ipc', { channel, err: safeErr(e) });
      return { ok: false, code: 'DTNA_INTERNAL' };
    }
  });

  // ── status / login ───────────────────────────────────────────────────────
  wrap('dtna:status', async () => session().status());

  wrap('dtna:login', async () => {
    const r = await session().openLoginWindow(ctx);
    if (r && r.ok) return { ok: true, state: r.state };
    return { ok: false, code: (r && r.code) || 'DTNA_SIGNIN_CANCELLED' };
  });

  // ── pull one unit ────────────────────────────────────────────────────────
  wrap('dtna:pull-unit', async (payload) => {
    const p = _payload(payload);
    if (!p) return _bad('payload');
    if (typeof p.equipmentId !== 'string') return _bad('equipmentId');
    const id = p.equipmentId.trim();
    if (!id || id.length > EQUIPMENT_MAX) return _bad('equipmentId');
    return _pullUnit(id);
  });

  // The pull-unit body (also the read-back after a stage change). id is a validated equipmentId.
  async function _pullUnit(id) {
    const st = store();
    // Merge base: the LARGER of ctx.lastData.rows and the stored fleetData rows (same as relay:refresh-unit).
    const liveRows = (ctx && ctx.lastData && Array.isArray(ctx.lastData.rows)) ? ctx.lastData.rows : [];
    const storedFd = st.load('fleetData', {}) || {};
    const storedRows = Array.isArray(storedFd.rows) ? storedFd.rows : [];
    const baseIsLive = liveRows.length >= storedRows.length;
    const baseRows = baseIsLive ? liveRows : storedRows;
    const idx = baseRows.findIndex((r) => r && String(r.equipmentId || '').trim() === id);
    if (idx < 0) return { ok: false, code: 'DTNA_UNIT_NOT_FOUND' };
    const row = baseRows[idx];
    if (!join.canWriteDtnaOffsite(row)) return { ok: false, code: 'DTNA_NON_DTNA_OFFSITE' };

    const S = session();
    const t0 = Date.now();
    S.setPulling(true);
    try {
      const rc = await client().resolveCaseForRow(row);
      if (!rc || !rc.ok) return { ok: false, code: (rc && rc.code) || 'DTNA_CASE_NOT_FOUND' };
      const pr = await client().pullCase(rc.caseId);
      if (!pr || !pr.ok) return { ok: false, code: (pr && pr.code) || 'DTNA_INTERNAL' };
      const entry = pr.entry;
      const pick = join.pickWrForCase(entry, [row]);
      let extract = false;
      try { extract = !!require('../config/perf-flags').loadExtract().enabled; } catch (_) { extract = false; }
      const next = Object.assign({}, row);
      const ap = rowApply().applyCaseToRow(next, entry, { now: Date.now(), wrId: pick ? pick.wrId : '', extract });
      if (!ap.applied) return { ok: false, code: ap.reason === 'non-dtna-offsite' ? 'DTNA_NON_DTNA_OFFSITE' : 'DTNA_INTERNAL' };

      baseRows[idx] = next;
      if (baseIsLive && ctx.lastData) ctx.lastData.rows = baseRows;
      storedFd.rows = baseRows;
      st.save('fleetData', storedFd);
      if (ctx && typeof ctx.pushData === 'function') {
        try { ctx.pushData({ rows: [next], partialMerge: true, _partial: 'dtna-pull-unit' }); } catch (e) { log.warn('[dtna] push', safeErr(e)); }
      }
      try {
        Promise.resolve(deepScan().rebuildUnitTimeline(next, { pushData: ctx.pushData, pushStatus: ctx.pushStatus || null }))
          .catch((e) => log.warn('[dtna] rebuild', safeErr(e)));
      } catch (e) { log.warn('[dtna] rebuild', safeErr(e)); }

      log.info('[dtna] pull-unit', { caseTag: caseTag(entry.caseId), comments: entry.commentCount, code: 'OK', ms: Date.now() - t0 });
      const res = { ok: true, caseId: entry.caseId, commentCount: entry.commentCount, updatedAt: entry.pulledAt, joinedWr: next._offsiteWrId || '' };
      if (pr.commentsStale) res.commentsStale = true;
      if (pr.commentsCode) res.commentsCode = String(pr.commentsCode).slice(0, 40);
      return res;
    } finally {
      try { S.setPulling(false); } catch (e) { log.warn('[dtna] status', safeErr(e)); }
    }
  }

  // ── session time (user-initiated: DTNA panel open / Check session) ────────
  wrap('dtna:session-time', async () => {
    const r = await sessionTime().read();
    if (!r || !r.ok) return { ok: false, code: String((r && r.code) || 'DTNA_INTERNAL').slice(0, 40) };
    return { ok: true, remainingSec: r.remainingSec, periodSec: r.periodSec, expired: !!r.expired };
  });

  // Pre-flight: blocks only when the servlet says the session is expired or nearly so (fail-open).
  const _preflightOnce = async () => {
    try {
      const pf = await sessionTime().preflight();
      return pf && pf.block ? pf : null;
    } catch (e) {
      log.warn('[dtna] preflight', safeErr(e));
      return null;
    }
  };
  // Blocked: one gated hidden background sign-in, then the pre-flight once more. Approvals stay where
  // they are (after the pre-flight); this only decides whether the request may ask for one.
  const _preflight = async () => {
    const pf = await _preflightOnce();
    if (!pf) return null;
    let r = null;
    try {
      const S = session();
      if (S && typeof S.backgroundLogin === 'function') r = await S.backgroundLogin({ reason: 'preflight' });
    } catch (e) {
      log.warn('[dtna] preflight sign-in', safeErr(e));
      r = null;
    }
    if (!r || !r.ok) return pf;
    return _preflightOnce();
  };

  // ── list ─────────────────────────────────────────────────────────────────
  wrap('dtna:list-cases', async (payload) => {
    const p = _payload(payload);
    if (!p) return _bad('payload');
    if (p.filterId !== undefined && (typeof p.filterId !== 'string' || !FILTER_ID_RE.test(p.filterId))) return _bad('filterId');
    const r = await client().listCaseIds(p.filterId ? { filterId: p.filterId } : {});
    if (!r || !r.ok) return { ok: false, code: (r && r.code) || 'DTNA_INTERNAL' };
    return { ok: true, count: r.ids.length };
  });

  // ── bulk ─────────────────────────────────────────────────────────────────
  let _running = null;          // { jobId, ac }
  const _jobs = new Map();      // jobId -> { results, cancelled, code } (last MAX_JOBS)

  wrap('dtna:bulk-pull', async (payload) => {
    const p = _payload(payload);
    if (!p) return _bad('payload');
    if (p.includeComments !== undefined && typeof p.includeComments !== 'boolean') return _bad('includeComments');
    if (_running) return { ok: false, code: 'DTNA_BUSY', jobId: _running.jobId };
    // Session (nearly) expired: the existing callers sign the user in on DTNA_SIGNIN_REQUIRED.
    if (await _preflight()) return { ok: false, code: 'DTNA_SIGNIN_REQUIRED' };
    if (_running) return { ok: false, code: 'DTNA_BUSY', jobId: _running.jobId };
    const jobId = 'j' + Date.now().toString(36);
    const ac = new AbortController();
    _running = { jobId, ac };
    const S = session();
    S.setPulling(true);
    let last = { done: 0, total: 0, failed: 0 };
    const onProgress = (x) => {
      last = { done: Number(x && x.done) || 0, total: Number(x && x.total) || 0, failed: Number(x && x.failed) || 0 };
      send('dtna:progress', { jobId, done: last.done, total: last.total, failed: last.failed, finished: false });
    };
    Promise.resolve()
      .then(() => client().bulkPull({ includeComments: p.includeComments !== false, onProgress, signal: ac.signal }))
      .then((r) => r || { ok: false, code: 'DTNA_INTERNAL', results: [] }, (e) => {
        log.warn('[dtna] bulk', safeErr(e));
        return { ok: false, code: 'DTNA_INTERNAL', results: [] };
      })
      .then((r) => {
        _jobs.set(jobId, { results: Array.isArray(r.results) ? r.results : [], cancelled: !!r.cancelled });
        while (_jobs.size > MAX_JOBS) _jobs.delete(_jobs.keys().next().value);
        const fin = {
          jobId,
          done: last.done,
          total: Number.isFinite(r.total) ? r.total : last.total,
          failed: Number.isFinite(r.failed) ? r.failed : last.failed,
          finished: true,
          cancelled: !!r.cancelled,
        };
        if (!r.ok && r.code) fin.code = String(r.code).slice(0, 40);
        send('dtna:progress', fin);
      })
      .catch((e) => log.warn('[dtna] bulk', safeErr(e)))
      .finally(() => {
        if (_running && _running.jobId === jobId) _running = null;
        try { S.setPulling(false); } catch (e) { log.warn('[dtna] status', safeErr(e)); }
      });
    return { ok: true, jobId };
  });

  wrap('dtna:bulk-cancel', async (payload) => {
    const p = _payload(payload);
    if (!p) return _bad('payload');
    if (typeof p.jobId !== 'string' || !JOB_ID_RE.test(p.jobId)) return _bad('jobId');
    if (_running && _running.jobId === p.jobId) { try { _running.ac.abort(); } catch (_) {} }
    return { ok: true };
  });

  // ── comment: AI draft (text only) and the approval-gated, dealer-visible post ──
  const _equipment = (p) => {
    if (typeof p.equipmentId !== 'string') return '';
    const id = p.equipmentId.trim();
    return id && id.length <= EQUIPMENT_MAX ? id : '';
  };

  wrap('dtna:draft-comment', async (payload) => {
    const p = _payload(payload);
    if (!p) return _bad('payload');
    const equipmentId = _equipment(p);
    if (!equipmentId) return _bad('equipmentId');
    if (typeof p.caseId !== 'string' || !C.CASE_ID_RE.test(p.caseId)) return _bad('caseId');
    const r = await commentDraft().draftForCase({ equipmentId, caseId: p.caseId, lastData: ctx && ctx.lastData });
    if (!r || !r.ok) return { ok: false, code: String((r && r.code) || 'DTNA_INTERNAL').slice(0, 40) };
    return { ok: true, aiDrafted: true, draft: String(r.draft || ''), noUpdate: !!r.noUpdate, droppedCount: Number(r.droppedCount) || 0 };
  });

  wrap('dtna:post-comment', async (payload) => {
    const p = _payload(payload);
    if (!p) return _bad('payload');
    const equipmentId = _equipment(p);
    if (!equipmentId) return _bad('equipmentId');
    if (typeof p.caseId !== 'string' || !C.CASE_ID_RE.test(p.caseId)) return _bad('caseId');
    if (typeof p.text !== 'string' || !p.text.trim() || p.text.length > C.POST_COMMENT_MAX) return _bad('text');
    if (p.aiDrafted !== undefined && typeof p.aiDrafted !== 'boolean') return _bad('aiDrafted');
    const caseId = p.caseId;
    const tag = caseTag(caseId);
    const len = p.text.length;
    const done = (r) => { log.info('[dtna] post-comment', { caseTag: tag, code: r.code || r.outcome || 'OK', len }); return r; };
    // Not configured: no approval prompt, no network.
    if (!writes().isPostConfigured()) return done({ ok: false, code: 'DTNA_POST_NOT_CONFIGURED' });
    const entry = dtnaStore().get(caseId);
    if (!entry) return done({ ok: false, code: 'DTNA_NOT_PULLED' });
    // The repair order comes from the cache, never from the renderer.
    if (!entry.repairOrderId) return done({ ok: false, code: 'DTNA_NO_REPAIR_ORDER' });
    const pf = await _preflight();
    if (pf) return done({ ok: false, code: 'DTNA_SESSION_LOW', remainingSec: Number(pf.remainingSec) || 0 });
    const r = await writeGate().requestWrite({
      kind: 'dtnaComment',
      payload: { caseId, repairOrderId: String(entry.repairOrderId), repairOrderNo: String(entry.repairOrderNo || ''), text: p.text },
      origin: 'unit-detail-dtna',
      unit: equipmentId,
      interactive: true,
      aiDrafted: p.aiDrafted === true,
    });
    const out = { ok: !!(r && r.ok), outcome: String((r && r.outcome) || 'send-failed'), id: (r && r.id) || null };
    if (r && r.ok && r.result && r.result.commentId) out.commentId = String(r.result.commentId);
    if (r && !r.ok && typeof r.error === 'string' && /^DTNA_[A-Z0-9_]{1,40}$/.test(r.error)) out.code = r.error;
    return done(out);
  });

  // ── stage: forward-only, dealer-visible, approval-gated ───────────────────
  const _caseOk = (p) => typeof p.caseId === 'string' && C.CASE_ID_RE.test(p.caseId);

  wrap('dtna:stage-options', async (payload) => {
    const p = _payload(payload);
    if (!p) return _bad('payload');
    if (!_equipment(p)) return _bad('equipmentId');
    if (!_caseOk(p)) return _bad('caseId');
    // Cache only: no network.
    const entry = dtnaStore().get(p.caseId);
    if (!entry) return { ok: false, code: 'DTNA_NOT_PULLED' };
    const st = pending().currentStage(entry);
    if (!st) return { ok: false, code: 'DTNA_STAGE_UNKNOWN' };
    return {
      ok: true,
      configured: !!writes().isStageConfigured(),
      current: st.name,
      currentIndex: st.index,
      targets: writes().stageTargets(st.name),
      stages: C.CASE_STAGES.slice(),
    };
  });

  const _stageBusy = new Set(); // caseIds with a stage change in flight

  wrap('dtna:change-stage', async (payload) => {
    const p = _payload(payload);
    if (!p) return _bad('payload');
    const equipmentId = _equipment(p);
    if (!equipmentId) return _bad('equipmentId');
    if (!_caseOk(p)) return _bad('caseId');
    if (typeof p.target !== 'string' || C.stageIndex(p.target) < 0) return _bad('target');
    const caseId = p.caseId;
    const target = p.target;
    const tag = caseTag(caseId);
    let from = '';
    const done = (r) => { log.info('[dtna] change-stage', { caseTag: tag, from, to: target, code: r.code || r.outcome || 'OK' }); return r; };
    // Not configured: no approval prompt, no network.
    if (!writes().isStageConfigured()) return done({ ok: false, code: 'DTNA_STAGE_NOT_CONFIGURED' });
    if (!dtnaStore().get(caseId)) return done({ ok: false, code: 'DTNA_NOT_PULLED' });
    if (_stageBusy.has(caseId)) return done({ ok: false, code: 'DTNA_BUSY' });
    _stageBusy.add(caseId);
    try {
      const pf = await _preflight();
      if (pf) return done({ ok: false, code: 'DTNA_SESSION_LOW', remainingSec: Number(pf.remainingSec) || 0 });
      // Fresh read so the approval shows the stage that is on the server now.
      const fr = await client().pullCase(caseId, { includeComments: false });
      if (!fr || !fr.ok) return done({ ok: false, code: String((fr && fr.code) || 'DTNA_INTERNAL').slice(0, 40) });
      const cur = pending().currentStage(fr.entry);
      if (!cur) return done({ ok: false, code: 'DTNA_STAGE_UNKNOWN' });
      from = cur.name;
      if (!C.isForwardStage(from, target)) return done({ ok: false, code: 'DTNA_STAGE_NOT_FORWARD', currentStage: from });
      const r = await writeGate().requestWrite({
        kind: 'dtnaStage',
        payload: { caseId, fromStage: from, toStage: target, repairOrderNo: String((fr.entry && fr.entry.repairOrderNo) || '') },
        origin: 'unit-detail-dtna-stage',
        unit: equipmentId,
        interactive: true,
      });
      if (!r || !r.ok) {
        const out = { ok: false, outcome: String((r && r.outcome) || 'send-failed'), id: (r && r.id) || null };
        if (r && typeof r.error === 'string' && /^DTNA_[A-Z0-9_]{1,40}$/.test(r.error)) out.code = r.error;
        return done(out);
      }
      // Sent: re-pull the unit (same path as Pull DTNA) and read the stage back.
      let pullCode = '';
      try {
        const pr = await _pullUnit(equipmentId);
        if (!pr || !pr.ok) pullCode = String((pr && pr.code) || 'DTNA_INTERNAL').slice(0, 40);
      } catch (e) {
        log.warn('[dtna] change-stage re-pull', safeErr(e));
        pullCode = 'DTNA_INTERNAL';
      }
      const after = pending().currentStage(dtnaStore().get(caseId));
      const out = {
        ok: true, outcome: 'sent', id: r.id || null, fromStage: from, toStage: target,
        currentStage: after ? after.name : '', confirmed: !!after && after.name === target,
      };
      if (pullCode) out.pullCode = pullCode;
      return done(out);
    } finally {
      _stageBusy.delete(caseId);
    }
  });

  // ── export ───────────────────────────────────────────────────────────────
  wrap('dtna:export', async (payload) => {
    const p = _payload(payload);
    if (!p) return _bad('payload');
    if (typeof p.jobId !== 'string' || !JOB_ID_RE.test(p.jobId)) return _bad('jobId');
    if (p.format !== 'tsv' && p.format !== 'xls') return _bad('format');
    if (p.mode !== undefined && p.mode !== 'cases' && p.mode !== 'comments') return _bad('mode');
    const mode = p.mode === 'comments' ? 'comments' : 'cases';
    if (_running && _running.jobId === p.jobId) return { ok: false, code: 'DTNA_BUSY' };
    const job = _jobs.get(p.jobId);
    if (!job) return { ok: false, code: 'DTNA_JOB_NOT_FOUND' };
    const date = new Date().toISOString().slice(0, 10);
    const filename = 'dtna-' + mode + '-' + date + '.' + p.format;
    const outputPath = path.join(electron().app.getPath('downloads'), filename);
    if (p.format === 'tsv') {
      fs.writeFileSync(outputPath, client().toTSV(job.results, { mode }), 'utf8');
    } else {
      const { columns, rows } = client().exportRows(job.results, { mode });
      const { generateExcel } = require('../utils/excel-export');
      generateExcel(rows, columns.map((c) => ({ key: c, header: c })), outputPath);
    }
    log.info('[dtna] export', { format: p.format, mode, count: job.results.length });
    return { ok: true, filename };
  });
}

module.exports = { registerDtnaIPC };

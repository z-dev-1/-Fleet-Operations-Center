'use strict';
/**
 * ipc/dtna.js — DTNA Service Tracker IPC (user-initiated Aura reads only).
 *
 * Channels: dtna:status, dtna:login, dtna:pull-unit, dtna:list-cases, dtna:bulk-pull (+ dtna:progress
 * events), dtna:bulk-cancel, dtna:export. Session status changes are pushed on dtna:status-changed.
 * Every handler returns {ok:false, code[, field]} on failure and never an error message or stack.
 * Results carry ids, counts and codes only: comment text stays in dtnaCaseCache / fleetData rows and
 * in a file the user exports. Nothing here runs on a timer.
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
 * deps (tests): { handle, client, session, store, electron, rowApply, deepScan }
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
  const join = require('../dtna/join');

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
      return { ok: true, caseId: entry.caseId, commentCount: entry.commentCount, updatedAt: entry.pulledAt, joinedWr: next._offsiteWrId || '' };
    } finally {
      try { S.setPulling(false); } catch (e) { log.warn('[dtna] status', safeErr(e)); }
    }
  });

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

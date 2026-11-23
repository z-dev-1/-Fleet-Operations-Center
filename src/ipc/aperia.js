'use strict';
/**
 * ipc/aperia.js — Aperia HALO Connect IPC (user-initiated GET reads; the opt-in tire alert watcher).
 *
 * Channels (exactly 11): aperia:status, aperia:login, aperia:logout, aperia:unit, aperia:bulk,
 * aperia:fleet-tires, aperia:issues, aperia:start-alerts, aperia:stop-alerts, aperia:poll-now, aperia:export.
 * Events: aperia:progress (bulk / fleet jobs) and aperia:alert (sent by the watcher).
 * Every handler returns {ok:false, code[, field]} on failure and never an error message or stack.
 * Registration only registers handlers and the before-quit hook: it calls no client, session or watcher
 * function. One job runs at a time (APERIA_BUSY); the last MAX_JOBS jobs are kept for export.
 * aperia:issues { cached:true } makes no Aperia call: it serves the sync cycle's warm cache of fleet-row
 * issues (src/aperia/sync-read.js) or APERIA_NO_CACHE. aperia:start-alerts / aperia:stop-alerts save the
 * user's Tire Alerts choice (src/aperia/alerts-pref.js; alerts are on by default). Sign out stops the
 * watcher and aborts a running job; it leaves the saved choice as is.
 */
const { safeErr } = require('../aperia/redact');
const log = require('../utils/logger')('aperia');

const ASSET_RE = /^[A-Za-z0-9 #_.-]+$/;
const ASSET_MAX = 40;
const LIST_MAX = 500;
const JOB_ID_RE = /^a[a-z0-9]{1,15}$/;
const ISSUE_TYPES = ['active', 'critical-no-case'];
const DOMICILE_MAX = 80;
const MAX_JOBS = 3;
const BULK_ROWS_MAX = 5000;

function _bad(field) { return { ok: false, code: 'APERIA_INVALID_INPUT', field }; }
function _payload(p) {
  if (p == null) return {};
  return typeof p === 'object' && !Array.isArray(p) ? p : null;
}
/** _asset(v) -> trimmed unit id | '' when invalid. */
function _asset(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s && s.length <= ASSET_MAX && ASSET_RE.test(s) ? s : '';
}
function _code(r) { return String((r && r.code) || 'APERIA_INTERNAL').slice(0, 40); }
function _domiciles(rows) {
  const s = new Set();
  for (const r of Array.isArray(rows) ? rows : []) if (r && typeof r.domicile === 'string' && r.domicile) s.add(r.domicile);
  return Array.from(s).sort();
}

/**
 * registerAperiaIPC(ctx, deps)
 * deps (tests): { handle, client, session, watcher, exporter, electron, dtnaStore, store, alertsPref, syncRead }
 */
function registerAperiaIPC(ctx, deps) {
  const d = deps || {};
  const handle = d.handle || require('./_safe').handle;
  const client = () => d.client || require('../aperia/client');
  const session = () => d.session || require('../aperia/session');
  const watcher = () => d.watcher || require('../aperia/watcher');
  const exporter = () => d.exporter || require('../aperia/export');
  const electron = () => d.electron || require('electron');
  const dtnaStore = () => d.dtnaStore || require('../dtna/store');
  const store = () => d.store || require('../store');
  const alertsPref = () => d.alertsPref || require('../aperia/alerts-pref');
  const syncRead = () => d.syncRead || require('../aperia/sync-read');

  const send = (ch, payload) => {
    try { if (ctx && typeof ctx.sendToWindow === 'function') ctx.sendToWindow(ch, payload); } catch (e) { log.warn('[aperia] send', safeErr(e)); }
  };

  const wrap = (channel, fn) => handle(channel, async (_e, payload) => {
    try {
      return await fn(payload);
    } catch (e) {
      log.warn('[aperia] ipc', { channel, err: safeErr(e) });
      return { ok: false, code: 'APERIA_INTERNAL' };
    }
  });

  // ── jobs ─────────────────────────────────────────────────────────────────
  let _running = null;          // { jobId, kind, ac }
  const _jobs = new Map();      // jobId -> { kind, results?, rows? } (last MAX_JOBS)
  let _lastMs = 0;

  function _newJob(kind) {
    const ms = Math.max(Date.now(), _lastMs + 1);
    _lastMs = ms;
    const jobId = 'a' + ms.toString(36);
    _running = { jobId, kind, ac: new AbortController() };
    return _running;
  }
  function _keep(jobId, job) {
    _jobs.set(jobId, job);
    while (_jobs.size > MAX_JOBS) _jobs.delete(_jobs.keys().next().value);
  }
  function _done(jobId) { if (_running && _running.jobId === jobId) _running = null; }

  /** _startPull(kind, run) — background bulk / fleet job with aperia:progress events. */
  function _startPull(kind, run) {
    const { jobId, ac } = _newJob(kind);
    let last = { done: 0, total: 0, failed: 0 };
    const onProgress = (x) => {
      last = { done: Number(x && x.done) || 0, total: Number(x && x.total) || 0, failed: Number(x && x.failed) || 0 };
      send('aperia:progress', { jobId, kind, done: last.done, total: last.total, failed: last.failed, finished: false });
    };
    const t0 = Date.now();
    Promise.resolve()
      .then(() => run({ ctx, onProgress, signal: ac.signal }))
      .then((r) => r || { ok: false, code: 'APERIA_INTERNAL', results: [] }, (e) => {
        log.warn('[aperia] ' + kind, safeErr(e));
        return { ok: false, code: 'APERIA_INTERNAL', results: [] };
      })
      .then((r) => {
        const results = Array.isArray(r.results) ? r.results : [];
        _keep(jobId, { kind, results });
        const tires = exporter().tireRows(results);
        const fin = {
          jobId,
          kind,
          done: last.done,
          total: Number.isFinite(r.total) ? r.total : last.total,
          failed: Number.isFinite(r.failed) ? r.failed : last.failed,
          finished: true,
          cancelled: !!r.cancelled,
        };
        if (!r.ok && r.code) fin.code = _code(r);
        if (kind === 'bulk') fin.rows = tires.slice(0, BULK_ROWS_MAX);
        fin.domiciles = _domiciles(tires);
        log.info('[aperia] job', { kind, total: fin.total, failed: fin.failed, cancelled: fin.cancelled, code: fin.code || 'OK', ms: Date.now() - t0 });
        send('aperia:progress', fin);
      })
      .catch((e) => log.warn('[aperia] ' + kind, safeErr(e)))
      .finally(() => _done(jobId));
    return { ok: true, jobId };
  }

  // ── status / login / logout ──────────────────────────────────────────────
  wrap('aperia:status', async () => Object.assign({}, session().status(), watcher().status()));

  wrap('aperia:login', async () => {
    const r = await session().openLoginWindow(ctx);
    if (r && r.ok) return { ok: true, state: r.state };
    return { ok: false, code: (r && r.code) || 'APERIA_SIGNIN_CANCELLED' };
  });

  wrap('aperia:logout', async () => {
    try { watcher().stop(); } catch (e) { log.warn('[aperia] logout watcher', safeErr(e)); }
    if (_running) { try { _running.ac.abort(); } catch (_) {} }
    const r = session().logout();
    return { ok: true, state: (r && r.state) || 'signed-out' };
  });

  // ── reads ────────────────────────────────────────────────────────────────
  wrap('aperia:unit', async (payload) => {
    const p = _payload(payload);
    if (!p) return _bad('payload');
    const assetId = _asset(p.assetId);
    if (!assetId) return _bad('assetId');
    const r = await client().lookupUnit(assetId, ctx);
    if (!r || !r.ok) return { ok: false, code: _code(r) };
    return { ok: true, unit: r.unit };
  });

  wrap('aperia:bulk', async (payload) => {
    const p = _payload(payload);
    if (!p) return _bad('payload');
    if (!Array.isArray(p.list) || p.list.length < 1 || p.list.length > LIST_MAX) return _bad('list');
    const list = [];
    const seen = new Set();
    for (const v of p.list) {
      const a = _asset(v);
      if (!a) return _bad('list');
      const k = a.toUpperCase();
      if (!seen.has(k)) { seen.add(k); list.push(a); }
    }
    if (_running) return { ok: false, code: 'APERIA_BUSY', jobId: _running.jobId };
    return _startPull('bulk', (o) => client().bulkLookup(list, o));
  });

  wrap('aperia:fleet-tires', async (payload) => {
    const p = _payload(payload);
    if (!p) return _bad('payload');
    if (_running) return { ok: false, code: 'APERIA_BUSY', jobId: _running.jobId };
    return _startPull('fleet', (o) => client().fleetTires(o));
  });

  wrap('aperia:issues', async (payload) => {
    const p = _payload(payload);
    if (!p) return _bad('payload');
    if (p.type !== undefined && !ISSUE_TYPES.includes(p.type)) return _bad('type');
    if (p.cached !== undefined && typeof p.cached !== 'boolean') return _bad('cached');
    const type = p.type || 'active';
    const kind = type === 'critical-no-case' ? 'crosslink' : 'issues';
    if (p.cached === true) {
      // The sync cycle's warm cache (fleet-row units only): no Aperia call, so a running pull is not
      // blocked or replaced (the export job id is minted without taking the running slot).
      const cache = syncRead().cached();
      if (!cache) return { ok: false, code: 'APERIA_NO_CACHE' };
      const picked = kind === 'crosslink' ? cache.crossLink : cache.issues;
      const rows = Array.isArray(picked) ? picked : [];
      const prev = _running;
      const job = _newJob(kind);
      _running = prev;
      _keep(job.jobId, { kind, rows });
      _done(job.jobId);
      return { ok: true, jobId: job.jobId, rows, domiciles: _domiciles(rows), pulledAt: cache.pulledAt || null, count: rows.length, cached: true };
    }
    if (_running) return { ok: false, code: 'APERIA_BUSY', jobId: _running.jobId };
    const { jobId, ac } = _newJob(kind);
    try {
      const li = await client().listIssues(ctx, { signal: ac.signal });
      if (!li || !li.ok) return { ok: false, code: _code(li) };
      let rows = Array.isArray(li.rows) ? li.rows : [];
      if (kind === 'crosslink') {
        const live = ctx && ctx.lastData && Array.isArray(ctx.lastData.rows) ? ctx.lastData.rows : [];
        let fleetRows = live;
        if (!live.length) {
          const fd = store().load('fleetData', {}) || {};
          fleetRows = Array.isArray(fd.rows) ? fd.rows : [];
        }
        let dtnaEntries = [];
        try { dtnaEntries = dtnaStore().all() || []; } catch (e) { log.warn('[aperia] crosslink', safeErr(e)); }
        rows = client().crossLinkCriticalNoCase(rows, { dtnaEntries, fleetRows });
      }
      _keep(jobId, { kind, rows });
      log.info('[aperia] job', { kind, count: rows.length });
      return { ok: true, jobId, rows, domiciles: _domiciles(rows), pulledAt: li.pulledAt || null, count: rows.length };
    } finally {
      _done(jobId);
    }
  });

  // ── alert watcher ────────────────────────────────────────────────────────
  wrap('aperia:start-alerts', async (payload) => {
    const p = _payload(payload);
    if (!p) return _bad('payload');
    if (p.minutes !== undefined && (!Number.isInteger(p.minutes) || p.minutes < 1 || p.minutes > 60)) return _bad('minutes');
    const r = await watcher().start({ minutes: p.minutes, ctx });
    if (!r || !r.ok) return { ok: false, code: _code(r) };
    try { alertsPref().save(true); } catch (e) { log.warn('[aperia] alerts pref', safeErr(e)); }
    const out = { ok: true, status: r.status };
    if (r.already) out.already = true;
    return out;
  });

  wrap('aperia:stop-alerts', async () => {
    const r = watcher().stop();
    try { alertsPref().save(false); } catch (e) { log.warn('[aperia] alerts pref', safeErr(e)); }
    return r;
  });

  wrap('aperia:poll-now', async () => {
    const r = await watcher().pollNow(ctx);
    if (!r || !r.ok) return { ok: false, code: _code(r) };
    return { ok: true, newCount: Number(r.newCount) || 0 };
  });

  // ── export ───────────────────────────────────────────────────────────────
  wrap('aperia:export', async (payload) => {
    const p = _payload(payload);
    if (!p) return _bad('payload');
    if (typeof p.jobId !== 'string' || !JOB_ID_RE.test(p.jobId)) return _bad('jobId');
    if (p.format !== 'tsv' && p.format !== 'xls') return _bad('format');
    if (p.domicile !== undefined && (typeof p.domicile !== 'string' || p.domicile.length > DOMICILE_MAX)) return _bad('domicile');
    if (_running && _running.jobId === p.jobId) return { ok: false, code: 'APERIA_BUSY' };
    const job = _jobs.get(p.jobId);
    if (!job) return { ok: false, code: 'APERIA_JOB_NOT_FOUND' };
    const X = exporter();
    const domicile = p.domicile || '';
    let spec;
    if (job.kind === 'issues') spec = { kind: 'issues', columns: X.ISSUE_COLUMNS, rows: X.issueRows(job.rows, { domicile }) };
    else if (job.kind === 'crosslink') spec = { kind: 'critical-no-case', columns: X.CROSSLINK_COLUMNS, rows: X.crossLinkRows(job.rows, { domicile }) };
    else spec = { kind: job.kind === 'fleet' ? 'fleet-tires' : 'tires', columns: X.TIRE_COLUMNS, rows: X.tireRows(job.results, { domicile }) };
    const r = X.writeExport(Object.assign(spec, { format: p.format, dir: electron().app.getPath('downloads') }));
    log.info('[aperia] export', { kind: spec.kind, format: p.format, count: spec.rows.length, filtered: !!domicile });
    return { ok: true, filename: r.filename };
  });

  // App quit: stop the watcher (no timer or socket outlives the app).
  try {
    const app = electron().app;
    if (app && typeof app.once === 'function') {
      app.once('before-quit', () => { try { watcher().stop(); } catch (_) {} });
    }
  } catch (e) { log.warn('[aperia] quit hook', safeErr(e)); }
}

module.exports = { registerAperiaIPC };

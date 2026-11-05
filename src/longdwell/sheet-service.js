'use strict';
/**
 * longdwell/sheet-service.js - "Preview, then write" for the weekly Long Dwell
 * SharePoint sheet. Orchestrates link store, transport, grid reader/patcher,
 * matcher and diff. Electron-free: every dependency is injected.
 *
 *   createSheetService({ transport, store, clock, logger, lock, flags })
 *     transport: { resolveFile(parsed, linkUrl), downloadFile(target), withSession(target, fn, opts) }
 *                ops passed to fn: { meta(), get(), download(), put(bytes, {ifMatch}) }
 *     store:     { load(key, def), update(key, fn, def) }
 *     clock:     { now() -> ms, sleep(ms) -> Promise }
 *     lock:      sharepoint_push._withWriteLock (shared with the existing push)
 *     flags:     () => { sharepointWrite, sharepointWriteCommit, sharepointGuard }
 *
 * Hard rules held here (the patcher holds them again at the byte level):
 *   - preview never uploads;
 *   - write sends ONLY ticked, validated cells, state re-derived from the
 *     cached previewed current (never from renderer data);
 *   - never A-M, never P/Q, never clear, never add rows;
 *   - re-match on fresh bytes inside the lock (same sheetRow and via).
 * Logs: counts, coordinates and codes only. Unexpected exceptions -> 'internal'
 * with the error class name logged, never its message.
 */
const crypto = require('crypto');
const C = require('./sheet-columns');
const links = require('./sheet-links');
const { parseSheetLink } = require('./link-parse');
const grid = require('./xlsx-grid');
const { matchUnits } = require('./sheet-match');
const diff = require('./sheet-diff');

const LIMITS = Object.freeze({
  maxUnits: 1000, maxCells: 3000, cacheEntries: 3, ttlMs: 20 * 60 * 1000,
  previewGapMs: 3000, lockWaitMs: 90000, writeTimeoutMs: 180000,
});
const VERIFY_DELAYS_MS = [2500, 1500, 2000]; // +2.5 s, +4 s, +6 s after the PUT
const CELL_ID_RE = /^\d{1,7}:[A-Z]{1,3}$/;
const WRITE_DISABLED_TEXT = 'Write is turned off. Set longDwell.sharepointWriteCommit to enable.';
const FIELD_LABELS = { delayReason: 'Delay Reason', escalationLevel: 'Escalation', summary: 'Summary' };
const PRE_PUT_RETRYABLE = new Set(['busy', 'auth-required', 'guard-unavailable', 'throttled', 'network', 'timeout', 'bad-target']);

class InternalAbort extends Error { constructor() { super('internal'); this.name = 'InternalAbort'; } }

function _noopLogger() { return { debug() {}, info() {}, warn() {}, error() {} }; }

function _eqKey(id) { return C.normUnitId(id); }
function _unitKey(u) { return _eqKey(u.equipmentId) + '::' + String(u.woKey || 'primary'); }

function weekLabel(weekKey) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(weekKey || ''));
  return m ? 'Week ' + Number(m[2]) + ', ' + m[1] : '';
}

function _etagShape(etag) {
  return /^"\{[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}\},\d+"$/i.test(String(etag || '')) ? 'sp-guid-n' : 'other';
}

function createSheetService(deps = {}) {
  const transport = deps.transport;
  const store = deps.store;
  const clock = deps.clock || { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
  const log = deps.logger || _noopLogger();
  const lock = deps.lock || ((fn) => Promise.resolve().then(fn));
  const flagsOf = typeof deps.flags === 'function' ? deps.flags : () => deps.flags || {};
  const linkDeps = { store, now: () => new Date(clock.now()) };
  const cache = new Map(); // previewId -> entry (insertion order = age)
  let previewBusy = false;
  let lastPreviewAt = -Infinity;

  const flags = () => { try { return flagsOf() || {}; } catch (_) { return {}; } };
  const internal = (where, e) => { log.error('[ldsp] internal', { where, name: (e && e.name) || 'Error' }); return { ok: false, code: 'internal' }; };

  function _prune() {
    const now = clock.now();
    for (const [id, e] of cache) if (e.expiresAt <= now && e.state !== 'writing') cache.delete(id);
    while (cache.size > LIMITS.cacheEntries) {
      const oldest = [...cache.keys()].find((k) => cache.get(k).state !== 'writing');
      if (!oldest) break;
      cache.delete(oldest);
    }
  }

  // Annotations (delay reason / escalation / summary) come from the app's own
  // store, never from the renderer: compound key, legacy bare key for primary.
  function _annotate(units) {
    let s = {};
    try { s = store.load('longDwellStore', {}) || {}; } catch (_) { s = {}; }
    return units.map((u) => {
      const id = String(u.equipmentId || '').trim();
      const woKey = String(u.woKey || 'primary').trim();
      const a = s[id + '::' + woKey] || (u.isPrimary === true ? s[id] : null) || {};
      return {
        equipmentId: id, woKey, isPrimary: u.isPrimary === true,
        woNumber: u.woNumber || '', woAmz: u.woAmz || '', vendor: u.vendor || '', domicile: u.domicile || '',
        delayReason: a.delayReason || '', escalationLevel: a.escalationLevel || '', summary: a.summary || '',
      };
    });
  }

  function _dedupe(units) {
    const seen = new Set();
    const out = [];
    for (const u of units) {
      if (!u || typeof u.equipmentId !== 'string' || !u.equipmentId.trim()) continue;
      const k = String(u.equipmentId).trim() + '::' + String(u.woKey || 'primary');
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(u);
    }
    return out;
  }

  // A5: a cached resolution only when it belongs to the current URL.
  async function _resolve(weekKey, link, force) {
    const rec = link.record || links.getLink(weekKey, linkDeps);
    const cached = !force ? links.resolvedFor(rec) : null;
    if (cached && cached.host && cached.serverRelativeUrl) return { ok: true, resolved: cached, fromCache: true };
    const parsed = parseSheetLink(link.url);
    if (!parsed.ok) return { ok: false, code: parsed.code };
    const r = await transport.resolveFile(parsed, link.url);
    if (!r || !r.ok) return { ok: false, code: (r && r.code) || 'unresolvable-link' };
    if (!/\.xlsx$/i.test(String(r.name || ''))) return { ok: false, code: 'unsupported-format' };
    const fresh = { host: r.host, site: r.site || '', serverRelativeUrl: r.serverRelativeUrl, uniqueId: r.uniqueId || null, name: r.name };
    let saved = null;
    try { saved = links.setResolved(weekKey, fresh, linkDeps); } catch (_) { log.warn('[ldsp] resolve cache not saved', { code: 'store' }); }
    return { ok: true, resolved: saved || { ...fresh, forUrlSha256: links.sha256(link.url) }, fromCache: false };
  }

  function _target(resolved) {
    return { host: resolved.host, site: resolved.site || '', serverRelativeUrl: resolved.serverRelativeUrl };
  }

  function _columnsSig(res) {
    const c = res.columns || {};
    return JSON.stringify({
      assetId: c.assetId && c.assetId.index, vendor: c.vendor && c.vendor.index, wo: res.woCol && res.woCol.index,
      t: C.TARGET_KEYS.map((k) => (res.targets[k] ? res.targets[k].index : null)),
    });
  }

  // ── preview ───────────────────────────────────────────────────────────────
  async function preview(args = {}) {
    const f = flags();
    if (f.sharepointWrite !== true) return { ok: false, code: 'off' };
    const now = clock.now();
    if (previewBusy) return { ok: false, code: 'rate-limited', retryAfterMs: LIMITS.previewGapMs };
    if (now - lastPreviewAt < LIMITS.previewGapMs) return { ok: false, code: 'rate-limited', retryAfterMs: LIMITS.previewGapMs - (now - lastPreviewAt) };
    const rawUnits = Array.isArray(args.units) ? args.units : null;
    if (!rawUnits) return { ok: false, code: 'invalid-units' };
    if (rawUnits.length > LIMITS.maxUnits) return { ok: false, code: 'too-many-units' };
    previewBusy = true;
    lastPreviewAt = now;
    try {
      return await _preview(rawUnits, typeof args.tab === 'string' && args.tab ? args.tab : null, f);
    } catch (e) {
      if (e instanceof grid.GridError) { log.warn('[ldsp] preview workbook', { code: e.code }); return { ok: false, code: e.code }; }
      return internal('preview', e);
    } finally {
      previewBusy = false;
    }
  }

  async function _preview(rawUnits, tabArg, f) {
    const weekKey = links.isoWeekKey(new Date(clock.now()));
    const link = await links.findLink(weekKey, linkDeps);
    if (!link) return { ok: false, code: 'no-link' };
    let rz = await _resolve(weekKey, link, false);
    if (!rz.ok) { log.warn('[ldsp] resolve', { code: rz.code }); return { ok: false, code: rz.code }; }
    let dl = await transport.downloadFile(_target(rz.resolved));
    if ((!dl || !dl.ok) && dl && dl.code === 'not-found' && rz.fromCache) {
      rz = await _resolve(weekKey, link, true); // a 404 on a cached resolution re-resolves once
      if (!rz.ok) return { ok: false, code: rz.code };
      dl = await transport.downloadFile(_target(rz.resolved));
    }
    if (!dl || !dl.ok) { const code = (dl && dl.code) || 'internal'; log.warn('[ldsp] download', { code }); return { ok: false, code }; }
    const resolved = rz.resolved;
    const wb = await grid.openWorkbook(dl.bytes);
    const picked = await grid.pickTab(wb, { tab: tabArg, storedTab: rz.fromCache ? resolved.tab : null });
    if (!picked.ok) {
      const code = picked.code === 'tab-unavailable' && tabArg ? 'unknown-tab' : picked.code;
      log.info('[ldsp] preview tab', { code, tabs: (picked.tabs || []).length });
      const out = { ok: false, code, tabs: picked.tabs || [] };
      if (picked.missing) out.missing = picked.missing;
      if (picked.duplicates) out.duplicates = picked.duplicates;
      return out;
    }
    const g = picked.grid;
    const res = picked.columns;
    const units = _annotate(_dedupe(rawUnits));
    const rows = grid.sheetRowsFrom(g, picked.headerRow, res);
    const hasWoCol = !!res.woCol;
    const matches = matchUnits(rows, units, { hasWoCol });
    const infos = new Map();
    const cells = diff.buildDraft({
      units, matches, targets: res.targets,
      cellInfo: (r, c) => { const i = grid.cellInfo(g, r, c); infos.set(r + ':' + c, i); return i; },
    });
    if (picked.tab !== resolved.tab) {
      try { links.setResolved(weekKey, { host: resolved.host, site: resolved.site, serverRelativeUrl: resolved.serverRelativeUrl, uniqueId: resolved.uniqueId, name: resolved.name, tab: picked.tab }, linkDeps); }
      catch (_) { log.warn('[ldsp] tab not saved', { code: 'store' }); }
    }
    const m = dl.meta || {};
    const diagnostics = {
      ...grid.collectDiagnostics(g, { headerRow: picked.headerRow, columns: res, units }),
      meta: { etagShape: _etagShape(m.etag), lockedBy: m.lockedBy == null ? null : !!m.lockedBy, checkOutType: m.checkOutType == null ? null : m.checkOutType, versioning: m.versioning == null ? null : !!m.versioning },
    };
    const count = (st) => cells.filter((c) => c.state === st).length;
    const counts = {
      unitsInView: rawUnits.length, units: units.length,
      matched: matches.filter((x) => x.match === 'matched').length,
      ambiguous: matches.filter((x) => x.match === 'ambiguous').length,
      notInSheet: matches.filter((x) => x.match === 'not-in-sheet').length,
      extraWo: matches.filter((x) => x.match === 'extra-wo').length,
      cells: cells.length, willWrite: count('will-write'), noChange: count('no-change'), conflict: count('conflict'), blocked: count('blocked'),
    };
    log.info('[ldsp] preview', { counts, diagnostics });
    // cache
    const previewId = crypto.randomBytes(16).toString('hex');
    const now = clock.now();
    const unitsByEq = new Map();
    for (const u of units) { const k = _eqKey(u.equipmentId); if (!unitsByEq.has(k)) unitsByEq.set(k, []); unitsByEq.get(k).push(u); }
    const matchByUnit = new Map();
    matches.forEach((mm, i) => matchByUnit.set(_unitKey(units[i]), mm));
    const cellsById = new Map();
    for (const c of cells) cellsById.set(c.id, { ...c, info: infos.get(c.sheetRow + ':' + c.colIndex) || {} });
    const entry = {
      previewId, weekKey, linkFingerprint: links.sha256(link.url), target: _target(resolved), fileName: resolved.name,
      tab: picked.tab, headerRow: picked.headerRow, columnsSig: _columnsSig(res), hasWoCol,
      allowedCols: C.TARGET_KEYS.map((k) => res.targets[k] && res.targets[k].index).filter((x) => Number.isInteger(x)),
      meta: m, cellsById, unitsByEq, matchByUnit,
      unitCounts: { notInSheet: counts.notInSheet, ambiguous: counts.ambiguous, emptySource: cells.filter((c) => c.reason === 'empty-source').length },
      state: 'ready', createdAt: now, expiresAt: now + LIMITS.ttlMs,
    };
    cache.set(previewId, entry);
    _prune();
    const mapping = C.FIELD_MAP.map((fm) => ({ field: fm.from, fieldLabel: FIELD_LABELS[fm.from] || fm.from, column: res.targets[fm.key] ? res.targets[fm.key].letter : null, header: fm.header }));
    const untouched = [{ column: 'A-M', header: 'Tracker columns', reason: 'read-only' }];
    for (const k of ['supportPOC', 'asanaLink']) {
      const col = res.columns[k];
      untouched.push({ column: col ? col.letter : null, header: C.labelOf(k), reason: 'no-computed-value' });
    }
    return {
      ok: true, previewId, weekKey, generatedAt: new Date(now).toISOString(), expiresAt: new Date(entry.expiresAt).toISOString(),
      file: { name: resolved.name, tab: picked.tab, headerRow: picked.headerRow, tabCount: picked.tabCount },
      mapping, untouched, commit: f.sharepointWriteCommit === true,
      units: matches.map((x) => ({ equipmentId: x.equipmentId, woKey: x.woKey, match: x.match, sheetRow: x.sheetRow, candidates: x.candidates, via: x.via, needsConfirm: x.needsConfirm })),
      cells: cells.map((c) => ({
        id: c.id, equipmentId: c.equipmentId, woKey: c.woKey, sheetRow: c.sheetRow, column: c.column, header: c.header,
        current: c.current, next: c.next, state: c.state, reason: c.reason, selectable: c.selectable, defaultChecked: c.defaultChecked,
        editor: c.editor, options: c.options, warnings: c.warnings,
      })),
      counts, diagnostics, truncated: !!g.truncated,
    };
  }

  // ── write ─────────────────────────────────────────────────────────────────
  function _reportCell(pc, status, reason, extra) {
    const out = { id: pc.id, equipmentId: pc.equipmentId, sheetRow: pc.sheetRow, column: pc.column, header: pc.header, status, reason: reason || null };
    return Object.assign(out, extra || {});
  }

  function _report(entry, listed, noChange, errors) {
    const cnt = (s) => listed.filter((c) => c.status === s).length;
    const forStatus = listed.concat(new Array(noChange).fill({ status: 'skipped', reason: 'no-change' }));
    const authFailed = (errors || []).some((e) => e.code === 'auth-required');
    const st = diff.deriveWriteStatus({ gate: null, authFailed, cells: forStatus });
    return {
      ok: st.ok, status: st.status, weekKey: entry.weekKey, completedAt: new Date(clock.now()).toISOString(),
      counts: {
        written: cnt('written'), skipped: cnt('skipped') + noChange, conflict: cnt('conflict'), failed: cnt('failed'),
        noChange, emptySource: entry.unitCounts.emptySource, unitsNotInSheet: entry.unitCounts.notInSheet, unitsAmbiguous: entry.unitCounts.ambiguous,
      },
      cells: listed, errors: errors || [],
    };
  }

  async function write(args = {}) {
    const f = flags();
    if (f.sharepointWrite !== true) return { ok: false, code: 'off' };
    if (f.sharepointWriteCommit !== true) return { ok: false, code: 'write-disabled', error: WRITE_DISABLED_TEXT };
    try {
      return await _write(args);
    } catch (e) {
      return internal('write', e);
    }
  }

  async function _write(args) {
    if (args.confirm !== true) return { ok: false, code: 'confirm-required' };
    const req = args.cells;
    if (!Array.isArray(req) || req.length === 0) return { ok: false, code: 'invalid-cell' };
    if (req.length > LIMITS.maxCells) return { ok: false, code: 'too-many-cells' };
    _prune();
    const entry = typeof args.previewId === 'string' ? cache.get(args.previewId) : null;
    if (!entry || entry.expiresAt <= clock.now()) { if (entry) cache.delete(args.previewId); return { ok: false, code: 'preview-expired' }; }
    if (entry.state === 'writing') return { ok: false, code: 'busy' };
    // A17: claimed synchronously so a second write for this preview is busy.
    entry.state = 'writing';
    const life = { consumed: false };
    try {
      return await _writeClaimed(entry, req, life);
    } finally {
      if (life.consumed) cache.delete(entry.previewId);
      else if (cache.get(entry.previewId) === entry) entry.state = 'ready';
    }
  }

  async function _writeClaimed(entry, req, life) {
    const weekKey = links.isoWeekKey(new Date(clock.now()));
    if (weekKey !== entry.weekKey) return { ok: false, code: 'week-rolled' };
    const link = await links.findLink(weekKey, linkDeps);
    if (!link || links.sha256(link.url) !== entry.linkFingerprint) return { ok: false, code: 'link-changed' };
    // ids against the cache; text re-validated on the server
    const seen = new Set();
    const approved = [];
    let badText = 0;
    for (const c of req) {
      if (!c || typeof c !== 'object' || typeof c.cellId !== 'string' || !CELL_ID_RE.test(c.cellId) || seen.has(c.cellId)) return { ok: false, code: 'invalid-cell' };
      seen.add(c.cellId);
      const pc = entry.cellsById.get(c.cellId);
      if (!pc || pc.selectable !== true) return { ok: false, code: 'invalid-cell' };
      const v = C.validateCellText(pc.fieldKey, c.text);
      if (!v.ok) { badText++; continue; }
      approved.push({ pc, next: v.text });
    }
    if (badText) { log.warn('[ldsp] write gate', { code: 'invalid-text', cells: badText }); return { ok: false, code: 'invalid-text' }; }

    const listed = [];
    let noChange = 0;
    const working = [];
    for (const a of approved) {
      const pc = a.pc;
      const st = diff.classifyCell(pc.current, a.next, { fieldKey: pc.fieldKey, formula: pc.info.formula, merged: pc.info.merged, protected: pc.info.protected });
      const extra = {};
      if (a.next !== pc.next) extra.edited = true;
      if (diff.validationMismatch(pc.info.validation, a.next)) extra.warning = 'validation-mismatch';
      if (st.state === 'no-change') { noChange++; continue; }
      if (st.state === 'blocked') { listed.push(_reportCell(pc, 'skipped', st.reason, extra)); continue; }
      working.push({ pc, next: a.next, state: st.state, extra });
    }
    for (const pc of entry.cellsById.values()) {
      if (!pc.selectable || seen.has(pc.id)) continue;
      if (pc.state === 'conflict') listed.push(_reportCell(pc, 'conflict', 'not-approved'));
      else listed.push(_reportCell(pc, 'skipped', 'not-approved'));
    }
    if (!working.length) {
      life.consumed = true;
      return _finishReport(entry, listed, noChange, []);
    }

    {
      const out = await _lockWithTimeout(async () => {
        const f2 = flags();
        if (f2.sharepointWrite !== true) return { gate: { ok: false, code: 'off' } };
        if (f2.sharepointWriteCommit !== true) return { gate: { ok: false, code: 'write-disabled', error: WRITE_DISABLED_TEXT } };
        const ctx = { putAttempted: false, finished: null };
        const r = await transport.withSession(entry.target, (ops) => _cycle(ops, entry, working, f2, ctx), { op: 'write', timeoutMs: LIMITS.writeTimeoutMs });
        return { r, ctx };
      });
      if (out.busy) { log.warn('[ldsp] write', { code: 'busy' }); return { ok: false, code: 'busy' }; }
      if (out.gate) return out.gate;
      const { r, ctx } = out;
      if (ctx.finished) {
        life.consumed = ctx.finished.consumed;
        for (const c of ctx.finished.cells) listed.push(c);
        const report = _finishReport(entry, listed, noChange + (ctx.finished.noChange || 0), ctx.finished.errors || []);
        if (!life.consumed) report.previewKept = true;
        return report;
      }
      // session failed before or during the cycle
      const code = (r && r.code) || 'internal';
      if (code === 'internal') throw new InternalAbort();
      if (ctx.putAttempted) {
        life.consumed = true;
        for (const w of working) listed.push(_reportCell(w.pc, 'failed', 'upload-unknown', w.extra));
        return _finishReport(entry, listed, noChange, [{ code }]);
      }
      log.warn('[ldsp] write', { code });
      for (const w of working) listed.push(_reportCell(w.pc, 'failed', code, w.extra));
      const report = _finishReport(entry, listed, noChange, [{ code }]);
      report.previewKept = true;
      return report;
    }
  }

  function _finishReport(entry, listed, noChange, errors) {
    const report = _report(entry, listed, noChange, errors);
    if (report.counts.written || report.counts.failed) {
      try { links.markWrite(entry.weekKey, { written: report.counts.written, failed: report.counts.failed }, linkDeps); }
      catch (_) { log.warn('[ldsp] lastWrite not recorded', { code: 'store' }); }
    }
    log.info('[ldsp] write', { status: report.status, counts: report.counts });
    return report;
  }

  function _lockWithTimeout(fn) {
    return new Promise((resolve, reject) => {
      let cancelled = false;
      const t = setTimeout(() => { cancelled = true; resolve({ busy: true }); }, LIMITS.lockWaitMs);
      let p;
      try {
        p = lock(async () => {
          if (cancelled) return; // the queued task is a no-op after cancellation
          clearTimeout(t);
          try { resolve(await fn()); } catch (e) { reject(e); }
        });
      } catch (e) { clearTimeout(t); reject(e); return; }
      if (p && typeof p.catch === 'function') p.catch(() => {});
    });
  }

  // Runs inside the lock and one session. Sets ctx.finished when the cycle
  // reached a report; returns {ok:false, code} for pre-PUT failures.
  async function _cycle(ops, entry, working, f, ctx) {
    const fin = (cells, consumed, extra) => { ctx.finished = { cells, consumed, ...(extra || {}) }; return { ok: true }; };
    const all = (status, reason, list, extraFn) => (list || working).map((w) => _reportCell(w.pc, status, reason, Object.assign({}, w.extra, extraFn ? extraFn(w) : {})));
    const dl = await ops.download();
    if (!dl || !dl.ok) {
      const code = (dl && dl.code) || 'internal';
      if (code === 'changed-since-preview') return fin(all('skipped', 'changed-since-preview'), true);
      if (code === 'too-large' || code === 'not-found' || code === 'unsupported-workbook') return fin(all('failed', code), true, { errors: [{ code }] });
      return { ok: false, code }; // pre-PUT failure: the preview is kept (state back to ready)
    }
    const b0 = dl.bytes;
    const m0 = dl.meta || {};
    // layout must be identical to the preview
    let picked = null;
    try {
      const wb = await grid.openWorkbook(b0);
      picked = await grid.pickTab(wb, { tab: entry.tab });
    } catch (e) {
      if (!(e instanceof grid.GridError)) throw e;
      picked = null;
    }
    if (!picked || !picked.ok || picked.tab !== entry.tab || picked.headerRow !== entry.headerRow || _columnsSig(picked.columns) !== entry.columnsSig) {
      log.info('[ldsp] write layout-changed', { cells: working.length });
      return fin(all('skipped', 'layout-changed'), true);
    }
    const g = picked.grid;
    const rows = grid.sheetRowsFrom(g, picked.headerRow, picked.columns);
    // A6: re-run the match for every equipment id in the working set
    const rematch = new Map();
    for (const w of working) {
      const ek = _eqKey(w.pc.equipmentId);
      if (rematch.has(ek)) continue;
      const us = entry.unitsByEq.get(ek) || [];
      const ms = matchUnits(rows, us, { hasWoCol: entry.hasWoCol });
      us.forEach((u, i) => rematch.set(_unitKey(u), ms[i]));
      rematch.set(ek, true);
    }
    const cells = [];
    const patches = [];
    let noChange = 0;
    working.sort((a, b) => (a.pc.sheetRow - b.pc.sheetRow) || (a.pc.colIndex - b.pc.colIndex));
    for (const w of working) {
      const uk = _eqKey(w.pc.equipmentId) + '::' + String(w.pc.woKey || 'primary');
      const pm = entry.matchByUnit.get(uk) || {};
      const info = grid.cellInfo(g, w.pc.sheetRow, w.pc.colIndex);
      const rc = diff.recheckCell({
        previewMatch: { sheetRow: pm.sheetRow, via: pm.via }, rematch: rematch.get(uk) || null,
        previewCurrent: w.pc.current, currentNow: info.current, next: w.next, formula: info.formula, merged: info.merged,
      });
      if (rc.status === 'patch' && info.protected) { cells.push(_reportCell(w.pc, 'skipped', 'protected', w.extra)); continue; }
      if (rc.status === 'patch') { patches.push(w); continue; }
      if (rc.reason === 'no-change') { noChange++; continue; }
      cells.push(_reportCell(w.pc, 'skipped', rc.reason, Object.assign({}, w.extra, rc.detail ? { detail: rc.detail } : {})));
    }
    if (!patches.length) return fin(cells, true, { noChange });
    const plist = patches.map((w) => ({ row: w.pc.sheetRow, col: w.pc.colIndex, text: w.next }));
    let b1;
    try {
      b1 = (await grid.patchWorkbookBytes(b0, picked.part, plist, { allowedCols: entry.allowedCols })).bytes;
    } catch (e) {
      const code = e && e.code ? 'patch-' + e.code : null;
      if (!code) throw e;
      log.error('[ldsp] patch refused', { code, cells: patches.map((w) => w.pc.id) });
      return fin(cells.concat(all('failed', code, patches)), true, { noChange, errors: [{ code }] });
    }
    const sc = await grid.selfCheck(b0, b1, picked.part, plist);
    if (!sc.ok) {
      log.error('[ldsp] self-check failed', { check: sc.reason });
      return fin(cells.concat(all('failed', 'self-check', patches)), true, { noChange, errors: [{ code: 'self-check' }] });
    }
    // guard immediately before the PUT
    const m1 = await ops.meta();
    if (!m1 || !m1.ok) return { ok: false, code: m1 && m1.code === 'auth-required' ? 'auth-required' : 'guard-unavailable' };
    if (m1.etag !== m0.etag || m1.modified !== m0.modified) {
      log.info('[ldsp] write guard', { code: 'changed-since-preview', cells: patches.length });
      return fin(cells.concat(all('skipped', 'changed-since-preview', patches)), true, { noChange });
    }
    const ifMatch = f.sharepointGuard === 'if-match' ? m1.etag : undefined;
    ctx.putAttempted = true;
    const put = await ops.put(b1, ifMatch ? { ifMatch } : {});
    let outcome;
    if (put && put.ok) outcome = 'ok';
    else if (put && (put.code === 'network' || put.code === 'timeout') && put.sent !== false) outcome = 'unknown';
    else {
      const code = (put && put.code) || 'internal';
      if (code === 'precondition') return fin(cells.concat(all('skipped', 'changed-since-preview', patches)), true, { noChange });
      if (!put || put.sent === false) ctx.putAttempted = false; // digest failed: nothing was sent
      log.warn('[ldsp] upload', { code });
      if (!ctx.putAttempted && PRE_PUT_RETRYABLE.has(code)) return { ok: false, code };
      return fin(cells.concat(all('failed', code, patches)), true, { noChange, errors: [{ code }] });
    }
    // verify read-back
    const seenNow = new Map();
    let gotAny = false;
    for (const d of VERIFY_DELAYS_MS) {
      await clock.sleep(d);
      let g2 = null;
      try {
        const rb = await ops.get();
        if (rb && rb.ok) {
          const wb2 = await grid.openWorkbook(rb.bytes);
          g2 = await grid.readGrid(wb2, entry.tab);
        }
      } catch (e) {
        if (!(e instanceof grid.GridError)) throw e;
        g2 = null;
      }
      if (!g2) continue;
      gotAny = true;
      let allMatch = true;
      for (const w of patches) {
        const v = g2.text(w.pc.sheetRow, w.pc.colIndex);
        seenNow.set(w.pc.id, v);
        if (C.normText(v) !== C.normText(w.next)) allMatch = false;
      }
      if (allMatch) break;
    }
    let lagged = 0, mismatched = 0;
    for (const w of patches) {
      const overwrote = w.state === 'conflict' ? { overwrote: true } : {};
      const v = seenNow.has(w.pc.id) ? C.normText(seenNow.get(w.pc.id)) : null;
      if (v !== null && v === C.normText(w.next)) { cells.push(_reportCell(w.pc, 'written', null, Object.assign({}, w.extra, { verified: true }, overwrote))); continue; }
      const stillOld = v === null || v === C.normText(w.pc.current);
      if (outcome === 'ok' && stillOld) { lagged++; cells.push(_reportCell(w.pc, 'written', 'verification-pending', Object.assign({}, w.extra, { verified: false }, overwrote))); continue; }
      if (outcome === 'unknown' && stillOld) { cells.push(_reportCell(w.pc, 'failed', 'upload-unknown', w.extra)); continue; }
      mismatched++;
      cells.push(_reportCell(w.pc, 'failed', 'verify-mismatch', w.extra));
    }
    if (lagged || mismatched || !gotAny) log.warn('[ldsp] verify', { lagged, mismatched, readBack: gotAny });
    return fin(cells, true, { noChange, errors: outcome === 'unknown' ? [{ code: 'network' }] : [] });
  }

  function discard(previewId) {
    if (typeof previewId === 'string') {
      const e = cache.get(previewId);
      if (e && e.state !== 'writing') cache.delete(previewId);
    }
    return { ok: true };
  }

  return { preview, write, discard, _cacheForTests: () => cache };
}

module.exports = { createSheetService, weekLabel, LIMITS, VERIFY_DELAYS_MS, WRITE_DISABLED_TEXT };

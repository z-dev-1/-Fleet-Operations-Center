'use strict';
/**
 * src/aperia/ai-context.js — PRIVATE Aperia tire data block for Orcha's answer prompt.
 *
 * Fails closed: only source 'fab' (in-app FAB) and 'slack-justme' (Z's own Just Me channel) get a block,
 * and only for tire/Aperia questions; anything else returns { text:'' } without touching a dependency.
 * Read-only: session.status, client.lookupUnit / listIssues / crossLinkCriticalNoCase, the sync-read
 * cache and the DTNA case cache. Every Aperia read is time-bounded (AbortController + setTimeout).
 * Injected ONLY by src/ipc/ai.js processOrchaAction (never partner/team surfaces).
 *
 *   isAperiaQuestion(msg) -> boolean
 *   unitTokens(msg, resolvedUnitIds) -> up to 3 upper-case unit ids (resolved ids first)
 *   buildAperiaBlock({ source, messageText, unitIds, ctx, signal }, deps?) -> Promise<{ text, units, fleet }>
 *
 * Never throws. Logs carry op, code, counts and ms only.
 */
const log = require('../utils/logger')('aperia');

const MAX_CHARS = 6000;
const MAX_UNITS = 3;
const MAX_FLEET_LINES = 40;
const UNIT_TIMEOUT_MS = 10e3;
const ISSUES_TIMEOUT_MS = 15e3;
const CACHE_FRESH_MS = 30 * 60e3;

const HEADER = '=== APERIA TIRE DATA (PRIVATE to Z \u2014 answer Z from this; do not copy it into any SLACK/EMAIL action unless Z explicitly asks to share tire data) ===';
const NOT_CONNECTED = 'Aperia is not connected (sign in from the Aperia pill in the status bar)';
const UNAVAILABLE = 'Aperia data unavailable right now';

const TOPIC_RE = /\b(tires?|tyres?|psi|pressure|inflat\w*|underinflat\w*|leak\w*|aperia|halo|tpms|gps)\b/i;
const UNIT_RE = /\b[A-Za-z]{0,4}\d{4,8}\b/g;

// Test seam: { session, client, syncRead, fleetScope, dtnaStore, now }.
let _deps = {};
function _setDeps(d) { _deps = d || {}; }
function _resetForTests() { _deps = {}; }

function _resolve(d) {
  const o = Object.assign({}, _deps, d || {});
  return {
    session: () => o.session || require('./session'),
    client: () => o.client || require('./client'),
    syncRead: () => o.syncRead || require('./sync-read'),
    fleetScope: () => o.fleetScope || require('./fleet-scope'),
    dtnaStore: () => o.dtnaStore || require('../dtna/store'),
    now: () => (typeof o.now === 'function' ? o.now() : Date.now()),
  };
}

function isAperiaQuestion(msg) { return TOPIC_RE.test(String(msg || '')); }

function unitTokens(msg, resolvedUnitIds) {
  const out = [];
  const add = (v) => {
    const k = String(v == null ? '' : v).toUpperCase().trim();
    if (k && !out.includes(k) && out.length < MAX_UNITS) out.push(k);
  };
  for (const u of Array.isArray(resolvedUnitIds) ? resolvedUnitIds : []) add(u);
  for (const m of String(msg || '').match(UNIT_RE) || []) add(m);
  return out;
}

/**
 * _timed(fn, ms, parentSignal) -> fn(signal)'s result, or { ok:false, code:'APERIA_TIMEOUT' } after ms,
 * or { ok:false, code:'APERIA_CANCELLED' } when the caller aborts. The inner signal is aborted on both.
 */
function _timed(fn, ms, parentSignal) {
  return new Promise((resolve) => {
    const ac = new AbortController();
    let done = false;
    let timer = null;
    const onAbort = () => finish({ ok: false, code: 'APERIA_CANCELLED' }, true);
    function finish(r, abort) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (parentSignal && typeof parentSignal.removeEventListener === 'function') parentSignal.removeEventListener('abort', onAbort);
      if (abort) { try { ac.abort(); } catch (_) {} }
      resolve(r);
    }
    if (parentSignal && parentSignal.aborted) { finish({ ok: false, code: 'APERIA_CANCELLED' }, true); return; }
    if (parentSignal && typeof parentSignal.addEventListener === 'function') parentSignal.addEventListener('abort', onAbort);
    timer = setTimeout(() => finish({ ok: false, code: 'APERIA_TIMEOUT' }, true), ms);
    Promise.resolve()
      .then(() => fn(ac.signal))
      .then((r) => finish(r, false), () => finish({ ok: false, code: 'APERIA_INTERNAL' }, false));
  });
}

function _code(r) { return String((r && r.code) || 'APERIA_INTERNAL').slice(0, 40); }
function _v(x) { return x == null || x === '' ? '-' : String(x); }
function _signed(n) { return n == null ? '-' : (n > 0 ? '+' + n : String(n)); }

function _tireLine(t) {
  const name = (t.positionName || t.position || '?') + (t.shortPosition ? ' (' + t.shortPosition + ')' : '');
  return [
    name,
    (t.pressure == null ? '-' : t.pressure) + ' PSI',
    'target ' + _v(t.setPoint),
    'delta ' + _signed(t.deltaPsi),
    (t.temperatureF == null ? '-' : t.temperatureF) + ' \u00b0F',
    _v(t.readAtEt),
    t.flag || '-',
  ].join(' | ');
}

function _unitSection(id, r) {
  if (!r || !r.ok || !r.unit) {
    if (r && r.code === 'APERIA_UNIT_NOT_FOUND') return 'No Aperia record for ' + id;
    return 'Aperia lookup failed (' + _code(r) + ') for ' + id;
  }
  const u = r.unit;
  const lines = ['[' + (u.fleetVehicleId || id) + '] Aperia tires' + (u.domicile ? ' (' + u.domicile + ')' : '')];
  for (const t of Array.isArray(u.tires) ? u.tires : []) lines.push(_tireLine(t));
  lines.push(u.gps ? 'GPS: ' + u.gps.lat + ', ' + u.gps.lng + ' @ ' + _v(u.gps.atEt) : 'GPS: ' + _v(u.gpsReason));
  for (const x of Array.isArray(u.issues) ? u.issues : []) {
    lines.push('Alert: ' + _v(x.severity) + ' ' + String(x.type || '').replace(/_/g, ' ') + ' \u2013 ' + _v(x.positionName)
      + (x.resolveBy ? ' \u00b7 resolve ' + x.resolveBy : '')
      + (Array.isArray(x.actions) && x.actions.length ? ' \u00b7 actions: ' + x.actions.join(' ') : ''));
  }
  return lines.join('\n');
}

function _fleetLines(issues) {
  const hits = (Array.isArray(issues) ? issues : []).filter((r) => r && r.muted !== true
    && (r.severity === 'CRITICAL' || /^UNDERINFLATION/.test(String(r.state || ''))));
  const lines = hits.slice(0, MAX_FLEET_LINES).map((r) => [
    _v(r.fleetVehicleId), _v(r.positionName || r.position), String(r.state || '-').replace(/_/g, ' '), _v(r.severity), _v(r.detectedEt),
  ].join(' | '));
  if (hits.length > MAX_FLEET_LINES) lines.push('and ' + (hits.length - MAX_FLEET_LINES) + ' more');
  return { lines, count: hits.length };
}

function _crossLines(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.inFleet);
  if (!list.length) return ['none'];
  return list.slice(0, MAX_FLEET_LINES).map((r) => _v(r.fleetVehicleId) + (r.domicile ? ' (' + r.domicile + ')' : '')
    + ' | ' + (r.criticalCount || 0) + ' critical'
    + (Array.isArray(r.states) && r.states.length ? ' | ' + r.states.join(', ').replace(/_/g, ' ') : '')
    + (Array.isArray(r.positions) && r.positions.length ? ' | ' + r.positions.join(', ') : '')
    + (r.latestDetectedEt ? ' | latest ' + r.latestDetectedEt : '')
    + ' | closed DTNA cases: ' + (r.closedDtnaCases || 0));
}

function _fleetFromCache(cached, now) {
  const age = Math.max(0, Math.round((now - Date.parse(cached.pulledAt)) / 60e3));
  const f = _fleetLines(cached.issues);
  return {
    text: ['FLEET TIRE ALERTS (your fleet units, CRITICAL / UNDERINFLATION; cached ' + (Number.isFinite(age) ? age : '?') + ' min ago)']
      .concat(f.lines.length ? f.lines : ['none'])
      .concat(['', 'CRITICAL TIRE + NO OPEN DTNA CASE (your fleet units)'], _crossLines(cached.crossLink)).join('\n'),
    count: f.count,
  };
}

async function _fleetLive(D, ctx, signal) {
  const li = await _timed((s) => D.client().listIssues(ctx, { signal: s }), ISSUES_TIMEOUT_MS, signal);
  if (!li || !li.ok) return { text: 'Aperia fleet issues read failed (' + _code(li) + ')', count: 0, code: _code(li) };
  const all = Array.isArray(li.rows) ? li.rows : [];
  const S = D.fleetScope();
  const scope = S.fleetUnitSet(ctx);
  const issues = all.filter((r) => r && S.inScope(scope, r.fleetVehicleId));
  const f = _fleetLines(issues);
  let dtnaEntries = [];
  try { dtnaEntries = D.dtnaStore().all() || []; } catch (_) { dtnaEntries = []; }
  let cross = [];
  try {
    cross = D.client().crossLinkCriticalNoCase(all, { dtnaEntries, fleetRows: Array.from(scope).map((k) => ({ equipmentId: k })) }) || [];
  } catch (_) { cross = []; }
  return {
    text: ['FLEET TIRE ALERTS (your fleet units, CRITICAL / UNDERINFLATION; live)']
      .concat(f.lines.length ? f.lines : ['none'])
      .concat(['', 'CRITICAL TIRE + NO OPEN DTNA CASE (your fleet units)'], _crossLines(cross)).join('\n'),
    count: f.count,
  };
}

function _cachedOf(D) {
  try {
    const c = D.syncRead().cached();
    return c && Number.isFinite(Date.parse(c.pulledAt)) ? c : null;
  } catch (_) { return null; }
}

function _wrap(body) {
  const t = HEADER + '\n' + body;
  return t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t;
}

async function _build(o, D) {
  const t0 = Date.now();
  const now = D.now();
  const units = unitTokens(o.messageText, o.unitIds);
  let st = null;
  try { st = D.session().status(); } catch (_) { st = null; }
  const parts = [];
  let fleet = false;
  if (!st || st.state !== 'connected') {
    parts.push(NOT_CONNECTED);
    const c = _cachedOf(D);
    if (c) { parts.push(_fleetFromCache(c, now).text); fleet = true; }
    log.info('[aperia] ai-context', { op: 'block', code: 'NOT_CONNECTED', cached: !!c, ms: Date.now() - t0 });
    return { text: _wrap(parts.join('\n\n')), units, fleet };
  }
  if (units.length) {
    let failed = 0;
    for (const id of units) {
      const r = await _timed((s) => D.client().lookupUnit(id, o.ctx || null, { signal: s }), UNIT_TIMEOUT_MS, o.signal);
      if (!r || !r.ok) failed++;
      parts.push(_unitSection(id, r));
    }
    log.info('[aperia] ai-context', { op: 'units', units: units.length, failed, ms: Date.now() - t0 });
  } else {
    const c = _cachedOf(D);
    const f = c && now - Date.parse(c.pulledAt) <= CACHE_FRESH_MS ? _fleetFromCache(c, now) : await _fleetLive(D, o.ctx || null, o.signal);
    parts.push(f.text);
    fleet = true;
    log.info('[aperia] ai-context', { op: 'fleet', cached: !!(c && now - Date.parse(c.pulledAt) <= CACHE_FRESH_MS), issues: f.count, code: f.code || 'OK', ms: Date.now() - t0 });
  }
  return { text: _wrap(parts.join('\n\n')), units, fleet };
}

async function buildAperiaBlock(opts, deps) {
  const o = opts || {};
  if (o.source !== 'fab' && o.source !== 'slack-justme') return { text: '', units: [], fleet: false };
  if (!isAperiaQuestion(o.messageText)) return { text: '', units: [], fleet: false };
  try {
    return await _build(o, _resolve(deps));
  } catch (e) {
    log.warn('[aperia] ai-context', { op: 'block', code: 'APERIA_INTERNAL' });
    return { text: _wrap(UNAVAILABLE), units: [], fleet: false };
  }
}

module.exports = {
  isAperiaQuestion, unitTokens, buildAperiaBlock, HEADER, MAX_CHARS, UNIT_TIMEOUT_MS, ISSUES_TIMEOUT_MS, _setDeps, _resetForTests,
};

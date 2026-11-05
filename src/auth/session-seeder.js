'use strict';
/**
 * src/auth/session-seeder.js — the one writer of Midway/AEA cookies into
 * PARTITION sessions (auth.propagation, default OFF).
 *
 *   seedSession(ses, { reason, partition }, deps)   disk cookies + fresh posture AEA, Amazon hosts only
 *   seedOrLegacy(ses, opts, legacyFn, deps)         flag off: the call site's original statement, verbatim
 *   refreshSticky(reason, deps)                     re-seed STICKY partitions already seeded this process
 *   seedForRelayOpen(partition, deps)               relay:open-url decision ('' -> default jar, raw inject)
 *   buildInventory(ses, deps)                       secret-free AEA / to-Midway cookie inventory
 *   guardedSession(ses, counters, log)              cookies.set wrapper enforcing AMAZON_HOST_RE
 *
 * Rules:
 *  - Never targets defaultSession (step 0). auth.js bumps the Phase 9 cookie
 *    generation only when the injector target IS defaultSession; a wrapped
 *    default jar would skip that bump. seedOrLegacy then runs the legacy lambda.
 *  - Every cookie write goes through guardedSet: EVERY present host (domain with
 *    the leading dot stripped AND the url hostname) must be an Amazon host.
 *  - Cookie contents are never read here: only name, domain, url, expirationDate.
 *  - src/scrapers/auth.js is not modified; its injectors only call
 *    ses.cookies.set / ses.cookies.flushStore, which the wrapper provides.
 */

let logger; try { logger = require('../utils/logger').createLogger('auth-seed'); } catch (_) { logger = { debug() {}, info() {}, warn() {}, error() {} }; }

const MIDWAY_PARTITIONS = new Set(['persist:vendor-uptake', 'persist:vendor-roadready', 'persist:slack']);
const STICKY = ['persist:vendor-uptake'];
const AMAZON_HOST_RE = /(^|\.)(amazon\.com|amazon\.dev|a2z\.com|aws\.dev)$/i;
const AEA_NAME = 'amazon_enterprise_access';
const STICKY_MIN_INTERVAL_MS = 5 * 60 * 1000;
const STICKY_WARN_INTERVAL_MS = 60 * 60 * 1000;
const MIDWAY_HOST = 'midway-auth.amazon.com';

// F6: keyed by the partition STRING; only a successful seedSession WITH a partition adds to it.
const _seededThisProcess = new Set();
const _lastSticky = new Map();      // partition -> ms of the last sticky refresh attempt
const _stickyWarnAt = new Map();    // partition -> ms of the last sticky failure warning

function _enabled(deps) {
  if (deps && typeof deps.enabled === 'boolean') return deps.enabled;
  try { return require('./auth-report').isEnabled() === true; } catch (_) { return false; }
}
function isEnabled() { return _enabled({}); }

function _log(deps) { return (deps && deps.logger) || logger; }
function _safe(s, n) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9:_ .@\/-]/g, '').slice(0, n || 80); }
function _sanitizeReason(r) {
  const s = String(r == null ? '' : r).slice(0, 60).replace(/[^A-Za-z0-9:_ .-]/g, '');
  return s || 'unspecified';
}

// ── Host guard (F7) ─────────────────────────────────────────────────────────
/** Every present host must be Amazon. Unparsable url -> mismatch. No host at all -> reject. */
function isAmazonCookieTarget(c) {
  if (!c || typeof c !== 'object') return false;
  const hosts = [];
  if (typeof c.domain === 'string' && c.domain !== '') hosts.push(c.domain.replace(/^\./, ''));
  if (c.url != null && c.url !== '') {
    let h = null;
    try { h = new URL(String(c.url)).hostname; } catch (_) { return false; }
    if (!h) return false;
    hosts.push(h);
  }
  if (!hosts.length) return false;
  return hosts.every((h) => h !== '' && AMAZON_HOST_RE.test(h));
}

/**
 * guardedSession(ses, counters?, log?) -> { cookies: { set, flushStore, get } }.
 * counters (mutated): { blockedNonAmazon, accepted, aeaAccepted }.
 */
function guardedSession(ses, counters, log) {
  const k = counters || {};
  k.blockedNonAmazon = k.blockedNonAmazon || 0;
  k.accepted = k.accepted || 0;
  k.aeaAccepted = k.aeaAccepted || 0;
  const lg = log || logger;
  async function guardedSet(c) {
    if (!isAmazonCookieTarget(c)) {
      k.blockedNonAmazon++;
      try { lg.warn('[auth-seed] blocked non-amazon cookie name=' + _safe(c && c.name, 60) + ' domain=' + _safe((c && (c.domain || c.url)) || '-', 80)); } catch (_) {}
      throw new Error('non-amazon-host');
    }
    const r = await ses.cookies.set(c);
    k.accepted++;
    if (c.name === AEA_NAME) k.aeaAccepted++;
    return r;
  }
  return {
    cookies: {
      set: guardedSet,
      flushStore: () => (typeof ses.cookies.flushStore === 'function' ? ses.cookies.flushStore() : Promise.resolve()),
      get: (...a) => ses.cookies.get(...a),
    },
  };
}

// ── Seeding ─────────────────────────────────────────────────────────────────
function _defaultSessionOf(deps) {
  try {
    const electron = (deps && deps.electron) || require('electron');
    return (electron && electron.session && electron.session.defaultSession) || null;
  } catch (_) { return null; }
}

/**
 * seedSession(ses, { reason, partition }, deps{ auth, electron, logger })
 *   -> { ok, injected, aea: 'posture+disk'|'disk-only'|'posture-only'|'none', blockedNonAmazon, errors }
 */
async function seedSession(ses, opts, deps) {
  opts = opts || {}; deps = deps || {};
  const log = _log(deps);
  const reason = _sanitizeReason(opts.reason);
  const partition = (typeof opts.partition === 'string' && opts.partition) ? opts.partition : null;
  const res = { ok: false, injected: 0, aea: 'none', blockedNonAmazon: 0, errors: [] };

  // Step 0: never the default jar (Phase 9 cookie generation must be bumped by the raw injectors).
  const def = _defaultSessionOf(deps);
  if (ses && def && ses === def) {
    res.errors.push('default-session-not-seeded');
    try { log.debug('[auth-seed] reason=' + reason + ' refused defaultSession'); } catch (_) {}
    return res;
  }
  // Step 1: validate.
  if (!ses || !ses.cookies || typeof ses.cookies.set !== 'function') {
    res.errors.push('invalid-session');
    try { log.warn('[auth-seed] reason=' + reason + ' invalid session'); } catch (_) {}
    return res;
  }
  const auth = deps.auth || require('../scrapers/auth');
  const counters = { blockedNonAmazon: 0, accepted: 0, aeaAccepted: 0 };
  const g = guardedSession(ses, counters, log);

  // Step 3: disk cookies (session + disk AEA), exactly what the call sites inject today.
  let diskAea = false;
  try { await auth.injectCookies(g); }
  catch (e) {
    const msg = String((e && e.message) || '');
    res.errors.push(/not found|ENOENT|cookie file/i.test(msg) ? 'cookie-file-missing' : 'disk-inject-failed');
    try { log.warn('[auth-seed] reason=' + reason + ' disk cookies not injected (' + res.errors[res.errors.length - 1] + ')'); } catch (_) {}
  }
  diskAea = counters.aeaAccepted > 0;

  // Step 4: fresh posture AEA when the ACME token has life left.
  let postureAea = false;
  let pmin = null;
  try { pmin = auth.postureTokenExpiryMin(); } catch (_) { pmin = null; }
  if (typeof pmin === 'number' && pmin > 0) {
    const before = counters.aeaAccepted;
    try {
      const r = await auth.injectAeaFromPostureToken(g);
      postureAea = !!(r && r.ok) && counters.aeaAccepted > before;
      if (!(r && r.ok)) res.errors.push('posture-' + _sanitizeReason((r && r.reason) || 'failed'));
    } catch (_) { res.errors.push('posture-inject-failed'); }
  } else {
    res.errors.push('posture-unavailable');
  }

  res.injected = counters.accepted;
  res.blockedNonAmazon = counters.blockedNonAmazon;
  res.aea = postureAea && diskAea ? 'posture+disk' : diskAea ? 'disk-only' : postureAea ? 'posture-only' : 'none';
  res.ok = res.injected > 0;
  if (res.ok && partition) _seededThisProcess.add(partition);
  try {
    log.info('[auth-seed] reason=' + reason + ' partition=' + (partition ? _safe(partition, 60) : '-') +
      ' injected=' + res.injected + ' aea=' + res.aea + ' blocked=' + res.blockedNonAmazon);
  } catch (_) {}
  return res;
}

/**
 * seedOrLegacy(ses, opts, legacyFn, deps) — flag off: `await legacyFn()` verbatim.
 * Flag on: seedSession; a defaultSession target falls back to the legacy lambda.
 */
async function seedOrLegacy(ses, opts, legacyFn, deps) {
  deps = deps || {};
  if (!_enabled(deps)) return await legacyFn();
  const r = await seedSession(ses, opts, deps);
  if (r && Array.isArray(r.errors) && r.errors.includes('default-session-not-seeded')) return await legacyFn();
  return r;
}

/**
 * refreshSticky(reason, deps{ fromPartition, now, seed, logger, ... }) — re-seed each
 * STICKY partition that this process already seeded, at most once per 5 min per partition.
 */
async function refreshSticky(reason, deps) {
  deps = deps || {};
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const seed = typeof deps.seed === 'function' ? deps.seed : seedSession;
  const fromPartition = typeof deps.fromPartition === 'function'
    ? deps.fromPartition
    : (p) => require('electron').session.fromPartition(p);
  const log = _log(deps);
  const r = _sanitizeReason(reason);
  const results = [];
  for (const p of STICKY) {
    if (!_seededThisProcess.has(p)) continue;
    const t = now();
    if (_lastSticky.has(p) && (t - _lastSticky.get(p)) < STICKY_MIN_INTERVAL_MS) continue;
    _lastSticky.set(p, t);
    try {
      const out = await seed(fromPartition(p), { reason: 'sticky:' + r, partition: p }, deps);
      results.push({ partition: p, ok: !!(out && out.ok) });
    } catch (e) {
      results.push({ partition: p, ok: false });
      const last = _stickyWarnAt.get(p) || 0;
      if (!_stickyWarnAt.has(p) || (t - last) >= STICKY_WARN_INTERVAL_MS) {
        _stickyWarnAt.set(p, t);
        try { log.warn('[auth-seed] sticky refresh failed partition=' + _safe(p, 60) + ' reason=' + r); } catch (_) {}
      }
    }
  }
  return { refreshed: results.length, results };
}

/**
 * relay:open-url decision (flag on only; the call site keeps its original line flag off):
 *   ''                   -> the raw default-jar inject (auth.injectCookies(), generation bump intact)
 *   in MIDWAY_PARTITIONS -> seedSession on that partition
 *   any other partition  -> no Midway inject
 */
async function seedForRelayOpen(partition, deps) {
  deps = deps || {};
  const part = typeof partition === 'string' ? partition : '';
  if (part === '') {
    const auth = deps.auth || require('../scrapers/auth');
    await auth.injectCookies();
    return { mode: 'default' };
  }
  if (MIDWAY_PARTITIONS.has(part)) {
    const fromPartition = typeof deps.fromPartition === 'function'
      ? deps.fromPartition
      : (p) => require('electron').session.fromPartition(p);
    const seed = typeof deps.seed === 'function' ? deps.seed : seedSession;
    const result = await seed(fromPartition(part), { reason: 'relay:open-url', partition: part }, deps);
    return { mode: 'seeded', result };
  }
  return { mode: 'none' };
}

// ── Inventory (5.4) ─────────────────────────────────────────────────────────
function domainMatches(domain, host) {
  if (typeof domain !== 'string' || !domain) return false;
  const h = String(host || '').toLowerCase();
  const d = domain.toLowerCase();
  if (d.startsWith('.')) { const bare = d.slice(1); return h === bare || h.endsWith(d); }
  return h === d;
}
function _cookieHost(c) {
  if (c && typeof c.domain === 'string' && c.domain) return c.domain;
  try { return new URL(String(c && c.url)).hostname; } catch (_) { return ''; }
}

/**
 * buildInventory(ses, deps{ electron, now }) -> { aea:[{domain,min}], toMidway:{aea,session,other}, aeaCountToMidway }
 * Re-filters whatever cookies.get returns (filters are not trusted). Reads name/domain/url/expirationDate only.
 */
async function buildInventory(ses, deps) {
  deps = deps || {};
  const now = (typeof deps.now === 'function' ? deps.now : Date.now)();
  const s = ses || _defaultSessionOf(deps);
  const inv = { aea: [], toMidway: { aea: 0, session: 0, other: 0 }, aeaCountToMidway: 0 };
  if (!s || !s.cookies || typeof s.cookies.get !== 'function') return inv;
  const minLeft = (c) => (typeof c.expirationDate === 'number' && Number.isFinite(c.expirationDate))
    ? Math.round((c.expirationDate * 1000 - now) / 60000) : null;
  let a = [];
  try { a = await s.cookies.get({ name: AEA_NAME }); } catch (_) { a = []; }
  for (const c of (Array.isArray(a) ? a : [])) {
    if (!c || c.name !== AEA_NAME) continue;
    inv.aea.push({ domain: _safe(_cookieHost(c), 80), min: minLeft(c) });
  }
  let m = [];
  try { m = await s.cookies.get({ url: 'https://' + MIDWAY_HOST + '/' }); } catch (_) { m = []; }
  for (const c of (Array.isArray(m) ? m : [])) {
    if (!c) continue;
    const host = _cookieHost(c);
    const ok = (c.domain ? domainMatches(c.domain, MIDWAY_HOST) : String(host).toLowerCase() === MIDWAY_HOST);
    if (!ok) continue;
    if (c.name === AEA_NAME) inv.toMidway.aea++;
    else if (c.name === 'session' || c.name === '__Host-session') inv.toMidway.session++;
    else inv.toMidway.other++;
  }
  inv.aeaCountToMidway = inv.toMidway.aea;
  return inv;
}

function formatInventory(inv, reason) {
  const i = inv || { aea: [], toMidway: { aea: 0, session: 0 } };
  const list = (i.aea || []).map((x) => x.domain + ':' + (x.min == null ? 'n/a' : x.min + 'm')).join(', ');
  return '[auth-inventory] reason=' + _sanitizeReason(reason) + ' aea=[' + list + '] toMidway={aea:' +
    ((i.toMidway && i.toMidway.aea) || 0) + ', session:' + ((i.toMidway && i.toMidway.session) || 0) + '}';
}

// ── Test seams ──────────────────────────────────────────────────────────────
function _reset() { _seededThisProcess.clear(); _lastSticky.clear(); _stickyWarnAt.clear(); }

module.exports = {
  seedSession, seedOrLegacy, refreshSticky, seedForRelayOpen, buildInventory, formatInventory,
  guardedSession, isAmazonCookieTarget, domainMatches, isEnabled,
  MIDWAY_PARTITIONS, STICKY, AMAZON_HOST_RE, STICKY_MIN_INTERVAL_MS,
  _seededThisProcess, _reset,
};

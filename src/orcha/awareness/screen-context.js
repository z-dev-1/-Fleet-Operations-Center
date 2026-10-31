'use strict';
/**
 * screen-context.js — in-memory holder for what the user is looking at in the
 * desktop app (context-aware assistant, design §D3). Never persisted: stale
 * context should die on restart.
 *
 * sanitize() validates the renderer payload: unknown keys dropped, over-length
 * top-level strings throw ConfigError (safeIPC turns that into {ok:false}),
 * bad filter values drop that key only. _isAppSender() is the IPC sender guard
 * (preload.js is also injected into AAP corp pages).
 */

const { ConfigError } = require('../../utils/errors');
const logger = require('../../utils/logger')('screen-context');

const TABS = new Set(['repair', 'intel', 'actions', 'history']);
const FILTER_KEYS = new Set(['lifecycleState', 'lifecycleReason', 'domicileSite', 'vendor', 'operator']);
const MAX_FILTERS = 8;

let _current = null;

function _optStr(raw, key, max, nullable) {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (v === null) {
    if (nullable) return null;
    throw new ConfigError(key + ' must be a string', key);
  }
  if (typeof v !== 'string') throw new ConfigError(key + ' must be a string', key);
  if (v.length > max) throw new ConfigError(key + ' too long (max ' + max + ')', key);
  return v;
}

function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('screen context must be an object', 'context');
  const out = {};
  const view = _optStr(raw, 'view', 32, false);
  if (view !== undefined) out.view = view;
  const unitId = _optStr(raw, 'unitId', 32, true);
  if (unitId !== undefined) out.unitId = unitId;
  if (raw.tab !== undefined) out.tab = (typeof raw.tab === 'string' && TABS.has(raw.tab)) ? raw.tab : null;
  const wrId = _optStr(raw, 'wrId', 64, true);
  if (wrId !== undefined) out.wrId = wrId;
  if (raw.secondaryWrCount !== undefined) {
    const n = Math.trunc(Number(raw.secondaryWrCount));
    out.secondaryWrCount = Number.isFinite(n) ? Math.min(20, Math.max(0, n)) : 0;
  }
  if (raw.filters !== undefined && raw.filters !== null) {
    if (typeof raw.filters !== 'object' || Array.isArray(raw.filters)) throw new ConfigError('filters must be an object', 'filters');
    const f = {};
    let count = 0;
    for (const k of Object.keys(raw.filters)) {
      if (!FILTER_KEYS.has(k)) continue;
      const v = raw.filters[k];
      if (typeof v !== 'string' || v.length > 64) { logger.debug('[screen-context] filter dropped: ' + k); continue; }
      if (count >= MAX_FILTERS) break;
      f[k] = v;
      count++;
    }
    out.filters = f;
  }
  const quickFilter = _optStr(raw, 'quickFilter', 32, false);
  if (quickFilter !== undefined) out.quickFilter = quickFilter;
  const search = _optStr(raw, 'search', 80, false);
  if (search !== undefined) out.search = search;
  return out;
}

// Throws (ConfigError) on invalid payload; the holder is unchanged in that case.
function set(raw, nowMs) {
  const clean = sanitize(raw);
  _current = Object.assign({}, clean, { receivedAt: typeof nowMs === 'number' ? nowMs : Date.now() });
  return _current;
}

function get({ maxAgeMs, nowMs } = {}) {
  if (!_current) return null;
  const t = typeof nowMs === 'number' ? nowMs : Date.now();
  if (typeof maxAgeMs === 'number' && t - _current.receivedAt > maxAgeMs) return null;
  return Object.assign({}, _current, _current.filters ? { filters: Object.assign({}, _current.filters) } : {});
}

function _isAppSender(e) {
  try {
    const u = new URL(e.sender.getURL());
    return u.protocol === 'file:' || (u.protocol === 'http:' && u.host === 'localhost:5173');
  } catch (_) { return false; }
}

function _resetForTests() { _current = null; }

module.exports = { sanitize, set, get, _isAppSender, _resetForTests };

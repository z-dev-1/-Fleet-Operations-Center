// tests/fixtures/dtna/sentinels.js — DTNA strings that must never reach a log line or a dtna:* IPC result.
// SENTINEL_COMMENT / SENTINEL_FROM are business data: allowed in dtnaCaseCache and fleetData rows only.
export const SENTINEL_TOKEN = 'SENTINEL_TOKEN_dt9k1';
export const SENTINEL_CONTEXT = 'SENTINEL_CONTEXT_dc7x2';
export const SENTINEL_PAGEURI = '/Servicetracker/s/case/Case/Default?SENTINEL_PAGEURI_dp3u';
export const SENTINEL_COOKIE = 'SENTINEL_COOKIE_dk8c4';
export const SENTINEL_EMAIL = 'sentinel.user@example.test';
export const SENTINEL_COMMENT = 'SENTINEL_COMMENT_dm5t6';
export const SENTINEL_FROM = 'SENTINEL_FROM_df2n7';
export const SENTINEL_LOGIN_URL = 'https://login.ciam.daimlertruck.com/authorize?SENTINEL_LOGIN_URL_dl1r8';

/** Auth-holding values: never in logs, IPC results, sendToWindow payloads, dtnaCaseCache or fleetData. */
export const AUTH_SENTINELS = [
  'SENTINEL_TOKEN', 'SENTINEL_CONTEXT', 'SENTINEL_PAGEURI', 'SENTINEL_COOKIE', SENTINEL_EMAIL, 'SENTINEL_LOGIN_URL',
];
/** Every sentinel (auth values + comment text / author). */
export const ALL_SENTINELS = AUTH_SENTINELS.concat(['SENTINEL_COMMENT', 'SENTINEL_FROM']);

function _text(value) {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v));
  } catch (_) { return String(value); }
}

/** containsSentinel(value, list = ALL_SENTINELS) -> the first sentinel found in JSON.stringify(value), or null. */
export function containsSentinel(value, list = ALL_SENTINELS) {
  const s = _text(value);
  for (const n of list) if (s && s.includes(n)) return n;
  return null;
}

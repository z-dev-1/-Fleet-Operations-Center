// tests/fixtures/aperia/sentinels.js — Aperia values that must never reach a log line, an aperia:* IPC result,
// a sendToWindow payload, a Notification, an export file or aperia_seen_alerts.json.
import { PII_STRINGS } from './responses.js';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** sentinelJwt(tag) -> a JWT-shaped token (exp one hour ahead) whose signature segment is the plain tag. */
const sentinelJwt = (tag) => b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ exp: Math.floor(Date.now() / 1000) + 3600, sub: tag }) + '.' + tag;

export const SENTINEL_BEARER_SIG = 'SENTINELBEARERap7q';
export const SENTINEL_WS_SIG = 'SENTINELWSTOKENap8w';
export const SENTINEL_BEARER = sentinelJwt(SENTINEL_BEARER_SIG);
export const SENTINEL_WS_TOKEN = sentinelJwt(SENTINEL_WS_SIG);
export const SENTINEL_COOKIE = 'SENTINEL_COOKIE_ap9c';
export const SENTINEL_WS_URL = 'wss://amazon.aperiatech.com/api/ws/events?x-authorization=' + encodeURIComponent(SENTINEL_WS_TOKEN);

/** Every value that must never leave main-process memory / the API response. */
export const ALL_SENTINELS = [
  SENTINEL_BEARER, SENTINEL_BEARER_SIG, SENTINEL_WS_TOKEN, SENTINEL_WS_SIG, SENTINEL_COOKIE, 'x-authorization=',
].concat(PII_STRINGS);

function _text(value) {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v));
  } catch (_) { return String(value); }
}

/** containsSentinel(value, list = ALL_SENTINELS) -> the first sentinel found in the value's text, or null. */
export function containsSentinel(value, list = ALL_SENTINELS) {
  const s = _text(value);
  for (const n of list) if (s && s.includes(n)) return n;
  return null;
}

// tests/fixtures/zoom/sentinels.js — strings that must never reach a log line or an IPC result.
export const SENTINEL_COOKIE = 'SENTINEL_COOKIE_c0ok1e9';
export const SENTINEL_TOKEN = 'SENTINEL_TOKEN_t0k3n9';
export const SENTINEL_TOPIC = 'SENTINEL_TOPIC_t0p1c9';
export const SENTINEL_URL = 'https://amazon.zoom.us/j/SENTINEL_URL_u7l9';
export const SENTINEL_TRANSCRIPT = 'SENTINEL_TRANSCRIPT_tr4n9';
export const SENTINEL_PATH = 'C:\\Users\\someone\\SENTINEL_PATH_p4th9\\file.txt';

export const ALL_SENTINELS = [
  'SENTINEL_COOKIE', 'SENTINEL_TOKEN', 'SENTINEL_TOPIC', 'SENTINEL_URL', 'SENTINEL_TRANSCRIPT', 'SENTINEL_PATH',
];

/** containsSentinel(value) -> the first sentinel name found in JSON.stringify(value), or null. */
export function containsSentinel(value) {
  let s = '';
  try { s = typeof value === 'string' ? value : JSON.stringify(value, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v)); } catch (_) { s = String(value); }
  for (const n of ALL_SENTINELS) if (s && s.includes(n)) return n;
  return null;
}

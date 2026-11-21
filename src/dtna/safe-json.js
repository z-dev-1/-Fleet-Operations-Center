'use strict';
/**
 * src/dtna/safe-json.js — the ONLY JSON parser under src/dtna/**.
 * safeJson(text) -> {ok:true, value} | {ok:false}. Never throws and never exposes the SyntaxError.
 */
function safeJson(text) {
  try {
    if (typeof text !== 'string') {
      if (text && typeof text.toString === 'function' && Buffer.isBuffer(text)) text = text.toString('utf8');
      else return { ok: false };
    }
    return { ok: true, value: JSON.parse(text) };
  } catch (_) {
    return { ok: false };
  }
}

module.exports = { safeJson };

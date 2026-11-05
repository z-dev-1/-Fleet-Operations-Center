'use strict';
// src/justme-context/log-safe.js — the only way new Just Me context code renders
// an error into a log line. Library and network error messages often embed
// input (Node's JSON.parse quotes it, XML/mail parsers quote tokens, net errors
// carry URLs with query strings), so e.message is never logged or shown. Only a
// short code/name made of [A-Za-z0-9_] survives.

function errTag(e) {
  const v = e && (e.code || e.name);
  return v ? String(v).replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'Error' : 'Error';
}

module.exports = { errTag };

'use strict';
/**
 * src/aperia/safe-json.js — the ONLY JSON parser under src/aperia/**. Re-exports the shared helper
 * (src/zoom/safe-json.js): safeJson(text) -> {ok:true, value} | {ok:false}. Never throws.
 */
const { safeJson } = require('../zoom/safe-json');

module.exports = { safeJson };

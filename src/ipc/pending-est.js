'use strict';
/**
 * ipc/pending-est.js — team-wide Pending Estimates (read-only).
 *
 *   pending-est:get   -> last stored scan (instant), cached:true
 *   pending-est:scan  -> scanTeamPending({ force }) (throttled 15 min, single-flight)
 *
 * Backed by src/scrapers/pending_est_sources.js. No write path here: escalation
 * and comment writes stay on relay:escalate / relay:add-comment -> write-gate.
 */
const store   = require('../store');
const logger  = require('../utils/logger')('ipc:pending-est');
const { handle } = require('./_safe');
const sources = require('../scrapers/pending_est_sources');

const EMPTY = () => ({ ok: true, asOf: null, rows: [], excludedDtna: 0, counts: {}, cached: true });

function _fleetRows(ctx) {
  if (ctx && ctx.lastData && Array.isArray(ctx.lastData.rows) && ctx.lastData.rows.length) return ctx.lastData.rows;
  const fd = store.load('fleetData', {}) || {};
  return Array.isArray(fd.rows) ? fd.rows : [];
}

function registerPendingEstIPC(ctx) {
  handle('pending-est:get', () => {
    const last = sources.getLastScan();
    return last ? Object.assign(last, { cached: true }) : EMPTY();
  });

  handle('pending-est:scan', (_e, opts) => sources.scanTeamPending(
    { force: !!(opts && opts.force) },
    { fleetRows: () => _fleetRows(ctx) },
  ));

  logger.info('Pending Estimates IPC handlers registered');
}

module.exports = { registerPendingEstIPC };

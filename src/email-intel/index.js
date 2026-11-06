'use strict';
/**
 * email-intel/index.js — entry point of the Email Triage Intelligence module.
 *
 * Phase 0 skeleton: these are inert stubs so the hooks in email_triage.js have
 * a module to require once the flags are true. With the flags OFF nothing
 * requires this file. Later phases replace the bodies (Phase A: capture and the
 * real scan orchestration, Phase G: supervision) without changing the exports.
 *
 *   engaged()                      effective.capture (the master gate)
 *   runIntelScan(opts, trigger)    trigger: 'manual' | 'scheduled' (chat counts as manual)
 *   scheduledTick(ctx, cfg, deps)  supervisor / legacy timer entry
 *   getStatus()                    read-only status
 */
const flags = require('./flags');

function engaged() {
  try { return flags.engaged(); } catch (_) { return false; }
}

/**
 * Skeleton: scans nothing and writes nothing. It resolves to the already stored
 * legacy results so a caller never sees a different result shape.
 */
async function runIntelScan(_opts, _trigger) {
  return require('../scrapers/email_triage').loadResults();
}

/** Skeleton: reports a skip (the supervisor treats `skipped` results as non-failures). */
async function scheduledTick(_ctx, _cfg, _deps) {
  return { skipped: 'not-implemented' };
}

function getStatus() {
  return { phase: 0, engaged: engaged(), flags: flags.get().effective };
}

module.exports = { engaged, runIntelScan, scheduledTick, getStatus };

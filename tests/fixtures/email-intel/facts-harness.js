// tests/fixtures/email-intel/facts-harness.js — temp data dir + flags for Phase C (timeline writer, staging,
// bootstrap) tests. Uses the REAL store, email_actions.applyUnitTimelineUpdate and ipc/notes.cleanTimeline.
// No Outlook, no AI, no network.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fleetData } from './fleet.js';
const require = createRequire(import.meta.url);

export const PHASE_C = Object.freeze({ enabled: true, capture: true, multiRecipient: true, actionsView: true, timelineWrites: true });

export function factsWorld(flagsIn = PHASE_C, o = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ei-facts-'));
  require('../../../src/config/paths').setDataDir(tmp);
  const flags = require('../../../src/email-intel/flags');
  flags._setForTests(flagsIn);
  const store = require('../../../src/store');
  store.save('fleetData', fleetData('fresh', o.now || Date.now()));
  return {
    tmp, flags, store,
    stores: require('../../../src/email-intel/stores'),
    timeline: (unit) => String(((store.load('notesStore', {}) || {})[unit] || {}).timeline || ''),
    cleanup() { flags._setForTests(null); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* tmp */ } },
  };
}

/** A validated v2 fact as analyze.js leaves it (effectiveConfidence decorated). */
export function vfact(o = {}) {
  return Object.assign({
    kind: 'parts_eta', item: 'turbo', value: 'Turbo ETA 11/12', state: 'eta_given', date: '2026-11-12', dateInvalid: false, amount: null, amountUnverified: false,
    assertion: 'stated', evidence: 'Turbo ETA 11/12 for 40123', evidenceAt: 0, unitAttribution: 'strong', noteConflictHint: false,
    confidence: 0.9, confidenceValid: true, effectiveConfidence: 0.9, caps: [],
  }, o);
}

// tests/fixtures/email-intel/phase-c.js — runIntelScan-level harness for Phase C (timeline writes, staging,
// opt-outs, acceptance cases). The reader is injected (captures go straight to onBatch, no OWA), the
// isolated lane is a scripted relay that answers from a rule table, and the store is a temp data dir.
// Real: identity, ledger, analysis, validation, confidence, reconcile, the timeline writer,
// email_actions.applyUnitTimelineUpdate and ipc/notes.cleanTimeline. No Outlook, no network, no model.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { capOf, scriptedRelay } from './records.js';
import { fleetData, ME } from './fleet.js';
import { mk } from './emails.js';
const require = createRequire(import.meta.url);

export const T0 = Date.parse('2026-11-04T20:00:00.000Z');
export const PHASE_C = Object.freeze({ enabled: true, capture: true, multiRecipient: true, actionsView: true, timelineWrites: true });
export const localIso = (...a) => new Date(...a).toISOString();

/** fact(over) -> a v2 fact the scripted lane returns (evidence must be an exact quote of the email). */
export function fact(o = {}) {
  return Object.assign({ kind: 'parts_eta', item: 'turbo', value: 'Turbo ETA 11/12', state: 'eta_given', date: '2026-11-12', assertion: 'stated', evidence: 'Turbo ETA 11/12 for 40123', noteConflictHint: false, confidence: 0.9 }, o);
}

function emailText(prompt) {
  const m = /<<<UNTRUSTED_EMAIL id=[0-9a-f]+>>>\n([\s\S]*?)\n<<<END_UNTRUSTED_EMAIL/.exec(prompt);
  return m ? m[1] : '';
}

/** fakeReader(caps) -> a readMailbox stand-in that commits the captures through onBatch and reports a complete read. */
export function fakeReader(caps) {
  return async (o) => {
    const items = caps.map((c) => ({ rowKey: 'row-' + c.itemId, rowSig: 'sig-' + c.itemId, captures: [c] }));
    if (items.length) await o.onBatch('Inbox', items);
    return {
      ok: true, authBlocked: false, aborted: false, timedOut: false, opened: items.length, rowsExamined: items.length,
      folders: [{ folder: 'Inbox', status: 'ok', requested: items.length, examined: items.length, opened: items.length, ingested: items.length, skippedKnown: 0, caughtUp: true, backlog: false, backlogRemaining: 0, retried: 0 }],
    };
  };
}

export function phaseCWorld(flagsIn = PHASE_C, o = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ei-phc-'));
  require('../../../src/config/paths').setDataDir(tmp);
  const flags = require('../../../src/email-intel/flags');
  flags._setForTests(flagsIn);
  require('../../../src/email-intel/reliability/lock')._reset();
  const lane = require('../../../src/email-intel/understand/lane');
  lane._resetForTests();
  const store = require('../../../src/store');
  const stores = require('../../../src/email-intel/stores');
  const idx = require('../../../src/email-intel/index');
  store.save('fleetData', fleetData('fresh', Date.now()));
  stores.save('config', Object.assign(stores.defaults('config'), { me: Object.assign({ fasName: '' }, JSON.parse(JSON.stringify(o.me || ME))) }));
  if (o.triageConfig) store.save('emailTriageConfig', Object.assign({}, require('../../../src/scrapers/email_triage').DEFAULT_CONFIG, o.triageConfig));
  const w = {
    tmp, flags, store, stores, idx, lane, rules: [], questions: [], answers: [],
    /** the lane answers with every rule fact whose evidence is quoted in the EMAIL fence of the prompt */
    answer(prompt) {
      const text = emailText(prompt);
      const units = new Map();
      for (const r of w.rules) {
        if (!text.includes(r.fact.evidence)) continue;
        if (!units.has(r.unit)) units.set(r.unit, []);
        units.get(r.unit).push(r.fact);
      }
      const questions = w.questions.filter((q) => text.includes(q.when)).map((q) => q.q);
      // FEAT-005: answers to the PRIOR OPEN QUESTIONS the app put in the prompt (rule: { when, evidence, confidence })
      const prior = (() => { const m = /PRIOR OPEN QUESTIONS[^\n]*\n(\[.*\])/.exec(prompt); try { return m ? JSON.parse(m[1]) : []; } catch (_) { return []; } })();
      const answers = [];
      for (const a of w.answers) if (text.includes(a.when)) for (const p of prior) answers.push({ pqid: p.pqid, evidence: a.evidence, confidence: a.confidence == null ? 0.9 : a.confidence });
      return {
        schemaVersion: 2, messageRef: '$REF', relevance: { level: units.size ? 'high' : 'low', reason: 'unit update', confidence: 0.9 },
        units: Array.from(units.entries()).map(([unit, facts]) => ({ unit, gist: 'update', facts })),
        questions, requests: [], answers, commitments: [],
        classification: { category: 'fleet_status_update', intent: questions.length ? 'request_information' : 'provide_update', informationalOnly: !questions.length, confidence: 0.9 },
        suggestDelete: { suggested: false, reason: '', confidence: 0.9 }, overallConfidence: 0.9,
      };
    },
    relay: null,
    cap: (m, over) => capOf(mk(m), over),
    scan(caps, opts) { return idx.runIntelScan(Object.assign({ _now: T0, folders: ['Inbox'], _readMailbox: fakeReader(caps || []) }, opts || {}), 'manual'); },
    timeline: (unit) => String(((store.load('notesStore', {}) || {})[unit] || {}).timeline || ''),
    lines: (unit) => w.timeline(unit).split('\n').filter(Boolean),
    ledger: () => Object.values(stores.load('ledger').entries || {}),
    staged: () => Object.values(stores.load('staged').items || {}),
    messages: () => stores.load('messages').messages,
    actions: () => Object.values(stores.load('actions').items || {}),
    open: (category) => Object.values(stores.load('actions').items || {}).filter((x) => x.state === 'open' && (!category || x.category === category)),
    cleanup() { flags._setForTests(null); lane._resetForTests(); require('../../../src/email-intel/reliability/lock')._reset(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* tmp */ } },
  };
  w.relay = scriptedRelay((prompt) => w.answer(prompt));
  lane._setRelayForTests(w.relay);
  return w;
}

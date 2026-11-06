// tests/email-intel-parity.test.js — flag-OFF parity (case N, design 12.3) against
// tests/fixtures/email-intel-baseline.json, captured ONCE at the export-only overlay
// commit (F2-02) before any other source edit. With every flag OFF the legacy email
// triage must behave and persist byte-identically to base commit 50419ba.
//
// The baseline file is never regenerated. Allowed intentional differences are
// asserted explicitly: the F-09 `uncertain` overlay branch (N13) and, in FEAT-008,
// the single additive types.emailTriage jobs entry (N14).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import * as fx from './fixtures/email-intel-fixture.js';
const require = createRequire(import.meta.url);

const baseline = JSON.parse(fs.readFileSync(path.join(fx.ROOT, 'tests/fixtures/email-intel-baseline.json'), 'utf8'));
const flags = require('../src/email-intel/flags');
const OVERLAY = 'renderer/src/js/components/email-triage-overlay.js';
const toCrlf = (s) => s.replace(/\r?\n/g, '\r\n');
const toLf = (s) => s.replace(/\r\n/g, '\n');

let cur;
beforeAll(async () => {
  flags._setForTests(null);
  cur = await fx.captureAll();
}, 120000);
afterAll(() => { flags._setForTests(null); });

describe('N1-N11 flag-OFF parity against the base-commit golden', () => {
  it('N1 buildTriagePrompt exact strings (learning empty and non-empty)', () => { expect(cur.N1).toEqual(baseline.N1); });
  it('N2 _mergeVerdict / _fallbackVerdict / _buildDecision incl. missing, string and out-of-range confidence', () => { expect(cur.N2).toEqual(baseline.N2); });
  it('N3 runTriage persisted emailTriageResults: first scan, rescan same ids, changed content, window slide', () => { expect(cur.N3).toEqual(baseline.N3); });
  it('N4 applyPendingUnitUpdates: notesStore, repairTimeline, emailEvidence, repairHistory and gate outcomes', () => { expect(cur.N4).toEqual(baseline.N4); });
  it('F2-01 flags OFF: legacy applyPendingUnitUpdates gate honors autoApplyUnitUpdates false and true exactly as baseline', () => {
    for (const site of ['ipcRun', 'autoTick']) {
      expect(cur.N4.gate['autoApplyFalse_' + site]).toEqual(baseline.N4.gate['autoApplyFalse_' + site]);
      expect(cur.N4.gate['autoApplyTrue_' + site]).toEqual(baseline.N4.gate['autoApplyTrue_' + site]);
    }
    // The baseline itself documents both outcomes: false writes only the results file, true also writes notes/timeline/history.
    expect(baseline.N4.gate.autoApplyFalse_ipcRun.writes.saves).toEqual(['emailTriageResults']);
    expect(baseline.N4.gate.autoApplyTrue_ipcRun.writes.saves).toContain('notesStore');
    expect(baseline.N4.gate.autoApplyTrue_ipcRun.writes.saves).toContain('repairHistory');
  });
  it('N5 owa_reader behavior goldens (aria parsing, normalize, scripts, readInbox folder loop incl. starvation)', () => {
    const { pins: _a, ...rest } = cur.N5; const { pins: _b, ...baseRest } = baseline.N5;
    expect(rest).toEqual(baseRest);
    expect(cur.N5.readInbox.starvation.folderClicks).toEqual([]);   // a busy first folder starves the others at base
  });
  it('N5 (F-10) owa_reader.js content hash and the three page-script sources are unchanged', () => {
    const file = fs.readFileSync(path.join(fx.ROOT, 'src/scrapers/owa_reader.js'), 'utf8');
    // The baseline was hashed on a CRLF working copy; compare line-ending independent.
    expect(crypto.createHash('sha256').update(toCrlf(file)).digest('hex')).toBe(baseline.N5.pins.sha256);
    const pins = fx.owaReaderPins();
    for (const name of Object.keys(baseline.N5.pins.functions)) {
      expect(toLf(pins.functions[name])).toBe(toLf(baseline.N5.pins.functions[name]));
    }
  });
  it('N6 sendReply arguments and result mapping into a stubbed sendViaOwa', () => { expect(cur.N6.actions).toEqual(baseline.N6.actions); });
  it('N7 registerEmailTriageIPC channel list is unchanged', () => { expect(cur.N7).toEqual(baseline.N7); });
  it('N7 every emailIntel:* channel is registered, returns { ok:true, enabled:false } and creates no files', async () => {
    fx.installStubs(); fx.resetWorld({}); fx.rec.handlers = {};
    flags._setForTests(null);
    const ipc = require('../src/ipc/email-intel');
    ipc.registerEmailIntelIPC({});
    const channels = Object.keys(ipc.GATES);
    expect(channels).toHaveLength(16);
    for (const ch of channels) expect(typeof fx.rec.handlers[ch]).toBe('function');
    for (const ch of channels) {
      const args = ch === 'emailIntel:prepare-action' ? ['send-reply', { conversationKey: 'cv_0123456789abcdef' }]
        : ch === 'emailIntel:confirm-action' ? ['0'.repeat(32)] : [];
      expect(await fx.rec.handlers[ch]({}, ...args)).toEqual({ ok: true, enabled: false });
    }
    expect(fx.rec.saves).toEqual([]);
  });
  it('N8 window.emailTriage bridge key list is unchanged', () => { expect(cur.N8).toEqual(baseline.N8); });
  it('F2-02 N9 overlay golden: _cardHtml/_replyButtonHtml/_replyPanelHtml match baseline for every legacy replyState', () => {
    expect(Object.keys(cur.N9).length).toBeGreaterThan(40);
    expect(cur.N9).toEqual(baseline.N9);
  });
  it('F2-02 baseline provenance: capturedAtCommit recorded, overlay diff vs 50419ba at capture is exactly one added export line', () => {
    expect(baseline.meta.baseCommit).toBe('50419ba');
    expect(baseline.meta.capturedAtCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(baseline.meta.overlayNumstat).toBe('1\t0\t' + OVERLAY);
    expect(baseline.meta.sourceTreeDirtyAtCapture).toBe('');
  });
  it('N10 data files written by scan, delete flow, auto-tick and config are the legacy ones only (no email_intel_*, no sqlite)', () => {
    expect(cur.N10).toEqual(baseline.N10);
    for (const k of baseline.N10.dataFilesWritten) expect(k.startsWith('emailIntel')).toBe(false);
  });
  it('N11 supervisor.claim spec and getAutoScanStatus key set are unchanged', () => { expect(cur.N11).toEqual(baseline.N11); });
});

describe('F2-03 N6b legacy send-reply byte-identical when threadReplies is not effective (all flags OFF; capture only; threadReplies set without capture)', () => {
  const variants = {
    'all flags OFF': null,
    'capture only': { enabled: true, capture: true },
    'threadReplies set without capture': { enabled: true, threadReplies: true },
    'threadReplies set without multiRecipient': { enabled: true, capture: true, threadReplies: true },
  };
  for (const [name, f] of Object.entries(variants)) {
    it(name + ': sendReply arguments, result mapping and the emailTriageResults patch match baseline', async () => {
      flags._setForTests(f);
      try {
        const out = await fx.captureN6();
        expect(out).toEqual(baseline.N6);
      } finally { flags._setForTests(null); }
    });
  }
});

describe('N12 hooks behave as OFF when the flags module cannot answer', () => {
  it('a throwing flags module leaves every legacy output identical to the baseline', async () => {
    const p = require.resolve('../src/email-intel/flags');
    const saved = require.cache[p];
    const boom = () => { throw new Error('flags unavailable'); };
    require.cache[p] = { id: p, filename: p, loaded: true, exports: { get: boom, engaged: boom, _setForTests: () => {} } };
    try {
      const out = await fx.captureAll();
      const { pins: _a, ...rest } = out.N5; const { pins: _b, ...baseRest } = baseline.N5;
      expect(out.N1).toEqual(baseline.N1);
      expect(out.N3).toEqual(baseline.N3);
      expect(out.N4).toEqual(baseline.N4);
      expect(rest).toEqual(baseRest);
      expect(out.N6).toEqual(baseline.N6);
      expect(out.N7).toEqual(baseline.N7);
      expect(out.N9).toEqual(baseline.N9);
      expect(out.N10).toEqual(baseline.N10);
      expect(out.N11).toEqual(baseline.N11);
    } finally {
      if (saved) require.cache[p] = saved; else delete require.cache[p];
    }
  }, 120000);
  it('a throwing settings load, or junk env values, resolve to all flags OFF', () => {
    const pf = require('../src/config/perf-flags');
    const off = pf.loadEmailIntel({ load: () => { throw new Error('io'); }, env: {} });
    expect(off.effective).toEqual({ capture: false, multiRecipient: false, timelineWrites: false, actionsView: false, threadReplies: false, attachments: false });
    const junk = pf.loadEmailIntel({ load: () => ({}), env: { FLEET_EMAIL_INTEL: 'yes', FLEET_EMAIL_INTEL_CAPTURE: 'true', FLEET_EMAIL_INTEL_MULTI: '2' } });
    expect(junk.enabled).toBe(false);
    expect(junk.effective.capture).toBe(false);
  });
});

describe('N13 rollback: records written by a flagged build are handled with all flags OFF', () => {
  const uncertain = { id: 'em_u', from: 'dealer@example.test', fromName: 'Dealer', subject: 'Unit 40123 ETA', summary: 's', importance: 'normal', replyState: 'uncertain', replyDraft: 'sent text', intel: { conversationKey: 'cv_0123456789abcdef', version: 1 }, triagedAt: '2026-11-04T15:04:05.000Z', unitRefs: [] };
  it('F-09 a replyState:uncertain record renders the non-actionable text and no Reply button, flags OFF', () => {
    const { _cardHtml, _replyButtonHtml, _replyPanelHtml } = fx.overlayFns;
    expect(_replyButtonHtml(uncertain)).toBe('<span class="et-uncertain" role="status">Reply status uncertain - check Outlook</span>');
    const card = _cardHtml(uncertain);
    expect(card).toContain('Reply status uncertain - check Outlook');
    expect(card).not.toContain('data-reply=');
    expect(card).not.toContain('Reply sent');
    expect(_replyPanelHtml(uncertain)).toBe('');
  });
  it('F-09 legacy states still render exactly as at base (the only new overlay output is for uncertain)', () => {
    const { _replyButtonHtml } = fx.overlayFns;
    for (const st of ['none', 'drafted', 'sent', 'dismissed']) {
      expect(_replyButtonHtml({ id: 'em_a6', replyState: st })).toBe(baseline.N9[st + '|plain|plain'].button);
    }
  });
  it('legacy _mergeResults, handlers and renderers accept records carrying an intel field', async () => {
    fx.installStubs();
    fx.resetWorld({ fleetData: { rows: fx.FLEET_ROWS }, emailTriageResults: { emails: [uncertain, { ...uncertain, id: 'em_i2', replyState: 'none', deleteSuggested: true, convId: 'c2=' }], ranAt: 'x', authBlocked: false } });
    const { triage } = fx.freshLegacy();
    fx.freshIpc();
    try {
      const merged = triage._mergeResults(triage.loadResults(), [{ ...uncertain, intel: undefined, replyState: undefined, id: 'em_u' }], {});
      expect(merged.emails.find((e) => e.id === 'em_u').replyState).toBe('uncertain');   // user engagement is preserved
      expect(merged.emails.find((e) => e.id === 'em_u').intel).toBeUndefined();            // fresh record replaced; legacy never reads intel
      expect(await fx.call('emailTriage:dismiss-reply', 'em_u')).toEqual({ ok: true });
      expect(await fx.call('emailTriage:keep', 'em_i2')).toEqual({ ok: true });
      expect(fx.doc('emailTriageResults').emails.find((e) => e.id === 'em_i2').intel).toEqual(uncertain.intel);
      expect(triage.applyPendingUnitUpdates(triage.loadResults())).toBe(0);
    } finally { triage.stopAutoScan(); }
  });
});

describe('N14 jobs status with all flags OFF', () => {
  it('matches the baseline (FEAT-008 adds only the single inert types.emailTriage entry)', () => {
    // NFR-12: the only difference is the new job type itself (its inert summary entry, its slot in the
    // type list, its env name and its default-false flag). Everything else is the base document.
    const expected = JSON.parse(JSON.stringify(baseline.N14));
    expected.summary.types.emailTriage = { flag: false, effective: false, adopted: true, mode: 'off' };
    expected.jobTypes = expected.jobTypes.concat(['emailTriage']);
    expected.jobEnv.emailTriage = 'FLEET_JOBS_EMAIL_TRIAGE';
    expected.resolveJobsDefault.types.emailTriage = false;
    expect(cur.N14).toEqual(expected);
    const added = Object.keys(cur.N14.summary.types).filter((k) => !(k in baseline.N14.summary.types));
    expect(added).toEqual(['emailTriage']);
    expect(cur.N14.init).toEqual(baseline.N14.init);
    expect(cur.N14.status).toEqual(baseline.N14.status);
  });
});

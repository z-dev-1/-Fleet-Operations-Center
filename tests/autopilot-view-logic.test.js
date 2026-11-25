// tests/autopilot-view-logic.test.js — fleet-autopilot §B12.2 renderer: pure helpers in
// views/autopilot-logic.js (reason sentences, state badges, evidence row model, supervisor banner
// incl. R13, live-reads text, unitsNotInFleet R14, re-check label) and the view in a fake DOM
// (no jsdom in the repo): an <img onerror=…> evidence value is set as textContent (AC-20).
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createExtDom, createBus, ExtElement } from './fixtures/zoom/fake-dom-ext.js';

// bridge.js reads window.app.platform at import time (toolbar.js imports bridge.js).
if (typeof globalThis.window === 'undefined') globalThis.window = { app: { platform: 'win32' } };
ExtElement.prototype.replaceChildren = function replaceChildren() { this.children = []; };

const L = await import('../renderer/src/js/views/autopilot-logic.js');
const view = await import('../renderer/src/js/views/autopilot.js');
const apiMod = await import('../renderer/src/js/views/autopilot-api.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const XSS = '<img src=x onerror="alert(1)">';
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function walk(n, out = []) {
  for (const c of (n && n.children) || []) { out.push(c); walk(c, out); }
  return out;
}

describe('autopilot-logic helpers', () => {
  it('reason sentences cover every detection reason code; unknown codes stay readable', () => {
    for (const code of ['OOS', 'DWELL_EXCEEDED', 'LONG_DWELL_LISTED', 'ETA_OVERDUE_VERIFIED', 'ETA_PAST_UNVERIFIED', 'ETA_NOT_PROVIDED',
      'UPDATE_STALE', 'ANNOTATION_STALE', 'WAITING_PARTS', 'WAITING_ESTIMATE_APPROVAL', 'AWAITING_SCHEDULING', 'STATUS_CONFLICT',
      'REPAIRED_UNVERIFIED', 'RECURRING_DEFECT', 'DOWN_SINCE_UNKNOWN']) {
      expect(L.reasonSentence(code)).not.toMatch(/^Reason code/);
    }
    expect(L.reasonSentence('X_NEW')).toBe('Reason code: X_NEW');
  });

  it('state badges for all twelve states', () => {
    expect(Object.keys(L.STATE_BADGES).length).toBe(12);
    expect(L.stateBadge('NEEDS_REVIEW')).toEqual({ label: 'Needs review', tone: 'action', className: 'ap-badge ap-badge--action' });
    expect(L.stateBadge('???').tone).toBe('mute');
  });

  it('event sentences: transitions, eta_due, aborts and unknown codes', () => {
    expect(L.eventSentence({ kind: 'transition', to_state: 'RESOLVED', reason_code: 'resolved' })).toBe('Moved to Resolved. AAP shows the unit Active on a newer API build.');
    expect(L.eventSentence({ kind: 'transition', to_state: 'QUEUED', reason_code: 'eta_due:2026-11-20' })).toBe('The ETC date 2026-11-20 arrived.');
    expect(L.eventSentence({ kind: 'control', reason_code: 'aborted:master_pause' })).toMatch(/Paused by the Pause control/);
    expect(L.eventSentence({ kind: 'unchanged', reason_code: 'evidence_unchanged' })).toMatch(/conclusion was kept/);
    expect(L.eventSentence({ kind: 'x', reason_code: 'zzz' })).toBe('Reason code: zzz');
  });

  it('evidence row model keeps an XSS value as a plain string and flags conflicts', () => {
    const rows = L.evidenceRows([
      { evidence_id: 'ev_a', source: 'email', field: 'note', value_text: XSS, observed_at: null, retrieved_at: Date.UTC(2026, 10, 20, 12), freshness: 'UNKNOWN', confidence: 0.5, trust: 'untrusted_text', authority_tag: 'notes/email', conflict_group: null },
      { evidence_id: 'ev_b', source: 'decisiv', field: 'stage', value_text: 'ready', observed_at: 1, retrieved_at: 2, freshness: 'RECENT', confidence: 0.9, trust: 'structured', authority_tag: 'decisiv', conflict_group: 'cf_status' },
      { evidence_id: 'ev_c', source: 'aap_cache', field: 'lifecycleState', value_text: 'Unavailable', retrieved_at: 2, freshness: 'RECENT', confidence: 0.9, trust: 'structured' },
    ], { cf_status: ['ev_b', 'ev_c'] });
    expect(rows[0].value).toBe(XSS);
    expect(typeof rows[0].value).toBe('string');
    expect(rows[0]).toMatchObject({ trust: 'untrusted text', observed: '—', conflict: false, confidence: '0.50' });
    expect(rows[1].conflict).toBe(true);
    expect(rows[2].conflict).toBe(true);
  });

  it('supervisor banner: shown only when master ON and the supervisor is off; R13 env override disables the button', () => {
    expect(L.supervisorBanner({ enabled: false, supervisorEnabled: false })).toBe(null);
    expect(L.supervisorBanner({ enabled: true, supervisorEnabled: true })).toBe(null);
    expect(L.supervisorBanner({ enabled: true, supervisorEnabled: false, supervisorEnvOverride: null })).toEqual({
      text: 'Autopilot runs under the worker supervisor, which is off. Enable it and restart the app to start Autopilot.',
      buttonLabel: 'Enable supervisor (restart required)', buttonDisabled: false,
    });
    expect(L.supervisorBanner({ enabled: true, supervisorEnabled: false, supervisorEnvOverride: '0' })).toMatchObject({
      text: 'Supervisor disabled by the FLEET_WORKERS environment variable', buttonDisabled: true,
    });
    expect(L.supervisorBanner({ enabled: true, supervisorEnabled: false }, { restartPending: true }).text).toBe('Restart the app to start Autopilot');
  });

  it('run buttons: Run now and Run harness are disabled with the supervisor off; harness disabled after it ran today', () => {
    expect(L.runButtons({ enabled: true, supervisorEnabled: false, runState: 'running' })).toMatchObject({ runNowDisabled: true, harnessDisabled: true });
    expect(L.runButtons({ enabled: true, supervisorEnabled: true, runState: 'running' })).toMatchObject({ runNowDisabled: false, harnessDisabled: false });
    expect(L.runButtons({ enabled: true, supervisorEnabled: true, runState: 'running', harnessRanToday: true })).toMatchObject({ runNowDisabled: false, harnessDisabled: true, harnessHint: 'The harness already ran today.' });
    expect(L.runButtons({ enabled: true, supervisorEnabled: true, runState: 'paused' }).runNowDisabled).toBe(true);
  });

  it('live-reads text cites approval item 5 with the D-1 scope and the V2 warm-only tool reads', () => {
    expect(L.LIVE_READS_TEXT).toMatch(/approval item 5/);
    expect(L.LIVE_READS_TEXT).toMatch(/AAP getService and Decisiv case status\/activity, only on an already-open session \(warm-only\)/);
    expect(L.LIVE_READS_TEXT).toMatch(/tools read the cache first and make at most one warm-only live read per source per run/);
    expect(L.LIVE_READS_TEXT).toMatch(/DTNA and Aperia use cached data/);
    expect(L.LOCKED_WRITE_TEXT).toBe('Not available in V2 (shadow mode)');
  });

  it('unitsNotInFleet list and text (R14)', () => {
    expect(L.unitsNotInFleet({ scope: { unitsNotInFleet: ['IND260261', '9010424'] } })).toEqual(['IND260261', '9010424']);
    expect(L.unitsNotInFleetText({ scope: { unitsNotInFleet: ['IND260261'] } })).toBe('Listed units with no AAP fleet row: IND260261');
    expect(L.unitsNotInFleetText({})).toBe('');
  });

  it('re-check label is a schedule hint, never a deadline; empty for RESOLVED / PAUSED', () => {
    const t = new Date(2026, 10, 20, 9, 5).getTime();
    expect(L.recheckLabel({ state: 'MONITORING', next_review_at: t, next_attempt_at: null })).toBe('Autopilot will re-check by 2026-11-20 09:05');
    expect(L.recheckLabel({ state: 'WAITING_FOR_DATA', next_review_at: t + 1e7, next_attempt_at: t })).toBe('Autopilot will re-check by 2026-11-20 09:05');
    expect(L.recheckLabel({ state: 'RESOLVED', next_review_at: t })).toBe('');
    expect(L.recheckLabel({ state: 'PAUSED', next_review_at: t })).toBe('');
    expect(L.recheckLabel({ state: 'QUEUED' })).toBe('');
  });

  it('findings sections, review buttons, all-units confirm, unit parsing', () => {
    const s = L.findingsSections({ confirmedFacts: [{ statement: XSS }], actionsRequiringApproval: [{ action: 'Ask vendor', rationale: 'r', owner: 'fleet' }] });
    expect(s.map((x) => x.title)).toEqual(['Confirmed facts', 'Evidence-based inferences', 'Missing information', 'Recommended actions', 'Actions requiring approval']);
    expect(s[0].items).toEqual([XSS]);
    expect(s[4]).toMatchObject({ items: ['Ask vendor — r (owner: fleet)'], badge: 'Requires approval — not executed in V1' });
    expect(L.reviewButtons('RECOMMENDATION_READY')).toEqual({ acknowledge: true, accept: false, rerun: true });
    expect(L.reviewButtons('NEEDS_REVIEW')).toEqual({ acknowledge: false, accept: true, rerun: true });
    expect(L.reviewButtons('INVESTIGATING').rerun).toBe(false);
    expect(L.allUnitsConfirmText(33)).toMatch(/33 units in scope/);
    expect(L.parseUnits(' b13014, 322283\n322283 ;x1')).toEqual(['B13014', '322283', 'X1']);
  });

  it('the logic module touches no DOM, window or IPC', () => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'src', 'js', 'views', 'autopilot-logic.js'), 'utf8');
    expect(src).not.toMatch(/\b(document|window|ipcRenderer|innerHTML)\b/);
    expect(src).not.toMatch(/^import /m);
  });
});

describe('V2 logic (§10.3, AC-27, AC-28, AC-37)', () => {
  const PASS = {
    fleet_rows: 25, duplicate_rows: 2, invalid_rows: 3, eligible: 9, excluded_trailer: 4, excluded_hostler: 4, excluded_unsupported: 1,
    type_unknown: 1, type_conflict: 1, down_eligible: 6, case_open: 5, below_threshold: 1, out_of_filter: 0, feature_off: 0,
    by_domicile: { ABE40: { eligible: 2 }, '(none)': { eligible: 1 }, roc5: { eligible: 1 } }, by_operator: { TUZR: {}, KNXP: {}, '(other)': {} },
    tokensWithoutRows: [],
  };
  const COV = {
    ok: true, pass: PASS, reconcileOk: true,
    groups: { detectedHeld: 0, queued: 3, active: 1, scheduled: 1, waiting: 0, review: 1, deferredAi: 2, paused: 0, failed: 0 },
    queue: { oldestQueuedAgeMs: 3 * 3600000 + 5 * 60000, queueCoveragePct: 60, processingRatePerHour: 1.5 },
    ai: { callsToday: 7, cap: 48, p50Ms: 1200, p95Ms: 4000, failureRate: 0.125, notYetAi: 4, noAiConclusion: 2 },
    sources: { aap_live: { ok: 3, not_warm: 1, auth: 0, cache_only: 2, rate_limited: 0 } },
  };

  it('coverage tile model: pass counts, groups, queue, AI and the clickable tiles', () => {
    const tiles = L.coverageTiles(COV);
    const by = Object.fromEntries(tiles.map((t) => [t.key, t]));
    expect(by.eligible).toMatchObject({ label: 'Power units monitored', value: '9' });
    expect(by.down_eligible).toMatchObject({ label: 'OOS detected', value: '6' });
    expect(by.case_open.value).toBe('5');
    expect(by.queued.value).toBe('3');
    expect(by.type_unknown).toMatchObject({ value: '1', link: { view: 'units', filter: { coverage: 'type_unknown' } } });
    expect(by.type_conflict.link).toEqual({ view: 'units', filter: { coverage: 'type_conflict' } });
    expect(by.notYetAi).toMatchObject({ value: '4', link: { view: 'cases', filter: { aiPending: true } } });
    expect(by.oldestQueued.value).toBe('3 h 5 min');
    expect(by.queueCoveragePct.value).toBe('60%');
    expect(by.processingRatePerHour.value).toBe('1.5');
    expect(by.aiToday.value).toBe('7 / 48');
    expect(by.aiLatency.value).toBe('1200 / 4000 ms');
    expect(by.aiFailureRate.value).toBe('13%');
    expect(by.noAiConclusion.value).toBe('2');
    for (const t of tiles) expect(typeof t.value).toBe('string');
    expect(L.coverageTiles({ ok: true, enabled: false })).toEqual([]);
    expect(L.coverageTiles(null)).toEqual([]);
    expect(L.sourceRows(COV, { aap_live: 'HEALTHY' })).toEqual([{ source: 'aap_live', ok: '3', not_warm: '1', auth: '0', cache_only: '2', rate_limited: '0', authState: 'HEALTHY' }]);
  });

  it('reconcile (red) and authorized-scope (amber) banners', () => {
    expect(L.reconcileBanner(COV)).toBe(null);
    const bad = Object.assign({}, COV, { reconcileOk: false, pass: Object.assign({}, PASS, { eligible: 8, case_open: 3 }) });
    expect(L.reconcileBanner(bad)).toMatchObject({ tone: 'bad', rowsDiff: 1, downDiff: 2 });
    expect(L.reconcileBanner(bad).text).toMatch(/by 1, and down power units differ from the coverage buckets by 2/);
    expect(L.scopeBanner(COV)).toBe(null);
    expect(L.scopeBanner(Object.assign({}, COV, { pass: Object.assign({}, PASS, { tokensWithoutRows: ['ZZZ9', 'QQQ1'] }) })))
      .toEqual({ tone: 'warn', text: 'Authorized scope tokens with no synced units: ZZZ9, QQQ1' });
  });

  it('filter model and cases query: dropdown values from the pass groups; empty values dropped; state wins over group', () => {
    const fm = L.filterModel(COV);
    expect(fm.domicileOptions).toEqual(['ABE40', 'ROC5']);
    expect(fm.scacOptions).toEqual(['KNXP', 'TUZR']);
    expect(fm.groups.map((g) => g[0])).toEqual(['queued', 'reasoning', 'monitoring', 'waiting', 'review', 'resolved', 'paused', 'failed']);
    expect(L.filterModel(null).domicileOptions).toEqual([]);
    expect(L.casesQuery({ state: '', group: 'waiting', carrier: ' TUZR ', downtimeMin: '3', downtimeMax: '', priorityMin: '50', aiPending: true, tier: 'complex', sort: 'downtime' }, { limit: 50, offset: 0 }))
      .toEqual({ group: 'waiting', carrier: 'TUZR', downtimeMin: 3, priorityMin: 50, aiPending: true, tier: 'complex', sort: 'downtime', limit: 50, offset: 0 });
    expect(L.casesQuery({ state: 'QUEUED', group: 'queued', priorityMin: '1.5', aiPending: false })).toEqual({ state: 'QUEUED' });
    expect(L.unitRow({ unit_id: 'UK600', eligibility: 'TYPE_UNKNOWN', coverage: 'type_unknown', reason: 'unknown equipment type', is_down: 1 }))
      .toMatchObject({ unit: 'UK600', coverage: 'type_unknown', reason: 'unknown equipment type', down: 'down', caseId: '' });
    expect(L.scopeFilterPatch({ domiciles: 'abe40, roc5\nABE40', carriers: 'Swift Leasing', scacs: 'tuzr', vendors: '', units: 'b13014' }))
      .toEqual({ scope: { filter: { domiciles: ['ABE40', 'ROC5'], carriers: ['Swift Leasing'], scacs: ['TUZR'], vendors: [], units: ['B13014'] } } });
  });

  const STEPS = [
    { step_id: 's1', run_id: 'r1', seq: 1, turn: 0, kind: 'tool', tool: 'existing_timeline', args_json: '{"unit":"322283"}', status: 'ok', code: null, why: 'preload', summary_json: JSON.stringify({ count: 1, evidenceIds: ['ev_t'], newestObservedAt: null, structured: [] }), live: 0, reused_step_id: null, ai_latency_ms: null, ai_lane: null, started_at: 1, ms: 3 },
    { step_id: 's2', run_id: 'r1', seq: 2, turn: 1, kind: 'model', tool: null, args_json: null, status: 'ok', code: null, why: null, summary_json: JSON.stringify({ decision: 'request_tools', tools: 2 }), live: 0, reused_step_id: null, ai_latency_ms: 900, ai_lane: 'isolated', started_at: 2, ms: 905 },
    { step_id: 's3', run_id: 'r1', seq: 3, turn: 1, kind: 'tool', tool: 'decisiv_activity', args_json: '{}', status: 'ok', code: null, why: 'check the stage ' + XSS, summary_json: JSON.stringify({ count: 2, evidenceIds: ['ev_s', 'ev_u'], newestObservedAt: Date.UTC(2026, 10, 20, 12), structured: [{ field: 'stage', value: 'x'.repeat(200) }] }), live: 1, reused_step_id: null, ai_latency_ms: null, ai_lane: null, started_at: 3, ms: 40 },
    { step_id: 's4', run_id: 'r1', seq: 4, turn: 2, kind: 'tool', tool: 'aap_comments', args_json: '{}', status: 'reused', code: null, why: 'again', summary_json: '{"count":0}', live: 0, reused_step_id: 's0', ai_latency_ms: null, ai_lane: null, started_at: 4, ms: 0 },
    { step_id: 's5', run_id: 'r1', seq: 5, turn: 3, kind: 'final', tool: null, args_json: null, status: 'final', code: null, why: null, summary_json: null, live: 0, reused_step_id: null, ai_latency_ms: null, ai_lane: null, started_at: 5, ms: 1 },
  ];
  const FIND = {
    ev_s: { evidence_id: 'ev_s', source: 'decisiv', field: 'stage', value_text: 'ready', trust: 'structured' },
    ev_u: { evidence_id: 'ev_u', source: 'decisiv', field: 'note', value_text: XSS, trust: 'untrusted_text' },
  };

  it('traceRows: no prompt / model-text field, collapsed untrusted text, markers, uncertain row for a conflict', () => {
    const output = { summary: 'Down at the dealer.', confirmedFacts: [{ statement: 'fact' }], missingInfo: [], conflicts: [{ field: 'repairStatus', note: 'cache says repair, live says ready', evidenceIds: ['ev_s'] }], nextReviewInHours: 12 };
    const rows = L.traceRows(STEPS, FIND, { case: { unit_id: '322283', state: 'MONITORING' }, output, memory: { openQuestions: [{ question: 'Is the turbo in?' }] } });
    expect(rows.map((r) => r.kind)).toEqual(['start', 'tool', 'model', 'tool', 'tool', 'final', 'final', 'uncertain']);
    const banned = /prompt|raw|reasoning|thought|model_text|modelText|response/i;
    for (const r of rows) for (const k of Object.keys(r)) expect(banned.test(k), k).toBe(false);
    expect(JSON.stringify(rows)).not.toMatch(/"prompt"/);
    const model = rows[2];
    expect(model).toMatchObject({ label: 'AI turn', summary: 'decision: request_tools · 2 tool requests', marker: 'lane isolated', ms: '900 ms', why: '' });
    const dec = rows[3];
    expect(dec).toMatchObject({ label: 'decisiv_activity', marker: 'live', turn: '1' });
    expect(dec.why).toContain(XSS);   // a plain string; the view sets it with textContent
    expect(dec.values[0].length).toBeLessThanOrEqual(80);
    expect(dec.chips[0]).toMatchObject({ evidenceId: 'ev_s', untrusted: false, value: 'stage: ready' });
    expect(dec.chips[1]).toMatchObject({ evidenceId: 'ev_u', untrusted: true, collapsed: 'decisiv · ' + XSS.length + ' chars', text: XSS });
    expect(dec.chips[1].collapsed).not.toContain('<');
    expect(rows[4]).toMatchObject({ marker: 'reused', status: { className: 'ap-badge ap-badge--mute' } });
    expect(rows[1].marker).toBe('cached');
    const fin = rows.find((r) => r.kind === 'final' && r.label === 'Conclusion');
    expect(fin).toMatchObject({ text: 'Down at the dealer.', nextReview: 'Next review in 12 h' });
    const unc = rows[rows.length - 1];
    expect(unc.items).toEqual(['Open question: Is the turbo in?', 'Conflict: repairStatus — cache says repair, live says ready']);
    expect(L.traceRows([], {}, {}).length).toBe(0);
  });

  it('deep button enablement and the V2 code messages', () => {
    const run = { runState: 'running' };
    for (const s of ['MONITORING', 'RECOMMENDATION_READY', 'QUEUED', 'NEEDS_REVIEW', 'WAITING_FOR_DATA', 'FAILED']) expect(L.deepButton({ state: s }, run).disabled, s).toBe(false);
    for (const s of ['RESOLVED', 'PAUSED', 'INVESTIGATING', 'ANALYZING']) expect(L.deepButton({ state: s }, run).disabled, s).toBe(true);
    expect(L.deepButton({ state: 'MONITORING' }, { runState: 'paused' })).toEqual({ disabled: true, hint: 'Autopilot is paused.' });
    expect(L.deepButton({ state: 'MONITORING' }, null).disabled).toBe(true);
    for (const code of ['NOT_RUNNING', 'CASE_BUSY', 'LOCKED_V2']) expect(L.codeMessage(code)).not.toMatch(/^Error:/);
    expect(L.PROPOSAL_BADGE).toBe('Proposal — not published to the unit timeline');
    expect(L.proposalRows([{ event_date: '11/18', kind: 'vendor_update', source: 'decisiv', description: XSS }])).toEqual([{ date: '11/18', kind: 'vendor_update', source: 'decisiv', description: XSS, badge: 'Proposal — not published to the unit timeline' }]);
    const rr = Object.fromEntries(L.recordRows({ root_cause: null, confidence: 0.5, days_down: 4.6 }));
    expect(rr).toMatchObject({ 'Root cause': '—', Confidence: '0.50', 'Days down': '4' });
  });
});

describe('autopilot-api wrapper', () => {
  it('resolves UNAVAILABLE when window.autopilot is missing', async () => {
    const prev = globalThis.window.autopilot;
    delete globalThis.window.autopilot;
    expect(await apiMod.autopilotApi.status()).toEqual({ ok: false, code: 'UNAVAILABLE' });
    for (const k of ['coverage', 'units', 'deepInvestigate']) expect(await apiMod.autopilotApi[k]('ap_0123456789abcdef')).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(typeof apiMod.autopilotApi.onChanged(() => {})).toBe('function');
    globalThis.window.autopilot = { status: vi.fn(async () => ({ ok: true })) };
    expect(await apiMod.autopilotApi.status()).toEqual({ ok: true });
    globalThis.window.autopilot = prev;
  });
});

describe('the view in a fake DOM', () => {
  function fakeApi(over) {
    const status = { ok: true, enabled: true, runState: 'running', supervisorEnabled: true, supervisorEnvOverride: null, config: { features: { liveReads: true }, scope: { domicile: 'ABE40', units: ['B13014'], allUnits: false }, oosDays: 3, maxCasesPerTick: 1, intervalMs: 300000, dailyCap: 48 }, counts: { open: 1, byState: { RECOMMENDATION_READY: 1 }, byDomicile: { ROC5: 1 }, etaOverdue: 0, needsReview: 0, auth: 0 }, scope: { unitsNotInFleet: [], fleetDown: 3 }, ai: {}, resources: {} };
    const kase = { case_id: 'ap_0123456789abcdef', unit_id: 'B13014', domicile: 'ROC5', state: 'RECOMMENDATION_READY', primary_reason: 'DWELL_EXCEEDED', days_down: 71.2, priority: 50, reasons: [{ code: 'DWELL_EXCEEDED' }], ai_findings: { summary: XSS, confirmedFacts: [{ statement: XSS }] }, recommendation: { recommendedActions: [], actionsRequiringApproval: [] } };
    const findings = [{ evidence_id: 'ev_x', source: 'email', field: 'note', value_text: XSS, retrieved_at: 1, freshness: 'UNKNOWN', confidence: 0.5, trust: 'untrusted_text' }];
    const steps = [{ step_id: 's1', run_id: 'r1', seq: 1, turn: 1, kind: 'tool', tool: 'outlook_evidence', status: 'ok', why: 'mail', summary_json: JSON.stringify({ count: 1, evidenceIds: ['ev_x'] }), live: 0, ms: 2 }];
    const coverage = { ok: true, reconcileOk: false, pass: { fleet_rows: 3, eligible: 1, down_eligible: 1, case_open: 0, tokensWithoutRows: ['ZZZ9'], by_domicile: { ROC5: {} }, by_operator: {} }, groups: { queued: 1 }, queue: {}, ai: {}, sources: {} };
    return Object.assign({
      status: vi.fn(async () => status),
      coverage: vi.fn(async () => coverage),
      units: vi.fn(async () => ({ ok: true, total: 1, items: [{ unit_id: 'UK600', eligibility: 'TYPE_UNKNOWN', coverage: 'type_unknown', reason: 'unknown equipment type' }] })),
      deepInvestigate: vi.fn(async () => ({ ok: false, code: 'CASE_BUSY' })),
      cases: vi.fn(async () => ({ ok: true, total: 1, items: [kase] })),
      getCase: vi.fn(async () => ({ ok: true, case: kase, runs: [{ plan: [{ source: 'aap_cache', status: 'cache', why: XSS }] }], findings, conflicts: {}, events: [{ at: 1, kind: 'transition', to_state: 'QUEUED', reason_code: XSS }], eventsTotal: 1,
        steps, proposals: [{ event_date: '11/18', kind: 'note', source: 'email', description: XSS }], record: { root_cause: null }, memory: { openQuestions: [] } })),
      setConfig: vi.fn(async () => ({ ok: true })),
      control: vi.fn(async () => ({ ok: true })),
      review: vi.fn(async () => ({ ok: true })),
      harnessRun: vi.fn(async () => ({ ok: true })),
      onChanged: vi.fn(() => () => {}),
    }, over || {});
  }

  it('self-registers a hidden #view-autopilot, a tab, #ap-styles once, and renders data with textContent only', async () => {
    view._resetForTests();
    const { document } = createExtDom();
    const bus = createBus();
    const addTab = vi.fn();
    const mount = new ExtElement('views-mount', 'div', null);
    const api = fakeApi();
    const h = view.init(mount, { bus, addTab, api, document, window: { confirm: () => false } });
    expect(h.root.id).toBe('view-autopilot');
    expect(h.root.style.display).toBe('none');
    expect(addTab).toHaveBeenCalledWith({ key: 'autopilot', view: 'autopilot', label: 'Autopilot', icon: '🛰️' });
    expect(document.head.querySelectorAll('#ap-styles').length).toBe(1);
    expect(api.status).not.toHaveBeenCalled();   // no polling while hidden

    bus.emit('ui:view-change', { to: 'autopilot' });
    await flush();
    expect(h.root.style.display).toBe('flex');
    expect(api.status).toHaveBeenCalled();
    expect(api.onChanged).toHaveBeenCalledTimes(1);
    const row = h.root.querySelector('[data-case="ap_0123456789abcdef"]') || walk(h.root).find((n) => n.getAttribute && n.getAttribute('data-case') === 'ap_0123456789abcdef');
    expect(row).toBeTruthy();
    row.click();
    await flush();
    expect(api.getCase).toHaveBeenCalledWith('ap_0123456789abcdef', { eventsOffset: 0 });

    const nodes = walk(h.root);
    const withXss = nodes.filter((n) => typeof n.textContent === 'string' && n.textContent.includes('<img'));
    expect(withXss.length).toBeGreaterThanOrEqual(4);   // evidence value, plan why, summary, confirmed fact, event
    expect(nodes.every((n) => !n.innerHTML)).toBe(true);
    expect(nodes.filter((n) => n.tagName === 'IMG').length).toBe(0);

    // V2: coverage on the status poll, both banners, the units list, proposals badge, trace collapse / expand, Deep investigate.
    expect(api.coverage).toHaveBeenCalled();
    expect(api.units).toHaveBeenCalled();
    const texts = nodes.map((n) => n.textContent);
    expect(texts.some((t) => typeof t === 'string' && t.startsWith('Coverage does not reconcile'))).toBe(true);
    expect(texts).toContain('Authorized scope tokens with no synced units: ZZZ9');
    expect(texts).toContain('type_unknown — unknown equipment type');
    expect(texts.filter((t) => t === 'Proposal — not published to the unit timeline').length).toBe(1);
    const collapsed = 'email · ' + XSS.length + ' chars';
    const body = nodes.find((n) => n.textContent === collapsed);
    expect(body).toBeTruthy();
    const expand = nodes.find((n) => n.tagName === 'BUTTON' && n.textContent === 'Expand');
    expand.click();
    expect(body.textContent).toBe(XSS);
    const deep = nodes.find((n) => n.tagName === 'BUTTON' && n.textContent === 'Deep investigate');
    expect(deep.disabled).toBeFalsy();
    deep.click();
    await flush();
    expect(api.deepInvestigate).toHaveBeenCalledWith('ap_0123456789abcdef');
    expect(walk(h.root).some((n) => n.textContent === 'The case is being investigated right now; try again when the run ends.')).toBe(true);
    expect(walk(h.root).filter((n) => n.tagName === 'IMG').length).toBe(0);

    // Locked write toggles are disabled with "Not available in V2 (shadow mode)".
    const locked = nodes.filter((n) => n.textContent === 'Not available in V2 (shadow mode)');
    expect(locked.length).toBe(9);

    bus.emit('ui:view-change', { to: 'settings' });
    expect(h.visible).toBe(true);
    bus.emit('ui:view-change', { to: 'fleet' });
    expect(h.visible).toBe(false);
    expect(h.root.style.display).toBe('none');
    expect(view.init(mount, { bus, addTab, api, document })).toBe(h);
  });

  it('the view source never assigns innerHTML', () => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'src', 'js', 'views', 'autopilot.js'), 'utf8');
    expect(src).not.toMatch(/\.innerHTML\s*=/);
    expect(src).not.toMatch(/insertAdjacentHTML|outerHTML/);
  });
});

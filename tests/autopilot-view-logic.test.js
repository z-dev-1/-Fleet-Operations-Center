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

  it('live-reads text cites approval item 5 with the D-1 scope', () => {
    expect(L.LIVE_READS_TEXT).toMatch(/approval item 5/);
    expect(L.LIVE_READS_TEXT).toMatch(/AAP getService and Decisiv case status\/activity, only on an already-open session; DTNA and Aperia use cached data in V1/);
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

describe('autopilot-api wrapper', () => {
  it('resolves UNAVAILABLE when window.autopilot is missing', async () => {
    const prev = globalThis.window.autopilot;
    delete globalThis.window.autopilot;
    expect(await apiMod.autopilotApi.status()).toEqual({ ok: false, code: 'UNAVAILABLE' });
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
    return Object.assign({
      status: vi.fn(async () => status),
      cases: vi.fn(async () => ({ ok: true, total: 1, items: [kase] })),
      getCase: vi.fn(async () => ({ ok: true, case: kase, runs: [{ plan: [{ source: 'aap_cache', status: 'cache', why: XSS }] }], findings, conflicts: {}, events: [{ at: 1, kind: 'transition', to_state: 'QUEUED', reason_code: XSS }], eventsTotal: 1 })),
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

    // Locked write toggles are disabled with "Not available in V1".
    const locked = nodes.filter((n) => n.textContent === 'Not available in V1');
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

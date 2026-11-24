/**
 * views/autopilot-logic.js -- pure helpers for the Autopilot dashboard (§B12.2, plan R13, R14).
 *
 * Pure: no DOM access and no IPC. Every value returned for display is a plain string; the view
 * sets it with textContent / setAttribute only.
 */

export const STATE_BADGES = Object.freeze({
  DETECTED: { label: 'Detected', tone: 'info' },
  QUEUED: { label: 'Queued', tone: 'info' },
  INVESTIGATING: { label: 'Investigating', tone: 'busy' },
  ANALYZING: { label: 'Analyzing', tone: 'busy' },
  RECOMMENDATION_READY: { label: 'Recommendation ready', tone: 'action' },
  MONITORING: { label: 'Monitoring', tone: 'ok' },
  RESOLVED: { label: 'Resolved', tone: 'ok' },
  WAITING_FOR_DATA: { label: 'Waiting for data', tone: 'warn' },
  AUTH_REQUIRED: { label: 'Sign-in needed', tone: 'warn' },
  FAILED: { label: 'Failed', tone: 'bad' },
  PAUSED: { label: 'Paused', tone: 'mute' },
  NEEDS_REVIEW: { label: 'Needs review', tone: 'action' },
});

/** stateBadge(state) -> { label, tone, className } */
export function stateBadge(state) {
  const b = STATE_BADGES[state] || { label: String(state || 'Unknown'), tone: 'mute' };
  return { label: b.label, tone: b.tone, className: 'ap-badge ap-badge--' + b.tone };
}

// Detection reason codes (constants.REASONS) -> plain sentences.
export const REASON_SENTENCES = Object.freeze({
  OOS: 'The unit is out of service in AAP.',
  DWELL_EXCEEDED: 'The unit has been down longer than the configured number of days.',
  LONG_DWELL_LISTED: 'The unit is listed on the AAP long-dwell tracker.',
  ETA_OVERDUE_VERIFIED: 'A verified repair ETC has passed.',
  ETA_PAST_UNVERIFIED: 'An ETC date has passed, but it does not come from an authoritative source.',
  ETA_NOT_PROVIDED: 'No source gives a repair ETC.',
  UPDATE_STALE: 'There is no recent vendor update.',
  ANNOTATION_STALE: 'The long-dwell note is out of date.',
  WAITING_PARTS: 'The repair is waiting for parts.',
  WAITING_ESTIMATE_APPROVAL: 'The repair is waiting for an estimate or approval.',
  AWAITING_SCHEDULING: 'The repair is waiting to be scheduled.',
  STATUS_CONFLICT: 'Sources disagree on the repair status.',
  REPAIRED_UNVERIFIED: 'A source says the repair is done, but AAP still shows the unit down.',
  RECURRING_DEFECT: 'The unit has a recurring defect in its repair history.',
  DOWN_SINCE_UNKNOWN: 'The down-since time is unknown.',
});

export function reasonSentence(code) {
  return REASON_SENTENCES[code] || ('Reason code: ' + String(code == null ? 'none' : code));
}

// ap_event reason codes -> plain sentences (the case drawer's "Why" history).
const EVENT_SENTENCES = Object.freeze({
  new: 'Opened by detection.',
  oos_rule: 'Opened because the unit has been down longer than the configured days.',
  hard_condition: 'Opened because of a verified overdue ETC, a status conflict or an unverified repair.',
  long_dwell: 'Opened because the unit is on the long-dwell tracker.',
  manual: 'Re-run requested by a user.',
  harness: 'Re-run by the acceptance harness.',
  recovered: 'Re-queued after the app restarted during a run.',
  crash: 'A previous run did not finish.',
  crash_loop: 'Stopped retrying after repeated interrupted runs.',
  unchanged: 'Evidence has not changed since the last run, so the conclusion was kept.',
  evidence_unchanged: 'Evidence has not changed since the last run, so the conclusion was kept.',
  evidence_changed: 'Cached evidence for the unit changed.',
  scheduled: 'The scheduled review time arrived.',
  auth_restored: 'Sign-in is healthy again.',
  retry_due: 'The retry time arrived.',
  resolved: 'AAP shows the unit Active on a newer API build.',
  aap_active: 'AAP shows the unit Active on a newer API build.',
  unit_missing: 'The unit was missing from two AAP builds.',
  lifecycle_not_active: 'The unit is no longer down, but its lifecycle is not Active.',
  non_api_lifecycle: 'The unit is no longer down, but the row did not come from the AAP API.',
  no_down_observation: 'The unit is no longer down, but Autopilot never saw it down on a build.',
  out_of_scope: 'Paused because the unit left the pilot scope.',
  in_scope: 'The unit is back in the pilot scope.',
  feature_off: 'Paused because the investigation type was turned off.',
  feature_on: 'The investigation type was turned on again.',
  master_pause: 'Paused by the Pause control.',
  master_stop: 'Stopped by the Stop control.',
  master_on: 'Autopilot was turned on again.',
  resume: 'Resumed by a user.',
  shutdown: 'The app shut down during the run; it will run again.',
  budget: 'The tick ran out of time; the case will run again.',
  reconfigure: 'The schedule changed during the run; it will run again.',
  no_row: 'The unit has no AAP fleet row.',
  fleet_red: 'AAP fleet data is too old to use.',
  fleet_grey: 'AAP fleet data has not loaded recently.',
  analyze: 'Analysis started.',
  planned: 'Source plan recorded.',
  acknowledge: 'A user acknowledged the recommendation.',
  accept: 'A user accepted the review item.',
  rerun: 'A user asked for a re-run.',
  ok: 'The AI analysis passed validation.',
  invalid: 'The AI output failed validation; a deterministic recommendation was used.',
  timeout: 'The AI timed out; a deterministic recommendation was used.',
  unavailable: 'The AI was unavailable; a deterministic recommendation was used.',
  skipped_cap: 'The daily AI cap was reached; a deterministic recommendation was used.',
  skipped_busy: 'Other AI work was waiting; a deterministic recommendation was used.',
  not_needed: 'The case needed no AI judgment.',
  disabled: 'AI investigation is turned off.',
  interrupted: 'The AI call was interrupted; it will be retried later.',
});

/** eventSentence(ev) -> plain sentence for one ap_event row. */
export function eventSentence(ev) {
  const e = ev || {};
  const raw = e.reason_code == null ? '' : String(e.reason_code);
  if (raw.startsWith('eta_due:')) return 'The ETC date ' + raw.slice(8) + ' arrived.';
  if (raw.startsWith('aborted:')) return 'The run stopped early (' + (EVENT_SENTENCES[raw.slice(8)] || raw.slice(8)) + ').';
  if (raw.startsWith('resumed:')) return 'Resumed from the ' + raw.slice(8) + ' checkpoint.';
  const base = EVENT_SENTENCES[raw] || (raw ? 'Reason code: ' + raw : '');
  if (e.kind === 'transition' && e.to_state) {
    const to = stateBadge(e.to_state).label;
    return base ? 'Moved to ' + to + '. ' + base : 'Moved to ' + to + '.';
  }
  if (e.kind === 'detection' && raw === 'reasons_changed') return 'Detection reasons changed.';
  return base || String(e.kind || 'event');
}

/** formatTime(ms) -> local date-time string, or '—'. */
export function formatTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function _str(v) {
  if (v == null) return '';
  return typeof v === 'string' ? v : (typeof v === 'object' ? JSON.stringify(v) : String(v));
}

/**
 * evidenceRows(findings, conflicts) -> row models for the evidence table.
 * Every display value is a plain string (untrusted text is never escaped or parsed here;
 * the view renders it with textContent).
 */
export function evidenceRows(findings, conflicts) {
  const inConflict = new Set();
  for (const ids of Object.values(conflicts || {})) for (const id of ids || []) inConflict.add(id);
  return (Array.isArray(findings) ? findings : []).map((f) => ({
    evidenceId: _str(f.evidence_id),
    source: _str(f.source),
    field: _str(f.field),
    value: _str(f.value_text),
    observed: formatTime(f.observed_at),
    retrieved: formatTime(f.retrieved_at),
    freshness: _str(f.freshness),
    confidence: Number.isFinite(f.confidence) ? f.confidence.toFixed(2) : '',
    trust: f.trust === 'untrusted_text' ? 'untrusted text' : _str(f.trust),
    authority: _str(f.authority_tag),
    conflictGroup: _str(f.conflict_group),
    conflict: !!f.conflict_group || inConflict.has(f.evidence_id),
  }));
}

/** recheckLabel(case) -> 'Autopilot will re-check by <time>' or ''. Never a deadline. */
export function recheckLabel(c) {
  const k = c || {};
  const ts = [k.next_attempt_at, k.next_review_at].filter(Number.isFinite);
  if (!ts.length || k.state === 'RESOLVED' || k.state === 'PAUSED') return '';
  return 'Autopilot will re-check by ' + formatTime(Math.min(...ts));
}

/** caseRow(case) -> the cases-table row model. */
export function caseRow(c) {
  const k = c || {};
  return {
    caseId: _str(k.case_id),
    unit: _str(k.unit_id),
    domicile: _str(k.domicile),
    state: stateBadge(k.state),
    primaryReason: k.primary_reason ? reasonSentence(k.primary_reason) : '',
    primaryReasonCode: _str(k.primary_reason),
    daysDown: Number.isFinite(k.days_down) ? String(Math.floor(k.days_down)) : '—',
    etc: k.eta && k.eta.status ? String(k.eta.status).replace(/_/g, ' ').toLowerCase() + (k.eta.date ? ' ' + k.eta.date : '') : '—',
    recheck: recheckLabel(k),
    priority: Number.isFinite(k.priority) ? String(k.priority) : '0',
  };
}

/**
 * supervisorBanner(status, { restartPending }) -> null | { text, buttonLabel, buttonDisabled }
 * Shown whenever the master switch is ON and the worker supervisor is off (D-2, R13).
 */
export function supervisorBanner(status, opts) {
  const s = status || {};
  if (!s.enabled || s.supervisorEnabled) return null;
  if (s.supervisorEnvOverride === '0') {
    return { text: 'Supervisor disabled by the FLEET_WORKERS environment variable', buttonLabel: 'Enable supervisor (restart required)', buttonDisabled: true };
  }
  if (opts && opts.restartPending) {
    return { text: 'Restart the app to start Autopilot', buttonLabel: 'Enable supervisor (restart required)', buttonDisabled: true };
  }
  return {
    text: 'Autopilot runs under the worker supervisor, which is off. Enable it and restart the app to start Autopilot.',
    buttonLabel: 'Enable supervisor (restart required)',
    buttonDisabled: false,
  };
}

/** runButtons(status) -> { runNowDisabled, harnessDisabled, harnessHint } */
export function runButtons(status) {
  const s = status || {};
  const supOff = !s.supervisorEnabled;
  const notRunning = s.runState !== 'running';
  const off = !s.enabled;
  let hint = '';
  if (off) hint = 'Autopilot is off.';
  else if (supOff) hint = 'The worker supervisor is off.';
  else if (notRunning) hint = 'Autopilot is ' + (s.runState || 'not running') + '.';
  else if (s.harnessRanToday) hint = 'The harness already ran today.';
  return {
    runNowDisabled: off || supOff || notRunning,
    harnessDisabled: off || supOff || notRunning || !!s.harnessRanToday,
    harnessHint: hint,
  };
}

export const LIVE_READS_TEXT = 'Live reads (approval item 5): AAP getService and Decisiv case status/activity, only on an already-open session; DTNA and Aperia use cached data in V1.';
export const SHADOW_TEXT = 'Shadow mode: nothing is sent. Autopilot only reads and records recommendations.';
export const LOCKED_WRITE_TEXT = 'Not available in V1';
export const APPROVAL_BADGE = 'Requires approval — not executed in V1';

export const WRITE_LABELS = Object.freeze({
  slackReplies: 'Automatic Slack replies',
  emailReplies: 'Email replies',
  vendorFollowUps: 'Vendor follow-ups',
  woCreate: 'Work order creation',
  woUpdate: 'Work order updates',
  lifecycleChange: 'Lifecycle changes',
  estimateApproval: 'Estimate approvals',
  externalEscalation: 'External escalations',
  futureAutonomous: 'Future autonomous workflows',
});

export const PROTECTION_LABELS = Object.freeze({
  permissions: 'Permissions',
  securityChecks: 'Security checks',
  approvalEnforcement: 'Approval enforcement',
  auditLogging: 'Audit logging',
  duplicateActionProtection: 'Duplicate-action protection',
});

export const FEATURE_LABELS = Object.freeze({
  oosInvestigation: 'OOS investigation',
  longDwellInvestigation: 'Long-Dwell investigation',
  evidenceCollection: 'Automated evidence collection',
  aiInvestigation: 'AI investigation and prioritization',
  localHistory: 'Local investigation history',
  liveReads: 'Live reads',
});

/** unitsNotInFleet(status) -> string[] (R14) */
export function unitsNotInFleet(status) {
  const l = status && status.scope && Array.isArray(status.scope.unitsNotInFleet) ? status.scope.unitsNotInFleet : [];
  return l.map((u) => String(u));
}

/** unitsNotInFleetText(status) -> '' | sentence */
export function unitsNotInFleetText(status) {
  const l = unitsNotInFleet(status);
  return l.length ? 'Listed units with no AAP fleet row: ' + l.join(', ') : '';
}

/** allUnitsConfirmText(count) -> the confirm-dialog text for the All-units switch. */
export function allUnitsConfirmText(count) {
  const n = Number.isFinite(count) ? count : 0;
  return 'Turn on All units? Autopilot will watch every down unit in the fleet: ' + n + ' unit' + (n === 1 ? '' : 's') + ' in scope right now.';
}

/** reliabilityHint(status) -> sentence about durable jobs. */
export function reliabilityHint(status) {
  const j = status && status.jobs;
  const on = !!(j && j.effective);
  return 'Durable jobs are ' + (on ? 'on' : 'off') + ' (setting settings.jobs.autopilotInvestigate.durable).';
}

/** parseUnits(text) -> string[] (one per line or comma; trimmed, uppercased, deduped). */
export function parseUnits(text) {
  const out = [];
  const seen = new Set();
  for (const part of String(text == null ? '' : text).split(/[\s,;]+/)) {
    const u = part.trim().toUpperCase();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/**
 * findingsSections(aiFindings) -> the five AI-finding sections as plain strings:
 * confirmed facts, inferences, missing information, recommended actions, actions requiring approval.
 */
export function findingsSections(f) {
  const o = f || {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  const act = (a) => _str(a.action) + (a.rationale ? ' — ' + _str(a.rationale) : '') + (a.owner ? ' (owner: ' + _str(a.owner) + ')' : '');
  return [
    { key: 'confirmedFacts', title: 'Confirmed facts', items: arr(o.confirmedFacts).map((x) => _str(x && x.statement)) },
    {
      key: 'inferences', title: 'Evidence-based inferences',
      items: arr(o.inferences).map((x) => _str(x && x.statement) + (x && x.reasoning ? ' — ' + _str(x.reasoning) : '') + (x && Number.isFinite(x.confidence) ? ' (confidence ' + x.confidence.toFixed(2) + ')' : '')),
    },
    { key: 'missingInfo', title: 'Missing information', items: arr(o.missingInfo).map((x) => _str(x && x.item) + (x && x.whyNeeded ? ' — ' + _str(x.whyNeeded) : '')) },
    { key: 'recommendedActions', title: 'Recommended actions', items: arr(o.recommendedActions).map((x) => act(x || {})) },
    { key: 'actionsRequiringApproval', title: 'Actions requiring approval', items: arr(o.actionsRequiringApproval).map((x) => act(x || {})), badge: APPROVAL_BADGE },
  ];
}

/** reviewButtons(state) -> which review decisions apply to a case state. */
export function reviewButtons(state) {
  return {
    acknowledge: state === 'RECOMMENDATION_READY',
    accept: state === 'NEEDS_REVIEW',
    rerun: !!state && !['INVESTIGATING', 'ANALYZING', 'PAUSED', 'RESOLVED', 'QUEUED'].includes(state),
  };
}

/** codeMessage(code) -> plain sentence for an IPC error code. */
export function codeMessage(code) {
  const M = {
    UNAVAILABLE: 'Autopilot is not available in this build.',
    DISABLED: 'Autopilot is off.',
    SUPERVISOR_DISABLED: 'The worker supervisor is off.',
    NOT_RUNNING: 'Autopilot is paused or stopped.',
    BUSY: 'Autopilot is busy; try again in a moment.',
    HARNESS_ALREADY_RAN: 'The harness already ran today.',
    LOCKED_V1: 'That setting is locked in V1.',
    INVALID_INPUT: 'The value is not valid.',
    INVALID_STATE: 'That action does not apply to the case right now.',
    NOT_FOUND: 'The case was not found.',
    SETTINGS_WRITE_FAILED: 'The settings could not be saved.',
    STORAGE_UNAVAILABLE: 'Local storage is unavailable.',
  };
  return M[code] || ('Error: ' + String(code || 'unknown'));
}

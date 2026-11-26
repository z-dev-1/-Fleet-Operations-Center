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
    conflictGroup: f.cited_from_run ? '' : _str(f.conflict_group),
    conflict: !f.cited_from_run && (!!f.conflict_group || inConflict.has(f.evidence_id)),
    // A cited row from an earlier run (getCase merges it so the stored recommendation stays traceable).
    earlierRun: !!f.cited_from_run,
    runId: _str(f.run_id),
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

export const LIVE_READS_TEXT = 'Live reads (approval item 5): AAP getService and Decisiv case status/activity, only on an already-open session (warm-only). Investigation tools read the cache first and make at most one warm-only live read per source per run; they never start a sign-in. DTNA and Aperia use cached data.';
export const SHADOW_TEXT = 'Shadow mode: nothing is sent. Autopilot only reads and records recommendations.';
export const LOCKED_WRITE_TEXT = 'Not available in V2 (shadow mode)';
export const PROPOSAL_BADGE = 'Proposal — not published to the unit timeline';
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
    CASE_BUSY: 'The case is being investigated right now; try again when the run ends.',
    BUSY: 'Autopilot is busy; try again in a moment.',
    HARNESS_ALREADY_RAN: 'The harness already ran today.',
    LOCKED_V1: 'That setting is locked in V1.',
    LOCKED_V2: 'That setting is locked in V2 (shadow mode).',
    INVALID_INPUT: 'The value is not valid.',
    INVALID_STATE: 'That action does not apply to the case right now.',
    NOT_FOUND: 'The case was not found.',
    SETTINGS_WRITE_FAILED: 'The settings could not be saved.',
    STORAGE_UNAVAILABLE: 'Local storage is unavailable.',
  };
  return M[code] || ('Error: ' + String(code || 'unknown'));
}

// ── V2 (§10.3) ──────────────────────────────────────────────────────────────

const _num = (v) => (Number.isFinite(v) ? v : 0);
const _arr = (v) => (Array.isArray(v) ? v : []);
const _obj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function _json(v) {
  if (_obj(v) || Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v) return null;
  try { return JSON.parse(v); } catch (_) { return null; }
}

/** formatAge(ms) -> '3 h 5 min' / '2 d 4 h' / '—'. */
export function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  if (h < 48) return h + ' h ' + (m % 60) + ' min';
  return Math.floor(h / 24) + ' d ' + (h % 24) + ' h';
}

/** reconcile identities of a detection pass (same formulas as src/autopilot/coverage.js). */
export function reconcileDiffs(pass) {
  const p = pass || {};
  const n = (k) => Number(p[k]) || 0;
  const rowsDiff = (n('fleet_rows') - n('duplicate_rows')) - (n('invalid_rows') + n('eligible') + n('excluded_trailer')
    + n('excluded_hostler') + n('excluded_unsupported') + n('type_unknown') + n('type_conflict'));
  const downDiff = n('down_eligible') - (n('case_open') + n('below_threshold') + n('out_of_filter') + n('feature_off'));
  return { rowsDiff, downDiff };
}

/**
 * coverageTiles(coverage) -> [{ key, label, value, group, link? }]. link is { view:'units', filter } or
 * { view:'cases', filter } for the clickable tiles. [] while Autopilot is off or no coverage was read.
 */
export function coverageTiles(cov) {
  const c = cov || {};
  if (!c.ok || c.enabled === false) return [];
  const p = c.pass || {};
  const g = c.groups || {};
  const q = c.queue || {};
  const ai = c.ai || {};
  const t = (key, label, value, group, link) => ({ key, label, value: String(value), group, link: link || null });
  const pass = c.pass ? (k) => String(_num(p[k])) : () => '—';
  const out = [
    t('eligible', 'Power units monitored', pass('eligible'), 'fleet'),
    t('down_eligible', 'OOS detected', pass('down_eligible'), 'fleet'),
    t('case_open', 'Cases open', pass('case_open'), 'fleet'),
    t('detectedHeld', 'Detected, waiting for a queue slot', _num(g.detectedHeld), 'groups', { view: 'cases', filter: { group: 'queued' } }),
    t('queued', 'Queued', _num(g.queued), 'groups', { view: 'cases', filter: { group: 'queued' } }),
    t('active', 'Investigating now', _num(g.active), 'groups', { view: 'cases', filter: { group: 'reasoning' } }),
    t('scheduled', 'Scheduled re-check', _num(g.scheduled), 'groups', { view: 'cases', filter: { group: 'monitoring' } }),
    t('waiting', 'Waiting for evidence', _num(g.waiting), 'groups', { view: 'cases', filter: { group: 'waiting' } }),
    t('review', 'Needs review', _num(g.review), 'groups', { view: 'cases', filter: { group: 'review' } }),
    t('deferredAi', 'AI deferred', _num(g.deferredAi), 'groups', { view: 'cases', filter: { aiPending: true } }),
    t('paused', 'Paused', _num(g.paused), 'groups', { view: 'cases', filter: { group: 'paused' } }),
    t('failed', 'Failed', _num(g.failed), 'groups', { view: 'cases', filter: { group: 'failed' } }),
    t('excluded_trailer', 'Excluded: trailers', pass('excluded_trailer'), 'excluded', { view: 'units', filter: { eligibility: 'EXCLUDED_TRAILER' } }),
    t('excluded_hostler', 'Excluded: hostlers', pass('excluded_hostler'), 'excluded', { view: 'units', filter: { eligibility: 'EXCLUDED_HOSTLER' } }),
    t('excluded_unsupported', 'Excluded: unsupported type', pass('excluded_unsupported'), 'excluded', { view: 'units', filter: { eligibility: 'EXCLUDED_UNSUPPORTED' } }),
    t('type_unknown', 'Unknown equipment type', pass('type_unknown'), 'excluded', { view: 'units', filter: { coverage: 'type_unknown' } }),
    t('type_conflict', 'Equipment type conflict', pass('type_conflict'), 'excluded', { view: 'units', filter: { coverage: 'type_conflict' } }),
    t('below_threshold', 'Below threshold', pass('below_threshold'), 'excluded', { view: 'units', filter: { coverage: 'below_threshold' } }),
    t('out_of_filter', 'Out of filter', pass('out_of_filter'), 'excluded', { view: 'units', filter: { coverage: 'out_of_filter' } }),
    t('oldestQueued', 'Oldest queued', formatAge(q.oldestQueuedAgeMs), 'queue'),
    t('queueCoveragePct', 'Queue coverage', Number.isFinite(q.queueCoveragePct) ? q.queueCoveragePct + '%' : '—', 'queue'),
    t('processingRatePerHour', 'Processed per hour', Number.isFinite(q.processingRatePerHour) ? String(q.processingRatePerHour) : '—', 'queue'),
    t('aiToday', 'AI calls today', _num(ai.callsToday) + ' / ' + (Number.isFinite(ai.cap) ? ai.cap : '—'), 'ai'),
    t('aiLatency', 'AI p50 / p95', Number.isFinite(ai.p50Ms) ? ai.p50Ms + ' / ' + (Number.isFinite(ai.p95Ms) ? ai.p95Ms : '—') + ' ms' : '—', 'ai'),
    t('aiFailureRate', 'AI failure rate', Number.isFinite(ai.failureRate) ? Math.round(ai.failureRate * 100) + '%' : '—', 'ai'),
    t('notYetAi', 'Not yet AI-investigated', _num(ai.notYetAi), 'ai', { view: 'cases', filter: { aiPending: true } }),
    t('noAiConclusion', 'No AI-supported conclusion', _num(ai.noAiConclusion), 'ai'),
  ];
  return out;
}

/** sourceRows(coverage, auth) -> per-source availability rows (base-pack and tool live calls, 24 h). */
export function sourceRows(cov, auth) {
  const s = (cov && _obj(cov.sources)) ? cov.sources : {};
  const a = _obj(auth) ? auth : {};
  return Object.keys(s).sort().map((k) => {
    const v = s[k] || {};
    const st = a[k];
    return {
      source: k,
      ok: String(_num(v.ok)), not_warm: String(_num(v.not_warm)), auth: String(_num(v.auth)),
      cache_only: String(_num(v.cache_only)), rate_limited: String(_num(v.rate_limited)),
      authState: st == null ? '' : (typeof st === 'object' ? (st.actionNeeded ? 'sign-in needed' : _str(st.state)) : _str(st)),
    };
  });
}

/** reconcileBanner(coverage) -> null | { tone:'bad', text } when the latest pass does not reconcile. */
export function reconcileBanner(cov) {
  if (!cov || !cov.ok || cov.reconcileOk !== false) return null;
  const d = reconcileDiffs(cov.pass);
  return {
    tone: 'bad',
    text: 'Coverage does not reconcile: fleet rows differ from the classified units by ' + d.rowsDiff
      + ', and down power units differ from the coverage buckets by ' + d.downDiff + '.',
    rowsDiff: d.rowsDiff, downDiff: d.downDiff,
  };
}

/** scopeBanner(coverage) -> null | { tone:'warn', text } when authorized scope tokens match no synced unit (FR-1.10). */
export function scopeBanner(cov) {
  const l = cov && cov.ok && cov.pass ? _arr(cov.pass.tokensWithoutRows).map((x) => String(x)) : [];
  return l.length ? { tone: 'warn', text: 'Authorized scope tokens with no synced units: ' + l.join(', ') } : null;
}

export const CASE_GROUPS = Object.freeze([
  ['queued', 'Queued'], ['reasoning', 'Investigating'], ['monitoring', 'Monitoring'], ['waiting', 'Waiting for evidence'],
  ['review', 'Needs review'], ['resolved', 'Resolved'], ['paused', 'Paused'], ['failed', 'Failed'],
]);
export const TIERS = Object.freeze([['simple', 'Simple'], ['standard', 'Standard'], ['complex', 'Complex']]);
export const SORTS = Object.freeze([['priority', 'Priority'], ['downtime', 'Downtime'], ['queued', 'Time queued'], ['updated', 'Last updated']]);
// classify.STAGES ∪ classify.CANONICAL_STATUSES (the autopilot:cases phase enum).
export const PHASES = Object.freeze(['arrival', 'diagnosis', 'approval', 'repair', 'ready', 'none', 'available', 'down', 'in_repair',
  'awaiting_parts', 'awaiting_estimate_approval', 'awaiting_vendor', 'ready_for_pickup', 'in_transit', 'decommissioned', 'unknown']);
export const UNIT_COVERAGES = Object.freeze(['case_open', 'below_threshold', 'not_down', 'out_of_filter', 'feature_off', 'excluded', 'type_unknown', 'type_conflict', 'invalid']);
export const ELIGIBILITY_CLASSES = Object.freeze(['POWER_ELIGIBLE', 'EXCLUDED_TRAILER', 'EXCLUDED_HOSTLER', 'EXCLUDED_UNSUPPORTED', 'TYPE_UNKNOWN', 'TYPE_CONFLICT', 'INVALID_ROW']);

const CODE_RE = /^[A-Z0-9]{2,10}$/;
function _groupKeys(o) {
  return Object.keys(_obj(o) ? o : {}).map((k) => String(k).trim().toUpperCase()).filter((k) => CODE_RE.test(k)).sort();
}

/** filterModel(coverage) -> dropdown values; domicile and SCAC come from the latest pass groups (no free typing). */
export function filterModel(cov) {
  const p = (cov && cov.pass) || {};
  return {
    domicileOptions: _groupKeys(p.by_domicile),
    scacOptions: _groupKeys(p.by_operator),
    groups: CASE_GROUPS, tiers: TIERS, sorts: SORTS, phases: PHASES,
  };
}

/** casesQuery(uiFilter, { limit, offset }) -> the autopilot:cases filter (empty values dropped, numbers parsed). */
export function casesQuery(f, page) {
  const u = f || {};
  const out = {};
  for (const k of ['state', 'reason', 'domicile', 'q', 'carrier', 'scac', 'vendor', 'phase', 'group', 'tier', 'sort']) {
    const v = u[k] == null ? '' : String(u[k]).trim();
    if (v) out[k] = v;
  }
  if (out.state && out.group) delete out.group;   // state wins; the IPC rejects both together
  for (const k of ['downtimeMin', 'downtimeMax']) {
    const v = u[k] === '' || u[k] == null ? NaN : Number(u[k]);
    if (Number.isFinite(v)) out[k] = v;
  }
  const pm = u.priorityMin === '' || u.priorityMin == null ? NaN : Number(u.priorityMin);
  if (Number.isInteger(pm)) out.priorityMin = pm;
  if (u.aiPending === true) out.aiPending = true;
  if (page && Number.isInteger(page.limit)) out.limit = page.limit;
  if (page && Number.isInteger(page.offset)) out.offset = page.offset;
  return out;
}

/** unitRow(ap_unit row) -> the units-table row model. */
export function unitRow(u) {
  const k = u || {};
  return {
    unit: _str(k.unit_id), eligibility: _str(k.eligibility), equipmentClass: _str(k.equipment_class),
    coverage: _str(k.coverage), domicile: _str(k.domicile), operator: _str(k.operator), owner: _str(k.owner),
    caseId: _str(k.case_id), reason: _str(k.reason), exclusionCode: _str(k.exclusion_code),
    down: k.is_down ? 'down' : '',
  };
}

const STEP_TONES = Object.freeze({
  ok: 'ok', empty: 'ok', final: 'ok', reused: 'mute', skipped: 'mute', pending: 'busy', interrupted: 'busy',
  unavailable: 'warn', auth_required: 'warn', stopped: 'warn', timeout: 'bad', invalid: 'bad', invalid_args: 'bad', denied: 'bad', error: 'bad',
});
const STRUCT_MAX = 80;
const ROW_KINDS = Object.freeze({ model: 'AI turn', final: 'Final answer', stop: 'Stopped' });

function _chip(id, findingsById) {
  const f = findingsById && findingsById[id];
  if (!f) return { evidenceId: _str(id), source: '', untrusted: false };
  const untrusted = f.trust === 'untrusted_text';
  const text = _str(f.value_text);
  return untrusted
    ? { evidenceId: _str(id), source: _str(f.source), untrusted: true, collapsed: _str(f.source) + ' · ' + text.length + ' chars', text }
    : { evidenceId: _str(id), source: _str(f.source), untrusted: false, value: _str(f.field) + ': ' + text.slice(0, STRUCT_MAX) };
}

/**
 * traceRows(steps, findingsById, final?) -> trace panel rows (pure, §10.3, AC-28).
 * steps: autopilot:case `steps` (the 17 listed columns only). Rows never carry a prompt or model
 * text field: a model step shows its decision and tool count, a tool step its why, status,
 * counts, newest observed time, short structured values and evidence chips. Untrusted evidence
 * text is collapsed to source + length; the view sets it with textContent only on expand.
 * final (optional): { case, output, memory } adds 'start', 'final' and 'uncertain' rows.
 */
export function traceRows(steps, findingsById, final) {
  const rows = [];
  const fx = final || {};
  const byId = _obj(findingsById) ? findingsById : {};
  if (fx.case) {
    const c = fx.case;
    rows.push({ kind: 'start', label: 'Started with', text: 'Unit ' + _str(c.unit_id) + ' · ' + stateBadge(c.state).label + ' · ' + Object.keys(byId).length + ' evidence items' });
  }
  for (const s of _arr(steps)) {
    if (!s) continue;
    const sum = _json(s.summary_json) || {};
    const status = _str(s.status);
    const tone = STEP_TONES[status] || 'mute';
    const kind = _str(s.kind);
    const r = {
      kind, stepId: _str(s.step_id), runId: _str(s.run_id), seq: Number.isFinite(s.seq) ? s.seq : null,
      turn: Number.isFinite(s.turn) ? String(s.turn) : '',
      label: kind === 'tool' ? _str(s.tool) : (ROW_KINDS[kind] || kind),
      why: kind === 'tool' ? _str(s.why).slice(0, 200) : '',
      status: { label: status + (s.code ? ' · ' + _str(s.code) : ''), className: 'ap-badge ap-badge--' + tone },
      summary: '', values: [], chips: [], marker: '',
      ms: Number.isFinite(s.ms) ? s.ms + ' ms' : '',
    };
    if (kind === 'model') {
      r.summary = (sum.decision ? 'decision: ' + _str(sum.decision) : '') + (Number.isFinite(sum.tools) ? ' · ' + sum.tools + ' tool request' + (sum.tools === 1 ? '' : 's') : '');
      r.marker = s.ai_lane ? 'lane ' + _str(s.ai_lane) : '';
      if (Number.isFinite(s.ai_latency_ms)) r.ms = s.ai_latency_ms + ' ms';
    } else if (kind === 'tool') {
      const n = Number.isFinite(sum.count) ? sum.count : 0;
      r.summary = n + ' item' + (n === 1 ? '' : 's') + (Number.isFinite(sum.newestObservedAt) ? ' · newest ' + formatTime(sum.newestObservedAt) : '');
      r.values = _arr(sum.structured).slice(0, 8).map((x) => (_str(x && x.field) + ': ' + _str(x && x.value)).slice(0, STRUCT_MAX));
      r.chips = _arr(sum.evidenceIds).slice(0, 40).map((id) => _chip(id, byId));
      r.marker = s.reused_step_id || status === 'reused' ? 'reused' : (s.live ? 'live' : (sum.cacheServed ? 'cached (source unavailable)' : 'cached'));
    }
    rows.push(r);
  }
  const out = fx.output;
  if (_obj(out)) {
    const sec = findingsSections(out);
    rows.push({
      kind: 'final', label: 'Conclusion', text: _str(out.summary).slice(0, 400),
      sections: sec.filter((x) => x.key !== 'missingInfo'),
      nextReview: Number.isFinite(out.nextReviewInHours) ? 'Next review in ' + out.nextReviewInHours + ' h' : '',
    });
  }
  const mem = _obj(fx.memory) ? fx.memory : {};
  const uncertain = [];
  for (const m of _arr(out && out.missingInfo)) uncertain.push('Missing: ' + _str(m && m.item));
  for (const q of _arr(mem.openQuestions)) uncertain.push('Open question: ' + _str(q && q.question));
  for (const c of _arr(out && out.conflicts)) uncertain.push('Conflict: ' + _str(c && (c.field || c.group)) + (c && c.note ? ' — ' + _str(c.note) : ''));
  if (uncertain.length) rows.push({ kind: 'uncertain', label: 'Uncertain', items: uncertain });
  return rows;
}

/** deepButton(case, status) -> { disabled, hint } (§10.3). */
export function deepButton(c, status) {
  const st = c && c.state;
  if (!status || status.runState !== 'running') return { disabled: true, hint: 'Autopilot is ' + String((status && status.runState) || 'not running') + '.' };
  if (['RESOLVED', 'PAUSED', 'INVESTIGATING', 'ANALYZING'].includes(st)) return { disabled: true, hint: 'Not available while the case is ' + stateBadge(st).label.toLowerCase() + '.' };
  return { disabled: false, hint: '' };
}

/** recordRows(record) -> [label, value] pairs of the structured findings record (FR-14.1). */
export function recordRows(rec) {
  const r = _obj(rec) ? rec : {};
  const v = (x) => (x == null || x === '' ? '—' : _str(x));
  return [
    ['Operator', v(r.operator)], ['Owner', v(r.owner)], ['Domicile', v(r.domicile)], ['OOS status', v(r.oos_status)],
    ['Days down', Number.isFinite(r.days_down) ? String(Math.floor(r.days_down)) : '—'], ['Repair phase', v(r.repair_phase)],
    ['Root cause', v(r.root_cause)], ['Blocker', v(r.blocker)], ['Responsible party', v(r.responsible_party)],
    ['Last verified update', Number.isFinite(r.last_verified_update_at) ? formatTime(r.last_verified_update_at) + (r.last_verified_update_source ? ' (' + _str(r.last_verified_update_source) + ')' : '') : '—'],
    ['Parts ETA', v(r.parts_eta)], ['Repair ETA', v(r.repair_eta)],
    ['Confidence', Number.isFinite(r.confidence) ? r.confidence.toFixed(2) : '—'], ['AI status', v(r.ai_status)],
    ['Investigated', formatTime(r.investigated_at)],
  ];
}

/** proposalRows(proposals) -> timeline proposal rows, each with the not-published badge. */
export function proposalRows(list) {
  return _arr(list).map((p) => ({
    date: _str(p && (p.event_date || (Number.isFinite(p.event_at) ? formatTime(p.event_at) : ''))),
    kind: _str(p && p.kind), source: _str(p && p.source), description: _str(p && p.description), badge: PROPOSAL_BADGE,
  }));
}

export const FILTER_LIST_KEYS = Object.freeze([['domiciles', 'Domiciles'], ['carriers', 'Carriers'], ['scacs', 'SCACs'], ['vendors', 'Vendors'], ['units', 'Units']]);

/** parseList(text, upper) -> trimmed, deduped entries (comma, semicolon or newline separated). */
export function parseList(text, upper) {
  const out = [];
  const seen = new Set();
  for (const part of String(text == null ? '' : text).split(/[,;\n]+/)) {
    const v = upper ? part.trim().toUpperCase() : part.trim();
    const k = v.toLowerCase();
    if (!v || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/** scopeFilterPatch({ domiciles, carriers, scacs, vendors, units } as text) -> { scope: { filter } } */
export function scopeFilterPatch(texts) {
  const t = texts || {};
  return { scope: { filter: {
    domiciles: parseList(t.domiciles, true), carriers: parseList(t.carriers, false), scacs: parseList(t.scacs, true),
    vendors: parseList(t.vendors, false), units: parseUnits(t.units),
  } } };
}

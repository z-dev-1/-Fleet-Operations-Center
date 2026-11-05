/**
 * worker-health.js — Worker Health section (Phase 6), hosted by the Fleet
 * Operations Center overlay (instance-management.js init()).
 *
 * Read:    window.health.snapshot()  (one aggregate IPC; each section may be
 *          { status:'unavailable', reason } without breaking the others)
 * Control: window.workers.reEnable(name) — the ONLY control. The backend
 *          validates the name and supervisor.reEnable() owns eligibility; the
 *          button is only shown for isolated / budget-exhausted workers.
 *
 * Polls every 15 s only while mounted AND the document is visible, plus a
 * manual Refresh button.
 */
import {
  esc, truncate, relTime, dur, workerStatus, authStatus, laneStatus, aiOverall,
  unavailableStatus, canReEnable, createVisiblePoller, jobsStatus,
} from './worker-health-logic.js';
import bus from '../bus.js';

let _el = null;
let _poller = null;
let _offAuthStatus = null;
let _last = null;
let _lastAt = null;
const _openDetails = new Set();
const _busy = new Set();

function _q(sel) { return _el ? _el.querySelector(sel) : null; }

function _pill(s) {
  return '<span class="' + esc(s.cls) + '"><span class="wh-dot" aria-hidden="true"></span>' + esc(s.label) + '</span>' +
    (s.reason ? '<span class="wh-reason">' + esc(s.reason) + '</span>' : '');
}
function _v(x, suffix) { return x == null ? '—' : esc(x) + (suffix || ''); }
function _kv(rows) {
  return '<dl class="wh-kv">' + rows.map((r) => '<dt>' + esc(r[0]) + '</dt><dd>' + r[1] + '</dd>').join('') + '</dl>';
}
function _card(id, title, sec, bodyFn) {
  let body;
  if (!sec) body = _pill(unavailableStatus({ reason: 'no data' }));
  else if (sec.status !== 'ok') body = _pill(unavailableStatus(sec));
  else {
    try { body = bodyFn(sec); } catch (e) { body = _pill(unavailableStatus({ reason: 'render error' })); }
  }
  return '<section class="wh-card" aria-labelledby="wh-' + id + '-h"><h3 id="wh-' + id + '-h" class="wh-card-title">' +
    esc(title) + '</h3>' + body + '</section>';
}

// ── Workers table ────────────────────────────────────────────────────────────
function _workerRow(w, now) {
  const s = workerStatus(w, now);
  const name = String(w.name || '');
  const c = w.counts || {};
  const failed = (Number(c.fail) || 0) + (Number(c.timeout) || 0);
  const job = w.currentJob
    ? esc(w.currentJob.trigger || 'run') + ' · running ' + esc(dur(Math.max(0, now - Number(w.currentJob.startedAt))))
    : '—';
  const next = s.key === 'recovering' ? esc(s.reason) : esc(relTime(w.nextRunAt, now));
  const errMsg = w.lastError && w.lastError.message ? String(w.lastError.message) : '';
  const err = errMsg
    ? '<span class="wh-err" tabindex="0" title="' + esc(errMsg) + '">' + esc(truncate(errMsg, 60)) + '</span>'
    : '—';
  const label = w.label || name;
  const detailId = 'wh-d-' + name;
  const isOpen = _openDetails.has(name);
  const busy = _busy.has(name);
  const reBtn = canReEnable(w)
    ? '<button type="button" class="sd-btn secondary wh-btn" data-act="reenable" data-name="' + esc(name) + '"' +
      (busy ? ' disabled' : '') + ' aria-label="Re-enable worker ' + esc(label) + '">' + (busy ? 'Re-enabling…' : 'Re-enable') + '</button>'
    : '';
  const detBtn = '<button type="button" class="sd-btn secondary wh-btn" data-act="details" data-name="' + esc(name) + '"' +
    ' aria-expanded="' + (isOpen ? 'true' : 'false') + '" aria-controls="' + esc(detailId) + '"' +
    ' aria-label="View details for worker ' + esc(label) + '">Details</button>';
  return '<tr data-worker="' + esc(name) + '">' +
    '<th scope="row">' + esc(label) + (w.label && w.label !== name ? ' <span class="wh-mono">' + esc(name) + '</span>' : '') + '</th>' +
    '<td>' + _pill(s) + '</td>' +
    '<td>' + esc(relTime(w.lastHeartbeatAt, now)) + '</td>' +
    '<td>' + job + '</td>' +
    '<td>' + next + '</td>' +
    '<td class="wh-mono">' + _v(c.ok) + ' / ' + esc(failed) + ' / ' + _v(c.skip) + '</td>' +
    '<td>' + err + '</td>' +
    '<td class="wh-mono">' + _v(w.restarts) + '/' + _v(w.maxRestarts) + '</td>' +
    '<td class="wh-actions">' + reBtn + detBtn + '</td>' +
    '</tr>' +
    '<tr id="' + esc(detailId) + '" class="wh-detail"' + (isOpen ? '' : ' hidden') + '><td colspan="9">' +
    '<pre class="wh-json">' + esc(JSON.stringify(w, null, 2)) + '</pre></td></tr>';
}

function _workersHtml(sec, now) {
  if (!sec) return '';
  if (sec.status !== 'ok') return '<div class="wh-note">' + _pill(unavailableStatus(sec)) + '</div>';
  if (!sec.enabled) return '<div class="wh-note">Worker supervisor is off (workers.supervisor.enabled).</div>';
  const list = Array.isArray(sec.list) ? sec.list : [];
  const more = typeof sec.total === 'number' && sec.total > list.length ? ' (showing ' + list.length + ' of ' + sec.total + ')' : '';
  return '<table class="wh-table">' +
    '<caption class="wh-cap">Background workers' + esc(more) + (sec.shuttingDown ? ' — shutting down' : '') + '</caption>' +
    '<thead><tr><th scope="col">Worker</th><th scope="col">Status</th><th scope="col">Last heartbeat</th>' +
    '<th scope="col">Current job</th><th scope="col">Next run</th><th scope="col">Done / Failed / Skipped</th>' +
    '<th scope="col">Last error</th><th scope="col">Restarts</th><th scope="col">Actions</th></tr></thead>' +
    '<tbody>' + (list.length ? list.map((w) => _workerRow(w, now)).join('') :
      '<tr><td colspan="9">No workers registered.</td></tr>') + '</tbody></table>';
}

// ── Cards ────────────────────────────────────────────────────────────────────
function _aiCard(a) {
  const l = a.lanes || {};
  const q = a.queue || {};
  const bp = q.byPriority || {};
  const aw = (p) => _v(bp[p] && bp[p].active) + '/' + _v(bp[p] && bp[p].waiting);
  const pool = a.claudePool || {};
  const lat = (a.latency && a.latency.byPriority) || {};
  const latRows = Object.keys(lat).map((p) => [
    'p95 ' + p, _v(lat[p].p95LatencyMs, ' ms') + ' <span class="wh-reason">wait p95 ' + _v(lat[p].p95QueueWaitMs, ' ms') + ' · n=' + _v(lat[p].count) + '</span>',
  ]);
  const ov = aiOverall(a.overall && a.overall.status);
  if (a.overall && a.overall.reasons && a.overall.reasons.length) ov.reason = a.overall.reasons.join('; ');
  return _kv([
    ['Overall', _pill(ov)],
    ['Fleet Brain', _pill(laneStatus(l.fleetBrain))],
    ['Orcha', _pill(laneStatus(l.orcha))],
    ['Claude', _pill(laneStatus(l.claude))],
    ['Bedrock', _pill(laneStatus(l.bedrock))],
    ['Queue a/w', '<span class="wh-mono">C ' + aw('critical') + ' H ' + aw('high') + ' N ' + aw('normal') + ' L ' + aw('low') + '</span>'],
    ['Active', _v(q.active) + ' / ' + _v(q.max) + ' (reserve ' + _v(q.reserve) + ')'],
    ['Oldest wait', q.oldestWaitMs == null ? '—' : esc(dur(q.oldestWaitMs))],
    ['Claude pool', _v(pool.busy) + ' / ' + _v(pool.size) + ' busy · ' + _v(pool.queued) + ' queued'],
  ].concat(latRows.length ? latRows : [['p95 latency', '—']]).concat([['As of', esc(relTime(a.at, Date.now()))]]));
}

function _authCard(a) {
  const k = a.keepAlive;
  // auth.propagation rows (fields present only with the flag on).
  const extra = [];
  if (a.message != null) extra.push(['Status', _v(a.message)]);
  if (a.verifiedAt != null) extra.push(['Verified', esc(relTime(a.verifiedAt, Date.now())) + (a.verifiedBy ? ' <span class="wh-reason">' + esc(a.verifiedBy) + '</span>' : '')]);
  if (a.nextRetryAt != null) extra.push(['Next retry', esc(relTime(a.nextRetryAt, Date.now()))]);
  if (a.liveAea != null) extra.push(['AEA (live)', _v(a.liveAea, ' min')]);
  return _kv([
    ['Midway', _pill(authStatus(a))],
    ['State', _v(a.state)],
  ].concat(extra).concat([
    ['Online', a.online == null ? '—' : (a.online ? 'yes' : 'no')],
    ['Session left', _v(a.sessionExpiresInMin, ' min')],
    ['AEA left', _v(a.aeaExpiresInMin, ' min')],
    ['Checked', esc(relTime(a.at, Date.now()))],
    ['AEA keep-alive', k ? (esc(k.running ? 'running' : 'stopped') + (k.state ? ' · ' + esc(k.state) : '')) : '—'],
    ['Keep-alive fails', k ? _v(k.consecutiveFailures) : '—'],
    ['Last keep-alive', k ? (esc(relTime(k.lastAt, Date.now())) + (k.lastOk == null ? '' : (k.lastOk ? ' · ok' : ' · failed')) +
      (k.lastReason ? ' <span class="wh-reason">' + esc(truncate(k.lastReason, 80)) + '</span>' : '')) : '—'],
  ]));
}

function _slackCard(s) {
  const now = Date.now();
  const rows = [['Mode', _v(s.mode) + (s.configuredMode && s.configuredMode !== s.mode ? ' (configured ' + esc(s.configuredMode) + ')' : '')]];
  if (s.startError) rows.push(['Start error', '<span class="wh-err" tabindex="0" title="' + esc(s.startError) + '">' + esc(truncate(s.startError, 60)) + '</span>']);
  const polls = s.polls || {};
  for (const kind of Object.keys(polls)) {
    const p = polls[kind] || {};
    const sk = p.skipped || {};
    const skipped = Object.keys(sk).map((k) => esc(k) + ' ' + esc(sk[k])).join(', ') || '—';
    rows.push([kind, (p.inFlight ? 'polling · ' : '') + (p.stalled ? '<strong>stalled</strong> · ' : '') +
      'last ' + esc(relTime(p.lastEndAt, now)) + ' (' + (p.lastDurationMs == null ? '—' : esc(p.lastDurationMs) + ' ms') + ')' +
      ' · next ' + esc(relTime(p.nextRunAt, now)) +
      '<span class="wh-reason">runs ' + _v(p.runs) + ' · fails ' + _v(p.fails) + ' · skipped: ' + skipped + '</span>' +
      (p.lastError ? '<span class="wh-reason wh-err" tabindex="0" title="' + esc(p.lastError) + '">' + esc(truncate(p.lastError, 60)) + '</span>' : '')]);
  }
  return _kv(rows);
}

const CH_LABELS = { sharepoint: 'SharePoint', email: 'Email', dbrAfp: 'DBR AFP', dbrDsp: 'DBR DSP' };
const CH_ENABLED = { sharepoint: 'sp', email: 'email', dbrAfp: 'dbr', dbrDsp: 'dbr' };

function _schedulerCard(s) {
  const now = Date.now();
  const rows = [];
  const ch = s.channels || {};
  for (const c of Object.keys(CH_LABELS)) {
    const x = ch[c];
    if (!x) continue;
    const ek = CH_ENABLED[c];
    const en = s.enabled ? s.enabled[ek] : null;
    const ns = s.nextSlot ? s.nextSlot[ek] : null;
    let v = (en ? 'on' : 'off') + (ns ? ' · next ' + esc(ns.label) + ' (' + esc(ns.when) + ')' : '');
    v += '<span class="wh-reason">verified ' + (x.lastVerified ? esc(x.lastVerified.slotLabel) + ' ' + esc(x.lastVerified.dateKey) : '—') +
      ' · active ' + esc(x.active) + ' · retrying ' + esc(x.retrying) + '</span>';
    if (x.lastFailure) {
      v += '<span class="wh-reason">last failure ' + esc(x.lastFailure.slotLabel) + ' ' + esc(x.lastFailure.dateKey) + ' (' + esc(x.lastFailure.state) + ')' +
        (x.lastFailure.error ? ' <span class="wh-err" tabindex="0" title="' + esc(x.lastFailure.error) + '">' + esc(truncate(x.lastFailure.error, 50)) + '</span>' : '') + '</span>';
    }
    if (x.blockedCount) {
      v += '<div>' + _pill({ cls: 'wh-st wh-st--degraded', label: 'blocked: ' + x.blockedCount, reason: '' }) +
        (x.blocked || []).map((j) => '<span class="wh-reason">' + esc(j.slotLabel) + ' ' + esc(j.dateKey) + ' · ' + esc(j.state) + '</span>').join('') + '</div>';
    }
    if (x.uncertainCount) {
      v += '<div>' + _pill({ cls: 'wh-st wh-st--degraded', label: 'uncertain: ' + x.uncertainCount, reason: '' }) +
        (x.uncertain || []).map((j) => '<span class="wh-reason">' + esc(j.slotLabel) + ' ' + esc(j.dateKey) + ' · ' + esc(j.state) + '</span>').join('') + '</div>';
    }
    rows.push([CH_LABELS[c], v]);
  }
  rows.push(['As of', esc(relTime(s.at, now))]);
  return _kv(rows);
}

// Phase 7 durable jobs (read-only).
export function _jobsCard(j) {
  const now = Date.now();
  const rows = [['Status', _pill(jobsStatus(j))], ['Mode', _v(j.mode) + (j.reason ? ' <span class="wh-reason">' + esc(truncate(j.reason, 80)) + '</span>' : '')]];
  const ts = j.types || {};
  for (const t of Object.keys(ts)) rows.push([t, _v(ts[t] && ts[t].mode)]);
  const cs = j.counts || {};
  for (const t of Object.keys(cs)) {
    const c = cs[t] || {};
    const parts = Object.keys(c).map((s) => esc(s) + ' ' + esc(c[s])).join(' · ');
    rows.push([t + ' jobs', '<span class="wh-mono">' + (parts || '—') + '</span>']);
  }
  const tot = j.totals || {};
  rows.push(['Open / failed 24h', _v(tot.open) + ' / ' + _v(tot.failed24h) + (tot.foreign ? ' <span class="wh-reason">' + esc(tot.foreign) + ' from a newer build</span>' : '')]);
  const or = j.oldestRunning;
  rows.push(['Oldest running', or ? esc(or.type) + ' ' + esc(or.scopeKey) + ' · started ' + esc(relTime(or.startedAt, now)) +
    ' · attempt ' + _v(or.attempt) + (or.leaseExpired ? ' <strong>lease expired</strong>' : '') : '—']);
  const rr = Array.isArray(j.recoveryRequired) ? j.recoveryRequired : [];
  if (rr.length) {
    rows.push(['Needs reconciliation', rr.map((r) => '<span class="wh-reason">' + esc(r.type) + ' ' + esc(r.scopeKey) +
      (r.lastError ? ' — ' + esc(truncate(r.lastError, 60)) : '') + '</span>').join('')]);
  }
  if (j.lastRecovery) {
    const lr = j.lastRecovery;
    rows.push(['Last recovery', esc(relTime(lr.at, now)) + ' <span class="wh-reason">requeued ' + _v(lr.requeued) + ' · needs reconciliation ' +
      _v(lr.recoveryRequired) + ' · failed ' + _v(lr.failed) + ' · cancelled ' + _v(lr.cancelled) + '</span>']);
  }
  return _kv(rows);
}

function _resourcesCard(r) {
  const el = r.eventLoop || {};
  const m = r.main || {};
  const rd = r.renderer || {};
  const t = r.total || {};
  const w = r.windows || {};
  const rows = [
    ['Event loop', _v(el.p50Ms) + ' / <strong>' + _v(el.p99Ms) + '</strong> / ' + _v(el.maxMs) + ' ms <span class="wh-reason">p50 / p99 / max</span>'],
    ['Main', 'RSS ' + _v(m.rssMb, ' MB') + ' · heap ' + _v(m.heapUsedMb, ' MB') + ' · CPU ' + _v(m.cpuPct, '%')],
    ['Renderer', _v(rd.workingSetMb, ' MB') + ' · CPU ' + _v(rd.cpuPct, '%') + ' (' + _v(rd.count) + ')'],
    ['Total', _v(t.workingSetMb, ' MB') + ' · CPU ' + _v(t.cpuPct, '%') + ' (' + _v(t.count) + ' procs)'],
    ['Windows', _v(w.visible) + ' visible / ' + _v(w.total)],
  ];
  for (const tr of (r.topTracks || [])) {
    rows.push([tr.name, 'p95 ' + _v(tr.p95Ms, ' ms') + ' · max ' + _v(tr.maxMs, ' ms') + ' <span class="wh-reason">n=' + _v(tr.count) + ' · fail ' + _v(tr.fail) + '</span>']);
  }
  rows.push(['Sampled', esc(relTime(r.at, Date.now()))]);
  return _kv(rows);
}

// ── Render ───────────────────────────────────────────────────────────────────
function _renderUpdated() {
  const u = _q('.wh-updated');
  if (u) u.textContent = _lastAt ? 'Updated ' + relTime(_lastAt, Date.now()) : 'Loading…';
}

function _render() {
  const body = _q('#wh-content');
  if (!body) return;
  const d = _last;
  if (!d) { body.innerHTML = '<div class="wh-note">Loading…</div>'; return; }
  if (!d.ok) {
    body.innerHTML = '<div class="wh-note">' + _pill(unavailableStatus({ reason: d.code || d.error || 'unavailable' })) + '</div>';
    return;
  }
  const now = Date.now();
  body.innerHTML = _workersHtml(d.workers, now) +
    '<div class="wh-grid">' +
    _card('ai', 'AI', d.ai, _aiCard) +
    _card('auth', 'Auth health', d.auth, _authCard) +
    _card('slack', 'Slack poller', d.slack, _slackCard) +
    _card('sched', 'Scheduler', d.scheduler, _schedulerCard) +
    _card('jobs', 'Durable jobs', d.jobs, _jobsCard) +
    _card('res', 'Resources', d.resources, _resourcesCard) +
    '</div>';
  _renderUpdated();
}

async function _load() {
  try {
    _last = await window.health.snapshot();
  } catch (e) {
    _last = { ok: false, error: (e && e.message) || 'unavailable' };
  }
  _lastAt = Date.now();
  _render();
}

function _setMsg(t) { const m = _q('#wh-msg'); if (m) m.textContent = t || ''; }

async function _reEnable(name, btn) {
  if (!name || _busy.has(name)) return;
  _busy.add(name);
  if (btn) { btn.disabled = true; btn.textContent = 'Re-enabling…'; }
  const w = _last && _last.workers && Array.isArray(_last.workers.list) ? _last.workers.list.find((x) => x.name === name) : null;
  const label = (w && w.label) || name;
  try {
    const r = await window.workers.reEnable(name);
    if (r && r.ok && r.reEnabled) _setMsg('Re-enabled ' + label);
    else if (r && r.ok) _setMsg('Not eligible: already running or stopped');
    else _setMsg('Refused: ' + ((r && r.code) || 'unknown'));
  } catch (e) {
    _setMsg('Refused: ' + ((e && e.message) || 'error'));
  } finally {
    _busy.delete(name);
  }
  if (_poller) _poller.refreshNow();
}

function _toggleDetails(name) {
  if (!name) return;
  const open = !_openDetails.has(name);
  if (open) _openDetails.add(name); else _openDetails.delete(name);
  const row = _el ? _el.querySelector('#' + CSS.escape('wh-d-' + name)) : null;
  if (row) row.hidden = !open;
  const btn = _el ? _el.querySelector('button[data-act="details"][data-name="' + CSS.escape(name) + '"]') : null;
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function _onClick(e) {
  const btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
  if (!btn || !_el || !_el.contains(btn)) return;
  const act = btn.getAttribute('data-act');
  const name = btn.getAttribute('data-name');
  if (act === 'refresh') { _setMsg(''); if (_poller) _poller.refreshNow(); }
  else if (act === 'reenable') _reEnable(name, btn);
  else if (act === 'details') _toggleDetails(name);
}

function _onVisibility() { if (_poller) _poller.onVisibilityChange(); }

export function mount(container) {
  unmount();
  _el = container;
  if (!_el) return null;
  if (!window.health || typeof window.health.snapshot !== 'function') {
    _el.innerHTML = '<div class="wh-note">Worker health unavailable.</div>';
    return _el;
  }
  _el.innerHTML =
    '<div class="wh">' +
      '<div class="wh-bar">' +
        '<span class="wh-updated" aria-live="off">Loading…</span>' +
        '<button type="button" class="sd-btn secondary wh-btn" data-act="refresh" id="wh-refresh" aria-label="Refresh worker health now">Refresh</button>' +
        '<span id="wh-msg" class="wh-msg" role="status" aria-live="polite"></span>' +
      '</div>' +
      '<div id="wh-content"><div class="wh-note">Loading…</div></div>' +
    '</div>';
  _el.addEventListener('click', _onClick);
  document.addEventListener('visibilitychange', _onVisibility);
  _poller = createVisiblePoller({
    run: _load,
    intervalMs: 15000,
    isVisible: () => document.visibilityState !== 'hidden',
  });
  _poller.setOpen(true);
  // auth.propagation: re-read the snapshot when the single auth status
  // changes while mounted (never emitted with the flag off).
  _offAuthStatus = bus.on('auth:status', () => { if (_poller) _poller.refreshNow(); });
  return _el;
}

export function unmount() {
  if (_offAuthStatus) { _offAuthStatus(); _offAuthStatus = null; }
  if (_poller) { _poller.stop(); _poller = null; }
  document.removeEventListener('visibilitychange', _onVisibility);
  if (_el) _el.removeEventListener('click', _onClick);
  _el = null;
}

export default { mount, unmount };

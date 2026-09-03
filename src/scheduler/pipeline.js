'use strict';
/**
 * scheduler/pipeline.js — Central backend delivery pipeline (Task #7).
 *
 * The single place that turns a scheduled/catch-up/manual trigger into a
 * verified delivery, driven entirely from the durable ledger:
 *
 *   trigger -> getOrCreateJob (idempotent) -> acquireLease (overlap guard)
 *     -> SYNCING   (runFullSync structured result)
 *     -> VALIDATING (freshness gate; block -> BLOCKED_STALE_DATA)
 *     -> RUNNING
 *          SharePoint: pushToSharePoint (read-back verified)
 *          Email:      buildEmail per operator/domicile/SOS+EOS
 *                      -> sendViaOwa (hidden, Sent-Items verified)
 *     -> VERIFYING -> SENT
 *     -> COMPLETED  (commit snapshot AFTER verify; clear one-shot note ONLY
 *                    after ALL intended production recipients verified sent)
 *
 * Failure handling:
 *   blocked-auth       -> BLOCKED_AUTH  (notify; resume same job after re-auth)
 *   delivery-uncertain -> DELIVERY_UNCERTAIN (never auto-resend; reconcile)
 *   partial-failure    -> PARTIAL_FAILURE
 *   transient failure  -> scheduleRetry (bounded backoff; exhaust -> FAILED)
 *
 * This module keeps its PURE decision logic (recipient resolution + dedup,
 * scope keys, subject/test-mode transforms, notification dedup) separate from
 * the Electron-touching execution so the important rules are unit-tested with
 * no live email / SharePoint / BrowserWindow.
 *
 * NO SMTP. NO Graph. NO fallback. Email goes out ONLY via the hidden OWA
 * service (scrapers/owa-mailer.js). No real email/SharePoint is exercised in
 * development — only mocked tests, until the live acceptance checklist.
 */

const store  = require('../store');
const ledger = require('./ledger');
const freshness = require('./freshness');
let logger; try { logger = require('../utils/logger')('scheduler-pipeline'); } catch (_) { logger = { info(){}, warn(){}, error(){} }; }

const SERIES = Object.freeze(['SOS', 'EOS']);

// ── Injectable dependency seam (Task #7) ───────────────────────────────────────
// The Electron-touching collaborators are resolved through this seam so tests
// can substitute fakes without a live BrowserWindow / SharePoint / mailbox.
// Production reads the real modules lazily (require on first access).
const _overrides = {};   // test-supplied replacements (win over the real modules)
const _cache = {};       // lazily-required real modules
const _deps = {
  get pushToSharePoint() { if (_overrides.pushToSharePoint) return _overrides.pushToSharePoint; if (!_cache.sp) _cache.sp = require('../scrapers/sharepoint_push'); return _cache.sp.pushToSharePoint; },
  get sendViaOwa()       { if (_overrides.sendViaOwa) return _overrides.sendViaOwa; if (!_cache.owa) _cache.owa = require('../scrapers/owa-mailer'); return _cache.owa.sendViaOwa; },
  get buildEmail()       { if (_overrides.buildEmail) return _overrides.buildEmail; if (!_cache.builder) _cache.builder = require('../scrapers/emailBuilder'); return _cache.builder.buildEmail; },
  get summary()          { if (_overrides.summary) return _overrides.summary; if (!_cache.summary) _cache.summary = require('../scrapers/email-summary'); return _cache.summary; },
};
// Test hook: override any of { pushToSharePoint, sendViaOwa, buildEmail, summary }.
function _setDeps(overrides) { Object.assign(_overrides, overrides || {}); }

// ── Pure helpers (unit-tested, no Electron) ────────────────────────────────────

// Normalize a single email address (accepts "Name <email>" too).
function _normAddr(a) {
  const s = String(a || '').trim();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

// Split a to/cc field (string or array) into a normalized, de-duped address list.
function _splitAddrs(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[;,]/);
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const a = _normAddr(raw);
    if (a && !seen.has(a)) { seen.add(a); out.push(a); }
  }
  return out;
}

/**
 * resolveRecipients(opEmails, spEmails) -> [{ key, operator, domicile, to:[], cc:[] }]
 * Merges the two sources the renderer used, but with STRONG dedup:
 *   - op_emails.json  : keyed by operator name  -> domicile 'ALL'
 *   - spConfig.emails : keyed 'Op__DOM'         -> per-domicile
 * A spConfig entry for an operator that already has an op_emails 'ALL' entry is
 * still included (it targets a specific domicile), but duplicate keys collapse.
 * Within each entry, addresses are normalized+de-duped and any address that
 * appears in To is removed from Cc (no To/Cc overlap).
 */
function resolveRecipients(opEmails, spEmails) {
  const entries = [];
  const byKey = new Map();

  const add = (key, operator, domicile, rec) => {
    if (!rec) return;
    const to = _splitAddrs(rec.to);
    let cc = _splitAddrs(rec.cc);
    if (!to.length && !cc.length) return;
    // No To/Cc overlap — To wins.
    const toSet = new Set(to);
    cc = cc.filter(a => !toSet.has(a));
    const e = { key, operator, domicile: domicile || 'ALL', to, cc };
    if (byKey.has(key)) return; // collapse duplicate keys
    byKey.set(key, e);
    entries.push(e);
  };

  const op = opEmails && typeof opEmails === 'object' ? opEmails : {};
  for (const name of Object.keys(op)) add(name, name, 'ALL', op[name]);

  const sp = spEmails && typeof spEmails === 'object' ? spEmails : {};
  for (const k of Object.keys(sp)) {
    const [operator, dom] = String(k).split('__');
    add(k, operator, dom || 'ALL', sp[k]);
  }
  return entries;
}

// Per operator/domicile/slot scope key for snapshot history.
function scopeKey(operator, domicile, slotLabel) {
  return [String(operator || 'ALL').toUpperCase(), String(domicile || 'ALL').toUpperCase(), slotLabel].join('_');
}

// HH:MM -> AM/PM label the email template + subject builder expect.
function slotToAmPm(slot) {
  const s = String(slot || '');
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return /pm/i.test(s) ? 'PM' : 'AM';
  return parseInt(m[1], 10) < 12 ? 'AM' : 'PM';
}

/**
 * applyTestMode(base, opts) -> { subject, to, cc, banner, intendedRecipients, actualRecipients }
 * In production: pass through. In test mode: subject prefixed [TEST], recipients
 * REPLACED with the configured test recipient(s), intended-vs-actual recorded
 * separately, and a banner surfaced. Callers MUST have already checked a test
 * recipient exists (see testRecipientsFor / gate below).
 */
function applyTestMode(base, opts) {
  opts = opts || {};
  const intendedTo = _splitAddrs(base.to);
  const intendedCc = _splitAddrs(base.cc);
  if (!opts.testMode) {
    return { subject: base.subject, to: intendedTo, cc: intendedCc, banner: opts.banner || null,
      intendedRecipients: [...intendedTo, ...intendedCc], actualRecipients: [...intendedTo, ...intendedCc] };
  }
  const testTo = _splitAddrs(opts.testRecipients);
  const subject = /^\[TEST\]/i.test(base.subject) ? base.subject : '[TEST] ' + base.subject;
  const banner = opts.banner ||
    ('TEST MODE — this message would have gone to: ' + [...intendedTo, ...intendedCc].join(', ') || '(none)');
  return { subject, to: testTo, cc: [], banner,
    intendedRecipients: [...intendedTo, ...intendedCc], actualRecipients: testTo };
}

// The configured test recipient list. Blocks test sends when empty.
// Per the product owner: default to the logged-in user's OWN profile email
// (settings.profile.email, captured as "Amazon Email" in the setup wizard) so
// test-mode sends land in the user's own inbox without any hardcoded address.
// An explicit override (emailTestRecipient / schedulerTest.recipient) still
// wins if one is configured.
function testRecipientsFor() {
  const s = store.load('settings', {}) || {};
  return _splitAddrs(
    s.emailTestRecipient ||
    s.testEmailRecipient ||
    (s.schedulerTest && s.schedulerTest.recipient) ||
    (s.profile && s.profile.email) ||
    ''
  );
}

// Notification dedup: one notice per (jobId, state). Returns true if this
// (jobId,state) has NOT been seen yet (i.e. the caller SHOULD notify).
const _notifiedKeys = new Set();
function shouldNotify(jobId, state) {
  const k = jobId + '|' + state;
  if (_notifiedKeys.has(k)) return false;
  _notifiedKeys.add(k);
  return true;
}
function _resetNotifyDedup() { _notifiedKeys.clear(); }

// Wrap an HTML body with a visible test/stale banner at the top of <body>.
function injectBanner(html, banner) {
  if (!banner) return html;
  const bar = '<div style="background:#fff3cd;border:2px solid #ffc107;color:#664d03;padding:10px 14px;font-family:Arial,sans-serif;font-weight:700;font-size:13px;border-radius:6px;margin-bottom:12px">' +
    String(banner).replace(/</g, '&lt;') + '</div>';
  if (/<body[^>]*>/i.test(html)) return html.replace(/(<body[^>]*>)/i, '$1' + bar);
  return bar + html;
}

// Classify an error into 'transient' (retryable) vs 'permanent'.
function classifyError(message) {
  const m = String(message || '').toLowerCase();
  if (/timeout|network|econn|socket|temporar|rate.?limit|503|502|429/.test(m)) return 'transient';
  if (/auth|login|mfa|consent|forbidden|401|403/.test(m)) return 'permanent';
  return 'transient';
}

module.exports = {
  SERIES,
  resolveRecipients, scopeKey, slotToAmPm, applyTestMode, testRecipientsFor,
  shouldNotify, injectBanner, classifyError,
  _splitAddrs, _normAddr, _resetNotifyDedup, _setDeps,
  // execution wired below
};

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTION (Electron-touching) — kept below the pure exports so the helpers can
// be required and tested without pulling in electron at module-eval time.
// ─────────────────────────────────────────────────────────────────────────────

// Build the email HTML for one scope (operator/domicile/series). Reuses the
// existing, preserved emailBuilder — the SOS/EOS design is untouched.
function _buildScopeEmail(ctx, scope, slotAmPm, opts) {
  const buildEmail = _deps.buildEmail;
  const relayCache = store.load('relayCache', {});
  const notesStore = store.load('notesStore', {});
  const fd = store.load('fleetData', { rows: [] });
  const rawRows = Array.isArray(fd.rows) ? fd.rows : [];
  // Map the persisted fleet rows into the email unit shape (same fields the
  // renderer/email:compose path used).
  const units = rawRows.map(r => ({
    id: r.equipmentId || '', op: r.operator || '', site: r.domicileSite || '',
    model: (r.manufacturer || r.make || '').trim() || '--',
    bodyType: r.bodyType || r.assetType || '', fuelType: r.fuelType || '',
    atsState: r.lifecycleState || '', relayStatus: r.lifecycleReason || '',
    riskScore: r.riskScore || 0,
    riskTier: r.riskScore >= 75 ? 'HIGH' : r.riskScore >= 50 ? 'MEDIUM' : 'LOW',
    vendor: r.vendor || '', duration: r.workDuration || '',
    issue: r.issueDetails || '', created: r.created || '',
    altId: r.alternativeId || '', serviceUrl: r.serviceUrl || '',
    offsiteShopEvent: r.offsiteShopEvent || '', offsiteShopEventUrl: r.offsiteShopEventUrl || '',
    savedRepairStatus: r.savedRepairStatus || '', savedPrimaryComponent: r.savedPrimaryComponent || '',
    savedSalesforceCase: r.savedSalesforceCase || r.salesforceCase || '',
    savedSalesforceCaseUrl: r.savedSalesforceCaseUrl || r.salesforceCaseUrl || '',
    savedOffsiteEvent: r.savedOffsiteEvent || '', savedOffsiteUrl: r.savedOffsiteUrl || '',
    savedNotes: r.savedNotes || '', insightsList: r.insightsList || [], geofence: r.geofence || '',
  }));
  const html = buildEmail({
    operator: scope.operator, domicile: scope.domicile, units,
    slot: slotAmPm, testMode: !!opts.testMode, relayCache, notesStore,
    emailNote: opts.emailNote || '',
  });
  return { html, buildEmailRef: buildEmail, unitsForSnapshot: units };
}

// Status + notification helper (declared here, after the pure exports) — pushes a renderer status event and (deduped)
// a desktop notification for the states the spec requires operators to see.
function _notify(ctx, job, extra) {
  try { if (ctx && ctx.send) ctx.send('scheduler:job-update', { jobId: job.jobId, channel: job.channel, state: job.state, slot: job.slotLabel, testMode: job.testMode, scope: job.scope, extra: extra || null }); } catch (_) {}
  const notifyStates = [ledger.STATES.BLOCKED_AUTH, ledger.STATES.BLOCKED_STALE_DATA, ledger.STATES.DELIVERY_UNCERTAIN, ledger.STATES.PARTIAL_FAILURE, ledger.STATES.FAILED, ledger.STATES.COMPLETED];
  if (notifyStates.includes(job.state) && shouldNotify(job.jobId, job.state)) {
    try {
      const { Notification } = require('electron');
      if (Notification && Notification.isSupported && Notification.isSupported()) {
        const titles = {
          [ledger.STATES.BLOCKED_AUTH]: 'OWA sign-in required',
          [ledger.STATES.BLOCKED_STALE_DATA]: 'Scheduled delivery blocked — stale data',
          [ledger.STATES.DELIVERY_UNCERTAIN]: 'Delivery unconfirmed — needs reconcile',
          [ledger.STATES.PARTIAL_FAILURE]: 'SharePoint push partially failed',
          [ledger.STATES.FAILED]: 'Scheduled job failed',
          [ledger.STATES.COMPLETED]: 'Scheduled delivery verified',
        };
        new Notification({ title: titles[job.state] || 'Scheduler', body: (job.channel + ' ' + job.slotLabel + (job.testMode ? ' [TEST]' : '')) }).show();
      }
    } catch (_) {}
  }
}

// ── Shared sync + freshness gate ───────────────────────────────────────────────
// Runs a fresh sync, records the structured result on the job, then applies the
// per-channel freshness policy. Returns { proceed, banner } or throws to retry.
async function _syncAndGate(ctx, job) {
  await ledger.transition(job.jobId, ledger.STATES.SYNCING, {}, 'sync start');
  let sync;
  try {
    sync = await ctx.runFullSync();
  } catch (e) {
    sync = { ok: false, errors: [{ source: 'sync', message: e.message }] };
  }
  await ledger.transition(job.jobId, ledger.STATES.VALIDATING, { syncResult: _redactSync(sync) }, 'freshness gate');
  const decision = freshness.evaluate(sync, { channel: job.channel, testMode: job.testMode });
  if (decision.block) {
    const r = await ledger.transition(job.jobId, ledger.STATES.BLOCKED_STALE_DATA,
      { error: { class: 'stale-data', message: decision.reasons.join('; ') } }, 'blocked: ' + decision.reasons.join('; '));
    _notify(ctx, r.ok ? r.job : ledger.getJob(job.jobId), { reasons: decision.reasons });
    return { proceed: false, banner: null };
  }
  return { proceed: true, banner: decision.banner || null };
}

function _redactSync(s) {
  if (!s) return null;
  return { ok: s.ok, rowCount: s.rowCount, syncedAt: s.syncedAt, dataAgeMs: s.dataAgeMs,
    sourcesUpdated: s.sourcesUpdated, sourcesFailed: s.sourcesFailed, usedCache: s.usedCache };
}

// ── SharePoint job ─────────────────────────────────────────────────────────────
async function runSharePointJob(ctx, spec) {
  const { job, created } = await ledger.getOrCreateJob({ ...spec, channel: ledger.CHANNELS.SHAREPOINT });
  if (!created) {
    if (job.state === ledger.STATES.COMPLETED) { logger.info('SP job already completed today — no-op'); return { skipped: 'already-completed', job }; }
    if (ledger.PAUSED_STATES.includes(job.state) && job.state !== ledger.STATES.RETRY) { logger.info('SP job in ' + job.state + ' — not auto-rerun'); return { skipped: job.state, job }; }
  }
  const lease = await ledger.acquireLease(ledger.CHANNELS.SHAREPOINT, job.jobId);
  if (!lease.ok) { logger.info('SP channel busy — skipping'); return { skipped: 'channel-busy', job }; }

  try {
    const gate = await _syncAndGate(ctx, job);
    if (!gate.proceed) { await ledger.releaseLease(ledger.CHANNELS.SHAREPOINT, job.jobId); return { blocked: 'stale-data', job: ledger.getJob(job.jobId) }; }

    await ledger.transition(job.jobId, ledger.STATES.RUNNING, {}, 'sharepoint push');
    const rows = (ctx.lastData && ctx.lastData.rows) || (store.load('fleetData', {}).rows) || [];
    const pushToSharePoint = _deps.pushToSharePoint;
    const win = ctx.getMainWindow && ctx.getMainWindow();
    const result = await pushToSharePoint(rows, (msg, type) => {
      logger.info('[SP] ' + (type || 'info') + ' | ' + msg);
      if (win && !win.isDestroyed()) win.webContents.send('sp:progress', { message: msg, type });
    });

    await ledger.transition(job.jobId, ledger.STATES.VERIFYING, { deliveryResult: _redactSp(result) }, 'read-back verify');
    if (result.ok) {
      const done = await ledger.transition(job.jobId, ledger.STATES.COMPLETED, {}, 'verified: ' + result.status);
      _notify(ctx, done.ok ? done.job : ledger.getJob(job.jobId));
      return { ok: true, job: ledger.getJob(job.jobId), result };
    }
    if (result.status === 'partial-failure' || result.status === 'verification-pending') {
      const p = await ledger.transition(job.jobId, ledger.STATES.PARTIAL_FAILURE,
        { error: { class: 'sp', message: result.status } }, result.status);
      _notify(ctx, p.ok ? p.job : ledger.getJob(job.jobId));
      return { partial: result.status, job: ledger.getJob(job.jobId), result };
    }
    // Hard failure (auth/digest/failed) -> retry with backoff.
    const rt = await ledger.scheduleRetry(job.jobId, { class: classifyError(result.status), message: (result.errors || []).join('; ') || result.status });
    if (rt.exhausted) _notify(ctx, ledger.getJob(job.jobId));
    return { failed: result.status, job: ledger.getJob(job.jobId), result };
  } catch (e) {
    logger.error('SP job error:', e.message);
    await ledger.scheduleRetry(job.jobId, { class: classifyError(e.message), message: e.message });
    return { error: e.message, job: ledger.getJob(job.jobId) };
  } finally {
    await ledger.releaseLease(ledger.CHANNELS.SHAREPOINT, job.jobId);
  }
}

function _redactSp(r) {
  if (!r) return null;
  return { ok: r.ok, status: r.status, workbooksAttempted: r.workbooksAttempted, workbooksSucceeded: r.workbooksSucceeded,
    workbooksFailed: r.workbooksFailed, rowsVerified: r.rowsVerified, readBack: r.readBack };
}

// ── Email job (one job per operator/domicile/series scope) ──────────────────────
// The scheduler creates ONE logical email trigger per slot; this function fans
// it out into per-scope jobs (operator × domicile × SOS/EOS), each with its own
// idempotency key, delivery + verification, snapshot commit, and note-clear
// contribution. The one-shot note is cleared only after ALL production scopes
// for the slot verified sent.
async function runEmailSlot(ctx, slotSpec) {
  const opEmails = _loadOpEmails();
  const spEmails = (store.load('spConfig', {}) || {}).emails || {};
  const recipients = resolveRecipients(opEmails, spEmails);
  if (!recipients.length) { logger.warn('Email slot ' + slotSpec.slotLabel + ': no recipients configured'); return { skipped: 'no-recipients' }; }

  const testMode = !!slotSpec.testMode;
  let testRecips = [];
  if (testMode) {
    testRecips = testRecipientsFor();
    if (!testRecips.length) { logger.warn('Test email blocked: no test recipient configured'); return { blocked: 'no-test-recipient' }; }
  }

  // One-shot note captured ONCE for the whole slot; cleared only after all
  // production scopes verified sent.
  const settings = store.load('settings', {});
  const oneShotActive = !!(settings.autoEmailNote && settings.autoEmailNoteOneShot);
  const emailNote = settings.autoEmailNote || '';
  const slotAmPm = slotToAmPm(slotSpec.slotLabel);

  const outcomes = [];
  for (const rec of recipients) {
    for (const series of SERIES) {
      const scope = { operator: rec.operator, domicile: rec.domicile, series };
      const outcome = await _runOneEmailScope(ctx, {
        ...slotSpec, scope, recipient: rec, testMode, testRecips, emailNote, slotAmPm,
      });
      outcomes.push(outcome);
    }
  }

  // Clear the one-shot note only if EVERY production scope reached COMPLETED.
  if (oneShotActive && !testMode) {
    const allSent = outcomes.length > 0 && outcomes.every(o => o.state === ledger.STATES.COMPLETED);
    if (allSent) {
      const s2 = store.load('settings', {});
      delete s2.autoEmailNote; s2.autoEmailNoteOneShot = false;
      store.save('settings', s2);
      logger.info('One-shot auto-email note cleared — all production scopes verified sent');
    } else {
      logger.info('One-shot note RETAINED — not all scopes verified sent (' + outcomes.filter(o => o.state === ledger.STATES.COMPLETED).length + '/' + outcomes.length + ')');
    }
  }
  return { outcomes };
}

async function _runOneEmailScope(ctx, o) {
  const spec = {
    channel: ledger.CHANNELS.EMAIL, dateKey: o.dateKey, slotLabel: o.slotLabel,
    scope: o.scope, origin: o.origin, testMode: o.testMode,
  };
  const { job, created } = await ledger.getOrCreateJob(spec);
  if (!created) {
    if (job.state === ledger.STATES.COMPLETED) return { state: job.state, scope: o.scope, skipped: 'already-completed' };
    if (ledger.PAUSED_STATES.includes(job.state) && job.state !== ledger.STATES.RETRY) return { state: job.state, scope: o.scope, skipped: job.state };
  }
  const lease = await ledger.acquireLease(ledger.CHANNELS.EMAIL, job.jobId);
  if (!lease.ok) return { state: job.state, scope: o.scope, skipped: 'channel-busy' };

  try {
    const gate = await _syncAndGate(ctx, job);
    if (!gate.proceed) { await ledger.releaseLease(ledger.CHANNELS.EMAIL, job.jobId); return { state: ledger.STATES.BLOCKED_STALE_DATA, scope: o.scope }; }

    await ledger.transition(job.jobId, ledger.STATES.RUNNING, {}, 'build + owa send');

    // Build the scoped email (preserved SOS/EOS builder).
    const built = _buildScopeEmail(ctx, o.scope, o.slotAmPm, { testMode: o.testMode, emailNote: o.emailNote });
    let html = built.html;
    // Subject: reuse the builder's computed suffix if present.
    let subject = 'Fleet Status ' + o.scope.operator + (o.scope.domicile && o.scope.domicile !== 'ALL' ? ' / ' + o.scope.domicile : '') + ' — ' + o.scope.series + ' ' + o.slotAmPm;
    if (built.buildEmailRef && built.buildEmailRef._lastSubjectSuffix) subject += built.buildEmailRef._lastSubjectSuffix;

    // Test-mode / stale banner + recipient transform.
    const tm = applyTestMode({ subject, to: o.recipient.to, cc: o.recipient.cc }, {
      testMode: o.testMode, testRecipients: o.testRecips, banner: gate.banner,
    });
    if (tm.banner) html = injectBanner(html, tm.banner);
    if (!html || html.length < 100) {
      await ledger.scheduleRetry(job.jobId, { class: 'transient', message: 'empty html' });
      return { state: ledger.getJob(job.jobId).state, scope: o.scope };
    }

    // Record intended vs actual recipients on the job (kept separate).
    await ledger.transition(job.jobId, ledger.STATES.VERIFYING,
      { intendedRecipients: tm.intendedRecipients, actualRecipients: tm.actualRecipients }, 'owa deliver');

    const owa = await _deps.sendViaOwa({ to: tm.to, cc: tm.cc, subject: tm.subject, html, correlationMarker: job.correlationMarker });

    if (owa.status === 'sent') {
      await ledger.transition(job.jobId, ledger.STATES.SENT, { deliveryResult: _redactOwa(owa) }, 'sent verified');
      // Commit snapshot AFTER verified send — production only, never in test mode.
      if (!o.testMode) {
        try {
          _deps.summary.commitSnapshot(built.unitsForSnapshot, o.slotAmPm, scopeKey(o.scope.operator, o.scope.domicile, o.slotLabel));
        } catch (e) { logger.warn('snapshot commit failed: ' + e.message); }
      }
      const done = await ledger.transition(job.jobId, ledger.STATES.COMPLETED, {}, 'completed');
      _notify(ctx, done.ok ? done.job : ledger.getJob(job.jobId));
      return { state: ledger.STATES.COMPLETED, scope: o.scope };
    }
    if (owa.status === 'blocked-auth') {
      const b = await ledger.transition(job.jobId, ledger.STATES.BLOCKED_AUTH, { deliveryResult: _redactOwa(owa), error: { class: 'auth', message: 'OWA auth required' } }, 'blocked-auth');
      _notify(ctx, b.ok ? b.job : ledger.getJob(job.jobId));
      return { state: ledger.STATES.BLOCKED_AUTH, scope: o.scope };
    }
    if (owa.status === 'delivery-uncertain') {
      const u = await ledger.transition(job.jobId, ledger.STATES.DELIVERY_UNCERTAIN, { deliveryResult: _redactOwa(owa) }, 'delivery-uncertain — will NOT auto-resend');
      _notify(ctx, u.ok ? u.job : ledger.getJob(job.jobId));
      return { state: ledger.STATES.DELIVERY_UNCERTAIN, scope: o.scope };
    }
    // failed -> retry
    const rt = await ledger.scheduleRetry(job.jobId, { class: classifyError((owa.errors || []).join(' ')), message: (owa.errors || []).join('; ') || 'owa failed' });
    if (rt.exhausted) _notify(ctx, ledger.getJob(job.jobId));
    return { state: ledger.getJob(job.jobId).state, scope: o.scope };
  } catch (e) {
    logger.error('Email scope error:', e.message);
    await ledger.scheduleRetry(job.jobId, { class: classifyError(e.message), message: e.message });
    return { state: ledger.getJob(job.jobId).state, scope: o.scope, error: e.message };
  } finally {
    await ledger.releaseLease(ledger.CHANNELS.EMAIL, job.jobId);
  }
}

function _redactOwa(r) {
  if (!r) return null;
  return { status: r.status, to: r.to, cc: r.cc, subject: r.subject, sentItemsMatch: r.sentItemsMatch, composeClosed: r.composeClosed };
}

function _loadOpEmails() {
  try {
    const fs = require('fs'); const { P } = require('../config/paths');
    if (fs.existsSync(P.opEmails)) return JSON.parse(fs.readFileSync(P.opEmails, 'utf8'));
  } catch (_) {}
  return {};
}

// ── Restart recovery ────────────────────────────────────────────────────────────
// Called from scheduler.start(). Re-commits verified-but-uncommitted sends,
// re-verifies in-flight jobs, and re-queues due retries — WITHOUT ever blindly
// resending. delivery-uncertain jobs are left for explicit reconciliation.
async function recover(ctx) {
  const rec = await ledger.recoverOnStartup();
  // SENT jobs: the send was verified but the process died before COMPLETED.
  for (const jobId of rec.resumeCommit) {
    const job = ledger.getJob(jobId);
    if (!job) continue;
    if (job.channel === ledger.CHANNELS.EMAIL && !job.testMode) {
      // Snapshot may not have committed — safe to re-commit (idempotent overwrite).
      try {
        const built = _buildScopeEmail(ctx, job.scope || {}, slotToAmPm(job.slotLabel), { testMode: false });
        _deps.summary.commitSnapshot(built.unitsForSnapshot, slotToAmPm(job.slotLabel), scopeKey((job.scope||{}).operator, (job.scope||{}).domicile, job.slotLabel));
      } catch (_) {}
    }
    await ledger.transition(jobId, ledger.STATES.COMPLETED, {}, 'recovered: re-committed after restart');
    logger.info('Recovered SENT job -> COMPLETED: ' + jobId);
  }
  return rec;
}

Object.assign(module.exports, {
  runSharePointJob, runEmailSlot, recover,
  _buildScopeEmail, _syncAndGate, _redactSync, _redactSp, _redactOwa,
});

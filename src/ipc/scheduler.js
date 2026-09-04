'use strict';
/**
 * ipc/scheduler.js — Scheduler control + authoritative state (Task #8).
 *
 * Exposes the durable backend scheduler to the renderer so the Scheduler UI can
 * render entirely from STRUCTURED ledger state (no localStorage history, no
 * message-string parsing). Also exposes the operator controls: run now, run a
 * test, retry, cancel, reconcile, enable/disable, configure freshness,
 * authenticate OWA, open Sent Items.
 *
 * All state is redacted (see scheduler.getState / _jobSummary): no email bodies,
 * no secrets — recipients are bare addresses, intended vs actual kept separate.
 */

const logger = require('../utils/logger')('ipc:scheduler');
const { handle, requireString } = require('./_safe');

function registerSchedulerIPC(ctx) {
  const scheduler = require('../scheduler');
  const ledger    = require('../scheduler/ledger');

  // ── Read authoritative state ─────────────────────────────────────────────
  handle('scheduler:get-state', () => scheduler.getState());
  handle('scheduler:get-job', (_e, jobId) => {
    requireString(jobId, 'jobId');
    const j = ledger.getJob(jobId);
    return j ? scheduler._jobSummary(j) : null;
  });

  // ── Manual runs ───────────────────────────────────────────────────────────
  // No live side effects unless real config + confirmation exist; the pipeline
  // itself gates on freshness and never fakes success.
  handle('scheduler:run-sp-now', async () => {
    logger.info('Manual SharePoint push requested');
    const r = await scheduler.runSpNow();
    return { ok: !!(r && (r.ok || r.job)), result: _redactRun(r) };
  });
  handle('scheduler:run-email-test-now', async () => {
    logger.info('Run next email slot as TEST requested');
    const r = await scheduler.runNextEmailAsTest();
    return { ok: !(r && r.blocked), result: _redactEmailRun(r) };
  });

  // REAL production email run (sends to actual operator recipients). Recovers a
  // slot that was blocked/missed earlier once data is fresh.
  handle('scheduler:run-email-now', async (_e, slotLabel) => {
    logger.info('Run PRODUCTION email now requested (slot=' + (slotLabel || 'auto') + ')');
    const r = await scheduler.runEmailNow(slotLabel);
    return { ok: !(r && r.blocked), result: _redactEmailRun(r) };
  });

  // ── Job actions ────────────────────────────────────────────────────────────
  handle('scheduler:retry', async (_e, jobId) => {
    requireString(jobId, 'jobId');
    const job = ledger.getJob(jobId);
    if (!job) return { ok: false, error: 'job not found' };
    // Re-queue a failed/paused job. The scheduler timers + catch-up will pick it
    // up; for an immediate retry we requeue then let the next tick run it.
    if (job.state === ledger.STATES.FAILED) {
      await ledger.transition(jobId, ledger.STATES.QUEUED, { attempts: 0, nextRetryAt: null }, 'manual retry');
    } else if (job.state === ledger.STATES.RETRY || job.state === ledger.STATES.PARTIAL_FAILURE) {
      await ledger.transition(jobId, ledger.STATES.QUEUED, { nextRetryAt: null }, 'manual retry');
    } else {
      return { ok: false, error: 'job not in a retryable state (' + job.state + ')' };
    }
    return { ok: true, state: ledger.getJob(jobId).state };
  });

  handle('scheduler:cancel', async (_e, jobId) => {
    requireString(jobId, 'jobId');
    const job = ledger.getJob(jobId);
    if (!job) return { ok: false, error: 'job not found' };
    if (ledger.TERMINAL_STATES.includes(job.state)) return { ok: false, error: 'job already terminal (' + job.state + ')' };
    const r = await ledger.transition(jobId, ledger.STATES.CANCELLED, {}, 'cancelled by user');
    return { ok: r.ok, state: ledger.getJob(jobId).state, error: r.ok ? undefined : r.error };
  });

  // Reconcile a delivery-uncertain job against OWA Sent Items. Full automated
  // re-verification is a live-only operation; here we surface the job as needing
  // operator confirmation and open Sent Items so they can confirm/deny. The job
  // is NOT auto-resent (that would risk a duplicate send).
  handle('scheduler:reconcile', async (_e, jobId) => {
    requireString(jobId, 'jobId');
    const job = ledger.getJob(jobId);
    if (!job) return { ok: false, error: 'job not found' };
    if (job.state !== ledger.STATES.DELIVERY_UNCERTAIN) return { ok: false, error: 'job is not delivery-uncertain (' + job.state + ')' };
    return {
      ok: true,
      action: 'confirm-in-sent-items',
      correlationMarker: job.correlationMarker,
      subject: job.deliveryResult && job.deliveryResult.subject,
      recipients: job.actualRecipients || [],
      note: 'Open Sent Items and confirm this message was sent. Use "Mark verified" or "Mark failed" — it will NOT be resent automatically.',
    };
  });

  // Operator resolution of a delivery-uncertain job after checking Sent Items.
  handle('scheduler:resolve-uncertain', async (_e, jobId, verified) => {
    requireString(jobId, 'jobId');
    const job = ledger.getJob(jobId);
    if (!job) return { ok: false, error: 'job not found' };
    if (job.state !== ledger.STATES.DELIVERY_UNCERTAIN) return { ok: false, error: 'not delivery-uncertain' };
    if (verified) {
      await ledger.transition(jobId, ledger.STATES.SENT, {}, 'operator confirmed in Sent Items');
      // Commit snapshot for a confirmed production email.
      if (job.channel === ledger.CHANNELS.EMAIL && !job.testMode) {
        try {
          const pipeline = require('../scheduler/pipeline');
          const built = pipeline._buildScopeEmail(ctx, job.scope || {}, pipeline.slotToAmPm(job.slotLabel), { testMode: false });
          require('../scrapers/email-summary').commitSnapshot(built.unitsForSnapshot, pipeline.slotToAmPm(job.slotLabel),
            pipeline.scopeKey((job.scope || {}).operator, (job.scope || {}).domicile, job.slotLabel));
        } catch (e) { logger.warn('reconcile snapshot commit failed: ' + e.message); }
      }
      await ledger.transition(jobId, ledger.STATES.COMPLETED, {}, 'operator resolved -> completed');
    } else {
      await ledger.transition(jobId, ledger.STATES.FAILED, { error: { class: 'manual', message: 'operator marked not-sent' } }, 'operator resolved -> failed');
    }
    return { ok: true, state: ledger.getJob(jobId).state };
  });

  // ── Config ──────────────────────────────────────────────────────────────────
  handle('scheduler:set-enabled', (_e, patch) => {
    return { ok: true, enabled: scheduler.setEnabled(patch || {}) };
  });
  handle('scheduler:set-freshness', (_e, patch) => {
    return { ok: true, freshness: scheduler.setFreshness(patch || {}) };
  });

  // ── OWA auth + Sent Items ─────────────────────────────────────────────────
  handle('scheduler:authenticate-owa', async () => {
    const { authenticateOwa } = require('../scrapers/owa-mailer');
    logger.info('Interactive OWA authentication requested (scheduler)');
    return authenticateOwa({});
  });
  // Diagnostic: run the silent warmup and report the redirect chain + final URL
  // so we can see exactly what the OWA SSO does in a hidden window (no send).
  handle('scheduler:owa-probe', async (_e, opts) => {
    const { warmOwaSessionProbe } = require('../scrapers/owa-mailer');
    logger.info('OWA warmup probe requested');
    return warmOwaSessionProbe(opts || {});
  });
  handle('scheduler:open-sent-items', async () => {
    const { shell } = require('electron');
    await shell.openExternal('https://outlook.office365.com/mail/sentitems');
    return { ok: true };
  });

  // Read-only OWA selector self-check — confirms the compose editor + Send
  // control are locatable in the current OWA build WITHOUT sending anything.
  // Used by the live acceptance step to de-risk the DOM targets.
  handle('scheduler:owa-selfcheck', async () => {
    const { previewSelectors } = require('../scrapers/owa-mailer');
    logger.info('OWA selector self-check requested');
    return previewSelectors({});
  });

  logger.info('Scheduler IPC handlers registered');
}

function _redactRun(r) {
  if (!r) return null;
  if (r.skipped) return { skipped: r.skipped };
  if (r.blocked) return { blocked: r.blocked };
  return { ok: !!r.ok, status: r.result && r.result.status, workbooksSucceeded: r.result && r.result.workbooksSucceeded, workbooksAttempted: r.result && r.result.workbooksAttempted };
}
function _redactEmailRun(r) {
  if (!r) return null;
  if (r.blocked) return { blocked: r.blocked };
  if (r.skipped) return { skipped: r.skipped };
  const outs = r.outcomes || [];
  return {
    scopes: outs.length,
    completed: outs.filter(o => o.state === 'completed').length,
    states: outs.map(o => ({ scope: o.scope, state: o.state, skipped: o.skipped })),
  };
}

module.exports = { registerSchedulerIPC };

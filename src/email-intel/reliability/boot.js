'use strict';
/**
 * email-intel/reliability/boot.js — restart safety (design 8.8; R8.3, AC-4, NFR-3).
 *
 *   reconcileOnBoot({ now }) -> Promise<summary>   run at IPC registration when engaged()
 *   interruptStale(now)      -> boolean            a scan.current left by a crashed run -> scan.last 'interrupted'
 *
 * No network, no AI, no scan. Every step is independent and best effort:
 *  - checkpoints.scan.current (no scan running in this process) -> scan.last { outcome:'interrupted' };
 *  - send attempts: 'sending' -> 'delivery-uncertain'; 'preparing' older than 10 minutes -> 'failed-before-send'
 *    (reply/send-guard.bootRecover; never while this process is sending);
 *  - timeline ledger 'pending' entries -> marker reconcile (facts/timeline-writer.reconcilePending; only while
 *    timelineWrites is effective, the writer checks it);
 *  - staged items: only 'timeline-disabled' / 'low-confidence' older than 30 days expire (facts/staged.applyCaps,
 *    F-23; every other reason never expires);
 *  - snoozed action items whose time passed reopen (actions/store.wake).
 * The synchronous steps run before the returned promise's first await, so the send recovery has happened when
 * registerEmailIntelIPC returns. Steps write only when they have something to change (no new files), and a
 * store from a newer build is never written (stores.update refuses it: read-only, NFR-3).
 * Logs carry counts only.
 */
const flags = require('../flags');
const stores = require('../stores');
const lock = require('./lock');
const { errName } = require('../redact');
let logger;
try { logger = require('../../utils/logger')('email-intel'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

function _eff() { try { return flags.get().effective || {}; } catch (_) { return {}; } }
function _engaged() { try { return flags.engaged(); } catch (_) { return false; } }

/** A scan.current left behind by a run that did not finish (crash, kill) becomes scan.last 'interrupted'. */
function interruptStale(now, ownsLock) {
  if (!ownsLock && lock.isBusy()) return false;                  // a scan of this process owns scan.current
  const t = Number.isFinite(now) ? now : Date.now();
  const ck = stores.load('checkpoints');
  const cur = ck && ck.scan && ck.scan.current;
  if (!cur) return false;
  const r = stores.update('checkpoints', (doc) => {
    doc.scan = doc.scan || {};
    const c = doc.scan.current;
    if (!c) return doc;
    doc.scan.last = {
      scanId: c.scanId || null, startedAt: c.startedAt || null, endedAt: new Date(t).toISOString(), outcome: 'interrupted', partial: true,
      trigger: c.trigger === 'scheduled' ? 'scheduled' : 'manual', errorCode: 'interrupted', folders: [], counts: {},
    };
    doc.scan.current = null;
    return doc;
  });
  if (r.ok) logger.warn('[email-intel] previous scan was interrupted; progress up to its last committed batch is kept');
  return !!r.ok;
}

function _wakeSnoozed(now) {
  const S = require('../actions/store');
  const probe = S.load();
  if (!Object.values(probe.items || {}).some((x) => x && x.state === 'snoozed')) return 0;
  let n = 0;
  const r = S.update((doc) => { n = S.wake(doc, now); return n; });
  return r.ok ? n : 0;
}

function _expireStaged(now) {
  const staged = require('../facts/staged');
  const probe = staged.load();
  if (!Object.keys(probe.items || {}).length) return { expired: 0, pruned: 0 };
  let out = { expired: 0, pruned: 0 };
  const r = stores.update('staged', (doc) => { out = staged.applyCaps(staged.ensureDoc(doc), now); return doc; });
  return r.ok ? out : { expired: 0, pruned: 0 };
}

/**
 * reconcileOnBoot({ now }) -> Promise<{ ran, interrupted, sends:{uncertain,failed}, ledger:{resolved,retried,failed}|null,
 *   staged:{expired,pruned}|null, reopened, errors }>
 */
function reconcileOnBoot(opts) {
  const now = opts && Number.isFinite(opts.now) ? opts.now : Date.now();
  const out = { ran: false, interrupted: false, sends: { uncertain: 0, failed: 0 }, ledger: null, staged: null, reopened: 0, errors: 0 };
  if (!_engaged()) return Promise.resolve(out);
  out.ran = true;
  const eff = _eff();
  const step = (name, fn) => { try { fn(); } catch (e) { out.errors++; logger.warn('[email-intel] boot ' + name + ' failed ' + errName(e)); } };
  step('checkpoints', () => { out.interrupted = interruptStale(now); });
  step('sends', () => { out.sends = require('../reply/send-guard').bootRecover({ now }); });
  if (eff.multiRecipient) step('staged', () => { out.staged = _expireStaged(now); });
  if (eff.actionsView) step('actions', () => { out.reopened = _wakeSnoozed(now); });
  const finish = () => {
    logger.info('[email-intel] boot reconcile interrupted=' + (out.interrupted ? 1 : 0) + ' sendsUncertain=' + out.sends.uncertain + ' sendsFailed=' + out.sends.failed +
      ' ledgerResolved=' + (out.ledger ? out.ledger.resolved : 0) + ' stagedExpired=' + (out.staged ? out.staged.expired : 0) + ' reopened=' + out.reopened + ' errors=' + out.errors);
    return out;
  };
  if (!eff.timelineWrites) return Promise.resolve(finish());
  let p;
  try { p = require('../facts/timeline-writer').reconcilePending({ now }); } catch (e) { out.errors++; logger.warn('[email-intel] boot ledger failed ' + errName(e)); return Promise.resolve(finish()); }
  return Promise.resolve(p).then((r) => { out.ledger = r || null; return finish(); }, (e) => { out.errors++; logger.warn('[email-intel] boot ledger failed ' + errName(e)); return finish(); });
}

module.exports = { reconcileOnBoot, interruptStale };

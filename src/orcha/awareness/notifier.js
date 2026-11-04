'use strict';
/**
 * notifier.js — unified proactive-note notifier for the context-aware assistant
 * (design §D6). Every proactive source (change digest, proactive-alerts,
 * deep-scan) hands notes here; this module owns de-dupe (persisted ledger),
 * batching, caps, toggles and delivery.
 *
 * The ONLY outbound paths are:
 *   - deps.send('assistant:notes', …)  → the app's own windows (ctx.send)
 *   - slack_send.sendToChannel(<Just Me channel id>, text)  → the user's own
 *     Just Me channel, found by slack_justme_channel.findJustMeChannel(…, {forSend:true}).
 * Nothing here talks to carriers, partners, vendors or AAP.
 *
 * Store keys: assistantNoteLedger, assistantNotesFeed (read: settings,
 * slackChannelWatchConfig, operatorChannels).
 */

const crypto = require('node:crypto');
const store  = require('../../store');
const logger = require('../../utils/logger')('notifier');
const { findJustMeChannel } = require('../../scrapers/slack_justme_channel');

const QUIET_MS = 20 * 1000;
const MAX_WAIT_MS = 90 * 1000;
const KEY_TTL_MS = 30 * 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const SOURCE_BASELINE_MS = 24 * 3600 * 1000; // covers the 12 h cooldown and the per-day flags
const STATE_SOURCES = new Set(['proactive-alerts', 'deep-scan']);
const MAX_TEXT = 300;
const FLOOD_MAX = 15;
const FAMILY_MAX = 5;
const INAPP_HOURLY_MAX = 30;
const FEED_MAX = 50;
const SLACK_HOURLY_MAX = 4;
const SLACK_MAX_BULLETS = 8;
const P2_SUPPRESS_MS = 2 * HOUR_MS;

const _slackEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function _defaultMayRunProduction() {
  let c;
  try { c = require('../../cluster'); } catch (_) { return true; }
  try { return typeof c.mayRunProduction !== 'function' || c.mayRunProduction(); } catch (_) { return true; }
}

function createNotifier(deps = {}) {
  const load = deps.load || store.load;
  const save = deps.save || store.save;
  const now = deps.now || Date.now;
  const _setTimeout = deps.setTimeout || setTimeout;
  const _clearTimeout = deps.clearTimeout || clearTimeout;
  const log = deps.log || logger;
  const loadSettings = deps.loadSettings || (() => load('settings', {}) || {});
  const mayRunProduction = deps.mayRunProduction || _defaultMayRunProduction;
  let send = deps.send || null;

  let pending = [];
  const _touched = new Set();
  const _evicted = new Set(); // pending ready-maybe keys replaced by ready-api: still marked at flush
  let _timer = null;
  let _firstAt = 0;
  let _flushing = false;
  let _rearm = false;

  const _actionLog = () => deps.actionLog || require('./action-log');
  const _slack = () => deps.slack || require('../../scrapers/slack_send');

  function _arm() {
    if (!pending.length && !_touched.size && !_evicted.size) return;
    const t = now();
    if (!_firstAt) _firstAt = t;
    if (_timer) _clearTimeout(_timer);
    const delay = Math.max(0, Math.min(QUIET_MS, _firstAt + MAX_WAIT_MS - t));
    _timer = _setTimeout(() => { _timer = null; flush().catch(() => {}); }, delay);
  }

  function _apiKey(key) { return key.replace('|ready-maybe|', '|ready-api|'); }
  function _maybeKey(key) { return key.replace('|ready-api|', '|ready-maybe|'); }

  function enqueue(notes) {
    try {
      const list = Array.isArray(notes) ? notes : [notes];
      let ledgerKeys = {};
      try { const l = load('assistantNoteLedger', null); ledgerKeys = (l && l.keys && typeof l.keys === 'object') ? l.keys : {}; } catch (_) { ledgerKeys = {}; }
      const t = now();
      let userEsc = null;
      for (const raw of list) {
        if (!raw || typeof raw.key !== 'string' || !raw.key || typeof raw.text !== 'string' || !raw.text) {
          log.debug('[notifier] invalid note dropped');
          continue;
        }
        const n = {
          id: 'n_' + crypto.createHash('sha1').update(raw.key + '|' + t).digest('hex').slice(0, 12),
          key: raw.key, unit: raw.unit != null ? String(raw.unit) : null, wr: raw.wr != null ? String(raw.wr) : null,
          family: raw.family ? String(raw.family) : 'other', icon: raw.icon ? String(raw.icon) : '🤖',
          title: raw.title ? String(raw.title) : '', text: raw.text.slice(0, MAX_TEXT),
          source: raw.source ? String(raw.source) : 'unknown', at: t,
          severity: raw.severity === 'high' ? 'high' : 'medium',
        };
        if (raw.silent === true) n._silent = true;

        if (Object.prototype.hasOwnProperty.call(ledgerKeys, n.key)) { _touched.add(n.key); continue; }
        if (pending.some((p) => p.key === n.key)) continue;
        if (n.key.includes('|ready-maybe|')) {
          const ak = _apiKey(n.key);
          if (Object.prototype.hasOwnProperty.call(ledgerKeys, ak) || pending.some((p) => p.key === ak)) continue;
        }
        if (n.key.includes('|ready-api|')) {
          const mk = _maybeKey(n.key);
          const before = pending.length;
          pending = pending.filter((p) => p.key !== mk);
          if (pending.length !== before) _evicted.add(mk);
        }
        if (n.family === 'esc' && n.unit) {
          if (userEsc === null) {
            try { userEsc = _actionLog().recent(50, P2_SUPPRESS_MS, { load, now }) || []; } catch (_) { userEsc = []; }
          }
          if (userEsc.some((a) => a && a.type === 'escalation' && a.unit === n.unit)) { log.debug('[notifier] P2 suppressed (user action)'); continue; }
        }
        pending.push(n);
      }
      _arm();
    } catch (e) {
      log.warn('[notifier] enqueue failed: ' + e.message);
    }
  }

  function _summary(t, i, count) {
    return { id: 'n_sum_' + t + '_' + i, key: 'summary|' + t + '|' + i, unit: null, wr: null, family: 'summary', icon: '🤖',
      title: 'Fleet changes', text: `${count} fleet changes detected at once. Ask Orcha "what changed?"`,
      source: 'notifier', at: t, severity: 'medium' };
  }

  function _shape(batch, t) {
    if (batch.length > FLOOD_MAX) return [_summary(t, 0, batch.length)];
    const byFam = new Map();
    for (const n of batch) { if (!byFam.has(n.family)) byFam.set(n.family, []); byFam.get(n.family).push(n); }
    const out = [];
    let i = 0;
    for (const [fam, list] of byFam) {
      if (list.length <= FAMILY_MAX) { out.push(...list); continue; }
      const units = list.map((n) => n.unit || '?');
      const shown = units.slice(0, 10).join(', ') + (units.length > 10 ? ` +${units.length - 10}` : '');
      out.push({ id: 'n_sum_' + t + '_' + (i++), key: 'family|' + fam + '|' + t, unit: null, wr: null, family: fam,
        icon: list[0].icon, title: list[0].title, text: `${list[0].title || fam} (${list.length}): ${shown}`,
        source: list[0].source, at: t, severity: list[0].severity });
    }
    return out;
  }

  function _slackText(userId, notes) {
    const lines = [`<@${userId}> 🤖 *Orcha — fleet notes* (${notes.length})`];
    for (const n of notes.slice(0, SLACK_MAX_BULLETS)) {
      let body = _slackEsc(n.text);
      if (n.unit && /^[A-Za-z0-9_-]{1,32}$/.test(n.unit)) {
        const idx = body.indexOf(n.unit);
        if (idx >= 0) body = body.slice(0, idx) + '*' + n.unit + '*' + body.slice(idx + n.unit.length);
      }
      lines.push('• ' + n.icon + ' ' + body);
    }
    const more = notes.length - SLACK_MAX_BULLETS;
    lines.push('_' + (more > 0 ? `+${more} more in the app. ` : '')
      + 'Suggestions only. Nothing was sent or changed. Send a new message here to ask about any of these._');
    return lines.join('\n');
  }

  function _readFeed() {
    const f = load('assistantNotesFeed', null);
    return { notes: (f && Array.isArray(f.notes)) ? f.notes : [], lastSeenAt: (f && typeof f.lastSeenAt === 'number') ? f.lastSeenAt : 0 };
  }
  function _unseen(feed) { return feed.notes.filter((n) => n && !n.dismissed && n.at > feed.lastSeenAt).length; }

  async function _deliverSlack(batch, ledger, t) {
    let leader = true;
    try { leader = mayRunProduction(); } catch (_) { leader = true; } // fail-open, like ipc/slack.js
    if (!leader) { log.info('[notifier] not production leader — Slack skipped'); return; }
    const ch = findJustMeChannel(load('slackChannelWatchConfig', {}) || {}, { forSend: true });
    if (!ch) { log.info('[notifier] no Just Me channel — Slack skipped'); return; }
    const oc = load('operatorChannels', {}) || {};
    const ops = Array.isArray(oc.operators) ? oc.operators : [];
    if (ops.some((o) => o && o.channelId && o.channelId === ch.id)) {
      log.warn('[notifier] Just Me channel is mapped as a carrier channel — refusing');
      return;
    }
    if (ledger.slackPosts.length >= SLACK_HOURLY_MAX) { log.info('[notifier] Slack hourly cap reached'); return; }
    const slack = _slack();
    let auth;
    try { auth = await slack.checkLiveAuth(); } catch (e) { log.info('[notifier] Slack auth check failed — skipped'); return; }
    if (!auth || !auth.authenticated || !auth.userId) { log.info('[notifier] Slack not authenticated — skipped'); return; }
    try {
      await slack.sendToChannel(ch.id, _slackText(auth.userId, batch));
    } catch (e) {
      log.warn('[notifier] Just Me post failed: ' + e.message);
      return;
    }
    ledger.slackPosts.push(t);
    try { save('assistantNoteLedger', ledger); } catch (e) { log.warn('[notifier] ledger save (slackPosts) failed: ' + e.message); }
  }

  async function flush() {
    if (_flushing) { _rearm = true; return; }
    _flushing = true;
    if (_timer) { _clearTimeout(_timer); _timer = null; }
    _firstAt = 0;
    try {
      const t = now();
      const raw = load('assistantNoteLedger', null);
      const firstRun = !raw || !raw.initializedAt;
      const ledger = Object.assign({}, raw || {});
      ledger.sourceBaseline = Object.assign({}, (raw && raw.sourceBaseline) || {});
      ledger.keys = Object.assign({}, (raw && raw.keys) || {});
      ledger.slackPosts = Array.isArray(raw && raw.slackPosts) ? raw.slackPosts.slice() : [];

      // Keep-alive refresh BEFORE the prune, so a still-detected signal never re-notifies.
      for (const k of _touched) if (Object.prototype.hasOwnProperty.call(ledger.keys, k)) ledger.keys[k] = t;
      _touched.clear();
      const work = [];
      for (const n of pending) {
        if (Object.prototype.hasOwnProperty.call(ledger.keys, n.key)) { ledger.keys[n.key] = t; continue; }
        work.push(n);
      }
      for (const k of Object.keys(ledger.keys)) if (!(t - ledger.keys[k] <= KEY_TTL_MS)) delete ledger.keys[k];
      ledger.slackPosts = ledger.slackPosts.filter((x) => t - x < HOUR_MS);
      const notes = work.filter((n) => !(n.key.includes('|ready-maybe|')
        && (Object.prototype.hasOwnProperty.call(ledger.keys, _apiKey(n.key)) || work.some((p) => p.key === _apiKey(n.key)))));
      const evicted = Array.from(_evicted);

      if (!notes.length && !evicted.length) {
        pending = [];
        try { save('assistantNoteLedger', ledger); } catch (e) { log.warn('[notifier] ledger refresh save failed: ' + e.message); }
        return;
      }

      const allKeys = notes.map((n) => n.key).concat(evicted);
      if (firstRun) {
        for (const k of allKeys) ledger.keys[k] = t;
        ledger.initializedAt = t;
        for (const n of notes) if (STATE_SOURCES.has(n.source) && !ledger.sourceBaseline[n.source]) ledger.sourceBaseline[n.source] = t;
        try { save('assistantNoteLedger', ledger); }
        catch (e) { log.warn('[notifier] ledger save failed: ' + e.message); _rearm = true; return; }
        pending = [];
        _evicted.clear();
        log.info('[notifier] baseline: ' + notes.length + ' notes marked silently');
        return;
      }

      const silentBySource = {};
      for (const n of notes) {
        if (STATE_SOURCES.has(n.source)) {
          const first = ledger.sourceBaseline[n.source] || (ledger.sourceBaseline[n.source] = t);
          if (t - first < SOURCE_BASELINE_MS) n._silent = true;
        }
        if (n._silent) silentBySource[n.source] = (silentBySource[n.source] || 0) + 1;
      }

      // Mark + save BEFORE delivery: a crash loses a note rather than duplicating it.
      for (const k of allKeys) ledger.keys[k] = t;
      try { save('assistantNoteLedger', ledger); }
      catch (e) { log.warn('[notifier] ledger save failed: ' + e.message); _rearm = true; return; } // pending kept
      pending = [];
      _evicted.clear();
      for (const src of Object.keys(silentBySource)) log.info('[notifier] baseline (' + src + '): ' + silentBySource[src] + ' marked silently');

      const live = notes.filter((n) => !n._silent);
      if (!live.length) return;
      const batch = _shape(live, t).map((n) => { const c = Object.assign({}, n, { at: t }); delete c._silent; return c; });

      let settings = {};
      try { settings = loadSettings() || {}; } catch (_) { settings = {}; }

      if (settings.proactiveNotesInApp !== false) {
        try {
          const feed = _readFeed();
          const lastHour = feed.notes.filter((n) => n && t - n.at < HOUR_MS).length;
          let inApp = batch;
          if (lastHour + batch.length > INAPP_HOURLY_MAX) {
            const keep = Math.max(0, INAPP_HOURLY_MAX - lastHour - 1);
            inApp = batch.slice(0, keep).concat([_summary(t, 99, batch.length - keep)]);
          }
          feed.notes = inApp.concat(feed.notes).slice(0, FEED_MAX);
          save('assistantNotesFeed', feed);
          if (send) {
            try { send('assistant:notes', { notes: inApp, unseen: _unseen(feed) }); }
            catch (e) { log.debug('[notifier] send failed: ' + e.message); }
          }
        } catch (e) { log.warn('[notifier] feed save failed: ' + e.message); }
      }

      if (settings.proactiveNotesSlack !== false) await _deliverSlack(batch, ledger, t);
    } catch (e) {
      log.warn('[notifier] flush failed: ' + e.message);
    } finally {
      _flushing = false;
      if (_rearm) { _rearm = false; _arm(); }
    }
  }

  function getFeed() {
    const feed = _readFeed();
    return { notes: feed.notes.filter((n) => n && !n.dismissed), unseen: _unseen(feed) };
  }

  function markSeen() {
    const feed = _readFeed();
    feed.lastSeenAt = now();
    save('assistantNotesFeed', feed);
    return { ok: true };
  }

  function dismiss(id) {
    const feed = _readFeed();
    const n = feed.notes.find((x) => x && x.id === id);
    if (!n) return { ok: false, code: 'NOT_FOUND' };
    n.dismissed = true;
    save('assistantNotesFeed', feed);
    return { ok: true };
  }

  function configure(opts = {}) {
    if (typeof opts.send === 'function') send = opts.send;
  }

  return { enqueue, flush, getFeed, markSeen, dismiss, configure };
}

let _singleton = null;
function getNotifier() {
  if (!_singleton) _singleton = createNotifier({});
  return _singleton;
}

module.exports = { createNotifier, getNotifier, _slackEsc };

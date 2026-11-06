'use strict';
/**
 * email-intel/facts/timeline-writer.js — the intent-first, ledgered timeline writer (design 4.4; R3.3,
 * R3.4, R3.6, R3.8, R3.9, PG-2, F-07, F-08).
 *
 *   commitFact(input) -> Promise<{ state:'applied'|'duplicate'|'staged'|'filtered'|'disabled'|'standby'|'out-of-scope'|'error', ledgerKey?, stagedId?, line?, code? }>
 *     input: { fact, unit, msg, evalResult, scopeOf?, userApproved?, canonicalSnapshot?, now?, deps? }
 *   reconcilePending({ now, deps }) -> { resolved, retried, failed }   boot / scan-start marker reconcile
 *   buildLine(input) -> the code-composed timeline line (<= 240 chars, ends with [em:<8hex>])
 *   substitute(text) -> text with the cleaner trigger words replaced
 *   appliedMessageKeys() -> Set of messageKeys with an applied ledger entry (legacy unitUpdateApplied flag)
 *
 * Steps: (1) timelineWrites flag; leader gate cluster.mayRunProduction (fail-open) else staged standby-host
 * (auto writes only; a user approval on this host is the user's own action); scope re-checked at commit.
 * (2) process-wide promise-chain mutex. (3) intent first: a `pending` ledger entry with provenance before
 * anything touches the timeline. (4) marker check: the item-free [em:xxxxxxxx] already in the unit
 * timeline without a local ledger entry stages possible-duplicate (another host may have written it).
 * (5) code-built line, never AI free text, no address. (6) the UNCHANGED email_actions.applyUnitTimelineUpdate.
 * (6a) post-write verification: the marker must be in the returned (cleanTimeline'd) timeline, else the
 * entry is write-filtered and the fact staged timeline-filtered (never reported applied). (7) applied.
 * (8) evidence. canonicalState is never written. Logs carry unit ids, short keys and enums only.
 */
const crypto = require('crypto');
const flags = require('../flags');
const stores = require('../stores');
const fk = require('./fact-key');
const staged = require('./staged');
const evidence = require('./evidence');
const { FACT_LABELS } = require('../understand/schema');
const { errName } = require('../redact');
let logger;
try { logger = require('../../utils/logger')('email-intel'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

const LINE_MAX = 240;
const VALUE_MAX = 160;
const SENDER_MAX = 30;
const PENDING_RECONCILE_MS = 2 * 60_000;
const WRITE_ATTEMPTS_MAX = 3;
const READY_STAGES = new Set(['ready_for_pickup', 'pickup_scheduled', 'repair_complete', 'closed']);
const CTRL = /[\u0000-\u001F\u007F\u2028\u2029]/g;

// ipc/notes.cleanTimeline drops "gap filler" lines (any line containing "requested" + "update" + "vendor",
// "[no update logged]", "requested estimate submission", ...). Synonyms keep a real fact from looking like one.
const SUBSTITUTIONS = Object.freeze([
  [/\brequested\b/gi, 'asked for'],
  [/\brequests?\b/gi, 'ask'],
  [/\bupdated\b/gi, 'changed'],
  [/\bupdates?\b/gi, 'info'],
  [/\bupdating\b/gi, 'changing'],
]);

function substitute(s) {
  let out = String(s == null ? '' : s);
  for (const [re, rep] of SUBSTITUTIONS) out = out.replace(re, (m) => (/^[A-Z]/.test(m) ? rep.charAt(0).toUpperCase() + rep.slice(1) : rep));
  return out;
}

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const nowIso = (now) => new Date(Number.isFinite(now) ? now : Date.now()).toISOString();
const _clean = (s) => String(s == null ? '' : s).replace(CTRL, ' ').replace(/\s+/g, ' ').trim();

function _mmddLocal(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0');
}
function _mmddDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  return m ? m[2] + '/' + m[3] : null;
}
function _isReady(f) { return (f.kind === 'pickup_readiness' && f.state === 'ready') || (f.kind === 'repair_stage' && READY_STAGES.has(f.state)); }

function senderNameOf(msg) {
  const n = _clean(msg && msg.from && msg.from.name);
  if (!n || n.includes('@')) return 'unknown sender';
  return substitute(n).slice(0, SENDER_MAX);
}

/**
 * buildLine({ fact, unit, msg, verifiedBy, supersededEntry, userApproved }) — "<MM/DD> <LABEL>: <value><amount><date>
 * [(was <old>)] (per <sender> email <MM/DD>)[ - not confirmed in AAP/Relay][ (user-approved)] [em:<8hex>]"
 */
function buildLine(input) {
  const i = input || {};
  const f = i.fact || {};
  const keys = fk.keysOf(f, i.unit);
  const recv = _mmddLocal(i.msg && i.msg.receivedAt) || '--/--';
  const label = FACT_LABELS[f.kind] || 'Update';
  let value = substitute(_clean(f.value)).slice(0, VALUE_MAX);
  let amount = '';
  if (f.amount && Number.isFinite(f.amount.value)) {
    const txt = f.amount.value.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (!value.includes(txt)) amount = ' $' + txt;
  }
  let date = '';
  const dd = _mmddDate(f.date);
  if (dd && !value.includes(dd) && !value.includes(String(Number(dd.slice(0, 2))) + '/' + String(Number(dd.slice(3))))) date = ' ' + dd;
  let was = '';
  const old = i.supersededEntry;
  if (old) {
    const ov = _mmddDate(old.fact && old.fact.date) || substitute(_clean((old.fact && old.fact.state) || ''));
    if (ov) was = ' (was ' + ov.slice(0, 30) + ')';
  }
  const per = ' (per ' + senderNameOf(i.msg) + ' email ' + recv + ')';
  const unverified = _isReady(f) && i.verifiedBy !== 'canonical' ? ' - not confirmed in AAP/Relay' : '';
  const approved = i.userApproved ? ' (user-approved)' : '';
  const tail = was + per + unverified + approved + ' ' + keys.marker;
  const head = recv + ' ' + label + ': ';
  const room = LINE_MAX - head.length - amount.length - date.length - tail.length;
  if (value.length > room) value = value.slice(0, Math.max(0, room - 1)).trimEnd() + '\u2026';
  return head + value + amount + date + tail;
}

// ── deps (injectable for tests) ───────────────────────────────────────────────
function _deps(d) {
  const x = d || {};
  return {
    apply: x.apply || ((unit, line) => require('../../scrapers/email_actions').applyUnitTimelineUpdate(unit, line)),
    mayRunProduction: x.mayRunProduction || (() => {
      try { const cl = require('../../cluster'); return typeof cl.mayRunProduction === 'function' ? cl.mayRunProduction() !== false : true; } catch (_) { return true; }
    }),
    timelineOf: x.timelineOf || ((unit) => {
      try { const ns = require('../../store').load('notesStore', {}) || {}; return String((ns[unit] && ns[unit].timeline) || ''); } catch (_) { return ''; }
    }),
  };
}

// ── mutex ─────────────────────────────────────────────────────────────────────
let _tail = Promise.resolve();
function _chain(fn) {
  const p = _tail.then(fn, fn);
  _tail = p.catch(() => {});
  return p;
}

function _timelineWrites() {
  try { return flags.get().effective.timelineWrites === true; } catch (_) { return false; }
}

function _ledgerKeyFor(entries, factKey, messageKey) {
  const e = entries[factKey];
  if (!e || e.state === 'pending' || e.state === 'applied') return factKey;
  return factKey + '-' + sha1(String(messageKey || '') + '|' + Date.now()).slice(0, 6);
}

function _factSnap(f) {
  return { kind: f.kind, item: f.item || null, value: String(f.value || '').slice(0, 160), state: f.state, date: f.date || null, amount: f.amount || null, assertion: f.assertion, evidence: String(f.evidence || '').slice(0, 200), effectiveConfidence: Number.isFinite(f.effectiveConfidence) ? f.effectiveConfidence : 0 };
}

function _stage(input, reason, detail, line) {
  const r = staged.stageFact({
    fact: input.fact, unit: input.unit, msg: input.msg, reason, detail, proposedLine: line || '',
    canonicalSnapshot: input.canonicalSnapshot || (input.evalResult && input.evalResult.canonicalSnapshot) || null, now: input.now,
  });
  return r.ok ? r.item.stagedId : null;
}

function _setEntry(ledgerKey, patch) {
  return stores.update('ledger', (doc) => {
    doc.entries = doc.entries || {};
    const e = doc.entries[ledgerKey];
    if (e) Object.assign(e, typeof patch === 'function' ? patch(e) : patch);
    return doc;
  });
}

async function _commit(input) {
  const i = input || {};
  const f = i.fact || {};
  const unit = String(i.unit || '').trim();
  const msg = i.msg || {};
  const now = Number.isFinite(i.now) ? i.now : Date.now();
  const deps = _deps(i.deps);
  const ev = i.evalResult || {};
  if (!_timelineWrites()) return { state: 'disabled' };
  if (!unit || !f.kind) return { state: 'error', code: 'bad-input' };
  if (!i.userApproved && !deps.mayRunProduction()) {
    logger.info('[email-intel] timeline write deferred: standby host unit=' + unit);
    return { state: 'standby', stagedId: _stage(i, 'standby-host', 'another Fleet host is the leader') };
  }
  if (typeof i.scopeOf === 'function' && i.scopeOf(unit) !== 'in') return { state: 'out-of-scope' };   // R3.8 re-check at commit

  const keys = fk.keysOf(f, unit);
  const supersededEntry = ev.supersededEntry || null;
  const line = buildLine({ fact: f, unit, msg, verifiedBy: ev.verifiedBy, supersededEntry, userApproved: !!i.userApproved });

  // (3) intent first
  let ledgerKey = null; let dupOf = null;
  const r1 = stores.update('ledger', (doc) => {
    doc.entries = doc.entries || {};
    const entries = doc.entries;
    const cls = fk.classify(f, unit, Object.values(entries));
    if (cls.kind === 'duplicate') {
      dupOf = cls.entry.ledgerKey;
      const e = entries[dupOf];
      e.seenCount = (e.seenCount || 1) + 1;
      if (msg.messageKey && msg.messageKey !== e.messageKey && !(e.corroboratedBy || []).includes(msg.messageKey)) e.corroboratedBy = (e.corroboratedBy || []).concat(msg.messageKey).slice(0, 10);
      return doc;
    }
    ledgerKey = _ledgerKeyFor(entries, keys.factKey, msg.messageKey);
    entries[ledgerKey] = {
      ledgerKey, factKey: keys.factKey, valueKey: keys.valueKey, groupKey: keys.groupKey, unit, kind: f.kind, item: keys.item, itemNorm: keys.itemNorm,
      fact: _factSnap(f), state: 'pending', observedAt: msg.receivedAt || null, receivedAtQuality: msg.receivedAtQuality || 'unknown',
      messageKey: msg.messageKey || null, conversationKey: msg.conversationKey || null, legacyId: msg.legacyId || null, source: 'email',
      senderName: senderNameOf(msg), confidence: Number.isFinite(f.effectiveConfidence) ? f.effectiveConfidence : 0, evidenceQuote: String(f.evidence || '').slice(0, 200),
      verifiedBy: ev.verifiedBy || null, line, marker: keys.marker, createdAt: nowIso(now), attempts: 0, seenCount: 1, corroboratedBy: [],
      supersedes: supersededEntry ? supersededEntry.ledgerKey : undefined, userApproved: !!i.userApproved || undefined,
    };
    return doc;
  });
  if (!r1.ok) { logger.error('[email-intel] ledger write failed code=' + r1.code); return { state: 'error', code: 'ledger' }; }
  if (dupOf) return { state: 'duplicate', ledgerKey: dupOf };

  // (4) marker check (item-free marker; no local entry for it -> another host or an earlier build wrote it)
  const before = deps.timelineOf(unit);
  if (before.includes(keys.marker) && !i.userApproved) {
    stores.update('ledger', (doc) => { if (doc.entries && doc.entries[ledgerKey] && doc.entries[ledgerKey].state === 'pending') delete doc.entries[ledgerKey]; return doc; });
    logger.info('[email-intel] marker present without ledger entry unit=' + unit + ' key=' + keys.valueKey.slice(0, 8));
    return { state: 'staged', reason: 'possible-duplicate', stagedId: _stage(i, 'possible-duplicate', 'a matching line is already on the timeline', line) };
  }
  return _write(i, ledgerKey, line, keys, deps, now, supersededEntry);
}

async function _write(i, ledgerKey, line, keys, deps, now, supersededEntry) {
  const unit = String(i.unit).trim();
  let res = null;
  // error name / code only: a write error message could echo the line (email-derived text)
  try { res = deps.apply(unit, line); } catch (e) { logger.warn('[email-intel] timeline write threw unit=' + unit + ' ' + errName(e)); res = { ok: false, error: 'threw' }; }
  if (!res || !res.ok) {
    let attempts = 0;
    _setEntry(ledgerKey, (e) => { attempts = (e.attempts || 0) + 1; return { attempts, lastError: 'write-failed' }; });
    if (attempts >= WRITE_ATTEMPTS_MAX) {
      logger.error('[email-intel] timeline write failed ' + attempts + ' times unit=' + unit);
      return { state: 'error', code: 'write-failed', ledgerKey, stagedId: _stage(i, 'write-failed', 'the timeline write failed', line) };
    }
    return { state: 'error', code: 'write-failed', ledgerKey };
  }
  // (6a) F-08: the cleaner may have dropped the line even though the write returned ok
  if (!(typeof res.timeline === 'string' && res.timeline.includes(keys.marker))) {
    _setEntry(ledgerKey, { state: 'write-filtered', manualEntriesOrphan: true, filteredAt: nowIso(now) });
    logger.warn('[email-intel] timeline cleaner removed the line unit=' + unit + ' key=' + keys.valueKey.slice(0, 8));
    const detail = i.userApproved ? 'cannot be written to the timeline' : 'The timeline cleaner removed this line';
    return { state: 'filtered', ledgerKey, stagedId: _stage(i, 'timeline-filtered', detail, line) };
  }
  // (7) applied (only after 6a passes); the superseded entry is linked
  _setEntry(ledgerKey, { state: 'applied', appliedAt: nowIso(now), lineHash: sha1(line).slice(0, 16), attempts: 0, lastError: undefined });
  if (supersededEntry && supersededEntry.ledgerKey) _setEntry(supersededEntry.ledgerKey, { state: 'superseded', supersededBy: ledgerKey, supersededAt: nowIso(now) });
  // (8) evidence (separate from authoritative state)
  try {
    evidence.recordEvidence({ unit, fact: i.fact, keys, msg: i.msg, usedInConclusion: true, isConflict: false, informationType: supersededEntry ? 'status_change' : 'new', ledgerKey });
  } catch (_) { /* evidence is best effort */ }
  return { state: 'applied', ledgerKey, line };
}

function commitFact(input) { return _chain(() => _commit(input)); }

/**
 * reconcilePending({ now, deps }) — pending entries older than 2 minutes: the marker in the timeline means
 * the write landed (crash between steps 6 and 7) -> applied; otherwise the stored line is written again
 * (3 attempts, then staged write-failed). Pending entries are never pruned.
 */
function reconcilePending(o) {
  return _chain(async () => {
    const opts = o || {};
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const deps = _deps(opts.deps);
    const out = { resolved: 0, retried: 0, failed: 0 };
    if (!_timelineWrites()) return out;
    const doc = stores.load('ledger');
    for (const e of Object.values(doc.entries || {})) {
      if (e.state !== 'pending') continue;
      if (now - (Date.parse(e.createdAt || '') || now) < PENDING_RECONCILE_MS) continue;
      if (deps.timelineOf(e.unit).includes(e.marker)) {
        _setEntry(e.ledgerKey, { state: 'applied', appliedAt: nowIso(now), lineHash: sha1(e.line).slice(0, 16), reconciled: true });
        logger.info('[email-intel] pending timeline entry reconciled by marker unit=' + e.unit);
        out.resolved++;
        continue;
      }
      out.retried++;
      const keys = fk.keysOf(e.fact, e.unit);
      const msg = { messageKey: e.messageKey, conversationKey: e.conversationKey, legacyId: e.legacyId, receivedAt: e.observedAt, receivedAtQuality: e.receivedAtQuality, from: { name: e.senderName }, body: { status: 'complete' } };
      const sup = e.supersedes ? (doc.entries[e.supersedes] || null) : null;
      const r = await _write({ fact: e.fact, unit: e.unit, msg, now, userApproved: !!e.userApproved }, e.ledgerKey, e.line, keys, deps, now, sup);
      if (r.state !== 'applied') out.failed++;
    }
    return out;
  });
}

/** messageKeys with an applied ledger entry (drives the legacy unitUpdateApplied display flag). */
function appliedMessageKeys() {
  const s = new Set();
  for (const e of Object.values(stores.load('ledger').entries || {})) if (e.state === 'applied' && e.messageKey) s.add(e.messageKey);
  return s;
}

module.exports = { commitFact, reconcilePending, buildLine, substitute, senderNameOf, appliedMessageKeys, SUBSTITUTIONS, LINE_MAX };

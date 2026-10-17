'use strict';
/**
 * scrapers/email_triage.js — AI inbox triage brain.
 *
 * Takes the grounded inbox records produced by owa_reader.readInbox(), batches
 * them through the AI (relay.ask, JSON-out, kept under the ~60k char prompt
 * cap), and produces, per email:
 *   - summary        : a short plain-English summary (incl. what any attached
 *                      pictures/files appear to be, by name/type)
 *   - importance     : 'high' | 'normal' | 'low'
 *   - importanceWhy  : one short reason
 *   - replySuggested : boolean (does this warrant a reply?)
 *   - deleteSuggested: boolean (clearly noise — newsletter/notification/auto)
 *   - unitRefs       : [{ unit, update, ready }] — fleet units referenced,
 *                      VALIDATED against fleetData.rows (invalid refs dropped),
 *                      with a timeline-ready `update` line and a `ready` flag
 *                      when the email says the unit is ready for pickup.
 *
 * Then it MERGES the fresh triage with the previously-stored results so that a
 * user's per-email reply state (draft written, reply sent) is NEVER lost just
 * because the inbox was re-scanned or newer mail arrived. The persisted store
 * (emailTriageResults) is the single source of truth the overlay + Slack read.
 *
 * This module does NOT send, delete, DM, or write to unit timelines — that is
 * all done by ipc/email-triage.js behind explicit confirmation. Here we only
 * read, reason, and persist advisory results.
 */

const store = require('../store');
const relay = require('../orcha/relay');
let logger; try { logger = require('../utils/logger')('email-triage'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

const PROMPT_CAP = 55000; // stay safely under relay's ~60k claude-code cap
const BODY_PER_EMAIL_CAP = 1500; // chars of body text handed to the AI per email

// ── Config ────────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  enabled: false,          // feature master switch (reading inbox is opt-in)
  maxEmails: 25,           // how many top emails to read/triage (across all folders)
  // Folders to scan, by their OWA display name. Default: just the Inbox. Add the
  // subfolders your inbox rules route mail into (e.g. 'Relay Garage', 'AVP40',
  // 'SAPB ABE40', 'TUZR ABE40', 'DOMO', 'Z Santiago') so rule-sorted mail is
  // triaged too, not just what lands in the Inbox.
  folders: ['Inbox'],
  autoApplyUnitUpdates: true, // append validated unit updates to the timeline on triage
                           // (the user asked: "if it can validate it's one of my units then
                           //  add it to timeline"). The operator READY DM is always confirm-gated.
  readyDmSuggested: true,  // when a unit is READY, surface a confirm-gated operator DM
  scanOnOpen: false,       // auto-run a scan when the overlay opens
  autoScan: false,         // run a scan automatically on a timer
  autoScanMinutes: 60,     // interval for the auto-scan (min 15)
};

function getConfig() {
  const cfg = store.load('emailTriageConfig', null);
  if (!cfg || typeof cfg !== 'object') return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...cfg };
}

function saveConfig(patch) {
  const next = { ...getConfig(), ...(patch || {}) };
  next.enabled = !!next.enabled;
  next.autoApplyUnitUpdates = !!next.autoApplyUnitUpdates;
  next.readyDmSuggested = !!next.readyDmSuggested;
  next.scanOnOpen = !!next.scanOnOpen;
  next.autoScan = !!next.autoScan;
  const n = parseInt(next.maxEmails, 10);
  next.maxEmails = Number.isFinite(n) ? Math.max(1, Math.min(50, n)) : DEFAULT_CONFIG.maxEmails;
  const m = parseInt(next.autoScanMinutes, 10);
  next.autoScanMinutes = Number.isFinite(m) ? Math.max(15, Math.min(1440, m)) : DEFAULT_CONFIG.autoScanMinutes;
  // Normalize folders: trim, drop empties, dedupe, always keep at least Inbox.
  let folders = Array.isArray(next.folders) ? next.folders.map((f) => String(f || '').trim()).filter(Boolean) : [];
  folders = Array.from(new Set(folders));
  if (!folders.length) folders = ['Inbox'];
  next.folders = folders;
  store.save('emailTriageConfig', next);
  // Re-arm the auto-scan timer to reflect any enabled/interval change.
  try { _rearmAutoScan(); } catch (_) {}
  return next;
}

// ── Deletion learning ──────────────────────────────────────────────────────────
// Records what the user actually deletes vs keeps, so the AI's junk detection
// adapts to their habits over time. We key on a normalized sender and track
// subject keywords. Nothing here deletes — it only learns from the user's
// explicit delete/keep actions (performed elsewhere, confirm-gated).
function loadLearning() {
  const l = store.load('emailTriageLearning', null);
  if (l && typeof l === 'object') {
    return { deleted: l.deleted || {}, kept: l.kept || {}, keywords: l.keywords || { deleted: {}, kept: {} } };
  }
  return { deleted: {}, kept: {}, keywords: { deleted: {}, kept: {} } };
}
function _saveLearning(l) { store.save('emailTriageLearning', l); }

function _senderKey(email) {
  const addr = String(email && email.from || '').trim().toLowerCase();
  if (addr) {
    // Prefer the domain for addresses (generalizes "no-reply@x.com" style).
    const at = addr.indexOf('@');
    return at > 0 ? addr.slice(at + 1) : addr;
  }
  return String(email && email.fromName || '').trim().toLowerCase() || '(unknown)';
}
const _STOP = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'at', 're', 'fw', 'your', 'you', 'is', 'are', 'this', 'that', 'with', 'from', 'we', 'our', 'it']);
function _keywords(subject) {
  return String(subject || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 4 && !_STOP.has(w)).slice(0, 8);
}

function recordDeletion(email) {
  if (!email) return;
  const l = loadLearning();
  const key = _senderKey(email);
  const d = l.deleted[key] || { count: 0, lastAt: null, samples: [] };
  d.count += 1; d.lastAt = new Date().toISOString();
  const subj = String(email.subject || '').slice(0, 80);
  if (subj && d.samples.length < 5 && !d.samples.includes(subj)) d.samples.push(subj);
  l.deleted[key] = d;
  for (const w of _keywords(email.subject)) l.keywords.deleted[w] = (l.keywords.deleted[w] || 0) + 1;
  _saveLearning(l);
}

function recordKeep(email) {
  if (!email) return;
  const l = loadLearning();
  const key = _senderKey(email);
  const k = l.kept[key] || { count: 0, lastAt: null };
  k.count += 1; k.lastAt = new Date().toISOString();
  l.kept[key] = k;
  for (const w of _keywords(email.subject)) l.keywords.kept[w] = (l.keywords.kept[w] || 0) + 1;
  _saveLearning(l);
}

// A compact, prompt-ready summary of learned habits (top deleted/kept senders +
// keywords). Kept short so it fits the triage prompt budget.
function _learningSummary() {
  const l = loadLearning();
  const topSenders = (map, n) => Object.keys(map)
    .sort((a, b) => (map[b].count || 0) - (map[a].count || 0)).slice(0, n);
  const topWords = (map, n) => Object.keys(map)
    .sort((a, b) => (map[b] || 0) - (map[a] || 0)).slice(0, n);
  const delSenders = topSenders(l.deleted, 8);
  const keptSenders = topSenders(l.kept, 8);
  const delWords = topWords(l.keywords.deleted || {}, 10);
  const keptWords = topWords(l.keywords.kept || {}, 10);
  if (!delSenders.length && !keptSenders.length && !delWords.length) return '';
  const lines = [];
  if (delSenders.length) lines.push('- The user USUALLY DELETES mail from: ' + delSenders.join(', '));
  if (delWords.length) lines.push('- Subjects they usually delete contain: ' + delWords.join(', '));
  if (keptSenders.length) lines.push('- The user KEEPS (never suggest deleting) mail from: ' + keptSenders.join(', '));
  if (keptWords.length) lines.push('- Subjects they keep contain: ' + keptWords.join(', '));
  return lines.join('\n');
}

// ── Fleet-unit validation ──────────────────────────────────────────────────────
function _fleetRows() {
  try {
    const fd = store.load('fleetData', {}) || {};
    return Array.isArray(fd.rows) ? fd.rows : [];
  } catch (_) { return []; }
}

// Case-insensitive equipmentId lookup (mirrors pm_alert_reply.findUnit).
function _findUnit(rows, assetId) {
  const want = String(assetId || '').trim().toLowerCase();
  if (!want) return null;
  return rows.find((r) => String(r.equipmentId || '').trim().toLowerCase() === want) || null;
}

// Build a compact catalog of valid equipment IDs so the AI only matches real
// units — and so we can validate whatever it returns. Capped for prompt budget.
function _unitCatalog(rows) {
  const ids = [];
  for (const r of rows) {
    const id = String(r.equipmentId || '').trim();
    if (id) ids.push(id);
  }
  return ids;
}

// ── Prompt ──────────────────────────────────────────────────────────────────
function buildTriagePrompt(emails, unitIds) {
  const lines = [];
  lines.push('You are an executive assistant triaging a fleet operations manager\'s email inbox. For EACH email, decide importance, whether it warrants a reply, whether it is deletable noise, and whether it references a fleet unit with a status update.');
  lines.push('');
  lines.push('Return STRICT JSON ONLY, no prose, no markdown, in this exact shape:');
  lines.push('{"emails":[{"id":"<the id>","summary":"1-2 sentence plain summary INCLUDING what any attached files/pictures appear to be based on their names/types","importance":"high|normal|low","importanceWhy":"short reason","replySuggested":true|false,"deleteSuggested":true|false,"unitRefs":[{"unit":"<equipmentId>","update":"MM/DD - short status note for the unit timeline","ready":true|false}]}]}');
  lines.push('');
  lines.push('RULES:');
  lines.push('- importance high = time-sensitive, from a person, needs action (dealer/vendor/operator updates, approvals, escalations). low = newsletters, automated notifications, no-reply, marketing, calendar spam.');
  lines.push('- deleteSuggested true ONLY for clear noise (newsletters, automated notifications, marketing, auto-replies). NEVER suggest deleting a real person\'s message or anything referencing a unit.');
  lines.push('- replySuggested true when a human is asking a question or expecting a response.');
  lines.push('- unitRefs: ONLY include an equipmentId that appears in the VALID UNIT IDS list below. If the email mentions a number that is not in that list, DO NOT include it. If none, use an empty array.');
  lines.push('- For a unitRef, write `update` as a concise fleet-timeline note prefixed with today\'s date as MM/DD (e.g. "10/14 - Part arrived, repair scheduled per dealer email").');
  lines.push('- Set unitRef.ready=true ONLY when the email clearly states the unit is READY / repaired / done / available for pickup.');
  lines.push('- NEVER invent a unit, date, price, or fact not present in the email. Summaries must be grounded in the email text + attachment names given.');
  lines.push('');
  const learned = _learningSummary();
  if (learned) {
    lines.push('');
    lines.push('LEARNED FROM THIS USER\'S PAST DELETE/KEEP CHOICES (weight these heavily for deleteSuggested):');
    lines.push(learned);
  }
  lines.push('');
  lines.push('VALID UNIT IDS (match case-insensitively; only these are real):');
  lines.push(unitIds.length ? unitIds.join(', ') : '(none loaded)');
  lines.push('');
  lines.push('EMAILS:');
  emails.forEach((e, idx) => {
    const atts = (e.attachments || []).map((a) => a.name + ' [' + a.type + ']').join(', ');
    lines.push('--- EMAIL ' + (idx + 1) + ' ---');
    lines.push('id: ' + e.id);
    lines.push('from: ' + (e.fromName ? e.fromName + ' <' + e.from + '>' : e.from));
    lines.push('subject: ' + e.subject);
    if (e.receivedText) lines.push('received: ' + e.receivedText);
    if (atts) lines.push('attachments: ' + atts);
    lines.push('body: ' + String(e.bodyText || '').replace(/\s+/g, ' ').slice(0, BODY_PER_EMAIL_CAP));
    lines.push('');
  });
  return lines.join('\n');
}

// Split emails into batches whose prompt stays under PROMPT_CAP.
function _batchEmails(emails, unitIds) {
  const batches = [];
  let current = [];
  for (const e of emails) {
    const trial = current.concat([e]);
    if (buildTriagePrompt(trial, unitIds).length > PROMPT_CAP && current.length) {
      batches.push(current);
      current = [e];
    } else {
      current = trial;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

function _parseJson(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) {}
  // Best-effort: strip trailing commas and retry once.
  try { return JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1')); } catch (_) {}
  return null;
}

// Validate + sanitize one AI verdict against a known email + fleet rows.
function _mergeVerdict(email, verdict, rows) {
  const v = verdict || {};
  const importance = ['high', 'normal', 'low'].includes(String(v.importance)) ? v.importance : 'normal';
  // Validate unit refs against real fleet data — drop anything not real.
  const unitRefs = [];
  const seenUnits = {};
  for (const ur of (Array.isArray(v.unitRefs) ? v.unitRefs : [])) {
    const row = _findUnit(rows, ur && ur.unit);
    if (!row) continue; // invalid / hallucinated unit — never trust it
    const canonical = String(row.equipmentId || '').trim();
    if (seenUnits[canonical]) continue;
    seenUnits[canonical] = 1;
    unitRefs.push({
      unit: canonical,
      operator: String(row.operator || '').trim(),
      domicile: String(row.domicileSite || '').trim(),
      update: String(ur.update || '').trim().slice(0, 240),
      ready: !!ur.ready,
    });
  }
  return {
    id: email.id,
    from: email.from,
    fromName: email.fromName,
    subject: email.subject,
    receivedText: email.receivedText,
    folder: email.folder || 'Inbox',
    attachments: email.attachments || [],
    summary: String(v.summary || '').trim().slice(0, 600),
    importance,
    importanceWhy: String(v.importanceWhy || '').trim().slice(0, 200),
    replySuggested: !!v.replySuggested,
    deleteSuggested: !!v.deleteSuggested,
    unitRefs,
    triagedAt: new Date().toISOString(),
  };
}

// Deterministic fallback verdict when the AI is unavailable (never fabricates —
// flags normal importance, no delete, extracts unit refs by literal id match).
function _fallbackVerdict(email, rows) {
  const text = (email.subject + ' ' + (email.bodyText || '')).toLowerCase();
  const unitRefs = [];
  const seen = {};
  for (const r of rows) {
    const id = String(r.equipmentId || '').trim();
    if (!id || seen[id]) continue;
    const re = new RegExp('\\b' + id.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
    if (re.test(text)) {
      seen[id] = 1;
      const ready = /\b(ready|repaired|completed|complete|done|available for pickup|picked up)\b/.test(text);
      unitRefs.push({ unit: id, operator: String(r.operator || '').trim(), domicile: String(r.domicileSite || '').trim(), update: '', ready });
    }
  }
  return {
    id: email.id, from: email.from, fromName: email.fromName, subject: email.subject,
    receivedText: email.receivedText, folder: email.folder || 'Inbox', attachments: email.attachments || [],
    summary: '(AI unavailable) ' + String(email.subject || '').slice(0, 200),
    importance: 'normal', importanceWhy: 'AI triage unavailable', replySuggested: false,
    deleteSuggested: false, unitRefs, triagedAt: new Date().toISOString(), aiUnavailable: true,
  };
}

// ── Persisted results (merge preserving per-email reply state) ─────────────────
function loadResults() {
  const r = store.load('emailTriageResults', null);
  if (r && typeof r === 'object' && Array.isArray(r.emails)) return r;
  return { emails: [], ranAt: null, authBlocked: false };
}

// Merge freshly-triaged records over the stored ones, keyed by stable id.
// CRITICAL: a user's reply state (replyDraft, replyState) on an EXISTING email
// is preserved — a re-scan or new mail never wipes the Reply option/draft the
// user already engaged with. Emails that fell out of the top-N window are kept
// too (so an older email's reply option does not disappear).
function _mergeResults(prevResults, freshRecords, meta) {
  const prevById = {};
  for (const e of prevResults.emails) prevById[e.id] = e;

  const freshIds = {};
  const merged = freshRecords.map((rec) => {
    freshIds[rec.id] = 1;
    const prev = prevById[rec.id];
    if (prev) {
      // Keep the user's reply engagement + any applied-update bookkeeping.
      return {
        ...rec,
        replyDraft: prev.replyDraft || '',
        replyState: prev.replyState || 'none', // none | drafted | sent | dismissed
        unitUpdateApplied: prev.unitUpdateApplied || false,
        readyDmSent: prev.readyDmSent || false,
        firstSeenAt: prev.firstSeenAt || rec.triagedAt,
      };
    }
    return { ...rec, replyDraft: '', replyState: 'none', unitUpdateApplied: false, readyDmSent: false, firstSeenAt: rec.triagedAt };
  });

  // Carry forward older stored emails that weren't in this scan (don't drop
  // their reply option). Keep a bounded history so the file never grows forever.
  for (const e of prevResults.emails) {
    if (!freshIds[e.id]) merged.push(e);
  }
  // Newest-first by triagedAt/firstSeenAt, cap to 100 records.
  merged.sort((a, b) => String(b.triagedAt || b.firstSeenAt || '').localeCompare(String(a.triagedAt || a.firstSeenAt || '')));
  const capped = merged.slice(0, 100);

  return {
    emails: capped,
    ranAt: new Date().toISOString(),
    authBlocked: !!(meta && meta.authBlocked),
    readError: (meta && meta.readError) || null,
  };
}

/**
 * triageEmails(emails, opts) -> Promise<{ records:[...], aiUsed:boolean }>
 * Pure-ish: triages a given list of already-read email records. Does NOT read
 * the inbox (that's owa_reader) and does NOT persist (caller decides). Exposed
 * for the full runTriage() below + for tests.
 */
async function triageEmails(emails, opts) {
  opts = opts || {};
  const rows = _fleetRows();
  const unitIds = _unitCatalog(rows);
  const records = [];
  let aiUsed = false;

  // Fail-safe: drop rows that are clearly OWA chrome, not real emails. A real
  // email has a sender OR a substantive body; chrome rows (e.g. a scrape that
  // grabbed the navigation pane) have an empty sender and a tell-tale subject.
  const CHROME_SUBJECTS = /^(navigation pane|folder pane|reading pane|message list|favorites|folders)$/i;
  emails = (Array.isArray(emails) ? emails : []).filter((e) => {
    if (!e) return false;
    const from = String(e.from || '').trim();
    const fromName = String(e.fromName || '').trim();
    const body = String(e.bodyText || '').trim();
    const subj = String(e.subject || '').trim();
    if (CHROME_SUBJECTS.test(subj)) return false;      // obvious chrome
    if (from || fromName) return true;                  // has a real sender (address or name)
    if (body.length >= 25) return true;                 // has real body content
    return false;                                       // no sender + no body => junk
  });

  if (!emails.length) return { records, aiUsed };

  const batches = _batchEmails(emails, unitIds);
  const { reason } = require('../orcha/reason');
  for (const batch of batches) {
    const prompt = buildTriagePrompt(batch, unitIds);
    // Shared reasoning core: one AI call + robust JSON parse + timeout, never
    // throws. On ok:false (AI down/unparseable) parsed stays null and each
    // email falls back to _fallbackVerdict below — identical to before.
    const r = await reason({ prompt, expectArray: 'emails', signal: opts.signal, requestId: opts.requestId, label: 'email-triage' });
    const parsed = r.ok ? r.data : null;
    if (r.ok) aiUsed = true;
    const verdictById = {};
    if (parsed && Array.isArray(parsed.emails)) {
      for (const v of parsed.emails) { if (v && v.id) verdictById[v.id] = v; }
    }
    for (const email of batch) {
      const v = verdictById[email.id];
      records.push(v ? _mergeVerdict(email, v, rows) : _fallbackVerdict(email, rows));
    }
  }
  return { records, aiUsed };
}

/**
 * runTriage(opts) -> Promise<results>
 * Full pipeline: read the inbox (owa_reader) -> AI triage -> merge+persist.
 * opts: { max?, signal?, requestId?, _readInbox?, _electron? }
 * Returns the persisted results object (shape of loadResults()).
 */
async function runTriage(opts) {
  opts = opts || {};
  const cfg = getConfig();
  const max = Number.isFinite(opts.max) ? opts.max : cfg.maxEmails;
  const readInbox = opts._readInbox || require('./owa_reader').readInbox;

  const folders = Array.isArray(opts.folders) && opts.folders.length ? opts.folders : cfg.folders;
  let read;
  try {
    read = await readInbox({ max, folders, _electron: opts._electron });
  } catch (e) {
    const prev = loadResults();
    const out = _mergeResults(prev, [], { readError: 'read failed: ' + e.message });
    store.save('emailTriageResults', out);
    return out;
  }

  if (read && read.authBlocked) {
    const prev = loadResults();
    const out = _mergeResults(prev, [], { authBlocked: true, readError: read.error || 'auth blocked' });
    store.save('emailTriageResults', out);
    return out;
  }

  const emails = (read && Array.isArray(read.emails)) ? read.emails : [];
  const { records } = await triageEmails(emails, { signal: opts.signal, requestId: opts.requestId });

  const prev = loadResults();
  const out = _mergeResults(prev, records, { readError: (read && read.error) || null });
  store.save('emailTriageResults', out);
  logger.info('[email-triage] triaged ' + records.length + ' email(s); ' +
    records.filter((r) => r.unitRefs && r.unitRefs.length).length + ' with unit refs');
  return out;
}

// ── Auto-apply validated unit timeline updates ───────────────────────────────
// Shared by the IPC run handler and the auto-scan timer. Applies each email's
// validated unit `update` line to that unit's timeline (via email_actions,
// which mirrors into fleetData), marks the email so it is applied only once,
// and persists. The operator READY DM is NEVER auto-sent — always confirm-gated.
function applyPendingUnitUpdates(results) {
  if (!results || !Array.isArray(results.emails)) return 0;
  let actions = null;
  try { actions = require('./email_actions'); } catch (_) { return 0; }
  let applied = 0;
  for (const em of results.emails) {
    if (em.unitUpdateApplied) continue;
    const refs = Array.isArray(em.unitRefs) ? em.unitRefs : [];
    let didApply = false;
    for (const ref of refs) {
      if (!ref.unit || !ref.update) continue;
      const r = actions.applyUnitTimelineUpdate(ref.unit, ref.update);
      if (r && r.ok) { didApply = true; applied++; }
    }
    if (didApply) em.unitUpdateApplied = true;
  }
  if (applied) store.save('emailTriageResults', results);
  return applied;
}

// ── Auto-scan scheduler ───────────────────────────────────────────────────────
// A single idempotent setInterval that, every N minutes (cfg.autoScanMinutes),
// runs a triage + auto-applies unit updates — but ONLY when the feature is
// enabled AND autoScan is on. Overlapping runs are guarded. unref()'d so it
// never keeps the process alive. _rearmAutoScan() is called by saveConfig so a
// config change takes effect immediately.
let _autoTimer = null;
let _autoRunning = false;
let _autoNotify = null; // optional callback(results) set by the IPC layer to push UI updates

function _setAutoNotify(fn) { _autoNotify = typeof fn === 'function' ? fn : null; }

async function _autoTick() {
  const cfg = getConfig();
  if (!cfg.enabled || !cfg.autoScan) return;
  if (_autoRunning) return;
  _autoRunning = true;
  try {
    logger.info('[email-triage] auto-scan tick — folders: ' + (cfg.folders || []).join(', '));
    const results = await runTriage({});
    if (results && !results.authBlocked && cfg.autoApplyUnitUpdates) {
      applyPendingUnitUpdates(results);
    }
    if (_autoNotify) { try { _autoNotify(loadResults()); } catch (_) {} }
  } catch (e) {
    logger.warn('[email-triage] auto-scan failed: ' + e.message);
  } finally {
    _autoRunning = false;
  }
}

function startAutoScan() {
  stopAutoScan();
  const cfg = getConfig();
  const minutes = Math.max(15, Math.min(1440, parseInt(cfg.autoScanMinutes, 10) || 60));
  _autoTimer = setInterval(() => { _autoTick().catch(() => {}); }, minutes * 60 * 1000);
  if (_autoTimer.unref) _autoTimer.unref();
  logger.info('[email-triage] auto-scan scheduler started (every ' + minutes + ' min; fires only when enabled + autoScan on)');
  return stopAutoScan;
}

function stopAutoScan() {
  if (_autoTimer) { clearInterval(_autoTimer); _autoTimer = null; }
}

// Re-arm the timer to pick up a changed interval (and keep it running whether or
// not autoScan is currently on — the tick itself is the on/off gate, so toggling
// autoScan back on takes effect at the next tick without a restart). Only
// restarts the interval when the interval length actually changed.
let _armedMinutes = null;
function _rearmAutoScan() {
  const cfg = getConfig();
  const minutes = Math.max(15, Math.min(1440, parseInt(cfg.autoScanMinutes, 10) || 60));
  if (_autoTimer && _armedMinutes === minutes) return; // already armed at this cadence
  _armedMinutes = minutes;
  startAutoScan();
}

module.exports = {
  DEFAULT_CONFIG,
  getConfig,
  saveConfig,
  buildTriagePrompt,
  triageEmails,
  runTriage,
  loadResults,
  applyPendingUnitUpdates,
  startAutoScan,
  stopAutoScan,
  loadLearning,
  recordDeletion,
  recordKeep,
  _learningSummary,
  _setAutoNotify,
  // exported for tests / reuse
  _findUnit,
  _unitCatalog,
  _mergeVerdict,
  _fallbackVerdict,
  _mergeResults,
  _batchEmails,
  _parseJson,
  _autoTick,
};

'use strict';
/**
 * context-block.js — bounded "awareness" prompt section for Orcha
 * (context-aware assistant, design §D8).
 *
 * Fail closed: only source 'fab' (in-app FAB) and 'slack-justme' (the user's
 * own Just Me channel) get a block; any other or unknown source gets ''.
 * Hard cap AWARENESS_MAX_CHARS. Never dumps fleet rows: the only unit ids in
 * the block come from the screen context, the digest, the action log, the
 * ready-notice ledger and the notes feed.
 */

const store = require('../../store');

const AWARENESS_MAX_CHARS = 6500;
const FOCUS_MAX_MS = 10 * 60 * 1000;
const FAB_MAX_MS = 4 * 3600 * 1000;
const DIGEST_WINDOW_MS = 24 * 3600 * 1000;
const ACTION_WINDOW_MS = 72 * 3600 * 1000;
const NOTES_WINDOW_MS = 24 * 3600 * 1000;
const CAP = { screen: 500, digest: 1800, actions: 900, notes: 500 };
const MAX_DIGEST_LINES = 12;
const MAX_ACTIONS = 8;
const MAX_READY_NOTICES = 3;
const MAX_NOTES = 4;

const RULES_LINE = 'Use this section only to answer what Z asks (e.g. "this", "what changed", "what did I do"). Do not bring it up otherwise. Never claim you sent, escalated, flipped, or created anything. Escalation, lifecycle and WR changes are done by Z\'s click in the app.';

const DEICTIC_RE = /\b(this|that)\s+(unit|truck|one|wr|work\s*order)\b|\b(this|here)\s*\??$|^\s*(this|here)\b|\bwhat'?s\s+(going on|up|new|happening)\b|\b(escalate|flip|status of|update on)\s+(this|it)\b/i;
const DRAFTING_RE = /^\s*(please\s+)?(rewrite|reword|rephrase|draft|translate|proofread|shorten|polish)\b/i;

// Shared by FAB and Slack requests (one assistant, one conversation memory).
// Read-only here; advanced by markInjected() after a non-empty AI reply.
let _lastInjectedAt = 0;

function isDeictic(msg) {
  const s = String(msg || '');
  return DEICTIC_RE.test(s) && !DRAFTING_RE.test(s);
}

function markInjected(nowMs) { _lastInjectedAt = typeof nowMs === 'number' ? nowMs : Date.now(); }

function _hhmm(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function _oneLine(s, max) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max || 200); }

// Joins header + lines, adding lines in order while the section stays <= cap.
function _section(header, lines, cap) {
  if (!lines.length) return { header, lines: [] };
  const kept = [];
  let len = header.length;
  for (const l of lines) {
    if (len + 1 + l.length > cap) break;
    kept.push(l);
    len += 1 + l.length;
  }
  return { header, lines: kept };
}

function _render(sec) { return sec && sec.lines.length ? [sec.header].concat(sec.lines).join('\n') : ''; }

function _screenSection(sc, fresh) {
  const lines = [];
  if (sc.unitId) lines.push('Open unit: ' + sc.unitId + (sc.tab ? ' (tab: ' + sc.tab + ')' : ''));
  if (sc.wrId) lines.push('WR: ' + sc.wrId + (sc.secondaryWrCount ? ' (+' + sc.secondaryWrCount + ' other WRs)' : ''));
  if (sc.view) lines.push('View: ' + sc.view);
  const f = sc.filters && Object.keys(sc.filters).length ? Object.keys(sc.filters).map((k) => k + '=' + sc.filters[k]).join(', ') : '';
  if (f) lines.push('Filters: ' + f);
  if (sc.quickFilter) lines.push('Quick filter: ' + sc.quickFilter);
  if (sc.search) lines.push('Search: "' + sc.search + '"');
  if (!lines.length) return null;
  if (fresh && sc.unitId) lines.push('"this"/"here" = ' + sc.unitId + ' unless Z names another unit.');
  const header = fresh
    ? '=== WHAT Z IS LOOKING AT (desktop app, as of ' + _hhmm(sc.receivedAt) + ') ==='
    : '=== LAST VIEWED IN DESKTOP APP (' + _hhmm(sc.receivedAt) + ') ===';
  return _section(header, lines, CAP.screen);
}

function _digestLines(load, now) {
  const doc = load('assistantChangeDigest', null);
  const digests = (doc && Array.isArray(doc.digests)) ? doc.digests : [];
  const lines = [];
  for (const d of digests) {
    if (!d || typeof d.at !== 'number' || now - d.at > DIGEST_WINDOW_MS || !Array.isArray(d.entries)) continue;
    const isNew = d.at > _lastInjectedAt;
    for (const e of d.entries) {
      if (!e || !e.text) continue;
      const tag = (isNew ? 'NEW ' : '') + _hhmm(d.at) + (e.cu ? ', since last session' : '');
      lines.push('[' + tag + '] ' + _oneLine(e.text, 200));
      if (lines.length >= MAX_DIGEST_LINES) return lines;
    }
  }
  return lines;
}

function _actionLines(load, now, actionLog) {
  const lines = [];
  let acts = [];
  try { acts = actionLog.recent(MAX_ACTIONS, ACTION_WINDOW_MS, { load, now: () => now }) || []; } catch (_) { acts = []; }
  for (const a of acts.slice(0, MAX_ACTIONS)) {
    if (!a || !a.type) continue;
    lines.push(_hhmm(a.at) + ' ' + a.type + (a.unit ? ' ' + a.unit : '') + (a.wr ? ' WR ' + a.wr : '')
      + (a.detail ? ' (' + _oneLine(a.detail, 160) + ')' : '') + (a.actor === 'user-via-orcha' ? ' [via Orcha]' : ''));
  }
  let notices = [];
  try {
    notices = Object.values(load('readyPickupNotices', {}) || {})
      .filter((e) => e && e.unit && Date.parse(e.at) >= now - ACTION_WINDOW_MS)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, MAX_READY_NOTICES);
  } catch (_) { notices = []; }
  for (const e of notices) {
    lines.push(_hhmm(Date.parse(e.at)) + ' App auto-sent ready-pickup notice for ' + _oneLine(e.unit, 32)
      + ' to ' + _oneLine(e.operator || 'carrier', 64));
  }
  return lines;
}

function _noteLines(load, now) {
  const feed = load('assistantNotesFeed', null);
  const notes = (feed && Array.isArray(feed.notes)) ? feed.notes : [];
  return notes.filter((n) => n && !n.dismissed && typeof n.at === 'number' && now - n.at <= NOTES_WINDOW_MS)
    .slice(0, MAX_NOTES)
    .map((n) => '[' + _hhmm(n.at) + '] ' + _oneLine(n.text, 200));
}

/**
 * buildAwarenessBlock({ source, messageText, resolvedUnitIds }, deps) → { text, focusUnitId }
 * deps = { screen, load, now, actionLog }.
 */
function buildAwarenessBlock({ source } = {}, deps = {}) {
  if (source !== 'fab' && source !== 'slack-justme') return { text: '', focusUnitId: null };
  const load = deps.load || store.load;
  const now = (deps.now || Date.now)();
  const screen = deps.screen || require('./screen-context');
  const actionLog = deps.actionLog || require('./action-log');

  const sc = screen.get({ maxAgeMs: source === 'fab' ? FAB_MAX_MS : FOCUS_MAX_MS, nowMs: now });
  const fresh = !!(sc && now - sc.receivedAt <= FOCUS_MAX_MS);
  const focusUnitId = fresh && sc.unitId ? sc.unitId : null;

  const screenSec = sc ? _screenSection(sc, fresh) : null;
  const digestSec = _section('=== RECENT FLEET CHANGES (NEW = since your last reply) ===', _digestLines(load, now), CAP.digest);
  const actionSec = _section('=== Z\'S RECENT ACTIONS (do not repeat or contradict these) ===', _actionLines(load, now, actionLog), CAP.actions);
  const notesSec = _section('=== NOTES ORCHA ALREADY SENT Z ===', _noteLines(load, now), CAP.notes);

  const build = () => {
    const parts = [_render(screenSec), _render(digestSec), _render(actionSec), _render(notesSec)].filter(Boolean);
    return parts.length ? parts.concat([RULES_LINE]).join('\n\n') : '';
  };
  let text = build();
  // Overflow trim order: oldest digest entries, then oldest actions, then notes. Screen never trimmed.
  for (const sec of [digestSec, actionSec, notesSec]) {
    while (text.length > AWARENESS_MAX_CHARS && sec.lines.length) { sec.lines.pop(); text = build(); }
  }
  if (text.length > AWARENESS_MAX_CHARS) text = text.slice(0, AWARENESS_MAX_CHARS);
  return { text, focusUnitId };
}

function _resetForTests() { _lastInjectedAt = 0; }

module.exports = {
  buildAwarenessBlock, markInjected, isDeictic, DEICTIC_RE, DRAFTING_RE, AWARENESS_MAX_CHARS, RULES_LINE, _resetForTests,
};

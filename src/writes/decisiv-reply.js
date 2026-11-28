'use strict';
/**
 * writes/decisiv-reply.js — Decisiv (Volvo/PACCAR) case-notes reply with a recipient
 * picker. Pure builders, the case-roster / latest-note reads, and the one
 * token-checked POST. Staged and approved through src/writes/write-gate.js
 * kind 'decisivReply'; nothing here posts without a live approval token.
 *
 * Endpoints (live DevTools captures on volvopg.asist.decisiv.net; same API on PACCAR):
 *   roster  GET  /mobilecomm/api/contacts/estimate_contacts_for_group.json
 *                ?estimate_id={ID}&group_id=-1&filter={subcase_dealer|dealer}&mobile=false
 *   feed    GET  /mobilecomm/api/estimates/{ESTIMATE_ID}/activity_logs?page=1&per_page=50
 *   reply   POST /mobilecomm/api/estimates/{ESTIMATE_ID}/notes/{NOTE_ID}/reply.json
 *
 * Roster id and filter:
 *   - The app stores the ESTIMATE id: the /fleet/estimates/<id> number of the
 *     unit's Decisiv URL (offsiteShopEventUrl / savedOffsiteUrl / asistSrUrl,
 *     renderer id-links.js vendorWoOf). It goes in the feed and reply paths,
 *     and it is also the roster estimate_id param and the reply body
 *     subject_id (the "caseId" of loadCaseRoster). The Decisiv UI passes the
 *     page's own id to the roster call; no other source of a separate case id
 *     exists in the API responses the app reads (estimate detail and
 *     activity_logs carry none; estimate_contacts.json groups have no
 *     subcase_dealer entry), so no derivation step is done.
 *   - The filter varies by case ('subcase_dealer' on some, 'dealer' on others).
 *     loadCaseRoster tries subcase_dealer first (narrower case roster), then
 *     dealer, and takes the first non-empty list that is not directory-sized
 *     (> DIRECTORY_SIZE entries, which is what a wrong id/filter returns: the
 *     whole dealer directory, ~212 people). Both empty -> DECISIV_NO_ROSTER;
 *     only directory-sized lists -> DECISIV_ROSTER_TOO_BROAD. Nothing can be
 *     staged in either case.
 *
 * Logs carry codes and counts only, never text, names, emails or UUIDs.
 */

const ROSTER_GROUP_ID = -1;
// Tried in this order; the first one that yields a case-sized roster wins.
const ROSTER_FILTERS = Object.freeze(['subcase_dealer', 'dealer']);
// A list longer than this is taken as the full dealer directory, not a case
// roster. Live: case rosters ~35 people, the full directory 212.
const DIRECTORY_SIZE = 120;
// Volvo (volvopg.asist) and PACCAR (pssmfleet, paccarpg) run the identical Decisiv
// API; the reply/roster/notes endpoints were captured on Volvo. Matches decisiv_api.js KNOWN_HOST_RE.
const REPLY_HOST_RE = /^(?:volvopg\.asist|pssmfleet|paccarpg)\.decisiv\.net$/i;
const MAX_RECIPIENTS = 50;
const MAX_ROSTER = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPLY_PATH_RE = /^\/mobilecomm\/api\/estimates\/\d+\/notes\/\d+\/reply\.json$/;

let _deps = {};
function _api() { return _deps.api || require('../scrapers/decisiv_api'); }
function _isApprovalToken(t) {
  if (typeof _deps.isApprovalToken === 'function') return _deps.isApprovalToken(t);
  return require('./write-gate').isApprovalToken(t);
}
let _logger = null;
function _log(msg) {
  try {
    if (!_logger) _logger = require('../utils/logger')('decisiv-reply');
    _logger.info(msg);
  } catch (_) {}
}
function _code(e, fallback) {
  const c = e && typeof e.code === 'string' ? e.code : '';
  return /^DECISIV_[A-Z0-9_]{1,40}$/.test(c) ? c : (fallback || 'DECISIV_API_ERROR');
}
function _digits(v) {
  const s = v == null ? '' : String(v).trim();
  return /^\d{1,15}$/.test(s) ? s : '';
}

// ── refs and paths ──────────────────────────────────────────────────────────
/** { estimateId, srUrl } for a PACCAR /fleet/estimates/<id> URL, else null. */
function replyRefFromUrl(url) {
  let u;
  try { u = new URL(String(url || '')); } catch (_) { return null; }
  if (u.protocol !== 'https:' || !REPLY_HOST_RE.test(u.host)) return null;
  const m = /^\/fleet\/estimates\/(\d{1,15})(?:\/|$)/.exec(u.pathname);
  if (!m) return null;
  return { estimateId: m[1], srUrl: u.protocol + '//' + u.host.toLowerCase() + '/fleet/estimates/' + m[1] };
}
// estimate_id here is the roster id, which is also the reply's subject_id.
function rosterPath(caseId, filter) {
  if (!ROSTER_FILTERS.includes(filter)) throw Object.assign(new Error('decisivReply: bad roster filter'), { code: 'DECISIV_BAD_REF' });
  return '/mobilecomm/api/contacts/estimate_contacts_for_group.json?estimate_id=' + encodeURIComponent(String(caseId)) +
    '&group_id=' + ROSTER_GROUP_ID + '&filter=' + filter + '&mobile=false';
}
function activityPath(estimateId) {
  return '/mobilecomm/api/estimates/' + encodeURIComponent(String(estimateId)) + '/activity_logs?page=1&per_page=50';
}
function replyPath(estimateId, noteId) {
  return '/mobilecomm/api/estimates/' + encodeURIComponent(String(estimateId)) + '/notes/' + encodeURIComponent(String(noteId)) + '/reply.json';
}

// ── roster ──────────────────────────────────────────────────────────────────
function _rosterList(arr) {
  return Array.isArray(arr) ? arr : (arr && Array.isArray(arr.contacts) ? arr.contacts : []);
}
/** [{ id, name, jobRole, subGroup, filterName }] — no email or phone kept. */
function normalizeRoster(arr) {
  const list = _rosterList(arr);
  const out = [];
  const seen = new Set();
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const id = String(c.id == null ? '' : c.id).trim().toLowerCase();
    if (!UUID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(c.name == null ? '' : c.name).trim().slice(0, 120) || '(no name)',
      jobRole: String(c.job_role == null ? '' : c.job_role).trim().slice(0, 80),
      subGroup: String(c.sub_group == null ? '' : c.sub_group).trim().slice(0, 120),
      filterName: String(c.filter_name == null ? '' : c.filter_name).trim().slice(0, 40),
    });
    if (out.length >= MAX_ROSTER) break;
  }
  return out;
}

// ── latest note ─────────────────────────────────────────────────────────────
// Real activity_logs shape (shape probe .agents/tasks/relay-extract/shape-probe
// SUMMARY.md section 4; fixture tests/fixtures/extract/b62281-paccar.js):
// { notes:[{ id (number), draft, created_at, ... }], total_count, page, per_page }.
// created_at is NOT ISO: "11/10/26 10:28 am EST". The feed is served newest-first.
//
// Rule: page 1 (per_page=50). Candidates are notes with a numeric id and
// draft !== true. If every candidate's created_at parses (all in the same
// format), the newest is the max timestamp, ties going to the earlier feed
// position. Otherwise the newest is the first candidate (feed order). No
// candidate -> DECISIV_NO_NOTE. System-generated notes are not excluded (the
// user asked to reply to the last note).
const DECISIV_TIME_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)(?:\s+[A-Za-z]{1,5})?$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
/** { ms, kind:'decisiv'|'iso' } or null. The TZ is ignored: one feed shares one zone. */
function parseNoteTime(s) {
  const str = String(s == null ? '' : s).trim();
  const m = DECISIV_TIME_RE.exec(str);
  if (m) {
    const mo = Number(m[1]); const d = Number(m[2]);
    let y = Number(m[3]); if (m[3].length === 2) y += 2000;
    let h = Number(m[4]); const mi = Number(m[5]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h < 1 || h > 12 || mi > 59) return null;
    const pm = m[6].toLowerCase() === 'pm';
    if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
    return { ms: Date.UTC(y, mo - 1, d, h, mi), kind: 'decisiv' };
  }
  if (ISO_RE.test(str)) {
    const ms = Date.parse(str);
    if (Number.isFinite(ms)) return { ms, kind: 'iso' };
  }
  return null;
}
function pickLatestNote(json) {
  const notes = json && Array.isArray(json.notes) ? json.notes : (Array.isArray(json) ? json : []);
  const cands = [];
  for (const n of notes) {
    if (!n || typeof n !== 'object' || n.draft === true) continue;
    const id = _digits(n.id);
    if (id) cands.push({ id, t: parseNoteTime(n.created_at) });
  }
  if (!cands.length) return { ok: false, code: 'DECISIV_NO_NOTE' };
  const allTimed = cands.every((c) => c.t) && cands.every((c) => c.t.kind === cands[0].t.kind);
  if (!allTimed) return { ok: true, noteId: cands[0].id, by: 'feed-order' };
  let best = cands[0];
  for (const c of cands) if (c.t.ms > best.t.ms) best = c;
  return { ok: true, noteId: best.id, by: 'created_at' };
}

// ── request body ────────────────────────────────────────────────────────────
/** { path, body } for the reply POST. Throws on a bad payload. */
function buildReplyRequest(payload, noteId) {
  const p = payload || {};
  const estimateId = _digits(p.estimateId);
  const nid = _digits(noteId);
  const subjectId = Number(p.caseId);
  const text = String(p.text == null ? '' : p.text);
  const recipients = Array.isArray(p.recipients) ? p.recipients : [];
  if (!estimateId) throw Object.assign(new Error('decisivReply: no estimate id'), { code: 'DECISIV_BAD_REF' });
  if (!nid) throw Object.assign(new Error('decisivReply: no note id'), { code: 'DECISIV_NO_NOTE' });
  if (!_digits(p.caseId) || !Number.isSafeInteger(subjectId)) throw Object.assign(new Error('decisivReply: bad case id'), { code: 'DECISIV_BAD_CASE' });
  if (!text.trim()) throw Object.assign(new Error('decisivReply: empty text'), { code: 'DECISIV_EMPTY_TEXT' });
  if (!recipients.length || recipients.length > MAX_RECIPIENTS) throw Object.assign(new Error('decisivReply: bad recipient count'), { code: 'DECISIV_NO_RECIPIENTS' });
  const ids = recipients.map((r) => String(r && r.id != null ? r.id : '').trim().toLowerCase());
  if (ids.some((id) => !UUID_RE.test(id))) throw Object.assign(new Error('decisivReply: bad recipient id'), { code: 'DECISIV_RECIPIENT_UNKNOWN' });
  return {
    path: replyPath(estimateId, nid),
    body: {
      note: {
        recipients: ids.map((id) => ({ to_recipient_uuid: id, to_user_id: id, to_group_id: ROSTER_GROUP_ID })),
        draft: false,
        public: true,
        note: text,
      },
      reply_to_id: nid,
      subject_id: subjectId,
      group_id: ROSTER_GROUP_ID,
    },
  };
}

// ── reads (never throw) ─────────────────────────────────────────────────────
async function _fetchRoster(srUrl, id, filter) {
  try {
    const list = _rosterList(await _api().apiGetForCase(srUrl, rosterPath(id, filter)));
    return { ok: true, filter, total: list.length, contacts: normalizeRoster(list) };
  } catch (e) {
    return { ok: false, filter, code: _code(e) };
  }
}

/**
 * { ok, caseId, filter, contacts } | { ok:false, code }. caseId is the estimate
 * id: it is the roster estimate_id param and becomes the reply's subject_id.
 * Tries ROSTER_FILTERS in order; the first non-empty, case-sized list wins.
 */
async function loadCaseRoster({ estimateId, srUrl } = {}) {
  const est = _digits(estimateId);
  if (!est || !srUrl) return { ok: false, code: 'DECISIV_BAD_REF' };
  const tried = [];
  for (const filter of ROSTER_FILTERS) {
    const r = await _fetchRoster(srUrl, est, filter);
    tried.push(r);
    _log('[decisiv-reply] roster ' + filter + ': ' + (r.ok ? 'total=' + r.total : r.code));
    if (r.ok && r.contacts.length && r.total <= DIRECTORY_SIZE) {
      return { ok: true, caseId: est, filter, contacts: r.contacts };
    }
  }
  let code = 'DECISIV_NO_ROSTER';
  if (tried.some((r) => r.ok && r.contacts.length)) code = 'DECISIV_ROSTER_TOO_BROAD';
  else { const err = tried.find((r) => !r.ok); if (err) code = err.code; }
  _log('[decisiv-reply] roster failed: ' + code);
  return { ok: false, code };
}

/** { ok, noteId } | { ok:false, code } — the newest note on the estimate's feed. */
async function latestNoteId({ estimateId, srUrl } = {}) {
  const est = _digits(estimateId);
  if (!est || !srUrl) return { ok: false, code: 'DECISIV_BAD_REF' };
  try {
    const json = await _api().getActivityLogs(est, { srUrl, page: 1, perPage: 50 });
    return pickLatestNote(json);
  } catch (e) {
    return { ok: false, code: _code(e) };
  }
}

// ── the one POST (approval token required) ──────────────────────────────────
/** Called only by write-gate _send('decisivReply') with its single-use token. */
async function postApproved(srUrl, path, body, token) {
  if (!_isApprovalToken(token)) return { ok: false, code: 'DECISIV_NOT_APPROVED' };
  if (!REPLY_PATH_RE.test(String(path || ''))) return { ok: false, code: 'DECISIV_BAD_REF' };
  try {
    const json = await _api().apiPostForCase(srUrl, path, body);
    return { ok: true, json: json == null ? null : json };
  } catch (e) {
    return { ok: false, code: _code(e) };
  }
}

function _setDepsForTest(d) { _deps = d || {}; }

module.exports = {
  ROSTER_GROUP_ID, ROSTER_FILTERS, DIRECTORY_SIZE, REPLY_HOST_RE, MAX_RECIPIENTS, UUID_RE,
  replyRefFromUrl, rosterPath, activityPath, replyPath,
  normalizeRoster, parseNoteTime, pickLatestNote, buildReplyRequest,
  loadCaseRoster, latestNoteId, postApproved,
  _setDepsForTest,
};

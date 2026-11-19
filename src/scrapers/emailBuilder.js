'use strict';
/**
 * emailBuilder.js — Universal table-based fleet email (v5 color scheme)
 * Light content area + dark text = works in both light and dark mode
 * Uses <font> tags to survive OWA paste sanitizer
 */
const fs   = require('fs');
const path = require('path');
const logger = require('../utils/logger').createLogger('emailBuilder');
const TEMPLATE_PATH = path.join(__dirname, 'email_template.html');
// Render-time redaction (personal names + dollar amounts) for free text that
// goes into the email. Stored timeline / notes are never modified.
const { redactForEmail } = require('../orcha/redact_sharing');
// Timeline-digest engine (pure sync helpers + cached grounded digest lines).
// The email never calls the async AI/store paths (buildDigest / refresh).
const TD = require('../orcha/timeline-digest');
const TT = require('../orcha/timeline-text');

function ft(color, text, extra) {
  return `<font color="${color}" face="Arial,sans-serif"${extra ? ' style="'+extra+'"' : ''}>${text}</font>`;
}

// ── Report redesign helpers (2026-11, v3 OWA-safe layout) ─────────────────────
// Every block is a nested presentation table; fills are bgcolor + inline
// background-color (solid 6-digit hex); text goes through ft().
const TBL = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _state(u) { return String(u.atsState || u.lifecycleState || ''); }
function _isUnavail(u) { return _state(u).toLowerCase().indexOf('unavail') > -1; }
function _isOrdered(u) { return /^ordered$/i.test(_state(u).trim()); }

// Whole days from a duration string. AAP durations are "Nd Nh Nm"; legacy
// strings are "8 days". Returns null when no day count is present.
function _durDays(s) {
  const m = String(s || '').match(/(\d+)\s*d(?:ays?)?\b/i);
  return m ? parseInt(m[1], 10) : null;
}
// One severity scale: red >= 7 days, amber 3-6, else green.
function _sev(days) {
  if (days != null && days >= 7) return { spine: '#dc2626', pillBg: '#fde8e8', pillFg: '#dc2626', text: '#dc2626' };
  if (days != null && days >= 3) return { spine: '#d97706', pillBg: '#fff4d9', pillFg: '#b45309', text: '#d97706' };
  return { spine: '#16a34a', pillBg: '#dcf5e4', pillFg: '#15803d', text: '#16a34a' };
}
function _badge(bg, fg, text) {
  return `<table ${TBL} style="display:inline;"><tr><td bgcolor="${bg}" style="background-color:${bg};padding:2px 6px;border-radius:3px;">${ft(fg, '<b>' + text + '</b>', 'font-size:9px')}</td></tr></table>`;
}
function _makeBadge(model) {
  const makeRaw = (model || '').toLowerCase();
  let makeBg = '#f3f4f6', makeLbl = _esc(model || '--'), makeColor = '#374151';
  if (makeRaw.includes('freightliner')) { makeBg = '#e5e7eb'; makeLbl = 'FREIGHTLINER'; makeColor = '#1f2937'; }
  else if (makeRaw.includes('volvo'))   { makeBg = '#dbeafe'; makeLbl = 'VOLVO'; makeColor = '#1e3a5f'; }
  else if (makeRaw.includes('peterbilt')){ makeBg = '#fee2e2'; makeLbl = 'PETERBILT'; makeColor = '#7f1d1d'; }
  else if (makeRaw.includes('kenworth')) { makeBg = '#fef3c7'; makeLbl = 'KENWORTH'; makeColor = '#78350f'; }
  else if (makeRaw.includes('mack'))    { makeBg = '#fed7aa'; makeLbl = 'MACK'; makeColor = '#78350f'; }
  return _badge(makeBg, makeColor, makeLbl);
}
function _bodyBadge(label) {
  if (!label) return '';
  const l = label.toLowerCase();
  if (/day\s*cab|tractor/.test(l)) return _badge('#e0f2fe', '#075985', _esc(label.toUpperCase()));
  if (/sleeper/.test(l)) return _badge('#ede9fe', '#5b21b6', 'SLEEPER');
  if (/box/.test(l)) return _badge('#dcfce7', '#166534', 'BOX TRUCK');
  return _badge('#f3f4f6', '#374151', _esc(label.toUpperCase()));
}
function _chip(bg, border, fg, text) {
  return `<table ${TBL} style="display:inline;"><tr><td bgcolor="${bg}" style="background-color:${bg};border:1px solid ${border};border-radius:12px;padding:4px 11px;">${ft(fg, '<b>' + text + '</b>', 'font-size:10px')}</td></tr></table>&nbsp;`;
}
function _spineCard(spine, inner, border, innerBg, pad) {
  const bd = border || '#e3e8ef';
  const bg = innerBg || '#ffffff';
  return `<table ${TBL} width="100%" style="border:1px solid ${bd};border-radius:8px;border-collapse:separate;"><tr>
<td bgcolor="${spine}" width="6" style="background-color:${spine};width:6px;border-radius:8px 0 0 8px;font-size:1px;line-height:1px;">&nbsp;</td>
<td bgcolor="${bg}" style="background-color:${bg};padding:${pad || '12px 14px'};">${inner}</td>
</tr></table>`;
}
function _sectionRow(bg, content, pad, extra) {
  return `<tr><td bgcolor="${bg}" style="background-color:${bg};padding:${pad};${extra || ''}">${content}</td></tr>`;
}

// PM/DOT classification. Mirrors the in-app pmOverdueDays
// (renderer/src/js/util/pm-overdue.js): "Overdue N days" -> N; a full past
// date "Mon DD, YYYY" -> whole calendar days between local midnights
// (Math.round). Other overdue forms ("Overdue 5 months", "overdue", past
// month-only dates) are overdue with no day count.
// Accepted inputs: the raw AAP due fields (pmBDue etc.: "Mon D, YYYY",
// "Mon YYYY" = last day of that month as in relay.js _formatPmDate,
// "Overdue N days"), the short pill value (pmB etc.: "overdue" | "Mon D",
// which relay.js only emits for today or later, so it is the next such
// date), and ISO "YYYY-MM-DD" (local date).
// Returns null (no data), {overdue:true, days}, or {overdue:false, dueIn, label}.
function _pmInfo(val, now) {
  const t = String(val == null ? '' : val).trim();
  if (!t || t === '--' || /^unknown$/i.test(t)) return null;
  let m = t.match(/^overdue\s+(\d+)\s+days?$/i);
  if (m) { const n = parseInt(m[1], 10); return { overdue: true, days: n > 0 ? n : null }; }
  if (/^overdue\b/i.test(t)) return { overdue: true, days: null };
  const today = new Date(now.getTime()); today.setHours(0, 0, 0, 0);
  const dayLabel = (d) => { const dd = d.getDate(); return MONTHS_SHORT[d.getMonth()] + ' ' + (dd < 10 ? '0' + dd : '' + dd); };
  const classify = (d, label, exactDays) => {
    if (isNaN(d.getTime())) return null;
    d.setHours(0, 0, 0, 0);
    const n = Math.round((today - d) / 86400000);
    if (n > 0) return { overdue: true, days: exactDays ? n : null };
    return { overdue: false, dueIn: -n, label: label || dayLabel(d) };
  };
  m = t.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) return classify(new Date(m[1] + ' ' + m[2] + ', ' + m[3]), '', true);
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  if (m) return classify(new Date(+m[1], +m[2] - 1, +m[3]), '', true);
  m = t.match(/^([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  if (m) {
    const first = new Date(m[1] + ' 1, ' + m[2]);
    if (isNaN(first.getTime())) return null;
    return classify(new Date(first.getFullYear(), first.getMonth() + 1, 0), MONTHS_SHORT[first.getMonth()] + ' ' + m[2], false);
  }
  m = t.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})$/);
  if (m) {
    let d = new Date(m[1] + ' ' + m[2] + ', ' + today.getFullYear());
    if (isNaN(d.getTime())) return null;
    d.setHours(0, 0, 0, 0);
    if (d < today) d = new Date(d.getFullYear() + 1, d.getMonth(), d.getDate());
    return classify(d, '', true);
  }
  return null;
}
// Raw AAP due field for each short PM key (same map as the in-app
// renderer/src/js/util/pm-overdue.js PM_RAW_KEY).
const PM_RAW_KEY = { pmB: 'pmBDue', pmX: 'pmXDue', dot: 'dotDue', quarterlyLift: 'quarterlyLiftDue' };

// Free text -> redacted (names, $ amounts) -> HTML-escaped. Redaction runs
// on plain text before escaping/link-building; the source string is untouched.
function _safeText(s) { return _esc(redactForEmail(s)); }

// ── Condensed TIMELINE digest (email only, render time) ──────────────────────
// Dated trail (oldest first, one short line per date, same-day entries merged)
// plus the newest entry in full in a LATEST block. Ids, $ amounts, names and
// dealer-name hedges are stripped from a local copy; stored data is untouched.
const TRAIL_LINE_MAX = 160;
const _p2md = (md) => String(md || '').split('/').map(x => String(x).padStart(2, '0')).join('/');
const ID_FILLER = new Set(['additional', 'created', 'opened', 'open', 'new', 'case', 'cases', 'service', 'request',
  'requests', 'ticket', 'ref', 'also', 'another', 'and', 'the', 'was', 'were', 'has', 'been']);
const TOKEN_STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'was', 'were', 'are', 'has', 'have',
  'been', 'being', 'not', 'but', 'per', 'via', 'unit', 'into', 'its', 'all', 'any']);
const OEM_LEADS = /^(volvo|freightliner|kenworth|peterbilt|mack|international|cummins|navistar|paccar|daimler|amerit|penske|ryder|rush)$/i;

// '11/07 — x' / '11/07: x' / '11/16 Vendor: x' -> '11/07 - x' (the engine's LINE_RE form).
function _normTimeline(text) {
  return String(text || '').replace(/\r/g, '').split('\n').map(l => l.trim()
    .replace(/^(\d{1,2}\/\d{1,2}(?:\s*[-\u2013]\s*\d{1,2}\/\d{1,2})?)\s*[\u2014:]\s*/, '$1 - ')
    .replace(/^(\d{1,2}\/\d{1,2})\s+(?=[A-Za-z])/, '$1 - ')).join('\n');
}
function _parseTl(line) {
  const m = TT.LINE_RE.exec(String(line || '').trim());
  if (!m) return null;
  return { key: m[2] ? m[1] + '\u2013' + m[2] : m[1], pad: m[2] ? '' : _p2md(m[1]), body: m[4] };
}
// Dealer-name hedges, citation tags, email attributions, leading source labels.
function _stripHedges(s) {
  return String(s || '')
    .replace(/\s*\([^()]*\b(?:sources?\s+(?:disagree|differ|conflict)\w*|disputed?|dealer name|unclear)\b[^()]*\)/gi, '')
    .replace(/\s*\[F\d+\]/g, '')
    .replace(/\s*\(\s*per\b[^()]*\b(?:e-?mail|call|text|message|msg|voicemail)\b[^()]*\)/gi, '')
    .replace(/[,;]?\s*\(?\b(?:dealer|vendor|shop)\s+name\s+(?:disputed|unclear|unconfirmed)\b\)?/gi, '')
    .replace(/^\s*(?:Vendor|Dealer|Internal|Note)\s*:\s*/i, '');
}
const ID_LABELLED_RE = /(?:\b(?:ASIST|SF|Salesforce|DTNA|Decisiv|RO|WO|WR|SR)\s+)?(?:\b(?:cases?|service requests?|SR|tickets?|ref|work orders?|work requests?|orders?|requests?)\s*)?#?\s*\b\d{5,}\b(?:\s*\((?:created\s+)?\d{1,2}\/\d{1,2}\))?/gi;
function _stripIdsRaw(s) {
  return String(s || '')
    .replace(/\b(?:tow\s+)?ref\.?\s*#?\s*[A-Za-z0-9-]*\d[A-Za-z0-9-]{5,}/gi, '')
    .replace(/\bamz-[a-z0-9]{6,}\b/gi, '')
    .replace(ID_LABELLED_RE, '')
    .replace(/(?<![/\d.])\b\d{5,}\b(?![/\d])/g, '');
}
// Nothing left but dates, filler words and punctuation.
function _isResidue(t) {
  const words = String(t || '').replace(/\d{1,2}\/\d{1,2}/g, ' ').toLowerCase().match(/[a-z]+/g) || [];
  return words.every(w => ID_FILLER.has(w));
}
// Case / ASIST / SF / WR / SR ids, tow refs, amz- refs, bare 5+ digit runs.
function _stripEmailIds(s) {
  const t = String(s || '').replace(/\(([^()]*)\)/g, (m, inner) => {
    const x = _stripIdsRaw(inner);
    if (x === inner) return m;
    return _isResidue(x) ? '' : '(' + x + ')';
  });
  return _stripIdsRaw(t);
}
function _tidy(s) {
  return String(s || '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\(\s*(?:tow\s+)?(?:ref\.?)?[\s,;:]*\)/gi, '')
    .replace(/\b(?:against|for|via|under|on|to|per|with|from|of)\s+(?=(?:and|or)\b|[.,;:)]|$)/gi, '')
    .replace(/[:,;]\s*(?:(?:and|or)\s*)?(?=[.;]|$)/gi, '')
    .replace(/\s+(?:and|or)\s*(?=[.,;:])/gi, '')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/([.,;:])\1+/g, '$1')
    .replace(/^[\s.,;:]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
function _splitSentences(s) {
  return String(s || '').split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean);
}
// Canonical dealer from the record: dealerName, then subVendor (not the geofence), then vendor.
function _canonicalDealer(u) {
  const sub = u.subVendor && u.subVendor !== u.geofence ? u.subVendor : '';
  return String(u.dealerName || sub || u.vendor || '').trim();
}
// Label variants of the canonical shop ("Bergeys Truck Centers Pennsauk", "Bergey's")
// -> the canonical name. Generic OEM/vendor leads are left alone (could be another shop).
function _resolveDealer(s, u) {
  const canon = _canonicalDealer(u);
  const lead = (canon.match(/[A-Za-z'\u2019]{4,}/) || [''])[0];
  const stem = lead.replace(/['\u2019]s$/, '').replace(/['\u2019]/g, '');
  if (stem.length < 4 || OEM_LEADS.test(stem)) return s;
  const ci = stem.split('').map(c => (/[a-z]/i.test(c) ? '[' + c.toUpperCase() + c.toLowerCase() + ']' : c)).join('');
  const re = new RegExp('\\b' + ci + "(?:['\u2019]?s)?\\b(?:\\s+(?:-|[A-Z][A-Za-z]*)){0,4}", 'g');
  return String(s).replace(re, (m) => {
    const tail = /\s+-$/.exec(m);
    return canon + (tail ? tail[0] : '');
  });
}
// Body -> cleaned plain text (no condensing). Used for LATEST (in full) and trail rows.
function _cleanBody(body, u) {
  let s = _stripHedges(redactForEmail(String(body || '')));
  const out = [];
  for (const sen of _splitSentences(s)) {
    if (/\breturn tow\b[^.]*\brestrict|\bDO NOT set up FLEETNET/i.test(sen)) continue;
    if (/^[a-z]/.test(sen) && sen.split(/\s+/).length < 4) continue;
    let t = _tidy(_resolveDealer(_stripEmailIds(sen), u));
    if (!t || !/[A-Za-z]/.test(t) || (t !== sen && _isResidue(t))) continue;
    if (/^[\s.,;:]*$/.test(t)) continue;
    out.push(t.charAt(0).toUpperCase() + t.slice(1));
  }
  return out.join(' ');
}
function _abbrev(s) {
  return String(s || '')
    .replace(/\bEstimate\s+V(\d+)\b/gi, 'Est V$1')
    .replace(/\b(Est V\d+ approved)\.\s+Added scope:\s*/gi, '$1; added: ')
    .replace(/\b(Est V\d+ approved)\.\s+Scope:\s*/gi, '$1: ')
    .replace(/\bquality control\b/gi, 'QC');
}
function _clipLine(s, max) {
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  if (sp > max / 2) cut = cut.slice(0, sp);
  return cut.replace(/[\s,;:-]+$/, '') + '\u2026';
}
// Sentences -> one line <= TRAIL_LINE_MAX: highest-signal sentence first (engine
// IMPORTANT_CLASSES + vendor + estimate/root cause), more while they fit, source order.
function _oneLine(sentences, u) {
  const sens = (sentences || []).filter(Boolean);
  if (!sens.length) return '';
  const vre = TD.vendorClassRe(u);
  const classes = TD.IMPORTANT_CLASSES.filter(c => c.key !== 'caseRef');
  const protect = (x) => (vre && vre.test(x)) || /root cause|\bV\d/i.test(x);
  const score = (x) => classes.filter(c => c.re.test(x)).length + (vre && vre.test(x) ? 1 : 0) + (/root cause|\bEst V\d/i.test(x) ? 2 : 0);
  const order = sens.map((x, i) => ({ i, sc: score(x) })).sort((a, b) => b.sc - a.sc || a.i - b.i);
  let top = sens[order[0].i];
  if (top.length > TRAIL_LINE_MAX) {
    top = _tidy(top.replace(/\s*\(([^()]*)\)/g, (m, inner) => (protect(inner) ? m : '')));
    top = _clipLine(top, TRAIL_LINE_MAX);
  }
  const kept = { [order[0].i]: top };
  let len = top.length;
  for (const o of order.slice(1)) {
    const x = sens[o.i];
    if (len + 1 + x.length > TRAIL_LINE_MAX) continue;
    kept[o.i] = x;
    len += 1 + x.length;
  }
  return Object.keys(kept).map(Number).sort((a, b) => a - b).map(k => kept[k]).join(' ');
}
function _tokens(s) {
  return [...new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !TOKEN_STOP.has(w)))];
}
// Group history entries by date (first-seen order); drop sentences whose content
// tokens are >= 60% contained in an already-kept sentence of that date.
function _mergeSameDay(entries, u) {
  const groups = [];
  const byKey = {};
  for (const e of entries) {
    if (!byKey[e.key]) { byKey[e.key] = { key: e.key, pad: e.pad, sens: [] }; groups.push(byKey[e.key]); }
    const g = byKey[e.key];
    for (const sen of _splitSentences(_abbrev(_cleanBody(e.body, u)))) {
      const tk = _tokens(sen);
      if (!tk.length) continue;
      const dup = g.sens.some(k => tk.filter(w => k.tk.includes(w)).length / tk.length >= 0.6);
      if (!dup) g.sens.push({ text: sen, tk });
    }
  }
  return groups.map(g => ({ date: g.key, pad: g.pad, text: _oneLine(g.sens.map(x => x.text), u) })).filter(r => r.text);
}
// Cached grounded AI lines of unit.timelineDigest, by zero-padded single date,
// only when the digest matches the timeline being rendered (read only).
function _freshDigestLines(rawTimeline, digest, now) {
  const out = {};
  const d = digest;
  if (!d || d.v !== TD.DIGEST_VERSION || !/^ai(\+backfill)?$/.test(String(d.method || '')) || !Array.isArray(d.lines)) return out;
  const sp = TD.splitLatest(rawTimeline, now);
  if (sp.latest !== d.latestEntry || sp.history.length !== d.historyCount) return out;
  for (const line of d.lines) {
    const p = _parseTl(line);
    if (p && p.pad && !out[p.pad]) out[p.pad] = p.body;
  }
  return out;
}
function _fallbackLines(raw) {
  return String(raw || '').split('\n').filter(l => l.trim().length > 5)
    .map(l => _tidy(_stripEmailIds(redactForEmail(l.trim())))).filter(Boolean);
}
/**
 * _timelineDigestModel(u, rawTimeline, digest, now) ->
 *   { latest: {date, text} | null, trail: [{date, text}], fallback: string[] } (plain text).
 * Never throws; never mutates its inputs.
 */
function _timelineDigestModel(u, rawTimeline, digest, now) {
  const raw = String(rawTimeline || '');
  try {
    const unit = u || {};
    const sp = TD.splitLatest(TT.cleanTimelineMeta(_normTimeline(raw)), now);
    const lp = sp.latest ? _parseTl(sp.latest) : null;
    if (!lp) return { latest: null, trail: [], fallback: _fallbackLines(raw) };
    const latestText = _cleanBody(lp.body, unit);
    const ai = _freshDigestLines(raw, digest, now);
    const trail = _mergeSameDay(sp.history.map(_parseTl).filter(Boolean), unit).map(r => {
      const aiBody = r.pad ? ai[r.pad] : '';
      const aiText = aiBody ? _oneLine(_splitSentences(_abbrev(_cleanBody(aiBody, unit))), unit) : '';
      return { date: r.date, text: aiText || r.text };
    });
    return { latest: latestText ? { date: lp.key, text: latestText } : null, trail, fallback: latestText || trail.length ? [] : _fallbackLines(raw) };
  } catch (e) {
    try { return { latest: null, trail: [], fallback: _fallbackLines(raw) }; } catch (_) { return { latest: null, trail: [], fallback: [] }; }
  }
}
function _timelineDigestHtml(model) {
  const m = model || {};
  const trail = Array.isArray(m.trail) ? m.trail : [];
  if (!m.latest && !trail.length) {
    const fb = (m.fallback || []).map(_esc).filter(Boolean);
    return ft('#374151', fb.length ? fb.join('<br>') : '\u2014', 'font-size:10px;line-height:1.5');
  }
  let h = '';
  if (m.latest) {
    h += `<table ${TBL} width="100%" style="margin:3px 0 5px 0;"><tr><td class="eos-tl-latest" bgcolor="#fff4d9" style="background-color:#fff4d9;border:1px solid #eccd86;border-radius:4px;padding:5px 7px;">` +
      ft('#92500a', '<b>LATEST ' + _esc(m.latest.date) + '</b>', 'font-size:9px;letter-spacing:0.06em') + '<br>' +
      ft('#1f2937', '<b>' + _esc(m.latest.text) + '</b>', 'font-size:11px;line-height:1.45') + '</td></tr></table>';
  }
  if (trail.length) {
    h += `<table ${TBL} width="100%">` + trail.map(r =>
      `<tr><td class="eos-tl-date" valign="top" width="44" style="width:44px;padding:1px 6px 1px 0;white-space:nowrap;">` +
      ft('#1a56db', '<b>' + _esc(r.date) + '</b>', 'font-size:10px') +
      `</td><td valign="top" style="padding:1px 0;">` + ft('#374151', _esc(r.text), 'font-size:10px;line-height:1.4') + '</td></tr>').join('') + '</table>';
  }
  return h;
}

// Uptake asset uuid: explicit field when a caller provides it, else parsed
// from the insight deep link (https://fleet.uptake.com/asset/<uuid>/insights/..)
// which every caller already passes through as insightsList[].url.
const UUID_RE = /^[0-9a-f-]{20,}$/i;
function _uptakeUuid(u) {
  const direct = String(u.uptakeAssetUuid || u.assetUuid || '').trim();
  if (UUID_RE.test(direct)) return direct;
  const list = Array.isArray(u.insightsList) ? u.insightsList : [];
  for (const i of list) {
    const mm = String((i && i.url) || '').match(/\/asset\/([0-9a-f-]{20,})/i);
    if (mm && UUID_RE.test(mm[1])) return mm[1];
  }
  return '';
}

function _fill(template, key, value) {
  return template.split('{{' + key + '}}').join(value);
}

function buildEmail(opts) {
  const { operator, domicile, units, slot, testMode, relayCache, notesStore, emailNote } = opts;
  let template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

  // Raw AAP PM/DOT due fields (pmBDue etc.) live on the persisted fleet rows.
  // The send paths map rows to units without them (and the compose fallback
  // derives pmB from the legacy dueDate string, which is empty), so read them
  // here by unit id. Read-only.
  const fdById = {};
  try {
    const fd = require('../store').load('fleetData', { rows: [] });
    (Array.isArray(fd && fd.rows) ? fd.rows : []).forEach(r => { if (r && r.equipmentId) fdById[r.equipmentId] = r; });
  } catch (e) { logger.warn('fleetData PM lookup failed (non-fatal):', e.message); }

  // Merge relay cache + notes into units (fills in altId, vendor, duration etc. from cache)
  const allUnits = (units || []).map(u => {
    const rc = (relayCache && relayCache[u.id]) || {};
    const ns = (notesStore && notesStore[u.id]) || {};
    const fr = fdById[u.id] || {};
    const pmRaw = {};
    Object.keys(PM_RAW_KEY).forEach(k => { const rk = PM_RAW_KEY[k]; pmRaw[rk] = u[rk] || fr[rk] || ''; });

    // Model/Make: prefer relay cache (FREIGHTLINER, VOLVO etc.) over Uptake (MODEL YEAR 2021)
    let model = u.model || '';
    if (rc.model && !rc.model.match(/^MODEL YEAR/i)) model = rc.model;
    else if (model.match(/^MODEL YEAR/i) && rc.model) model = rc.model;
    // If still "MODEL YEAR..." check relay cache make field
    if (model.match(/^MODEL YEAR/i) && rc.make) model = rc.make;

    return {
      ...u,
      ...pmRaw,
      model: model,

      altId: u.altId || rc.altId || ns.altId || '',
      serviceUrl: u.serviceUrl || rc.serviceUrl || '',
      vendor: u.vendor || rc.vendor || ns.vendor || '',
      created: u.created || rc.created || ns.created || '',
      duration: u.duration || rc.duration || ns.duration || '',
      issue: u.issue || rc.issue || ns.issue || '',
      offsiteShopEvent: u.offsiteShopEvent || rc.offsiteShopEvent || ns.savedOffsiteEvent || '',
      offsiteShopEventUrl: u.offsiteShopEventUrl || rc.offsiteShopEventUrl || ns.savedOffsiteUrl || '',
      savedSalesforceCase: u.savedSalesforceCase || ns.savedSalesforceCase || '',
      issueSummary: u.issueSummary || ns.issueSummary || '',
      repairTimeline: u.repairTimeline || ns.timeline || '',
      savedTimeline: ns.timeline || '',
      savedSalesforceCaseUrl: u.savedSalesforceCaseUrl || ns.savedSalesforceCaseUrl || '',
      dealerName:             u.dealerName || rc.dealerName || ns.dealerName || '',
      subVendor:              u.subVendor || u.dealerName || rc.dealerName || ns.subVendor || ((/offsite/i.test(u.relayStatus||'')) ? (u.geofence||'') : '') || '',
    };
  });



  const now = new Date();
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const h = now.getHours(), m = now.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  const mm = m < 10 ? '0' + m : '' + m;
  const datetime = days[now.getDay()] + ', ' + months[now.getMonth()] + ' ' + now.getDate() + ', ' + now.getFullYear() + ' \u2014 ' + h12 + ':' + mm + ' ' + ampm + ' EDT';

  const greeting = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const slotLabel = slot || (h < 14 ? 'AM' : 'PM');
  const site = domicile || 'ALL';
  const op = (operator || '').toUpperCase();

  // Slot badge colors (solid hex — Outlook doesn't render rgba)
  const slotBg = slotLabel === 'AM' ? '#e0eeff' : '#fff4d9';
  const slotBorder = slotLabel === 'AM' ? '#7ab3f0' : '#e6b84d';
  const slotColor = slotLabel === 'AM' ? '#1a56db' : '#b87a00';
  const slotIcon = slotLabel === 'AM' ? '\u2600' : '\uD83C\uDF06';
  const slotDisplayLabel = slotLabel === 'AM' ? 'SOS REPORT' : 'EOS REPORT';

  // Filter units
  let filteredUnits;

  if (domicile && domicile !== 'ALL') {
    filteredUnits = allUnits.filter(u => (u.op || '').toUpperCase() === op && (u.site || '').toUpperCase() === domicile.toUpperCase());
  } else {
    filteredUnits = allUnits.filter(u => (u.op || '').toUpperCase() === op);
  }

  const unavailUnits = filteredUnits.filter(u => (u.atsState||u.lifecycleState) && (u.atsState||u.lifecycleState).toLowerCase().indexOf('unavail') > -1);
  const totalUnits = filteredUnits.length;
  const inService = totalUnits - unavailUnits.length;

  // Accent bar text — DESIGN UPDATE (2026-07-21): the bar itself is now a
  // permanent part of the template shell (always rendered, see
  // email_template.html), not conditional. Only the text inside it is
  // conditional: blank by default, "TEST" only during an actual test send.
  const testBanner = testMode ? 'TEST' : '&nbsp;';

  const inServicePct = totalUnits > 0 ? Math.round((inService / totalUnits) * 100) : 0;
  const reportTitle = slotLabel === 'AM' ? 'Start of Shift Report' : 'End of Shift Report';

  // Vendor chips — counted from currently unavailable units only (active vendor workload).
  const vendorCounts = {};
  unavailUnits.forEach(u => { const v = (u.vendor || '').trim(); if (v) vendorCounts[v] = (vendorCounts[v] || 0) + 1; });
  const vendorNames = Object.keys(vendorCounts);

  const noteBar = emailNote
    ? _sectionRow('#fdf3f3', `<font color="#dc2626" face="Arial,sans-serif" style="font-size:12px;font-weight:bold;">NOTE: ${emailNote.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</font>`, '10px 28px', 'border-bottom:1px solid #f3dede;')
    : '';

  // Body-type buckets (unchanged filters)
  const dayCabs = filteredUnits.filter(u => /day\s*cab|tractor/i.test(u.bodyType || ''));
  const sleepers = filteredUnits.filter(u => /sleeper/i.test(u.bodyType || ''));
  const boxTrucks = filteredUnits.filter(u => /box/i.test(u.bodyType || ''));
  const others = filteredUnits.filter(u => !dayCabs.includes(u) && !sleepers.includes(u) && !boxTrucks.includes(u));

  function bucketStat(title, label, list) {
    const down = list.filter(_isUnavail).length;
    const total = list.length;
    const inSvc = total - down;
    return { title, label, down, inSvc, total, pct: total > 0 ? Math.round((inSvc / total) * 100) : 0 };
  }
  const bucketStats = [];
  if (dayCabs.length) bucketStats.push(bucketStat('DAY CAB', 'Day Cab', dayCabs));
  if (sleepers.length) bucketStats.push(bucketStat('SLEEPER', 'Sleeper', sleepers));
  if (boxTrucks.length) bucketStats.push(bucketStat('BOX TRUCK', 'Box Truck', boxTrucks));
  if (others.length) bucketStats.push(bucketStat('OTHER', 'Other', others));
  if (!bucketStats.length) bucketStats.push(bucketStat('ALL UNITS', 'All Units', filteredUnits));

  // Body-type label per unit (bucket, else the legacy PM-table fallback)
  function bodyLabel(u) {
    if (dayCabs.includes(u)) return 'Day Cab';
    if (sleepers.includes(u)) return 'Sleeper';
    if (boxTrucks.includes(u)) return 'Box Truck';
    return u.bodyType || ((u.model || '').toLowerCase().includes('box') ? 'Box Truck' : (op === 'AUVTE' ? 'Box Truck' : 'Day Cab'));
  }

  // ── HERO tiles + health bar ──
  const nLines = bucketStats.length;
  const downLines = bucketStats.map(b => b.label + ' ' + b.down).join('<br>');
  const fleetLines = bucketStats.map(b => b.label + ' ' + b.total).join('<br>');
  let inLines = inService + ' of ' + totalUnits;
  for (let i = 1; i < nLines; i++) inLines += '<br>&nbsp;';
  function heroTile(bg, sub, label, big, suffix, lines) {
    return `<td bgcolor="${bg}" valign="top" style="background-color:${bg};border-radius:10px;padding:10px 14px;text-align:center;">
${ft(sub, label, 'font-size:9px;letter-spacing:0.12em')}<br>
${ft('#ffffff', '<b>' + big + '</b>', 'font-size:28px;font-weight:bold')}${suffix ? ft(sub, suffix, 'font-size:12px') : ''}<br>
${ft(sub, lines, 'font-size:9px;line-height:1.5')}
</td>`;
  }
  const heroTiles = `<table ${TBL} align="right"><tr>
${heroTile('#dc2626', '#ffe0e0', 'UNITS DOWN', unavailUnits.length, '&nbsp;/ ' + totalUnits, downLines)}
<td width="8" style="width:8px;">&nbsp;</td>
${heroTile('#16a34a', '#dcfce7', 'IN SERVICE', inServicePct, '%', inLines)}
<td width="8" style="width:8px;">&nbsp;</td>
${heroTile('#1565c0', '#d6e7fb', 'FLEET', totalUnits, '', fleetLines)}
</tr></table>`;

  const barTd = (hex, w) => `<td bgcolor="${hex}" width="${w}%" style="background-color:${hex};height:5px;line-height:5px;font-size:1px;">&nbsp;</td>`;
  let healthBar = `<table ${TBL} width="100%"><tr>`;
  if (totalUnits === 0) healthBar += barTd('#e2e8f0', 100);
  else {
    if (100 - inServicePct > 0) healthBar += barTd('#dc2626', 100 - inServicePct);
    if (inServicePct > 0) healthBar += barTd('#16a34a', inServicePct);
  }
  healthBar += '</tr></table>';

  // ── PM & DOT compliance chips ──
  const _hasBoxTrucks = filteredUnits.some(u => /box/i.test(u.bodyType || ''));
  const pmTypes = [['PM-B', 'pmB'], ['PM-X', 'pmX'], ['DOT', 'dot']];
  if (_hasBoxTrucks) pmTypes.push(['Quarterly Lift', 'quarterlyLift']);
  const pmOverdue = [], pmDue = [];
  filteredUnits.forEach(u => {
    pmTypes.forEach(([label, key]) => {
      // Raw AAP due date first (exact "Nd over"), else the short pill value.
      const info = _pmInfo(u[PM_RAW_KEY[key]], now) || _pmInfo(u[key], now);
      if (!info) return;
      if (info.overdue) pmOverdue.push({ id: u.id, label, days: info.days });
      else if (info.dueIn <= 60) pmDue.push({ id: u.id, label, dueIn: info.dueIn, date: info.label });
    });
  });
  pmOverdue.sort((a, b) => (b.days == null ? -1 : b.days) - (a.days == null ? -1 : a.days));
  pmDue.sort((a, b) => a.dueIn - b.dueIn);

  let pmSection = _sectionRow('#f1faf4',
    ft('#14532d', '<b>&#128197; PM &amp; DOT COMPLIANCE</b>', 'font-size:13px;font-weight:bold') +
    (filteredUnits.length ? ft('#5a8468', '&nbsp;&#8212; ' + pmOverdue.length + ' overdue, ' + pmDue.length + ' due soon', 'font-size:11px') : ''),
    '14px 24px 2px 24px', 'border-top:1px solid #d8eede;');
  if (filteredUnits.length) {
    const overdueChips = pmOverdue.length
      ? pmOverdue.map(p => _chip('#fde8e8', '#f5bcbc', '#b91c1c', _esc(p.id) + ' &#183; ' + p.label + ' ' + (p.days != null ? p.days + 'd over' : 'overdue'))).join('\n')
      : ft('#64748a', 'None overdue &#10003;', 'font-size:10px');
    const dueChips = pmDue.length
      ? pmDue.map(p => _chip('#fff4d9', '#eccd86', '#92500a', _esc(p.id) + ' &#183; ' + p.label + ' ' + _esc(p.date))).join('\n')
      : ft('#64748a', 'None due within 60 days', 'font-size:10px');
    pmSection += _sectionRow('#f1faf4', ft('#64748a', 'OVERDUE', 'font-size:9px;letter-spacing:0.08em') + '&nbsp;&nbsp;\n' + overdueChips, '8px 24px 2px 24px');
    pmSection += _sectionRow('#f1faf4', ft('#64748a', 'DUE &#8804; 60d', 'font-size:9px;letter-spacing:0.08em') + '&nbsp;&nbsp;\n' + dueChips, '6px 24px 12px 24px', 'border-bottom:1px solid #d8eede;');
  } else {
    pmSection += _sectionRow('#f1faf4', ft('#94a3b8', 'No PM data', 'font-size:12px'), '8px 24px 12px 24px', 'border-bottom:1px solid #d8eede;');
  }

  // ── Uptake + new delivery sets ──
  const riskUnits = filteredUnits.filter(u => u.riskScore && u.riskScore >= 60)
    .sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));
  const orderedUnits = filteredUnits.filter(_isOrdered);
  const veryHighCount = riskUnits.filter(u => (u.riskScore || 0) >= 75).length;

  // ── Quick stats line ──
  const nDel = orderedUnits.length;
  const quickStats = unavailUnits.length + ' down &#183; ' + pmOverdue.length + ' PM/DOT overdue &#183; ' +
    nDel + ' new ' + (nDel === 1 ? 'delivery' : 'deliveries') + ' &#183; ' + veryHighCount + ' very-high risk';

  // ── FLEET BY BODY TYPE ──
  const cardW = Math.floor(100 / bucketStats.length);
  let btCells = '';
  bucketStats.forEach((b, i) => {
    const last = i === bucketStats.length - 1;
    const inner = ft('#0f1b2d', '<b>' + b.title + ' &#183; ' + _esc(op) + '</b>', 'font-size:12px') + '<br>' +
      ft('#dc2626', '<b>' + b.down + '</b> down', 'font-size:11px') + ' ' + ft('#94a3b8', '&#183;', 'font-size:11px') + ' ' +
      ft('#16a34a', '<b>' + b.inSvc + '</b> in svc', 'font-size:11px') + '<br>' +
      ft('#64748a', b.total + ' total &#183; ', 'font-size:10px') + ft('#1565c0', '<b>' + b.pct + '%</b>', 'font-size:10px');
    btCells += `<td width="${last ? 100 - cardW * (bucketStats.length - 1) : cardW}%" valign="top" style="${last ? '' : 'padding-right:8px;'}">${_spineCard('#1565c0', inner, '#e3e8ef', '#ffffff', '9px 12px')}</td>`;
  });
  const bodyTypeSection = _sectionRow('#ffffff',
    ft('#334155', '<b>&#128202; FLEET BY BODY TYPE</b>', 'font-size:11px;font-weight:bold;letter-spacing:0.06em') +
    `<table ${TBL} width="100%" style="margin-top:8px;"><tr>${btCells}</tr></table>`,
    '16px 24px 14px 24px');

  // ── UNAVAILABLE UNITS as status cards ──
  let unavailBreak = '';
  if (bucketStats.length > 1 && unavailUnits.length) {
    const parts = bucketStats.filter(b => b.down > 0).map(b => b.down + ' ' + b.label);
    if (parts.length) unavailBreak = ' (' + parts.join(' &#183; ') + ')';
  }
  let unavailSection = _sectionRow('#fdf3f3',
    ft('#7f1d1d', '<b>&#128683; UNAVAILABLE UNITS</b>', 'font-size:13px;font-weight:bold') +
    ft('#a06464', '&nbsp;&#8212; ' + unavailUnits.length + ' down' + unavailBreak, 'font-size:11px'),
    '14px 24px 12px 24px', 'border-top:1px solid #f3dede;border-bottom:1px solid #f3dede;');
  if (vendorNames.length) {
    unavailSection += _sectionRow('#ffffff',
      ft('#64748a', 'ACTIVE VENDORS:&nbsp;', 'font-size:9px;letter-spacing:0.05em') +
      vendorNames.map(v => `<table ${TBL} style="display:inline;"><tr><td bgcolor="#eef2f7" style="background-color:#eef2f7;border-radius:10px;padding:3px 10px;">${ft('#334155','<b>'+_esc(v.toUpperCase())+': '+vendorCounts[v]+'</b>','font-size:9px')}</td></tr></table>&nbsp;`).join(''),
      '10px 24px 0 24px');
  }

  const link = (href, text) => '<a href="' + _esc(href) + '" style="color:#1a56db;font-size:10px;font-weight:bold;text-decoration:underline;">' + _esc(text) + '</a>';
  if (unavailUnits.length) {
    unavailUnits.forEach(u => {
      const duration = u.duration || '';
      const sev = _sev(_durDays(duration));

      const repairStatus = u.savedRepairStatus || u.relayStatus || '--';
      let rsColor = '#555555';
      if (/repairs in progress/i.test(repairStatus)) rsColor = '#d97706';
      else if (/amerit/i.test(repairStatus)) rsColor = '#7c3aed';
      else if (/done|complete/i.test(repairStatus)) rsColor = '#16a34a';

      const vendor = u.vendor || '';
      const timeline = u.repairTimeline || u.savedTimeline || '';
      // BUG FIX (2026-07-16): never fall back to u.savedNotes (private
      // scratchpad). Only the repair timeline goes out in the email.
      // Redacted per line (names, $ amounts); the stored timeline is untouched.
      const tlLines = timeline ? timeline.split('\n').filter(l => l.trim().length > 5).map(l => _safeText(l.trim())).filter(Boolean) : [];
      // TIMELINE cell: condensed digest (render time; stored timeline untouched).
      const tlDigest = u.timelineDigest || ((notesStore || {})[u.id] || {}).timelineDigest || (fdById[u.id] || {}).timelineDigest || null;
      const tlHtml = _timelineDigestHtml(_timelineDigestModel(u, timeline, tlDigest, now));

      // Case / Offsite: Alt ID + Offsite Event + Salesforce Case (all hyperlinked)
      const altId = u.altId || '';
      const offsiteEvent = u.offsiteShopEvent || u.savedOffsiteEvent || '';
      const offsiteUrl = u.offsiteShopEventUrl || u.savedOffsiteUrl || '';
      const sfCase = u.savedSalesforceCase || '';
      const sfUrl = u.savedSalesforceCaseUrl || '';
      const serviceUrl = u.serviceUrl || '';
      const caseParts = [];
      // Plain space before the dot so a long line breaks between items.
      const caseItem = (label, val, url) => ft('#94a3b8', ' &#183;&nbsp;' + label + ' ', 'font-size:10px') +
        (url ? link(url, val) : ft('#1a56db', '<b>' + _esc(val) + '</b>', 'font-size:10px'));
      if (altId) caseParts.push(caseItem('Alt ID', altId, serviceUrl));
      if (offsiteEvent) caseParts.push(caseItem('Offsite', offsiteEvent, offsiteUrl));
      if (sfCase) caseParts.push(caseItem('Case', sfCase, sfUrl));

      // Relay Garage: every down unit with a vendor/dealer, an issue summary,
      // or a timeline gets a block (was offsite + vendor only). Vendor (or
      // dealer / sub-vendor) bold, location, Down, AI issue, freshest
      // timeline line. "—" only when none of that exists.
      let rgHtml = ft('#bbbbbb', '\u2014', 'font-size:10px');
      // subVendor falls back to geofence in the merge above; don't print it as a vendor.
      const _subV = [u.subVendor, u.dealerName].find(s => s && s !== u.geofence) || '';
      const rgVendor = vendor || _subV;
      const aiIssue = _safeText(u.issueSummary || u.issue || '');
      const lastUpdate = tlLines.length ? tlLines[tlLines.length - 1] : '';
      if (rgVendor || aiIssue || lastUpdate) {
        rgHtml = rgVendor ? ft('#1e2d3d', '<b>' + _esc(rgVendor) + '</b>', 'font-size:11px') : '';
        const extra = [];
        if (_subV && _subV !== rgVendor) extra.push(_esc(_subV));
        if (u.geofence) extra.push('\uD83D\uDCCD ' + _esc(u.geofence));
        if (extra.length) rgHtml += (rgHtml ? ' ' : '') + ft('#7c3aed', (rgHtml ? '&#183; ' : '') + extra.join(' &#183; '), 'font-size:10px');
        const rgLines = [];
        if (duration) rgLines.push(ft(sev.text, '<b>Down: ' + _esc(duration) + '</b>', 'font-size:10px'));
        if (aiIssue) rgLines.push(ft('#555555', '<i>' + aiIssue + '</i>', 'font-size:10px'));
        if (lastUpdate) rgLines.push(ft('#64748a', '<b>Last update:</b> ', 'font-size:10px') + ft('#374151', lastUpdate, 'font-size:10px'));
        rgHtml += (rgHtml && rgLines.length ? '<br>' : '') + rgLines.join('<br>');
      }

      const compReason = [u.savedPrimaryComponent, u.relayStatus].filter(s => s && s !== '--').map(_esc).join(' &#183; ');
      const where = [u.site, u.op].filter(Boolean).map(_esc).concat(['Unavailable']).join(' &#183; ');

      const header = `<table ${TBL} width="100%"><tr>
<td valign="top" width="62%">
${ft('#1a56db', '<b>' + _esc(u.id || '--') + '</b>', 'font-size:15px;font-weight:bold')}
&nbsp;${_makeBadge(u.model)}
&nbsp;${_bodyBadge(bodyLabel(u))}
${compReason ? '&nbsp;' + ft('#64748a', compReason, 'font-size:10px') : ''}
<br>${ft('#64748a', where, 'font-size:10px')}
</td>
<td valign="top" align="right" width="38%">
<table ${TBL} align="right"><tr><td bgcolor="${sev.pillBg}" style="background-color:${sev.pillBg};border-radius:10px;padding:4px 10px;text-align:right;">${ft(sev.pillFg, '<b>&#9660; DOWN' + (duration ? ' ' + _esc(duration) : '') + '</b>', 'font-size:11px')}</td></tr></table>
</td>
</tr>
<tr><td colspan="2" valign="top" width="100%" class="eos-meta" style="width:100%;padding-top:3px;line-height:1.5;word-wrap:break-word;word-break:break-word;overflow-wrap:anywhere;">
${ft(rsColor, '<b>' + _esc(repairStatus) + '</b>', 'font-size:11px')}${caseParts.join('')}
</td></tr></table>`;
      const body = `<table ${TBL} width="100%" style="margin-top:8px;"><tr>
<td valign="top" width="410" style="width:410px;padding-right:10px;word-wrap:break-word;word-break:break-word;">
${ft('#64748a', 'RELAY GARAGE', 'font-size:9px;letter-spacing:0.08em')}<br>
${rgHtml}
</td>
<td valign="top" width="436" bgcolor="#f7f9fc" style="width:436px;background-color:#f7f9fc;border:1px solid #e5e9f0;border-radius:6px;padding:8px 10px;word-wrap:break-word;word-break:break-word;">
${ft('#64748a', 'TIMELINE', 'font-size:9px;letter-spacing:0.08em')}<br>
${tlHtml}
</td>
</tr></table>`;
      unavailSection += _sectionRow('#ffffff', _spineCard(sev.spine, header + body), '10px 24px 0 24px');
    });
    unavailSection += _sectionRow('#ffffff', '&nbsp;', '0', 'height:14px;line-height:14px;font-size:1px;');
  } else {
    unavailSection += _sectionRow('#ffffff', ft('#94a3b8', 'No unavailable units &#10003;', 'font-size:12px'), '14px 24px', 'text-align:center;');
  }

  // ── UPTAKE INSIGHTS (score >= 60) ──
  let uptakeHtml = ft('#4c1d95', '<b>&#9889; UPTAKE INSIGHTS</b>', 'font-size:13px;font-weight:bold');
  if (riskUnits.length) {
    riskUnits.forEach(u => {
      const score = u.riskScore || 0;
      const scoreColor = score >= 75 ? '#dc2626' : '#d97706';
      const tier = u.riskTier || (score >= 75 ? 'Very High' : score >= 50 ? 'High' : 'Medium');
      const tierColor = /very\s*high/i.test(tier) ? '#dc2626' : /high/i.test(tier) ? '#d97706' : '#6b7280';
      let insight = '';
      if (u.insightsList && u.insightsList.length) {
        const active = u.insightsList.filter(i => i.stillActive);
        insight = active.length ? active.map(i => i.title || i.description || '').join('; ') : (u.insightsList[0].title || '');
      } else if (u.insights) { insight = u.insights; }

      // Auto-determine PM status
      const issueText = ((u.savedNotes || '') + ' ' + (u.issue || '')).toLowerCase();
      const hasPM = issueText.includes('predictive maintenance') || issueText.includes('predictive maint');
      const isActive = _state(u) && _state(u).toLowerCase() === 'available';
      let pmStatus = u.pmStatus || '';
      if (!pmStatus) {
        if (hasPM && isActive) pmStatus = 'Completed';
        else if (hasPM) pmStatus = 'In Progress';
        else if (score >= 80) pmStatus = 'In Review';
        else pmStatus = 'Opened';
      }
      const pmColors = { 'Opened': '#6b7280', 'In Review': '#d97706', 'In Progress': '#2563eb', 'Completed': '#16a34a' };
      const pmColor = pmColors[pmStatus] || '#6b7280';

      const uuid = _uptakeUuid(u);
      const uptakeLink = uuid
        ? '&nbsp;&nbsp;<a href="https://fleet.uptake.com/asset/' + _esc(uuid) + '" style="color:#4c1d95;font-size:10px;font-weight:bold;text-decoration:underline;">View in Uptake &#8594;</a>'
        : '';
      const where = [u.op, u.site].filter(Boolean).map(_esc).join(' &#183; ');
      const inner = ft('#1a56db', '<b>' + _esc(u.id || '--') + '</b>', 'font-size:13px') +
        `&nbsp;<table ${TBL} style="display:inline;"><tr><td style="border:2px solid ${scoreColor};border-radius:50%;padding:1px 6px;">${ft(scoreColor, '<b>' + score + '</b>', 'font-size:11px')}</td></tr></table>` +
        '&nbsp;' + ft(tierColor, '<b>' + _esc(tier) + '</b>', 'font-size:10px') +
        (where ? '&nbsp;' + ft('#64748a', where, 'font-size:10px') : '') +
        '<br>' + ft('#333333', insight ? _esc(insight) : '\u2014', 'font-size:10px') +
        '<br>' + ft(pmColor, '<b>Status: ' + _esc(pmStatus) + '</b>', 'font-size:10px') + uptakeLink;
      uptakeHtml += `<table ${TBL} width="100%" style="margin-top:6px;"><tr><td>${_spineCard(scoreColor, inner, '#e3e0f0', '#ffffff', '10px 12px')}</td></tr></table>`;
    });
  } else {
    uptakeHtml += '<br>' + ft('#94a3b8', 'No active predictive insights (score &lt; 60)', 'font-size:11px');
  }

  // ── NEW DELIVERY (lifecycle ORDERED / Pending Delivery) ──
  let deliveryHtml = '';
  if (orderedUnits.length) {
    deliveryHtml = ft('#0e7490', '<b>&#128666; NEW DELIVERY</b>', 'font-size:13px;font-weight:bold');
    orderedUnits.forEach(u => {
      const wr = u.issue || u.issueSummary || '';
      const inner = ft('#1a56db', '<b>' + _esc(u.id || '--') + '</b>', 'font-size:13px') + '&nbsp;' + _makeBadge(u.model) +
        '<br>' + ft('#b87a00', '<b>ORDERED &#183; ' + _esc(u.relayStatus || 'Pending Delivery') + '</b>', 'font-size:10px') +
        (wr ? '<br>' + ft('#555555', _safeText(wr), 'font-size:10px') : '');
      deliveryHtml += `<table ${TBL} width="100%" style="margin-top:6px;"><tr><td>${_spineCard('#0e7490', inner, '#cfe9f2', '#ffffff', '10px 12px')}</td></tr></table>`;
    });
  }
  const insightsInner = deliveryHtml
    ? `<table ${TBL} width="100%"><tr><td valign="top" width="530" style="width:530px;padding-right:10px;">${uptakeHtml}</td><td valign="top" width="362" style="width:362px;">${deliveryHtml}</td></tr></table>`
    : uptakeHtml;
  const insightsDeliverySection = _sectionRow('#f6f4fc', insightsInner, '14px 24px 14px 24px', 'border-top:1px solid #e5e0f2;');

  // Smart change summary — what changed since the last verified send of this scope
  let changeMeta = null;
  try {
    const { buildChangeSummary } = require('./email-summary');
    // Scope the change-summary snapshot per operator (+domicile if scoped) +slot
    // so each recipient's "new / returned" diff compares against its own history,
    // not a shared global snapshot that other operators' sends overwrite.
    const _scopeKey = [String(op || 'ALL').toUpperCase(),
                       (domicile && domicile !== 'ALL') ? String(domicile).toUpperCase() : '',
                       String(slotLabel || '')].filter(Boolean).join('_');
    const result = buildChangeSummary(filteredUnits, { slot: slotLabel, scopeKey: _scopeKey });
    changeMeta = result.meta || null;
  } catch (e) { logger.warn('Change summary failed (non-fatal):', e.message); }

  let changeRow = '';
  if (changeMeta && changeMeta.hasBaseline) {
    const slotName = changeMeta.prevSlot === 'AM' ? 'AM / SOS' : changeMeta.prevSlot === 'PM' ? 'PM / EOS' : String(changeMeta.prevSlot || '');
    let when = '';
    if (changeMeta.prevSentAt) {
      const d = new Date(changeMeta.prevSentAt);
      if (!isNaN(d.getTime())) {
        const ph = d.getHours(), pm = d.getMinutes();
        when = MONTHS_SHORT[d.getMonth()] + ' ' + d.getDate() + ', ' + (ph % 12 || 12) + ':' + (pm < 10 ? '0' + pm : pm) + ' ' + (ph >= 12 ? 'PM' : 'AM');
      }
    }
    const lbl = [slotName, when].filter(Boolean).map(_esc).join(' &#183; ');
    let c = ft('#64748a', 'SINCE LAST REPORT' + (lbl ? ' (' + lbl + ')' : '') + '&nbsp;&nbsp;', 'font-size:9px;letter-spacing:0.08em');
    if (changeMeta.newCount > 0) c += _chip('#fde8e8', '#f5bcbc', '#b91c1c', '&#9650; ' + changeMeta.newCount + ' newly down');
    if (changeMeta.returnedCount > 0) c += _chip('#dcf5e4', '#a7e3bd', '#15803d', '&#9660; ' + changeMeta.returnedCount + ' back in service');
    if (changeMeta.stalledCount > 0) c += _chip('#fff4d9', '#eccd86', '#92500a', '&#9888; ' + changeMeta.stalledCount + ' stalled');
    const idParts = [];
    if ((changeMeta.newIds || []).length) idParts.push('New: ' + changeMeta.newIds.map(_esc).join(', '));
    if ((changeMeta.returnedIds || []).length) idParts.push('Returned: ' + changeMeta.returnedIds.map(_esc).join(', '));
    if ((changeMeta.stalled || []).length) idParts.push('Stalled: ' + changeMeta.stalled.map(s => _esc(s.id) + ' (' + s.daysDown + 'd)').join(', '));
    if (idParts.length) c += ft('#94a3b8', '&nbsp;' + idParts.join(' &#183; '), 'font-size:10px');
    if (!changeMeta.newCount && !changeMeta.returnedCount && !changeMeta.stalledCount) {
      c += ft('#475569', '&#10003; No significant changes since last report. Fleet status stable.', 'font-size:10px');
    }
    const dl = changeMeta.delta > 0 ? ' (+' + changeMeta.delta + ')' : changeMeta.delta < 0 ? ' (' + changeMeta.delta + ')' : '';
    c += '<br>' + ft('#64748a', 'Unavailable ' + changeMeta.unavailCount + dl + ' &#183; Avg days down ' + _esc(changeMeta.avgDaysDown) +
      ' &#183; High risk (70+) ' + changeMeta.highRiskCount, 'font-size:10px');
    changeRow = _sectionRow('#ffffff', c, '12px 28px 2px 28px');
  }

  // Dynamic greeting body based on site content
  const hasUptake = filteredUnits.some(u => u.riskScore && u.riskScore >= 60);
  let pmList = 'PM-B / PM-X / DOT' + (_hasBoxTrucks ? ' / Quarterly Lift' : '');

  let greetBody = 'Below is the <b>' + slotDisplayLabel.replace(' REPORT','') + ' fleet maintenance update</b> for <b>' + _esc(op) + '</b>. This report covers unavailable units, ' + pmList + ' due dates, relay garage events';
  if (hasUptake) greetBody += ', and <b>high-risk predictive maintenance insights (Uptake)</b>';
  greetBody += '.';

  // Replace placeholders (split/join: values are never treated as regex replacement patterns)
  template = _fill(template, 'TEST_BANNER', testBanner);
  template = _fill(template, 'DATETIME', datetime);
  template = _fill(template, 'SITE', _esc(site));
  template = _fill(template, 'OPERATOR', _esc(op));
  template = _fill(template, 'REPORT_TITLE', reportTitle);
  template = _fill(template, 'HERO_TILES', heroTiles);
  template = _fill(template, 'HEALTH_BAR', healthBar);
  template = _fill(template, 'QUICK_STATS', quickStats);
  template = _fill(template, 'GREETING', greeting);
  template = _fill(template, 'GREETING_BODY', greetBody);
  template = _fill(template, 'SLOT', slotLabel);
  template = _fill(template, 'SLOT_LABEL', slotDisplayLabel);
  template = _fill(template, 'SLOT_BG', slotBg);
  template = _fill(template, 'SLOT_BORDER', slotBorder);
  template = _fill(template, 'SLOT_COLOR', slotColor);
  template = _fill(template, 'SLOT_ICON', slotIcon);
  template = _fill(template, 'NOTE_BAR', noteBar);
  template = _fill(template, 'CHANGE_ROW', changeRow);
  template = _fill(template, 'BODY_TYPE_SECTION', bodyTypeSection);
  template = _fill(template, 'UNAVAIL_SECTION', unavailSection);
  template = _fill(template, 'PM_SECTION', pmSection);
  template = _fill(template, 'INSIGHTS_DELIVERY_SECTION', insightsDeliverySection);

  // Store change metadata for subject enhancement (read by email:compose handler)
  buildEmail._lastChangeMeta = changeMeta;
  buildEmail._lastSubjectSuffix = '';
  if (changeMeta) {
    try {
      const { buildSubjectSuffix } = require('./email-summary');
      buildEmail._lastSubjectSuffix = buildSubjectSuffix(changeMeta);
    } catch (_) {}
  }

  return template;
}

module.exports = { buildEmail, _timelineDigestModel };

'use strict';
/**
 * repair-intel/wo-facts.js — fact assembly for the structured extractor
 * (relay-extract design §6.3, §7-§12; Path-B ETC rule in plan.md).
 *
 * Turns the persisted fact blocks of a row (`relayFacts`, `offsiteFacts`, plus the
 * row's `offsiteStageHistory` / `pmSchedule`) into one fact set, then writes the
 * row fills (blank or own-fill only), the scalar mirrors and the AI-output keys.
 *
 * Pure and deterministic: requires only the pure ../ai/authority, ./wo-extract,
 * ./wo-extract-dates, ../utils/salesforce-url and crypto. The single log call
 * (_warnOnce) lazy-loads the logger and carries counts/codes only.
 *
 * ETC: the chains / priorEtcs / partsEta / negations are the best-effort Details
 * model of §6.3. The COUNTED value (`etc.counted`, the etcMissed / etcMissCount /
 * etcReason mirrors and `_factEtc.state`) is computed from the repair-completion
 * chain only and needs an explicit repair-miss marker for 'missed'. Counted
 * conservatively by design; met/revision nuance lives in the Details prose, not
 * the counts.
 */

const crypto = require('crypto');
const authority = require('../ai/authority');
const D = require('./wo-extract-dates');
const X = require('./wo-extract');
const { buildSalesforceUrl } = require('../utils/salesforce-url');

const DAY_MS = 86400000;
const PRIOR_EPISODE_MS = 3 * DAY_MS;
const FACT_BLOCK_KEYS = Object.freeze(['relayFacts', 'offsiteFacts']);
const FILL_KEYS = Object.freeze(['dealerName', 'dealerCode', 'decisivDealerId', 'salesforceCase', 'salesforceCaseUrl', 'cause', 'correction', 'totalCost', 'vin']);
const AI_KEYS = Object.freeze(['_factsOn', '_factEtc', '_factPartsWhy', '_factEstimateWhy']);
const DIGEST_MAX = 16 * 1024;

// Fact source -> authority tag (§8). resolveField matches tags by substring.
const AUTH_TAG = Object.freeze({
  relay: 'relaygarage',
  'relaygarage/vendor': 'relaygarage/vendor',
  'relaygarage/fas': 'relaygarage/fas',
  'relaygarage/approver': 'relaygarage/approver',
  decisiv: 'decisiv',
  dtna: 'offsiteevent/dtna',
  notes: 'notes',
  email: 'notes/email',
  fleetdata: 'fleetdata',
});

// ── Small helpers ───────────────────────────────────────────────────────────
function _str(v) { return v == null ? '' : String(v); }
function _blank(v) { return v == null || v === '' || v === '--'; }
function _ms(v) { const m = D.parseTs(v); return m == null ? null : m; }
function _day(at, fallback) { const m = _ms(at); return m == null ? (fallback || null) : D.ymd(m); }
function _isBlock(b) { return !!b && typeof b === 'object' && b.v === 2 && Array.isArray(b.facts); }
function _tagOf(f) {
  if (!f) return 'notes';
  if (f.source === 'relay' && f.via === 'structured' && (f.kind === 'cause' || f.kind === 'correction')) return 'relaygarage/wo';
  return AUTH_TAG[f.source] || _str(f.source);
}
function _byAtAsc(a, b) {
  const x = _ms(a.at); const y = _ms(b.at);
  return (x == null ? Infinity : x) - (y == null ? Infinity : y);
}
function _newest(list) {
  // Newest by `at` (null oldest); on equal times the later list entry wins.
  let best = null; let bm = -Infinity;
  for (const f of list || []) { const m = _ms(f.at); const v = m == null ? -Infinity : m; if (best == null || v >= bm) { best = f; bm = v; } }
  return best;
}
function _uniq(arr) { return arr.filter((v, i, a) => v != null && v !== '' && a.indexOf(v) === i); }
function _mdPad(ymdStr) { const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(_str(ymdStr)); return m ? m[1] + '/' + m[2] : ''; }
function _localMidnight(ymdStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(_str(ymdStr));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null;
}
function _sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function _usd(n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function _todayYmd() { return D.ymd(Date.now()); }

let _warned = new Set();
function _warnOnce(where, id, e) {
  const k = where + '|' + (e && e.name ? e.name : 'Error');
  if (_warned.has(k)) return;
  _warned.add(k);
  try { require('../utils/logger')('extract').warn('[extract] ' + where + ' failed: ' + (e && e.name ? e.name : 'Error') + (id ? ' unit=' + _str(id).slice(0, 20) : '')); } catch (_) { /* no logger in tests */ }
}

// Freshness bucket for authority ties (§8): <= 2 d LIVE, <= 7 d RECENT, older STALE, null UNKNOWN.
function freshness(atIso, today) {
  const d = _day(atIso);
  const t = _localMidnight(today || _todayYmd());
  const a = _localMidnight(d);
  if (a == null || t == null) return 'UNKNOWN';
  const age = Math.round((t - a) / DAY_MS);
  if (age <= 2) return 'LIVE';
  if (age <= 7) return 'RECENT';
  return 'STALE';
}

// ── Names (§4.6) ────────────────────────────────────────────────────────────
const OEM_TAG_RE = /\s*\((?:volvo|peterbilt|kenworth|freightliner|mack|international|navistar|oem)\)\s*$/i;
const OEM_ENUM_RE = /^(VOLVO|PETERBILT|KENWORTH|FREIGHTLINER|MACK|INTERNATIONAL|NAVISTAR|DAIMLER|PACCAR|OEM)$/i;
const TRUNC_RE = /(\.\.\.|…)\s*$/;

function nameKey(s) {
  let t = _str(s).trim().replace(OEM_TAG_RE, '');
  t = t.toLowerCase().replace(/&/g, ' and ').replace(/[–—]/g, '-');
  return t.replace(/[^a-z0-9]+/g, ' ').trim();
}
function _supplierName(s) {
  const t = _str(s).trim();
  if (!t || OEM_ENUM_RE.test(t)) return '';
  return t;
}
// A cut-off name ('M&K Truck Cen...') resolves to the first candidate whose key starts with it, else ''.
function untruncate(v, cands) {
  const s = _str(v);
  if (!TRUNC_RE.test(s)) return s;
  const pk = nameKey(s.replace(TRUNC_RE, ''));
  if (!pk) return '';
  const c = (cands || []).find((x) => nameKey(x.value).startsWith(pk));
  return c ? c.value : '';
}

// ── ETC model (§6.3 Details + Path-B counted) ───────────────────────────────
const CHAIN_OF = { partsShip: 'parts', partsArrival: 'parts', repairCompletion: 'repairCompletion', techOnsite: 'techOnsite' };
const RESOLVED = new Set(['missed', 'superseded', 'met', 'met-late']);
const REASON_TOKENS = [
  ['backorder', /back[\s-]?order/i],
  ['built-to-order', /\bbuilt[\s-]to[\s-]order\b/i],
  ['no-tracking', /\bno\s+(?:tracking|shipping)\s+(?:info|information|number|confirmation)\b/i],
  ['waiting-on-part', /\bwaiting\s+on\s+(?:the\s+)?([a-z ]{3,20})/i],
  ['parts-pricing', /\bparts\s+pricing\b/i],
  ['tech-reassigned', /\btechnician\b[^.]{0,40}\breassigned\b/i],
  ['vendor', /\bETC Delay Reason-([A-Z_]{3,40})\b/],
  ['cc', /Selected Reason:\s*(CC\s*-\s*[^.\n]{2,60})/i],
];
function _reasonIn(text) {
  const t = _str(text);
  if (!t) return null;
  for (const [name, re] of REASON_TOKENS) {
    const m = re.exec(t);
    if (!m) continue;
    if (name === 'vendor') return 'vendor:' + m[1];
    if (name === 'cc') return 'cc:' + m[1].trim();
    return name;
  }
  return null;
}
function _commentKey(f) { return _str(f.at) + '|' + _str(f.source) + '|' + _str(f.author); }

// Stream event from an etcMention fact; null when it never enters a chain.
function _event(f, idx, today) {
  if (!f || f.kind !== 'etcMention') return null;
  const base = {
    id: f.id, at: f.at || null, atMs: _ms(f.at), day: _day(f.at, today), source: f.source, author: f.author || null,
    tag: _tagOf(f), snippet: f.snippet || '', pos: Number.isFinite(f.pos) ? f.pos : 0, idx, ck: _commentKey(f),
    structured: f.via === 'structured' || f.via === 'history',
  };
  if (f.marker === 'miss' || f.marker === 'met') {
    const chain = f.chain === 'parts' || f.chain === 'repairCompletion' || f.chain === 'techOnsite' ? f.chain : null;
    if (!chain) return null;
    return Object.assign(base, { type: f.marker, chain, date: f.value || null, repair: !!f.repair });
  }
  const chain = CHAIN_OF[f.etcKind];
  if (!chain) return null;                                   // repairStart / updateExpected are auxiliary
  if (f.negated) return Object.assign(base, { type: 'neg', chain, kind: f.etcKind, date: null, phrase: f.raw || '' });
  if (!f.value) return null;
  return Object.assign(base, { type: 'mention', chain, kind: f.etcKind, date: f.value, tentative: !!f.tentative, approx: f.approx || null });
}

function _sortStream(evs) {
  const first = new Map();
  evs.forEach((e) => { if (!first.has(e.ck)) first.set(e.ck, e.idx); });
  return evs.slice().sort((a, b) => {
    const x = a.atMs == null ? Infinity : a.atMs; const y = b.atMs == null ? Infinity : b.atMs;
    if (x !== y) return x - y;
    const ca = first.get(a.ck); const cb = first.get(b.ck);
    if (ca !== cb) return ca - cb;
    const ra = a.type === 'miss' ? 1 : 0; const rb = b.type === 'miss' ? 1 : 0;
    if (ra !== rb) return ra - rb;
    return (a.pos - b.pos) || (a.idx - b.idx);
  });
}

// reasonNear: own snippet -> same comment -> next comment by the same author within 24 h.
function _reasonFinder(allFacts) {
  const byComment = new Map();
  for (const f of allFacts || []) {
    if (!f || !f.snippet) continue;
    const k = _commentKey(f);
    if (!byComment.has(k)) byComment.set(k, { at: _ms(f.at), source: f.source, author: f.author, text: [] });
    byComment.get(k).text.push(f.snippet);
  }
  const comments = [...byComment.values()].filter((c) => c.at != null).sort((a, b) => a.at - b.at);
  return (ev) => {
    const own = _reasonIn(ev.snippet);
    if (own) return own;
    const c = byComment.get(ev.ck);
    const same = c ? _reasonIn(c.text.join(' \n ')) : null;
    if (same) return same;
    if (ev.atMs == null) return null;
    for (const n of comments) {
      if (n.at <= ev.atMs) continue;
      if (n.at > ev.atMs + DAY_MS) break;
      if (n.author !== ev.author || n.source !== ev.source) continue;
      const r = _reasonIn(n.text.join(' \n '));
      if (r) return r;
    }
    return null;
  };
}

function _label(ev) {
  if (ev.kind === 'partsShip') return 'ship';
  if (ev.kind === 'partsArrival') return /\bparts?\s+etc\b/i.test(ev.snippet) ? 'partsEtc' : 'arrival';
  return ev.kind;
}
function _addLabel(e, l) { if (!e.labels.includes(l)) e.labels.push(l); if (e.chain === 'parts') e.kind = e.labels.includes('ship') ? 'partsShip' : 'partsArrival'; }
function _entry(ev) {
  const e = {
    date: ev.date, kind: ev.kind, chain: ev.chain, labels: [], status: 'open', statedAt: ev.at, lastConfirmedAt: null,
    confirmCount: 1, missedAt: null, metAt: null, arrivedAt: null, reason: null, source: ev.tag, tag: ev.tag,
    factIds: [ev.id], snippet: ev.snippet, tentative: !!ev.tentative, approx: ev.approx || null, explicitMiss: false,
    explicitAt: null,
  };
  _addLabel(e, _label(ev));
  return e;
}

// One deterministic pass of §6.3 over a sorted stream.
function _runChains(stream, today, reasonOf, onStep) {
  const chains = { parts: [], repairCompletion: [], techOnsite: [] };
  const metAt = { parts: null, repairCompletion: null, techOnsite: null };
  const negations = [];
  for (const ev of stream) {
    const ch = chains[ev.chain];
    if (!ch) continue;
    const isRep = ev.chain === 'repairCompletion';
    const same = (e) => !isRep || e.tag === ev.tag;
    let prev = null;
    for (let i = ch.length - 1; i >= 0; i--) if (same(ch[i])) { prev = ch[i]; break; }
    const d = ev.day;
    if (ev.type === 'miss') {
      let e = null;
      if (ev.date) e = ch.find((x) => x.date === ev.date && same(x)) || ch.find((x) => x.date === ev.date) || null;
      else e = prev;
      if (e && d > e.date) {
        if (e.status === 'open' || e.status === 'superseded') { e.status = 'missed'; e.missedAt = d; }
        if (ev.repair && isRep) { e.explicitMiss = true; e.explicitAt = ev.at; }
      }
      if (e && e.status === 'missed' && !e.reason) e.reason = reasonOf(ev);
    } else if (ev.type === 'met') {
      const tags = isRep ? _uniq(ch.map((x) => x.tag)) : [null];
      for (const tag of tags) {
        const own = (x) => !isRep || x.tag === tag;
        let p = null;
        for (let i = ch.length - 1; i >= 0; i--) if (own(ch[i])) { p = ch[i]; break; }
        if (p && p.status === 'open') {
          p.status = d <= p.date ? 'met' : 'met-late';
          p.metAt = d; metAt[ev.chain] = d;
        } else if (p && p.status === 'missed' && !p.arrivedAt && !ch.some((x) => own(x) && x.status === 'open')) {
          p.arrivedAt = d; metAt[ev.chain] = d;
        }
      }
    } else if (ev.type === 'neg') {
      if (prev && prev.status === 'open' && prev.date < d) { prev.status = 'missed'; prev.missedAt = d; prev.reason = prev.reason || reasonOf(ev); }
      negations.push({ kind: ev.kind, chainKey: ev.chain, tag: ev.tag, statedAt: ev.at, day: d, phrase: ev.phrase, factId: ev.id });
    } else {
      const hist = ch.find((e) => same(e) && e.date === ev.date && RESOLVED.has(e.status));
      if (hist && hist.status === 'superseded' && hist.date >= d) {
        if (prev && prev !== hist && prev.status === 'open') {
          if (prev.date < d) { prev.status = 'missed'; prev.missedAt = d; prev.reason = prev.reason || reasonOf(ev); } else prev.status = 'superseded';
        }
        hist.status = 'open'; hist.lastConfirmedAt = ev.at; hist.confirmCount++; _addLabel(hist, _label(ev)); hist.factIds.push(ev.id);
        ch.splice(ch.indexOf(hist), 1); ch.push(hist);
      } else if (hist) {
        _addLabel(hist, _label(ev)); hist.factIds.push(ev.id);
        if (hist.status === 'missed' && !hist.reason) hist.reason = reasonOf(ev);
      } else if (prev && prev.status === 'open' && prev.date === ev.date) {
        prev.lastConfirmedAt = ev.at; prev.confirmCount++; _addLabel(prev, _label(ev)); prev.factIds.push(ev.id);
        if (!ev.tentative) prev.tentative = false;
        if (!ev.approx) prev.approx = null;
      } else {
        if (prev && prev.status === 'open') {
          if (prev.date < d) { prev.status = 'missed'; prev.missedAt = d; prev.reason = prev.reason || reasonOf(ev); } else prev.status = 'superseded';
        } else if (prev && prev.status === 'missed' && !prev.reason) prev.reason = reasonOf(ev);
        ch.push(_entry(ev));
      }
    }
    if (onStep) onStep(ev, chains);
  }
  return { chains, metAt, negations };
}

function _stated(e) { return e.lastConfirmedAt || e.statedAt; }
function _lastOpen(ch) { for (let i = ch.length - 1; i >= 0; i--) if (ch[i].status === 'open') return ch[i]; return null; }
function _negNewer(negs, chainKey, tag, e) {
  const em = _ms(_stated(e));
  return negs.some((n) => n.chainKey === chainKey && (tag == null || n.tag === tag) && _ms(n.statedAt) != null && (em == null || _ms(n.statedAt) > em));
}
function _cur(e, kind) {
  return { date: e.date, kind: kind || e.kind, source: e.tag, statedAt: _stated(e), snippet: e.snippet, tentative: !!e.tentative, approx: e.approx || null, status: e.status };
}
function _pub(e) {
  const o = { date: e.date, kind: e.kind, status: e.status, statedAt: e.statedAt, lastConfirmedAt: e.lastConfirmedAt, confirmCount: e.confirmCount,
    missedAt: e.missedAt, reason: e.reason, source: e.source };
  if (e.metAt) o.metAt = e.metAt;
  if (e.arrivedAt) o.arrivedAt = e.arrivedAt;
  if (e.explicitMiss) o.explicitMiss = true;
  return o;
}

/**
 * etcModel(facts, {today, allFacts, onStep}) -> etc
 * facts: etcMention facts of the current episode (text + structured/history). opts.onStep(ev, chains)
 * is a test-only hook called after each stream event.
 */
function etcModel(facts, opts = {}) {
  const today = opts.today || _todayYmd();
  const reasonOf = _reasonFinder(opts.allFacts || facts);
  const evs = (facts || []).map((f, i) => _event(f, i, today)).filter(Boolean);
  const structuredMet = evs.filter((e) => e.structured && e.type === 'met');
  const text = _sortStream(evs.filter((e) => !e.structured).concat(structuredMet));
  const strm = _sortStream(evs.filter((e) => e.structured));
  const T = _runChains(text, today, reasonOf, opts.onStep);
  const S = _runChains(strm, today, reasonOf, null);
  const chains = T.chains;
  const negations = T.negations;
  const rep = chains.repairCompletion;

  // Source heads of the repair chain: newest open entry per tag, newest-first.
  const heads = [];
  for (const tag of _uniq(rep.map((e) => e.tag))) {
    const h = _lastOpen(rep.filter((e) => e.tag === tag));
    if (h) heads.push(h);
  }
  heads.sort((a, b) => (_ms(_stated(b)) || 0) - (_ms(_stated(a)) || 0));
  const eligible = heads.filter((h) => !_negNewer(negations, 'repairCompletion', h.tag, h));
  const sOpen = _lastOpen(S.chains.repairCompletion);

  let currentEtc = null;
  let chosen = null;
  if (heads.length) {
    if (eligible.length) {
      const res = authority.resolveField('repairEtc', eligible.map((h) => ({ value: h.date, source: h.tag, at: h.statedAt, freshness: freshness(_stated(h), today) })));
      chosen = eligible.find((h) => h.tag === res.source && h.date === res.value) || eligible[0];
      currentEtc = _cur(chosen, 'repairCompletion');
    } else {
      const n = negations.filter((x) => x.chainKey === 'repairCompletion').slice(-1)[0];
      currentEtc = { date: null, negated: true, kind: 'repairCompletion', source: n ? n.tag : heads[0].tag, statedAt: n ? n.statedAt : null, snippet: '' };
    }
  }
  if (!currentEtc && sOpen) { chosen = sOpen; currentEtc = _cur(sOpen, 'repairCompletion'); }
  if (!currentEtc) {
    for (const key of ['parts', 'techOnsite']) {
      const o = _lastOpen(chains[key]);
      if (!o) continue;
      if (_negNewer(negations, key, null, o)) {
        const n = negations.filter((x) => x.chainKey === key).slice(-1)[0];
        currentEtc = { date: null, negated: true, kind: n.kind, source: n.tag, statedAt: n.statedAt, snippet: '' };
      } else { chosen = o; currentEtc = _cur(o); }
      break;
    }
  }
  if (!currentEtc && negations.length) {
    const n = negations.filter((x) => x.chainKey === 'repairCompletion').slice(-1)[0] || negations[negations.length - 1];
    currentEtc = { date: null, negated: true, kind: n.kind, source: n.tag, statedAt: n.statedAt, snippet: '' };
  }

  // Conflicts: open text heads + latest open structured entry.
  const conflicts = [];
  const cands = heads.map((h) => ({ value: h.date, source: h.tag, at: h.statedAt, freshness: freshness(_stated(h), today) }));
  if (sOpen) cands.push({ value: sOpen.date, source: sOpen.tag, at: sOpen.statedAt, freshness: freshness(_stated(sOpen), today) });
  if (_uniq(cands.map((c) => c.value)).length >= 2) {
    const res = authority.resolveField('repairEtc', cands);
    conflicts.push({ field: 'repairEtc', resolved: { value: res.value, source: res.source }, candidates: cands.map((c) => ({ value: c.value, source: c.source, at: c.at })) });
  }

  // Details-level summary (§6.3 top-level fields).
  const all = chains.parts.concat(rep, chains.techOnsite);
  const sAll = S.chains.repairCompletion.concat(S.chains.techOnsite);
  const missedDetails = !!(currentEtc && currentEtc.date && chosen && chosen.status === 'open' && currentEtc.date < today);
  const missKeys = new Set();
  for (const e of all.concat(sAll)) if (e.status === 'missed') missKeys.add((CHAIN_OF[e.kind] || e.chain) + '|' + e.date);
  const priorEtcs = all.concat(sAll).filter((e) => e.status !== 'open')
    .sort((a, b) => (_ms(b.statedAt) || 0) - (_ms(a.statedAt) || 0)).map(_pub);
  const misses = all.concat(sAll).filter((e) => e.status === 'missed').sort((a, b) => _str(b.missedAt).localeCompare(_str(a.missedAt)));
  const lastParts = chains.parts[chains.parts.length - 1] || null;
  const openParts = _lastOpen(chains.parts);
  let partsEta = null;
  if (openParts) partsEta = { date: openParts.date, kind: openParts.kind, statedAt: _stated(openParts), source: openParts.tag };
  else if (lastParts && (lastParts.status === 'met' || lastParts.status === 'met-late' || lastParts.arrivedAt)) partsEta = { metAt: T.metAt.parts };
  let lastEtcStatedAt = null;
  for (const e of all) for (const t of [e.statedAt, e.lastConfirmedAt]) if (t && (!lastEtcStatedAt || _ms(t) > _ms(lastEtcStatedAt))) lastEtcStatedAt = t;
  for (const n of negations) if (n.statedAt && (!lastEtcStatedAt || _ms(n.statedAt) > _ms(lastEtcStatedAt))) lastEtcStatedAt = n.statedAt;

  // Path-B counted value: repair-completion chain (+ structured) only; explicit marker for 'missed'.
  const repHead = currentEtc && currentEtc.kind === 'repairCompletion' && currentEtc.date && chosen ? chosen : null;
  const confident = !!(repHead && !repHead.tentative && !repHead.approx);
  const explicit = rep.filter((e) => e.explicitMiss && e.date < today)
    .sort((a, b) => (_ms(b.explicitAt) || 0) - (_ms(a.explicitAt) || 0));
  const explicitDates = _uniq(explicit.map((e) => e.date));
  const newestMiss = explicit[0] || null;
  let state = 'none';
  if (confident && repHead.date === today) state = 'today';
  else if (newestMiss) state = 'missed';
  else if (confident && repHead.date > today) state = 'future';
  const counted = {
    state,
    date: state === 'today' || state === 'future' ? repHead.date : (state === 'missed' ? newestMiss.date : null),
    explicitMissDate: newestMiss ? newestMiss.date : null,
    reason: newestMiss ? (newestMiss.reason || null) : null,
  };
  const countedEntry = state === 'missed' ? newestMiss : (state === 'today' || state === 'future' ? repHead : null);

  const view = (k) => chains.parts.filter((e) => e.kind === k);
  return {
    chains: { parts: chains.parts, partsShip: view('partsShip'), partsArrival: view('partsArrival'), repairCompletion: rep, techOnsite: chains.techOnsite },
    chainMetAt: T.metAt,
    structured: { repairCompletion: S.chains.repairCompletion, techOnsite: S.chains.techOnsite },
    negations,
    openHeads: heads.map((h) => ({ date: h.date, source: h.tag, statedAt: _stated(h) })),
    currentEtc,
    currentEtcKind: currentEtc ? currentEtc.kind : null,
    etcSource: currentEtc ? currentEtc.source || null : null,
    lastEtcStatedAt,
    missed: missedDetails,
    missCount: missKeys.size + (missedDetails ? 1 : 0),
    priorEtcs,
    etcReason: misses.length ? misses[0].reason || null : null,
    partsEta,
    partsMissCount: chains.parts.filter((e) => e.status === 'missed').length,
    explicitMisses: explicit.map((e) => ({ date: e.date, at: e.explicitAt, reason: e.reason || null, source: e.tag })),
    etcMissCount: explicitDates.length,
    counted,
    _countedEntry: countedEntry ? { source: countedEntry.tag, statedAt: _stated(countedEntry), snippet: countedEntry.snippet } : null,
    conflicts,
  };
}

// ── Parts (§7) ──────────────────────────────────────────────────────────────
function partsModel(facts) {
  const fs = facts || [];
  const orders = _uniq(fs.filter((f) => f.kind === 'order').map((f) => _str(f.value).toUpperCase()));
  const re = X.reclassifyPartsAsOrders(fs, orders);
  const byNo = new Map();
  for (const f of re.filter((x) => x.kind === 'part').sort(_byAtAsc)) {
    const k = _str(f.value).toUpperCase();
    if (!byNo.has(k)) byNo.set(k, { partNo: k, qty: null, orderNo: null, vor: null, desc: null, status: null, lastStatusAt: null, source: f.source, factIds: [], orderConflict: false, _orders: [] });
    const p = byNo.get(k);
    p.factIds.push(f.id);
    if (p.qty == null && f.qty != null) p.qty = f.qty;
    if (f.orderNo) p._orders.push(f.orderNo);
    if (p.vor == null && f.vor) p.vor = true;
    if (p.desc == null && f.desc) p.desc = f.desc;
  }
  const parts = [...byNo.values()];
  for (const p of parts) {
    const os = _uniq(p._orders);
    p.orderNo = os[0] || null;
    p.orderConflict = os.length > 1;
    delete p._orders;
  }
  const statuses = re.filter((f) => f.kind === 'partStatus').sort(_byAtAsc);
  for (const s of statuses) {
    const targets = s.part ? parts.filter((p) => p.partNo === _str(s.part).toUpperCase()) : parts;
    for (const p of targets) { p.status = s.value; p.lastStatusAt = s.at || p.lastStatusAt; }
  }
  const last = statuses[statuses.length - 1];
  return { parts, partsStatus: last ? last.value : '', facts: re };
}

// ── Estimate (§7) ───────────────────────────────────────────────────────────
function estimateModel(facts) {
  const list = (facts || []).filter((f) => f && f.kind === 'estimate').map((f, i) => ({ f, i })).sort((a, b) => _byAtAsc(a.f, b.f) || (a.i - b.i)).map((x) => x.f);
  const versions = [];
  const byCents = new Map();
  const cents = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100));
  const create = (c, v) => {
    const ver = { v: v != null ? v : (versions.reduce((m, x) => Math.max(m, x.v || 0), 0) + 1), amount: c / 100, status: null, reason: null, at: null, by: null, history: [], _c: c };
    versions.push(ver); byCents.set(c, ver);
    return ver;
  };
  const lastSubmitted = () => { for (let i = versions.length - 1; i >= 0; i--) if (versions[i].history.some((h) => h.status === 'submitted')) return versions[i]; return versions[versions.length - 1] || null; };
  for (const f of list) {
    const st = f.amountStatus;
    if (!st) continue;
    let ver = null;
    if (st === 'submitted') {
      const c = cents(f.value);
      if (c == null) continue;
      ver = byCents.get(c) || create(c, f.v != null ? f.v : null);
    } else {
      const c = cents(f.citedAmount != null ? f.citedAmount : f.value);
      if (c != null) ver = byCents.get(c) || create(c, f.v != null ? f.v : null);
      else if (f.v != null) ver = versions.find((x) => x.v === f.v) || null;
      else if (f.at != null) ver = lastSubmitted();
      if (!ver) continue;
    }
    if (f.v != null) ver.v = f.v;
    ver.history.push({ status: st, at: f.at || null, by: f.author || null, reason: f.reason || null, source: _tagOf(f) });
  }
  for (const ver of versions) {
    const h = ver.history[ver.history.length - 1];
    ver.status = h ? h.status : null;
    ver.at = h ? h.at : null;
    ver.by = h ? h.by : null;
    const r = ver.history.slice().reverse().find((x) => x.reason && x.status !== 'submitted') || ver.history.slice().reverse().find((x) => x.reason);
    ver.reason = r ? r.reason : null;
  }
  const flat = [];
  for (const ver of versions) for (const h of ver.history) flat.push({ ver, h });
  flat.sort((a, b) => _byAtAsc(a.h, b.h));
  const lastEntry = flat[flat.length - 1] || null;
  const approved = versions.filter((v) => v.history.some((h) => h.status === 'approved'));
  let approvedTotal = null;
  if (approved.length) {
    const cand = [];
    for (const v of approved) for (const h of v.history) if (h.status === 'approved') cand.push({ value: v.amount, source: h.source, at: h.at });
    cand.sort((a, b) => (_ms(b.at) || 0) - (_ms(a.at) || 0));
    if (_uniq(cand.map((c) => c.value)).length > 1) {
      approvedTotal = authority.resolveField('estimateAmount', cand.map((c) => ({ value: c.value, source: c.source, freshness: freshness(c.at) }))).value;
    } else approvedTotal = cand[0].value;
  }
  const rej = flat.filter((x) => x.h.status === 'rejected' || x.h.status === 'temp-reject');
  const lr = rej[rej.length - 1] || null;
  const latestRejectReason = lr ? { v: lr.ver.v, status: lr.h.status, reason: lr.h.reason || null, at: lr.h.at } : null;
  const sub = flat.filter((x) => x.h.status === 'submitted');
  const ls = sub[sub.length - 1] || null;
  const status = lastEntry ? lastEntry.h.status : null;
  const approvedAfterReject = !!(lr && flat.some((x) => x.h.status === 'approved' && flat.indexOf(x) > flat.indexOf(lr)));
  for (const v of versions) delete v._c;
  return {
    versions, status, approvedTotal,
    latestSubmitted: ls ? ls.ver.amount : null,
    pendingSince: status === 'submitted' && lastEntry ? lastEntry.h.at : null,
    latestRejectReason,
    approvedAfterReject,
    latestVersion: versions.length ? versions.reduce((m, x) => (x.v > m.v ? x : m), versions[0]).v : null,
  };
}

// ── Case ids (§7) ───────────────────────────────────────────────────────────
function caseIds(facts, opts = {}) {
  const fs = facts || [];
  const newestFirst = (k, pred) => fs.filter((f) => f.kind === k && (!pred || pred(f))).sort((a, b) => -_byAtAsc(a, b));
  const ns = (n) => newestFirst('case', (f) => f.ns === n);
  const all = { salesforce: _uniq(ns('salesforce').map((f) => f.value)), decisivCase: _uniq(ns('decisivCase').map((f) => f.value)),
    oemCase: _uniq(ns('oemCase').map((f) => f.value)), unknown: _uniq(ns('unknown').map((f) => f.value)) };
  const sfC = ns('salesforce').map((f) => ({ value: f.value, source: _tagOf(f), freshness: freshness(f.at, opts.today) }));
  const sf = sfC.length ? authority.resolveField('salesforceCase', sfC).value : '';
  return {
    salesforce: sf || '', decisivCase: all.decisivCase[0] || '', oemCase: all.oemCase[0] || '',
    fleetnet: _uniq(newestFirst('fleetnet').map((f) => f.value)), tow: _uniq(newestFirst('tow').map((f) => f.value)),
    estimateId: opts.estimateId || '', all,
  };
}

// ── Dealer (§7, §4.6) ───────────────────────────────────────────────────────
const VIA_RANK = { structured: 0, location: 1, dtna: 2, wr: 3, fas: 4 };
function dealerModel(facts, row, opts = {}) {
  const fs = facts || [];
  const today = opts.today;
  const cands = [];
  for (const f of fs.filter((x) => x.kind === 'dealer' && x.value)) cands.push({ value: _str(f.value).trim(), source: _tagOf(f), at: f.at || null, via: f.via || '' });
  const sup = _supplierName(row && row.suppliers);
  if (sup) cands.push({ value: sup, source: 'fleetdata', at: null, via: 'suppliers' });
  const auth = (s) => { const order = authority.FIELD_AUTHORITY.dealerName; const t = _str(s).toLowerCase(); const i = order.findIndex((o) => t.includes(o)); return i < 0 ? Infinity : i; };
  const fr = (c) => authority.FRESHNESS_RANK[freshness(c.at, today)];
  // Group by nameKey; a key that is a word-prefix of another joins the longer group.
  const keys = _uniq(cands.map((c) => nameKey(c.value)).filter(Boolean)).sort((a, b) => b.length - a.length);
  const canon = new Map();
  for (const k of keys) {
    const host = keys.find((o) => o !== k && o.length > k.length && o.startsWith(k + ' ') && canon.get(o) === o);
    canon.set(k, host || k);
  }
  const groups = new Map();
  for (const c of cands) {
    const k = canon.get(nameKey(c.value));
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const gl = [...groups.entries()].map(([key, list]) => {
    list.sort((a, b) => (auth(a.source) - auth(b.source)) || ((VIA_RANK[a.via] ?? 9) - (VIA_RANK[b.via] ?? 9)) || (fr(b) - fr(a)));
    const freshest = list.slice().sort((a, b) => (_ms(b.at) || 0) - (_ms(a.at) || 0))[0];
    return { key, list, best: list[0], newestAt: freshest.at };
  }).sort((a, b) => (_ms(b.newestAt) || 0) - (_ms(a.newestAt) || 0));
  let name = ''; let key = ''; let conflict = false;
  if (gl.length) {
    const res = authority.resolveField('dealerName', gl.map((g) => ({ value: g.key, source: g.best.source, freshness: freshness(g.newestAt, today) })));
    const g = gl.find((x) => x.key === res.value) || gl[0];
    name = g.best.value; key = g.key; conflict = !!res.conflict;
  }
  const newest = (k, pred) => _newest(fs.filter((f) => f.kind === k && (!pred || pred(f))));
  const urlCode = newest('dealerCode', (f) => f.via === 'url');
  const code = urlCode || newest('dealerCode');
  const did = newest('decisivDealerId');
  const phone = newest('phone', (f) => f.side === 'dealer');
  const seen = new Set();
  const contacts = [];
  for (const f of fs.filter((x) => x.kind === 'contact' && (x.side === 'dealer' || x.side === 'oem'))) {
    const k = _str(f.value) + '|' + _str(f.location);
    if (seen.has(k)) continue;
    seen.add(k);
    contacts.push({ name: f.value, role: f.role || null, side: f.side, location: f.location || null });
  }
  const callAttempts = fs.filter((f) => f.kind === 'callAttempt').sort(_byAtAsc).map((f) => ({ at: f.at, outcome: f.outcome || f.value, factId: f.id }));
  return {
    name, nameKey: key, code: code ? _str(code.value) : '', decisivDealerId: did ? _str(did.value) : '', phone: phone ? phone.value : '',
    contacts, callAttempts, conflict,
    candidates: cands.map((c) => ({ value: c.value, source: c.source, at: c.at })),
    groups: gl.map((g) => ({ key: g.key, value: g.best.value, source: g.best.source, at: g.newestAt })),
  };
}

// dealerOf(block): structured dealer name, else the most frequent dealer-side location, else the first dealer fact.
function dealerOf(block) {
  if (!_isBlock(block)) return '';
  if (block.dealer && block.dealer.name) return _str(block.dealer.name);
  const cur = block.facts.filter((f) => f.kind === 'dealer' && f.episode !== 'prior');
  const loc = cur.filter((f) => f.via === 'location');
  if (loc.length) {
    const n = new Map();
    for (const f of loc) n.set(f.value, (n.get(f.value) || 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  return cur.length ? _str(cur[0].value) : '';
}

// ── Stage dwell (§11.1) ─────────────────────────────────────────────────────
const PARTS_STATUS_RE = /\bparts?\b|\bhold\s*\(parts\)/i;
function _stageKey(s) {
  const t = _str(s).toLowerCase();
  if (/arriv|check/.test(t)) return 'arrival';
  if (/diag/.test(t)) return 'diagnosis';
  if (/approv|estimat|authori/.test(t)) return 'approval';
  if (/repair/.test(t)) return 'repair';
  if (/ready|complet|releas|pick/.test(t)) return 'ready';
  return null;
}
function stageDwell(history, opts = {}) {
  const sinceMs = typeof opts.since === 'number' ? opts.since : _ms(opts.since);
  const noCut = !Number.isFinite(sinceMs);
  let list = (Array.isArray(history) ? history : []).filter((e) => e && _ms(e.at) != null)
    .map((e, i) => ({ e, i, ms: _ms(e.at) })).sort((a, b) => (a.ms - b.ms) || (a.i - b.i));
  if (!noCut) list = list.filter((x) => x.ms >= sinceMs);
  const out = { arrival: null, diagnosis: null, approval: null, repair: null, ready: null, partsMs: null, open: null, transitions: list.length };
  if (noCut) out.noEpisodeCut = true;
  for (let i = 0; i + 1 < list.length; i++) {
    const cur = list[i]; const dur = list[i + 1].ms - cur.ms;
    if (dur > 30 * DAY_MS && !noCut && cur.ms < sinceMs + 3 * DAY_MS) continue;
    const k = _stageKey(cur.e.stage);
    if (k) out[k] = (out[k] || 0) + dur;
    if (PARTS_STATUS_RE.test(_str(cur.e.status))) out.partsMs = (out.partsMs || 0) + dur;
  }
  const last = list[list.length - 1];
  if (last) {
    out.open = { stage: last.e.stage || null, status: last.e.status || null, since: last.e.at };
    if (Number.isFinite(opts.now)) out.open.ms = Math.max(0, opts.now - last.ms);
  }
  return out;
}

// ── Lines (§4.8) ────────────────────────────────────────────────────────────
function joinLines(lines) {
  const ls = Array.isArray(lines) ? lines : [];
  const n = ls.length;
  return ls.map((c) => (n > 1 ? 'L' + c.line + ': ' : '') + _str(c.text)).join('; ').slice(0, 600);
}
function _ccLines(facts, kind, field, today) {
  const fs = facts.filter((f) => f.kind === kind && f.value);
  if (!fs.length) return [];
  const byTag = new Map();
  for (const f of fs) { const t = _tagOf(f); if (!byTag.has(t)) byTag.set(t, []); byTag.get(t).push(f); }
  const groups = [...byTag.entries()].map(([tag, list]) => {
    const newestAt = _newest(list).at;
    const chosen = list.filter((f) => f.at === newestAt).sort((a, b) => (a.line || 0) - (b.line || 0));
    const seen = new Set();
    const lines = [];
    for (const f of chosen) { const k = (f.line || 0) + '|' + f.value; if (seen.has(k)) continue; seen.add(k); lines.push(f); }
    return { tag, lines, at: newestAt };
  }).sort((a, b) => (_ms(b.at) || 0) - (_ms(a.at) || 0));
  let g = groups[0];
  if (groups.length > 1) {
    const res = authority.resolveField(field, groups.map((x) => ({ value: x.tag, source: x.tag, freshness: freshness(x.at, today) })));
    g = groups.find((x) => x.tag === res.value) || groups[0];
  }
  return g.lines.map((f, i) => ({ line: f.line || i + 1, text: _str(f.value), source: g.tag, at: f.at || null, ro: f.ro || null, category: f.category || null, factId: f.id }));
}

// ── Fact set (§7 buildFactSet) ──────────────────────────────────────────────
function _emptyFactSet(row) {
  return {
    parts: [], partsStatus: '', orders: [], ros: [], dealerRo: '',
    etc: etcModel([], {}), estimate: estimateModel([]), caseIds: caseIds([]), dealer: dealerModel([], row || {}),
    cause: [], correction: [], warranty: [], vendorDelayReason: '', leadTime: '', pmAddedToRo: false, tow: [], dtna: [], vins: [],
    pmSchedule: Array.isArray(row && row.pmSchedule) ? row.pmSchedule : [],
    conflicts: [], events: [], typed: _typed([]), stageDwell: null,
    counts: { facts: 0, prior: 0, rejected: 0, truncated: 0 }, sources: { relay: false, offsite: false, notes: false },
    blocks: { relayAt: null, offsiteAt: null, relayCounts: null, offsiteCounts: null },
  };
}

function _typed(facts) {
  const refsByKind = { part: [], order: [], ro: [], dealerCode: [], tow: [], fleetnet: [], case: { salesforce: [], decisivCase: [], oemCase: [], unknown: [] } };
  const amounts = []; const dates = []; const etc = { repairCompletion: [], parts: [], techOnsite: [] };
  const factIds = {};
  const add = (arr, v, id) => { if (v == null || v === '') return; const s = _str(v); if (!arr.includes(s)) arr.push(s); (factIds[s] = factIds[s] || []).push(id); };
  for (const f of facts) {
    if (!f) continue;
    if (f.kind === 'part' || f.kind === 'order' || f.kind === 'ro' || f.kind === 'dealerCode' || f.kind === 'tow' || f.kind === 'fleetnet') add(refsByKind[f.kind], _str(f.value).toUpperCase(), f.id);
    else if (f.kind === 'case') add(refsByKind.case[f.ns] || refsByKind.case.unknown, _str(f.value).toUpperCase(), f.id);
    else if (f.kind === 'estimate' && f.value != null && Number.isFinite(Number(f.value))) { const c = Math.round(Number(f.value) * 100); if (!amounts.includes(c)) amounts.push(c); }
    else if (f.kind === 'etcMention' && f.value) {
      if (!dates.includes(f.value)) dates.push(f.value);
      const ch = f.marker ? f.chain : CHAIN_OF[f.etcKind];
      if (ch && etc[ch] && !etc[ch].includes(f.value)) etc[ch].push(f.value);
    }
  }
  return { refsByKind, amounts, dates, etc, factIds };
}

/**
 * buildFactSet(row, {today, notesFacts}) -> fact set (§7). today ('YYYY-MM-DD') is required.
 */
function buildFactSet(row, opts = {}) {
  const today = opts && opts.today;
  if (!today || !/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new TypeError('buildFactSet: today (YYYY-MM-DD) is required');
  const r = row && typeof row === 'object' ? row : {};
  const rf = _isBlock(r.relayFacts) ? r.relayFacts : null;
  const of = _isBlock(r.offsiteFacts) ? r.offsiteFacts : null;
  const nf = opts.notesFacts && Array.isArray(opts.notesFacts.facts) ? opts.notesFacts.facts : (Array.isArray(opts.notesFacts) ? opts.notesFacts : null);
  if (!rf && !of && !(nf && nf.length)) {
    const e = _emptyFactSet(r);
    const since = _ms((rf && rf.wrCreatedAt) || r.created);
    if (Array.isArray(r.offsiteStageHistory) && r.offsiteStageHistory.length) {
      e.stageDwell = stageDwell(r.offsiteStageHistory, { since: since != null ? since - PRIOR_EPISODE_MS : undefined });
    }
    return e;
  }
  const createdMs = _ms((rf && rf.wrCreatedAt) || r.created);
  const sinceMs = createdMs != null ? createdMs - PRIOR_EPISODE_MS : null;
  const tagPrior = (f) => {
    if (!f || f.episode === 'prior' || sinceMs == null) return f;
    const m = _ms(f.at);
    return m != null && m < sinceMs ? Object.assign({}, f, { episode: 'prior' }) : f;
  };
  let all = [].concat(rf ? rf.facts : [], of ? of.facts.map(tagPrior) : [], nf || []).filter(Boolean);
  const curOrders = _uniq(all.filter((f) => f.kind === 'order' && f.episode !== 'prior').map((f) => _str(f.value).toUpperCase()));
  all = X.reclassifyPartsAsOrders(all, curOrders);
  const cur = all.filter((f) => f.episode !== 'prior');

  const pm = partsModel(cur);
  const etc = etcModel(cur.filter((f) => f.kind === 'etcMention'), { today, allFacts: cur });
  const estimate = estimateModel(cur);
  const ids = caseIds(cur, { today, estimateId: (of && of.estimateId) || '' });
  const dealer = dealerModel(cur, r, { today });
  const cause = _ccLines(cur, 'cause', 'reasonForRepair', today);
  const correction = _ccLines(cur, 'correction', 'workAccomplished', today);

  const warrantyFacts = cur.filter((f) => f.kind === 'warranty').sort((a, b) => -_byAtAsc(a, b));
  const warranty = warrantyFacts.map((f) => ({ value: f.value, side: f.side, source: _tagOf(f), at: f.at, factId: f.id }));
  const delay = cur.filter((f) => f.kind === 'delayReason');
  const dStruct = _newest(delay.filter((f) => f.via === 'structured'));
  const dAny = dStruct || _newest(delay);
  const lead = _newest(cur.filter((f) => f.kind === 'leadTime'));
  const ros = cur.filter((f) => f.kind === 'ro');
  const hasVendorWo = !!(r.vendorWorkOrderId || (Array.isArray(r.vendorWorkOrderIds) && r.vendorWorkOrderIds.length) || ros.some((f) => f.isVendorWo));
  const dRo = hasVendorWo ? null : _newest(ros.filter((f) => !f.isVendorWo));
  const vins = _uniq(cur.filter((f) => f.kind === 'vin').map((f) => _str(f.value).toUpperCase()));

  const conflicts = [];
  const wv = _uniq(warranty.map((w) => w.value));
  if (wv.length >= 2) {
    const candidates = wv.map((v) => { const w = warranty.find((x) => x.value === v); return { value: v, source: w.source, at: w.at, side: w.side }; });
    conflicts.push({ field: 'warranty', resolved: { value: warranty[0].value, source: warranty[0].source }, candidates });
  }
  for (const c of etc.conflicts) conflicts.push(c);
  if (dealer.conflict) {
    conflicts.push({ field: 'dealerName', resolved: { value: dealer.name, source: (dealer.groups.find((g) => g.key === dealer.nameKey) || {}).source || null },
      candidates: dealer.groups.map((g) => ({ value: g.value, source: g.source, at: g.at })) });
  }
  const rowVin = _str(r.vin).toUpperCase();
  if (vins.length > 1 || (vins.length === 1 && rowVin && !_blank(r.vin) && vins[0] !== rowVin)) {
    conflicts.push({ field: 'vin', resolved: { value: rowVin || vins[0], source: rowVin ? 'fleetdata' : 'relaygarage' }, candidates: vins.map((v) => ({ value: v, source: 'relaygarage', at: null })) });
  }
  const oc = pm.parts.filter((p) => p.orderConflict);
  if (oc.length) conflicts.push({ field: 'partOrder', resolved: { value: oc[0].orderNo, source: oc[0].source }, candidates: oc.map((p) => ({ value: p.partNo + ':' + p.orderNo, source: p.source, at: null })) });

  const events = [].concat(rf && Array.isArray(rf.events) ? rf.events : [], of && Array.isArray(of.events) ? of.events : []).slice().sort(_byAtAsc);
  const allOrders = _uniq(cur.filter((f) => f.kind === 'order').map((f) => _str(f.value).toUpperCase()).concat(pm.parts.map((p) => p.orderNo)));
  return {
    parts: pm.parts, partsStatus: pm.partsStatus,
    orders: allOrders,
    ros: _uniq(ros.map((f) => _str(f.value).toUpperCase())),
    dealerRo: dRo ? _str(dRo.value).toUpperCase() : '',
    etc, estimate, caseIds: ids, dealer, cause, correction, warranty,
    vendorDelayReason: dAny ? _str(dAny.value) : '',
    leadTime: lead ? _str(lead.value) : '',
    pmAddedToRo: cur.some((f) => f.kind === 'pmAdded' && f.value === true),
    tow: ids.tow,
    dtna: cur.filter((f) => f.kind === 'dtnaEvent').sort(_byAtAsc).map((f) => ({ value: f.value, dealer: f.dealer || null, city: f.city || null, status: f.status || null, transition: f.transition || null, at: f.at })),
    vins,
    pmSchedule: Array.isArray(r.pmSchedule) ? r.pmSchedule : [],
    conflicts, events, typed: _typed(all),
    stageDwell: Array.isArray(r.offsiteStageHistory) && r.offsiteStageHistory.length ? stageDwell(r.offsiteStageHistory, { since: sinceMs != null ? sinceMs : undefined }) : null,
    counts: {
      facts: all.length, prior: all.length - cur.length,
      rejected: ((rf && rf.counts && rf.counts.rejected) || 0) + ((of && of.counts && of.counts.rejected) || 0),
      truncated: ((rf && rf.counts && rf.counts.truncated) || 0) + ((of && of.counts && of.counts.truncated) || 0),
      noEpisodeCut: sinceMs == null ? true : undefined,
    },
    sources: { relay: !!rf, offsite: !!of, notes: !!(nf && nf.length) },
    blocks: { relayAt: rf ? rf.at || null : null, offsiteAt: of ? of.at || null : null, relayCounts: rf ? rf.counts || null : null, offsiteCounts: of ? of.counts || null : null },
  };
}

// Fill values the facts support (§9), '' when none.
function resolveFields(fs) {
  const sf = fs.caseIds.salesforce || '';
  const vinOk = fs.vins.length === 1 && !fs.conflicts.some((c) => c.field === 'vin');
  return {
    dealerName: fs.dealer.name || '',
    dealerCode: fs.dealer.code || '',
    decisivDealerId: fs.dealer.decisivDealerId || '',
    salesforceCase: sf,
    salesforceCaseUrl: sf ? buildSalesforceUrl(sf) : '',
    cause: joinLines(fs.cause),
    correction: joinLines(fs.correction),
    totalCost: fs.estimate.approvedTotal != null ? _usd(fs.estimate.approvedTotal) : '',
    vin: vinOk ? fs.vins[0] : '',
  };
}

// ── Mirrors (§12.3, §10) ────────────────────────────────────────────────────
const PM_SHORT = { PM_A: 'PM A', PM_B: 'PM B', PM_X: 'PM X', WASH: 'Wash', DOT: 'DOT', APU: 'APU', SVR: 'SVR', STATE_DOT: 'State insp',
  STATE: 'State insp', R360_HANDOFF_INSPECTION: 'R360', QUARTERLY_LIFT: 'Lift', SEMIANNUAL_LIFT: 'Lift' };
function _pmOverdue(schedule) {
  const list = (Array.isArray(schedule) ? schedule : []).filter((e) => e && Number(e.overdueDays) > 0)
    .sort((a, b) => Number(b.overdueDays) - Number(a.overdueDays));
  const parts = list.map((e) => (PM_SHORT[e.type] || _str(e.label || e.type)) + ' ' + Number(e.overdueDays) + 'd');
  let out = '';
  for (const p of parts) { const next = out ? out + '; ' + p : p; if (next.length > 120) break; out = next; }
  return out;
}

function rowMirrors(fs) {
  const etc = fs.etc;
  const ce = etc.currentEtc;
  const repDate = ce && ce.kind === 'repairCompletion' && ce.date ? ce.date : '';
  const pe = etc.partsEta && etc.partsEta.date ? etc.partsEta.date : '';
  const est = fs.estimate;
  const ext = [fs.blocks.relayAt, fs.blocks.offsiteAt].filter(Boolean).sort().pop() || '';
  return {
    partNumbers: fs.parts.map((p) => p.partNo).join('; '),
    orderNumbers: fs.orders.join('; '),
    roNumbers: fs.ros.join('; '),
    dealerRo: fs.dealerRo || '',
    decisivCaseId: fs.caseIds.decisivCase || '',
    oemCaseId: fs.caseIds.oemCase || '',
    towRefs: fs.caseIds.tow.join('; '),
    repairEtc: repDate,
    repairEtcSource: repDate ? ce.source || '' : '',
    partsEta: pe,
    partsStatus: fs.partsStatus || '',
    etcMissCount: etc.etcMissCount,
    etcMissed: etc.counted.state === 'missed',
    etcReason: etc.counted.reason || '',
    partsMissCount: etc.partsMissCount,
    estimateApprovedAmount: est.approvedTotal != null ? est.approvedTotal : '',
    estimateStatus: est.status || '',
    estimateVersion: est.latestVersion != null ? est.latestVersion : '',
    estimateRejectReason: est.latestRejectReason && est.latestRejectReason.reason ? est.latestRejectReason.reason : '',
    vendorDelayReason: fs.vendorDelayReason || '',
    pmAddedToRo: !!fs.pmAddedToRo,
    leadTime: fs.leadTime || '',
    dealerCallAttempts: fs.dealer.callAttempts.length,
    pmOverdue: _pmOverdue(fs.pmSchedule),
    factConflicts: fs.conflicts.length,
    extractedAt: ext,
  };
}

function _factEtc(fs) {
  const etc = fs.etc;
  const c = etc.counted;
  const ce = etc.currentEtc;
  const ent = etc._countedEntry;
  const negated = !!(ce && ce.negated && ce.kind === 'repairCompletion');
  return {
    date: c.date || null, kind: 'repairCompletion', state: c.state, explicitMissDate: c.explicitMissDate || null,
    source: ent ? ent.source : (negated ? ce.source || null : null),
    statedAt: ent ? ent.statedAt || null : (negated ? ce.statedAt || null : null),
    snippet: ent ? ent.snippet || '' : '',
    negated, reason: c.reason || null,
  };
}

function _partsWhy(fs) {
  const shipOpen = fs.etc.partsEta && fs.etc.partsEta.date && fs.etc.partsEta.kind === 'partsShip' ? fs.etc.partsEta.date : '';
  const out = [];
  for (const p of fs.parts) {
    let s = 'Part #' + p.partNo;
    if (p.orderNo) s += ' (Order #' + p.orderNo + (p.vor ? ', VOR' : '') + ')';
    else if (p.vor) s += ' (VOR)';
    if (p.status) s += ' ' + p.status + (p.lastStatusAt ? ' ' + _mdPad(_day(p.lastStatusAt)) : '');
    if (shipOpen) s += ', ship ' + _mdPad(shipOpen);
    out.push(s);
  }
  let r = '';
  for (const s of out) { const next = r ? r + '; ' + s : s; if (next.length > 200) break; r = next; }
  return r;
}

function _estimateWhy(fs) {
  const lr = fs.estimate.latestRejectReason;
  if (!lr || fs.estimate.approvedAfterReject) return '';
  return 'V' + lr.v + ' ' + lr.status + ': ' + _str(lr.reason).slice(0, 80);
}

// Blank-or-own-fill writer (§9).
function _fill(row, key, v) {
  const ff = row._factFilled && typeof row._factFilled === 'object' ? row._factFilled : null;
  const own = ff ? ff[key] : undefined;
  const free = _blank(row[key]) || (own !== undefined && row[key] === own);
  if (!free) { if (ff) delete ff[key]; return; }
  const val = v == null ? '' : v;
  if (val === '' && own === undefined) return;               // nothing to write, nothing owned
  row[key] = val;
  if (val === '') { if (ff) delete ff[key]; return; }
  if (!row._factFilled || typeof row._factFilled !== 'object') row._factFilled = {};
  row._factFilled[key] = val;
}

/**
 * applyToRow(row, fs, flags): fills, derived subVendor, mirrors, _factsSig and (aiOutput) the
 * _fact* keys. A pure function of (row inputs, fs); flags off -> row untouched.
 */
function applyToRow(row, fs, flags) {
  if (!row || !fs || !flags || !flags.enabled) return row;
  const fills = resolveFields(fs);
  for (const k of FILL_KEYS) _fill(row, k, fills[k]);
  if (row._factFilled && typeof row._factFilled === 'object' && !Object.keys(row._factFilled).length) delete row._factFilled;
  row.subVendor = untruncate(row.dealerName || fs.dealer.name || _supplierName(row.suppliers) || '', fs.dealer.candidates);
  Object.assign(row, rowMirrors(fs));
  const hasSource = fs.sources.relay || fs.sources.offsite;
  if (hasSource) {
    row._factsSig = _sha1(_str(fs.blocks.relayAt) + '|' + _str(fs.blocks.offsiteAt) + '|' + JSON.stringify([fs.blocks.relayCounts, fs.blocks.offsiteCounts]));
  } else delete row._factsSig;
  if (flags.aiOutput && hasSource) {
    row._factsOn = true;
    row._factEtc = _factEtc(fs);
    row._factPartsWhy = _partsWhy(fs);
    row._factEstimateWhy = _estimateWhy(fs);
  } else {
    for (const k of AI_KEYS) delete row[k];
  }
  return row;
}

// ── Entry points (§12.3) ────────────────────────────────────────────────────
function refreshRowFacts(row, flags, today) {
  if (!flags || !flags.enabled || !row || typeof row !== 'object') return row;
  try { applyToRow(row, buildFactSet(row, { today: today || _todayYmd() }), flags); } catch (e) { _warnOnce('refreshRowFacts', row.equipmentId, e); }
  return row;
}

function refreshFleetFacts(rows, flags, today) {
  if (!flags || !flags.enabled || !Array.isArray(rows)) return rows;
  try { trimFleetBlocks(rows, X.CAPS.fleetBytes); } catch (e) { _warnOnce('trimFleetBlocks', null, e); }
  const t = today || _todayYmd();
  for (const r of rows) refreshRowFacts(r, flags, t);
  return rows;
}

// Loaders without a carry-forward: keep blocks from the previous fleetData for the SAME WR only.
function carryFactBlocks(rows, prevRows) {
  const prev = new Map((prevRows || []).filter(Boolean).map((p) => [p.equipmentId, p]));
  for (const r of rows || []) {
    if (!r) continue;
    const p = prev.get(r.equipmentId);
    if (!p || !r.workRequestId || p.workRequestId !== r.workRequestId) continue;
    if (!_isBlock(r.relayFacts) && _isBlock(p.relayFacts) && p.relayFactsWr === r.workRequestId) { r.relayFacts = p.relayFacts; r.relayFactsWr = p.relayFactsWr; }
    if (!_isBlock(r.offsiteFacts) && _isBlock(p.offsiteFacts) && (!p._offsiteWrId || p._offsiteWrId === r.workRequestId)) r.offsiteFacts = p.offsiteFacts;
    if (!(Array.isArray(r.offsiteStageHistory) && r.offsiteStageHistory.length) && Array.isArray(p.offsiteStageHistory) && p.offsiteStageHistory.length
        && (!p._offsiteWrId || p._offsiteWrId === r.workRequestId)) r.offsiteStageHistory = p.offsiteStageHistory;
  }
  return rows;
}

// ── Fleet byte cap (§12.5) ──────────────────────────────────────────────────
function _trimBlock(b, target) {
  const nb = Object.assign({}, b, { facts: b.facts.slice(), events: (Array.isArray(b.events) ? b.events : []).slice().sort(_byAtAsc), counts: Object.assign({}, b.counts || {}) });
  let size = JSON.stringify(nb).length;
  let dropped = 0;
  while (size > target && nb.events.length) { size -= JSON.stringify(nb.events[0]).length + 1; nb.events.shift(); dropped++; }
  if (size > target) {
    const seen = new Set(); const drop = new Set();
    nb.facts.forEach((f, i) => {
      if (f.kind !== 'etcMention' || f.value == null) return;
      const k = f.etcKind + '|' + f.value + '|' + _str(f.marker);
      if (seen.has(k)) drop.add(i); else seen.add(k);
    });
    for (const i of drop) { if (size <= target) break; size -= JSON.stringify(nb.facts[i]).length + 1; nb.facts[i] = null; dropped++; }
    nb.facts = nb.facts.filter(Boolean);
  }
  if (size > target) {
    const order = nb.facts.map((f, i) => ({ i, prior: f.episode === 'prior' ? 0 : 1, ms: _ms(f.at) == null ? -Infinity : _ms(f.at) }))
      .sort((a, b) => (a.prior - b.prior) || (a.ms - b.ms));
    for (const o of order) { if (size <= target) break; size -= JSON.stringify(nb.facts[o.i]).length + 1; nb.facts[o.i] = null; dropped++; }
    nb.facts = nb.facts.filter(Boolean);
  }
  nb.counts.truncated = (nb.counts.truncated || 0) + dropped;
  return { block: nb, size: JSON.stringify(nb).length, dropped };
}

// -> { bytes, truncated }. Trims the largest block by 25% while the total exceeds maxBytes.
function trimFleetBlocks(rows, maxBytes) {
  const cap = Number.isFinite(maxBytes) ? maxBytes : X.CAPS.fleetBytes;
  const items = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    for (const k of FACT_BLOCK_KEYS) if (_isBlock(r[k])) items.push({ r, k, size: JSON.stringify(r[k]).length });
  }
  let total = items.reduce((s, x) => s + x.size, 0);
  let truncated = 0;
  let guard = 0;
  while (total > cap && items.length && guard++ < 10000) {
    let big = items[0];
    for (const x of items) if (x.size > big.size) big = x;
    if (big.size <= 64) break;
    const t = _trimBlock(big.r[big.k], Math.floor(big.size * 0.75));
    if (!t.dropped) break;
    big.r[big.k] = t.block;
    total += t.size - big.size;
    big.size = t.size;
    truncated += t.dropped;
  }
  return { bytes: total, truncated };
}

// ── Renderer projection (§12.5) ─────────────────────────────────────────────
function _hasBlocks(r) { return !!r && typeof r === 'object' && FACT_BLOCK_KEYS.some((k) => k in r); }
function _omit(r) { const o = Object.assign({}, r); for (const k of FACT_BLOCK_KEYS) delete o[k]; return o; }
function rendererView(d) {
  try {
    if (!d || !Array.isArray(d.rows) || !d.rows.some(_hasBlocks)) return d;
    return Object.assign({}, d, { rows: d.rows.map((r) => (_hasBlocks(r) ? _omit(r) : r)) });
  } catch (e) { _warnOnce('rendererView', null, e); return d; }
}
function rendererRow(r) {
  try { return _hasBlocks(r) ? _omit(r) : r; } catch (e) { _warnOnce('rendererRow', null, e); return r; }
}

// ── Gate typed index (§14.2 / §14.3.1 shape) ────────────────────────────────
function _toMd(v) {
  const s = _str(v).trim();
  if (/^\d{1,2}\/\d{1,2}$/.test(s)) return s.split('/').map((x) => String(+x)).join('/');
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return D.md(m[1]);
  const ms = _ms(s);
  return ms == null ? '' : D.md(D.ymd(ms));
}
function typedIndex(fs, opts = {}) {
  const t = fs && fs.typed ? fs.typed : _typed([]);
  const byKind = {
    part: new Set(t.refsByKind.part), order: new Set(t.refsByKind.order), ro: new Set(t.refsByKind.ro),
    dealerCode: new Set(t.refsByKind.dealerCode), tow: new Set(t.refsByKind.tow), fleetnet: new Set(t.refsByKind.fleetnet),
    case: { salesforce: new Set(t.refsByKind.case.salesforce), decisivCase: new Set(t.refsByKind.case.decisivCase),
      oemCase: new Set(t.refsByKind.case.oemCase), unknown: new Set(t.refsByKind.case.unknown) },
  };
  const etcRepair = new Set(t.etc.repairCompletion.map(_toMd).filter(Boolean));
  const partsDates = new Set(t.etc.parts.map(_toMd).filter(Boolean));
  const dates = _uniq(t.dates.map(_toMd).concat((opts.rowDates || []).map(_toMd)).filter(Boolean));
  const refs = [].concat(t.refsByKind.part, t.refsByKind.order, t.refsByKind.ro, t.refsByKind.dealerCode, t.refsByKind.tow, t.refsByKind.fleetnet,
    t.refsByKind.case.salesforce, t.refsByKind.case.decisivCase, t.refsByKind.case.oemCase, t.refsByKind.case.unknown);
  const amounts = t.amounts.map((c) => '$' + (c / 100).toFixed(2));
  const tokenText = _uniq(refs.concat(amounts, dates)).join(' ');
  const factIds = new Map(Object.entries(t.factIds || {}));
  return { tokenText, byKind, etcRepair, partsDates, factIds };
}

// ── Repair-intel digest (§13.2) ─────────────────────────────────────────────
function _firstAt(history, status) {
  let best = null;
  for (const h of Array.isArray(history) ? history : []) {
    if (!h || h.status !== status || _ms(h.at) == null) continue;
    if (best == null || _ms(h.at) < _ms(best)) best = h.at;
  }
  return best;
}
function digestForRi(fs) {
  const etc = fs.etc;
  const d = {
    v: 1,
    parts: fs.parts.map((p) => ({ partNo: p.partNo, qty: p.qty, orderNo: p.orderNo, vor: p.vor, status: p.status, lastStatusAt: p.lastStatusAt })),
    orders: fs.orders.slice(), ros: fs.ros.slice(),
    caseIds: { salesforce: fs.caseIds.salesforce, decisivCase: fs.caseIds.decisivCase, oemCase: fs.caseIds.oemCase, fleetnet: fs.caseIds.fleetnet, tow: fs.caseIds.tow },
    // submittedAt / approvedAt (first of each in the version history) feed Trends approvalCycle (§12.6).
    estimate: { versions: fs.estimate.versions.map((v) => ({ v: v.v, amount: v.amount, status: v.status, reason: v.reason, at: v.at,
      submittedAt: _firstAt(v.history, 'submitted'), approvedAt: _firstAt(v.history, 'approved') })),
      approvedTotal: fs.estimate.approvedTotal, latestSubmitted: fs.estimate.latestSubmitted },
    etc: { currentEtc: etc.currentEtc, currentEtcKind: etc.currentEtcKind, missCount: etc.etcMissCount, detailsMissCount: etc.missCount,
      partsMissCount: etc.partsMissCount, counted: etc.counted, etcReason: etc.counted.reason || etc.etcReason, etcSource: etc.etcSource,
      lastEtcStatedAt: etc.lastEtcStatedAt, priorEtcs: etc.priorEtcs.slice(0, 12) },
    cause: fs.cause.slice(0, 6).map((c) => ({ line: c.line, text: c.text })),
    correction: fs.correction.slice(0, 6).map((c) => ({ line: c.line, text: c.text })),
    vendorDelayReason: fs.vendorDelayReason,
    dealer: { name: fs.dealer.name, code: fs.dealer.code, decisivDealerId: fs.dealer.decisivDealerId, callAttempts: fs.dealer.callAttempts.length },
    leadTime: fs.leadTime, pmAddedToRo: fs.pmAddedToRo,
    warranty: fs.warranty.slice(0, 4).map((w) => ({ value: w.value, side: w.side, at: w.at })),
    conflicts: fs.conflicts.map((c) => c.field),
  };
  while (JSON.stringify(d).length > DIGEST_MAX && d.etc.priorEtcs.length) d.etc.priorEtcs.pop();
  if (JSON.stringify(d).length > DIGEST_MAX) for (const v of d.estimate.versions) v.reason = v.reason ? _str(v.reason).slice(0, 40) : v.reason;
  return d;
}

module.exports = {
  buildFactSet, etcModel, estimateModel, partsModel, caseIds, dealerModel, nameKey, resolveFields, stageDwell,
  applyToRow, refreshRowFacts, refreshFleetFacts, carryFactBlocks, trimFleetBlocks, rowMirrors, digestForRi, typedIndex,
  rendererView, rendererRow, dealerOf, freshness, joinLines, untruncate,
  AUTH_TAG, FACT_BLOCK_KEYS, FILL_KEYS,
};

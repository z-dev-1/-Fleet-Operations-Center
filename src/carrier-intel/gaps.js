'use strict';
/**
 * carrier-intel/gaps.js — the disclosed-gap catalog (design B9).
 *
 * selectGaps({ cues, model, stats, fd, now }) -> { gaps: [{ id, kind:'cue'|'data', text }], diag }.
 * The texts are fixed in GAP_TEXT; every {…} field comes from computed values, never from the
 * AI. Cue gaps are never capped; data gaps are capped at 6. Render order: G-STALE, G-FASID,
 * the cue gaps in table order, then the remaining data gaps. Pure: no I/O, no logging.
 */

const { defangMentions } = require('../justme-context/reply-hygiene');
const Fx = require('./facts');

const STALE_MS = 4 * 3600 * 1000;
const DATA_GAPS_MAX = 6;
const DRIVER_QUOTES_MAX = 2;
const CND_IDS_MAX = 5;
const CUE_ORDER = Object.freeze(['G-ARRIVAL', 'G-REASSIGN', 'G-DRIVER', 'G-CND', 'G-SYMPTOM', 'G-DSPHOLD']);
const DATA_ORDER = Object.freeze(['G-STALE', 'G-FASID', 'G-NOFACTS', 'G-NODETAIL', 'G-FILTER', 'G-PMA']);
const DRIVER_THEMES = Object.freeze(['after fueling', 'cold start', 'under load']);

const GAP_TEXT = Object.freeze({
  'G-ARRIVAL': 'Tech arrival is only captured for the current work order on {n} unit(s) (Relay "Actual technician arrival"), measured from vendor assignment: median {median} h, range {min} h to {max} h. Closed WRs and dealer or DSP units have no arrival record, so the sample is small. AAP down time counts from WR creation, not tech arrival.',
  'G-ARRIVAL-NONE': 'Tech arrival time isn\'t captured for {SCAC}\'s down units: no current work order has a Relay "Actual technician arrival" entry, and closed WRs aren\'t covered. AAP down time counts from WR creation, not tech arrival.',
  'G-REASSIGN': 'Tech reassignment (for example a vendor moving techs to trailers or hostlers) isn\'t recorded: the data has no tech identity or reassignment history, so I can\'t name dates or units.',
  'G-DRIVER': 'Driver-reported conditions (cold start, after fueling, under load) aren\'t structured fields. Free-text mentions: {quotes}.',
  'G-DRIVER-NONE': 'Driver-reported conditions (cold start, after fueling, under load) aren\'t structured fields, and none are mentioned in {SCAC}\'s notes or repair summaries.',
  'G-CND': '"Could not duplicate"-type outcomes appear on {k} unit(s): {ids}.',
  'G-CND-NONE': '"Could not duplicate" doesn\'t appear in {SCAC}\'s current conversations or repair summaries.',
  'G-CND-NEAREST': ' The nearest is a vendor "system OK"-type finding on {ids}.',
  'G-SYMPTOM': 'Symptom themes come from free-text notes and daily repair summaries, not structured fields; they\'re counted per unit and episode, not verified diagnoses.',
  'G-DSPHOLD': 'There\'s no structured DSP-hold reason; the DSP blockers here come from FAS/MCS notes.',
  'G-PMA': 'AAP shows {halves}. These look like stale AAP schedules, not missed PMs.',
  'G-PMA-A': 'PM A overdue on {n} unit(s) that completed a later PM B/X',
  'G-PMA-W': 'Wash overdue on {w} unit(s)',
  'G-PMA-W-DATE': ' last recorded {date}',
  'G-NOFACTS': '{k} unit(s) have no extracted Relay facts yet ({ids}); their lines use AAP fields only.',
  'G-NODETAIL': 'Detail covers {k} of {n} down units (the {k} longest-down); the rest count in the totals only.',
  'G-NODETAIL-TIER': 'Full notes cover the {x} longest-down units of {n}; the rest come from extracted facts only.',
  'G-FILTER': 'No {SCAC} units are tagged box truck, so this covers all {SCAC} units.',
  'G-STALE': '\u26a0 Fleet data is {h} h old.',
  'G-FASID': 'Your own Relay comments aren\'t identified yet this session (AAP login not loaded), so actions taken can\'t be listed from them; see the unit notes in Relay.',
});

function _s(v) { return v == null ? '' : String(v); }
function _fill(tpl, vals) { return tpl.replace(/\{(\w+)\}/g, (m, k) => (vals[k] != null ? String(vals[k]) : m)); }
function _median(hs) {
  const s = hs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10;
}

/** Arrival figures over records with basis 'assign' (the same rule as the roll-up line, B6.4). */
function arrivalStats(records) {
  const hs = (Array.isArray(records) ? records : [])
    .filter((r) => r && r.arrival && r.arrival.basis === 'assign' && r.arrival.hours != null).map((r) => r.arrival.hours);
  if (!hs.length) return { n: 0 };
  const s = hs.slice().sort((a, b) => a - b);
  return { n: hs.length, median: _median(hs).toFixed(1), min: s[0].toFixed(1), max: s[s.length - 1].toFixed(1) };
}

function _idList(ids, detailed) {
  const shown = ids.filter((id) => !detailed || detailed.has(id));
  const more = ids.length - shown.length;
  return shown.join(', ') + (more > 0 ? (shown.length ? ', ' : '') + '+' + more + ' more' : '');
}

function _cueGap(id, cues, m, scac) {
  const recs = m.records || [];
  const hits = (m.themes && m.themes.hits) || {};
  switch (id) {
    case 'G-ARRIVAL': {
      if (!(cues.arrival || (cues.uptime && recs.some((r) => r.arrival != null)))) return null;
      const a = arrivalStats(recs);
      return a.n ? _fill(GAP_TEXT['G-ARRIVAL'], a) : _fill(GAP_TEXT['G-ARRIVAL-NONE'], { SCAC: scac });
    }
    case 'G-REASSIGN':
      return cues.reassign ? GAP_TEXT['G-REASSIGN'] : null;
    case 'G-DRIVER': {
      if (!cues.driver) return null;
      const all = [];
      for (const t of DRIVER_THEMES) for (const h of hits[t] || []) all.push(h);
      if (!all.length) return _fill(GAP_TEXT['G-DRIVER-NONE'], { SCAC: scac });
      all.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
      const seen = new Set();
      const qs = [];
      for (const h of all) {
        if (seen.has(h.id)) continue;
        seen.add(h.id);
        qs.push('"' + Fx.md(h.date) + ' ' + h.id + ': ' + defangMentions(h.quote) + '"');
        if (qs.length >= DRIVER_QUOTES_MAX) break;
      }
      return _fill(GAP_TEXT['G-DRIVER'], { quotes: qs.join('; ') });
    }
    case 'G-CND': {
      if (!cues.cnd) return null;
      const ids = (h) => [...new Set((h || []).map((x) => x.id))];
      const cnd = ids(hits['could not duplicate']);
      if (cnd.length) return _fill(GAP_TEXT['G-CND'], { k: cnd.length, ids: cnd.slice(0, CND_IDS_MAX).join(', ') });
      let s = _fill(GAP_TEXT['G-CND-NONE'], { SCAC: scac });
      const near = ids(hits['vendor found no fault']);
      if (near.length) s += _fill(GAP_TEXT['G-CND-NEAREST'], { ids: near.slice(0, CND_IDS_MAX).join(', ') });
      return s;
    }
    case 'G-SYMPTOM':
      return cues.symptom ? GAP_TEXT['G-SYMPTOM'] : null;
    case 'G-DSPHOLD': {
      const dspUnit = recs.some((r) => r.owner === 'DSP');
      return (cues.dsp || (dspUnit && (cues.uptime || cues.why))) ? GAP_TEXT['G-DSPHOLD'] : null;
    }
    default: return null;
  }
}

function _dataGap(id, m, fd, now, scac) {
  const recs = m.records || [];
  switch (id) {
    case 'G-STALE': {
      const at = Date.parse(_s(fd && fd.syncedAt));
      const t = Number.isFinite(now) ? now : Date.parse(_s(now));
      if (!Number.isFinite(at) || !Number.isFinite(t) || t - at <= STALE_MS) return null;
      return _fill(GAP_TEXT['G-STALE'], { h: Math.floor((t - at) / 3600000) });
    }
    case 'G-FASID':
      return _s(m.fasAlias) === '' ? GAP_TEXT['G-FASID'] : null;
    case 'G-NOFACTS': {
      const noFacts = m.noFactsIds || recs.filter((r) => r.factsFresh === false).map((r) => r.id);
      if (!noFacts.length) return null;
      return _fill(GAP_TEXT['G-NOFACTS'], { k: noFacts.length, ids: _idList(noFacts, m.detailedIds) });
    }
    case 'G-NODETAIL': {
      const n = recs.length;
      const k = m.detailedIds ? m.detailedIds.size : n;
      const x = m.blockIds ? m.blockIds.size : k;
      const parts = [];
      if (k < n) parts.push(_fill(GAP_TEXT['G-NODETAIL'], { k, n }));
      if (x < k) parts.push(_fill(GAP_TEXT['G-NODETAIL-TIER'], { x, n }));
      return parts.length ? parts.join(' ') : null;
    }
    case 'G-FILTER':
      return m.filterFallback ? _fill(GAP_TEXT['G-FILTER'], { SCAC: scac }) : null;
    case 'G-PMA': {
      const cb = m.countBy instanceof Map ? m.countBy : new Map();
      const n = cb.get('pmaStale') || 0;
      const w = cb.get('washStale') || 0;
      if (!n && !w) return null;
      const halves = [];
      if (n) halves.push(_fill(GAP_TEXT['G-PMA-A'], { n }));
      if (w) halves.push(_fill(GAP_TEXT['G-PMA-W'], { w }) + (m.washLast ? _fill(GAP_TEXT['G-PMA-W-DATE'], { date: m.washLast }) : ''));
      return _fill(GAP_TEXT['G-PMA'], { halves: halves.join(', and ') });
    }
    default: return null;
  }
}

/**
 * selectGaps({ cues, model, stats, fd, now }) -> { gaps, diag }.
 * `model` carries records (all down units), countBy, themes, scac, fasAlias, detailedIds,
 * blockIds, noFactsIds, filterFallback and washLast (built by context.buildContext).
 */
function selectGaps(args = {}) {
  const cues = args.cues && typeof args.cues === 'object' ? args.cues : {};
  const m = args.model && typeof args.model === 'object' ? args.model : {};
  const scac = _s(m.scac);
  const diag = [];
  const data = [];
  for (const id of DATA_ORDER) {
    try {
      const t = _dataGap(id, m, args.fd, args.now, scac);
      if (t) data.push({ id, kind: 'data', text: defangMentions(t) });
    } catch (_) { diag.push({ code: 'gap-failed', level: 'debug', id }); }
  }
  const kept = data.slice(0, DATA_GAPS_MAX);
  const cue = [];
  for (const id of CUE_ORDER) {
    try {
      const t = _cueGap(id, cues, m, scac);
      if (t) cue.push({ id, kind: 'cue', text: defangMentions(t) });
    } catch (_) { diag.push({ code: 'gap-failed', level: 'debug', id }); }
  }
  const lead = kept.filter((g) => g.id === 'G-STALE' || g.id === 'G-FASID');
  const rest = kept.filter((g) => g.id !== 'G-STALE' && g.id !== 'G-FASID');
  return { gaps: lead.concat(cue, rest), diag };
}

module.exports = { GAP_TEXT, selectGaps, arrivalStats, CUE_ORDER, DATA_ORDER, DATA_GAPS_MAX, STALE_MS };

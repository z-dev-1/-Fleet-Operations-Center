'use strict';
/**
 * tests/fixtures/carrier-intel/build-auvte-fleet.cjs — builds the AUVTE fixture fleet
 * (carrier-intel design B18.2, plan decisions D1 / D2) and, when run directly, writes
 * auvte-scac-rows.json next to this file:
 *
 *   $env:TZ='America/New_York'; node tests/fixtures/carrier-intel/build-auvte-fleet.cjs
 *
 * Rows: g1/g2/g3 `.row` as committed; B12263 / B12267 / B62059 / B12258 synthesized from the
 * m1 / m8+m5 / m3 / m2 replays with synthetic Relay history LOGS (one ASSIGN_VENDOR, one
 * 'Expected completion date time' edit per revision, and for B12263 / B12267 an arrival log)
 * appended before extractRelay (D1), then wo-facts.refreshRowFacts(row, { enabled:true,
 * aiOutput:true }, '2026-11-17') last (D2); the 4 m9 Active rows; 18 plain Active rows (three
 * of them B12271, B62053, B20038). Deterministic: no Date.now(), fixed key order. The script
 * asserts isDown, the ETC day-slip split and the arrival hours, and throws otherwise.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const X = require(path.join(ROOT, 'src/repair-intel/wo-extract'));
const W = require(path.join(ROOT, 'src/repair-intel/wo-facts'));
const F = require(path.join(ROOT, 'src/dbr/fleet-dbr'));
const mapper = require(path.join(ROOT, 'src/scrapers/aap_api_mapper'));
const Fx = require(path.join(ROOT, 'src/carrier-intel/facts'));

const SYNCED_AT = '2026-11-17T17:38:17Z';
const TODAY = '2026-11-17';
const LAST_EDIT_AT = '2026-11-17T12:15:00Z';
const OUT = path.join(__dirname, 'auvte-scac-rows.json');

const load = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

// Per-row table (B18.2). head = the ET day the last revision ends on (report §6, D1).
const SYN = [
  { id: 'B12263', vendor: 'COX', lifecycleReason: 'Damaged-Moderate', issueSummary: 'crankcase cover leak', src: 'm1',
    assignAt: '2026-11-03T23:44:37Z', later: 9, earlier: 1, same: 2, head: '2026-11-17', arrivalRaw: '2026-11-04T03:44:44Z' },
  { id: 'B12267', vendor: 'COX', lifecycleReason: 'Damaged-Moderate', issueSummary: 'turbo seals into CAC', src: 'm8+m5',
    assignAt: '2026-11-03T00:39:26Z', later: 11, earlier: 1, same: 2, head: '2026-11-17', arrivalRaw: '2026-11-03T04:27:08Z' },
  { id: 'B62059', vendor: 'COX', lifecycleReason: 'Damaged-Moderate', issueSummary: 'broken hood shocks and air drain lines', src: 'm3',
    assignAt: '2026-11-03T19:55:54Z', later: 9, earlier: 0, same: 2, head: '2026-11-18', arrivalRaw: null },
  { id: 'B12258', vendor: 'KWNE', lifecycleReason: 'Offsite Shop Repair', issueSummary: 'CEL / harness repin', src: 'm2',
    assignAt: '2026-10-27T15:55:00Z', later: 0, earlier: 0, same: 0, head: null, arrivalRaw: null },
];
const EXPECT = { B12195: { later: 5, hours: 34.3 }, B12263: { later: 9, hours: 4.0 }, B12267: { later: 11, hours: 3.8 }, B62059: { later: 9, hours: 8.4 } };
const PLAIN_IDS = ['B12271', 'B62053', 'B20038', 'B12272', 'B12273', 'B12274', 'B12276', 'B12277', 'B12278',
  'B12279', 'B12280', 'B12281', 'B12282', 'B12283', 'B12284', 'B12285', 'B12286', 'B12287'];

function _pad(n) { return String(n).padStart(2, '0'); }
function _addDays(ymd, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
  return t.getUTCFullYear() + '-' + _pad(t.getUTCMonth() + 1) + '-' + _pad(t.getUTCDate());
}
// ISO of hh:00 America/New_York on a YYYY-MM-DD (local time; TZ is pinned to New York).
function _etIso(ymd, hh) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return new Date(+m[1], +m[2] - 1, +m[3], hh, 0, 0, 0).toISOString();
}
function _plusMs(iso, ms) { return new Date(Date.parse(iso) + ms).toISOString(); }

function _durationTo(fromIso, toIso) {
  const mins = Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / 60000);
  return Math.floor(mins / 1440) + 'd ' + Math.floor((mins % 1440) / 60) + 'h ' + (mins % 60) + 'm';
}

function _assignLog(wrId, at, vendor) {
  return { serviceEntityId: wrId, eventDateTime: at, requester: 'fasuser1', operation: 'ASSIGN_VENDOR', message: 'Work request edited', status: 'SUCCESS',
    serviceChangeDetails: [{ field: 'Vendor', description: 'vendor', oldValue: 'UNASSIGNED', newValue: vendor, displayType: 'PLAIN_TEXT' }] };
}
function _etcLog(woId, at, fromIso, toIso) {
  return { serviceEntityId: woId, eventDateTime: at, requester: 'COX', operation: 'EDIT', message: 'Work order edited', status: 'SUCCESS',
    serviceChangeDetails: [{ field: 'Expected completion date time', description: 'expected completion date time', oldValue: fromIso, newValue: toIso, displayType: 'DATE_TIME' }] };
}
function _arrivalLog(woId, raw) {
  return { serviceEntityId: woId, eventDateTime: _plusMs(raw, 17000), requester: 'COX', operation: 'EDIT', message: 'Work order edited', status: 'SUCCESS',
    serviceChangeDetails: [
      { field: 'Actual technician arrival date time', description: 'actual technician arrival date time', oldValue: null, newValue: raw, displayType: 'DATE_TIME' },
      { field: 'State', description: 'state', oldValue: 'PENDING', newValue: 'WORK_IN_PROGRESS', displayType: 'ENUM_TEXT' },
    ] };
}

// Synthetic ETC revisions (B18.2 generator, D1 cursor): later moves, then earlier, then same-day.
function _etcLogs(spec, woId) {
  const n = spec.later + spec.earlier + spec.same;
  if (!n) return [];
  let d = _addDays(spec.head, -(spec.later - spec.earlier));
  const a0 = Date.parse(spec.assignAt) + 2 * 3600 * 1000;
  const a1 = Date.parse(LAST_EDIT_AT);
  const logs = [];
  const moves = [].concat(Array(spec.later).fill(1), Array(spec.earlier).fill(-1), Array(spec.same).fill(0));
  moves.forEach((mv, k) => {
    const from = d;
    const to = _addDays(d, mv);
    const at = new Date(n === 1 ? a1 : Math.round(a0 + (k * (a1 - a0)) / (n - 1))).toISOString();
    logs.push(_etcLog(woId, at, _etIso(from, 12), _etIso(to, mv === 0 ? 15 : 12)));
    d = to;
  });
  return logs;
}

function _source(spec) {
  if (spec.src === 'm8+m5') {
    const m8 = load('m8-cox-parts-eta-restatements-missed.json');
    const m5 = load('m5-estimate-subtotals-counted-as-versions.json');
    const seen = new Set();
    const comments = [];
    for (const c of [].concat(m8.input.serviceDetail.workRequest.comments || [], m5.input.serviceDetail.workRequest.comments || [])) {
      const key = c.id ? 'id:' + c.id : (c.createdDateTime || c.timestamp || '') + '|' + c.text;
      if (seen.has(key)) continue;
      seen.add(key);
      comments.push(c);
    }
    const sd = clone(m8.input.serviceDetail);
    sd.workRequest.comments = clone(comments);
    sd.workOrders = clone(m5.input.serviceDetail.workOrders);
    return { sd, opts: clone(m8.input.opts), history: clone(m5.input.history || []), now: m8.now };
  }
  const file = { m1: 'm1-cox-bare-parts-ordered.json', m2: 'm2-kwne-question-read-as-arrival.json', m3: 'm3-cox-no-eta-classified-tech-onsite.json' }[spec.src];
  const fx = load(file);
  return { sd: clone(fx.input.serviceDetail), opts: clone(fx.input.opts), history: clone(fx.input.history || []), now: fx.now };
}

function _synthRow(spec) {
  const src = _source(spec);
  const wrId = src.sd.workRequest.id;
  const woId = 'wo-' + spec.id.toLowerCase();
  const history = src.history.concat([_assignLog(wrId, spec.assignAt, spec.vendor)], _etcLogs(spec, woId),
    spec.arrivalRaw ? [_arrivalLog(woId, spec.arrivalRaw)] : []);
  const relayFacts = X.extractRelay(src.sd, Object.assign({}, src.opts, { history, now: Date.parse(src.now) }));
  const row = {
    equipmentId: spec.id,
    assetType: 'boxTruck',
    bodyType: 'Box Truck',
    domicileSite: 'ROC5',
    operator: 'AUVTE',
    lifecycleState: 'Unavailable',
    lifecycleReason: spec.lifecycleReason,
    serviceState: 'Work in progress',
    subState: 'Work order assigned',
    vendor: spec.vendor,
    serviceCategory: 'UNPLANNED',
    workDuration: _durationTo(relayFacts.wrCreatedAt, SYNCED_AT),
    issueSummary: spec.issueSummary,
    issueDetails: '',
    created: relayFacts.wrCreatedAt,
    offsiteShopEventUrl: '',
    asistSrUrl: '',
    towRefs: '',
    repairTimeline: '',
    fullConversation: 'Conversation\n' + mapper.commentsToTimeline(mapper.collectAllComments(src.sd), { includeInternal: true, tagInternal: false }),
    relayFacts,
    workRequestId: relayFacts.wr,
    relayFactsWr: relayFacts.wr,
  };
  W.refreshRowFacts(row, { enabled: true, aiOutput: true }, TODAY);
  return row;
}

function _activeRow(id) {
  return { equipmentId: id, assetType: 'boxTruck', bodyType: 'Box Truck', domicileSite: 'ROC5', operator: 'AUVTE',
    lifecycleState: 'Active', lifecycleReason: '', serviceState: '', subState: '', vendor: '' };
}
function _m9Row(r0) {
  const r = clone(r0);
  for (const k of Object.keys(r)) if (r[k] === '(absent)') delete r[k];
  const row = Object.assign({ equipmentId: r.equipmentId, assetType: 'boxTruck', bodyType: 'Box Truck' }, r);
  W.refreshRowFacts(row, { enabled: true }, TODAY);
  return row;
}

function _check(rows) {
  const byId = new Map(rows.map((r) => [r.equipmentId, r]));
  for (const spec of SYN) {
    if (!F.isDown(byId.get(spec.id))) throw new Error('build-auvte-fleet: ' + spec.id + ' is not down');
  }
  for (const id of Object.keys(EXPECT)) {
    const r = byId.get(id);
    const c = Fx.etcDayCounts(r.relayFacts && r.relayFacts.historyTrend);
    if (!c || c.daySlips !== EXPECT[id].later) throw new Error('build-auvte-fleet: ' + id + ' day slips ' + (c && c.daySlips) + ' != ' + EXPECT[id].later);
    const a = Fx.arrivalOf(r);
    if (!a || a.basis !== 'assign' || a.hours !== EXPECT[id].hours) throw new Error('build-auvte-fleet: ' + id + ' arrival ' + JSON.stringify(a) + ' != ' + EXPECT[id].hours + ' h');
  }
  const down = rows.filter((r) => F.isDown(r)).length;
  if (down !== 7) throw new Error('build-auvte-fleet: ' + down + ' down units, expected 7');
}

function build() {
  const golden = ['g1-b12195-cox-parts-hold.json', 'g2-b13014-accident-dsp-hold.json', 'g3-b62064-impound-dsp-hold.json'].map((f) => load(f).row);
  const rows = golden.concat(SYN.map(_synthRow), load('m9-pm-overdue-missing-without-schedule.json').input.rows.map(_m9Row), PLAIN_IDS.map(_activeRow));
  _check(rows);
  return { scac: 'AUVTE', domicile: 'ROC5', today: TODAY, syncedAt: SYNCED_AT, rows };
}

module.exports = { build, OUT, SYNCED_AT, TODAY };

if (require.main === module) {
  fs.writeFileSync(OUT, JSON.stringify(build(), null, 2) + '\n');
  process.stdout.write('wrote ' + path.relative(ROOT, OUT) + '\n');
  process.exit(0);
}

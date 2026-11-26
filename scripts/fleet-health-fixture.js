'use strict';
/**
 * scripts/fleet-health-fixture.js — dev-only, READ-ONLY builder of the anonymized Fleet Health
 * real-row fixture (design §9, tests/fixtures/fleet-health/real-2026-11-25.json). Not wired into
 * the app.
 *
 * Reads fleet_data.json + fas_roster.json from --data-dir and writes ONLY --out (refused when it
 * lies inside the data dir, like scripts/fleet-health-harness.js).
 *
 * Kept: the down rows of the user's exact roster pairs with the §9 allow-listed fields
 * (repairTimeline: last 8 lines; asistNotes: 3 newest entries; fullConversation dropped). Every
 * other row (up rows and other pairs' down rows, needed for the domicile / SCAC totals) keeps only
 * equipmentId, domicileSite, operator, lifecycleState. Free text goes through the evidence
 * redaction (emails, phones) plus a person-name scrub: roster person names (full name and
 * "Last, F" forms), "Last, F" author tags, and any "Xxxx Yyyy" pair outside the business / place
 * allow-list -> '[name]'. The roster is reduced to a stub: the user's exact pairs plus one other
 * pair under the placeholder 'Other FAS'.
 *
 * Usage (from the worktree root):
 *   node scripts/fleet-health-fixture.js --data-dir <dir> --out <file.json> [--fas "Z Santiago"]
 *        [--today YYYY-MM-DD] [--list-scrubs]
 * --list-scrubs prints every "Xxxx Yyyy" candidate with its count and whether it was kept
 * (allow-listed) or scrubbed, so the allow-list can be reviewed; it writes nothing.
 */
const fs = require('fs');
const path = require('path');

function arg(name, def) { const i = process.argv.indexOf(name); return i > -1 ? (process.argv[i + 1] || def) : def; }
const flag = (name) => process.argv.includes(name);

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = arg('--data-dir', '');
const OUT = arg('--out', '');
const FAS = arg('--fas', 'Z Santiago');
const TODAY = arg('--today', '2026-11-25');
const LIST = flag('--list-scrubs');
if (!DATA_DIR || (!OUT && !LIST)) {
  console.error('usage: node scripts/fleet-health-fixture.js --data-dir <dir> --out <file.json> [--fas NAME] [--today YYYY-MM-DD] [--list-scrubs]');
  process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(TODAY)) { console.error('--today must be YYYY-MM-DD'); process.exit(2); }
if (OUT && path.resolve(OUT).toLowerCase().startsWith(path.resolve(DATA_DIR).toLowerCase())) { console.error('--out must not be inside the data dir'); process.exit(2); }

const EV = require(path.join(ROOT, 'src/dbr/fleet-dbr-evidence'));
const dbr = require(path.join(ROOT, 'src/dbr/fleet-dbr'));
const { offsiteEntries } = require(path.join(ROOT, 'src/utils/offsite-notes-order'));

function readJson(name) { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); }

// §9 allow-list for the user pairs' down rows.
const DOWN_FIELDS = [
  'equipmentId', 'domicileSite', 'operator', 'lifecycleState', 'lifecycleReason', 'vendor', 'savedRepairStatus', 'serviceState',
  'subState', 'issueSummary', 'issueDetails', 'created', 'workDuration', 'partsStatus', 'partsEta', 'estimateStatus',
  'estimatePendingCost', 'repairEtc', 'repairEtcSource', 'vendorDelayReason', 'delayReasonCodes', 'offsiteStage',
  'offsiteStageDetail', 'escalations', 'savedNotes', 'repairTimeline', 'asistNotes', '_factsOn', '_factEtc', '_factPartsWhy',
  '_factEstimateWhy', 'dealerCallAttempts',
];
const UP_FIELDS = ['equipmentId', 'domicileSite', 'operator', 'lifecycleState'];
// Structural code / date fields: emails and phones are redacted, but no name scrub (they hold
// vendor codes and statuses the rules match on).
const CODE_FIELDS = new Set([
  'equipmentId', 'domicileSite', 'operator', 'lifecycleState', 'lifecycleReason', 'vendor', 'savedRepairStatus', 'serviceState',
  'subState', 'created', 'workDuration', 'partsStatus', 'partsEta', 'estimateStatus', 'estimatePendingCost', 'repairEtc',
  'repairEtcSource', 'vendorDelayReason', 'delayReasonCodes', 'offsiteStage', '_factsOn', 'dealerCallAttempts',
]);
// Lone first names found when reviewing the 2026-11-25 text ("spoke with Matt").
const SINGLE_NAMES = ['Matt'];
const TIMELINE_KEEP = 8;
const ASIST_KEEP = 3;

// Two-capitalized-word business / place / equipment phrases that are not people (reviewed with
// --list-scrubs on the 2026-11-25 frozen data). Compared case-sensitively as "Word Word".
const ALLOW_PAIRS = new Set([
  'Travel Centers', 'Great Dane', 'Dane Northeast', 'Traceys Road', 'Tracey Road', 'Uptime Center', 'Kenworth Northeast',
  'Cox Fleet', 'Fleet Services', 'New York', 'York City', 'Relay Garage', 'Work Order', 'Repair Stage', 'Parts Delay',
  'Offsite Shop', 'Shop Repair', 'Parts Ordered', 'Waiting For', 'For Vendor', 'Under Diagnosis', 'Vehicle Arrived',
  'Repair Completed', 'Ready For', 'For Pickup', 'Parts Received', 'Repair In', 'In Progress',
  // businesses / places
  'Gabrielli Truck', 'Transedge Truck', 'Truck Sales', 'American Fleet', 'First Advantage', 'Hexagon Agility', 'Irving St',
  'Bergeys Truck', 'Centers Pennsauk', 'Detroit Assurance', 'Mechanics Plus', 'Pull Autobody', 'Road Ready',
  'Towing Transport', 'Uptake Insights', 'Truck Centers', 'Petro Scranton',
  // status / prose phrases (rules match some of them, e.g. RELEASED_RE "asset released")
  'Current Case', 'Cannot Complete', 'Contract Maintenance', 'Good Afternoon', 'Asset Released', 'Engagement Attached',
  'Services Tracker', 'Communication Date', 'Confirmed Appointment', 'Dash Is', 'Dealer Advised', 'Driver Vehicle',
  'Extended Life', 'First Communication', 'Gate Code', 'Heavy Duty', 'Hood Latch', 'Inspection Report', 'Is Broken',
  'Passenger Side', 'Payments Disputes', 'Per Carrier', 'Service Request', 'This Comment', 'Unit Drive', 'Updated First',
]);
// Single capitalized words that never make a person-name pair (generic shop / repair words,
// vendors, places, months, weekdays). A pair is kept when both words are listed here.
const ALLOW_WORDS = new Set((
  'Cox Amerit Volvo Freightliner Kenworth Peterbilt International Navistar Mack Paccar Daimler Allegiance Ascendance Ascend '
  + 'Velociti Goodyear Mobile Onsite Fleet Fleetnet Services Service Center Centers Travel Petro Love Loves Pilot Flying '
  + 'Truck Trucks Tractor Trailer Unit Units Vehicle Asset Assets Repair Repairs Parts Part Vendor Vendors Dealer Dealers Shop '
  + 'Garage Relay Work Order Orders Estimate Estimates Approval Approved Pending Status Stage Update Updates Diagnosis Diagnostic '
  + 'Diagnostics Inspection Battery Batteries Engine Air System Brake Brakes Tire Tires Wheel Wheels Liftgate Hood Door Doors '
  + 'Mirror Light Lights Check Warning Code Codes Fault Faults Sensor Sensors Module Control Controls Cab Climate Coolant '
  + 'Cooling Radiator Fuel Transmission Axle Steering Suspension Exhaust Filter Oil Leak Turbo Injector Starter Alternator '
  + 'Expected Completion Date Time Note Notes Case Cases Ticket Tow Towing Road Roadside Call Calls Email Phone Team Support '
  + 'Manager Uptime North South East West Northeast Northwest Southeast Southwest Great Dane Road Street Avenue Highway Route '
  + 'County City York Jersey Pennsylvania Rochester Allentown Scranton Buffalo Albany Syracuse Newark Philadelphia Hazleton '
  + 'Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September '
  + 'October November December Jan Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec The This That No Not New Next Per Vendor'
).split(/\s+/).filter(Boolean));

const fleet = readJson('fleet_data.json');
const roster = readJson('fas_roster.json');
const rows = (Array.isArray(fleet.rows) ? fleet.rows : []).filter((r) => r && typeof r === 'object');
const rosterRows = Array.isArray(roster.rows) ? roster.rows : [];

// ── Roster (exact pairs, same normalization as roster-lookup.fasForExact) ──
const _n = (v) => String(v == null ? '' : v).trim().toUpperCase();
const byPair = new Map();
const personNames = new Set();
for (const r of rosterRows) {
  const fas = String(r['FAS Name'] || '').trim();
  for (const k of ['FAS Name', 'Uptime Manager', 'Sr PM']) { const v = String(r[k] || '').trim(); if (v) personNames.add(v); }
  if (!fas) continue;
  const scac = _n(r.SCAC);
  const site = _n(r['Site Code']);
  if (scac && site) byPair.set(scac + '|' + site, fas);
}
const exactFor = (scac, site) => byPair.get(_n(scac) + '|' + _n(site)) || byPair.get(_n(site) + '|' + _n(scac)) || '';

const pairKeys = [...new Set(rows.map(dbr.groupKey))].sort();
const exactByKey = {};
for (const k of pairKeys) { const [d, s] = k.split('|'); exactByKey[k] = exactFor(s, d); }
const userKeys = pairKeys.filter((k) => exactByKey[k] && exactByKey[k].toLowerCase() === FAS.toLowerCase());
const otherKey = pairKeys.find((k) => exactByKey[k] && exactByKey[k].toLowerCase() !== FAS.toLowerCase()) || null;
const isDown = (r) => dbr.isDown(r);
const userDownKeys = userKeys.filter((k) => rows.some((r) => dbr.groupKey(r) === k && isDown(r)));

// ── Scrubbing ───────────────────────────────────────────────────────────────
const _esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const personRes = [];
for (const name of personNames) {
  const toks = name.replace(/[^\p{L}\s'-]+/gu, ' ').split(/\s+/).filter(Boolean);
  if (toks.length < 2) continue;
  const first = toks[0];
  const last = toks[toks.length - 1];
  personRes.push(new RegExp('\\b' + toks.map(_esc).join('\\s+') + '\\b', 'g'));
  personRes.push(new RegExp('\\b' + _esc(last) + ',\\s*' + _esc(first) + '(?:\\.|\\b)', 'g'));
  if (first.length > 1) personRes.push(new RegExp('\\b' + _esc(last) + ',\\s*' + _esc(first[0]) + '\\b(?!\\w)', 'g'));
}
const LAST_FIRST_TAG_RE = /\b[A-Z][a-z]+,\s[A-Z]\b(?![\w'])/g;
const PAIR_RE = /\b[A-Z][a-z]+ [A-Z][a-z]+\b/g;
const candidates = new Map();
function _pairAllowed(p) {
  if (ALLOW_PAIRS.has(p)) return true;
  const [a, b] = p.split(' ');
  return ALLOW_WORDS.has(a) && ALLOW_WORDS.has(b);
}
function scrubText(s) {
  let t = EV.redactEvidence(String(s));
  for (const re of personRes) { re.lastIndex = 0; t = t.replace(re, '[name]'); }
  t = t.replace(LAST_FIRST_TAG_RE, '[name]');
  t = t.replace(PAIR_RE, (p) => {
    const keep = _pairAllowed(p);
    const c = candidates.get(p) || { n: 0, keep };
    c.n += 1;
    candidates.set(p, c);
    return keep ? p : '[name]';
  });
  // Pass 2: a first or last name of a scrubbed pair that also appears on its own ("Thanks, Kim").
  if (nameTokenRe) { nameTokenRe.lastIndex = 0; t = t.replace(nameTokenRe, '[name]'); }
  return t;
}
let nameTokenRe = null;
function redactOnly(v) { return typeof v === 'string' ? EV.redactEvidence(v) : v; }
function scrubDeep(v) {
  if (v == null) return v;
  if (typeof v === 'string') return scrubText(v);
  if (Array.isArray(v)) return v.map(scrubDeep);
  if (typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = scrubDeep(x); return o; }
  return v;
}

// ── Trimming ────────────────────────────────────────────────────────────────
function lastLines(text, n) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-n).join('\n');
}
// asistNotes: the newest ASIST_KEEP dated entries, newest first (the text is newest-first, D1).
function newestEntries(text, n) {
  const s = String(text);
  const entries = offsiteEntries(s).map((e, i) => ({ e, i, body: s.slice(e.start, e.end).replace(/\n+$/, '') }))
    .filter((x) => x.body.trim());
  const dated = entries.filter((x) => x.e.atMs != null).sort((a, b) => (b.e.atMs - a.e.atMs) || (a.i - b.i));
  const pick = (dated.length ? dated : entries).slice(0, n);
  return pick.map((x) => x.body).join('\n');
}

function downRow(r) {
  const o = {};
  for (const f of DOWN_FIELDS) {
    let v = r[f];
    if (v === undefined || v === null || v === '') continue;
    if (f === 'repairTimeline') v = lastLines(v, TIMELINE_KEEP);
    if (f === 'asistNotes') v = newestEntries(v, ASIST_KEEP);
    o[f] = CODE_FIELDS.has(f) ? redactOnly(v) : scrubDeep(JSON.parse(JSON.stringify(v)));
  }
  return o;
}
function upRow(r) {
  const o = {};
  for (const f of UP_FIELDS) if (r[f] !== undefined && r[f] !== null && r[f] !== '') o[f] = redactOnly(r[f]);
  return o;
}

const userDownSet = new Set(userDownKeys);
const build = () => rows.map((r) => (isDown(r) && userDownSet.has(dbr.groupKey(r)) ? downRow(r) : upRow(r)));
// Pass 1 finds the scrubbed name pairs; pass 2 also scrubs their words on their own.
build();
const tokens = new Set(SINGLE_NAMES);
for (const [p, c] of candidates) if (!c.keep) for (const w of p.split(' ')) if (!ALLOW_WORDS.has(w)) tokens.add(w);
if (tokens.size) nameTokenRe = new RegExp('\\b(?:' + [...tokens].map(_esc).join('|') + ')\\b', 'g');
candidates.clear();
const outRows = build();

if (LIST) {
  const list = [...candidates.entries()].sort((a, b) => (a[1].keep - b[1].keep) || (b[1].n - a[1].n) || (a[0] < b[0] ? -1 : 1));
  console.log('scrub candidates ("Xxxx Yyyy" pairs in kept free text):', list.length);
  for (const [p, c] of list) console.log((c.keep ? 'kept     ' : 'SCRUBBED ') + String(c.n).padStart(4) + '  ' + p);
  console.log('user exact pairs with units down:', userDownKeys.join(', '));
  process.exit(0);
}

const rosterExact = {};
for (const k of userKeys) rosterExact[k] = FAS;
if (otherKey) rosterExact[otherKey] = 'Other FAS';
const out = {
  meta: {
    note: 'Anonymized, trimmed Fleet Health fixture built by scripts/fleet-health-fixture.js from read-only frozen data. '
      + 'Emails/phones redacted, person names -> [name], fullConversation dropped, repairTimeline last ' + TIMELINE_KEEP
      + ' lines, asistNotes ' + ASIST_KEEP + ' newest entries; rows outside the user pairs\' down units keep only '
      + UP_FIELDS.join(', ') + '.',
    today: TODAY, fleetSyncedAt: fleet.syncedAt || fleet.scrapedAt || null, fleetRows: outRows.length,
    userName: FAS, userDownPairKeys: userDownKeys,
  },
  roster: { userName: FAS, rosterExact },
  rows: outRows,
};
fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(path.resolve(OUT), JSON.stringify(out, null, 1) + '\n');
console.log('rows', outRows.length, '| user pairs', userKeys.length, '| with units down', userDownKeys.length,
  '| kept down rows', outRows.filter((r) => r.issueSummary !== undefined || r.vendor !== undefined).length,
  '| scrubbed pairs', [...candidates.values()].filter((c) => !c.keep).reduce((n, c) => n + c.n, 0));
console.log('wrote', path.resolve(OUT));

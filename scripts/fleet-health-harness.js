'use strict';
/**
 * scripts/fleet-health-harness.js — READ-ONLY Fleet Health (DBR) harness. Not wired into the app.
 *
 * Loads the app's stored fleet data + today's Fleet Health snapshot/edits read-only, builds the
 * DBR through the real IPC module (src/ipc/fleet-dbr.js: _buildLocal -> buildFleetDbr +
 * applyOverlays with the snapshot's drafts and today's edits), produces the "Copy for SharePoint"
 * TSVs through the renderer logic (fleet-dbr-logic.js) with the panel's default filters, and
 * dumps per-pair / per-cell values plus the raw evidence of every down unit.
 *
 * Usage (from the worktree root):
 *   node scripts/fleet-health-harness.js --out <file.json> [--today YYYY-MM-DD] [--data-dir <dir>]
 *        [--fas "Z Santiago"] [--hide-zero] [--scacs A,B]
 *
 * Read-only guarantees: the store passed to the IPC module keeps every save() in memory only
 * (recorded in meta.blockedSaves); the logger is a no-op (the real one appends to log files);
 * nothing under the data dir is written. Free text in the dump has emails / phone-like runs
 * redacted with the builder's own patterns.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

function arg(name, def) { const i = process.argv.indexOf(name); return i > -1 ? (process.argv[i + 1] || def) : def; }
const flag = (name) => process.argv.includes(name);

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = arg('--data-dir', path.join(process.env.APPDATA || '', 'fleet-ops-app'));
const OUT = arg('--out', '');
const TODAY_ARG = arg('--today', '');
const FAS_ARG = arg('--fas', '');
const HIDE_ZERO = flag('--hide-zero');
const SCACS = (arg('--scacs', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!OUT) { console.error('usage: node scripts/fleet-health-harness.js --out <file.json> [--today YYYY-MM-DD]'); process.exit(2); }
if (TODAY_ARG && !/^\d{4}-\d{2}-\d{2}$/.test(TODAY_ARG)) { console.error('--today must be YYYY-MM-DD'); process.exit(2); }
if (path.resolve(OUT).toLowerCase().startsWith(path.resolve(DATA_DIR).toLowerCase())) { console.error('--out must not be inside the data dir'); process.exit(2); }

// ── read-only store ─────────────────────────────────────────────────────────
const FILES = {
  fleetData: 'fleet_data.json', fleetDbrSnapshot: 'fleet_dbr_snapshot.json', fleetDbrEdits: 'fleet_dbr_edits.json',
  settings: 'settings.json', fasRoster: 'fas_roster.json', emailIntelConfig: 'email_intel_config.json',
  canonicalState: 'canonical_state.json', notesStore: 'fleet_notes.json', emailEvidence: 'email_evidence.json',
};
const _cache = {};
const blockedSaves = [];
const memOverlay = {};
function _read(name) {
  if (name in _cache) return _cache[name];
  const f = FILES[name];
  let v;
  if (f) {
    try { v = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch (_) { v = undefined; }
  }
  _cache[name] = v;
  return v;
}
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const roStore = {
  load(name, def) {
    if (name in memOverlay) return clone(memOverlay[name]);
    const v = _read(name);
    return v === undefined ? def : clone(v);
  },
  save(name, data) { blockedSaves.push(name); memOverlay[name] = clone(data); },
  exists(name) { return _read(name) !== undefined; },
};

function inject(rel, exp) {
  const p = require.resolve(path.join(ROOT, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exp };
}
const noop = () => {};
function fakeLogger() { return { debug: noop, info: noop, warn: noop, error: noop }; }
Object.assign(fakeLogger, { createLogger: fakeLogger, setLogDir: noop, setLevel: noop, setSilent: noop, LEVELS: {} });
inject('src/utils/logger', fakeLogger);
inject('src/store/index.js', roStore);
try { inject('node_modules/electron', { ipcMain: { handle: noop } }); } catch (_) { /* electron not resolvable: _safe never registers here */ }

const dbr = require(path.join(ROOT, 'src/dbr/fleet-dbr'));
const engine = require(path.join(ROOT, 'src/dbr/review-engine'));
const woFacts = require(path.join(ROOT, 'src/repair-intel/wo-facts'));
const ipc = require(path.join(ROOT, 'src/ipc/fleet-dbr'));
const flags = require(path.join(ROOT, 'src/config/perf-flags'));

// ── clock ───────────────────────────────────────────────────────────────────
function _ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
const realNow = new Date();
// --today: same wall-clock time on that local day (so day-scoped edits / drafts follow it).
const NOW = TODAY_ARG
  ? new Date(+TODAY_ARG.slice(0, 4), +TODAY_ARG.slice(5, 7) - 1, +TODAY_ARG.slice(8, 10), realNow.getHours(), realNow.getMinutes(), realNow.getSeconds())
  : realNow;
const TODAY = _ymd(NOW);

// ── redaction ───────────────────────────────────────────────────────────────
// NANP-shaped phone numbers only (the builder's broader pattern also eats ISO dates like 2026-11-25).
const PHONE_RE = /(?<![\d-])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}(?![\d-])/g;
function red(v) {
  if (v == null) return v;
  if (typeof v === 'string') return v.replace(new RegExp(dbr.EMAIL_RE.source, 'g'), '[redacted]').replace(PHONE_RE, '[redacted]');
  if (Array.isArray(v)) return v.map(red);
  if (typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = red(x); return o; }
  return v;
}

const EVIDENCE_FIELDS = [
  'equipmentId', 'domicileSite', 'domicile', 'operator', 'lifecycleState', 'lifecycleReason', 'vendor', 'subVendor', 'dealerName',
  'suppliers', 'serviceState', 'subState', 'savedRepairStatus', 'serviceCategory', 'issueSummary', 'issueDetails', 'created',
  'workDuration', 'delayReasonCodes', 'vendorDelayReason', 'estimatePendingCost', 'estimateStatus', 'estimateSubmittedAmount',
  'estimateApprovedAmount', 'estimateRejectReason', 'escalations', 'salesforceCase', 'offsiteStage', 'offsiteStageDetail',
  'offsiteStageSince', 'repairEtc', 'repairEtcSource', 'partsEta', 'partsStatus', 'etcMissCount', 'etcMissed', 'etcReason',
  'etcSlipCount', 'dealerCallAttempts', 'savedNotes', 'notesUpdatedAt', 'repairTimeline', 'asistNotes', 'asistScrapedAt',
  'fullConversation', 'relaySynced', 'extractedAt', 'canonicalSituation', 'canonicalNextStep', 'canonicalWaitingOn',
  '_factsOn', '_factEtc', '_factPartsWhy', '_factEstimateWhy', 'factConflicts',
];

function etcBySource(row, today) {
  const out = {};
  for (const f of ['canonicalNextStep', 'canonicalSituation', 'savedNotes', 'repairTimeline', 'asistNotes']) {
    const t = row[f];
    if (!t || !String(t).trim()) continue;
    const r = dbr.parseEtc({ [f]: t }, today);
    out[f] = { state: r.state, date: r.date, snippet: red(r.snippet), mentionDates: dbr.etcMentionDates(String(t), today) };
  }
  return out;
}

function recomputedFactEtc(row, today) {
  if (!row._factsOn) return null;
  try {
    const c = clone(row);
    woFacts.refreshRowFacts(c, { enabled: true, aiOutput: true }, today);
    return { factEtc: red(c._factEtc || null), parseEtc: red(dbr.parseEtc(c, today)) };
  } catch (e) { return { error: (e && e.name) || 'Error' }; }
}

function unitEvidence(row, today) {
  const ev = {};
  for (const f of EVIDENCE_FIELDS) if (row[f] !== undefined && row[f] !== '' && row[f] !== null) ev[f] = red(clone(row[f]));
  const daysDown = engine.parseDaysOpen(row);
  const b = dbr.classifyBarriers(row, { today, daysDown });
  const pe = dbr.parseEtc(row, today);
  const counted = dbr.countedEtc(row, pe, today);
  return {
    id: String(row.equipmentId || ''),
    daysDown,
    evidence: ev,
    // The sheet bucket the builder puts this unit in (design §3.2).
    etc: { state: pe.state, date: pe.date, bucket: counted.bucket, bucketReason: counted.reason, undercut: red(counted.undercut) },
    parseEtc: red(pe),
    etcLegacyNoFacts: red(dbr.parseEtc(Object.assign({}, row, { _factsOn: false }), today)),
    etcBySource: etcBySource(row, today),
    recomputedAtBuild: recomputedFactEtc(row, today),
    barrierWhys: red(b),
  };
}

function cellsByHeader(model, row) {
  const o = {};
  for (const c of model.columns) o[c.header] = row.cells[c.id];
  return o;
}

function rowView(model, r) {
  return {
    key: r.key, domicile: r.domicile, scac: r.scac, pair: r.pair,
    domicileStats: r.domicileStats, scacStats: r.scacStats,
    cells: red(cellsByHeader(model, r)), source: r.source, flags: r.flags, draft: r.draft,
    base: red(r.base), fasSource: r.fasSource, rosterFas: r.rosterFas ? '(roster)' : '', mine: !!r.mine,
    units: red(r.units), etcUnits: red(r.etcUnits), etcOverrides: r.etcOverrides, etcDisagreements: r.etcDisagreements,
    disagreements: r.disagreements, unverifiedNames: red(r.unverifiedNames), unboundDates: r.unboundDates,
  };
}

(async () => {
  const L = await import(pathToFileURL(path.join(ROOT, 'renderer/src/js/views/fleet-dbr-logic.js')).href);
  const fleet = roStore.load('fleetData', {}) || {};
  const rows = Array.isArray(fleet.rows) ? fleet.rows.filter((r) => r && typeof r === 'object') : [];
  const snapDisk = roStore.load('fleetDbrSnapshot', null);
  const editsDisk = roStore.load('fleetDbrEdits', {});

  ipc._resetForTests({
    store: roStore,
    now: () => NOW,
    getFleet: () => roStore.load('fleetData', {}),
    loadFlags: () => flags.loadFleetDbr({ load: roStore.load }),
    loadServerFlags: () => ({}),
    userAlias: () => Promise.resolve(''),
  });
  const H = ipc.__test__.handlers;
  const f = flags.loadFleetDbr({ load: roStore.load });

  // 1) What the tab shows on open before any rebuild (stored snapshot + overlays), if it is today's.
  const stored = await H.get(null);
  // 2) What a rebuild shows now (same path as the tab's ↺ Rebuild / Just Me currentModel / DBR DATA pull).
  const built = await H.build(null, {});
  if (!built || !built.ok) { console.error('build failed', built && built.code); process.exit(1); }
  const model = built.model;

  const userName = FAS_ARG || model.fasName || '';
  // "Copy for SharePoint" exactly as the panel does it: scope 'mine' (the user's exact roster pairs
  // with units down; falls back to the visible rows when the scope is unavailable) through the
  // golden-format sheetTsv. tsvVisible keeps the visible-rows scope for comparison.
  const sheetBlock = (rowsToCopy, extra) => Object.assign({
    filters: { hideZero: HIDE_ZERO, scacs: SCACS },
    copyRowKeys: rowsToCopy.map((r) => r.key),
    copyRows: L.sheetTsv(model.columns, rowsToCopy, undefined, { header: false }),
    copyWithHeader: L.sheetTsv(model.columns, rowsToCopy, undefined, { header: true }),
    copyFill: L.sheetTsv(L.fillColumns(model), rowsToCopy, undefined, { header: false }),
  }, extra);
  const scopeInfo = L.copyScopeInfo(model, HIDE_ZERO, SCACS);
  const tsv = sheetBlock(L.copyRows(model, 'mine', HIDE_ZERO, SCACS), { scope: 'mine', scopeOk: scopeInfo.mineOk, scopeNote: scopeInfo.note });
  const tsvVisible = sheetBlock(L.copyRows(model, 'visible', HIDE_ZERO, SCACS), { scope: 'visible' });
  // The user's pairs = the model's exact-roster rows for the user's name (row.mine, §3.12).
  const isUser = (r) => !!r.mine;
  const userPairs = model.rows.filter(isUser);
  const userDownPairs = userPairs.filter((r) => r.pair.down > 0);
  const youRows = model.rows.filter((r) => r.fasSource === 'you');

  const byKey = new Map();
  for (const r of rows) {
    const k = dbr.groupKey(r);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  // Computed cells (no overlays) from the same pure builder call the IPC build made.
  const computed = dbr.buildFleetDbr(rows, { today: TODAY });
  const computedByKey = new Map(computed.rows.map((r) => [r.key, r]));
  const pairs = userDownPairs.map((r) => {
    const down = (byKey.get(r.key) || []).filter((x) => dbr.isDown(x));
    const c = computedByKey.get(r.key);
    const computedCells = {};
    if (c) for (const col of model.columns) computedCells[col.header] = c.cells[col.id];
    const n = (v) => parseInt(String(v == null ? '' : v).split('\n')[0], 10) || 0;
    const etcSum = n(r.cells.etcToday) + n(r.cells.noEtc) + n(r.cells.missedEtc);
    return Object.assign(rowView(model, r), {
      computedCells: red(computedCells),
      etcCheck: { down: r.pair.down, shownSum: etcSum, future: (r.units || []).filter((u) => u.etc && u.etc.state === 'future').map((u) => u.id) },
      evidence: down.map((x) => unitEvidence(x, TODAY)),
    });
  });

  const syncedAt = fleet.syncedAt || fleet.scrapedAt || null;
  const out = {
    meta: {
      generatedAt: realNow.toISOString(), now: NOW.toISOString(), today: TODAY, dataDir: DATA_DIR,
      flags: f, fleetRows: rows.length, fleetSyncedAt: syncedAt,
      fleetAgeMin: syncedAt ? Math.round((NOW.getTime() - Date.parse(syncedAt)) / 60000) : null,
      snapshotOnDisk: snapDisk ? { day: snapDisk.day, builtAt: snapDisk.builtAt, fleetSyncedAt: snapDisk.fleetSyncedAt, drafts: Object.keys(snapDisk.drafts || {}) } : null,
      editsOnDisk: { day: editsDisk && editsDisk.day, fasNameSet: !!(editsDisk && editsDisk.fasName), rows: Object.keys((editsDisk && editsDisk.rows) || {}).length },
      userName, userPairKeys: userPairs.map((r) => r.key), userDownPairKeys: userDownPairs.map((r) => r.key),
      noRosterRowsShowingUserName: youRows.map((r) => r.key + ' ' + r.pair.down + '/' + r.pair.total),
      blockedSaves: blockedSaves.slice(),
      factsOnRows: rows.filter((r) => r._factsOn).length,
      canonicalFieldsOnRows: rows.filter((r) => r.canonicalSituation !== undefined || r.canonicalNextStep !== undefined).length,
    },
    storedModel: stored && stored.ok && stored.model
      ? { builtAt: stored.model.builtAt, fleetSyncedAt: stored.model.fleetSyncedAt, rows: stored.model.rows.filter((r) => userDownPairs.some((u) => u.key === r.key)).map((r) => rowView(stored.model, r)) }
      : null,
    model: {
      day: model.day, builtAt: model.builtAt, fleetSyncedAt: model.fleetSyncedAt, fleetCount: model.fleetCount, downCount: model.downCount,
      fasName: model.fasName ? '(set)' : '', fasNameSource: model.fasNameSource, columns: model.columns,
      allRows: model.rows.map((r) => ({
        key: r.key, down: r.pair.down, total: r.pair.total, fasSource: r.fasSource, isUser: isUser(r),
        draft: r.draft, yn: { vendor1p: r.cells.vendor1pYN, oem: r.cells.oemYN, estimate: r.cells.estimateYN, partner: r.cells.partnerYN, parts: r.cells.partsYN, common: r.cells.commonYN },
        etcToday: r.cells.etcToday, noEtc: r.cells.noEtc, missedEtc: String(r.cells.missedEtc).split('\n')[0],
      })),
    },
    tsv: red(tsv),
    tsvVisible: red(tsvVisible),
    pairs,
  };
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(path.resolve(OUT), JSON.stringify(out, null, 2));
  console.log('today', TODAY, '| fleet rows', rows.length, '| synced', syncedAt, '(' + out.meta.fleetAgeMin + ' min old)');
  console.log('user', userName ? '(set)' : '(none)', '| user pairs', userPairs.length, '| with units down', userDownPairs.map((r) => r.key + ' ' + r.pair.down + '/' + r.pair.total + ' ETC today ' + r.cells.etcToday + ' NO ETC ' + r.cells.noEtc + ' missed ' + String(r.cells.missedEtc).split('\n')[0] + ' [' + r.draft.state + ']').join('; '));
  console.log('rows with no roster match showing the user name:', youRows.length);
  console.log('copy rows (scope mine' + (tsv.scopeOk ? '' : ', unavailable: ' + tsv.scopeNote) + '):', tsv.copyRowKeys.length, '| visible rows:', tsvVisible.copyRowKeys.length, '| blocked saves (memory only):', blockedSaves.join(',') || 'none');
  console.log('wrote', path.resolve(OUT));
})().catch((e) => { console.error('harness failed:', e && e.stack ? e.stack : e); process.exit(1); });

// tests/fleet-dbr-ipc.test.js - fleet-dbr:* IPC surface (src/ipc/fleet-dbr.js): registration,
// flag gates with zero store calls, build/get with day-scoped edits and roster FAS names,
// save-edit / reset-row / set-fas-name validation, draft (ai-off, not-built, unknown-row,
// no-down-units, busy cap, stale-build without AI, success), save-failed, internal, and a
// logger spy that must never see unit text, AI text or FAS names.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
function inject(rel, exp) { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; }
const handlers = {};
inject('electron', { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } });
const logCalls = [];
function fakeLogger() { const rec = (lvl) => (...a) => logCalls.push({ lvl, a }); return { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') }; }
fakeLogger.createLogger = fakeLogger; fakeLogger.setLogDir = () => {}; fakeLogger.setLevel = () => {}; fakeLogger.setSilent = () => {}; fakeLogger.LEVELS = {};
inject('../src/utils/logger', fakeLogger);
// Fake relay: only the default _ask() path (no _o.ask) reaches it (AC13).
const relayCalls = [];
let relayAnswer = async () => '';
inject('../src/orcha/relay', { askWithTimeout: (p, o) => { relayCalls.push({ p, o }); return relayAnswer(p, o); } });
const ipc = require('../src/ipc/fleet-dbr');
const F = require('../src/dbr/fleet-dbr');
const { makeFleetRows, downIdsOf } = require('./fixtures/fleet-dbr/make-rows');
ipc.registerFleetDbrIPC({});

const CHANNELS = ['status', 'get', 'build', 'draft', 'save-edit', 'reset-row', 'set-fas-name'].map((c) => 'fleet-dbr:' + c);
const call = (ch, payload) => handlers['fleet-dbr:' + ch]({ sender: { id: 1 } }, payload);
const OFF = { ok: false, code: 'off' };
const TODAY = '2026-11-10';
const YESTERDAY = '2026-11-09';
const NOW = new Date(2026, 10, 10, 10, 30, 0); // local time -> today = 2026-11-10
const ROC_KEY = 'ROC5|AUVTE';
const SAPB_KEY = 'ABE40|SAPB';
const TUZR_KEY = 'ABE40|TUZR';
const ZERO_KEY = 'ABE40|AZNG';
const SECRET = 'SECRET_UNIT_NOTE_TEXT';
const USER = 'Pat Example';
const ROSTER = 'Roster Person';
const ROC = downIdsOf(makeFleetRows(), 'ROC5', 'AUVTE');

function memStore(init = {}) {
  const data = JSON.parse(JSON.stringify(init));
  const calls = [];
  return {
    data, calls, failSave: false, failLoad: false, failKeys: new Set(),
    load(k, d) {
      calls.push(['load', k]);
      if (this.failLoad || this.failKeys.has(k)) throw new Error('disk ' + SECRET);
      return k in data ? JSON.parse(JSON.stringify(data[k])) : d;
    },
    save(k, v) { calls.push(['save', k]); if (this.failSave) throw new Error('disk full ' + SECRET); data[k] = JSON.parse(JSON.stringify(v)); },
  };
}

// Mocked AI answers in the design §3 contract shape.
const NB = { yn: 'N', details: [] };
const answer = (fasActions) => JSON.stringify({
  barriers: { vendor1p: NB, oem: NB, estimate: NB, partner: NB, parts: NB, common: NB },
  etc: [], fasActions, support: 'None',
});
const OK_ANSWER = answer([{ unit: ROC[0], text: 'No FAS action logged; AI_SECRET call carrier; next: call carrier' }]);
const ROC0_LINE = '• ' + ROC[0] + ': No FAS action logged; AI_SECRET call carrier; next: call carrier';

let store, flags, fleet, ask, fasFor, userAlias, clock;
function freshFleet() {
  return { rows: makeFleetRows({ [ROC[0]]: { savedNotes: SECRET + ' tow order 00176990', vendor: 'CEI' } }), syncedAt: '2026-11-10T10:00:00Z' };
}
function reset(over = {}) {
  store = memStore(over.storeInit || {});
  flags = over.flags || { enabled: true, aiDraft: true };
  fleet = over.fleet || freshFleet();
  ask = over.ask || vi.fn(async () => OK_ANSWER);
  fasFor = vi.fn((scac, dom) => (scac === 'TUZR' && dom === 'ABE40' ? ROSTER : ''));
  userAlias = over.userAlias || vi.fn(() => '');
  clock = { t: 1000000 };
  logCalls.length = 0;
  relayCalls.length = 0;
  const o = {
    store, loadFlags: () => flags, now: () => NOW, getFleet: () => fleet, fasFor,
    userAlias: (...a) => userAlias(...a),
    aliasNow: over.aliasNow || (() => clock.t),
    aliasSleep: over.aliasSleep || (() => new Promise((r) => setTimeout(r, 1))),
  };
  if (!over.realAsk) o.ask = (...a) => ask(...a);
  ipc._resetForTests(o);
}
const flush = () => new Promise((r) => setTimeout(r, 5));
beforeEach(() => reset());
const rowOf = (model, key) => model.rows.find((r) => r.key === key);

describe('registration', () => {
  it('registers exactly the seven fleet-dbr channels', () => {
    expect(Object.keys(handlers).filter((k) => k.startsWith('fleet-dbr:')).sort()).toEqual(CHANNELS.slice().sort());
    expect(Object.keys(ipc.__test__.handlers).sort()).toEqual(['build', 'draft', 'get', 'resetRow', 'saveEdit', 'setFasName', 'status']);
  });
});

describe('flags', () => {
  it('off: every channel except status returns off with zero store calls', async () => {
    reset({ flags: { enabled: false, aiDraft: false } });
    expect(await call('get')).toEqual(OFF);
    expect(await call('build')).toEqual(OFF);
    expect(await call('draft', { key: ROC_KEY })).toEqual(OFF);
    expect(await call('save-edit', { key: ROC_KEY, col: 'fasActions', value: 'x' })).toEqual(OFF);
    expect(await call('reset-row', { key: ROC_KEY })).toEqual(OFF);
    expect(await call('set-fas-name', { name: 'x' })).toEqual(OFF);
    expect(await call('draft', null)).toEqual(OFF); // gate before validation
    expect(await call('status')).toEqual({ ok: true, enabled: false, aiDraft: false });
    expect(store.calls).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
  });
  it('status reports the AI sub-flag', async () => {
    expect(await call('status')).toEqual({ ok: true, enabled: true, aiDraft: true });
    flags = { enabled: true, aiDraft: false };
    expect(await call('status')).toEqual({ ok: true, enabled: true, aiDraft: false });
  });
});

describe('build / get', () => {
  it('get is null before build; build saves the snapshot and returns the 24-column model', async () => {
    expect(await call('get')).toEqual({ ok: true, model: null });
    const r = await call('build');
    expect(r.ok).toBe(true);
    expect(r.saved).toBe(true);
    expect(r.model.rows).toHaveLength(21);
    expect(r.model.columns).toHaveLength(24);
    expect(r.model.fleetSyncedAt).toBe('2026-11-10T10:00:00Z');
    expect(r.model.flags).toEqual({ aiDraft: true });
    const snap = store.data.fleetDbrSnapshot;
    expect(snap.version).toBe(1);
    expect(snap.day).toBe(TODAY);
    expect(snap.rows).toHaveLength(21);
    expect(snap.drafts).toEqual({});
    const g = await call('get');
    expect(g.model.rows.map((x) => x.key)).toEqual(r.model.rows.map((x) => x.key));
  });

  it('a snapshot from yesterday reads as absent', async () => {
    await call('build');
    store.data.fleetDbrSnapshot.day = YESTERDAY;
    expect(await call('get')).toEqual({ ok: true, model: null });
  });

  it('no fleet rows -> no-fleet-data', async () => {
    fleet = { rows: [] };
    expect(await call('build')).toEqual({ ok: false, code: 'no-fleet-data' });
    fleet = null;
    expect(await call('build')).toEqual({ ok: false, code: 'no-fleet-data' });
  });

  it('keeps today\'s drafts across a rebuild and tags them stale when the pair\'s units changed', async () => {
    const b = await call('build');
    const hash = rowOf(b.model, ROC_KEY).unitsHash;
    store.data.fleetDbrSnapshot.drafts = { [ROC_KEY]: { fasActions: '• kept', support: 'None', draftedAt: 'x', unitsHash: hash, dropped: 0 } };
    let m = (await call('build')).model;
    expect(rowOf(m, ROC_KEY).draft.state).toBe('ok');
    expect(rowOf(m, ROC_KEY).cells.fasActions).toBe('• kept');
    expect(rowOf(m, ROC_KEY).source.fasActions).toBe('ai');
    fleet.rows.find((x) => x.equipmentId === ROC[1]).vendor = 'Amerit';
    m = (await call('build')).model;
    expect(rowOf(m, ROC_KEY).draft.state).toBe('stale');
    expect(rowOf(m, ROC_KEY).cells.fasActions).toBe('• kept');
    store.data.fleetDbrSnapshot.day = YESTERDAY;
    m = (await call('build')).model;
    expect(rowOf(m, ROC_KEY).draft.state).toBe('none');
  });

  it('edits from a previous day are not applied; the fasName override still is; roster name wins per row', async () => {
    reset({ storeInit: { fleetDbrEdits: { version: 1, fasName: USER, day: YESTERDAY, rows: { [ROC_KEY]: { fasActions: 'old', noEtc: 'old' } } } } });
    const m = (await call('build')).model;
    for (const r of m.rows) expect(Object.values(r.source)).not.toContain('edit');
    // The computed (composer) FAS Actions, not yesterday's edit.
    expect(rowOf(m, ROC_KEY).cells.fasActions).toMatch(/^Tracking T\d{4}\//);
    expect(m.fasName).toBe(USER);
    expect(m.fasNameSource).toBe('panel');
    expect(rowOf(m, ROC_KEY).cells.fasName).toBe(USER);
    expect(rowOf(m, ROC_KEY).fasSource).toBe('you');
    expect(rowOf(m, TUZR_KEY).cells.fasName).toBe(ROSTER);
    expect(rowOf(m, TUZR_KEY).fasSource).toBe('roster');
    expect(fasFor).toHaveBeenCalledWith('TUZR', 'ABE40');
  });

  it('falls back to the email-intel name, then empty; a throwing roster lookup is treated as no match', async () => {
    reset({ storeInit: { emailIntelConfig: { me: { fasName: 'Mail Name' } } } });
    let m = (await call('build')).model;
    expect(m.fasNameSource).toBe('email-intel');
    expect(rowOf(m, ROC_KEY).cells.fasName).toBe('Mail Name');
    reset();
    fasFor.mockImplementation(() => { throw new Error('roster broken'); });
    m = (await call('build')).model;
    expect(m.fasNameSource).toBe('none');
    expect(rowOf(m, TUZR_KEY).cells.fasName).toBe('');
    expect(rowOf(m, TUZR_KEY).fasSource).toBe('none');
  });

  it('snapshot save failure -> ok with saved:false', async () => {
    store.failSave = true;
    const r = await call('build');
    expect(r.ok).toBe(true);
    expect(r.saved).toBe(false);
  });
});

describe('save-edit / reset-row / set-fas-name', () => {
  it('save-edit validation', async () => {
    expect(await call('save-edit', { key: ROC_KEY, col: 'fasActions', value: 'x' })).toEqual({ ok: false, code: 'not-built' });
    await call('build');
    expect(await call('save-edit', { key: 'NOPE|X', col: 'fasActions', value: 'x' })).toEqual({ ok: false, code: 'unknown-row' });
    expect(await call('save-edit', { key: ROC_KEY, col: 'scacUptime', value: 'x' })).toEqual({ ok: false, code: 'bad-column' });
    expect(await call('save-edit', { key: ROC_KEY, col: 'oemYN', value: 'Y' })).toEqual({ ok: false, code: 'bad-column' });
    expect(await call('save-edit', { key: ROC_KEY, col: 'fasActions', value: 5 })).toEqual({ ok: false, code: 'invalid-value' });
    expect(await call('save-edit', { key: ROC_KEY, col: 'fasActions', value: 'a'.repeat(16001) })).toEqual({ ok: false, code: 'too-long' });
    expect(await call('save-edit', { key: ROC_KEY, col: 'oemDetails', value: 'a'.repeat(16000) })).toEqual({ ok: true }); // MAX_VALUE 16000
    const bad = await call('save-edit', null);
    expect(bad.ok).toBe(false);
    expect(bad.code).not.toBe('internal');
    expect(await call('save-edit', { key: ROC_KEY, col: 'fasActions', value: 'a\r\nb\u0007c\td' })).toEqual({ ok: true });
    expect(store.data.fleetDbrEdits.rows[ROC_KEY].fasActions).toBe('a\nbc\td');
    const m = (await call('get')).model;
    expect(rowOf(m, ROC_KEY).cells.fasActions).toBe('a\nbc\td');
    expect(rowOf(m, ROC_KEY).source.fasActions).toBe('edit');
  });

  it('the first write of a new day resets yesterday\'s rows and keeps fasName', async () => {
    reset({ storeInit: { fleetDbrEdits: { version: 1, fasName: USER, day: YESTERDAY, rows: { [SAPB_KEY]: { noEtc: 'old' } } } } });
    await call('build');
    expect(await call('save-edit', { key: ROC_KEY, col: 'support', value: 'None' })).toEqual({ ok: true });
    expect(store.data.fleetDbrEdits).toEqual({ version: 1, fasName: USER, day: TODAY, rows: { [ROC_KEY]: { support: 'None' } } });
  });

  it('reset-row removes the row\'s edits', async () => {
    await call('build');
    expect(await call('reset-row', { key: ROC_KEY })).toEqual({ ok: true });
    await call('save-edit', { key: ROC_KEY, col: 'support', value: 'x' });
    await call('save-edit', { key: SAPB_KEY, col: 'support', value: 'y' });
    expect(await call('reset-row', { key: ROC_KEY })).toEqual({ ok: true });
    expect(Object.keys(store.data.fleetDbrEdits.rows)).toEqual([SAPB_KEY]);
    expect(await call('reset-row', { key: 'NOPE|X' })).toEqual({ ok: false, code: 'unknown-row' });
    const m = (await call('get')).model;
    expect(rowOf(m, ROC_KEY).source.support).toBe('computed');
  });

  it('set-fas-name trims, validates, persists and clears', async () => {
    expect(await call('set-fas-name', { name: '  ' + USER + '  ' })).toEqual({ ok: true, fasName: USER });
    expect(store.data.fleetDbrEdits.fasName).toBe(USER);
    expect(await call('set-fas-name', { name: 'x'.repeat(121) })).toEqual({ ok: false, code: 'too-long' });
    expect(await call('set-fas-name', { name: 'a\u0001b' })).toEqual({ ok: false, code: 'invalid-name' });
    expect(await call('set-fas-name', { name: 7 })).toEqual({ ok: false, code: 'invalid-name' });
    const m = (await call('build')).model;
    expect(rowOf(m, ROC_KEY).cells.fasName).toBe(USER);
    expect(await call('set-fas-name', { name: '' })).toEqual({ ok: true, fasName: '' });
    expect((await call('get')).model.fasNameSource).toBe('none');
  });

  it('store save failure -> save-failed', async () => {
    await call('build');
    store.failSave = true;
    expect(await call('save-edit', { key: ROC_KEY, col: 'support', value: 'x' })).toEqual({ ok: false, code: 'save-failed' });
    expect(await call('reset-row', { key: ROC_KEY })).toEqual({ ok: false, code: 'save-failed' });
    expect(await call('set-fas-name', { name: USER })).toEqual({ ok: false, code: 'save-failed' });
  });
});

describe('draft', () => {
  it('ai-off when the sub-flag is off (no store, no AI)', async () => {
    flags = { enabled: true, aiDraft: false };
    expect(await call('draft', { key: ROC_KEY })).toEqual({ ok: false, code: 'ai-off' });
    expect(store.calls).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
  });

  it('not-built, unknown-row, no-down-units', async () => {
    expect(await call('draft', { key: ROC_KEY })).toEqual({ ok: false, code: 'not-built' });
    await call('build');
    expect(await call('draft', { key: 'NOPE|X' })).toEqual({ ok: false, code: 'unknown-row' });
    expect(await call('draft', { key: ZERO_KEY })).toEqual({ ok: false, code: 'no-down-units' });
    expect(ask).not.toHaveBeenCalled();
  });

  it('success stores the validated draft with the snapshot hash and returns the model', async () => {
    const b = await call('build');
    const hash = rowOf(b.model, ROC_KEY).unitsHash;
    const r = await call('draft', { key: ROC_KEY });
    expect(r.ok).toBe(true);
    expect(r.key).toBe(ROC_KEY);
    expect(r.fasActions.split('\n')).toContain(ROC0_LINE);
    expect(r.support).toBe('None');
    expect(r.saved).toBe(true);
    expect(typeof r.draftedAt).toBe('string');
    const stored = store.data.fleetDbrSnapshot.drafts[ROC_KEY];
    expect(stored).toMatchObject({ version: 2, unitsHash: hash, dropped: 0, mode: 'single', identity: { alias: false, names: 0 } });
    expect(stored.cells.fasActions).toBe(r.fasActions);
    expect(stored.cells.support).toBe('None');
    expect(Object.keys(stored.cells).sort()).toEqual(F.AI_CELL_IDS.slice().sort());
    expect(stored.evidenceHash).toBe(rowOf(b.model, ROC_KEY).evidenceHash);
    expect(rowOf(r.model, ROC_KEY).source.fasActions).toBe('ai');
    expect(rowOf(r.model, ROC_KEY).source.oemYN).toBe('ai');
    expect(rowOf(r.model, ROC_KEY).draft.state).toBe('ok');
    expect(ask.mock.calls[0][0]).toContain('VERIFIED COUNTS');
    expect(ask.mock.calls[0][0]).toContain('tow order 00176990');
  });

  it('stale-build when fleet data changed since the snapshot; AI is not called', async () => {
    await call('build');
    fleet.rows.find((x) => x.equipmentId === ROC[2]).savedRepairStatus = 'Parts ordered';
    expect(await call('draft', { key: ROC_KEY })).toEqual({ ok: false, code: 'stale-build' });
    expect(ask).not.toHaveBeenCalled();
  });

  it('a third concurrent draft returns busy', async () => {
    const pending = [];
    // The first call of each draft stays pending; the self-review and sheet calls answer at once.
    reset({ ask: vi.fn((p) => (p.includes('REVIEW CHECKLIST') || p.includes('SHEET CONTRACT') ? Promise.resolve(OK_ANSWER) : new Promise((res) => pending.push(res)))) });
    await call('build');
    const p1 = call('draft', { key: ROC_KEY });
    const p2 = call('draft', { key: SAPB_KEY });
    expect(await call('draft', { key: TUZR_KEY })).toEqual({ ok: false, code: 'busy' });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    for (const res of pending) res(answer([]));
    expect((await p1).ok).toBe(true);
    expect((await p2).ok).toBe(true);
    pending.length = 0;
    const p3 = call('draft', { key: TUZR_KEY });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]('not json');
    expect(await p3).toEqual({ ok: false, code: 'ai-invalid' });
  });

  it('AI failures map to codes and save nothing', async () => {
    await call('build');
    ask.mockImplementationOnce(async () => { throw Object.assign(new Error('AI timeout'), { code: 'AI_TIMEOUT' }); });
    expect(await call('draft', { key: ROC_KEY })).toEqual({ ok: false, code: 'ai-timeout' });
    ask.mockImplementationOnce(async () => { throw new Error('relay down'); });
    expect(await call('draft', { key: ROC_KEY })).toEqual({ ok: false, code: 'ai-failed' });
    expect(store.data.fleetDbrSnapshot.drafts).toEqual({});
  });
});

const HARD = F.HARD_CELL_IDS.filter((id) => id !== 'fasName');
const pickCells = (row, ids) => Object.fromEntries(ids.map((id) => [id, row.cells[id]]));
const AI_YES = answer([{ unit: ROC[0], text: 'No FAS action logged; unit at CEI; next: call carrier' }]).replace(
  '"vendor1p":{"yn":"N","details":[]}', '"vendor1p":{"yn":"N","details":[]},"domicileDown":"999","scacUptime":"1%"');
function v2Draft(row, over = {}) {
  return Object.assign({
    version: 2, cells: { oemYN: 'Y', oemDetails: '• AI OEM', fasActions: '• AI FAS', support: 'None', domicileDown: '999' },
    sources: { oemYN: 'ai', oemDetails: 'ai', fasActions: 'ai', support: 'ai' }, flags: { oemDetails: 'review' },
    draftedAt: 'x', unitsHash: row.unitsHash, evidenceHash: row.evidenceHash, identity: { alias: true, names: 0, fasTagged: 0 },
  }, over);
}

describe('draft v2 (FEAT-004)', () => {
  it('AC7: hard cells are never changed through IPC, even when the AI JSON carries hard keys', async () => {
    reset({ ask: vi.fn(async () => AI_YES) });
    const b = await call('build');
    const before = pickCells(rowOf(b.model, ROC_KEY), HARD);
    const r = await call('draft', { key: ROC_KEY });
    expect(r.ok).toBe(true);
    expect(pickCells(rowOf(r.model, ROC_KEY), HARD)).toEqual(before);
    for (const id of F.HARD_CELL_IDS) expect(r.cells).not.toHaveProperty(id);
    const snap = store.data.fleetDbrSnapshot;
    for (const id of F.HARD_CELL_IDS) expect(snap.drafts[ROC_KEY].cells).not.toHaveProperty(id);
    // A tampered stored draft with hard keys is ignored by the overlay whitelist.
    snap.drafts[ROC_KEY].cells.domicileDown = '999';
    snap.drafts[ROC_KEY].cells.scacUptime = '1%';
    const g = await call('get');
    expect(pickCells(rowOf(g.model, ROC_KEY), HARD)).toEqual(before);
  });

  it('AC12: flag OFF -> draft ai-off; get with a stored v2 draft shows computed cells, no AI source, state none', async () => {
    const b = await call('build');
    const row = rowOf(b.model, ROC_KEY);
    store.data.fleetDbrSnapshot.drafts = { [ROC_KEY]: v2Draft(row) };
    flags = { enabled: true, aiDraft: false };
    expect(await call('draft', { key: ROC_KEY })).toEqual({ ok: false, code: 'ai-off' });
    let m = (await call('get')).model;
    let r = rowOf(m, ROC_KEY);
    expect(r.cells).toEqual(row.cells);
    expect(Object.values(r.source)).not.toContain('ai');
    expect(r.draft.state).toBe('none');
    expect(r.flags).toEqual({});
    expect(m.columns).toHaveLength(24);
    expect(m.aiCellIds).toEqual(F.AI_CELL_IDS);
    // Flag back on: the stored draft shows again (kept on disk).
    flags = { enabled: true, aiDraft: true };
    m = (await call('get')).model;
    r = rowOf(m, ROC_KEY);
    expect(r.cells.oemYN).toBe('Y');
    expect(r.source.oemYN).toBe('ai');
    expect(r.cells.domicileDown).toBe(row.cells.domicileDown);
    expect(r.flags).toEqual({ oemDetails: 'review' });
    expect(r.draft.state).toBe('ok');
  });

  it('v1 drafts still overlay fasActions/support only, and not with the flag off', async () => {
    const b = await call('build');
    const row = rowOf(b.model, ROC_KEY);
    store.data.fleetDbrSnapshot.drafts = { [ROC_KEY]: { fasActions: '• v1', support: 'None', oemYN: 'Y', draftedAt: 'x', unitsHash: row.unitsHash, dropped: 0 } };
    let r = rowOf((await call('get')).model, ROC_KEY);
    expect(r.cells.fasActions).toBe('• v1');
    expect(r.cells.oemYN).toBe(row.cells.oemYN);
    expect(r.source.oemYN).toBe('computed');
    expect(r.draft.state).toBe('ok');
    flags = { enabled: true, aiDraft: false };
    r = rowOf((await call('get')).model, ROC_KEY);
    expect(r.cells.fasActions).toBe(row.cells.fasActions);
    expect(r.draft.state).toBe('none');
  });

  it('AC13: the relay call is isolated + preferAki + source fleet_dbr with the per-call timeout', async () => {
    reset({ realAsk: true });
    relayAnswer = async () => OK_ANSWER;
    await call('build');
    const r = await call('draft', { key: ROC_KEY });
    expect(r.ok).toBe(true);
    expect(relayCalls.length).toBeGreaterThan(0);
    for (const c of relayCalls) {
      expect(c.o).toMatchObject({ source: 'fleet_dbr', priority: 'normal', isolated: true, preferAki: true });
      expect(c.o.timeoutMs).toBeGreaterThanOrEqual(125000);
    }
  });

  it('AC15: a changed repairTimeline (same status fields) marks the draft stale by evidence; units change -> units', async () => {
    await call('build');
    expect((await call('draft', { key: ROC_KEY })).ok).toBe(true);
    fleet.rows.find((x) => x.equipmentId === ROC[3]).repairTimeline = '11/10 - dealer: tech on site';
    let r = rowOf((await call('build')).model, ROC_KEY);
    expect(r.draft).toMatchObject({ state: 'stale', staleReason: 'evidence' });
    expect(r.source.fasActions).toBe('ai'); // a stale draft still overlays
    fleet.rows.find((x) => x.equipmentId === ROC[3]).vendor = 'Amerit';
    r = rowOf((await call('build')).model, ROC_KEY);
    expect(r.draft).toMatchObject({ state: 'stale', staleReason: 'units' });
  });

  it('AC22: timeline change between Build and Draft -> stored row units/evidenceHash are fresh, hard cells kept, state ok', async () => {
    const b = await call('build');
    const before = rowOf(b.model, ROC_KEY);
    fleet.rows.find((x) => x.equipmentId === ROC[1]).repairTimeline = '11/10 - dealer: ETC 11/12 brakes';
    const fresh = F.buildFleetDbr(fleet.rows, { today: TODAY }).rows.find((x) => x.key === ROC_KEY);
    expect(fresh.unitsHash).toBe(before.unitsHash);
    expect(fresh.evidenceHash).not.toBe(before.evidenceHash);
    const r = await call('draft', { key: ROC_KEY });
    expect(r.ok).toBe(true);
    const snap = store.data.fleetDbrSnapshot;
    const srow = snap.rows.find((x) => x.key === ROC_KEY);
    expect(snap.drafts[ROC_KEY].evidenceHash).toBe(srow.evidenceHash);
    expect(srow.evidenceHash).toBe(fresh.evidenceHash);
    expect(srow.units).toEqual(fresh.units);
    expect(pickCells(srow, HARD)).toEqual(pickCells(before, HARD));
    expect(srow.cells.etcToday).toBe(fresh.cells.etcToday);
    expect(rowOf(r.model, ROC_KEY).draft.state).toBe('ok');
    fleet.rows.find((x) => x.equipmentId === ROC[1]).repairTimeline = '11/10 - dealer: ETC 11/14 brakes';
    expect(rowOf((await call('build')).model, ROC_KEY).draft.state).toBe('stale');
  });

  it('AC30: the response carries cells, sources, flags, etcUnits and the drill-down lists', async () => {
    await call('build');
    const r = await call('draft', { key: ROC_KEY });
    expect(r.ok).toBe(true);
    for (const k of ['cells', 'sources', 'flags', 'etcUnits', 'etcDisagreements', 'etcOverrides', 'provenance', 'unverifiedNames',
      'unboundDates', 'disagreements', 'coverageFilled', 'dropped', 'rounds', 'reviewSkipped', 'mode', 'draftedAt', 'saved', 'model',
      'fasActions', 'support']) expect(r).toHaveProperty(k);
    expect(Object.keys(r.cells).sort()).toEqual(F.AI_CELL_IDS.slice().sort());
    expect(r.etcUnits).toHaveLength(ROC.length);
    expect(r.sources.fasActions).toBe('ai');
  });

  it('AC35: status/get start the alias fetch; alias-unknown draft goes identity-stale once the alias is known', async () => {
    await call('status');
    expect(userAlias).toHaveBeenCalledTimes(1);
    await flush();
    await call('build');
    const r = await call('draft', { key: ROC_KEY });
    expect(store.data.fleetDbrSnapshot.drafts[ROC_KEY].identity.alias).toBe(false);
    expect(rowOf(r.model, ROC_KEY).draft.state).toBe('ok');
    expect(r.model.fasAliasKnown).toBe(false);
    // 30-min retry window: no new fetch yet.
    await call('get');
    expect(userAlias).toHaveBeenCalledTimes(1);
    clock.t += 31 * 60 * 1000;
    userAlias.mockImplementation(async () => 'patexa');
    await call('get');
    expect(userAlias).toHaveBeenCalledTimes(2);
    await flush();
    const m = (await call('get')).model;
    expect(m.fasAliasKnown).toBe(true);
    expect(rowOf(m, ROC_KEY).draft).toMatchObject({ state: 'stale', staleReason: 'identity' });
    const r2 = await call('draft', { key: ROC_KEY });
    expect(store.data.fleetDbrSnapshot.drafts[ROC_KEY].identity.alias).toBe(true);
    expect(rowOf(r2.model, ROC_KEY).draft.state).toBe('ok');
  });

  it('AC49: _awaitAlias waits for a pending fetch, then exactly 2 of 4 released drafts run and 2 are busy', async () => {
    let release;
    const pendingAlias = new Promise((res) => { release = res; });
    const pending = [];
    reset({
      userAlias: vi.fn(() => pendingAlias),
      ask: vi.fn((p) => (p.includes('REVIEW CHECKLIST') || p.includes('SHEET CONTRACT') ? Promise.resolve(OK_ANSWER) : new Promise((res) => pending.push(res)))),
    });
    await call('build');
    const p1 = call('draft', { key: ROC_KEY });
    const p2 = call('draft', { key: SAPB_KEY });
    await flush();
    const p3 = call('draft', { key: TUZR_KEY });
    const p4 = call('draft', { key: 'MIMY01|MIMY' });
    await flush();
    expect(ask).not.toHaveBeenCalled(); // all four are waiting on the alias
    release('patexa');
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    await flush();
    expect(pending).toHaveLength(2); // exactly 2 reached draftRow
    for (const res of pending) res(OK_ANSWER);
    const all = await Promise.all([p1, p2, p3, p4]);
    expect(all.filter((x) => x.ok === true)).toHaveLength(2);
    expect(all.filter((x) => x.code === 'busy')).toHaveLength(2);
    for (const d of Object.values(store.data.fleetDbrSnapshot.drafts)) expect(d.identity.alias).toBe(true);
  });

  it('AC49: the snapshot is read after the wait; a never-resolving fetch starts the draft after 15 s with no alias', async () => {
    let release;
    reset({ userAlias: vi.fn(() => new Promise((res) => { release = res; })) });
    await call('build');
    const p = call('draft', { key: ROC_KEY });
    await flush();
    store.data.fleetDbrSnapshot.day = YESTERDAY; // changed during the wait
    release('');
    expect(await p).toEqual({ ok: false, code: 'not-built' });

    const t = { v: 0 };
    reset({ userAlias: vi.fn(() => new Promise(() => {})), aliasNow: () => (t.v += 1000), aliasSleep: () => Promise.resolve() });
    await call('build');
    const r = await call('draft', { key: ROC_KEY });
    expect(r.ok).toBe(true);
    expect(store.data.fleetDbrSnapshot.drafts[ROC_KEY].identity.alias).toBe(false);
  });

  it('AC49: source order - _awaitAlias() is the first await in draft, before the busy check; no Promise.race', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../src/ipc/fleet-dbr.js'), 'utf8');
    const body = src.slice(src.indexOf("draft: guarded('draft'"), src.indexOf("saveEdit: guarded('save-edit'"));
    expect(body).toMatch(/_primeAlias\(\);[\s\S]*?await _awaitAlias\(\);[\s\S]*?MAX_IN_FLIGHT/);
    expect(body.indexOf('await ')).toBe(body.indexOf('await _awaitAlias()'));
    const seg = body.slice(body.indexOf('await _awaitAlias()') + 1, body.indexOf('_inFlight += 1'));
    expect(seg).not.toMatch(/\bawait\b/);
    expect(src).not.toMatch(/Promise\.race/);
  });

  it('enrich: notes reach the prompt; a throwing source is skipped (warn, code only) and the draft is still ok', async () => {
    reset({ storeInit: {
      notesStore: { [ROC[0]]: { manualEntries: ['11/09 called CEI re tow ENRICH_NOTE_X'] } },
      emailEvidence: { [ROC[1]]: [{ field: 'eta', value: 'parts ETA 11/14 EMAIL_X', observedAt: '2026-11-09T10:00:00Z', sender: 'a' }] },
    } });
    store.failKeys.add('canonicalState');
    await call('build');
    const r = await call('draft', { key: ROC_KEY });
    expect(r.ok).toBe(true);
    expect(ask.mock.calls[0][0]).toContain('ENRICH_NOTE_X');
    const warn = logCalls.find((c) => c.lvl === 'warn' && c.a[0] === '[fleet-dbr] enrich');
    expect(warn.a[1]).toEqual({ key: ROC_KEY, source: 'canonicalState', code: 'enrich-unavailable' });
    store.failKeys = new Set(['notesStore', 'emailEvidence']);
    expect((await call('draft', { key: ROC_KEY })).ok).toBe(true);
  });

  it('info log carries counts, mode and demand only', async () => {
    await call('build');
    await call('draft', { key: ROC_KEY });
    const info = logCalls.filter((c) => c.lvl === 'info' && c.a[0] === '[fleet-dbr] draft').pop();
    expect(info.a[1]).toMatchObject({ key: ROC_KEY, outcome: 'ok', mode: 'single', alias: false });
    expect(typeof info.a[1].demand).toBe('number');
    expect(info.a[1].calls).toBe(3);   // draft + review + sheet (FEAT-003)
    for (const k of ['maxOutChars', 'maxPromptChars', 'envOver', 'envMissing', 'fasTagged', 'mapRetries']) expect(typeof info.a[1][k]).toBe('number');
    expect(info.a[1].dropReasons).toBeTypeOf('object');
    expect(info.a[1].fieldOver).toBeTypeOf('object');
  });
});

describe('guarded + logging', () => {
  it('unexpected throw -> internal', async () => {
    store.failLoad = true;
    expect(await call('get')).toEqual({ ok: false, code: 'internal' });
    expect(await call('build')).toEqual({ ok: false, code: 'internal' });
  });

  it('logs never carry unit text, AI text or FAS names', async () => {
    reset({ storeInit: { emailIntelConfig: { me: { fasName: USER } } } });
    await call('build');
    await call('set-fas-name', { name: USER });
    await call('draft', { key: ROC_KEY });
    fleet.rows.find((x) => x.equipmentId === ROC[2]).savedRepairStatus = 'Parts ordered';
    await call('draft', { key: ROC_KEY });
    store.failSave = true;
    await call('save-edit', { key: SAPB_KEY, col: 'support', value: SECRET });
    store.failLoad = true;
    await call('get');
    expect(logCalls.length).toBeGreaterThan(0);
    const text = JSON.stringify(logCalls);
    for (const s of [SECRET, 'AI_SECRET', USER, ROSTER, '00176990', 'VERIFIED COUNTS']) expect(text).not.toContain(s);
  });
});

describe('builder parity', () => {
  it('the model rows are the pure builder rows (same keys and computed cells)', async () => {
    const m = (await call('build')).model;
    const built = F.buildFleetDbr(fleet.rows, { today: TODAY });
    expect(m.rows.map((r) => r.key)).toEqual(built.rows.map((r) => r.key));
    expect(rowOf(m, ROC_KEY).cells.partnerYN).toBe('N'); // a CEI vendor is no longer a Partner hit (design §3.6, Q5)
  });
});

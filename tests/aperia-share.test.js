// tests/aperia-share.test.js — src/aperia/share.js onAlert with the real share-pref / share-store /
// share-compose on a temp data dir and stubbed client / geocoder / AI / Slack (no live calls).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installFakeLogger } from './fixtures/zoom/fake-electron.js';
import { VEHICLE_DETAIL, NOW } from './fixtures/aperia/responses.js';

const require = createRequire(import.meta.url);
const logger = installFakeLogger(require);
const paths = require('../src/config/paths');
const P = require('../src/aperia/parsers');
const SC = require('../src/aperia/share-compose');
const pref = require('../src/aperia/share-pref');
const store = require('../src/aperia/share-store');
const share = require('../src/aperia/share');
const fleetScope = require('../src/aperia/fleet-scope');

const ADDRESS = '1 Sentinel Way, Testville, PA 18000';
const AI_TEXT = 'NP6923 Right Steer is at 70 PSI against a 100 PSI target (UNDERINFLATION, CRITICAL). Inflate it to the set point immediately. Near ' + ADDRESS + '.';
const unit = () => P.parseVehicleDetail(JSON.parse(JSON.stringify(VEHICLE_DETAIL)), { now: NOW }).unit;
const alert = (o = {}) => Object.assign({ id: '9001', severity: 'CRITICAL', fleetVehicleId: 'NP6923', state: 'UNDERINFLATION_AND_LEAK', positionName: 'Right Steer', domicile: 'ATL2', vehicleId: '104' }, o);

let tmp; let d; let ctx; let entry;

function setup(o = {}) {
  entry = 'entry' in o ? o.entry : { operator: 'GWOP', channelId: 'C_GW', ownerId: 'U_OWNER', ownerName: 'Owner' };
  d = {
    client: {
      getVehicle: vi.fn(o.getVehicle || (async () => ({ ok: true, unit: unit() }))),
      lookupUnit: vi.fn(async () => ({ ok: true, unit: unit() })),
    },
    geocode: { reverseGeocode: vi.fn(async () => ADDRESS) },
    ask: vi.fn(async () => AI_TEXT),
    resolveOperatorEntry: vi.fn(() => entry),
    slack: {
      openConversation: vi.fn(async () => 'D_OWNER'),
      sendToChannel: vi.fn(o.sendToChannel || (async () => ({ ok: true }))),
    },
    storeMod: { load: vi.fn(() => ({ rows: [] })) },
    timers: [],
  };
  share._setDeps({
    client: d.client,
    geocode: d.geocode,
    compose: Object.assign({}, SC, { compose: (f, a) => SC.compose(f, a, { ask: d.ask }) }),
    resolveOperatorEntry: d.resolveOperatorEntry,
    slack: d.slack,
    storeMod: d.storeMod,
    setTimeout: (fn, ms) => { d.timers.push({ fn, ms }); return { unref() {} }; },
  });
  ctx = { lastData: { rows: [{ equipmentId: 'NP6923', operator: 'GWOP' }, { equipmentId: 'T100', operator: 'GWOP' }] } };
}

const nothingCalled = () => {
  expect(d.client.getVehicle).not.toHaveBeenCalled();
  expect(d.client.lookupUnit).not.toHaveBeenCalled();
  expect(d.geocode.reverseGeocode).not.toHaveBeenCalled();
  expect(d.ask).not.toHaveBeenCalled();
  expect(d.slack.openConversation).not.toHaveBeenCalled();
  expect(d.slack.sendToChannel).not.toHaveBeenCalled();
  expect(store.list()).toEqual([]);
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aperia-share-'));
  paths.setDataDir(tmp);
  logger.clear();
  share._resetForTests();
});
afterEach(() => { share._resetForTests(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('aperia share: toggle ON', () => {
  it('DMs the operator owner once and adds one pending briefing item', async () => {
    pref.save(true);
    setup();
    const r = await share.onAlert(alert(), { ctx });
    expect(r).toEqual({ ok: true, code: 'OK', dm: true, item: true });
    expect(d.client.getVehicle).toHaveBeenCalledWith('104', ctx);
    expect(d.geocode.reverseGeocode).toHaveBeenCalledWith(32.89654, -97.03804);
    expect(d.resolveOperatorEntry).toHaveBeenCalledWith('GWOP');
    expect(d.slack.openConversation).toHaveBeenCalledWith({ id: 'U_OWNER', type: 'user' });
    expect(d.slack.sendToChannel).toHaveBeenCalledTimes(1);
    expect(d.slack.sendToChannel).toHaveBeenCalledWith('D_OWNER', AI_TEXT, null, { unfurl: false });
    const items = store.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ issueId: '9001', unit: 'NP6923', operator: 'GWOP', severity: 'CRITICAL', status: 'pending', text: AI_TEXT });
    const prompt = d.ask.mock.calls[0][0];
    expect(prompt).not.toMatch(/-?\d{1,3}\.\d{2,}\s*,\s*-?\d{1,3}\.\d{2,}/);
    expect(prompt).not.toContain('Right Steer Outer');
    expect(logger.text()).not.toContain('Sentinel');
    expect(logger.text()).not.toContain('32.89');
    expect(logger.lines.some((l) => l.args[0] === '[aperia] share' && l.args[1].op === 'share' && l.args[1].code === 'OK' && l.args[1].dm === true)).toBe(true);
  });

  it('the same alert again -> no second DM; a severity step up -> one more', async () => {
    pref.save(true);
    setup();
    await share.onAlert(alert({ severity: 'MAJOR' }), { ctx });
    expect(await share.onAlert(alert({ severity: 'MAJOR' }), { ctx })).toEqual({ ok: true, skipped: 'already-sent' });
    expect(d.slack.sendToChannel).toHaveBeenCalledTimes(1);
    expect((await share.onAlert(alert({ severity: 'CRITICAL' }), { ctx })).dm).toBe(true);
    expect(d.slack.sendToChannel).toHaveBeenCalledTimes(2);
    expect(await share.onAlert(alert({ severity: 'CRITICAL' }), { ctx })).toMatchObject({ skipped: 'already-sent' });
    expect(d.slack.sendToChannel).toHaveBeenCalledTimes(2);
  });

  it('concurrent calls for one id run once', async () => {
    pref.save(true);
    setup();
    const [a, b] = await Promise.all([share.onAlert(alert(), { ctx }), share.onAlert(alert(), { ctx })]);
    expect(a).toBe(b);
    expect(d.slack.sendToChannel).toHaveBeenCalledTimes(1);
  });

  it('UNDERINFLATION is shared; LEAK and other states never', async () => {
    pref.save(true);
    setup();
    for (const state of ['LEAK', 'HIGH_TEMP', 'OVERINFLATION', '']) {
      expect(await share.onAlert(alert({ id: 'x' + state, state }), { ctx })).toMatchObject({ skipped: 'not-shareable' });
    }
    nothingCalled();
    expect((await share.onAlert(alert({ state: 'UNDERINFLATION' }), { ctx })).dm).toBe(true);
  });

  it('a detail issue type that is not shareable stops the share', async () => {
    pref.save(true);
    const u = unit();
    u.tires.find((t) => t.issue && t.issue.id === '9001').issue.type = 'LEAK';
    setup({ getVehicle: async () => ({ ok: true, unit: u }) });
    expect(await share.onAlert(alert({ state: 'UNDERINFLATION' }), { ctx })).toMatchObject({ skipped: 'not-shareable' });
    expect(d.client.getVehicle).toHaveBeenCalledTimes(1);
    expect(d.ask).not.toHaveBeenCalled();
    expect(d.slack.sendToChannel).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
  });

  it('a unit outside the fleet rows -> nothing; the stored fleetData rows are used when ctx has none', async () => {
    pref.save(true);
    setup();
    expect(await share.onAlert(alert({ fleetVehicleId: 'OTHER1' }), { ctx })).toMatchObject({ skipped: 'out-of-scope' });
    nothingCalled();
    d.storeMod.load.mockReturnValue({ rows: [{ equipmentId: 'np6923', operator: 'GWOP' }] });
    share._setDeps(Object.assign({}, { client: d.client, geocode: d.geocode, compose: Object.assign({}, SC, { compose: (f, a) => SC.compose(f, a, { ask: d.ask }) }), resolveOperatorEntry: d.resolveOperatorEntry, slack: d.slack, storeMod: d.storeMod, fleetScope: { fleetUnitSet: () => fleetScope.fromRows([{ equipmentId: 'NP6923' }]), inScope: fleetScope.inScope } }));
    expect((await share.onAlert(alert(), { ctx: { lastData: { rows: [] } } })).dm).toBe(true);
  });

  it('no ownerId -> no DM but a pending item; not marked sent', async () => {
    pref.save(true);
    setup({ entry: { operator: 'GWOP', channelId: 'C_GW', ownerId: '' } });
    expect(await share.onAlert(alert(), { ctx })).toEqual({ ok: true, code: 'no-owner', dm: false, item: true });
    expect(d.slack.openConversation).not.toHaveBeenCalled();
    expect(d.slack.sendToChannel).not.toHaveBeenCalled();
    expect(store.list()).toHaveLength(1);
    expect(store.shouldSend('9001', 'CRITICAL')).toBe(true);
  });

  it('no carrier channel -> DM only, no item; no operator entry -> nothing sent', async () => {
    pref.save(true);
    setup({ entry: { operator: 'GWOP', channelId: '', ownerId: 'U_OWNER' } });
    expect(await share.onAlert(alert(), { ctx })).toEqual({ ok: true, code: 'OK', dm: true, item: false });
    expect(store.list()).toEqual([]);
    share._resetForTests();
    setup({ entry: null });
    expect(await share.onAlert(alert({ id: '9002' }), { ctx })).toEqual({ ok: true, code: 'no-owner', dm: false, item: false });
    expect(d.slack.sendToChannel).not.toHaveBeenCalled();
  });

  it('a Slack send failure -> APERIA_SHARE_SEND_FAILED and the ledger is not marked', async () => {
    pref.save(true);
    setup({ sendToChannel: async () => { throw new Error('slack down'); } });
    const r = await share.onAlert(alert(), { ctx });
    expect(r).toMatchObject({ ok: false, code: 'APERIA_SHARE_SEND_FAILED', dm: false });
    expect(store.shouldSend('9001', 'CRITICAL')).toBe(true);
    expect(logger.text()).not.toContain('slack down');
  });

  it('a Slack send failure schedules one 60 s retry that DMs the owner once Slack is back', async () => {
    pref.save(true);
    let fail = true;
    setup({ sendToChannel: async () => { if (fail) throw new Error('slack down'); return { ok: true }; } });
    expect(await share.onAlert(alert(), { ctx })).toMatchObject({ code: 'APERIA_SHARE_SEND_FAILED' });
    expect(d.timers).toHaveLength(1);
    expect(d.timers[0].ms).toBe(60e3);
    fail = false;
    await d.timers[0].fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(d.slack.sendToChannel).toHaveBeenCalledTimes(2);
    expect(store.shouldSend('9001', 'CRITICAL')).toBe(false);
    expect(store.list()).toHaveLength(1);                      // one item per issue + severity
    expect(d.timers).toHaveLength(1);
  });

  it('an escalated alert gets its own retry after the lower severity used its one', async () => {
    pref.save(true);
    setup({ getVehicle: async () => ({ ok: false, code: 'APERIA_NETWORK' }) });
    await share.onAlert(alert({ severity: 'MAJOR' }), { ctx });
    await share.onAlert(alert({ severity: 'MAJOR' }), { ctx });
    expect(d.timers).toHaveLength(1);
    await share.onAlert(alert({ severity: 'CRITICAL' }), { ctx });
    expect(d.timers).toHaveLength(2);
  });

  it('a failed vehicle read schedules one retry in 60 s; vehicleId missing uses lookupUnit', async () => {
    pref.save(true);
    setup({ getVehicle: async () => ({ ok: false, code: 'APERIA_NETWORK' }) });
    expect(await share.onAlert(alert(), { ctx })).toEqual({ ok: false, code: 'APERIA_NETWORK' });
    expect(d.timers).toHaveLength(1);
    expect(d.timers[0].ms).toBe(60e3);
    await d.timers[0].fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(d.client.getVehicle).toHaveBeenCalledTimes(2);
    expect(d.timers).toHaveLength(1);                         // the retry never schedules another
    expect(await share.onAlert(alert(), { ctx })).toEqual({ ok: false, code: 'APERIA_NETWORK' });
    expect(d.timers).toHaveLength(1);
    d.client.getVehicle.mockClear();
    expect((await share.onAlert(alert({ id: '9100', vehicleId: '' }), { ctx })).dm).toBe(true);
    expect(d.client.lookupUnit).toHaveBeenCalledWith('NP6923', ctx);
    expect(d.client.getVehicle).not.toHaveBeenCalled();
  });

  it('no GPS or a failed geocode -> no location in the message', async () => {
    pref.save(true);
    const u = unit(); u.gps = null;
    setup({ getVehicle: async () => ({ ok: true, unit: u }) });
    d.ask.mockResolvedValue('');
    await share.onAlert(alert(), { ctx });
    expect(d.geocode.reverseGeocode).not.toHaveBeenCalled();
    expect(d.slack.sendToChannel.mock.calls[0][1]).not.toContain('Location');
  });
});

describe('aperia share: toggle OFF (default)', () => {
  it('no DM, no item, no client / geocode / AI call', async () => {
    setup();
    expect(pref.load().enabled).toBe(false);
    expect(await share.onAlert(alert(), { ctx })).toEqual({ ok: true, skipped: 'off' });
    nothingCalled();
    pref.save(false);
    expect(await share.onAlert(alert(), { ctx })).toEqual({ ok: true, skipped: 'off' });
    nothingCalled();
  });
});

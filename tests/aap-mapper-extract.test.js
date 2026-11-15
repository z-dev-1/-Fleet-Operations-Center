// tests/aap-mapper-extract.test.js — relay-extract mapper-side extraction. FEAT-001 part:
// utils/salesforce-url is a byte-identical move of aap_wo_scraper.buildSalesforceUrl and of
// the inline builder relay.js Phase 3 used. FEAT-003 part: toFleetRow fills (AC11, AC42),
// pmDueFields decomposition (AC13) and the flag-off byte identity against 1eabe04 (AC24).
process.env.TZ = 'America/New_York';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as V from './fixtures/extract/relay-vendors.js';
import * as R39 from './fixtures/extract/relay-39582-volvo.js';
import * as PM from './fixtures/extract/asset-39582-maintenance.js';
const require = createRequire(import.meta.url);
const { buildSalesforceUrl } = require('../src/utils/salesforce-url');
const mapper = require('../src/scrapers/aap_api_mapper');
const woFacts = require('../src/repair-intel/wo-facts');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The 1eabe04 mapper (pure, no requires), loaded from git for the AC24 byte-identity checks.
function loadBaseMapper() {
  try {
    const src = execFileSync('git', ['-C', ROOT, 'show', '1eabe04:src/scrapers/aap_api_mapper.js'], { encoding: 'utf8' });
    const p = path.join(os.tmpdir(), 'relay-extract-base-mapper-' + process.pid + '.js');
    fs.writeFileSync(p, src);
    const m = require(p);
    fs.unlinkSync(p);
    return m;
  } catch (_) { return null; }
}
const BASE = loadBaseMapper();
const NOW = new Date(2026, 10, 11, 12, 0).getTime();   // 2026-11-11 12:00 local
const ON = { extract: { enabled: true }, now: NOW };
const woOf = (id, vendor, extra = {}) => Object.assign({ id: 'svc-' + id, workRequestId: 'wr-' + id, assetDisplayName: id, vendor,
  scheduledDateTime: Date.parse('2026-10-27T12:00:00Z'), vendorWorkOrderIds: [] }, extra);
const FIX = [
  ['39582', 'VOLVO', R39.serviceDetail], ['IND260261', 'TA', V.relayIND260261], ['322355', 'AMERIT', V.relay322355],
  ['321185', 'CEI', V.relay321185], ['B12195', 'COX', V.relayB12195], ['B13014', 'DSP', V.relayB13014],
];
afterEach(() => { vi.useRealTimers(); });

// The 1eabe04 aap_wo_scraper.js:75-90 body, verbatim.
function oldScraperBuilder(caseNumber) {
  if (!caseNumber) return '';
  const sfJson = JSON.stringify({
    componentDef: 'forceSearch:searchPageDesktop',
    attributes: {
      term: caseNumber,
      scopeMap: { type: 'TOP_RESULTS' },
      context: { FILTERS: {}, disableIntentQuery: false, disableSpellCorrection: false },
      groupId: 'DEFAULT'
    },
    state: {}
  });
  return 'https://amazonfreightpartner.lightning.force.com/one/one.app#' +
    Buffer.from(sfJson).toString('base64');
}
// The 1eabe04 relay.js:1102-1104 inline builder, verbatim.
function oldRelayInline(caseNumber) {
  const _sfJson = JSON.stringify({"componentDef":"forceSearch:searchPageDesktop","attributes":{"term":caseNumber,"scopeMap":{"type":"TOP_RESULTS"},"context":{"FILTERS":{},"disableIntentQuery":false,"disableSpellCorrection":false},"groupId":"DEFAULT"},"state":{}});
  return 'https://amazonfreightpartner.lightning.force.com/one/one.app#' + Buffer.from(_sfJson).toString('base64');
}

describe('utils/salesforce-url', () => {
  it('equals the old builders on 3 case numbers', () => {
    for (const cn of ['00034630', '00034983', '00176990']) {
      expect(buildSalesforceUrl(cn)).toBe(oldScraperBuilder(cn));
      expect(buildSalesforceUrl(cn)).toBe(oldRelayInline(cn));
    }
  });
  it('empty case number -> empty string', () => {
    expect(buildSalesforceUrl('')).toBe('');
    expect(buildSalesforceUrl(null)).toBe('');
  });
  it('aap_wo_scraper and relay.js delegate to the shared builder', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const scraper = fs.readFileSync(path.join(root, 'src/scrapers/aap_wo_scraper.js'), 'utf8');
    const relay = fs.readFileSync(path.join(root, 'src/scrapers/relay.js'), 'utf8');
    expect(scraper).toContain("require('../utils/salesforce-url').buildSalesforceUrl(caseNumber)");
    expect(relay).toContain("require('../utils/salesforce-url').buildSalesforceUrl(convSalesforce.caseNumber)");
    expect(relay).not.toContain('forceSearch:searchPageDesktop');
  });
});

describe('toFleetRow flag off (AC24)', () => {
  it('the 1eabe04 mapper is available for the byte-identity checks', () => {
    expect(BASE && typeof BASE.toFleetRow).toBe('function');
  });
  it('3-arg, empty extra and extract disabled are byte-identical to 1eabe04 for every fixture', () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    for (const [id, vendor, sd] of FIX) {
      const wo = woOf(id, vendor);
      const want = JSON.stringify(BASE.toFleetRow(wo, null, sd));
      expect(JSON.stringify(mapper.toFleetRow(wo, null, sd))).toBe(want);
      expect(JSON.stringify(mapper.toFleetRow(wo, null, sd, {}))).toBe(want);
      expect(JSON.stringify(mapper.toFleetRow(wo, null, sd, { extract: { enabled: false }, history: [], now: NOW }))).toBe(want);
    }
  });
  it('no service detail: extract on adds nothing', () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const wo = woOf('X1', 'TA');
    expect(JSON.stringify(mapper.toFleetRow(wo, null, null, ON))).toBe(JSON.stringify(BASE.toFleetRow(wo, null, null)));
  });
  it('pmDueFields legacy (no opts / {} / all:false) is byte-identical to 1eabe04', () => {
    for (const a of [PM.asset39582, PM.assetSynthetic, { maintenanceScheduleStatuses: PM.statuses39582 }, {}, null]) {
      const want = JSON.stringify(BASE.pmDueFields(a));
      expect(JSON.stringify(mapper.pmDueFields(a))).toBe(want);
      expect(JSON.stringify(mapper.pmDueFields(a, {}))).toBe(want);
      expect(JSON.stringify(mapper.pmDueFields(a, { all: false, now: NOW }))).toBe(want);
    }
    expect(Object.keys(mapper.pmDueFields(PM.asset39582))).toEqual(['pmBDue', 'pmXDue', 'dotDue', 'quarterlyLiftDue']);
  });
});

describe('toFleetRow fills (AC11, AC42)', () => {
  it('39582: createdBy, needBy (ISO of the epoch ms), alternativeId, relayFacts v2 + WR', () => {
    const row = mapper.toFleetRow(woOf('39582', 'VOLVO'), null, R39.serviceDetail, ON);
    expect(row.createdBy).toBe('Fleet Ops Center');
    expect(row.needBy).toBe('2026-09-30T18:00:00.000Z');
    expect(row.alternativeId).toBe('amz-9g7bq2kd4m1xz8');
    expect(row.relayFacts.v).toBe(2);
    expect(row.relayFactsWr).toBe('wr-39582');
    expect(row.salesforceCase).toBe('');
    expect(row.salesforceCaseUrl).toBe('');
  });
  it('SF case from the thread; URL equals the shared builder', () => {
    const row = mapper.toFleetRow(woOf('321185', 'CEI'), null, V.relay321185, ON);
    expect(row.salesforceCase).toBe('00034983');
    expect(row.salesforceCaseUrl).toBe(buildSalesforceUrl('00034983'));
  });
  it('a row that already has createdBy keeps it through the merge', () => {
    const fresh = mapper.toFleetRow(woOf('39582', 'VOLVO'), null, R39.serviceDetail, ON);
    const { mergeRelayIntoRows } = require('../src/scrapers/relay');
    const out = mergeRelayIntoRows([Object.assign({}, fresh, { createdBy: 'X' })], {}, {});
    expect(out[0].createdBy).toBe('X');
  });
  it('structured cause/correction (322355 Amerit)', () => {
    const row = mapper.toFleetRow(woOf('322355', 'AMERIT', { vendorWorkOrderIds: ['891-00011598'] }), null, V.relay322355, ON);
    expect(row.cause).toContain('DEAD BATTERIES WOULD NOT START IN YARD');
    expect(row.correction).toContain('BATTERIES NEED TO BE REPLACED');
  });
  it('AC42: IND260261 totalCost is the string $24,804.13; the number lives in the mirror only', () => {
    const row = mapper.toFleetRow(woOf('IND260261', 'TA', { vendorWorkOrderIds: ['TA-77120'] }), null, V.relayIND260261, ON);
    expect(row.totalCost).toBe('$24,804.13');
    expect('estimateApprovedAmount' in row).toBe(false);
    const r = woFacts.refreshRowFacts(Object.assign({}, row), { enabled: true, aiOutput: true }, '2026-11-11');
    expect(r.estimateApprovedAmount).toBe(24804.13);
    expect(r.totalCost).toBe('$24,804.13');
  });
  it('AC42: a DOM-era $1,234.56 totalCost is never overwritten', () => {
    const row = mapper.toFleetRow(woOf('IND260261', 'TA'), null, V.relayIND260261, ON);
    const dom = Object.assign({}, row, { totalCost: '$1,234.56' });
    const r = woFacts.refreshRowFacts(dom, { enabled: true, aiOutput: true }, '2026-11-11');
    expect(r.totalCost).toBe('$1,234.56');
  });
  it('_usd formats like DOM-era rows', () => {
    expect(mapper._usd(24804.13)).toBe('$24,804.13');
    expect(mapper._usd(509.6)).toBe('$509.60');
  });
});

describe('pmDueFields decomposition (AC13)', () => {
  it('6 real probe types: new raw keys, legacy values unchanged, absent types null', () => {
    const pm = mapper.pmDueFields(PM.asset39582, { all: true, now: NOW });
    const legacy = mapper.pmDueFields(PM.asset39582);
    for (const k of ['pmBDue', 'pmXDue', 'dotDue', 'quarterlyLiftDue']) expect(pm[k]).toBe(legacy[k]);
    expect(pm.dotDue).toBe('Nov 1, 2026');
    expect(pm.pmBDue).toBe('Sep 2026');                 // MONTH_AND_YEAR
    expect(pm.pmADue).toBe('Nov 19, 2025');
    expect(pm.washDue).toBe('Jan 31, 2026');
    expect(pm.stateInspDue).toBe('Nov 1, 2026');
    expect(pm.r360Due).toBe('Sep 16, 2026');
    expect(pm.apuDue).toBe(null);
    expect(pm.svrDue).toBe(null);
    expect(pm.semiannualLiftDue).toBe(null);
  });
  it('pmSchedule: 6 entries sorted by nextDueIso, lastCompletedIso, end-of-day overdue days', () => {
    const { pmSchedule } = mapper.pmDueFields(PM.asset39582, { all: true, now: NOW });
    expect(pmSchedule).toHaveLength(6);
    const dues = pmSchedule.map((e) => e.nextDueIso);
    expect(dues).toEqual(dues.slice().sort());
    const by = Object.fromEntries(pmSchedule.map((e) => [e.type, e]));
    expect(by.PM_A.overdueDays).toBe(356);
    expect(by.DOT.overdueDays).toBe(9);
    expect(by.DOT.lastCompletedIso).toBe('2025-11-01');
    expect(by.STATE_DOT.lastCompletedIso).toBe(null);
    expect(by.PM_A).toMatchObject({ label: 'PM A', interval: 12, lastVendor: 'OEM', status: 'Completed', usagePct: 157, displayFormat: 'DATE' });
    expect(by.PM_B.overdueDays).toBeGreaterThan(0);
    // pmOverdue mirror (§10): sorted by days, short labels.
    const r = woFacts.refreshRowFacts({ equipmentId: '39582', pmSchedule }, { enabled: true, aiOutput: true }, '2026-11-11');
    expect(r.pmOverdue.startsWith('PM A 356d; Wash ')).toBe(true);
    expect(r.pmOverdue).toContain('DOT 9d');
  });
  it('a due date later today is not overdue (end-of-day rule)', () => {
    const { pmSchedule } = mapper.pmDueFields({ maintenanceScheduleStatuses: [{ maintenanceType: 'DOT', nextDueDate: '2026-11-11' }] }, { all: true, now: NOW });
    expect(pmSchedule[0].overdueDays).toBe(null);
  });
  it('SYNTHETIC types: apu/svr/semiannual raw keys; unknown FOO_TYPE kept in pmSchedule only; STATE alias', () => {
    const pm = mapper.pmDueFields(PM.assetSynthetic, { all: true, now: NOW });
    expect(pm.apuDue).toBe('Dec 5, 2026');
    expect(pm.svrDue).toBe('Oct 1, 2026');
    expect(pm.semiannualLiftDue).toBe('Nov 20, 2026');
    expect(pm.pmXDue).toBe('Feb 2027');
    const foo = pm.pmSchedule.find((e) => e.type === 'FOO_TYPE');
    expect(foo).toBeTruthy();
    expect(pm.pmSchedule[pm.pmSchedule.length - 1].type).toBe('FOO_TYPE');   // nulls last
    expect(Object.keys(pm).some((k) => /foo/i.test(k))).toBe(false);
    expect(mapper.pmTypeKey('STATE')).toBe('stateInspDue');
    expect(mapper.pmTypeKey('state_dot')).toBe('stateInspDue');
    expect(mapper.pmTypeKey('FOO_TYPE')).toBe(null);
  });
});

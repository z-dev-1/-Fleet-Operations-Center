// FEAT-003: the WR modal submits AVM codes (ELECTRICAL_SYSTEM). AAP stores the
// text it is sent, so the /createRepair + VRE body and the approval summary must
// carry display text (tree displayName, else underscores -> spaces). TOW and
// tire positions pass through unchanged.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { formatAvmLabel } from '../renderer/src/js/util/avm-label.js';
const require = createRequire(import.meta.url);
const aap = require('../src/scrapers/aap_api');
const avmText = require('../src/scrapers/avm-text');
const gate = require('../src/writes/write-gate');

const LL = {
  geoPoint: { latitude: 40.607464, longitude: -75.562252 },
  geoFences: [{ name: '116FCLGQY_ITR' }, { name: 'EOFE01-SHUTTLE' }],
};
const ELEC = [{ area: 'ELECTRICAL', subcategory: 'ELECTRICAL_SYSTEM' }, { area: 'ELECTRICAL', subcategory: 'SOLENOID_ASSEMBLY' }];
const build = (areaPairs, extra = {}) => aap._buildCreateRepairBody(
  { aaid: 'x', domicile: 'EOFE01', locationLatest: LL, areaPairs, ...extra },
  { aaid: 'x', latestLocation: LL }, 'AMERIT', null);

beforeEach(() => avmText._resetForTests());

describe('WR create sends AVM display text, not underscore codes', () => {
  it('(a) no tree remembered: underscores become spaces in /createRepair suggestedItems', () => {
    const items = build(ELEC).suggestedItems;
    expect(items.map((s) => s.level2)).toEqual(['ELECTRICAL SYSTEM', 'SOLENOID ASSEMBLY']);
    expect(items.map((s) => s.level1)).toEqual(['ELECTRICAL', 'ELECTRICAL']);
    expect(JSON.stringify(items)).not.toContain('_');
  });

  it('(b) remembered AVM tree: displayName wins, code-only nodes fall back to spaces', () => {
    avmText.rememberTree('TRACTOR', {
      l1: [{ code: 'ELECTRICAL', displayName: 'Electrical' }],
      l2ByParent: { ELECTRICAL: [{ code: 'ELECTRICAL_SYSTEM', displayName: 'Electrical System' }, { code: 'SOLENOID_ASSEMBLY', displayName: 'SOLENOID_ASSEMBLY' }] },
      l3ByParent: {},
    });
    const items = build(ELEC).suggestedItems;
    expect(items[0]).toEqual({ level1: 'Electrical', level2: 'Electrical System', level3: '' });
    expect(items[1]).toEqual({ level1: 'Electrical', level2: 'SOLENOID ASSEMBLY', level3: '' });
  });

  it('(c) TOW passes through unchanged and stays OFFSITE', () => {
    const body = build([{ area: 'TOW', subcategory: 'MECHANICAL ISSUE' }],
      { offSite: true, locStreet: '1 A St', towDirection: 'return-to-yard', towToStreet: '2 B St', towToCity: 'Easton', towToState: 'PA', towToZip: '18045' });
    expect(body.suggestedItems).toEqual([{ level1: 'TOW', level2: 'MECHANICAL ISSUE', level3: '' }]);
    expect(body.calltype).toBe('OFFSITE');
  });

  it('(d) tire positions keep their code and tireIssue stays true', () => {
    const body = build([{ area: 'TIRES', subcategory: 'DRIVE_LEFT_REAR_OUTSIDE' }]);
    expect(body.suggestedItems[0].level2).toBe('DRIVE_LEFT_REAR_OUTSIDE');
    expect(body.tireIssue).toBe(true);
  });

  it('(e) approval summary Repair items line matches the submitted text', () => {
    const pv = gate.previewOf('createWorkOrder', { title: 'Electrical', vendor: 'Amerit', vendorCode: 'AMERIT', areaPairs: ELEC }, { unit: '321768', origin: 'relay' });
    const line = pv.split('\n').find((l) => l.startsWith('Repair items (L1 / L2 / L3):'));
    expect(line).toBe('Repair items (L1 / L2 / L3): ELECTRICAL / ELECTRICAL SYSTEM; ELECTRICAL / SOLENOID ASSEMBLY');
    expect(line).not.toContain('_');
  });

  it('(f) dropdown labels have no underscores', () => {
    expect(formatAvmLabel('ELECTRICAL_SYSTEM')).toBe('Electrical System');
    expect(formatAvmLabel('SOLENOID_ASSEMBLY')).toBe('Solenoid Assembly');
  });
});

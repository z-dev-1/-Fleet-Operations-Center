// tests/vendor-wo-parity.test.js — the universal Vendor WO value is computed twice:
// renderer id-links.js vendorWoOf (unit detail, drafter modals, Pending Estimates) and
// main relay-action-draft.js collectFacts().vendorWo (drafter text, RO#). Both must agree.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import { vendorWoOf, estimateIdFromUrl } from '../renderer/src/js/views/id-links.js';
const require = createRequire(import.meta.url);
const D = require('../src/writes/relay-action-draft');
const CP = require('../src/scrapers/decisiv_case_page');

const NOW = new Date(2026, 10, 19, 12, 0, 0);
const WR = '0a1b2c3d-1111-2222-3333-444455556666';
const VOLVO = 'https://volvopg.asist.decisiv.net/fleet/estimates/21383146';
const PACCAR = 'https://paccarpg.decisiv.net/fleet/estimates/21467830';

const ROWS = [
  ['Decisiv estimate URL', { workRequestId: WR, offsiteShopEventUrl: VOLVO }, '21383146'],
  ['PACCAR saved URL', { workRequestId: WR, savedOffsiteUrl: PACCAR }, '21467830'],
  ['Decisiv + vendorWorkOrderId', { workRequestId: WR, offsiteShopEventUrl: VOLVO, vendorWorkOrderId: 'VWO-9' }, '21383146'],
  ['vendorWorkOrderId only', { workRequestId: WR, vendorWorkOrderId: 'RO-1' }, 'RO-1'],
  ['URL owned by another WR', { workRequestId: WR, _offsiteWrId: 'other', offsiteShopEventUrl: VOLVO, vendorWorkOrderId: 'RO-2' }, 'RO-2'],
  ['URL owned by this WR', { workRequestId: WR, _offsiteWrId: WR, offsiteShopEventUrl: VOLVO }, '21383146'],
  ['DTNA URL', { workRequestId: WR, offsiteShopEventUrl: 'https://dtna.my.site.com/s/case/500X', vendorWorkOrderId: 'DT-3' }, 'DT-3'],
  ['service request URL', { workRequestId: WR, asistSrUrl: 'https://volvopg.asist.decisiv.net/service_requests/123' }, null],
  ['http (unsafe) estimate URL', { workRequestId: WR, offsiteShopEventUrl: 'http://volvopg.asist.decisiv.net/fleet/estimates/5', vendorWorkOrderId: 'RO-4' }, 'RO-4'],
  ['none', { workRequestId: WR }, null],
];

afterEach(() => D._setDepsForTest({}));

describe('Vendor WO parity (renderer vendorWoOf vs main collectFacts)', () => {
  it('estimate-id rule matches src/scrapers/decisiv_case_page.js', () => {
    for (const u of [VOLVO, PACCAR, 'https://pssmfleet.decisiv.net/fleet/estimates/77', 'https://dtna.my.site.com/x', 'x', '']) {
      expect(estimateIdFromUrl(u), u).toBe(CP.estimateIdFromUrl(u));
    }
  });
  for (const [name, row, want] of ROWS) {
    it(name, () => {
      const mem = { load: (k, d) => d, save() {} };
      D._setDepsForTest({ store: mem, now: () => new Date(NOW) });
      const vw = vendorWoOf(row);
      const main = D.collectFacts(row, { now: NOW }).vendorWo;
      expect(vw ? vw.id : null).toBe(want);
      expect(main).toBe(want);
    });
  }
});

// tests/decisiv-case-page.test.js
//
// Pure parser for the Decisiv case page (GET /fleet/estimates/{id}) and the
// "done offsite / RG WO still open" classifier (src/scrapers/decisiv_case_page.js).
// Fixture = estimate 21383146 (real head + left nav, scrubbed; the truncated
// rest constructed from the documented field map).

process.env.TZ = 'America/New_York';

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const cp = require('../src/scrapers/decisiv_case_page');

const here = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(here, 'fixtures', 'decisiv', 'case-page-21383146.html'), 'utf8');
const URL_21383146 = 'https://volvopg.asist.decisiv.net/fleet/estimates/21383146';
const NOW = '2026-11-20T17:00:00.000Z';

describe('decisiv_case_page: estimate 21383146 field map', () => {
  const rec = cp.parseCasePage(HTML, { estimateId: '21383146', now: NOW, url: URL_21383146 });

  it('money: Total $8,735.97 from the grand-total cell, Parts and Labor', () => {
    expect(rec.total).toBe(8735.97);
    expect(rec.totalSource).toBe('grand');
    expect(rec.partsTotal).toBe(4326.46);
    expect(rec.laborTotal).toBe(3940.0);
  });
  it('Fleet Status = selected option, Repair Status = render tag value', () => {
    expect(rec.fleetStatus).toBe('Approved');
    expect(rec.repairStatus).toBe('Waiting');
  });
  it('ETR and Created timestamps', () => {
    expect(rec.etr).toBe('2026-10-26T16:00:00.000Z');
    expect(rec.etrText).toBe('10/26/2026 12:00 pm EDT');
    expect(rec.createdAt).toBe('2026-10-20T14:35:00.000Z');
    expect(rec.checkedInAt).toBe('2026-10-23T04:00:00.000Z');
    expect(rec.followUpAt).toBe('2026-11-20T16:06:00.000Z');
  });
  it('asset, RO and dealer', () => {
    expect(rec.unit).toBe('39351');
    expect(rec.serial).toBe('LN260640');
    expect(rec.make).toBe('Volvo');
    expect(rec.model).toBe('VNR');
    expect(rec.year).toBe('2020');
    expect(rec.roNumber).toBe('30933SP');
    expect(rec.dealerName).toBe('M & K Truck Centers - Dunmore, PA (Volvo)');
    expect(rec.dealerShortName).toBe('M & K Truck Centers');
    expect(rec.dealerCity).toBe('Dunmore');
    expect(rec.dealerState).toBe('PA');
  });
  it('identity fields and ok', () => {
    expect(rec.estimateId).toBe('21383146');
    expect(rec.host).toBe('volvopg.asist.decisiv.net');
    expect(rec.vendorKind).toBe('volvo');
    expect(rec.ok).toBe(true);
    expect(rec.error).toBe(null);
  });
  it('updatedAt = the 10/29 Estimate-History version date (not Follow-Up or ETR)', () => {
    expect(rec.updatedAt).toBe('2026-10-29T13:12:00.000Z');
  });
  it('updatedAt ignores stamps after now', () => {
    const html = HTML.replace('</body>', '<p>Updated: 12/01/2026 9:00am</p></body>');
    const r = cp.parseCasePage(html, { estimateId: '21383146', now: NOW });
    expect(r.updatedAt).toBe('2026-10-29T13:12:00.000Z');
    const r2 = cp.parseCasePage(html, { estimateId: '21383146', now: '2026-12-02T00:00:00.000Z' });
    expect(r2.updatedAt).toBe('2026-12-01T14:00:00.000Z');
  });
});

describe('decisiv_case_page: variants', () => {
  it('no grand-total cell -> parts + labor sum', () => {
    const html = HTML.replace(/<tr class='grand-total'>[\s\S]*?<\/tr>/, '');
    const r = cp.parseCasePage(html, { estimateId: '21383146', now: NOW });
    expect(r.total).toBe(8266.46);
    expect(r.totalSource).toBe('sum');
  });
  it('version data total when no grand-total cell', () => {
    const html = HTML.replace(/<tr class='grand-total'>[\s\S]*?<\/tr>/, '')
      .replace('</body>', '<div ng-init=\'vm.init({&quot;versions&quot;:[{&quot;version&quot;:1,&quot;total&quot;:&quot;8000.00&quot;},{&quot;version&quot;:2,&quot;total&quot;:&quot;8735.97&quot;,&quot;parts_total&quot;:&quot;4326.46&quot;,&quot;labor_total&quot;:&quot;3940.00&quot;}]})\'></div></body>');
    const r = cp.parseCasePage(html, { estimateId: '21383146', now: NOW });
    expect(r.total).toBe(8735.97);
    expect(r.totalSource).toBe('version');
  });
  it("text fallback: 'Parts Total' / 'Labor Total' labels are parts / labor, never the grand total", () => {
    const body = '<div class="est"><span>Parts Total: $4,326.46</span> <span>Labor Total: $3,940.00</span></div>';
    const html = '<html><body>' + body + '</body></html>';
    const r = cp.parseCasePage(html, { estimateId: '21383146', now: NOW });
    expect(r.partsTotal).toBe(4326.46);
    expect(r.laborTotal).toBe(3940.0);
    expect(r.total).toBe(8266.46);
    expect(r.totalSource).toBe('sum');
    const withGrand = cp.parseCasePage('<html><body>' + body + ' <span>Total: $8,735.97</span></body></html>', { estimateId: '21383146', now: NOW });
    expect(withGrand.total).toBe(8735.97);
    expect(withGrand.totalSource).toBe('grand');
  });
  it('repairStatus inside an entity-encoded attribute', () => {
    const html = HTML.replace('<script>renderEstimateRepairStatusTag({repairStatus:"Waiting"});</script>',
      '<div ng-init=\'renderEstimateRepairStatusTag({&quot;repairStatus&quot;:&quot;Complete (here)&quot;})\'></div>');
    const r = cp.parseCasePage(html, { estimateId: '21383146', now: NOW });
    expect(r.repairStatus).toBe('Complete (here)');
  });
  it('login page -> every scraped field null', () => {
    const login = '<!DOCTYPE html><html><head><title>Sign in</title></head><body><form action="/users/sign_in" method="post"><input name="user[email]"><input type="password"></form></body></html>';
    const r = cp.parseCasePage(login, { estimateId: '21383146', now: NOW });
    for (const k of ['fleetStatus', 'repairStatus', 'total', 'partsTotal', 'laborTotal', 'totalSource', 'etr', 'etrText', 'createdAt',
      'checkedInAt', 'followUpAt', 'updatedAt', 'roNumber', 'dealerName', 'dealerShortName', 'dealerCity', 'dealerState', 'unit', 'serial', 'make', 'model', 'year']) {
      expect(r[k], k).toBe(null);
    }
    expect(r.ok).toBe(false);
  });
  it('never throws on junk input', () => {
    expect(() => cp.parseCasePage(null)).not.toThrow();
    expect(() => cp.parseCasePage(undefined, {})).not.toThrow();
    expect(cp.parseCasePage('', {}).total).toBe(null);
  });
});

describe('decisiv_case_page: URL helpers', () => {
  it('estimateIdFromUrl: Volvo + PACCAR hosts only, numeric ids only', () => {
    expect(cp.estimateIdFromUrl(URL_21383146)).toBe('21383146');
    expect(cp.estimateIdFromUrl('https://pssmfleet.decisiv.net/fleet/estimates/21467830')).toBe('21467830');
    expect(cp.estimateIdFromUrl('https://paccarpg.decisiv.net/fleet/estimates/21467830?tab=notes')).toBe('21467830');
    expect(cp.estimateIdFromUrl('https://dtna.my.site.com/fleet/estimates/123')).toBe('');
    expect(cp.estimateIdFromUrl('https://volvopg.asist.decisiv.net/service_requests/123')).toBe('');
    expect(cp.estimateIdFromUrl('https://volvopg.asist.decisiv.net/fleet/estimates/abc')).toBe('');
    expect(cp.estimateIdFromUrl('')).toBe('');
  });
  it('vendorKindOfUrl', () => {
    expect(cp.vendorKindOfUrl(URL_21383146)).toBe('volvo');
    expect(cp.vendorKindOfUrl('https://pssmfleet.decisiv.net/fleet/estimates/1')).toBe('paccar');
    expect(cp.vendorKindOfUrl('https://paccarpg.decisiv.net/fleet/estimates/1')).toBe('paccar');
    expect(cp.vendorKindOfUrl('https://dtna.my.site.com/x')).toBe('');
    expect(cp.vendorKindOfUrl('')).toBe('');
  });
});

describe('decisiv_case_page: mergeCaseStatus', () => {
  it('copies stage/status/since and raises updatedAt from history', () => {
    const rec = cp.parseCasePage(HTML, { estimateId: '21383146', now: NOW });
    const m = cp.mergeCaseStatus(rec, {
      ok: true, stage: 'repair', status: 'Waiting', since: '2026-11-04T15:00:00Z',
      history: [{ stage: 'approval', status: 'Approved', at: '2026-10-30T12:00:00Z' }, { stage: 'repair', status: 'Waiting', at: '2026-11-04T15:00:00Z' }],
    }, { now: NOW });
    expect(m.stage).toBe('repair');
    expect(m.stageStatus).toBe('Waiting');
    expect(m.stageSince).toBe('2026-11-04T15:00:00Z');
    expect(m.updatedAt).toBe('2026-11-04T15:00:00.000Z');
    expect(rec.stage).toBe(null); // input not mutated
  });
  it('ignores a failed summary and future history', () => {
    const rec = { updatedAt: '2026-10-29T13:12:00.000Z' };
    expect(cp.mergeCaseStatus(rec, { ok: false }, { now: NOW })).toEqual(rec);
    const m = cp.mergeCaseStatus(rec, { ok: true, stage: 'repair', status: 'Working', since: '', history: [{ at: '2027-01-01T00:00:00Z' }] }, { now: NOW });
    expect(m.updatedAt).toBe('2026-10-29T13:12:00.000Z');
  });
});

describe('decisiv_case_page: status-mismatch classifier (requirement 1)', () => {
  const flag = (offsite, rgOpen) => cp.classifyStatusMismatch({ offsite, rgOpen });
  it('Repair complete / ready + RG open -> flagged', () => {
    expect(flag({ repairStatus: 'Complete (here)', stage: 'ready' }, true)).toEqual({ offsiteDone: true, statusMismatch: true });
    expect(flag({ stage: 'ready', stageStatus: 'Yard (Waiting)' }, true).statusMismatch).toBe(true);
    expect(flag({ repairStatus: 'Repair Complete' }, true).statusMismatch).toBe(true);
    expect(flag({ repairStatus: 'Ready for Pickup' }, true).statusMismatch).toBe(true);
  });
  it('Approved but Waiting -> NOT flagged (Fleet Status is not an input)', () => {
    expect(flag({ fleetStatus: 'Approved', repairStatus: 'Waiting', stage: 'repair' }, true)).toEqual({ offsiteDone: false, statusMismatch: false });
  });
  it('offsite not done + RG open -> NOT flagged', () => {
    for (const s of ['Working', 'Hold (parts)', 'Road Test']) {
      expect(flag({ repairStatus: s, stage: 'repair', stageStatus: s }, true).statusMismatch, s).toBe(false);
    }
  });
  it('done offsite but RG not open -> NOT flagged', () => {
    expect(flag({ repairStatus: 'Complete', stage: 'ready' }, false)).toEqual({ offsiteDone: true, statusMismatch: false });
    expect(flag({ repairStatus: 'Complete', stage: 'ready' }, undefined).statusMismatch).toBe(false);
  });
  it('Yard (Waiting) outside the ready stage is not done', () => {
    expect(cp.isOffsiteRepairDone({ stage: 'approval', stageStatus: 'Yard (Waiting)' })).toBe(false);
    expect(flag(null, true)).toEqual({ offsiteDone: false, statusMismatch: false });
  });
});

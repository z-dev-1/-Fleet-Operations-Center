// tests/repair-intel-dealer-link.test.js — dealer link + 3C evidence helpers,
// fed real service-detail shapes through the REAL aap_api_mapper.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const mapper = require('../src/scrapers/aap_api_mapper');
const dl = require('../src/repair-intel/dealer-link');

const EST = 'https://pssmfleet.decisiv.net/fleet/estimates/E100';
const EST_NEW = 'https://volvopg.asist.decisiv.net/fleet/estimates/E200';
const SR = 'https://paccarpg.decisiv.net/service_requests/S300';
const DTNA = 'https://dtna.my.site.com/Servicetracker/s/case/C400';

function detail(comments, extra) {
  return Object.assign({ workRequest: { damageDescription: 'brake light out', comments } }, extra || {});
}
const c = (ts, text, more) => Object.assign({ timestamp: ts, text, createdBy: 'Jane Tech', author: 'Jane Tech' }, more || {});

describe('isAllowedDealerUrl', () => {
  it('accepts estimate / service request / DTNA case', () => {
    expect(dl.isAllowedDealerUrl(EST)).toBe(true);
    expect(dl.isAllowedDealerUrl(EST_NEW)).toBe(true);
    expect(dl.isAllowedDealerUrl(SR)).toBe(true);
    expect(dl.isAllowedDealerUrl(DTNA)).toBe(true);
  });
  it('rejects http, javascript, quotes, other hosts/paths', () => {
    expect(dl.isAllowedDealerUrl('http://pssmfleet.decisiv.net/fleet/estimates/E1')).toBe(false);
    expect(dl.isAllowedDealerUrl('javascript:alert(1)')).toBe(false);
    expect(dl.isAllowedDealerUrl(EST + '"onload="x')).toBe(false);
    expect(dl.isAllowedDealerUrl('https://pssmfleet.decisiv.net/other/E1')).toBe(false);
    expect(dl.isAllowedDealerUrl('https://evil.example.com/fleet/estimates/E1')).toBe(false);
    expect(dl.isAllowedDealerUrl('https://aap-na.corp.amazon.com/v2/offsite-events/1')).toBe(false);
    expect(dl.isAllowedDealerUrl('')).toBe(false);
    expect(dl.isAllowedDealerUrl(null)).toBe(false);
  });
});

describe('dealerFromDetail (real mapper)', () => {
  it('estimate beats service request beats DTNA', () => {
    const d = detail([c('2026-10-01T00:00:00Z', 'case ' + DTNA), c('2026-10-02T00:00:00Z', 'sr ' + SR), c('2026-10-01T12:00:00Z', 'est ' + EST)]);
    expect(dl.dealerFromDetail(d, mapper)).toEqual({ url: EST, source: 'estimate', label: 'Fleet Estimate' });
    const d2 = detail([c('2026-10-01T00:00:00Z', 'case ' + DTNA), c('2026-10-02T00:00:00Z', 'sr ' + SR)]);
    expect(dl.dealerFromDetail(d2, mapper)).toEqual({ url: SR, source: 'service_request', label: 'Service Request' });
    const d3 = detail([c('2026-10-01T00:00:00Z', 'case ' + DTNA)]);
    expect(dl.dealerFromDetail(d3, mapper)).toEqual({ url: DTNA, source: 'dtna', label: 'DTNA Case' });
  });
  it('newest wins', () => {
    const d = detail([c('2026-10-05T00:00:00Z', 'new ' + EST_NEW), c('2026-10-01T00:00:00Z', 'old ' + EST)]);
    expect(dl.dealerFromDetail(d, mapper).url).toBe(EST_NEW);
  });
  it('http estimate rejected', () => {
    const d = detail([c('2026-10-01T00:00:00Z', 'http://pssmfleet.decisiv.net/fleet/estimates/E9')]);
    expect(dl.dealerFromDetail(d, mapper)).toBeNull();
  });
  it('no comments / no detail → null', () => {
    expect(dl.dealerFromDetail(detail([]), mapper)).toBeNull();
    expect(dl.dealerFromDetail(null, mapper)).toBeNull();
    expect(dl.dealerFromDetail(detail([c('2026-10-01T00:00:00Z', 'no link here')]), mapper)).toBeNull();
  });
});

describe('ownership + unit row', () => {
  const stamped = { _offsiteWrId: 'W1', workRequestId: 'W2', offsiteShopEventUrl: EST, asistLabel: 'Fleet Estimate', asistNotes: 'dealer says pads' };
  const unstamped = { workRequestId: 'W2', savedOffsiteUrl: SR, asistNotes: 'x'.repeat(5000) };
  it('ownsOffsite: stamped uses _offsiteWrId, unstamped uses workRequestId', () => {
    expect(dl.ownsOffsite(stamped, 'W1')).toBe(true);
    expect(dl.ownsOffsite(stamped, 'W2')).toBe(false);
    expect(dl.ownsOffsite(unstamped, 'W2')).toBe(true);
    expect(dl.ownsOffsite(unstamped, 'W1')).toBe(false);
    expect(dl.ownsOffsite(unstamped, '')).toBe(false);
    expect(dl.ownsOffsite(null, 'W1')).toBe(false);
  });
  it('dealerFromUnitRow', () => {
    expect(dl.dealerFromUnitRow(stamped, 'W1')).toEqual({ url: EST, source: 'unit_row', label: 'Fleet Estimate' });
    expect(dl.dealerFromUnitRow(stamped, 'W2')).toBeNull();
    expect(dl.dealerFromUnitRow(unstamped, 'W2')).toEqual({ url: SR, source: 'unit_row', label: 'Dealer' });
  });
  it('unit row with only an AAP URL → null', () => {
    expect(dl.dealerFromUnitRow({ workRequestId: 'W1', offsiteShopEventUrl: 'https://aap-na.corp.amazon.com/v2/offsite-events/1' }, 'W1')).toBeNull();
  });
  it('offsiteNotesFor: owned only, capped at 4000', () => {
    expect(dl.offsiteNotesFor(stamped, 'W1')).toBe('dealer says pads');
    expect(dl.offsiteNotesFor(stamped, 'W2')).toBe('');
    expect(dl.offsiteNotesFor(unstamped, 'W2').length).toBe(4000);
  });
});

describe('evidenceFromDetail', () => {
  it('shape, cause/correction from workOrders, no author text', () => {
    const d = detail([c('2026-10-01T00:00:00Z', 'found bad bulb'), c('2026-10-02T00:00:00Z', 'replaced bulb')],
      { workOrders: [{ cause: 'Bulb burned out', correction: 'Replaced bulb', createdBy: 'Jane Tech' }, { cause: 'Wire chafed', correction: '' }] });
    const ev = dl.evidenceFromDetail(d, mapper);
    expect(ev.v).toBe(1);
    expect(ev.complaint).toBe('brake light out');
    expect(ev.cause).toBe('Bulb burned out; Wire chafed');
    expect(ev.correction).toBe('Replaced bulb');
    expect(ev.comments).toEqual([
      { at: Date.parse('2026-10-01T00:00:00Z'), text: 'found bad bulb' },
      { at: Date.parse('2026-10-02T00:00:00Z'), text: 'replaced bulb' },
    ]);
    expect(ev.commentCount).toBe(2);
    expect(ev.lastCommentAt).toBe(Date.parse('2026-10-02T00:00:00Z'));
    expect(JSON.stringify(ev)).not.toContain('Jane');
  });
  it('title fallback for complaint', () => {
    const ev = dl.evidenceFromDetail({ workRequest: { title: 'PM due', comments: [] } }, mapper);
    expect(ev.complaint).toBe('PM due');
    expect(ev.comments).toEqual([]);
    expect(ev.lastCommentAt).toBeNull();
  });
  it('caps: newest 30 comments, 600 chars each, 8000 total, oldest-first', () => {
    const comments = [];
    for (let i = 0; i < 40; i++) comments.push(c(new Date(Date.UTC(2026, 9, 1, i)).toISOString(), 'c' + String(i).padStart(2, '0') + ' ' + 'z'.repeat(900)));
    const ev = dl.evidenceFromDetail(detail(comments), mapper);
    expect(ev.commentCount).toBe(40);
    expect(ev.comments.length).toBeLessThanOrEqual(30);
    for (const k of ev.comments) expect(k.text.length).toBeLessThanOrEqual(600);
    const total = ev.complaint.length + ev.cause.length + ev.correction.length + ev.comments.reduce((s, k) => s + k.text.length, 0);
    expect(total).toBeLessThanOrEqual(8000);
    // newest kept, oldest-first order
    expect(ev.comments[ev.comments.length - 1].text.startsWith('c39')).toBe(true);
    for (let i = 1; i < ev.comments.length; i++) expect(ev.comments[i].at).toBeGreaterThan(ev.comments[i - 1].at);
    expect(ev.comments.some((k) => k.text.startsWith('c09'))).toBe(false);
  });
  it('null detail → null', () => {
    expect(dl.evidenceFromDetail(null, mapper)).toBeNull();
  });
});

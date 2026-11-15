// tests/wo-extract-relay.test.js — relay-extract §3.3 / §4 on Relay serviceaggregates:
// AC1 (part/order trap), AC3 (case-id shapes), AC7 (cause/correction lines), AC9 (Relay
// side), AC10 (Relay salesforce), AC34 (cross-block trap helper), AC36 (call attempts),
// author classification, timestamps, entity decode, history, bridge PIN / lat-long,
// template blanks, the _fact snippet invariant, caps.
process.env.TZ = 'America/New_York';
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import * as F39582 from './fixtures/extract/relay-39582-volvo.js';
import * as V from './fixtures/extract/relay-vendors.js';
import * as P from './fixtures/extract/b62281-paccar.js';
import * as DT from './fixtures/extract/dtna-122269.js';
const require = createRequire(import.meta.url);
const X = require('../src/repair-intel/wo-extract');

const NOW = Date.parse('2026-11-11T15:00:00Z');
const relay = (sd, o = {}) => X.extractRelay(sd, Object.assign({ now: NOW }, o));
const kinds = (b, k) => b.facts.filter((f) => f.kind === k);
const vals = (b, k) => kinds(b, k).map((f) => f.value);
const wrOf = (comments, extra = {}) => ({ id: 'svc-x', workOrders: [], workRequest: Object.assign({ id: 'wr-x', comments }, extra) });
const cm = (text, createdBy = 'fasuser1', timestamp = '2026-11-05T15:00:00Z') => ({ timestamp, createdBy, text });

describe('block shape', () => {
  it('v2 block with wr fields, events per comment, counts', () => {
    const b = relay(F39582.serviceDetail, { vendor: 'VOLVO' });
    expect(b.v).toBe(2);
    expect(b.wr).toBe('wr-39582');
    expect(b.wrCreatedAt).toBe('2026-09-23T18:04:00.000Z');
    expect(b.wrCreatedBy).toBe('Fleet Ops Center');
    expect(b.wrNeedBy).toBe('2026-09-30T18:00:00.000Z');
    expect(b.wrAltId).toBe('amz-9g7bq2kd4m1xz8');
    expect(b.events).toHaveLength(F39582.comments.length);
    expect(b.counts).toMatchObject({ comments: 20, rejected: 0, truncated: 0 });
    expect(b.partial).toBe(false);
    expect(JSON.stringify(b).length).toBeLessThanOrEqual(X.CAPS.relayBlockBytes);
    for (const f of b.facts) {
      expect(f.snippet.length).toBeLessThanOrEqual(140);
      expect(X.KINDS).toContain(f.kind);
      expect(X.SOURCES).toContain(f.source);
      expect(X.SIDES).toContain(f.side);
      expect(f.id).toMatch(/^f_[0-9a-f]{8}$/);
    }
  });
  it('events are sorted ascending (ISO + nanosecond timestamps)', () => {
    const b = relay(F39582.serviceDetail);
    const ats = b.events.map((e) => e.at);
    expect(ats).toEqual(ats.slice().sort());
    expect(ats).toContain('2026-09-26T15:00:00.204Z');
  });
  it('the alternateUniqueId is an altId fact, never a tow ref', () => {
    const b = relay(wrOf([cm('Ref amz-9g7bq2kd4m1xz8 and FN tow to dealer amz-htkt2ed6g9ay7b')], { alternateUniqueId: 'amz-9g7bq2kd4m1xz8' }));
    expect([...new Set(vals(b, 'altId'))]).toEqual(['amz-9g7bq2kd4m1xz8']);
    expect(kinds(b, 'altId').map((f) => f.via || 'text')).toEqual(['structured', 'text']);
    expect(vals(b, 'tow')).toEqual(['amz-htkt2ed6g9ay7b']);
    expect(kinds(b, 'tow')[0].towRequested).toBe(true);
  });
});

describe('author classification', () => {
  it('first match wins', () => {
    expect(X.classifyRelayAuthor('RelayGarage')).toEqual({ source: 'relay', side: 'system' });
    expect(X.classifyRelayAuthor('Fleet Ops Center')).toEqual({ source: 'relay', side: 'amazon' });
    expect(X.classifyRelayAuthor('Amerit')).toEqual({ source: 'relaygarage/vendor', side: 'vendor' });
    expect(X.classifyRelayAuthor('Acme Repair', { vendor: 'Acme Repair' })).toEqual({ source: 'relaygarage/vendor', side: 'vendor' });
    expect(X.classifyRelayAuthor('PETE_STORE')).toEqual({ source: 'relaygarage/vendor', side: 'vendor' });
    expect(X.classifyRelayAuthor('fasuser1')).toEqual({ source: 'relaygarage/fas', side: 'amazon' });
    expect(X.classifyRelayAuthor('Some Person')).toEqual({ source: 'relay', side: 'unknown' });
  });
});

describe('AC1 part vs order trap (Relay side)', () => {
  const b = relay(F39582.serviceDetail, { vendor: 'VOLVO' });
  it('85152780 is the only part; harness, VOR, linked to the order', () => {
    expect([...new Set(vals(b, 'part'))]).toEqual(['85152780']);
    const p = kinds(b, 'part')[0];
    expect(p).toMatchObject({ orderNo: '3010287243', vor: true, desc: 'harness' });
    expect(vals(b, 'order')).toContain('3010287243');
    expect(vals(b, 'part')).not.toContain('3010287243');
    expect(vals(b, 'vor')).toEqual([true]);
  });
  it('a same-block order value reclassifies a part; the negated mention is order-scoped', () => {
    const t = relay(wrOf([cm('Order #3010287243 placed'), cm('No ESD at this time for part#3010287243', 'fasuser1', '2026-11-06T15:00:00Z')]));
    expect(vals(t, 'part')).toEqual([]);
    expect(kinds(t, 'order').map((f) => [f.value, f.reclassifiedFrom || null])).toEqual([['3010287243', null], ['3010287243', 'part']]);
    const neg = kinds(t, 'etcMention').filter((f) => f.negated);
    expect(neg).toHaveLength(1);
    expect(neg[0]).toMatchObject({ etcKind: 'partsShip', orderNo: '3010287243' });
  });
  it('empty template labels yield no fact', () => {
    const t = relay(wrOf([cm('• Part #: • Order#: • PO#: • Dealer Code: • Verify if ordered VOR (Y/N):')]));
    expect(t.facts).toEqual([]);
  });
  it('labelled part forms and the International bare form', () => {
    const t = relay(wrOf([cm('PART # 85152780 / Part No:  K4253RX / Part Number: 20512915 / part#N71-6164-120000')]));
    expect(vals(t, 'part')).toEqual(['85152780', 'K4253RX', '20512915', 'N71-6164-120000']);
    const ta = relay(V.relayIND260261);
    expect(vals(ta, 'part')).toEqual(['4125033C96', '4049968C99', '6121796C1']);
  });
});

describe('AC34 cross-block trap helper', () => {
  it('an offsite part# with no order label becomes an order given the Relay order union', () => {
    const off = X.extractText('No ESD at this time for part#3010287243', { source: 'notes', at: '2026-11-05T15:00:00Z' }).facts;
    expect(off.filter((f) => f.kind === 'part').map((f) => f.value)).toEqual(['3010287243']);
    const rb = relay(F39582.serviceDetail);
    const orders = vals(rb, 'order');
    const fixed = X.reclassifyPartsAsOrders(off, orders);
    expect(fixed.filter((f) => f.kind === 'part')).toEqual([]);
    expect(fixed.filter((f) => f.kind === 'order').map((f) => f.value)).toEqual(['3010287243']);
    expect(fixed.find((f) => f.negated).orderNo).toBe('3010287243');
  });
});

describe('AC3 case-id shapes', () => {
  it('salesforce, decisivCase, oemCase, fleetnet + tow, unknown', () => {
    const t = relay(wrOf([
      cm('Salesforce Case #00034630 opened'),
      cm('Created Accident SaleForce Case # 00034983 per claim'),
      cm('see 00034630 again'),
      cm('Per ASIST case #20944704 and case 21268757'),
      cm('Volvo dealer CASE # 264113145'),
      cm('Fleetnet per 00176990|amz-dr67qazvrtau54'),
      cm('Dealer opened case 12345 for the body shop'),
    ]));
    const cases = kinds(t, 'case').map((f) => [f.value, f.ns]);
    expect(cases).toEqual(expect.arrayContaining([
      ['00034630', 'salesforce'], ['00034983', 'salesforce'], ['20944704', 'decisivCase'], ['21268757', 'decisivCase'],
      ['264113145', 'oemCase'], ['12345', 'unknown'],
    ]));
    expect(cases.filter(([v]) => v === '00176990')).toEqual([]);
    expect(vals(t, 'fleetnet')).toEqual(['00176990']);
    expect(vals(t, 'tow')).toEqual(['amz-dr67qazvrtau54']);
  });
  it('DSP fixture: ETC: N/A negated, FNA tow, carrier contact, unknown case', () => {
    const b = relay(V.relayB13014);
    expect(kinds(b, 'etcMention').filter((f) => f.negated).map((f) => f.etcKind)).toEqual(['repairCompletion']);
    expect(vals(b, 'tow')).toEqual(['amz-dr67qazvrtau54', 'amz-7cvf6f2rds7r3w']);
    expect(kinds(b, 'contact').filter((f) => f.side === 'carrier')).toHaveLength(1);
    expect(kinds(b, 'phone').map((f) => f.side)).toEqual(['carrier']);
    expect(kinds(b, 'case').map((f) => f.ns)).toEqual(['unknown']);
  });
  it('AC10 Relay part: salesforceCase 00034630 from the DTNA unit thread', () => {
    const b = relay(DT.relay122269);
    expect(kinds(b, 'case').map((f) => [f.value, f.ns])).toEqual([['00034630', 'salesforce']]);
  });
});

describe('AC7 cause / correction per labor line', () => {
  it('59080 Amerit: 3 lines each', () => {
    const b = relay(V.relay59080);
    const cause = kinds(b, 'cause');
    const corr = kinds(b, 'correction');
    expect(cause.map((f) => f.line)).toEqual([1, 2, 3]);
    expect(corr.map((f) => f.line)).toEqual([1, 2, 3]);
    expect(cause[0].value).toBe('DEAD BATTERIES WOULD NOT START IN YARD');
    expect(cause[0].category).toBe('MECHANICAL');
    expect(corr[2].value).toBe('REPLACED RIGHT FRONT TIRE.');
    expect(vals(b, 'ro')).toEqual([]);
  });
  it('B12195 COX: 2 labor lines with ro 206910652 (not a vendor WO id)', () => {
    const b = relay(V.relayB12195);
    expect(kinds(b, 'cause').map((f) => [f.line, f.ro, f.value])).toEqual([
      [1, '206910652', 'FAILED STARTER MOTOR'], [2, '206910652', 'CRACKED AIR LINE AT FITTING'],
    ]);
    expect(kinds(b, 'correction').map((f) => [f.line, f.ro])).toEqual([[1, '206910652'], [2, '206910652']]);
    const ro = kinds(b, 'ro');
    expect(ro.map((f) => f.value)).toEqual(['206910652']);
    expect(ro[0].isVendorWo).toBeUndefined();
    expect(vals(b, 'delayReason')).toEqual(['CC - Parts Ordered']);
  });
  it('Amerit RO format is a vendor WO; lat/long is never a ref, date or phone', () => {
    const b = relay(V.relay321062);
    expect(kinds(b, 'ro').map((f) => [f.value, f.isVendorWo])).toEqual([['891-00011134', true]]);
    expect(kinds(b, 'etcMention').map((f) => [f.value, f.etcKind])).toEqual([['2026-09-16', 'repairCompletion']]);
    expect(b.facts.filter((f) => /40\.62664|75\.44557|62664|44557/.test(String(f.value)))).toEqual([]);
    expect(vals(b, 'phone')).toEqual([]);
  });
});

describe('structured fields and history (§3.3)', () => {
  it('322355 Amerit: reasonCodes, history ETC revisions, current value deduped', () => {
    const b = relay(V.relay322355, { history: V.history322355, vendor: 'Amerit' });
    const s = kinds(b, 'delayReason');
    expect(s.map((f) => [f.value, f.via])).toEqual([['SOURCING_PARTS', 'structured'], ['SOURCING_PARTS', 'amerit']]);
    const hist = kinds(b, 'etcMention').filter((f) => f.via === 'history');
    expect(hist.map((f) => [f.value, f.prev || null, f.at])).toEqual([
      ['2026-11-11', null, '2026-11-10T13:00:00.000Z'], ['2026-11-11', '2026-11-11', '2026-11-11T12:40:00.000Z'],
    ]);
    expect(kinds(b, 'etcMention').filter((f) => f.via === 'structured')).toEqual([]);
    expect(kinds(b, 'etcMention').filter((f) => !f.via).map((f) => [f.value, f.etcKind])).toEqual([['2026-11-11', 'partsArrival']]);
    expect(kinds(b, 'ro').map((f) => [f.value, f.isVendorWo])).toEqual([['891-00011598', true]]);
  });
  it('B12195: 4 history revisions of the structured ETC (local calendar days)', () => {
    const b = relay(V.relayB12195, { history: V.historyB12195 });
    expect(kinds(b, 'etcMention').filter((f) => f.via === 'history').map((f) => f.value)).toEqual(['2026-11-09', '2026-11-08', '2026-11-10', '2026-11-10']);
  });
  it('IND260261: structured ETC at vendorModifiedTimestamp, approved estimate from the approver', () => {
    const b = relay(V.relayIND260261, { vendor: 'TA' });
    const st = kinds(b, 'etcMention').filter((f) => f.via === 'structured');
    expect(st.map((f) => [f.value, f.etcKind, f.at])).toEqual([['2026-10-30', 'repairCompletion', '2026-11-07T20:08:58.939Z']]);
    const est = kinds(b, 'estimate').filter((f) => f.via === 'structured');
    expect(est.map((f) => [f.value, f.amountStatus, f.source])).toEqual([[24804.13, 'approved', 'relaygarage/approver']]);
  });
});

describe('AC4 / §4.9 IND260261 TA text', () => {
  const b = relay(V.relayIND260261, { vendor: 'TA' });
  it('ETA/ETC one-liner, updateExpected, parts 11/13, tentative 11/20', () => {
    const m = kinds(b, 'etcMention').filter((f) => !f.via && !f.negated && !f.marker).map((f) => [f.value, f.etcKind, !!f.tentative]);
    expect(m).toEqual([
      ['2026-10-29', 'techOnsite', false], ['2026-11-07', 'repairCompletion', false], ['2026-11-10', 'updateExpected', false],
      ['2026-11-13', 'partsArrival', false], ['2026-11-20', 'repairCompletion', true],
    ]);
  });
  it('estimate chain: submitted, rejected, revised, temp rejects, approved', () => {
    const e = kinds(b, 'estimate').filter((f) => f.via !== 'structured').map((f) => [f.value, f.amountStatus, f.source]);
    expect(e).toEqual([
      [28895.94, 'submitted', 'relaygarage/vendor'],
      [28984.94, 'rejected', 'relaygarage/approver'],
      [28984.94, 'temp-reject', 'relaygarage/approver'],
      [24715.13, 'submitted', 'relaygarage/vendor'],
      [24804.13, 'temp-reject', 'relaygarage/approver'],
      [24804.13, 'submitted', 'relaygarage/vendor'],
      [24804.13, 'approved', 'relaygarage/approver'],
    ]);
    expect(kinds(b, 'estimate').find((f) => f.amountStatus === 'rejected').reason).toBe('Line item cost above expected');
  });
  it('line prices never become estimates; VIN is a cross-check fact', () => {
    expect(vals(b, 'estimate')).not.toContain(6784.49);
    expect(vals(b, 'vin')).toEqual(['3HSDZAPR1VN265324']);
  });
});

describe('§4.9 KWNE, CEI, PETE', () => {
  it('KWNE reject and Approved V1; relative by thurs', () => {
    const b = relay(V.relayB12258);
    expect(kinds(b, 'estimate').map((f) => [f.value, f.amountStatus, f.v || null, f.source])).toEqual([
      [1720.52, 'rejected', null, 'relaygarage/approver'], [509.65, 'approved', 1, 'relaygarage/approver'],
    ]);
    expect(kinds(b, 'estimate')[1].reason).toMatch(/^CEL diagnostic/);
    expect(kinds(b, 'etcMention').map((f) => [f.value, f.etcKind, f.relative])).toEqual([['2026-11-05', 'partsArrival', 'thurs']]);
  });
  it('CEI: salesforce, lead time, early next week', () => {
    const b = relay(V.relay321185);
    expect(kinds(b, 'case').map((f) => [f.value, f.ns])).toEqual([['00034983', 'salesforce']]);
    expect(kinds(b, 'leadTime').map((f) => [f.value, f.min, f.max, f.unit])).toEqual([['2-3 week', 2, 3, 'week']]);
    expect(kinds(b, 'etcMention').map((f) => [f.value, f.approx])).toEqual([['2026-10-27', true]]);
  });
  it('PETE: Tech ETA / ETC', () => {
    const b = relay(V.relay892568);
    expect(kinds(b, 'etcMention').map((f) => [f.value, f.etcKind])).toEqual([['2026-11-12', 'techOnsite'], ['2026-11-14', 'repairCompletion']]);
  });
});

describe('AC9 Relay side (B62281 PACCAR)', () => {
  const b = relay(P.relayB62281);
  it('WR dealer, dealer_id code, tow, approver V1, FAS warranty active', () => {
    expect(kinds(b, 'dealer').map((f) => [f.value, f.via])).toEqual([['The Peterbilt Store - Hartford', 'wr']]);
    expect(kinds(b, 'dealerCode').map((f) => [f.value, f.via])).toEqual([['PCF0013', 'url']]);
    expect(vals(b, 'tow')).toEqual(['amz-htkt2ed6g9ay7b']);
    expect(kinds(b, 'estimate').map((f) => [f.value, f.v, f.source])).toEqual([[5292.31, 1, 'relaygarage/approver']]);
    expect(kinds(b, 'warranty').map((f) => [f.value, f.side])).toEqual([['active', 'amazon']]);
  });
});

describe('AC36 dealer call attempts + contacts + phones', () => {
  const b = relay(F39582.serviceDetail);
  it('hold and voicemail attempts; spoke-with is not an attempt', () => {
    expect(kinds(b, 'callAttempt').map((f) => [f.outcome, f.dealer || null])).toEqual([
      ['hold', 'M&K Truck Centers – Dunmore, PA'], ['voicemail', null],
    ]);
    const n = relay(wrOf([cm('Called the dealer and spoke with Pat, no answer on the parts line')]));
    expect(kinds(n, 'callAttempt')).toEqual([]);
  });
  it('FAS-prose dealer, phone attached to it, contacts', () => {
    expect(kinds(b, 'dealer').map((f) => [f.value, f.via])).toEqual(expect.arrayContaining([
      ['M&K Truck Centers - Dunmore', 'wr'], ['M&K Truck Centers – Dunmore, PA', 'fas'],
    ]));
    expect(kinds(b, 'phone').map((f) => [f.value, f.side, f.dealer])).toContainEqual(['555-010-1245', 'dealer', 'M&K Truck Centers – Dunmore, PA']);
    expect(kinds(b, 'contact').map((f) => [f.value, f.role, f.side])).toEqual(expect.arrayContaining([
      ['Pat', null, 'dealer'], ['Pat Doe', 'Service Manager', 'dealer'],
    ]));
  });
  it('bridge PIN is never a phone, ref or date', () => {
    const t = relay(wrOf([cm('One-click Connect Number: +18005550199,,,0402,,,8263 and +1 (800) 555-0199,,,0402')]));
    expect(t.facts).toEqual([]);
  });
  it('misc: PM-B added, lead time, ASIST case', () => {
    expect(vals(b, 'pmAdded')).toEqual([true]);
    expect(vals(b, 'leadTime')).toEqual(['6-8 week']);
    expect(kinds(b, 'case').map((f) => [f.value, f.ns])).toEqual([['20944704', 'decisivCase']]);
  });
});

describe('ETC facts of the 39582 Relay thread', () => {
  const b = relay(F39582.serviceDetail);
  const etc = kinds(b, 'etcMention');
  it('markers consume their cited dates; negations are undated', () => {
    expect(etc.filter((f) => f.marker === 'miss').map((f) => [f.value, f.chain])).toEqual([
      ['2026-10-11', 'parts'], ['2026-10-11', 'parts'], ['2026-10-26', 'parts'], ['2026-10-26', 'parts'],
    ]);
    expect(etc.filter((f) => f.marker === 'met').map((f) => f.chain)).toEqual(['parts']);
    expect(etc.filter((f) => f.negated).map((f) => [f.value, f.etcKind])).toEqual([[null, 'partsArrival'], [null, 'partsArrival']]);
    expect(etc.filter((f) => f.etcKind === 'repairCompletion')).toEqual([]);
    expect(etc.filter((f) => f.etcKind === 'repairStart').map((f) => [f.value, f.approx])).toEqual([['2026-11-09', 'weekOf']]);
  });
});

describe('text hygiene', () => {
  it('entity decode incl. bare &amp', () => {
    const b = relay(wrOf([cm('Called M&amp;K Truck Centers &amp Co, Dunmore, PA (Volvo) at (555) 010-1245, no answer, on hold')]));
    expect(vals(b, 'dealer')).toEqual(['M&K Truck Centers & Co, Dunmore, PA']);
    expect(X.decodeEntities('a &amp b &lt;c&gt; &#39;d&#39; &quot;e&quot;&nbsp;f')).toBe("a & b <c> 'd' \"e\" f");
  });
  it('legacy MM/DD/YYYY HH:MM:SS comment timestamp is UTC', () => {
    const b = relay(wrOf([V.legacyTs]));
    expect(b.events[0].at).toBe('2026-11-03T14:05:09.000Z');
    expect(kinds(b, 'etcMention').map((f) => f.value)).toEqual(['2026-11-07']);
  });
  it('comments longer than perCommentChars are cut and counted', () => {
    const b = relay(wrOf([cm('x '.repeat(15000) + 'ETC 11/20')]));
    expect(b.counts.truncated).toBe(1);
    expect(kinds(b, 'etcMention')).toEqual([]);
  });
  it('bad input is safe', () => {
    expect(relay(null).facts).toEqual([]);
    expect(relay({ workRequest: { comments: [null, { text: '' }] } }).facts).toEqual([]);
  });
});

describe('_fact invariant', () => {
  const prov = { source: 'relay', side: 'system', at: null, author: null };
  it('rejects a value not present in its snippet', () => {
    expect(X._fact('part', '85152799', prov, { snippet: 'Part #85152780 ordered', raw: '85152799' })).toBe(null);
    expect(X._fact('estimate', 4800, prov, { snippet: 'Approved $5,292.31' })).toBe(null);
    expect(X._fact('part', '85152780', prov, { snippet: 'Part #85152780 ordered', raw: '85152780' })).toMatchObject({ kind: 'part', value: '85152780' });
  });
  it('rejects bad enums', () => {
    expect(X._fact('nope', 'x', prov, { snippet: 'x', raw: 'x' })).toBe(null);
    expect(X._fact('part', 'x', Object.assign({}, prov, { source: 'web' }), { snippet: 'x', raw: 'x' })).toBe(null);
    expect(X._fact('part', 'x', prov, { snippet: 'x', raw: 'x', side: 'martian' })).toBe(null);
  });
  it('separators are ignored by the comparison', () => {
    expect(X._fact('estimate', 24804.13, prov, { snippet: 'estimate for $24,  804.13', raw: '$24, 804.13' })).not.toBe(null);
  });
});

describe('caps', () => {
  it('a 400-comment thread stays within the block caps', () => {
    const comments = [];
    for (let i = 0; i < 400; i++) {
      comments.push(cm('Update ' + i + ': Parts ETC 11/' + String(10 + (i % 15)) + '/2026 Part #8515' + String(1000 + i) + ' Order #30102' + String(87000 + i), 'fasuser1', new Date(Date.parse('2026-09-01T12:00:00Z') + i * 3600000).toISOString()));
    }
    const b = relay(wrOf(comments));
    expect(b.facts.length).toBeLessThanOrEqual(X.CAPS.facts);
    expect(b.events.length).toBeLessThanOrEqual(X.CAPS.events);
    expect(JSON.stringify(b).length).toBeLessThanOrEqual(X.CAPS.relayBlockBytes);
    expect(b.counts.truncated).toBeGreaterThan(0);
    // overflow drops events first, then restatements, then the oldest facts: the newest comment's facts stay
    const newest = new Date(Date.parse(comments[399].timestamp)).toISOString();
    expect(b.facts.some((f) => f.at === newest)).toBe(true);
  });
});

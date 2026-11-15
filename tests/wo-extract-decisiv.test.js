// tests/wo-extract-decisiv.test.js — relay-extract §3.4 / §3.5: AC2 (DOM block, pre-cap),
// Decisiv normalization (groupId sides, job_role, recipients, tz), prior episode,
// structured dealer + Decisiv dealer id, context/version approvals, AC9 offsite side,
// AC10 DTNA (enter / close, long feed).
process.env.TZ = 'America/New_York';
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import * as N from './fixtures/extract/decisiv-39582-notes.js';
import { estimateDetail } from './fixtures/extract/estimate-detail-39582.js';
import * as P from './fixtures/extract/b62281-paccar.js';
import * as DT from './fixtures/extract/dtna-122269.js';
const require = createRequire(import.meta.url);
const X = require('../src/repair-intel/wo-extract');
const decisivApi = require('../src/scrapers/decisiv_api');

const NOW = Date.parse('2026-11-11T15:00:00Z');
const kinds = (b, k) => b.facts.filter((f) => f.kind === k);
const vals = (b, k) => kinds(b, k).map((f) => f.value);
const b39582 = X.extractDecisivNotes(N.allNotes, { estimateId: '20945735', estimateDetail, wrCreatedAt: N.WR_CREATED_AT, now: NOW, pages: 3 });

describe('normalizeDecisivNote', () => {
  it('sides, tz parse, text, recipients', () => {
    const n = X.normalizeDecisivNote(N.allNotes[0]);
    expect(n).toMatchObject({
      at: '2026-11-10T15:28:00.000Z', author: 'Uptime Agent', side: 'oem', groupId: -3,
      jobRole: 'customer_service_representative', text: 'Current Case — ETR is 11/11/2026', internal: false, systemGenerated: false,
    });
    expect(n.recipients.map((r) => r.side)).toEqual(['dealer', 'amazon']);
    expect(n.recipients[1].jobRole).toBe(null);
    expect(X.normalizeDecisivNote({ from: { location: 'Amazon Bos3' }, created_at: 'x' })).toMatchObject({ side: 'amazon', at: null });
    expect(X.normalizeDecisivNote({ from: { location: 'Originator: Uptime' } }).side).toBe('oem');
    expect(X.normalizeDecisivNote({ from: { location: 'Some Dealer' } }).side).toBe('dealer');
  });
  it('_plain copy matches decisiv_api._plain', () => {
    for (const s of ['Case #<a href="https://x/y">12345</a> opened', 'line1<br>line2', 'a &amp; b &lt;c&gt; &#39;d&#39;', '<p>x</p><div>y</div>', null]) {
      expect(X._plain(s)).toBe(decisivApi._plain(s));
    }
  });
});

describe('AC2 DOM block note (pre-cap extraction)', () => {
  it('ro, dealerCode, oemCase, vor, partsArrival 10/11', () => {
    const dealerNote = (f) => f.at === '2026-09-28T18:05:00.000Z';
    const own = b39582.facts.filter(dealerNote);
    expect(own.filter((f) => f.kind === 'ro').map((f) => f.value)).toEqual(['30319SP']);
    expect(own.filter((f) => f.kind === 'dealerCode').map((f) => f.value)).toEqual(['5948D']);
    expect(own.filter((f) => f.kind === 'case').map((f) => [f.value, f.ns])).toEqual([['264113145', 'oemCase']]);
    expect(own.filter((f) => f.kind === 'vor').map((f) => f.value)).toEqual([true]);
    expect(own.filter((f) => f.kind === 'etcMention').map((f) => [f.value, f.etcKind])).toEqual([['2026-10-11', 'partsArrival']]);
  });
  it('the same notes formatted + cut at 6000 lose 30319SP', () => {
    const { text } = decisivApi.formatActivityLogs({ notes: N.allNotes });
    expect(text.slice(0, 6000)).not.toContain('30319SP');
    expect(JSON.stringify(b39582.facts)).toContain('30319SP');
  });
  it('AC1 offsite side: the template yields nothing; part# of an order is an order', () => {
    const tpl = b39582.facts.filter((f) => f.at === '2026-09-27T12:30:00.000Z');
    expect(tpl).toEqual([]);
    expect([...new Set(vals(b39582, 'part'))]).toEqual(['85152780']);
    expect(kinds(b39582, 'part').some((f) => f.qty === 1 && f.orderNo === '3010287243')).toBe(true);
    const neg = kinds(b39582, 'etcMention').filter((f) => f.negated);
    expect(neg.map((f) => [f.etcKind, f.orderNo])).toEqual([['partsShip', '3010287243']]);
    expect(kinds(b39582, 'order').filter((f) => f.reclassifiedFrom === 'part').map((f) => f.value)).toEqual(['3010287243']);
  });
});

describe('block, episodes, structured dealer', () => {
  it('block counts, events sorted ascending, size cap', () => {
    expect(b39582).toMatchObject({ v: 2, estimateId: '20945735', wrCreatedAt: '2026-09-23T18:04:00.000Z' });
    expect(b39582.counts).toMatchObject({ notes: 108, pages: 3, rejected: 0 });
    expect(b39582.events.length).toBeLessThanOrEqual(X.CAPS.events);
    const ats = b39582.events.map((e) => e.at);
    expect(ats).toEqual(ats.slice().sort());
    expect(JSON.stringify(b39582).length).toBeLessThanOrEqual(X.CAPS.offsiteBlockBytes);
  });
  it('June notes are a prior episode', () => {
    const prior = b39582.facts.filter((f) => f.episode === 'prior');
    expect(prior.length).toBeGreaterThan(0);
    expect(prior.every((f) => f.at < '2026-07-01')).toBe(true);
    expect(b39582.events.filter((e) => e.episode === 'prior')).toHaveLength(8);
    expect(b39582.facts.filter((f) => f.at >= '2026-09-01' && f.episode)).toEqual([]);
    const noCut = X.extractDecisivNotes(N.allNotes, { now: NOW });
    expect(noCut.facts.filter((f) => f.episode)).toEqual([]);
  });
  it('Uptime ETR 11/11 is a decisiv repairCompletion mention', () => {
    expect(kinds(b39582, 'etcMention').filter((f) => f.etcKind === 'repairCompletion' && !f.episode).map((f) => [f.value, f.side]))
      .toEqual([['2026-11-11', 'oem']]);
  });
  it('estimate.dealer -> block.dealer, decisivDealerId (never dealerCode), structured dealer', () => {
    expect(b39582.dealer).toEqual({ id: 'AUS0014', name: 'M & K Truck Centers - Dunmore, PA' });
    expect(vals(b39582, 'decisivDealerId')).toEqual(['AUS0014']);
    expect(vals(b39582, 'dealerCode')).toEqual(['5948D']);
    expect(kinds(b39582, 'dealer').map((f) => [f.value, f.via])).toEqual(expect.arrayContaining([
      ['M & K Truck Centers - Dunmore, PA', 'structured'], ['M & K Truck Centers - Dunmore, PA (Volvo)', 'location'],
    ]));
  });
  it('structured contacts per distinct (name, location)', () => {
    const c = kinds(b39582, 'contact').filter((f) => f.via === 'structured');
    expect(c.map((f) => [f.value, f.side])).toEqual(expect.arrayContaining([
      ['Uptime Agent', 'oem'], ['Dealer Advisor', 'dealer'], ['Amazon Fas', 'amazon'],
    ]));
    expect(c).toHaveLength(3);
  });
});

describe('AC9 offsite side (B62281 PACCAR)', () => {
  const b = X.extractDecisivNotes(P.notesB62281, { estimateId: '21520684', estimateDetail: P.estimateDetailB62281, now: NOW });
  it('Decisiv dealer id PCUS00307 stays separate; dealer name', () => {
    expect(vals(b, 'decisivDealerId')).toEqual(['PCUS00307']);
    expect(vals(b, 'dealerCode')).toEqual([]);
    expect(b.dealer).toEqual({ id: 'PCUS00307', name: 'The Peterbilt Store - Hartford' });
  });
  it('dealer warranty expired; PM added (question rejected)', () => {
    expect(kinds(b, 'warranty').map((f) => [f.value, f.side])).toEqual([['expired', 'dealer']]);
    expect(kinds(b, 'pmAdded').map((f) => f.side)).toEqual(['dealer']);
  });
  it('Est Approved / Total authorized; context estimate_approved stamps the version', () => {
    const e = kinds(b, 'estimate').map((f) => [f.value, f.amountStatus, f.v || null, f.source]);
    expect(e).toEqual([[5292.31, 'approved', null, 'decisiv'], [5292.31, 'approved', 1, 'decisiv']]);
    expect(b.events.find((x) => x.via === 'system')).toBeTruthy();
  });
});

describe('AC10 DTNA feed', () => {
  it('parseDtnaFeedLines: actors -> sides, continuation lines', () => {
    const lines = X.parseDtnaFeedLines(DT.feed + '\ncontinued text');
    expect(lines.map((l) => l.side)).toEqual(['amazon', 'system', 'oem', 'dealer', 'system']);
    expect(lines[4].text).toMatch(/continued text$/);
    expect(lines[0].at).toBe('2026-10-27T04:00:00.000Z');
  });
  it('enter + close events, dealer name', () => {
    const b = X.extractDtnaFeed(DT.feed, { now: NOW });
    const ev = kinds(b, 'dtnaEvent');
    const enter = ev.find((f) => f.value === 'enter');
    expect(enter).toMatchObject({ dealer: 'HORWITH FREIGHTLINER', city: 'NORTHAMPTON, PA', at: '2026-10-23T10:37:00.000Z', source: 'dtna', side: 'system' });
    const close = ev.find((f) => f.value === 'close');
    expect(close).toMatchObject({ status: 'Closed', transition: 'Post-Repair to Closed' });
    expect(kinds(b, 'dealer').map((f) => [f.value, f.via])).toEqual([['HORWITH FREIGHTLINER', 'dtna']]);
    expect(vals(b, 'ro')).toEqual([]);
    expect(b.partial).toBe(false);
  });
  it('long feed: both the newest close and the oldest enter are extracted', () => {
    const long = DT.longFeed();
    expect(long.length).toBeGreaterThan(9000);
    const b = X.extractDtnaFeed(long, { now: NOW });
    expect(kinds(b, 'dtnaEvent').map((f) => f.value).sort()).toEqual(['close', 'enter']);
    expect(JSON.stringify(b).length).toBeLessThanOrEqual(X.CAPS.offsiteBlockBytes);
  });
  it('falls back to offsiteText and marks the block truncated / partial', () => {
    const b = X.extractDtnaFeed('', { offsiteText: DT.feed.slice(0, 200), now: NOW });
    expect(b.partial).toBe(true);
    expect(b.counts.truncated).toBeGreaterThanOrEqual(1);
  });
});

describe('extractText (app notes / email)', () => {
  it('runs the shared pass with notes/email provenance', () => {
    const r = X.extractText('Per ASIST case #20944704, ETC 11/14', { source: 'email', at: '2026-11-10T15:00:00Z' });
    expect(r.facts.map((f) => [f.kind, f.value, f.source])).toEqual([
      ['case', '20944704', 'email'], ['etcMention', '2026-11-14', 'email'],
    ]);
    expect(X.extractText('', { source: 'notes' }).facts).toEqual([]);
  });
});

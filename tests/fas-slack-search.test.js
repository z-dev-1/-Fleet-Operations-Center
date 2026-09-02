import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-slacksearch-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const { searchSlack } = require('../src/orcha/fas/slack-search');
const profiles = require('../src/orcha/fas/sender-profiles');

const nowMs = Date.now();
const tsSecAgo = (s) => ((nowMs - s * 1000) / 1000).toFixed(6);

// Injected index (mocked message boundary — not the store, not live Slack).
const INDEX = [
  { ts: tsSecAgo(3600), senderName: 'Donte', channelName: '#mmfm-predictive-mx', text: 'Update on 320160: parts arrived, back together tomorrow', operator: 'TUZR', domicile: 'ABE40', permalink: 'https://slack/1' },
  { ts: tsSecAgo(86400), senderName: 'Ops', channelName: '#ops', text: 'old note about 320160 waiting on diagnosis', operator: 'TUZR', domicile: 'ABE40', permalink: 'https://slack/2' },
  { ts: tsSecAgo(600), senderName: 'Vendor', channelName: '#vendors', text: 'Amerit says 622072 is done', operator: 'SAPB', domicile: 'EWR45', permalink: 'https://slack/3' },
  { ts: tsSecAgo(120), senderName: 'Noise', channelName: '#random', text: 'lunch?', operator: '', domicile: '' },
];

const internal = () => ({ type: 'internal', operators: [], domiciles: [], allowedDataCategories: profiles.DATA_CATEGORIES.slice() });
const carrierTUZR = () => ({ type: 'carrier', operators: ['TUZR'], domiciles: [], allowedDataCategories: ['unit_status'] });

beforeEach(() => {});
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('FAS SEARCH_SLACK adapter', () => {
  it('searches message CONTENT and ranks newer exact-unit matches first', () => {
    const r = searchSlack({ unit: '320160' }, internal(), { index: INDEX });
    expect(r.ok).toBe(true);
    expect(r.results.length).toBe(2);
    // Newer 320160 update ranks above the day-old one.
    expect(r.results[0].excerpt).toMatch(/parts arrived/);
    expect(r.results[0].exactUnitMatch).toBe(true);
  });

  it('returns timestamp, sender, channel, excerpt, permalink', () => {
    const r = searchSlack({ keywords: 'Amerit' }, internal(), { index: INDEX });
    const hit = r.results[0];
    expect(hit.when).toBeTruthy();
    expect(hit.sender).toBe('Vendor');
    expect(hit.channel).toBe('#vendors');
    expect(hit.excerpt).toMatch(/Amerit/);
    expect(hit.permalink).toBe('https://slack/3');
  });

  it('re-filters by requesting sender scope (carrier cannot see other operator chatter)', () => {
    // TUZR carrier searching a SAPB-tagged message -> excluded.
    const r = searchSlack({ keywords: 'Amerit' }, carrierTUZR(), { index: INDEX });
    expect(r.results.length).toBe(0);
    // But CAN see their own operator's 320160 messages.
    const own = searchSlack({ unit: '320160' }, carrierTUZR(), { index: INDEX });
    expect(own.results.length).toBeGreaterThanOrEqual(1);
    expect(own.results.every(x => /320160/.test(x.excerpt))).toBe(true);
  });

  it('supports date-range filtering', () => {
    const r = searchSlack({ unit: '320160', fromMs: nowMs - 2 * 3600 * 1000 }, internal(), { index: INDEX });
    // Only the 1h-ago message falls in the last 2h window.
    expect(r.results.length).toBe(1);
    expect(r.results[0].excerpt).toMatch(/parts arrived/);
  });

  it('caps result count', () => {
    const big = [];
    for (let i = 0; i < 50; i++) big.push({ ts: tsSecAgo(i + 1), senderName: 'S', channelName: '#c', text: 'unit 320160 note ' + i, operator: 'TUZR' });
    const r = searchSlack({ unit: '320160' }, internal(), { index: big, maxResults: 5 });
    expect(r.results.length).toBe(5);
    expect(r.truncated).toBe(true);
  });
});

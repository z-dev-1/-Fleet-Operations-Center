// tests/dtna-raw-thread.test.js — relay-extract §3.5 / AC10 long feed: parseFeed stays
// byte-identical to 1eabe04 (8000-char head), parseFeedFull is the same thread uncapped,
// and the extractor reads both the newest close and the oldest enter event from the
// 20000-char rawThread head that enrichDtna now returns. Electron / auto-login are faked
// in the require cache (dtna_enrich requires them at load).
process.env.TZ = 'America/New_York';
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function injectFake(rel, exportsObj) {
  const resolved = require.resolve(rel);
  if (!require.cache[resolved]) require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
injectFake('electron', { BrowserWindow: function () {} });
injectFake('../src/orcha/auto-login', { partitionForUrl: () => 'persist:dtna', attachAutoLogin: () => {} });
const dtna = require('../src/scrapers/dtna_enrich');
const X = require('../src/repair-intel/wo-extract');

// 1eabe04's parseFeed (+ its _CHROME_RE), evaluated from git.
function baseParseFeed() {
  try {
    const src = execFileSync('git', ['-C', ROOT, 'show', '1eabe04:src/scrapers/dtna_enrich.js'], { encoding: 'utf8' });
    const a = src.indexOf('const _CHROME_RE');
    const b = src.indexOf('// Expand the lazy Lightning feed');
    return new Function(src.slice(a, b) + '\nreturn parseFeed;')();
  } catch (_) { return null; }
}
const BASE = baseParseFeed();

// Raw rendered Chatter feed (newest first): close item, many sync items, enter item last.
function rawFeed(padItems) {
  const L = [];
  L.push('Sort by:', 'Latest Posts');
  L.push('ROSync API (Employee) closed this case as Closed.', 'October 26, 2026 at 9:12 AM', 'Status', 'Post-Repair to Closed', 'Like', 'Comment');
  L.push('AFP FAS (Partner - Y16782)', 'October 27, 2026 at 8:15 AM', 'made ro, printed docs 10/27/26 8:15am requested additional 3 hrs of diag approval', 'Write a comment...');
  for (let i = 0; i < padItems; i++) {
    L.push((i % 2 ? 'ROSync API (Employee) updated this record.' : 'AFP FAS (Partner - Y16782)'), 'October 25, 2026 at 6:56 AM',
      'Status sync ' + i + ' repair order updated, awaiting technician assignment and parts confirmation from the dealer parts counter', 'Like');
  }
  L.push('E2E Geofence API User (Partner)', 'October 23, 2026 at 3:37 AM',
    'Serial No: NP6923 (Unit Id: 122269) has entered HORWITH FREIGHTLINER in NORTHAMPTON, PA at 10/23/2026 03:37 AM PDT', 'End of Feed');
  return L.join('\n');
}

describe('dtna parseFeed / parseFeedFull', () => {
  it('the 1eabe04 parseFeed is available', () => { expect(typeof BASE).toBe('function'); });
  it('parseFeed is byte-identical to 1eabe04 (short and long feeds)', () => {
    for (const raw of [rawFeed(3), rawFeed(90), '', 'Like\nComment']) expect(dtna.parseFeed(raw)).toBe(BASE(raw));
  });
  it('parseFeed = parseFeedFull head 8000; long feeds keep the oldest entries only in parseFeedFull', () => {
    const raw = rawFeed(90);
    const full = dtna.parseFeedFull(raw);
    expect(full.length).toBeGreaterThan(9000);
    expect(dtna.parseFeed(raw)).toBe(full.slice(0, 8000));
    expect(dtna.parseFeed(raw)).not.toContain('HORWITH');
    expect(full).toContain('has entered HORWITH FREIGHTLINER');
  });
  it('AC10 long feed: the rawThread head yields the newest close and the oldest enter', () => {
    const raw = rawFeed(90);
    const rawThread = dtna.parseFeedFull(raw).slice(0, 20000);
    const b = X.extractDtnaFeed(rawThread, { now: Date.parse('2026-11-11T15:00:00Z') });
    const ev = b.facts.filter((f) => f.kind === 'dtnaEvent');
    expect(ev.map((f) => f.value).sort()).toEqual(['close', 'enter']);
    expect(ev.find((f) => f.value === 'close')).toMatchObject({ status: 'Closed', transition: 'Post-Repair to Closed' });
    // The capped offsiteText alone loses the enter event.
    const capped = X.extractDtnaFeed(dtna.parseFeed(raw), { now: Date.parse('2026-11-11T15:00:00Z') });
    expect(capped.facts.filter((f) => f.kind === 'dtnaEvent').map((f) => f.value)).toEqual(['close']);
  });
  it('enrichDtna returns rawThread = parseFeedFull head 20000 next to the unchanged offsiteText', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/scrapers/dtna_enrich.js'), 'utf8');
    expect(src).toContain('rawThread: parseFeedFull(d.text).slice(0, 20000)');
    expect(src).toContain('const thread = parseFeed(d.text);');
    expect(src).toContain('offsiteText: thread, statusText: thread, estimateComments: thread,');
  });
});

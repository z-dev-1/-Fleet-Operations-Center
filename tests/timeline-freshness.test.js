// tests/timeline-freshness.test.js
//
// Regression for "timeline not current" (unit 320160, 2026-10-27): the timeline
// said "no dealer update since 10/22" while ASIST had 10/22, 10/26 and 10/27
// updates. Causes fixed + covered here:
//   1. deep-scan trusted cached asistNotes forever (no age check)  → stale cache re-scraped live
//   2. relay merge always preferred the (older) relay cache copy   → newer copy wins
//   3. a deep-scan saved its whole in-memory notesStore            → only changed units written
//   4. refresh-on-open never rebuilt the timeline                  → input signature + single-unit rebuild
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'tl-fresh-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const store = require('../src/store');

// Stub the AI relay + live ASIST scraper in the CJS cache BEFORE deep-scan loads them.
const _ask = vi.fn();
const _enrich = vi.fn();
function _stub(rel, exportsObj) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}
_stub('../src/orcha/relay', { ask: (...a) => _ask(...a) });
_stub('../src/scrapers/asist_enrich', { enrichVolvoAsist: (...a) => _enrich(...a) });

const deepScan = require('../src/orcha/deep-scan');
const { _newerOffsite } = require('../src/scrapers/relay.js');
const { timelineInputSignature } = require('../src/orcha/timeline-freshness');

const HOUR = 3600 * 1000;
const STALE_NOTES = '2026-10-21 18:12 Dealer: ECA and clutch received.';
const FRESH_NOTES = '2026-10-27 10:45 Uptime: THE CLUTCH IS HERE. Fork kit shipped from Indianapolis.\n' + STALE_NOTES;
const AI_TEXT = 'REPAIR_STATUS: Waiting for parts\nPRIMARY_COMPONENT: ENGINE/MOTOR SYSTEMS\nISSUE: Transmission fault\nTIMELINE:\n10/21 - ECA and clutch received.\n10/27 - Clutch on site; fork kit shipped.\n';

function unit(extra) {
  return {
    equipmentId: '320160', lifecycleState: 'Unavailable', lifecycleReason: 'Offsite Shop Repair',
    vendor: 'VOLVO', offsiteShopEventUrl: 'https://volvopg.asist.decisiv.net/fleet/estimates/21349860',
    fullConversation: 'Conversation\n10/09 WR created', ...extra,
  };
}

beforeEach(() => {
  store.save('notesStore', {});
  _ask.mockReset(); _enrich.mockReset();
  _ask.mockResolvedValue(AI_TEXT);
  _enrich.mockResolvedValue({ ok: true, offsiteText: FRESH_NOTES, scrapedAt: new Date().toISOString(), source: 'estimate' });
});

const run = (rows) => deepScan.runOrchaDeepScan(rows, { pushData: () => {}, pushStatus: () => {}, payload: {} });

describe('offsite cache freshness in the timeline build', () => {
  it('re-scrapes ASIST live when the cached notes are stale, and feeds the FRESH notes to the AI', async () => {
    const row = unit({ asistNotes: STALE_NOTES, asistScrapedAt: new Date(Date.now() - 5 * 24 * HOUR).toISOString() });
    await run([row]);
    expect(_enrich).toHaveBeenCalledTimes(1);
    expect(_ask.mock.calls[0][0]).toContain('THE CLUTCH IS HERE');
    expect(row.asistNotes).toContain('THE CLUTCH IS HERE');   // row cache refreshed
    expect(row.repairTimeline).toContain('10/27');
  });
  it('treats undated cached notes as stale', async () => {
    await run([unit({ asistNotes: STALE_NOTES, asistScrapedAt: '' })]);
    expect(_enrich).toHaveBeenCalledTimes(1);
  });
  it('uses fresh cached notes without a live scrape', async () => {
    await run([unit({ asistNotes: FRESH_NOTES, asistScrapedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() })]);
    expect(_enrich).not.toHaveBeenCalled();
    expect(_ask.mock.calls[0][0]).toContain('THE CLUTCH IS HERE');
  });
  it('falls back to the stale cache if the live scrape fails', async () => {
    _enrich.mockResolvedValue({ ok: false });
    await run([unit({ asistNotes: STALE_NOTES, asistScrapedAt: '' })]);
    expect(_ask.mock.calls[0][0]).toContain('ECA and clutch received');
  });
  it('isOffsiteCacheFresh window', () => {
    const now = Date.now();
    expect(deepScan.isOffsiteCacheFresh({ asistScrapedAt: new Date(now - HOUR).toISOString() }, now)).toBe(true);
    expect(deepScan.isOffsiteCacheFresh({ asistScrapedAt: new Date(now - 3 * HOUR).toISOString() }, now)).toBe(false);
    expect(deepScan.isOffsiteCacheFresh({ asistScrapedAt: '' }, now)).toBe(false);
  });
});

describe('notesStore saves never clobber concurrent changes', () => {
  it('a scan only writes the units it changed', async () => {
    store.save('notesStore', { OTHER: { notes: 'before' } });
    _ask.mockImplementation(async () => {
      // Simulate a user edit / single-unit rebuild landing mid-scan.
      const ns = store.load('notesStore', {}); ns.OTHER = { notes: 'edited during scan' }; store.save('notesStore', ns);
      return AI_TEXT;
    });
    await run([unit({ asistNotes: FRESH_NOTES, asistScrapedAt: new Date().toISOString() })]);
    const after = store.load('notesStore', {});
    expect(after.OTHER.notes).toBe('edited during scan');
    expect(after['320160'].timeline).toContain('10/27');
  });
});

describe('rebuildUnitTimeline', () => {
  it('rebuilds one unit and pushes it as a partial merge (never a 1-row grid replace)', async () => {
    const pushes = [];
    const row = unit({ asistNotes: FRESH_NOTES, asistScrapedAt: new Date().toISOString() });
    const r = await deepScan.rebuildUnitTimeline(row, { pushData: (p) => pushes.push(p) });
    expect(r.ok).toBe(true);
    expect(r.timeline).toContain('10/27');
    expect(pushes.length).toBeGreaterThan(0);
    expect(pushes.every((p) => p.partialMerge === true && p.rows.length === 1)).toBe(true);
  });
});

describe('relay merge keeps the NEWER offsite notes', () => {
  const old = new Date(Date.now() - 5 * 24 * HOUR).toISOString();
  const now = new Date().toISOString();
  it('row newer than cache → row wins', () => {
    expect(_newerOffsite({ asistNotes: STALE_NOTES, asistScrapedAt: old }, { asistNotes: FRESH_NOTES, asistScrapedAt: now }).asistNotes).toBe(FRESH_NOTES);
  });
  it('cache newer than row → cache wins', () => {
    expect(_newerOffsite({ asistNotes: FRESH_NOTES, asistScrapedAt: now }, { asistNotes: STALE_NOTES, asistScrapedAt: old }).asistNotes).toBe(FRESH_NOTES);
  });
  it('dated beats undated; undated on both keeps the cache (old behavior)', () => {
    expect(_newerOffsite({ asistNotes: STALE_NOTES }, { asistNotes: FRESH_NOTES, asistScrapedAt: now }).asistNotes).toBe(FRESH_NOTES);
    expect(_newerOffsite({ asistNotes: 'cache' }, { asistNotes: 'row' }).asistNotes).toBe('cache');
  });
  it('never trades real text for an empty one', () => {
    expect(_newerOffsite({ asistNotes: STALE_NOTES, asistScrapedAt: old }, { asistNotes: '', asistScrapedAt: now }).asistNotes).toBe(STALE_NOTES);
  });
});

describe('relay merge keeps the NEWER WR conversation (Relay Garage)', () => {
  const { _newerConversation } = require('../src/scrapers/relay.js');
  const cachedAt = Date.now() - 6 * HOUR;
  it('live API conversation fetched after the relay scrape wins', () => {
    expect(_newerConversation({ fullConversation: 'old', _cachedAt: cachedAt }, { fullConversation: 'live', _convFetchedAt: new Date().toISOString() })).toBe('live');
  });
  it('a relay scrape newer than the row wins', () => {
    expect(_newerConversation({ fullConversation: 'fresh scrape', _cachedAt: Date.now() }, { fullConversation: 'older', _convFetchedAt: new Date(cachedAt).toISOString() })).toBe('fresh scrape');
  });
  it('undated row keeps the old cache-first behavior; empties fall back', () => {
    expect(_newerConversation({ fullConversation: 'cache', _cachedAt: cachedAt }, { fullConversation: 'row' })).toBe('cache');
    expect(_newerConversation({}, { fullConversation: 'row' })).toBe('row');
    expect(_newerConversation({ fullConversation: 'cache' }, {})).toBe('cache');
  });
});

describe('timelineInputSignature', () => {
  it('changes when dealer notes or the WR conversation change, not otherwise', () => {
    const a = timelineInputSignature(unit({ asistNotes: STALE_NOTES }));
    expect(a).toBe(timelineInputSignature(unit({ asistNotes: STALE_NOTES, odometerMiles: 999 })));
    expect(a).not.toBe(timelineInputSignature(unit({ asistNotes: FRESH_NOTES })));
    expect(a).not.toBe(timelineInputSignature(unit({ asistNotes: STALE_NOTES, fullConversation: 'Conversation\n10/27 new comment' })));
  });
  it('is empty when there is nothing to build from', () => {
    expect(timelineInputSignature({ equipmentId: 'X' })).toBe('');
  });
});

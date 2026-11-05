// tests/longdwell-sp-week.test.js - ISO week key + weekly link store
// (src/longdwell/sheet-links.js) and its host-local store registration.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const links = require('../src/longdwell/sheet-links');

function memStore() {
  const data = {};
  return {
    data,
    load: (k, def) => (k in data ? JSON.parse(JSON.stringify(data[k])) : def),
    update: (k, fn, def) => { const cur = k in data ? JSON.parse(JSON.stringify(data[k])) : def; data[k] = fn(cur); return data[k]; },
  };
}
const at = (y, m, d, h = 12, mi = 0) => new Date(y, m - 1, d, h, mi);

describe('isoWeekKey vectors', () => {
  const V = [
    [[2026, 11, 5], '2026-W45'], [[2026, 11, 8], '2026-W45'], [[2026, 11, 9], '2026-W46'],
    [[2025, 12, 29], '2026-W01'], [[2026, 12, 31], '2026-W53'], [[2027, 1, 1], '2026-W53'], [[2027, 1, 4], '2027-W01'],
  ];
  for (const [[y, m, d], key] of V) {
    it(y + '-' + m + '-' + d + ' -> ' + key, () => {
      expect(links.isoWeekKey(at(y, m, d))).toBe(key);
      expect(links.isoWeekKey(at(y, m, d, 0, 0))).toBe(key);
      expect(links.isoWeekKey(at(y, m, d, 23, 59))).toBe(key);
    });
  }
});

for (const zone of ['America/Los_Angeles', 'Europe/Berlin']) {
  describe('DST boundaries in ' + zone, () => {
    let prev;
    beforeAll(() => { prev = process.env.TZ; process.env.TZ = zone; });
    afterAll(() => { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; });
    it('spring-forward and fall-back days keep their ISO week', () => {
      // 2026: US DST starts Sun Mar 8, ends Sun Nov 1; EU starts Sun Mar 29, ends Sun Oct 25.
      for (const [y, m, d, key] of [[2026, 3, 8, '2026-W10'], [2026, 3, 29, '2026-W13'], [2026, 10, 25, '2026-W43'], [2026, 11, 1, '2026-W44']]) {
        expect(links.isoWeekKey(at(y, m, d, 0, 30))).toBe(key);
        expect(links.isoWeekKey(at(y, m, d, 23, 30))).toBe(key);
      }
      // Monday after the change starts the next week.
      expect(links.isoWeekKey(at(2026, 3, 30, 0, 30))).toBe('2026-W14');
      expect(links.isoWeekKey(at(2026, 11, 2, 0, 30))).toBe('2026-W45');
    });
  });
}

describe('link store (in-memory store)', () => {
  it('setLink stores under the current week and getLink reads it', () => {
    const store = memStore();
    const now = () => at(2026, 11, 5);
    const r = links.setLink(undefined, { url: 'https://x.sharepoint.com/a.xlsx', kind: 'direct-path' }, { store, now });
    expect(r.weekKey).toBe('2026-W45');
    expect(links.getLink(undefined, { store, now })).toMatchObject({ url: 'https://x.sharepoint.com/a.xlsx', kind: 'direct-path', resolved: null, lastWrite: null });
  });
  it('week rollover: a W45 link is not returned for W46, history kept', () => {
    const store = memStore();
    links.setLink(undefined, { url: 'https://x.sharepoint.com/w45.xlsx', kind: 'direct-path' }, { store, now: () => at(2026, 11, 8, 23, 59) });
    const w46 = { store, now: () => at(2026, 11, 9, 0, 1) };
    expect(links.getLink(undefined, w46)).toBe(null);
    expect(links.getLink('2026-W45', w46).url).toBe('https://x.sharepoint.com/w45.xlsx');
    expect(Object.keys(store.data.longDwellSheetLinks.links)).toEqual(['2026-W45']);
  });
  it('prunes to the newest 26 weeks', () => {
    const store = memStore();
    for (let i = 0; i < 30; i++) {
      const d = new Date(2026, 0, 5 + i * 7, 12);
      links.setLink(undefined, { url: 'https://x.sharepoint.com/' + i + '.xlsx', kind: 'direct-path' }, { store, now: () => d });
    }
    const keys = Object.keys(store.data.longDwellSheetLinks.links).sort();
    expect(keys).toHaveLength(26);
    expect(keys[0]).toBe('2026-W06');
    expect(keys[25]).toBe('2026-W31');
  });
  it('setLink replaces the whole record: resolved, tab and lastWrite are dropped', () => {
    const store = memStore();
    const deps = { store, now: () => at(2026, 11, 5) };
    links.setLink(undefined, { url: 'https://x.sharepoint.com/a.xlsx', kind: 'direct-path' }, deps);
    const res = links.setResolved(undefined, { host: 'x.sharepoint.com', serverRelativeUrl: '/sites/a/a.xlsx', tab: 'Week 45' }, deps);
    expect(res.forUrlSha256).toBe(links.sha256('https://x.sharepoint.com/a.xlsx'));
    expect(res.tab).toBe('Week 45');
    links.markWrite(undefined, { written: 3, failed: 1, text: 'ignored' }, deps);
    const before = links.getLink(undefined, deps);
    expect(before.resolved.tab).toBe('Week 45');
    expect(before.lastWrite).toMatchObject({ written: 3, failed: 1 });
    expect(before.lastWrite.text).toBeUndefined();
    links.setLink(undefined, { url: 'https://x.sharepoint.com/b.xlsx', kind: 'direct-path' }, deps);
    const after = links.getLink(undefined, deps);
    expect(after).toEqual({ url: 'https://x.sharepoint.com/b.xlsx', kind: 'direct-path', setAt: after.setAt, resolved: null, lastWrite: null });
  });
  it('resolvedFor ignores a resolution made for another URL', () => {
    const rec = { url: 'https://x.sharepoint.com/b.xlsx', resolved: { forUrlSha256: links.sha256('https://x.sharepoint.com/a.xlsx'), tab: 'T' } };
    expect(links.resolvedFor(rec)).toBe(null);
    rec.resolved.forUrlSha256 = links.sha256(rec.url);
    expect(links.resolvedFor(rec).tab).toBe('T');
  });
  it('clearLink removes only the current week', () => {
    const store = memStore();
    links.setLink('2026-W44', { url: 'https://x.sharepoint.com/44.xlsx' }, { store });
    const deps = { store, now: () => at(2026, 11, 5) };
    links.setLink(undefined, { url: 'https://x.sharepoint.com/45.xlsx' }, deps);
    expect(links.clearLink(undefined, deps)).toBe(true);
    expect(links.clearLink(undefined, deps)).toBe(false);
    expect(links.getLink('2026-W44', deps).url).toContain('44');
  });
});

describe('link sources', () => {
  afterEach(() => links._resetSourcesForTests());
  it('manual is the only default source', () => {
    expect(links.sources.map((s) => s.id)).toEqual(['manual']);
  });
  it('findLink returns the stored manual link with confidence user, or null', async () => {
    const store = memStore();
    const deps = { store, now: () => at(2026, 11, 5) };
    expect(await links.findLink(undefined, deps)).toBe(null);
    links.setLink(undefined, { url: 'https://x.sharepoint.com/a.xlsx' }, deps);
    expect(await links.findLink(undefined, deps)).toMatchObject({ url: 'https://x.sharepoint.com/a.xlsx', confidence: 'user', source: 'manual' });
  });
  it('registerSource order: first non-null wins; a throwing source is skipped', async () => {
    const store = memStore();
    const deps = { store, now: () => at(2026, 11, 5) };
    links.registerSource({ id: 'boom', find: async () => { throw new Error('x'); } });
    links.registerSource({ id: 'slack', find: async (wk) => ({ url: 'https://x.sharepoint.com/' + wk + '.xlsx', confidence: 'low', source: 'slack' }) });
    expect((await links.findLink(undefined, deps)).source).toBe('slack');
    links.setLink(undefined, { url: 'https://x.sharepoint.com/m.xlsx' }, deps);
    expect((await links.findLink(undefined, deps)).source).toBe('manual');
    expect(() => links.registerSource({ id: 'slack', find: async () => null })).toThrow();
    expect(() => links.registerSource({ id: 'bad' })).toThrow();
  });
});

describe('store registration (host-local)', () => {
  it('longDwellSheetLinks is a registered store key and is not cluster-shared', () => {
    const store = require('../src/store');
    expect('longDwellSheetLinks' in store.REGISTRY).toBe(true);
    const { isShared } = require('../src/cluster/sync-engine');
    expect(isShared('longDwellSheetLinks')).toBe(false);
  });
  it('real-store round trip', () => {
    const paths = require('../src/config/paths');
    const engine = require('../src/store/sqlite_engine');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ldsp-week-'));
    try {
      engine.close();
      paths.setDataDir(tmp);
      const now = () => at(2026, 11, 5);
      links.setLink(undefined, { url: 'https://x.sharepoint.com/real.xlsx', kind: 'direct-path' }, { now });
      engine.close();
      expect(links.getLink(undefined, { now }).url).toBe('https://x.sharepoint.com/real.xlsx');
    } finally {
      engine.close();
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });
});

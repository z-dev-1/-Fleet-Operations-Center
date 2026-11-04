// tests/awareness-screen-context.test.js
//
// Screen-context holder and sender guard (src/orcha/awareness/screen-context.js), design §D3, §D16.6 (AC20).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

vi.mock('../renderer/src/js/bridge.js', () => ({ assistant: {} }));
vi.mock('../renderer/src/js/bus.js', () => ({ default: { on() {}, emit() {}, off() {} } }));
import { buildPayload } from '../renderer/src/js/screen-context.js';
const require = createRequire(import.meta.url);
const sc = require('../src/orcha/awareness/screen-context');
const { ConfigError } = require('../src/utils/errors');

const T0 = Date.parse('2026-11-01T12:00:00Z');
const sender = (url) => ({ sender: { getURL: () => url } });

beforeEach(() => sc._resetForTests());

describe('sanitize', () => {
  it('drops unknown keys and filter keys outside the allow-list', () => {
    const out = sc.sanitize({ view: 'fleet', unitId: '322504', evil: 'x', filters: { vendor: 'Rush', password: 'p', operator: 'ACME' } });
    expect(out).toEqual({ view: 'fleet', unitId: '322504', filters: { vendor: 'Rush', operator: 'ACME' } });
  });

  it('coerces tab to the allow-list or null', () => {
    expect(sc.sanitize({ tab: 'repair' }).tab).toBe('repair');
    expect(sc.sanitize({ tab: 'settings' }).tab).toBeNull();
    expect(sc.sanitize({ tab: 7 }).tab).toBeNull();
  });

  it('clamps secondaryWrCount to 0–20', () => {
    expect(sc.sanitize({ secondaryWrCount: 99 }).secondaryWrCount).toBe(20);
    expect(sc.sanitize({ secondaryWrCount: -3 }).secondaryWrCount).toBe(0);
    expect(sc.sanitize({ secondaryWrCount: 2.7 }).secondaryWrCount).toBe(2);
  });

  it('over-length top-level strings throw ConfigError', () => {
    expect(() => sc.sanitize({ unitId: 'x'.repeat(33) })).toThrow(ConfigError);
    expect(() => sc.sanitize({ view: 'x'.repeat(33) })).toThrow(ConfigError);
    expect(() => sc.sanitize({ wrId: 'x'.repeat(65) })).toThrow(ConfigError);
    expect(() => sc.sanitize({ search: 'x'.repeat(81) })).toThrow(ConfigError);
    expect(() => sc.sanitize({ quickFilter: 'x'.repeat(33) })).toThrow(ConfigError);
    expect(() => sc.sanitize('nope')).toThrow(ConfigError);
    expect(() => sc.sanitize(null)).toThrow(ConfigError);
  });

  it('filter value of 65 chars → that key dropped, no throw', () => {
    const out = sc.sanitize({ filters: { vendor: 'x'.repeat(65), operator: 'ACME', lifecycleState: 5 } });
    expect(out.filters).toEqual({ operator: 'ACME' });
  });
});

describe('set / get', () => {
  it('get respects maxAgeMs; rejected set leaves holder unchanged', () => {
    sc.set({ unitId: 'A1', tab: 'repair' }, T0);
    expect(sc.get({ maxAgeMs: 10 * 60 * 1000, nowMs: T0 + 5 * 60 * 1000 })).toMatchObject({ unitId: 'A1', tab: 'repair', receivedAt: T0 });
    expect(sc.get({ maxAgeMs: 10 * 60 * 1000, nowMs: T0 + 11 * 60 * 1000 })).toBeNull();
    expect(() => sc.set({ unitId: 'x'.repeat(40) }, T0 + 1000)).toThrow(ConfigError);
    expect(sc.get({ nowMs: T0 + 1000 })).toMatchObject({ unitId: 'A1', receivedAt: T0 });
  });

  it('heartbeat refreshes receivedAt', () => {
    sc.set({ unitId: 'A1' }, T0);
    sc.set({ unitId: 'A1' }, T0 + 60000);
    expect(sc.get({ nowMs: T0 + 60000 }).receivedAt).toBe(T0 + 60000);
  });

  it('empty holder → null', () => {
    expect(sc.get({ maxAgeMs: 1000, nowMs: T0 })).toBeNull();
  });
});

describe('renderer buildPayload → main sanitize (seam)', () => {
  it('initial / unset state is accepted (no null view/quickFilter/search sent)', () => {
    const p = buildPayload({ view: null, unitId: null, tab: null, wrId: null, secondaryWrCount: 0, filters: {}, quickFilter: null, search: null });
    expect(p).not.toHaveProperty('view');
    expect(p).not.toHaveProperty('quickFilter');
    expect(p).not.toHaveProperty('search');
    expect(() => sc.sanitize(p)).not.toThrow();
    expect(() => sc.sanitize(buildPayload(undefined))).not.toThrow();
  });

  it('populated state round-trips, over-long strings clipped to main limits', () => {
    const p = buildPayload({ view: 'fleet', unitId: '322504', tab: 'repair', wrId: 'WR-1', secondaryWrCount: 2,
      filters: { vendor: 'Rush' }, quickFilter: 'down', search: 'x'.repeat(200) });
    expect(sc.sanitize(p)).toEqual({ view: 'fleet', unitId: '322504', tab: 'repair', wrId: 'WR-1', secondaryWrCount: 2,
      filters: { vendor: 'Rush' }, quickFilter: 'down', search: 'x'.repeat(80) });
  });
});

describe('_isAppSender (AC20)', () => {
  it('accepts file: and http://localhost:5173 only', () => {
    expect(sc._isAppSender(sender('file:///C:/app/dist/renderer/index.html'))).toBe(true);
    expect(sc._isAppSender(sender('http://localhost:5173/'))).toBe(true);
    expect(sc._isAppSender(sender('https://aap-na.corp.amazon.com/assets/123'))).toBe(false);
    expect(sc._isAppSender(sender('https://evil.example/?a=localhost:5173'))).toBe(false);
    expect(sc._isAppSender(sender('https://x/dist/renderer/'))).toBe(false);
    expect(sc._isAppSender(sender('http://localhost:5174/'))).toBe(false);
  });

  it('returns false when getURL throws or returns garbage', () => {
    expect(sc._isAppSender({ sender: { getURL: () => { throw new Error('gone'); } } })).toBe(false);
    expect(sc._isAppSender(sender('not a url'))).toBe(false);
    expect(sc._isAppSender(sender(undefined))).toBe(false);
    expect(sc._isAppSender({})).toBe(false);
  });
});

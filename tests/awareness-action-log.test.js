// tests/awareness-action-log.test.js
//
// Action memory ring buffer (src/orcha/awareness/action-log.js), design §D7, test plan §D16.4.
// The two static source checks on src/ipc/scrapers.js / src/ipc/ai.js are added with the hooks (FEAT-002).
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const al = require('../src/orcha/awareness/action-log');

const H = 3600 * 1000;
const T0 = Date.parse('2026-11-01T12:00:00Z');
const QUIET = { info() {}, warn() {}, debug() {} };

function fakeStore(init = {}) {
  const data = JSON.parse(JSON.stringify(init));
  return { data, load: (k, d) => (k in data ? data[k] : d), save: vi.fn((k, v) => { data[k] = v; }) };
}
const depsAt = (fs, t) => ({ load: fs.load, save: fs.save, now: () => t, log: QUIET });

describe('record / recent', () => {
  it('ring cap 50, newest first', () => {
    const fs = fakeStore();
    for (let i = 0; i < 60; i++) al.record({ type: 'timeline-add', unit: 'U' + i, detail: 'd' + i, actor: 'user' }, depsAt(fs, T0 + i));
    const acts = fs.data.assistantActionLog.actions;
    expect(acts).toHaveLength(50);
    expect(acts[0].unit).toBe('U59');
    expect(acts[49].unit).toBe('U10');
  });

  it('recent(8, 72h) honors window and limit', () => {
    const fs = fakeStore();
    for (let i = 0; i < 5; i++) al.record({ type: 'notes-saved', unit: 'OLD' + i }, depsAt(fs, T0 - 80 * H));
    for (let i = 0; i < 12; i++) al.record({ type: 'notes-saved', unit: 'NEW' + i }, depsAt(fs, T0 - H));
    const r = al.recent(8, 72 * H, { load: fs.load, now: () => T0 });
    expect(r).toHaveLength(8);
    expect(r.every((a) => a.unit.startsWith('NEW'))).toBe(true);
    const fs2 = fakeStore();
    al.record({ type: 'notes-saved', unit: 'OLD' }, depsAt(fs2, T0 - 80 * H));
    expect(al.recent(8, 72 * H, { load: fs2.load, now: () => T0 })).toEqual([]);
  });

  it('redacts xoxc-, xoxd-, Bearer and JWT-like tokens', () => {
    const fs = fakeStore();
    al.record({ type: 'message-sent', detail: 'tok xoxc-1234-abcd and xoxd-ZZZ-9 Bearer abc.def eyJhbGciOi.eyJzdWIi.c2lnbmF0dXJl end' }, depsAt(fs, T0));
    const d = fs.data.assistantActionLog.actions[0].detail;
    expect(d).not.toMatch(/xoxc-|xoxd-|Bearer abc|eyJhbGciOi/);
    expect(d).toContain('[redacted]');
    expect(d).toContain('end');
  });

  it('truncates detail to 160', () => {
    const fs = fakeStore();
    al.record({ type: 'timeline-add', detail: 'word '.repeat(100) }, depsAt(fs, T0));
    expect(fs.data.assistantActionLog.actions[0].detail.length).toBe(160);
  });

  it('unknown type ignored', () => {
    const fs = fakeStore();
    al.record({ type: 'send-to-carrier', unit: '1' }, depsAt(fs, T0));
    expect(fs.save).not.toHaveBeenCalled();
  });

  it('record never throws when save throws (AC17)', () => {
    const deps = { load: () => null, save: () => { throw new Error('disk'); }, now: () => T0, log: QUIET };
    expect(() => al.record({ type: 'timeline-add', unit: '1' }, deps)).not.toThrow();
    expect(() => al.record(null, deps)).not.toThrow();
  });
});

describe('resolveUnit', () => {
  const fs = fakeStore({ fleetData: { rows: [
    { equipmentId: 'A1', workRequestId: 'WR-A', assetUrl: 'https://aap/assets/AAID-111' },
    { equipmentId: 'B2', workRequestId: 'WR-B', _secondaryWRs: [{ workRequestId: 'WR-B2' }], assetUrl: 'https://aap/assets/AAID-222' },
  ] } });
  const deps = { load: fs.load };
  it('by workRequestId, secondary WR and aaid', () => {
    expect(al.resolveUnit({ workRequestId: 'WR-A' }, deps)).toBe('A1');
    expect(al.resolveUnit({ workRequestId: 'WR-B2' }, deps)).toBe('B2');
    expect(al.resolveUnit({ aaid: 'AAID-222' }, deps)).toBe('B2');
    expect(al.resolveUnit({ equipmentId: 'A1' }, deps)).toBe('A1');
    expect(al.resolveUnit({ workRequestId: 'nope' }, deps)).toBeNull();
  });
});

describe('mappers (AC26)', () => {
  it('fromCreateWr: commit → record (tow suffix); draft/error/no id → null', () => {
    const r = al.fromCreateWr({ ok: true, phase: 'commit', workRequestId: 'WR9' }, { unitId: 'A1', vendor: 'Rush', towDirection: 'to-vendor' });
    expect(r).toEqual({ type: 'wr-created', unit: 'A1', wr: 'WR9', detail: 'vendor Rush (tow)', actor: 'user' });
    expect(al.fromCreateWr({ ok: true, phase: 'commit', workRequestId: 'WR9' }, { unitId: 'A1', vendor: 'Rush' }).detail).toBe('vendor Rush');
    expect(al.fromCreateWr({ ok: true, phase: 'draft', workRequestId: 'WR9' }, {})).toBeNull();
    expect(al.fromCreateWr({ ok: false, phase: 'commit', workRequestId: 'WR9', error: 'x' }, {})).toBeNull();
    expect(al.fromCreateWr({ ok: true, phase: 'commit' }, {})).toBeNull();
    expect(al.fromCreateWr(null, {})).toBeNull();
  });

  it('fromEscalationUpdate: add+remove → 2 records with unit and wr; comment never appears', () => {
    const payload = { add: ['MCS Lead'], remove: ['Ops'], workRequestId: 'WR1', comment: 'SECRET COMMENT BODY' };
    const recs = al.fromEscalationUpdate(payload, 'A1');
    expect(recs.map((r) => [r.type, r.unit, r.wr, r.detail])).toEqual([['escalation', 'A1', 'WR1', 'MCS Lead'], ['de-escalation', 'A1', 'WR1', 'Ops']]);
    expect(JSON.stringify(recs)).not.toContain('SECRET');
    expect(al.fromEscalationUpdate({ add: ['X'], workRequestId: 'WR1' }, null)[0].unit).toBeNull();
    expect(al.fromEscalationUpdate({ workRequestId: 'WR1' }, 'A1')).toEqual([]);
  });

  it('fromLifecycleResult: success:false → null', () => {
    expect(al.fromLifecycleResult({ success: false }, { unitId: 'A1', state: 'Available' })).toBeNull();
    expect(al.fromLifecycleResult({ success: true }, { unitId: 'A1', state: 'Available', reason: 'Repaired' }))
      .toMatchObject({ type: 'lifecycle-set', unit: 'A1', detail: 'Available / Repaired' });
  });

  it('fromConfirmSend for slack / email / lifecycle / approve-wr; not ok → null', () => {
    expect(al.fromConfirmSend({ channel: 'slack', recipientName: 'Bob', message: 'BODY' }, { ok: true })).toMatchObject({ type: 'message-sent', detail: 'Slack to Bob' });
    expect(al.fromConfirmSend({ channel: 'email', to: 'a@example.com', body: 'BODY' }, { ok: true })).toMatchObject({ type: 'email-sent', detail: 'email to a@example.com' });
    expect(al.fromConfirmSend({ channel: 'lifecycle', unitId: 'A1', state: 'Available' }, { ok: true })).toMatchObject({ type: 'lifecycle-set', unit: 'A1' });
    expect(al.fromConfirmSend({ channel: 'approve-wr', unitId: 'A1' }, { ok: true, workRequestId: 'WR7' })).toMatchObject({ type: 'wr-created', wr: 'WR7' });
    expect(JSON.stringify(al.fromConfirmSend({ channel: 'slack', recipientName: 'Bob', message: 'BODY' }, { ok: true }))).not.toContain('BODY');
    expect(al.fromConfirmSend({ channel: 'slack' }, { ok: false })).toBeNull();
  });

  it('fromTimeline truncates to 160 and maps kinds', () => {
    const r = al.fromTimeline('add', 'A1', 'x'.repeat(300), 'user');
    expect(r.type).toBe('timeline-add');
    expect(r.detail.length).toBeLessThanOrEqual(160);
    expect(al.fromTimeline('edit', 'A1', 'e', 'user-via-orcha')).toMatchObject({ type: 'timeline-edit', actor: 'user-via-orcha' });
    expect(al.fromTimeline('hide', 'A1', '', 'user').type).toBe('timeline-hide');
    expect(al.fromTimeline('bogus', 'A1', '', 'user')).toBeNull();
  });
});

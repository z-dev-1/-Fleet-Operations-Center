// tests/email-intel-notify.test.js — notifications (design 5.4; R4.12): notify once, escalation only, never for
// recorded / informational / out-of-scope / suggested replies, one batched OS notification with counts and unit ids only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let tmp; let flags; let S; let N;
const NOW = Date.parse('2026-11-04T20:00:00.000Z');
const item = (id, o) => Object.assign({ actionId: id, category: 'reply', tier: 'required', state: 'open', conversationKey: 'cv_' + id, units: ['40123'], reasonCode: 'reply-me',
  subject: 'SUBJ-SENTINEL', reasonText: 'NAME-SENTINEL asked you', notifiedAt: null, notifyCount: 0, escalations: 0, notifiedEscalations: 0, firstSeenAt: new Date(NOW).toISOString(), lastChangedAt: new Date(NOW).toISOString() }, o);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ei-notify-'));
  require('../src/config/paths').setDataDir(tmp);
  flags = require('../src/email-intel/flags');
  flags._setForTests({ enabled: true, capture: true, multiRecipient: true, actionsView: true });
  S = require('../src/email-intel/actions/store');
  N = require('../src/email-intel/actions/notify');
});
afterEach(() => { flags._setForTests(null); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* tmp */ } });

function seed(items) { S.update((doc) => { for (const x of items) doc.items[x.actionId] = x; }); }

describe('R4.12 notify once, escalation only', () => {
  it('R4.12 notify once, escalation only', () => {
    seed([
      item('a1'),                                                                      // reply required: yes
      item('a2', { category: 'decision', tier: 'suggested', units: ['40456'] }),        // decision (any tier): yes
      item('a3', { category: 'review', tier: 'required', reasonCode: 'conflict-canonical', units: ['40789'] }),   // conflict review: yes
      item('a4', { category: 'review', tier: 'suggested', reasonCode: 'low-confidence' }),                          // other review: no
      item('a5', { category: 'reply', tier: 'suggested' }),                            // suggested reply: no
      item('a6', { category: 'recorded', tier: 'fyi' }), item('a7', { category: 'info', tier: 'fyi' }), item('a8', { category: 'outofscope', tier: 'fyi' }),
      item('a9', { state: 'dismissed' }), item('a10', { state: 'snoozed' }), item('a11', { state: 'done-auto' }),
      item('a12', { category: 'followup', units: ['40999'] }),                           // overdue follow-up: yes
    ]);
    const os1 = vi.fn(() => true);
    const push = vi.fn();
    const r1 = N.notifyPending({ now: NOW, osNotify: os1, push });
    expect(r1.notified).toBe(4);
    expect(os1).toHaveBeenCalledTimes(1);                                              // batched: one OS notification per scan
    const msg = os1.mock.calls[0][0];
    expect(msg.title).toBe('My Email Actions');
    expect(msg.body).toBe('1 item needs your decision; 1 reply needed; 1 follow-up overdue; 1 conflicting update to review (40123, 40456, 40789, 40999)');
    expect(msg.body).not.toMatch(/SENTINEL/);
    expect(push).toHaveBeenCalledWith({ kind: 'actions', notified: 4 });
    const doc = S.load();
    for (const id of ['a1', 'a2', 'a3', 'a12']) expect(doc.items[id]).toMatchObject({ notifyCount: 1, notifiedAt: new Date(NOW).toISOString() });
    for (const id of ['a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11']) expect(doc.items[id].notifyCount).toBe(0);
    // a rescan: nothing new, nothing re-notified
    const os2 = vi.fn(() => true);
    expect(N.notifyPending({ now: NOW + 1000, osNotify: os2 })).toEqual({ notified: 0, body: null });
    expect(os2).not.toHaveBeenCalled();
    // an escalation re-notifies that item exactly once
    S.update((d) => { d.items.a2.tier = 'required'; d.items.a2.escalations = 1; });
    const os3 = vi.fn(() => true);
    expect(N.notifyPending({ now: NOW + 2000, osNotify: os3 }).notified).toBe(1);
    expect(os3.mock.calls[0][0].body).toBe('1 item needs your decision (40456)');
    expect(N.notifyPending({ now: NOW + 3000, osNotify: os3 }).notified).toBe(0);
    expect(S.load().items.a2.notifyCount).toBe(2);
  });

  it('no Notification support: in-app only, items still marked once; a throwing notifier never breaks the scan', () => {
    seed([item('b1')]);
    const r = N.notifyPending({ now: NOW, osNotify: () => { throw new Error('unsupported'); } });
    expect(r.notified).toBe(1);
    expect(N.notifyPending({ now: NOW }).notified).toBe(0);
    seed([item('b2')]);
    expect(N.notifyPending({ now: NOW }).notified).toBe(1);                          // default notifier: electron stub has no Notification
  });

  it('eligibility table', () => {
    expect(N.eligible(item('x'))).toBe(true);
    expect(N.eligible(item('x', { notifiedAt: 'y', escalations: 0, notifiedEscalations: 0 }))).toBe(false);
    expect(N.eligible(item('x', { notifiedAt: 'y', escalations: 2, notifiedEscalations: 1 }))).toBe(true);
    expect(N.eligible(item('x', { category: 'review', reasonCode: 'conflict-ready' }))).toBe(true);
    expect(N.eligible(null)).toBe(false);
    expect(N.buildMessage([item('a', { units: ['<b>1</b>'] })]).body).toBe('1 reply needed (b1b)');
  });
});

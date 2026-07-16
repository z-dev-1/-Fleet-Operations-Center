// tests/slack-dm-polling.test.js
//
// Coverage for the 2026-07-16 readDMs() rewrite (src/scrapers/slack_send.js).
//
// TWO bugs found and fixed while investigating the user's question "will I
// know when I get a message?":
//
// BUG 1 -- dead on arrival: the original readDMs() called
// conversations.list({types:'im'}), which Amazon's Enterprise Grid Slack
// workspace blocks (error: enterprise_is_restricted -- verified live
// against the real API with the user's authenticated session). It threw on
// every single call; the poller's try/catch swallowed it silently, so DM
// notifications have never worked, ever -- not a sync/timing issue.
//
// BUG 2 -- shape mismatch, independent of bug 1: the original return shape
// was [{ channelId, userId, unread, messages: [...] }], but the only
// consumer (orcha-fab.js's _startSlackPoll) reads msg.ts / msg.text /
// msg.user directly off each array item -- fields that never existed at
// that nesting level. Even without bug 1, notifications would never have
// fired correctly.
//
// FIX: client.counts (verified NOT subject to the same restriction) gives
// per-DM has_unreads flags without needing to "list" conversations. These
// tests mirror the pure logic in isolation (filtering, de-dup, shape),
// following the existing project convention of testing extracted logic
// rather than live network calls.

import { describe, it, expect } from 'vitest';

// Mirrors readDMs()'s unread-filtering + slice logic against client.counts'
// ims array shape.
function selectUnreadDMs(imsFromClientCounts, limit) {
  const lim = Math.min(Number(limit) || 20, 39);
  return imsFromClientCounts.filter(im => im.has_unreads).slice(0, lim);
}

// Mirrors the de-dup logic that prevents the same unread message from
// re-notifying on every 30s poll (since has_unreads doesn't clear without
// calling conversations.mark, which we deliberately do NOT call).
function dedupeAgainstSeen(candidates, seenSet) {
  const out = [];
  for (const c of candidates) {
    const key = c.channelId + ':' + c.ts;
    if (seenSet.has(key)) continue;
    seenSet.add(key);
    out.push(c);
  }
  return out;
}

// Mirrors the final result shape assembly: { ts, text, user, channelId }
// -- matches what _startSlackPoll in orcha-fab.js actually reads
// (msg.ts, msg.text, msg.user), unlike the old nested shape which never
// matched what the consumer expected.
function buildResultEntry(latestMessage, resolvedSenderName, channelId) {
  return {
    ts: latestMessage.ts,
    text: latestMessage.text,
    user: resolvedSenderName || latestMessage.userId || 'Slack',
    channelId
  };
}

describe('readDMs() unread selection (via client.counts, not conversations.list)', () => {
  it('only selects DMs with has_unreads true', () => {
    const ims = [
      { id: 'D1', has_unreads: true },
      { id: 'D2', has_unreads: false },
      { id: 'D3', has_unreads: true },
    ];
    const selected = selectUnreadDMs(ims, 20);
    expect(selected.map(i => i.id)).toEqual(['D1', 'D3']);
  });

  it('respects the limit parameter, capped at 39 (the real workspace DM count observed)', () => {
    const ims = Array.from({ length: 50 }, (_, i) => ({ id: 'D' + i, has_unreads: true }));
    expect(selectUnreadDMs(ims, 100)).toHaveLength(39);
    expect(selectUnreadDMs(ims, 5)).toHaveLength(5);
  });

  it('returns an empty array when nothing is unread (normal steady-state)', () => {
    const ims = [{ id: 'D1', has_unreads: false }, { id: 'D2', has_unreads: false }];
    expect(selectUnreadDMs(ims, 20)).toEqual([]);
  });
});

describe('readDMs() de-duplication (prevents re-notifying the same message forever)', () => {
  it('surfaces a message once, then suppresses it on a later poll with the same ts', () => {
    const seen = new Set();
    const first = dedupeAgainstSeen([{ channelId: 'D1', ts: '123.456' }], seen);
    expect(first).toHaveLength(1);
    const second = dedupeAgainstSeen([{ channelId: 'D1', ts: '123.456' }], seen);
    expect(second).toHaveLength(0);
  });

  it('still surfaces a genuinely NEW message in the same DM (different ts)', () => {
    const seen = new Set();
    dedupeAgainstSeen([{ channelId: 'D1', ts: '123.456' }], seen);
    const next = dedupeAgainstSeen([{ channelId: 'D1', ts: '789.012' }], seen);
    expect(next).toHaveLength(1);
  });

  it('tracks distinct DMs independently by channelId', () => {
    const seen = new Set();
    dedupeAgainstSeen([{ channelId: 'D1', ts: '1.0' }], seen);
    const other = dedupeAgainstSeen([{ channelId: 'D2', ts: '1.0' }], seen);
    // same ts value, different channel -- must NOT be suppressed
    expect(other).toHaveLength(1);
  });
});

describe('readDMs() result shape (must match what _startSlackPoll actually reads)', () => {
  it('produces a flat {ts, text, user, channelId} entry, not a nested {messages:[...]} shape', () => {
    const entry = buildResultEntry({ ts: '1.0', text: 'hey', userId: 'U1' }, 'Melissa McClain', 'D1');
    expect(entry).toEqual({ ts: '1.0', text: 'hey', user: 'Melissa McClain', channelId: 'D1' });
    // The exact fields _startSlackPoll dereferences directly:
    expect(entry.ts).toBeDefined();
    expect(entry.text).toBeDefined();
    expect(entry.user).toBeDefined();
  });

  it('falls back to the raw userId when sender name resolution fails', () => {
    const entry = buildResultEntry({ ts: '1.0', text: 'hey', userId: 'U1' }, null, 'D1');
    expect(entry.user).toBe('U1');
  });

  it('falls back to "Slack" when neither a resolved name nor a userId is available', () => {
    const entry = buildResultEntry({ ts: '1.0', text: 'hey' }, null, 'D1');
    expect(entry.user).toBe('Slack');
  });
});

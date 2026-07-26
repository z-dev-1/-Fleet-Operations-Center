// tests/slack-thread-continuation.test.js
//
// Coverage for the 2026-07-26 fix: "does it know when someone keeps a
// conversation in thread and keeps replying in thread?"
//
// TWO separate bugs found and fixed:
//
// BUG 1 (DM Auto-Reply, src/scrapers/slack_dm_autoreply.js): the reply
// send call never passed a threadTs, so DM replies always posted as new
// top-level messages even when the incoming message was itself part of a
// thread. Fix: pass msg.threadTs (captured by readMessages() already, just
// unused) through to sendToChannel()'s existing optional third param.
// Since msg.threadTs is null for ordinary top-level messages, this is a
// no-op for the default/existing behavior -- only messages already inside
// a thread get a threaded reply.
//
// BUG 2 (Partner Auto-Reply channels, src/scrapers/slack_channel_watch.js):
// conversations.history (used by readMessages()) only returns a channel's
// TOP-LEVEL message timeline -- it does NOT include thread reply messages.
// That silently broke the existing TIER 2 "continue replying in a thread I
// was @mentioned in" logic (_isInMentionThread): the tracked thread exists
// and the gate itself is correct, but the actual continuation messages
// never reached the candidate pool in the first place, so they were never
// even logged, let alone replied to. Fix: readThreadReplies() (new,
// conversations.replies) fetches real replies for the channel's tracked
// mention-threads, merged into the candidate pool before any existing
// filtering/tiering runs.
//
// Both tests mirror the pure logic in isolation, following the existing
// project convention (live Slack Web API calls aren't easily mockable in
// this Vitest CJS setup) -- see slack-dm-polling.test.js and
// slack-group-dm.test.js for the pattern.

import { describe, it, expect } from 'vitest';

// Mirrors slack_dm_autoreply.js's fixed reply call: sendToChannel(channelId,
// text, msg.threadTs || undefined). Returns the payload sendToChannel would
// build, mirroring the "only set thread_ts if threadTs is truthy" logic
// confirmed live in slack_send.js's sendToChannel().
function buildDmReplyPayload(channelId, text, msg) {
  const payload = { channel: channelId, text };
  const threadTs = msg.threadTs || undefined;
  if (threadTs) payload.thread_ts = threadTs;
  return payload;
}

// Mirrors the merge step added to pollChannelsOnce(): combine root messages
// (from readMessages/conversations.history) with reply messages (from
// readThreadReplies/conversations.replies) for the channel's currently
// tracked mention-threads, deduped by ts, sorted newest-first -- exactly
// what the real code does before any existing filtering/tiering runs.
function mergeThreadReplies(rootMessages, replyBatches) {
  const seenTs = new Set(rootMessages.map(m => m.ts));
  const extra = [];
  for (const batch of replyBatches) {
    for (const m of batch) {
      if (!seenTs.has(m.ts)) { seenTs.add(m.ts); extra.push(m); }
    }
  }
  if (!extra.length) return rootMessages;
  return rootMessages.concat(extra).sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));
}

describe('DM Auto-Reply: thread-aware replies (BUG 1 fix)', () => {
  it('does NOT set thread_ts for an ordinary top-level message (unchanged default behavior)', () => {
    const msg = { ts: '100.001', threadTs: null, text: 'hi' };
    const payload = buildDmReplyPayload('D123', 'reply text', msg);
    expect(payload).toEqual({ channel: 'D123', text: 'reply text' });
    expect(payload.thread_ts).toBeUndefined();
  });

  it('DOES set thread_ts when the incoming message is part of a thread', () => {
    const msg = { ts: '100.005', threadTs: '100.001', text: 'continuing in thread' };
    const payload = buildDmReplyPayload('D123', 'reply text', msg);
    expect(payload.thread_ts).toBe('100.001');
  });

  it('handles a thread ROOT message (thread_ts === own ts) the same as any other threaded reply', () => {
    // Slack sets thread_ts === ts on the parent/root message of a thread.
    // Passing that value back as the reply's thread_ts is correct Slack
    // behavior (starts/continues the thread from its root).
    const msg = { ts: '100.001', threadTs: '100.001', text: 'root of a thread' };
    const payload = buildDmReplyPayload('D123', 'reply text', msg);
    expect(payload.thread_ts).toBe('100.001');
  });
});

describe('Partner Auto-Reply channels: thread-reply merge (BUG 2 fix)', () => {
  it('returns root messages unchanged when there are no tracked threads / no replies', () => {
    const roots = [{ ts: '300.0' }, { ts: '200.0' }];
    const merged = mergeThreadReplies(roots, []);
    expect(merged).toBe(roots); // same reference: confirms true no-op, not just equal content
  });

  it('merges in new thread-reply messages not already present in the root list', () => {
    const roots = [{ ts: '300.0' }, { ts: '100.0' }];
    const replyBatches = [
      [{ ts: '150.0' }, { ts: '160.0' }],
    ];
    const merged = mergeThreadReplies(roots, replyBatches);
    const tsSet = merged.map(m => m.ts);
    expect(tsSet).toEqual(['300.0', '160.0', '150.0', '100.0']); // newest-first
  });

  it('dedupes reply messages that already exist in the root list by ts', () => {
    const roots = [{ ts: '300.0' }, { ts: '100.0' }];
    // '300.0' shows up again in a reply batch (e.g. a reply-broadcast) --
    // must not be duplicated.
    const replyBatches = [[{ ts: '300.0' }, { ts: '150.0' }]];
    const merged = mergeThreadReplies(roots, replyBatches);
    expect(merged.filter(m => m.ts === '300.0').length).toBe(1);
    expect(merged.map(m => m.ts)).toEqual(['300.0', '150.0', '100.0']);
  });

  it('merges replies from multiple tracked threads correctly', () => {
    const roots = [{ ts: '500.0' }];
    const replyBatches = [
      [{ ts: '400.0' }],
      [{ ts: '450.0' }, { ts: '420.0' }],
    ];
    const merged = mergeThreadReplies(roots, replyBatches);
    expect(merged.map(m => m.ts)).toEqual(['500.0', '450.0', '420.0', '400.0']);
  });
});

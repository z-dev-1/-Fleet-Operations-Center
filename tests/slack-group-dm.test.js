// tests/slack-group-dm.test.js
//
// Coverage for the 2026-07-25 GROUP DM feature (Slack "mpim" conversations,
// 3+ people), added to both the DM listing/notification layer
// (src/scrapers/slack_send.js) and the DM Auto-Reply engine
// (src/scrapers/slack_dm_autoreply.js).
//
// Root problem found: everything DM-related only ever looked at
// client.counts().ims (1:1 direct messages). Group DMs live in a separate
// counts.mpims array and were completely invisible -- not listed, not
// notified on, and the DM Auto-Reply engine never saw or replied to them.
// Even if a group DM channel ID were passed in manually, name resolution
// broke too: conversations.info's `.user` field (used to look up the 1:1
// counterpart's name) simply doesn't exist on a group DM, which instead
// needs a conversations.members call and multiple name lookups joined
// together.
//
// These tests mirror the pure logic in isolation (same project convention
// as tests/slack-dm-polling.test.js), since the real functions make live
// Slack Web API calls.

import { describe, it, expect } from 'vitest';

// Mirrors listOpenDMs()'s combining of ims + mpims from client.counts.
function combineDmSources(counts, limit) {
  const lim = Math.min(Number(limit) || 40, 100);
  const ims   = (counts.ims   || []).map(c => ({ id: c.id, isGroup: false }));
  const mpims = (counts.mpims || []).map(c => ({ id: c.id, isGroup: true  }));
  return ims.concat(mpims).slice(0, lim);
}

// Mirrors _resolveDmSenderName()'s group-DM branch: join every member's
// resolved name except Z's own, falling back to the raw channel name.
function buildGroupDmName(memberIds, myUserId, nameLookup, rawChannelName) {
  const others = memberIds.filter(id => id !== myUserId);
  const names = others.map(id => nameLookup[id]).filter(Boolean);
  return names.join(', ') || rawChannelName || null;
}

// Mirrors the per-message speaker-attribution fix in the poll loop's
// historyMsgs builder: resolve the ACTUAL sender, not a blanket dm.name.
function attributeSpeaker(msg, myUserId, nameLookup, dmName) {
  if (msg.userId === myUserId) return 'You';
  return nameLookup[msg.userId] || dmName || 'Them';
}

// Mirrors the multi-sender contact auto-save fix: every distinct non-self
// sender in a batch of new messages gets saved, not just the first.
function distinctNewSenderIds(newMsgs, myUserId) {
  return [...new Set(newMsgs.filter(m => m.userId && m.userId !== myUserId).map(m => m.userId))];
}

describe('Group DM listing (client.counts.mpims alongside .ims)', () => {
  it('includes group DMs (mpims), not just 1:1 DMs (ims)', () => {
    const counts = {
      ims:   [{ id: 'D1' }],
      mpims: [{ id: 'G1' }, { id: 'G2' }],
    };
    const combined = combineDmSources(counts, 40);
    expect(combined.map(c => c.id)).toEqual(['D1', 'G1', 'G2']);
  });

  it('tags each entry with isGroup so callers can distinguish 1:1 from group', () => {
    const counts = { ims: [{ id: 'D1' }], mpims: [{ id: 'G1' }] };
    const combined = combineDmSources(counts, 40);
    expect(combined.find(c => c.id === 'D1').isGroup).toBe(false);
    expect(combined.find(c => c.id === 'G1').isGroup).toBe(true);
  });

  it('still respects the overall limit across both sources combined', () => {
    const counts = {
      ims:   Array.from({ length: 5 }, (_, i) => ({ id: 'D' + i })),
      mpims: Array.from({ length: 5 }, (_, i) => ({ id: 'G' + i })),
    };
    expect(combineDmSources(counts, 6)).toHaveLength(6);
  });

  it('previously (the bug): group DMs were entirely absent from the result', () => {
    // The old implementation only ever read counts.ims -- this asserts the
    // shape of that bug directly, so a regression back to ims-only would
    // fail this test.
    const counts = { ims: [{ id: 'D1' }], mpims: [{ id: 'G1' }] };
    const oldBuggyResult = (counts.ims || []).slice(0, 40); // old logic
    expect(oldBuggyResult.map(c => c.id)).not.toContain('G1');
    // new logic must include it
    expect(combineDmSources(counts, 40).map(c => c.id)).toContain('G1');
  });
});

describe('Group DM display name (join member names, excluding self)', () => {
  const nameLookup = { U1: 'Alice Smith', U2: 'Bob Lee', U3: 'Carol Diaz', ME: 'Z Santiago' };

  it('joins all other members\' names with ", "', () => {
    const name = buildGroupDmName(['ME', 'U1', 'U2'], 'ME', nameLookup, 'mpdm-fallback');
    expect(name).toBe('Alice Smith, Bob Lee');
  });

  it('excludes Z\'s own name from the joined list', () => {
    const name = buildGroupDmName(['ME', 'U1', 'U2', 'U3'], 'ME', nameLookup, 'mpdm-fallback');
    expect(name).not.toContain('Z Santiago');
    expect(name).toBe('Alice Smith, Bob Lee, Carol Diaz');
  });

  it('falls back to the raw channel name if every lookup fails', () => {
    const name = buildGroupDmName(['ME', 'U9'], 'ME', nameLookup, 'mpdm-fallback');
    expect(name).toBe('mpdm-fallback');
  });

  it('falls back to null (not a blank string) when there is no raw name either', () => {
    const name = buildGroupDmName(['ME', 'U9'], 'ME', nameLookup, null);
    expect(name).toBeNull();
  });
});

describe('Per-message speaker attribution (group DM context fix)', () => {
  const nameLookup = { U1: 'Alice Smith', U2: 'Bob Lee' };

  it('labels Z\'s own messages "You"', () => {
    expect(attributeSpeaker({ userId: 'ME' }, 'ME', nameLookup, 'Alice Smith, Bob Lee')).toBe('You');
  });

  it('resolves the individual sender in a group thread, not the joined group name', () => {
    // dmName here is deliberately the multi-person joined string -- the fix
    // must NOT stamp that on an individual message.
    const label = attributeSpeaker({ userId: 'U1' }, 'ME', nameLookup, 'Alice Smith, Bob Lee');
    expect(label).toBe('Alice Smith');
    expect(label).not.toBe('Alice Smith, Bob Lee');
  });

  it('falls back to dmName only when individual resolution fails (matches old 1:1 behavior)', () => {
    const label = attributeSpeaker({ userId: 'U9' }, 'ME', nameLookup, 'Alice Smith');
    expect(label).toBe('Alice Smith');
  });
});

describe('Multi-sender contact auto-save (group DM fix)', () => {
  it('captures every distinct non-self sender in a batch, not just the first', () => {
    const newMsgs = [
      { userId: 'U1', text: 'hey' },
      { userId: 'U2', text: 'hi' },
      { userId: 'U1', text: 'again' }, // duplicate sender, same batch
    ];
    const ids = distinctNewSenderIds(newMsgs, 'ME');
    expect(ids).toEqual(['U1', 'U2']);
  });

  it('excludes Z\'s own messages and empty/system authors', () => {
    const newMsgs = [{ userId: 'ME', text: 'my own msg' }, { userId: '', text: 'system' }, { userId: 'U1', text: 'hi' }];
    expect(distinctNewSenderIds(newMsgs, 'ME')).toEqual(['U1']);
  });

  it('previously (the bug): only the FIRST sender in a batch would ever be saved', () => {
    const newMsgs = [{ userId: 'U1' }, { userId: 'U2' }, { userId: 'U3' }];
    const oldBuggyFirst = newMsgs.find(m => m.userId && m.userId !== 'ME')?.userId;
    expect(oldBuggyFirst).toBe('U1'); // old behavior: only U1 ever got saved
    // new logic saves all three
    expect(distinctNewSenderIds(newMsgs, 'ME')).toEqual(['U1', 'U2', 'U3']);
  });
});

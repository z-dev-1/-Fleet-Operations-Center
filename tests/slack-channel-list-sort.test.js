// tests/slack-channel-list-sort.test.js
//
// Coverage for the channel/DM sort order used in the new Slack tab
// (renderer/src/js/components/orcha-fab.js's _renderSlackList()), added
// 2026-07-16 as part of building a real Slack view into the Orcha floater.

import { describe, it, expect } from 'vitest';

// Mirrors the sort logic in _renderSlackList(): DMs/group-DMs before
// channels, unread count descending within each group.
function sortSlackItems(items) {
  return items.slice().sort((a, b) => {
    const aIm = a.isIm || a.isMpim, bIm = b.isIm || b.isMpim;
    if (aIm !== bIm) return aIm ? -1 : 1;
    return (b.unread || 0) - (a.unread || 0);
  });
}

describe('Slack tab channel/DM list sort order', () => {
  it('places DMs before public/private channels', () => {
    const items = [
      { id: 'c1', name: 'general', isIm: false, isMpim: false, unread: 0 },
      { id: 'd1', name: 'alice',   isIm: true,  isMpim: false, unread: 0 },
    ];
    const sorted = sortSlackItems(items);
    expect(sorted[0].id).toBe('d1');
    expect(sorted[1].id).toBe('c1');
  });

  it('places group DMs (isMpim) before channels too', () => {
    const items = [
      { id: 'c1', name: 'fleet-ops', isIm: false, isMpim: false, unread: 0 },
      { id: 'g1', name: 'group-dm',  isIm: false, isMpim: true,  unread: 0 },
    ];
    const sorted = sortSlackItems(items);
    expect(sorted[0].id).toBe('g1');
  });

  it('sorts by unread count descending within the same group', () => {
    const items = [
      { id: 'c1', name: 'low',  isIm: false, isMpim: false, unread: 1 },
      { id: 'c2', name: 'high', isIm: false, isMpim: false, unread: 9 },
      { id: 'c3', name: 'zero', isIm: false, isMpim: false, unread: 0 },
    ];
    const sorted = sortSlackItems(items);
    expect(sorted.map(i => i.id)).toEqual(['c2', 'c1', 'c3']);
  });

  it('treats missing/undefined unread as zero', () => {
    const items = [
      { id: 'c1', name: 'a', isIm: false, isMpim: false },
      { id: 'c2', name: 'b', isIm: false, isMpim: false, unread: 3 },
    ];
    const sorted = sortSlackItems(items);
    expect(sorted[0].id).toBe('c2');
  });

  it('handles a fully mixed realistic list correctly', () => {
    const items = [
      { id: 'chan-a', name: 'general',   isIm: false, isMpim: false, unread: 0 },
      { id: 'dm-a',   name: 'bob',       isIm: true,  isMpim: false, unread: 5 },
      { id: 'chan-b', name: 'fleet-ops', isIm: false, isMpim: false, unread: 12 },
      { id: 'dm-b',   name: 'carol',     isIm: true,  isMpim: false, unread: 0 },
    ];
    const sorted = sortSlackItems(items);
    // DMs first (unread desc: bob=5 then carol=0), then channels (unread desc: fleet-ops=12 then general=0)
    expect(sorted.map(i => i.id)).toEqual(['dm-a', 'dm-b', 'chan-b', 'chan-a']);
  });
});

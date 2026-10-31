import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const gw = require('../src/slack/gateway');

describe('gateway — normalizeInbound surfaces (spec #3)', () => {
  it('1:1 DM → surface dm, not group, not self', () => {
    const n = gw.normalizeInbound({ engine: 'dm', conv: { channelId: 'C1', name: 'Alice', isGroup: false }, message: { userId: 'U1', ts: '1.1', text: 'hi' } });
    expect(n.surface).toBe('dm');
    expect(n.isGroup).toBe(false);
    expect(n.isSelf).toBe(false);
    expect(n.channelId).toBe('C1');
    expect(n.senderSlackId).toBe('U1');
    expect(n.text).toBe('hi');
  });

  it('self-DM (sender == myUserId) → surface self_dm', () => {
    const n = gw.normalizeInbound({ engine: 'dm', conv: { channelId: 'C1', name: 'Me', isSelf: true }, message: { userId: 'ME', ts: '1.1', text: 'note' }, myUserId: 'ME' });
    expect(n.surface).toBe('self_dm');
    expect(n.isSelf).toBe(true);
  });

  it('dm-thread engine → surface dm_thread, isThreadReply true', () => {
    const n = gw.normalizeInbound({ engine: 'dm-thread', conv: { channelId: 'C1', name: 'Bob' }, message: { userId: 'U2', ts: '2.2', text: 'more' }, parentTs: '1.0' });
    expect(n.surface).toBe('dm_thread');
    expect(n.isThreadReply).toBe(true);
    expect(n.threadTs).toBe('1.0');
  });

  it('channel → surface channel, isGroup true', () => {
    const n = gw.normalizeInbound({ engine: 'channel', conv: { channelId: 'C9', name: 'ops', isGroup: true }, message: { userId: 'U3', ts: '3.3', text: 'any update?' }, mentioned: false });
    expect(n.surface).toBe('channel');
    expect(n.isGroup).toBe(true);
    expect(n.isMentioned).toBe(false);
  });

  it('Slack Connect channel → surface slack_connect', () => {
    const n = gw.normalizeInbound({ engine: 'channel', conv: { channelId: 'C7', name: 'partner', isGroup: true, isSlackConnect: true }, message: { userId: 'U4', ts: '4.4', text: 'hello' } });
    expect(n.surface).toBe('slack_connect');
    expect(n.isSlackConnect).toBe(true);
  });

  it('mention detection from text when mentioned flag omitted', () => {
    const n = gw.normalizeInbound({ engine: 'channel', conv: { channelId: 'C9', name: 'ops', isGroup: true }, message: { userId: 'U3', ts: '3.3', text: '<@ME> status 320160?' }, myUserId: 'ME' });
    expect(n.isMentioned).toBe(true);
    expect(n.mentions).toContain('ME');
  });

  it('explicit mentioned flag wins over text detection', () => {
    const n = gw.normalizeInbound({ engine: 'channel', conv: { channelId: 'C9', name: 'ops', isGroup: true }, message: { userId: 'U3', ts: '3.3', text: 'no mention here' }, mentioned: true });
    expect(n.isMentioned).toBe(true);
  });

  it('bad input never throws', () => {
    expect(() => gw.normalizeInbound(null)).not.toThrow();
    expect(() => gw.normalizeInbound({})).not.toThrow();
  });
});

describe('gateway — toRunnerInput maps to the runner native shape', () => {
  it('produces the exact fields the FAS runner expects', () => {
    const n = gw.normalizeInbound({ engine: 'dm', conv: { channelId: 'C1', name: 'Alice', isGroup: false }, message: { userId: 'U1', ts: '1.1', text: 'hi', files: [{ id: 'F1' }] } });
    const input = gw.toRunnerInput(n, { conversation: ['a: hi'], attachments: 'ctx', actualReply: 'legacy' });
    expect(input.engine).toBe('dm');
    expect(input.slackId).toBe('U1');
    expect(input.channelId).toBe('C1');
    expect(input.ts).toBe('1.1');
    expect(input.text).toBe('hi');
    expect(input.isGroup).toBe(false);
    expect(input.files.length).toBe(1);
    expect(input.conversation).toEqual(['a: hi']);
    expect(input.attachments).toBe('ctx');
    expect(input.actualReply).toBe('legacy');
    expect(input.mentioned).toBe(false);
  });

  it('buildRunnerInput one-shot equals normalize+map, and carries group+mention+participants', () => {
    const raw = { engine: 'channel', conv: { channelId: 'C9', name: 'ops', isGroup: true }, message: { userId: 'U3', ts: '3.3', threadTs: '3.3', text: 'q' }, mentioned: true, participants: ['U_A', 'U_B'] };
    const input = gw.buildRunnerInput(raw, {});
    expect(input.engine).toBe('channel');
    expect(input.isGroup).toBe(true);
    expect(input.mentioned).toBe(true);
    expect(input.participants).toEqual(['U_A', 'U_B']);
    expect(input.threadTs).toBe('3.3');
  });

  it('channel input matches the legacy inline shape (parity)', () => {
    // The legacy inline object the channel engine used to pass.
    const legacy = { engine: 'channel', slackId: 'U3', senderName: 'ops', channelName: 'ops',
      channelId: 'C9', threadTs: '3.3', ts: '3.3', text: 'q', files: [], isGroup: true, mentioned: true };
    const gwInput = gw.buildRunnerInput({ engine: 'channel', conv: { channelId: 'C9', name: 'ops', isGroup: true },
      message: { userId: 'U3', ts: '3.3', threadTs: '3.3', text: 'q', files: [] }, mentioned: true }, {});
    // Field-by-field parity on everything the runner reads.
    for (const k of ['engine', 'slackId', 'senderName', 'channelName', 'channelId', 'threadTs', 'ts', 'text', 'isGroup', 'mentioned']) {
      expect(gwInput[k]).toEqual(legacy[k]);
    }
  });
});

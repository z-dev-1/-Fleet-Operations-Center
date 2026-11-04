// tests/awareness-justme-channel.test.js
//
// Shared Just Me channel helper (src/scrapers/slack_justme_channel.js), design §D4 / §D16.3.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const jm = require('../src/scrapers/slack_justme_channel');

describe('slack_justme_channel', () => {
  it('finds a per-channel replyMode justme channel (both modes)', () => {
    const cfg = { enabled: true, channels: [{ id: 'C1', replyMode: 'mentions' }, { id: 'D2', replyMode: 'justme' }] };
    expect(jm.findJustMeChannel(cfg).id).toBe('D2');
    expect(jm.findJustMeChannel(cfg, { forSend: true }).id).toBe('D2');
  });

  it('global cfg.replyMode fallback: found for reading, null for sending', () => {
    const cfg = { enabled: true, replyMode: 'justme', channels: [{ id: 'C1' }] };
    expect(jm.findJustMeChannel(cfg).id).toBe('C1');
    expect(jm.findJustMeChannel(cfg, { forSend: true })).toBeNull();
  });

  it('forSend skips a justme channel with pmAlertAutoReply:true', () => {
    const cfg = { enabled: true, channels: [{ id: 'C1', replyMode: 'justme', pmAlertAutoReply: true }, { id: 'D2', replyMode: 'justme' }] };
    expect(jm.findJustMeChannel(cfg, { forSend: true }).id).toBe('D2');
    const only = { enabled: true, channels: [{ id: 'C1', replyMode: 'justme', pmAlertAutoReply: true }] };
    expect(jm.findJustMeChannel(only, { forSend: true })).toBeNull();
    expect(jm.findJustMeChannel(only).id).toBe('C1');
  });

  it('legacy ch.mode justme is not recognised', () => {
    const cfg = { enabled: true, channels: [{ id: 'C1', mode: 'justme' }] };
    expect(jm.findJustMeChannel(cfg)).toBeNull();
    expect(jm.findJustMeChannel(cfg, { forSend: true })).toBeNull();
  });

  it('enabled:false skipped, enabled undefined accepted', () => {
    expect(jm.findJustMeChannel({ enabled: true, channels: [{ id: 'C1', replyMode: 'justme', enabled: false }] })).toBeNull();
    expect(jm.findJustMeChannel({ enabled: true, channels: [{ id: 'C1', replyMode: 'justme', enabled: false }] }, { forSend: true })).toBeNull();
    expect(jm.findJustMeChannel({ enabled: true, channels: [{ id: 'C1', replyMode: 'justme' }] }, { forSend: true }).id).toBe('C1');
  });

  it('cfg.enabled false (or missing cfg/channels) → null', () => {
    expect(jm.findJustMeChannel({ enabled: false, channels: [{ id: 'C1', replyMode: 'justme' }] })).toBeNull();
    expect(jm.findJustMeChannel({ channels: [{ id: 'C1', replyMode: 'justme' }] }, { forSend: true })).toBeNull();
    expect(jm.findJustMeChannel(null)).toBeNull();
    expect(jm.findJustMeChannel({ enabled: true })).toBeNull();
  });

  it('missing id → null', () => {
    const cfg = { enabled: true, channels: [{ replyMode: 'justme' }] };
    expect(jm.findJustMeChannel(cfg)).toBeNull();
    expect(jm.findJustMeChannel(cfg, { forSend: true })).toBeNull();
    expect(jm.isJustMeSendTarget({ replyMode: 'justme' })).toBe(false);
  });

  it("channelMode defaults to 'mentions'", () => {
    expect(jm.channelMode({}, {})).toBe('mentions');
    expect(jm.channelMode(null, null)).toBe('mentions');
    expect(jm.channelMode({}, { replyMode: 'all' })).toBe('all');
    expect(jm.channelMode({ replyMode: 'justme' }, { replyMode: 'all' })).toBe('justme');
  });
});

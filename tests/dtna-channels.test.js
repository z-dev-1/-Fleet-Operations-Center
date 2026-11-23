// DTNA Chatter + Files: src/dtna/channels.js selectChannel — Chatter when the case feed says
// isChatterEnabled and Chatter posting is configured, else the case comment. Pure, no fakes needed.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { selectChannel } = require('../src/dtna/channels.js');

const BOTH = { chatterConfigured: true, chatterEnabled: true, commentConfigured: true, hasRepairOrder: true, pulled: true };

describe('selectChannel', () => {
  it('auto = Chatter when configured and isChatterEnabled is true', () => {
    const r = selectChannel(BOTH);
    expect(r.auto).toBe('chatter');
    expect(r.chosen).toBe('chatter');
    expect(r.chatter).toEqual({ available: true, reason: '' });
    expect(r.comment).toEqual({ available: true, reason: '' });
  });

  it('falls back to the case comment when isChatterEnabled is false (external communication off)', () => {
    const r = selectChannel(Object.assign({}, BOTH, { chatterEnabled: false }));
    expect(r.auto).toBe('comment');
    expect(r.chatter).toEqual({ available: false, reason: 'DTNA_CHATTER_DISABLED' });
  });

  it('falls back to the case comment when the flag is unknown or Chatter is not configured', () => {
    const u = selectChannel(Object.assign({}, BOTH, { chatterEnabled: null, chatterCode: 'DTNA_TIMEOUT' }));
    expect(u.auto).toBe('comment');
    expect(u.chatter).toEqual({ available: false, reason: 'DTNA_CHATTER_UNKNOWN', code: 'DTNA_TIMEOUT' });
    const n = selectChannel(Object.assign({}, BOTH, { chatterConfigured: false }));
    expect(n.auto).toBe('comment');
    expect(n.chatter.reason).toBe('DTNA_CHATTER_NOT_CONFIGURED');
  });

  it('neither channel when Chatter is off and the case has no repair order', () => {
    const r = selectChannel(Object.assign({}, BOTH, { chatterEnabled: false, hasRepairOrder: false }));
    expect(r.auto).toBeNull();
    expect(r.chosen).toBeNull();
    expect(r.comment).toEqual({ available: false, reason: 'DTNA_NO_REPAIR_ORDER' });
  });

  it('Chatter does not need a repair order', () => {
    const r = selectChannel(Object.assign({}, BOTH, { hasRepairOrder: false }));
    expect(r.auto).toBe('chatter');
    expect(r.comment.reason).toBe('DTNA_NO_REPAIR_ORDER');
  });

  it('comment reasons: not configured, not pulled', () => {
    expect(selectChannel(Object.assign({}, BOTH, { commentConfigured: false })).comment.reason).toBe('DTNA_POST_NOT_CONFIGURED');
    expect(selectChannel(Object.assign({}, BOTH, { pulled: false })).comment.reason).toBe('DTNA_NOT_PULLED');
  });

  it('an explicit comment pick while Chatter is the auto choice is honoured', () => {
    const r = selectChannel(BOTH, 'comment');
    expect(r.auto).toBe('chatter');
    expect(r.chosen).toBe('comment');
    expect(r.refused).toBeUndefined();
  });

  it('an explicit Chatter pick is refused when Chatter is disabled', () => {
    const r = selectChannel(Object.assign({}, BOTH, { chatterEnabled: false }), 'chatter');
    expect(r.chosen).toBeNull();
    expect(r.refused).toBe('DTNA_CHATTER_DISABLED');
    expect(selectChannel(BOTH, 'email').refused).toBe('DTNA_INVALID_INPUT');
    expect(selectChannel(BOTH, 'auto').chosen).toBe('chatter');
  });
});

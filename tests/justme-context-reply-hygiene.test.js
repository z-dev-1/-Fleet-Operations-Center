// AC-40 (mention defang), round-3 fix 8 (labelled links), AC-44 (staged-send preview).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { defangMentions, confirmPreview } = require('../src/justme-context/reply-hygiene');

describe('defangMentions (AC-40)', () => {
  it('broadcast, user, and channel tokens become plain text', () => {
    const out = defangMentions('<!channel> hi <@U123|bob> see <#C999|ops>');
    for (const raw of ['<!channel>', '<@U123', '<#C999']) expect(out).not.toContain(raw);
    expect(out).toBe('@\u200Bchannel hi @bob see #ops');
  });
  it('here/everyone/subteam and label-less ids', () => {
    expect(defangMentions('<!here|here> <!everyone> <!subteam^S12AB|@ops> <@W42> <#C1>')).toBe('@\u200Bhere @\u200Beveryone @group @W42 #C1');
  });
  it('plain-text @here/@channel get a zero-width break', () => {
    expect(defangMentions('@here now and @channel')).toBe('@\u200Bhere now and @\u200Bchannel');
    expect(defangMentions('mail a@here.com')).toBe('mail a@here.com');
  });
  it('fix 8: a labelled link shows its target', () => {
    const out = defangMentions('<https://evil.example|Midway re-auth required>');
    expect(out).toBe('Midway re-auth required (https://evil.example)');
    expect(out).not.toContain('|');
    expect(out).not.toContain('<https');
  });
  it('fix 8 runs before the mention rules (label holding a broadcast token)', () => {
    expect(defangMentions('<https://evil.example/a?b=1|click> and <!here>')).toBe('click (https://evil.example/a?b=1) and @\u200Bhere');
  });
  it('a bare <https://…> link (no label) is left as is', () => {
    expect(defangMentions('see <https://w.amazon.com/x>')).toBe('see <https://w.amazon.com/x>');
  });
  it('non-string input is stringified', () => {
    expect(defangMentions(null)).toBe('');
    expect(defangMentions(42)).toBe('42');
  });
});

describe('confirmPreview (AC-44)', () => {
  it('one quoted line per staged Slack send, newlines collapsed, mentions defanged', () => {
    const p = confirmPreview([{ channel: 'slack', recipientName: 'James Mendez', body: 'Good morning <!here>\nline2' }]);
    expect(p).toBe('\n> To James Mendez: Good morning @\u200Bhere line2');
  });
  it('email shows subject and body; lifecycle/approve items add nothing', () => {
    const p = confirmPreview([
      { channel: 'email', recipientName: 'bob@example.com', subject: 'Report', body: 'Body text' },
      { channel: 'lifecycle', recipientName: '208336 → Active' },
      { channel: 'approve-wr', recipientName: 'WR 1' },
    ]);
    expect(p).toBe('\n> To bob@example.com: Report — Body text');
  });
  it('caps the preview at 300 chars with an ellipsis and defangs fence markers', () => {
    const p = confirmPreview([{ channel: 'slack', recipientName: 'x', body: '<<<' + 'b'.repeat(400) + '>>>' }]);
    const body = p.split(': ')[1];
    expect(body.length).toBe(300);
    expect(body.endsWith('…')).toBe(true);
    expect(p).not.toContain('<<<');
  });
  it('labelled links in a staged body are shown with their target', () => {
    expect(confirmPreview([{ channel: 'slack', recipientName: 'x', body: '<https://evil.example|Midway>' }])).toBe('\n> To x: Midway (https://evil.example)');
  });
  it('empty / malformed input → empty string', () => {
    expect(confirmPreview(null)).toBe('');
    expect(confirmPreview([null, {}])).toBe('');
  });
});

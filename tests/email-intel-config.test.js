// tests/email-intel-config.test.js — F-19 config validation, R8.4 clamps, R7.4 minConfidence rules, F-12.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const cfg = require('../src/email-intel/config');
const C = require('../src/email-intel/constants');

const V = (patch, prev) => cfg.validate(patch, prev);

describe('F-19 minConfidence rules', () => {
  it('F-19 minConfidence NaN/string/null/<0.75/>1 resets to 0.75, effective never NaN', () => {
    for (const bad of [NaN, Infinity, -Infinity, '0.9', null, 0.5, 0.74999, 1.01, 2, -1, {}, [], true]) {
      const r = V({ minConfidence: bad });
      expect(r.ok, String(bad)).toBe(true);
      expect(r.config.minConfidence, String(bad)).toBe(0.75);
      expect(r.warnings).toContain('minConfidence-reset');
      expect(cfg.effectiveMinConfidence(r.config)).toBe(0.75);
    }
    for (const bad of [NaN, '0.9', null, undefined, 0.1, Infinity, {}]) {
      const e = cfg.effectiveMinConfidence({ minConfidence: bad });
      expect(Number.isNaN(e)).toBe(false);
      expect(e).toBeGreaterThanOrEqual(0.75);
    }
  });

  it('R7.4 config can only raise the threshold: 0.75 and above are kept, effective is max(0.75, cfg)', () => {
    for (const ok of [0.75, 0.8, 0.9, 1]) {
      const r = V({ minConfidence: ok });
      expect(r.config.minConfidence).toBe(ok);
      expect(r.warnings).not.toContain('minConfidence-reset');
      expect(cfg.effectiveMinConfidence(r.config)).toBe(ok);
    }
    expect(cfg.effectiveMinConfidence({ minConfidence: 0.2 })).toBe(0.75);
    expect(cfg.effectiveMinConfidence(null)).toBe(0.75);
    expect(C.AUTO_APPLY_MIN_CONFIDENCE).toBe(0.75);
  });
});

describe('F-19 payload size and shape', () => {
  it('F-19 set-config over 32 KB rejected, nothing returned to save', () => {
    const r = V({ banners: Array.from({ length: 20 }, () => 'x'.repeat(2000)) });
    expect(r).toEqual({ ok: false, code: 'BAD_ARG', field: 'config', error: 'too large' });
    expect(V('nope')).toMatchObject({ ok: false, code: 'BAD_ARG', field: 'config' });
    expect(V([1])).toMatchObject({ ok: false, code: 'BAD_ARG' });
    expect(V(null)).toMatchObject({ ok: false, code: 'BAD_ARG' });
  });

  it('unknown keys are dropped', () => {
    const r = V({ evil: 1, me: { names: ['Zila Santiago'], hack: 'x' }, __proto__: { x: 1 } });
    expect(r.ok).toBe(true);
    expect(r.config.evil).toBeUndefined();
    expect(r.config.me.hack).toBeUndefined();
    expect(Object.keys(r.config).sort()).toEqual(Object.keys(cfg.defaults()).sort());
  });

  it('mailboxTzVerified and visionNoticeAcknowledged cannot be set through set-config', () => {
    const r = V({ mailboxTzVerified: true, attachments: { visionNoticeAcknowledged: true, maxVision: 3 } });
    expect(r.config.mailboxTzVerified).toBe(false);
    expect(r.config.attachments.visionNoticeAcknowledged).toBe(false);
    expect(r.config.attachments.maxVision).toBe(3);
    // and a previously verified/acknowledged value is preserved, not reset
    const prev = Object.assign(cfg.defaults(), { mailboxTzVerified: true });
    prev.attachments.visionNoticeAcknowledged = true;
    const keep = V({ folders: ['Inbox'] }, prev);
    expect(keep.config.mailboxTzVerified).toBe(true);
    expect(keep.config.attachments.visionNoticeAcknowledged).toBe(true);
    expect(V({ mailboxTzVerified: false }, prev).config.mailboxTzVerified).toBe(true);
  });
});

describe('R8.4 clamps to hard maxima', () => {
  it('R8.4 clamps to hard maxima, floors, and ignores non-numbers', () => {
    const r = V({ caps: { maxEmails: 9999, maxOpen: 500, aiCalls: 1000, lookbackDays: 0 }, aiConcurrency: 9 });
    expect(r.config.caps).toEqual({ maxEmails: C.MAX_EMAILS_HARD, maxOpen: C.MAX_OPEN_HARD, aiCalls: C.AI_CALLS_HARD, lookbackDays: 1 });
    expect(r.config.aiConcurrency).toBe(C.AI_CONCURRENCY_HARD);
    expect(r.warnings).toEqual(expect.arrayContaining(['clamped-caps.maxEmails', 'clamped-caps.maxOpen', 'clamped-caps.aiCalls', 'clamped-aiConcurrency']));
    const prev = Object.assign(cfg.defaults(), { caps: { maxEmails: 12, maxOpen: 40, aiCalls: 24, lookbackDays: 14 } });
    const ig = V({ caps: { maxEmails: 'lots', maxOpen: NaN } }, prev);
    expect(ig.config.caps.maxEmails).toBe(12);
    expect(ig.warnings).toEqual(expect.arrayContaining(['ignored-caps.maxEmails', 'ignored-caps.maxOpen']));
    const att = V({ attachments: { maxBytes: 99_000_000, maxPerMessage: 99, maxVision: 99 } });
    expect(att.config.attachments).toMatchObject({ maxBytes: 10_000_000, maxPerMessage: 5, maxVision: 4 });
  });

  it('folders: trimmed, deduped, truncated to 12, null means use the triage list', () => {
    const r = V({ folders: ['  Inbox ', 'inbox', 'DOMO', ...Array.from({ length: 20 }, (_, i) => 'F' + i)] });
    expect(r.config.folders).toHaveLength(C.MAILBOX_FOLDERS_MAX);
    expect(r.config.folders.slice(0, 2)).toEqual(['Inbox', 'DOMO']);
    expect(r.warnings).toContain('truncated-folders');
    expect(V({ folders: null }).config.folders).toBeNull();
    expect(V({ folders: [] }).config.folders).toBeNull();
    expect(V({ folders: ['bad\u0000name'] })).toMatchObject({ ok: false, field: 'folders' });
  });
});

describe('F-12 identity', () => {
  it('F-12 names, addresses and lists validate with field-level errors', () => {
    const ok = V({ me: { names: ['Zila Santiago', 'Z Santiago'], addresses: ['Zila.Santiago@Example.test'], distributionLists: ['Fleet Ops DL', 'fleet@example.test'], fasName: 'Zila S' } });
    expect(ok.ok).toBe(true);
    expect(ok.config.me).toEqual({ names: ['Zila Santiago', 'Z Santiago'], addresses: ['zila.santiago@example.test'], distributionLists: ['Fleet Ops DL', 'fleet@example.test'], fasName: 'Zila S' });
    expect(V({ me: { addresses: ['not-an-address'] } })).toMatchObject({ ok: false, code: 'BAD_ARG', field: 'me.addresses' });
    expect(V({ me: { names: ['Z'] } })).toMatchObject({ ok: false, field: 'me.names' });
    expect(V({ me: { names: ['x'.repeat(61)] } })).toMatchObject({ ok: false, field: 'me.names' });
    expect(V({ me: { names: ['Zila\u0007 S'] } })).toMatchObject({ ok: false, field: 'me.names' });
    expect(V({ me: { names: 'Zila' } })).toMatchObject({ ok: false, field: 'me.names' });
    expect(V({ me: { fasName: 5 } })).toMatchObject({ ok: false, field: 'me.fasName' });
  });

  it('F-12 arrays truncate to 10 / 10 / 20 and a patch merges into the previous identity', () => {
    const names = Array.from({ length: 14 }, (_, i) => 'Alias Number ' + i);
    const r = V({ me: { names } });
    expect(r.config.me.names).toHaveLength(10);
    expect(r.warnings).toContain('truncated-me.names');
    const prev = V({ me: { names: ['Zila Santiago'], addresses: ['zila@example.test'] } }).config;
    const merged = V({ me: { fasName: 'Zila S' } }, prev);
    expect(merged.config.me).toMatchObject({ names: ['Zila Santiago'], addresses: ['zila@example.test'], fasName: 'Zila S' });
    expect(cfg.isIdentitySet(merged.config)).toBe(true);
    expect(cfg.isFasNameSet(merged.config)).toBe(true);
    expect(cfg.isIdentitySet(cfg.defaults())).toBe(false);
    expect(cfg.isFasNameSet(cfg.defaults())).toBe(false);
  });

  it('normalize tolerates junk stored documents and never lowers the threshold', () => {
    for (const junk of [null, 'x', 5, [], { me: 5, caps: 'x', minConfidence: 'high', attachments: [] }]) {
      const n = cfg.normalize(junk);
      expect(n.minConfidence).toBe(0.75);
      expect(Array.isArray(n.me.names)).toBe(true);
    }
    expect(cfg.normalize({ minConfidence: 0.3 }).minConfidence).toBe(0.75);
    expect(cfg.normalize({ minConfidence: 0.9 }).minConfidence).toBe(0.9);
  });

  it('the pure validator never touches disk or state (no store access)', () => {
    const before = JSON.stringify(cfg.defaults());
    V({ me: { names: ['Zila Santiago'] } });
    expect(JSON.stringify(cfg.defaults())).toBe(before);
  });
});

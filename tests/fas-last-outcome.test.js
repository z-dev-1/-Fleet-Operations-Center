// tests/fas-last-outcome.test.js
//
// Regression: the FAS audit log is stored NEWEST-FIRST (unshift). The engine-
// status "Last message" panel must show the NEWEST event, not the oldest
// (audit[audit.length-1] was the bug). Timestamps are used defensively.

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// slack.js requires electron at load — inject a harmless fake before requiring.
function injectFake(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
injectFake('electron', { BrowserWindow: function () {}, session: { defaultSession: {} }, ipcMain: { handle: () => {} }, shell: {} });

const { _newestAuditOutcome } = require('../src/ipc/slack');

describe('_newestAuditOutcome — newest-first audit selection', () => {
  it('returns the NEWEST event (index 0 in a newest-first log), not the oldest', () => {
    const audit = [
      { at: '2026-09-05T10:00:00Z', outcome: 'auto-sent', channelName: 'DM-new', mode: 'autonomous' },      // newest
      { at: '2026-09-05T09:00:00Z', outcome: 'queued', channelName: 'DM-mid', mode: 'autonomous' },
      { at: '2026-09-05T08:00:00Z', outcome: 'shadow', channelName: 'DM-old', mode: 'shadow' },              // oldest
    ];
    const r = _newestAuditOutcome(audit);
    expect(r.outcome).toBe('auto-sent');
    expect(r.channel).toBe('DM-new');
    expect(r.engine).toBe('digital-fas');
  });

  it('picks by newest timestamp even if array order is imperfect', () => {
    const audit = [
      { at: '2026-09-05T08:00:00Z', outcome: 'old' },
      { at: '2026-09-05T12:00:00Z', outcome: 'newest' },
      { at: '2026-09-05T09:00:00Z', outcome: 'mid' },
    ];
    expect(_newestAuditOutcome(audit).outcome).toBe('newest');
  });

  it('falls back to index 0 (newest by insertion) when timestamps are missing', () => {
    const audit = [
      { outcome: 'first-in-array', channelName: 'A' },
      { outcome: 'second', channelName: 'B' },
    ];
    expect(_newestAuditOutcome(audit).outcome).toBe('first-in-array');
  });

  it('maps shadow/disabled mode to the legacy engine label', () => {
    const audit = [{ at: '2026-09-05T10:00:00Z', outcome: 'shadow', mode: 'shadow', channelName: 'X' }];
    expect(_newestAuditOutcome(audit).engine).toBe('legacy');
  });

  it('returns null for an empty or invalid log', () => {
    expect(_newestAuditOutcome([])).toBeNull();
    expect(_newestAuditOutcome(null)).toBeNull();
    expect(_newestAuditOutcome([null, undefined])).toBeNull();
  });

  it('surfaces a queue/fail reason and the handling engine', () => {
    const audit = [{ at: '2026-09-05T10:00:00Z', outcome: 'queued', queueReason: 'approval-level action proposed', handledBy: 'digital-fas', channelName: 'DM' }];
    const r = _newestAuditOutcome(audit);
    expect(r.reason).toMatch(/approval-level/);
    expect(r.engine).toBe('digital-fas');
  });
});

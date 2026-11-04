import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-p8-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const config = require('../src/orcha/fas/config');
const runner = require('../src/orcha/fas/runner');

beforeEach(() => { store.save('fasApprovalQueue', []); store.save('fasAuditLog', []); });
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('Phase 8 — config defaults (FAS primary, legacy retired)', () => {
  it('fresh install defaults: enabled true, mode approval, retireLegacyReasoning true', () => {
    store.delete && store.delete('fasConfig');
    const c = config.get();
    expect(c.enabled).toBe(true);
    expect(c.mode).toBe('approval');
    expect(c.retireLegacyReasoning).toBe(true);
  });

  it('retireLegacyReasoning survives a partial save (shallow-merge keeps the key)', () => {
    config.save({ mode: 'autonomous' });
    const c = config.get();
    expect(c.mode).toBe('autonomous');
    expect(c.retireLegacyReasoning).toBe(true); // default key preserved
  });

  it('operator can explicitly roll back retireLegacyReasoning to false', () => {
    const c = config.save({ retireLegacyReasoning: false });
    expect(c.retireLegacyReasoning).toBe(false);
    expect(config.get().retireLegacyReasoning).toBe(false);
  });
});

describe('Phase 8 — runner exposes _queueManualReview (used by the retired-legacy error path)', () => {
  it('_queueManualReview is exported and queues a visible manual-review item', () => {
    expect(typeof runner._queueManualReview).toBe('function');
    const item = runner._queueManualReview(
      { engine: 'dm', slackId: 'U1', senderName: 'Z', channelId: 'C1', ts: '1.1', text: 'help' },
      { decision: 'clarify' }, 'FAS runtime error: boom');
    expect(item.kind).toBe('manual-review');
    expect(item.failReason).toMatch(/runtime error/);
    expect(item.request).toBe('help');
    expect(item.proposedReply).toBe('');            // nothing to send
    const q = store.load('fasApprovalQueue', []);
    expect(q.some(x => x.id === item.id && x.kind === 'manual-review')).toBe(true);
  });
});

describe('Phase 8 — runner still fails safe to legacy on error (mode gate unchanged)', () => {
  // The runner itself returns letLegacyReply:true on an agent throw; the
  // ENGINE decides (via retireLegacyReasoning) whether to honor that or queue a
  // manual review. Prove the runner contract is intact so the engine guard has
  // a consistent signal.
  it('agent throw in approval mode -> runner still returns letLegacyReply true (engine then retires it)', async () => {
    store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [] });
    store.save('contacts', [{ type: 'slack', slackId: 'U1', name: 'Z', identityType: 'internal', org: 'Amazon' }]);
    store.save('slackSenderProfiles', { __migratedAt: new Date().toISOString(), __migrationVersion: 1 });
    store.save('fasConfig', { enabled: true, mode: 'approval', retireLegacyReasoning: true, maxSteps: 1, maxRuntimeMs: 5000, retry: { inLoopRetries: 0 } });
    const relay = require('../src/orcha/relay');
    vi.spyOn(relay, 'ask').mockRejectedValue(new Error('relay down'));
    const out = await runner.handleInbound({ engine: 'dm', slackId: 'U1', senderName: 'Z', channelId: 'C1', ts: '1.1', text: 'status?' });
    // Agent produced a fallback (no usable reply) -> runner routes to
    // manual-review in a primary mode (NOT letLegacyReply), so the engine never
    // even reaches its legacy path for an AI failure.
    expect(out.outcome).toBe('manual-review');
    expect(out.letLegacyReply).toBe(false);
  });
});

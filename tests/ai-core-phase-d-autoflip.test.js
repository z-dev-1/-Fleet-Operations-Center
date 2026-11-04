import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'ai-core-phase-d-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const autoreply = require('../src/scrapers/slack_dm_autoreply');

// Seed an internal operator + a power unit (Day Cab) in a flippable state so
// the power-unit gate passes and MOVE_UNIT verification is exercised.
function seed() {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '321060', operator: 'TUZR', domicileSite: 'ABE40', assetType: 'Tractor', bodyType: 'Day Cab',
      lifecycleState: 'Unavailable', lifecycleReason: 'Offsite Shop Repair',
      assetUrl: 'https://aap-na.corp.amazon.com/v2/asset/uuid-321060' },
    // A unit in a BLOCKED hold state (PM Failed) — must never be auto-flipped.
    { equipmentId: '321099', operator: 'TUZR', domicileSite: 'ABE40', assetType: 'Tractor', bodyType: 'Day Cab',
      lifecycleState: 'Unavailable', lifecycleReason: 'PM Failed',
      assetUrl: 'https://aap-na.corp.amazon.com/v2/asset/uuid-321099' },
  ] });
  store.save('contacts', [
    { type: 'slack', slackId: 'U_INT', name: 'Z Internal', org: 'Amazon', email: 'z@amazon.com' },
  ]);
  store.save('slackSenderProfiles', {});
  store.save('fasIdempotency', {});
  store.save('fasAuditLog', []);
  store.save('notesStore', {});
}

beforeEach(() => { seed(); });
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('AI Core Phase D — Slack auto-flip routed through Digital FAS (no direct mutation)', () => {
  it('says "Done" ONLY after source read-back verifies the new state', async () => {
    const sl = require('../src/scrapers/setLifecycle');
    const rl = require('../src/scrapers/readLifecycle');
    const setSpy = vi.spyOn(sl, 'setLifecycleState').mockResolvedValue({ success: true });
    // Read-back confirms the unit is now Active -> executor returns done/verified.
    vi.spyOn(rl, 'readLifecycle').mockResolvedValue({ state: 'Active', reason: 'Healthy' });

    const r = await autoreply._maybeAutoFlip('321060', '', 'U_INT', 'Z Internal');
    expect(r._flip.action).toBe('flipped');
    expect(r._flip.verified).toBe(true);
    expect(r.reply).toMatch(/Done/i);
    expect(r.inScope).toBe(true);
    // The mutation went through the executor (setLifecycleState was invoked by
    // MOVE_UNIT.run), NOT by a direct call in the autoreply path.
    expect(setSpy).toHaveBeenCalledTimes(1);
  });

  it('returns EXECUTION_UNCERTAIN (never "Done") when the write cannot be verified', async () => {
    const sl = require('../src/scrapers/setLifecycle');
    const rl = require('../src/scrapers/readLifecycle');
    vi.spyOn(sl, 'setLifecycleState').mockResolvedValue({ success: true });
    // Read-back unavailable (throws) -> executor DEFERS to verifying.
    vi.spyOn(rl, 'readLifecycle').mockRejectedValue(new Error('no session'));

    const r = await autoreply._maybeAutoFlip('321060', '', 'U_INT', 'Z Internal');
    expect(r._flip.action).toBe('execution-uncertain');
    expect(r.reply).not.toMatch(/\bDone\b/i);         // must NOT claim success
    expect(r.reply).toMatch(/couldn't confirm|verify/i);
    expect(r.inScope).toBe(false);                     // escalated for review
  });

  it('does NOT attempt any mutation for a blocked hold state (PM Failed)', async () => {
    const sl = require('../src/scrapers/setLifecycle');
    const setSpy = vi.spyOn(sl, 'setLifecycleState').mockResolvedValue({ success: true });

    const r = await autoreply._maybeAutoFlip('321099', '', 'U_INT', 'Z Internal');
    expect(r._flip.action).toBe('blocked');
    expect(r.reply).toMatch(/can't flip/i);
    // No executor path reached -> setLifecycleState never called.
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('a failed/unverified read-back (state disagrees) reports a truthful failure, not "Done"', async () => {
    const sl = require('../src/scrapers/setLifecycle');
    const rl = require('../src/scrapers/readLifecycle');
    vi.spyOn(sl, 'setLifecycleState').mockResolvedValue({ success: true });
    // Read-back shows the unit is STILL Unavailable -> executor returns unverified.
    vi.spyOn(rl, 'readLifecycle').mockResolvedValue({ state: 'Unavailable', reason: 'Offsite Shop Repair' });

    const r = await autoreply._maybeAutoFlip('321060', '', 'U_INT', 'Z Internal');
    expect(r.reply).not.toMatch(/\bDone\b/i);
    expect(['failed', 'execution-uncertain']).toContain(r._flip.action);
    expect(r.inScope).toBe(false);
  });

  it('detects a flip request and inherits the thread unit for an implicit follow-up', () => {
    expect(autoreply._detectFlipRequest('can you flip 321060 back?', [])).toBe('321060');
    // Implicit "flip it" inherits the last unit mentioned in history.
    expect(autoreply._detectFlipRequest('flip it back please', ['Z: what about 321060?'])).toBe('321060');
    // Not a flip request.
    expect(autoreply._detectFlipRequest('any update on 321060?', [])).toBeNull();
  });
});

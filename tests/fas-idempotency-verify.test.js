import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-idem-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const executor = require('../src/orcha/fas/executor');
const actions = require('../src/orcha/fas/action-registry');

const INTERNAL = { slackId: 'U_INT', name: 'Z', type: 'internal', operators: [], domiciles: [],
  allowedDataCategories: ['*'], permittedRequestTypes: ['follow_up', 'lifecycle_change', 'create_wr'] };

function reset() {
  store.save('notesStore', {});
  store.save('reminders', []);
  store.save('fasCases', {});
  store.save('fasAuditLog', []);
  store.save('fasIdempotency', {});
}
beforeEach(() => { reset(); });
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('FAS idempotency', () => {
  it('ADD_TIMELINE retried with same args does not duplicate the note', async () => {
    const args = { unit: '320160', entry: '09/02 - parts ordered' };
    const r1 = await executor.executeVerified('ADD_TIMELINE', args, { profile: INTERNAL });
    expect(r1.status).toBe('done');
    const r2 = await executor.executeVerified('ADD_TIMELINE', args, { profile: INTERNAL });
    expect(r2.status).toBe('done');
    expect(r2.idempotent).toBe(true);
    // The timeline has exactly ONE occurrence of the entry.
    const tl = store.load('notesStore', {})['320160'].timeline.split('\n').filter(l => l.includes('parts ordered'));
    expect(tl.length).toBe(1);
  });

  it('CREATE_REMINDER retried does not create a second reminder', async () => {
    const args = { unit: '320160', note: 'follow up with Amerit', when: '2026-09-05' };
    await executor.executeVerified('CREATE_REMINDER', args, { profile: INTERNAL });
    const r2 = await executor.executeVerified('CREATE_REMINDER', args, { profile: INTERNAL });
    expect(r2.idempotent).toBe(true);
    expect(store.load('reminders', []).length).toBe(1);
  });

  it('idempotency keys differ for different content', () => {
    const a = actions.getAction('ADD_TIMELINE').idempotencyKey({ unit: '1', entry: 'x' });
    const b = actions.getAction('ADD_TIMELINE').idempotencyKey({ unit: '1', entry: 'y' });
    const c = actions.getAction('ADD_TIMELINE').idempotencyKey({ unit: '1', entry: 'x' });
    expect(a).not.toBe(b);
    expect(a).toBe(c); // same content -> same key
  });
});

describe('FAS MOVE_UNIT read-back verification', () => {
  it('does NOT report done on write-success alone — holds VERIFYING', async () => {
    // Mock setLifecycle to report success but provide NO read-back state.
    const sl = require('../src/scrapers/setLifecycle');
    vi.spyOn(sl, 'setLifecycleState').mockResolvedValue({ success: true });
    const res = await executor.executeVerified('MOVE_UNIT',
      { unit: '320160', state: 'Active', reason: 'repair complete', assetUrl: 'https://aap/x' },
      { profile: INTERNAL });
    expect(res.status).toBe('verifying');
    expect(res.verified).toBe(false);
    expect(res.deferred).toBe(true);
  });

  it('reports done ONLY when a source read-back confirms the new state', async () => {
    const sl = require('../src/scrapers/setLifecycle');
    vi.spyOn(sl, 'setLifecycleState').mockResolvedValue({ success: true });
    const res = await executor.executeVerified('MOVE_UNIT',
      { unit: '320160', state: 'Active', reason: 'repair complete', assetUrl: 'https://aap/x' },
      { profile: INTERNAL, readLifecycle: async () => 'Active' });
    expect(res.status).toBe('done');
    expect(res.verified).toBe(true);
    expect(res.evidence).toMatch(/read-back/i);
  });

  it('reports unverified when read-back disagrees with the requested state', async () => {
    const sl = require('../src/scrapers/setLifecycle');
    vi.spyOn(sl, 'setLifecycleState').mockResolvedValue({ success: true });
    const res = await executor.executeVerified('MOVE_UNIT',
      { unit: '320160', state: 'Active', reason: 'x', assetUrl: 'https://aap/x' },
      { profile: INTERNAL, readLifecycle: async () => 'Unavailable' });
    expect(res.verified).toBe(false);
    expect(res.status).not.toBe('done');
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-shadow-test-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const config = require('../src/orcha/fas/config');
const shadow = require('../src/orcha/fas/shadow');

function seed() {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Unavailable', lifecycleReason: 'Offsite Shop Repair', vendor: 'Amerit', workDuration: '20d', openUnplanned: '1' },
  ] });
  store.save('contacts', [{ type: 'slack', slackId: 'U_INT', name: 'Internal Person', org: 'Amazon', email: 'x@amazon.com' }]);
  store.save('slackSenderProfiles', {});
  store.save('fasCases', {});
  store.save('fasConfig', null);
  store.save('fasAuditLog', []);
}
beforeEach(() => { seed(); });
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('FAS shadow runner', () => {
  it('is a no-op when FAS is disabled (default) — writes no audit', async () => {
    const relay = require('../src/orcha/relay');
    const spy = vi.spyOn(relay, 'ask');
    await shadow.runShadow({ engine: 'dm', slackId: 'U_INT', senderName: 'Internal Person', channelName: 'Internal Person', ts: '1.0', text: 'update on 320160?', actualReply: 'it is at Amerit' });
    expect(spy).not.toHaveBeenCalled(); // agent never ran
    expect(store.load('fasAuditLog', [])).toHaveLength(0);
  });

  it('is a no-op when enabled but mode is not shadow (e.g. approval)', async () => {
    config.save({ enabled: true, mode: 'approval' });
    const relay = require('../src/orcha/relay');
    const spy = vi.spyOn(relay, 'ask');
    await shadow.runShadow({ engine: 'dm', slackId: 'U_INT', senderName: 'X', channelName: 'X', ts: '1.0', text: 'hi', actualReply: 'hi' });
    expect(spy).not.toHaveBeenCalled();
    expect(store.load('fasAuditLog', [])).toHaveLength(0);
  });

  it('records an audit entry comparing FAS draft to the live reply when enabled+shadow', async () => {
    config.save({ enabled: true, mode: 'shadow' });
    const relay = require('../src/orcha/relay');
    vi.spyOn(relay, 'ask').mockResolvedValue('{"decision":"answer","confidence":0.8,"reason":"data present","actions":[],"reply":"320160 is at Amerit, parts ordered.","followUp":{"required":false}}');
    await shadow.runShadow({ engine: 'dm', slackId: 'U_INT', senderName: 'Internal Person', channelName: 'Internal Person', ts: '2.0', text: 'any update on 320160?', actualReply: 'let me look into that' });
    const log = store.load('fasAuditLog', []);
    expect(log).toHaveLength(1);
    expect(log[0].mode).toBe('shadow');
    expect(log[0].fasReply).toContain('Amerit');
    expect(log[0].actualReply).toBe('let me look into that');
    expect(log[0].divergence).toBeGreaterThan(0); // the two replies differ
    expect(log[0].caseId).toBe('unit-320160');
  });

  it('in shadow mode, proposed actions are recorded but NOT executed', async () => {
    config.save({ enabled: true, mode: 'shadow' });
    const relay = require('../src/orcha/relay');
    vi.spyOn(relay, 'ask').mockResolvedValue('{"decision":"act","confidence":0.8,"reason":"add note","actions":[{"tool":"ADD_TIMELINE","args":{"unit":"320160","entry":"09/02 test"}}],"reply":"logging that now","followUp":{"required":false}}');
    store.save('notesStore', {});
    await shadow.runShadow({ engine: 'dm', slackId: 'U_INT', senderName: 'Internal Person', channelName: 'Internal Person', ts: '9.0', text: 'log a note on 320160', actualReply: 'ok' });
    // Shadow must not have executed the timeline write.
    expect(store.load('notesStore', {})['320160']).toBeUndefined();
    const log = store.load('fasAuditLog', []);
    const withActions = log.find(e => e.actionOutcomes && e.actionOutcomes.length);
    expect(withActions).toBeTruthy();
    expect(withActions.actionOutcomes[0].outcome).toBe('shadow');
  });

  it('never throws even if the agent errors (guarded)', async () => {
    config.save({ enabled: true, mode: 'shadow' });
    const relay = require('../src/orcha/relay');
    vi.spyOn(relay, 'ask').mockRejectedValue(new Error('boom'));
    await expect(shadow.runShadow({ engine: 'dm', slackId: 'U_INT', senderName: 'X', channelName: 'X', ts: '3.0', text: 'x', actualReply: 'y' })).resolves.toBeUndefined();
    // Agent's own fallback still produces an audit row (decision=clarify, empty reply)
    const log = store.load('fasAuditLog', []);
    expect(log.length).toBe(1);
    expect(log[0].fasDecision).toBe('clarify');
  });
});

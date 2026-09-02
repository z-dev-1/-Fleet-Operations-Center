import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-cipc-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

// Capture IPC handlers by faking electron.ipcMain in the require cache BEFORE
// loading the contacts IPC module (mirrors how the slack tests inject fakes).
const handlers = {};
function injectFake(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
injectFake('electron', { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } });

const store = require('../src/store');
const { registerContactsHandlers } = require('../src/ipc/contacts');
registerContactsHandlers();
const call = (ch, arg) => handlers[ch]({}, arg);

beforeEach(() => { store.save('contacts', []); store.save('contactsTombstones', []); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('Part 1: Contact Book IPC validation + dedup', () => {
  it('contacts:add dedupes by slackId (links instead of creating a second)', async () => {
    await call('contacts:add', { slackId: 'U1', name: 'Joe', identityType: 'carrier' });
    const r2 = await call('contacts:add', { slackId: 'U1', name: 'Joe Again', operators: ['tuzr'] });
    expect(r2.linked).toBe(true);
    const all = store.load('contacts', []);
    expect(all.filter(c => c.slackId === 'U1').length).toBe(1);
    expect(all[0].operators).toContain('TUZR'); // normalized uppercase
  });

  it('contacts:add sanitizes bogus identityType + permission enums', async () => {
    const r = await call('contacts:add', { slackId: 'U2', identityType: 'superadmin',
      allowedDataCategories: ['unit_status', 'everything'], permittedRequestTypes: ['sudo', 'follow_up'] });
    const c = store.load('contacts', []).find(x => x.id === r.id);
    expect(c.identityType).toBe('unknown');
    expect(c.allowedDataCategories).toEqual(['unit_status']);
    expect(c.permittedRequestTypes).toEqual(['follow_up']);
  });

  it('contacts:update rejects a slackId that collides with another contact', async () => {
    const a = await call('contacts:add', { slackId: 'U1', name: 'A' });
    const b = await call('contacts:add', { slackId: 'U2', name: 'B' });
    const res = await call('contacts:update', { id: b.id, slackId: 'U1' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already/i);
  });

  it('contacts:link-slack refuses to link an already-used Slack ID', async () => {
    await call('contacts:add', { slackId: 'U1', name: 'A' });
    const b = await call('contacts:add', { name: 'B (no slack)' });
    const res = await call('contacts:link-slack', { contactId: b.id, slackId: 'U1' });
    expect(res.ok).toBe(false);
  });

  it('contacts:link-slack links a Slack ID to an existing contact (no duplicate)', async () => {
    const b = await call('contacts:add', { name: 'B (no slack)' });
    const res = await call('contacts:link-slack', { contactId: b.id, slackId: 'U9', name: 'B' });
    expect(res.ok).toBe(true);
    const all = store.load('contacts', []);
    expect(all.filter(c => c.slackId === 'U9').length).toBe(1);
  });

  it('contacts:save (bulk) drops duplicate active slackIds + sanitizes', async () => {
    const res = await call('contacts:save', [
      { id: '1', slackId: 'U1', identityType: 'carrier', operators: ['tuzr'] },
      { id: '2', slackId: 'U1', identityType: 'bogus' }, // duplicate slackId dropped
      { id: '3', slackId: 'U2', identityType: 'internal' },
    ]);
    expect(res.count).toBe(2);
    const all = store.load('contacts', []);
    expect(all.filter(c => c.slackId === 'U1').length).toBe(1);
  });

  it('contacts:delete writes a tombstone and revokes access', async () => {
    const a = await call('contacts:add', { slackId: 'U1', name: 'A', identityType: 'internal' });
    await call('contacts:delete', a.id);
    expect(store.load('contacts', []).length).toBe(0);
    const tomb = store.load('contactsTombstones', []);
    expect(tomb.some(t => t.slackId === 'U1')).toBe(true);
    // resolveSender now returns limited default (access revoked).
    const p = require('../src/orcha/fas/sender-profiles').resolveSender('U1');
    expect(p.type).toBe('unknown');
  });

  it('contacts:get-fas-view returns resolved permissions + summary for slack contacts', async () => {
    await call('contacts:add', { slackId: 'U1', name: 'Joe', identityType: 'carrier', operators: ['TUZR'] });
    const view = await call('contacts:get-fas-view');
    expect(view.length).toBe(1);
    expect(view[0].identityType).toBe('carrier');
    expect(view[0].summary).toMatch(/TUZR/);
  });
});

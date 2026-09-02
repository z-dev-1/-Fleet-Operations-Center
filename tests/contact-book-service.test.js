import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'cb-svc-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const cb = require('../src/services/contact-book');

beforeEach(() => { store.save('contacts', []); store.save('contactsTombstones', []); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('Contact Book hardened write service', () => {
  it('normalizes Slack IDs case-insensitively and prevents duplicates', () => {
    const a = cb.upsert({ slackId: 'U123ABC', name: 'Joe' });
    expect(a.ok).toBe(true);
    // Same id, different case -> LINKS onto the same contact, no duplicate.
    const b = cb.upsert({ slackId: 'u123abc', name: 'Joe Again', operators: ['tuzr'] });
    expect(b.linked).toBe(true);
    expect(b.id).toBe(a.id);
    const all = store.load('contacts', []);
    expect(all.length).toBe(1);
    expect(all[0].operators).toEqual(['TUZR']); // normalized uppercase
  });

  it('sanitizes malformed permission arrays into SAFE EMPTY arrays (never raw strings)', () => {
    const r = cb.upsert({ slackId: 'U1', identityType: 'superadmin',
      allowedDataCategories: 'unit_status,everything',   // string, not array
      permittedRequestTypes: { bad: true },              // object, not array
      operators: 'tuzr sapb' });
    const c = store.load('contacts', []).find(x => x.id === r.id);
    expect(c.identityType).toBe('unknown');              // bad enum -> unknown
    expect(Array.isArray(c.allowedDataCategories)).toBe(true);
    expect(c.allowedDataCategories).toEqual([]);          // malformed -> empty
    expect(Array.isArray(c.permittedRequestTypes)).toBe(true);
    expect(c.permittedRequestTypes).toEqual([]);
    expect(c.operators).toEqual(['TUZR', 'SAPB']);        // string parsed to array
  });

  it('sanitizes lifecyclePermission to a valid 3-state value', () => {
    const r = cb.upsert({ slackId: 'U1', lifecyclePermission: 'god_mode' });
    const c = store.load('contacts', []).find(x => x.id === r.id);
    expect(c.lifecyclePermission).toBe('not_allowed');
    const r2 = cb.update({ id: r.id, lifecyclePermission: 'trusted_autonomous' });
    expect(store.load('contacts', []).find(x => x.id === r.id).lifecyclePermission).toBe('trusted_autonomous');
  });

  it('never overwrites useful existing info with blanks', () => {
    const a = cb.upsert({ slackId: 'U1', name: 'Real Name', organization: 'AFP', operators: ['TUZR'] });
    // Update with blank name/org and empty non-clearable field -> keep existing.
    cb.update({ id: a.id, name: '', organization: '', role: 'Fleet Lead' });
    const c = store.load('contacts', []).find(x => x.id === a.id);
    expect(c.name).toBe('Real Name');
    expect(c.organization).toBe('AFP');
    expect(c.role).toBe('Fleet Lead'); // populated value applied
    expect(c.operators).toEqual(['TUZR']); // untouched
  });

  it('allows explicitly clearing scope/permission arrays', () => {
    const a = cb.upsert({ slackId: 'U1', operators: ['TUZR'], allowedDataCategories: ['unit_status'] });
    cb.update({ id: a.id, operators: [], allowedDataCategories: [] });
    const c = store.load('contacts', []).find(x => x.id === a.id);
    expect(c.operators).toEqual([]);              // clearable
    expect(c.allowedDataCategories).toEqual([]);  // clearable
  });

  it('linkSlack refuses a Slack ID already used by another contact (case-insensitive)', () => {
    const a = cb.upsert({ slackId: 'U1', name: 'A' });
    const b = cb.upsert({ name: 'B (no slack)' });
    const res = cb.linkSlack({ contactId: b.id, slackId: 'u1' });
    expect(res.ok).toBe(false);
  });

  it('discoverFromDM creates a SAFE UNKNOWN contact (no scope, no lifecycle perm)', () => {
    const r = cb.discoverFromDM({ slackId: 'U_NEW', name: 'Stranger', channelId: 'D1' });
    expect(r.existed).toBe(false);
    const c = store.load('contacts', []).find(x => x.id === r.id);
    expect(c.identityType).toBe('unknown');
    expect(c.operators).toEqual([]);
    expect(c.domiciles).toEqual([]);
    expect(c.lifecyclePermission).toBe('not_allowed');
    expect(c.allowedDataCategories).toEqual(['unit_status']); // conservative
  });

  it('discoverFromDM dedupes case-insensitively and does NOT downgrade an existing contact', () => {
    cb.upsert({ slackId: 'U1', name: 'Known Carrier', identityType: 'carrier', operators: ['TUZR'], allowedDataCategories: ['unit_status', 'work_orders'] });
    const r = cb.discoverFromDM({ slackId: 'u1', name: 'X', channelId: 'D9' });
    expect(r.existed).toBe(true);
    const c = store.load('contacts', []).find(x => x.slackId === 'U1');
    expect(store.load('contacts', []).length).toBe(1); // no duplicate
    expect(c.identityType).toBe('carrier');             // not downgraded
    expect(c.channelId).toBe('D9');                     // filled a missing field
  });

  it('bulkSave drops duplicate active slackIds (case-insensitive) + sanitizes', () => {
    const res = cb.bulkSave([
      { id: '1', slackId: 'U1', identityType: 'carrier', operators: ['tuzr'] },
      { id: '2', slackId: 'u1', identityType: 'bogus' },   // dup slackId dropped
      { id: '3', name: 'Vendor Co', type: 'vendor' },       // no slackId kept
    ]);
    expect(res.count).toBe(2);
    const all = store.load('contacts', []);
    expect(all.filter(c => (c.slackId || '').toUpperCase() === 'U1').length).toBe(1);
  });

  it('remove writes a tombstone', () => {
    const a = cb.upsert({ slackId: 'U1', name: 'A', identityType: 'internal' });
    cb.remove(a.id);
    expect(store.load('contacts', []).length).toBe(0);
    expect(store.load('contactsTombstones', []).some(t => t.slackId === 'U1')).toBe(true);
  });
});

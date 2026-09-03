import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-cbmig-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const profiles = require('../src/orcha/fas/sender-profiles');

beforeEach(() => {
  store.save('contacts', []);
  store.save('slackSenderProfiles', {});
  store.save('fasMigrationLog', []);
});
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('Part 1: Contact Book is the single source of truth', () => {
  it('resolves permissions from a Contact Book record (identity type preset)', () => {
    store.save('contacts', [{ id: 'c1', type: 'slack', slackId: 'U1', name: 'Carrier Joe', operators: ['TUZR'], identityType: 'carrier' }]);
    const p = profiles.resolveSender('U1');
    expect(p.type).toBe('carrier');
    expect(p.operators).toContain('TUZR');
    expect(p.allowedDataCategories).toContain('unit_status');
    expect(p.source).toBe('contact-book');
  });

  it('a disabled contact grants NO access', () => {
    store.save('contacts', [{ id: 'c1', slackId: 'U1', name: 'X', identityType: 'internal', enabled: false }]);
    const p = profiles.resolveSender('U1');
    expect(p.enabled).toBe(false);
    expect(p.allowedDataCategories).toEqual([]);
    expect(profiles.canRequest(p, 'follow_up')).toBe(false);
  });

  it('external contact with empty operator/domicile scope sees NO fleet-scoped units', () => {
    store.save('contacts', [{ id: 'c1', slackId: 'U1', name: 'X', identityType: 'carrier', operators: [], domiciles: [] }]);
    const p = profiles.resolveSender('U1');
    expect(profiles.scopeUnitForSender(p, { operator: 'TUZR', domicileSite: 'ABE40' })).toBe(false);
  });

  it('explicit permission fields on the contact override the preset', () => {
    store.save('contacts', [{ id: 'c1', slackId: 'U1', name: 'X', identityType: 'carrier',
      allowedDataCategories: ['unit_status'], permittedRequestTypes: ['unit_status'] }]);
    const p = profiles.resolveSender('U1');
    expect(p.allowedDataCategories).toEqual(['unit_status']);
    expect(profiles.canViewCategory(p, 'work_orders')).toBe(false);
  });

  it('editing the contact immediately changes authorization', () => {
    store.save('contacts', [{ id: 'c1', slackId: 'U1', name: 'X', identityType: 'carrier', operators: ['TUZR'] }]);
    expect(profiles.scopeUnitForSender(profiles.resolveSender('U1'), { operator: 'SAPB' })).toBe(false);
    // Operator changed on the contact.
    store.save('contacts', [{ id: 'c1', slackId: 'U1', name: 'X', identityType: 'carrier', operators: ['SAPB'] }]);
    expect(profiles.scopeUnitForSender(profiles.resolveSender('U1'), { operator: 'SAPB' })).toBe(true);
  });

  it('plain-language permission summary reads correctly', () => {
    store.save('contacts', [{ id: 'c1', slackId: 'U1', name: 'X', identityType: 'carrier', operators: ['TUZR'], domiciles: ['ROC5'],
      allowedDataCategories: ['unit_status', 'repair_timeline'], permittedRequestTypes: ['unit_status'] }]);
    const s = profiles.permissionSummary(profiles.resolveSender('U1'));
    expect(s).toMatch(/TUZR/);
    expect(s).toMatch(/Cannot .*lifecycle/i);
  });
});

describe('MIGRATION: slackSenderProfiles -> Contact Book', () => {
  it('merges a legacy profile into a matching contact (no duplicate)', () => {
    store.save('contacts', [{ id: 'c1', slackId: 'U1', name: 'Joe', type: 'slack' }]);
    store.save('slackSenderProfiles', { U1: { slackId: 'U1', name: 'Joe', type: 'carrier', operators: ['TUZR'], allowedDataCategories: ['unit_status'], permittedRequestTypes: ['unit_status'] } });
    const res = profiles.migrateSenderProfilesToContacts();
    expect(res.merged).toBe(1);
    expect(res.created).toBe(0);
    const contacts = store.load('contacts', []);
    expect(contacts.length).toBe(1); // no duplicate
    expect(contacts[0].operators).toContain('TUZR');
    expect(contacts[0].identityType).toBe('carrier');
  });

  it('creates a new contact when no match exists (no duplicate on rerun)', () => {
    store.save('slackSenderProfiles', { U9: { slackId: 'U9', name: 'New Person', type: 'carrier', operators: ['SAPB'] } });
    const res1 = profiles.migrateSenderProfilesToContacts();
    expect(res1.created).toBe(1);
    // Idempotent: re-running produces the same result (no new contact).
    const res2 = profiles.migrateSenderProfilesToContacts();
    const contacts = store.load('contacts', []);
    expect(contacts.filter(c => c.slackId === 'U9').length).toBe(1);
  });

  it('takes an immutable versioned backup of BOTH stores exactly once', () => {
    store.save('contacts', [{ id: 'c1', slackId: 'U1', name: 'Joe' }]);
    store.save('slackSenderProfiles', { U1: { slackId: 'U1', type: 'carrier' } });
    profiles.migrateSenderProfilesToContacts();
    const backup = store.load('fasMigrationBackup_v1', null);
    expect(backup).toBeTruthy();
    expect(Array.isArray(backup.contacts)).toBe(true);
    expect(backup.slackSenderProfiles).toBeTruthy();
    // Immutable: the original backup timestamp is preserved across reruns.
    const firstAt = backup.at;
    profiles.migrateSenderProfilesToContacts(); // no-op rerun
    expect(store.load('fasMigrationBackup_v1', {}).at).toBe(firstAt);
  });

  it('dry run performs NO writes (no backup, no contact change, legacy unmarked)', () => {
    store.save('contacts', []);
    store.save('slackSenderProfiles', { U1: { slackId: 'U1', type: 'carrier', operators: ['TUZR'] } });
    const res = profiles.migrateSenderProfilesToContacts({ dryRun: true });
    expect(res.created).toBe(1);        // reports what WOULD happen
    expect(store.load('contacts', []).length).toBe(0);       // nothing written
    expect(store.load('fasMigrationBackup_v1', null)).toBeNull();
    expect(store.load('slackSenderProfiles', {}).__migratedAt).toBeUndefined();
  });

  it('does not overwrite useful contact info with blanks', () => {
    store.save('contacts', [{ id: 'c1', slackId: 'U1', name: 'Joe Real', organization: 'AFP', type: 'slack' }]);
    store.save('slackSenderProfiles', { U1: { slackId: 'U1', name: '', org: '', type: 'carrier', operators: ['TUZR'] } });
    profiles.migrateSenderProfilesToContacts();
    const c = store.load('contacts', [])[0];
    expect(c.name).toBe('Joe Real');       // not blanked
    expect(c.organization).toBe('AFP');    // not blanked
    expect(c.operators).toContain('TUZR'); // scope added
  });

  it('after migration, a stale legacy profile no longer grants access', () => {
    // Legacy profile for U2 but NO contact for U2.
    store.save('slackSenderProfiles', { U1: { slackId: 'U1', type: 'carrier', operators: ['TUZR'] } });
    // Pre-migration, resolveSender would honor the legacy profile.
    const pre = profiles.resolveSender('U1');
    expect(pre.operators).toContain('TUZR');
    // Migrate (creates a contact for U1, marks legacy migrated).
    profiles.migrateSenderProfilesToContacts();
    // Now hand-add a DIFFERENT stale legacy profile that has NO contact.
    const legacy = store.load('slackSenderProfiles', {});
    legacy.U_STALE = { slackId: 'U_STALE', type: 'internal', operators: [], allowedDataCategories: ['uptake'] };
    store.save('slackSenderProfiles', legacy);
    const stale = profiles.resolveSender('U_STALE');
    // Migrated store -> legacy ignored -> falls to the limited DEFAULT, NOT the
    // legacy 'internal' profile. (Unknown now reads broadly, but it is the
    // default profile — not the legacy one — that answers, and it has NO
    // lifecycle/WR authority, unlike the legacy internal would have implied.)
    expect(stale.type).toBe('unknown');
    expect(stale.source).toBe('default-limited');
    expect(profiles.canRequest(stale, 'lifecycle_change')).toBe(false);
    expect(profiles.canRequest(stale, 'create_wr')).toBe(false);
  });

  it('is idempotent (rerun produces same merged/created counts of zero-new)', () => {
    store.save('contacts', [{ id: 'c1', slackId: 'U1', name: 'Joe' }]);
    store.save('slackSenderProfiles', { U1: { slackId: 'U1', type: 'carrier', operators: ['TUZR'] } });
    profiles.migrateSenderProfilesToContacts();
    const before = store.load('contacts', []).length;
    profiles.migrateSenderProfilesToContacts();
    const after = store.load('contacts', []).length;
    expect(after).toBe(before); // no new contacts on rerun
  });

  it('a rerun after completion is a TRUE no-op (noop flag, no rewrite)', () => {
    store.save('slackSenderProfiles', { U1: { slackId: 'U1', type: 'carrier', operators: ['TUZR'] } });
    profiles.migrateSenderProfilesToContacts();
    const contactsAfter1 = JSON.stringify(store.load('contacts', []));
    const res2 = profiles.migrateSenderProfilesToContacts();
    expect(res2.noop).toBe(true);
    expect(res2.merged).toBe(0);
    expect(res2.created).toBe(0);
    // Contacts untouched by the no-op rerun.
    expect(JSON.stringify(store.load('contacts', []))).toBe(contactsAfter1);
  });

  it('case-insensitive slackId match prevents a duplicate contact', () => {
    store.save('contacts', [{ id: 'c1', slackId: 'u1', name: 'Joe' }]); // lowercase
    store.save('slackSenderProfiles', { U1: { slackId: 'U1', type: 'carrier', operators: ['TUZR'] } }); // uppercase
    const res = profiles.migrateSenderProfilesToContacts();
    expect(res.merged).toBe(1);
    expect(res.created).toBe(0);
    expect(store.load('contacts', []).length).toBe(1); // no dup despite case diff
  });

  it('if contacts save FAILS, legacy profiles are NOT marked migrated (still honored)', () => {
    store.save('slackSenderProfiles', { U1: { slackId: 'U1', type: 'internal', allowedDataCategories: ['uptake'], operators: [] } });
    // Force store.save('contacts', ...) to throw.
    const realSave = store.save;
    store.save = (key, data) => { if (key === 'contacts') throw new Error('disk full'); return realSave(key, data); };
    let res;
    try { res = profiles.migrateSenderProfilesToContacts(); } finally { store.save = realSave; }
    expect(res.aborted).toBe('contacts-save-failed');
    // Legacy NOT marked migrated -> resolveSender still honors it.
    expect(store.load('slackSenderProfiles', {}).__migratedAt).toBeUndefined();
    const p = profiles.resolveSender('U1');
    expect(p.type).toBe('internal'); // legacy authorization preserved
  });

  it('aborts (no contact writes) if the backup cannot be written', () => {
    store.save('slackSenderProfiles', { U1: { slackId: 'U1', type: 'carrier', operators: ['TUZR'] } });
    store.save('contacts', []);
    const realSave = store.save;
    store.save = (key, data) => { if (key === 'fasMigrationBackup_v1') throw new Error('backup disk full'); return realSave(key, data); };
    let res;
    try { res = profiles.migrateSenderProfilesToContacts(); } finally { store.save = realSave; }
    expect(res.aborted).toBe('backup-failed');
    expect(store.load('contacts', []).length).toBe(0); // nothing migrated
    expect(store.load('slackSenderProfiles', {}).__migratedAt).toBeUndefined();
  });
});

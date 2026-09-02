import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-profval-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const profiles = require('../src/orcha/fas/sender-profiles');

beforeEach(() => { store.save('slackSenderProfiles', {}); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('FAS sender-profile validation (prevents malformed profiles granting access)', () => {
  it('rejects a profile without a slackId', () => {
    const r = profiles.saveProfile({ type: 'internal' });
    expect(r.ok).toBe(false);
  });

  it('drops unknown/wildcard data categories and request types', () => {
    const r = profiles.saveProfile({
      slackId: 'U1', type: 'carrier',
      allowedDataCategories: ['unit_status', '*', 'everything', 'work_orders'],
      permittedRequestTypes: ['unit_status', 'sudo', 'lifecycle_change'],
    });
    expect(r.ok).toBe(true);
    expect(r.profile.allowedDataCategories.sort()).toEqual(['unit_status', 'work_orders']);
    expect(r.profile.permittedRequestTypes.sort()).toEqual(['lifecycle_change', 'unit_status']);
    // A wildcard can never grant a category — canViewCategory is exact-match.
    expect(profiles.canViewCategory(r.profile, 'uptake')).toBe(false);
  });

  it('coerces an unknown type to "unknown" (no accidental internal escalation)', () => {
    const r = profiles.saveProfile({ slackId: 'U2', type: 'superadmin', allowedDataCategories: ['unit_status'] });
    expect(r.profile.type).toBe('unknown');
    // Unknown type is not treated as internal by the authorization summary.
    expect(profiles.authorizationSummary(r.profile).isInternal).toBe(false);
  });

  it('normalizes operators/domiciles to uppercase arrays; ignores non-array junk', () => {
    const r = profiles.saveProfile({ slackId: 'U3', type: 'carrier', operators: ['tuzr', ' sapb '], domiciles: 'not-an-array',
      allowedDataCategories: ['unit_status'] });
    expect(r.profile.operators).toEqual(['TUZR', 'SAPB']);
    expect(r.profile.domiciles).toEqual([]);
  });

  it('a saved carrier profile cannot pull a category it was not granted', () => {
    profiles.saveProfile({ slackId: 'U4', type: 'carrier', operators: ['TUZR'],
      allowedDataCategories: ['unit_status'] });
    const p = profiles.resolveSender('U4');
    expect(profiles.canViewCategory(p, 'unit_status')).toBe(true);
    expect(profiles.canViewCategory(p, 'vendor_contact')).toBe(false);
    expect(profiles.canViewCategory(p, 'uptake')).toBe(false);
  });
});

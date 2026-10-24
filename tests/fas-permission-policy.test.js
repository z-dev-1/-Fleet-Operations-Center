import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-policy-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const policy = require('../src/orcha/fas/permission-policy');
const contactBook = require('../src/services/contact-book');
const profiles = require('../src/orcha/fas/sender-profiles');

afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); store.save('contacts', []); });

describe('permission-policy — confidence tiers (spec #12)', () => {
  it('>= 0.95 → AUTO_APPLY', () => {
    expect(policy.tierForConfidence(0.95)).toBe(policy.TIER.AUTO);
    expect(policy.tierForConfidence(0.99)).toBe(policy.TIER.AUTO);
  });
  it('0.75–0.949 → SUGGEST', () => {
    expect(policy.tierForConfidence(0.75)).toBe(policy.TIER.SUGGEST);
    expect(policy.tierForConfidence(0.9)).toBe(policy.TIER.SUGGEST);
  });
  it('< 0.75 → DEFAULT', () => {
    expect(policy.tierForConfidence(0.74)).toBe(policy.TIER.DEFAULT);
    expect(policy.tierForConfidence(0)).toBe(policy.TIER.DEFAULT);
  });
});

describe('permission-policy — evaluate', () => {
  it('internal high-confidence → auto-apply, all-scope, but NO trusted actions', () => {
    const r = policy.evaluate({ identityType: 'internal', confidence: 0.97, slackId: 'U1' });
    expect(r.tier).toBe(policy.TIER.AUTO);
    expect(r.apply).toBe(true);
    expect(r.profile.operators).toEqual(['*']);
    expect(r.profile.lifecyclePermission).toBe('not_allowed'); // classification never trusts
    expect(r.profile.createWrPermission).toBe('not_allowed');
  });

  it('carrier high-confidence with SCAC → scoped to that SCAC, no actions', () => {
    const r = policy.evaluate({ identityType: 'carrier', confidence: 0.96, operators: ['TUZR'], slackId: 'U2' });
    expect(r.apply).toBe(true);
    expect(r.profile.operators).toEqual(['TUZR']);
    expect(r.profile.lifecyclePermission).toBe('not_allowed');
  });

  it('vendor → lifecycle + create-WR hard-locked even if trusted map tries', () => {
    const r = policy.evaluate({ identityType: 'vendor', confidence: 0.98, slackId: 'U3' },
      { trustedActors: { U3: { lifecyclePermission: 'trusted_autonomous', createWrPermission: 'trusted_autonomous' } } });
    expect(r.profile.lifecyclePermission).toBe('not_allowed');
    expect(r.profile.createWrPermission).toBe('not_allowed');
  });

  it('SUGGEST tier → effective stays conservative (unknown), proposed saved separately', () => {
    const r = policy.evaluate({ identityType: 'carrier', confidence: 0.85, operators: ['TUZR'], slackId: 'U4' });
    expect(r.tier).toBe(policy.TIER.SUGGEST);
    expect(r.apply).toBe(false);
    expect(r.profile.identityType).toBe('unknown');       // effective not widened
    expect(r.suggestion.identityType).toBe('carrier');    // proposal available for review
    expect(r.suggestion.operators).toEqual(['TUZR']);
  });

  it('DEFAULT tier → unknown profile, no widening', () => {
    const r = policy.evaluate({ identityType: 'carrier', confidence: 0.5, operators: ['TUZR'], slackId: 'U5' });
    expect(r.tier).toBe(policy.TIER.DEFAULT);
    expect(r.apply).toBe(false);
    expect(r.profile.identityType).toBe('unknown');
    expect(r.profile.operators).toEqual(['*']);
  });

  it('TRUSTED actors map (operator-configured) CAN grant trusted lifecycle for internal', () => {
    const r = policy.evaluate({ identityType: 'internal', confidence: 0.97, slackId: 'U6' },
      { trustedActors: { U6: { lifecyclePermission: 'trusted_autonomous', createWrPermission: 'may_request' } } });
    expect(r.profile.lifecyclePermission).toBe('trusted_autonomous'); // only via explicit operator map
    expect(r.profile.createWrPermission).toBe('may_request');
  });
});

describe('permission-policy — trusted-grant gate (spec #14)', () => {
  it('canGrantTrusted only for operator / operator_trusted_map', () => {
    expect(policy.canGrantTrusted('operator')).toBe(true);
    expect(policy.canGrantTrusted('operator_trusted_map')).toBe(true);
    expect(policy.canGrantTrusted('ai')).toBe(false);
    expect(policy.canGrantTrusted('classification')).toBe(false);
    expect(policy.canGrantTrusted('automated')).toBe(false);
  });

  it('sanitizeContactPermissionWrite downgrades trusted for non-operator source', () => {
    const out = policy.sanitizeContactPermissionWrite(
      { lifecyclePermission: 'trusted_autonomous', createWrPermission: 'trusted_autonomous' }, 'automated');
    expect(out.lifecyclePermission).toBe('may_request');
    expect(out.createWrPermission).toBe('may_request');
  });

  it('sanitizeContactPermissionWrite keeps trusted for operator source', () => {
    const out = policy.sanitizeContactPermissionWrite(
      { lifecyclePermission: 'trusted_autonomous' }, 'operator');
    expect(out.lifecyclePermission).toBe('trusted_autonomous');
  });
});

// ── INTEGRATION: Contact Book honors the policy gate on automated writes ─────
describe('contact-book — policy gate on writes', () => {
  it('automated upsert cannot persist trusted_autonomous (downgraded to may_request)', () => {
    store.save('contacts', []);
    const res = contactBook.upsert({
      type: 'slack', slackId: 'U_AUTO', name: 'Auto', identityType: 'internal',
      lifecyclePermission: 'trusted_autonomous', createWrPermission: 'trusted_autonomous',
    }, { operator: false });
    expect(res.ok).toBe(true);
    const p = profiles.resolveSender('U_AUTO', 'Auto');
    expect(p.lifecyclePermission).toBe('may_request');  // NOT trusted
    expect(p.createWrPermission).toBe('may_request');
  });

  it('operator upsert (default) CAN persist trusted_autonomous for internal', () => {
    store.save('contacts', []);
    const res = contactBook.upsert({
      type: 'slack', slackId: 'U_OP', name: 'Op', identityType: 'internal',
      lifecyclePermission: 'trusted_autonomous',
    }); // no opts → operator default true
    expect(res.ok).toBe(true);
    const p = profiles.resolveSender('U_OP', 'Op');
    expect(p.lifecyclePermission).toBe('trusted_autonomous');
  });

  it('vendor stays locked regardless of source', () => {
    store.save('contacts', []);
    contactBook.upsert({
      type: 'slack', slackId: 'U_VEND', name: 'Mech', identityType: 'vendor',
      lifecyclePermission: 'trusted_autonomous', createWrPermission: 'trusted_autonomous',
    }); // even as operator
    const p = profiles.resolveSender('U_VEND', 'Mech');
    expect(p.lifecyclePermission).toBe('not_allowed');
    expect(p.createWrPermission).toBe('not_allowed');
  });
});

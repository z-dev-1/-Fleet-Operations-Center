import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-sync-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const enrich = require('../src/slack/profile-enrichment');
const idResolver = require('../src/slack/identity-resolver');
const sync = require('../src/slack/contact-sync');
const profiles = require('../src/orcha/fas/sender-profiles');
const slackSend = require('../src/scrapers/slack_send');

beforeEach(() => { store.save('contacts', []); store.save('slackIdentityMappings', {}); store.save('slackIdentityChangeLog', []); });
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

// ── profile-enrichment freshness gate (spec #9) ─────────────────────────────
describe('profile-enrichment — shouldEnrich', () => {
  it('first contact (no profile) → enrich', () => {
    expect(enrich.shouldEnrich(null, {}).enrich).toBe(true);
    expect(enrich.shouldEnrich({}, {}).reason).toBe('first-contact');
  });
  it('fresh profile within TTL → skip', () => {
    const r = enrich.shouldEnrich({ slackProfileRetrievedAt: new Date().toISOString() }, { needClassification: false });
    expect(r.enrich).toBe(false);
  });
  it('stale profile (older than TTL) → enrich', () => {
    const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const r = enrich.shouldEnrich({ slackProfileRetrievedAt: old }, {});
    expect(r.enrich).toBe(true);
    expect(r.reason).toMatch(/stale/);
  });
  it('force → enrich even if fresh', () => {
    const r = enrich.shouldEnrich({ slackProfileRetrievedAt: new Date().toISOString() }, { force: true });
    expect(r.enrich).toBe(true);
  });
  it('missing critical field + needClassification → enrich', () => {
    const r = enrich.shouldEnrich({ slackProfileRetrievedAt: new Date().toISOString(), email: '' }, { needClassification: true });
    expect(r.enrich).toBe(true);
    expect(r.reason).toMatch(/missing critical/);
  });
});

// ── identity-resolver classification (spec #11) ─────────────────────────────
describe('identity-resolver — classify', () => {
  it('amazon.com email → internal, high confidence', () => {
    const c = idResolver.classify({ slackId: 'U1', email: 'z@amazon.com', emailDomain: 'amazon.com' });
    expect(c.identityType).toBe('internal');
    expect(c.confidence).toBeGreaterThanOrEqual(0.95);
  });
  it('restricted amazon guest → internal but SUGGEST-tier confidence', () => {
    const c = idResolver.classify({ slackId: 'U2', email: 'g@amazon.com', emailDomain: 'amazon.com', isRestricted: true });
    expect(c.identityType).toBe('internal');
    expect(c.confidence).toBeLessThan(0.95);
  });
  it('known vendor domain mapping → vendor, high confidence', () => {
    store.save('slackIdentityMappings', { vendorDomains: { 'amerit.com': 'Amerit Fleet' }, domicilesByDomain: { 'amerit.com': ['ABE40'] } });
    const c = idResolver.classify({ slackId: 'U3', email: 'm@amerit.com', emailDomain: 'amerit.com' });
    expect(c.identityType).toBe('vendor');
    expect(c.vendor).toBe('Amerit Fleet');
  });
  it('bot/app account → unknown, low confidence', () => {
    const c = idResolver.classify({ slackId: 'U4', isBot: true });
    expect(c.identityType).toBe('unknown');
    expect(c.confidence).toBeLessThan(0.75);
  });
  it('operator-confirmed existing identity wins with confidence 1.0', () => {
    const c = idResolver.classify({ slackId: 'U5', email: 'x@carrier.com', emailDomain: 'carrier.com' },
      { existing: { identityType: 'internal', permissionSource: 'ui-edited', organization: 'Amazon' } });
    expect(c.identityType).toBe('internal');
    expect(c.confidence).toBe(1.0);
  });
  it('external unmapped domain → unknown, conservative confidence', () => {
    const c = idResolver.classify({ slackId: 'U6', email: 'x@randomco.com', emailDomain: 'randomco.com' });
    expect(c.identityType).toBe('unknown');
    expect(c.confidence).toBeLessThan(0.75);
  });
});

// ── contact-sync orchestration (spec #8/#9/#11/#15/#16) ──────────────────────
describe('contact-sync — syncSender', () => {
  it('AUTO_APPLY: internal @amazon.com auto-classifies, writes metadata + identity, NO trusted', async () => {
    vi.spyOn(slackSend, 'fetchUserProfile').mockResolvedValue({
      slackId: 'U_INT', realName: 'Zila S', displayName: 'zila', email: 'zila@amazon.com', emailDomain: 'amazon.com',
      title: 'Fleet Specialist', timezone: 'America/New_York', customFields: {}, retrievedAt: new Date().toISOString(), source: 'slack.users.info',
    });
    const res = await sync.syncSender('U_INT', { name: 'Zila' });
    expect(res.ok).toBe(true);
    expect(res.action).toBe('applied');
    expect(res.identityType).toBe('internal');
    const p = profiles.resolveSender('U_INT', 'Zila');
    expect(p.type).toBe('internal');
    expect(p.lifecyclePermission).toBe('not_allowed'); // classification NEVER grants trusted/action
    // metadata persisted
    const c = store.load('contacts', []).find(x => x.slackId === 'U_INT');
    expect(c.email).toBe('zila@amazon.com');
    expect(c.slackProfileRetrievedAt).toBeTruthy();
    expect(c.permissionSource).toBe('auto-classified-v1');
    // provenance logged
    expect(sync.getChangeLog().some(e => e.slackId === 'U_INT' && e.change === 'identity')).toBe(true);
  });

  it('SUGGEST: weak signal stores a proposal, does NOT change effective permissions', async () => {
    vi.spyOn(slackSend, 'fetchUserProfile').mockResolvedValue({
      slackId: 'U_SUG', realName: 'Driver Dan', displayName: 'dan', email: '', emailDomain: '',
      title: 'Driver', org: '', customFields: {}, retrievedAt: new Date().toISOString(), source: 'slack.users.info',
    });
    const res = await sync.syncSender('U_SUG', { name: 'Dan' });
    expect(res.action).toBe('suggested');
    const c = store.load('contacts', []).find(x => x.slackId === 'U_SUG');
    expect(c.suggestedIdentity).toBeTruthy();
    expect(c.suggestedIdentity.identityType).toBe('carrier');
    // effective identity stays unknown (not widened)
    const p = profiles.resolveSender('U_SUG', 'Dan');
    expect(p.type).toBe('unknown');
  });

  it('automated sync can NEVER persist trusted even if policy somehow returned it (gate)', async () => {
    // Force a trusted actors map but through the AUTOMATED path — the contact
    // book gate (operator:false) strips it on write.
    vi.spyOn(slackSend, 'fetchUserProfile').mockResolvedValue({
      slackId: 'U_T', realName: 'T', email: 't@amazon.com', emailDomain: 'amazon.com', customFields: {}, retrievedAt: new Date().toISOString(),
    });
    await sync.syncSender('U_T', { trustedActors: { U_T: { lifecyclePermission: 'trusted_autonomous', createWrPermission: 'trusted_autonomous' } } });
    const p = profiles.resolveSender('U_T', 'T');
    // policy would apply the trusted map, but the automated contact-book write
    // gate downgrades it to may_request.
    expect(p.lifecyclePermission).toBe('may_request');
    expect(p.createWrPermission).toBe('may_request');
  });

  it('fresh profile → sync skips enrichment (no Slack call)', async () => {
    store.save('contacts', [{ id: 'c1', type: 'slack', slackId: 'U_FRESH', name: 'Fresh', identityType: 'internal',
      email: 'f@amazon.com', title: 'x', organization: 'Amazon', slackProfileRetrievedAt: new Date().toISOString() }]);
    const spy = vi.spyOn(slackSend, 'fetchUserProfile').mockResolvedValue(null);
    const res = await sync.syncSender('U_FRESH', {});
    expect(res.action).toBe('none');
    expect(spy).not.toHaveBeenCalled();
  });

  it('operator-confirmed identity is not downgraded by a weaker auto classification', async () => {
    store.save('contacts', [{ id: 'c2', type: 'slack', slackId: 'U_OP', name: 'Op', identityType: 'internal',
      permissionSource: 'ui-edited', organization: 'Amazon' }]);
    vi.spyOn(slackSend, 'fetchUserProfile').mockResolvedValue({
      slackId: 'U_OP', realName: 'Op', email: 'x@randomco.com', emailDomain: 'randomco.com', customFields: {}, retrievedAt: new Date().toISOString(),
    });
    await sync.syncSender('U_OP', { force: true });
    const p = profiles.resolveSender('U_OP', 'Op');
    expect(p.type).toBe('internal'); // stayed internal (operator identity won)
  });
});

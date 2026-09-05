// tests/fas-inbound-claim.test.js
//
// Spec v2 exactly-once: a durable, atomic inbound-message claim keyed by
// channel|ts|threadTs, acquired BEFORE either engine processes. Proves single
// ownership, no concurrent FAS+legacy, retry-no-duplicate, restart-no-resend,
// queued stays FAS, fallback transfers to legacy, stale lease recovery, and
// delivery-verified-before-terminal.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-claim-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const claim = require('../src/orcha/fas/inbound-claim');

const MSG = { channelId: 'C1', ts: '100.1', threadTs: null };
beforeEach(() => { store.save(claim.KEY, {}); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('claimKey identity', () => {
  it('includes threadTs so a thread reply and same-ts top-level do not collide', () => {
    expect(claim.claimKey('C1', '100.1', null)).not.toBe(claim.claimKey('C1', '100.1', '90.0'));
    expect(claim.claimKey('C1', '100.1', null)).toBe('C1|100.1|');
  });
});

describe('single ownership + no concurrent engines', () => {
  it('first acquire wins; a second concurrent acquire is refused while processing', () => {
    const a = claim.acquire({ ...MSG, owner: 'digital-fas' });
    expect(a.ok).toBe(true);
    const b = claim.acquire({ ...MSG, owner: 'legacy' });
    expect(b.ok).toBe(false);
    expect(b.already).toBe('processing');
  });

  it('legacy cannot take a message Digital FAS owns (queued response)', () => {
    const a = claim.acquire({ ...MSG, owner: 'digital-fas' });
    claim.markOwnedQueued(a.key);
    const b = claim.acquire({ ...MSG, owner: 'legacy' });
    expect(b.ok).toBe(false);
    expect(b.already).toBe('owned');
  });
});

describe('retry / restart do not duplicate a delivered reply', () => {
  it('a delivered claim is terminal — re-acquire is refused', () => {
    const a = claim.acquire({ ...MSG, owner: 'digital-fas' });
    const d = claim.markDelivered(a.key, 'S1');
    expect(d.ok).toBe(true);
    const again = claim.acquire({ ...MSG, owner: 'digital-fas' });
    expect(again.ok).toBe(false);
    expect(again.already).toBe('delivered');
    // Even the legacy engine cannot re-send it.
    expect(claim.acquire({ ...MSG, owner: 'legacy' }).ok).toBe(false);
  });

  it('markDelivered REQUIRES a Slack ts (delivery verified before terminal)', () => {
    const a = claim.acquire({ ...MSG, owner: 'digital-fas' });
    expect(claim.markDelivered(a.key, null).ok).toBe(false);
    expect(claim.isDelivered(a.key)).toBe(false);
  });
});

describe('failed delivery stays recoverable', () => {
  it('a failed claim can be re-acquired and retried', () => {
    const a = claim.acquire({ ...MSG, owner: 'digital-fas' });
    claim.markFailed(a.key, 'slack 503');
    const retry = claim.acquire({ ...MSG, owner: 'digital-fas' });
    expect(retry.ok).toBe(true);              // recoverable
    expect(retry.claim.attempts).toBeGreaterThanOrEqual(2);
  });
});

describe('technical fallback transfers ownership to legacy', () => {
  it('transferToLegacy marks the claim legacy-owned; FAS cannot then take it', () => {
    const a = claim.acquire({ ...MSG, owner: 'digital-fas' });
    claim.transferToLegacy(a.key, 'ai-timeout');
    const c = claim.get(a.key);
    expect(c.status).toBe('legacy');
    expect(c.owner).toBe('legacy');
    // Legacy can resume its own claim; a fresh FAS acquire cannot steal it.
    expect(claim.acquire({ ...MSG, owner: 'legacy' }).ok).toBe(true);
    expect(claim.acquire({ ...MSG, owner: 'digital-fas' }).ok).toBe(false);
  });

  it('transferToLegacy works even with no prior claim (creates a legacy claim)', () => {
    const c = claim.transferToLegacy(claim.claimKey('C9', '5.5', null), 'init-failure');
    expect(c.status).toBe('legacy');
  });
});

describe('stale lease recovery (restart)', () => {
  it('a processing claim with an expired lease can be taken over', () => {
    const a = claim.acquire({ ...MSG, owner: 'digital-fas' });
    // Force the lease into the past.
    const m = store.load(claim.KEY, {});
    m[a.key].leaseUntil = new Date(Date.now() - 1000).toISOString();
    store.save(claim.KEY, m);
    const b = claim.acquire({ ...MSG, owner: 'digital-fas' });
    expect(b.ok).toBe(true);                  // stale lease recovered
  });

  it('reconcile() marks stale processing leases recoverable on restart', () => {
    const a = claim.acquire({ ...MSG, owner: 'digital-fas' });
    const m = store.load(claim.KEY, {});
    m[a.key].leaseUntil = new Date(Date.now() - 1000).toISOString();
    store.save(claim.KEY, m);
    const r = claim.reconcile();
    expect(r.recovered).toBe(1);
    expect(claim.get(a.key).status).toBe('failed');
  });

  it('reconcile() does NOT touch delivered/owned/legacy claims', () => {
    const a = claim.acquire({ ...MSG, owner: 'digital-fas' });
    claim.markDelivered(a.key, 'S1');
    const r = claim.reconcile();
    expect(r.recovered).toBe(0);
    expect(claim.get(a.key).status).toBe('delivered');
  });
});

describe('durability across a simulated restart', () => {
  it('a delivered claim persists and blocks resend after reloading the store module', () => {
    const a = claim.acquire({ ...MSG, owner: 'digital-fas' });
    claim.markDelivered(a.key, 'S1');
    // Simulate restart: drop the module cache and reload against the same data dir.
    delete require.cache[require.resolve('../src/orcha/fas/inbound-claim')];
    const claim2 = require('../src/orcha/fas/inbound-claim');
    expect(claim2.isDelivered(a.key)).toBe(true);
    expect(claim2.acquire({ ...MSG, owner: 'digital-fas' }).ok).toBe(false);
  });
});

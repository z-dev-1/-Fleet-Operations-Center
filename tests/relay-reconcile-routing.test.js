import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'rr-routing-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const apply = require('../src/scrapers/relay_reconcile_apply');

// A MODE A config (auto-post on) so we can prove the SAFETY guard: even with
// auto-post enabled, a vendor message to a non-Relay destination must stage.
const CFG_AUTO = { enabled: true, autoPostToRelay: true, staleDays: 3, minConfidence: 0.5, maxUnitsPerSync: 8 };
const CFG_STAGE = { ...CFG_AUTO, autoPostToRelay: false };

beforeEach(() => {
  // Reset the staging + dedup ledgers between tests.
  store.save('relayReconcilePending', { items: [] });
  store.save('relayReconcileLog', {});
});

function pending() { return apply.loadPending().items; }

describe('apply routing — _destinationFor (spec §20/§33)', () => {
  it('gap-fill always routes to relay_internal', () => {
    expect(apply._destinationFor({ threadOfRecord: 'offsite' }, 'gap-fill')).toBe('relay_internal');
    expect(apply._destinationFor({ threadOfRecord: 'relay_internal' }, 'gap-fill')).toBe('relay_internal');
  });

  it('vendor message with an offsite thread routes to offsite', () => {
    expect(apply._destinationFor({ threadOfRecord: 'offsite' }, 'dealer-ask')).toBe('offsite');
  });

  it('vendor message with an integrated vendor stays in relay_vendor', () => {
    expect(apply._destinationFor({ threadOfRecord: 'relay_integrated_vendor' }, 'dealer-ask')).toBe('relay_vendor');
  });

  it('SAFETY: vendor message into an internal-only thread -> human_decision (never silently sent)', () => {
    expect(apply._destinationFor({ threadOfRecord: 'relay_internal' }, 'dealer-ask')).toBe('human_decision');
    expect(apply._destinationFor({ threadOfRecord: 'none' }, 'reply-to-vendor')).toBe('human_decision');
  });

  it('decisionRequired forces human_decision regardless of thread', () => {
    expect(apply._destinationFor({ threadOfRecord: 'offsite', decisionRequired: true }, 'reply-to-vendor')).toBe('human_decision');
  });
});

describe('apply routing — staged item carries the §34 pending-action fields', () => {
  it('stages a gap-fill as relay_internal with full context', async () => {
    const decision = {
      equipmentId: 'U1', _workRequestId: 'wr-1', relayHasLatest: false,
      relayNote: 'Dealer advised parts on order with ETA 10/22.', missingUpdate: 'parts on order ETA 10/22',
      currentStatus: 'Awaiting parts', nextStep: 'await parts', nextActionType: 'post_to_relay',
      repairPhase: 'awaiting_parts', waitingOn: 'parts', threadOfRecord: 'offsite',
      decisionRequired: false, confidence: 0.9, reasoning: 'parts fresh',
    };
    const res = await apply.applyReconcile(decision, { cfg: CFG_STAGE });
    expect(res.timeline).toBe(true);
    const gap = res.posts.find(p => p.kind === 'gap-fill');
    expect(gap.action).toBe('staged');
    expect(gap.destination).toBe('relay_internal');
    const it = pending().find(x => x.equipmentId === 'U1' && x.kind === 'gap-fill');
    expect(it.destination).toBe('relay_internal');
    expect(it.repairPhase).toBe('awaiting_parts');
    expect(it.waitingOn).toBe('parts');
    expect(it.threadOfRecord).toBe('offsite');
  });
});

describe('apply routing — SAFETY: a vendor message never auto-posts to the wrong place', () => {
  it('MODE A + offsite vendor chase: STAGED (not posted to Relay)', async () => {
    const decision = {
      equipmentId: 'U2', _workRequestId: 'wr-2', relayHasLatest: true,
      nextActionType: 'request_update', followUpNeeded: true, isStale: true,
      dealerAsk: 'Following up on the turbo parts — can you confirm arrival and a revised ETC?',
      repairPhase: 'awaiting_parts', waitingOn: 'vendor', threadOfRecord: 'offsite',
      confidence: 0.9, reasoning: 'stale',
    };
    const res = await apply.applyReconcile(decision, { cfg: CFG_AUTO });
    const ask = res.posts.find(p => p.kind === 'dealer-ask');
    // Even in MODE A (auto-post on), an offsite destination must STAGE.
    expect(ask.action).toBe('staged');
    expect(ask.destination).toBe('offsite');
  });

  it('MODE A + integrated vendor chase: posts to relay_vendor (safe — lives in Relay)', async () => {
    const decision = {
      equipmentId: 'U3', _workRequestId: 'wr-3', relayHasLatest: true,
      nextActionType: 'request_update', followUpNeeded: true, isStale: true,
      dealerAsk: 'Following up on the backordered parts for unit U3 — can you confirm the revised ETC?',
      repairPhase: 'parts_backordered', waitingOn: 'parts', threadOfRecord: 'relay_integrated_vendor',
      confidence: 0.9, reasoning: 'stale integrated',
    };
    // Use an empty WR target so no network post is attempted; the destination
    // resolution is what we assert (relay_vendor, i.e. routed to a Relay surface).
    const res = await apply.applyReconcile({ ...decision, _workRequestId: '' }, { cfg: CFG_AUTO });
    // With no WR target the post fails gracefully -> 'skipped', but destination
    // must still be relay_vendor (proving it was ROUTED to a Relay surface, not staged as offsite).
    const ask = res.posts.find(p => p.kind === 'dealer-ask');
    expect(ask.destination).toBe('relay_vendor');
    expect(['posted', 'skipped']).toContain(ask.action);
  });

  it('confirmPending refuses to post an offsite item to Relay (needs manual route)', async () => {
    apply._stage({ equipmentId: 'U4', _workRequestId: 'wr-4', threadOfRecord: 'offsite',
      dealerAsk: 'x', vendor: 'Rush' }, 'dealer-ask', 'Please confirm ETC.', 'offsite');
    const item = pending().find(x => x.equipmentId === 'U4');
    const r = await apply.confirmPending(item.id);
    expect(r.ok).toBe(false);
    expect(r.needsManualRoute).toBe(true);
    expect(r.destination).toBe('offsite');
  });

  it('confirmPending refuses a human_decision item (needs decision)', async () => {
    apply._stage({ equipmentId: 'U5', _workRequestId: 'wr-5', threadOfRecord: 'relay_internal',
      decisionRequired: true, decisionQuestion: 'Approve $475 freight?' }, 'reply-to-vendor', 'Approved.', 'human_decision');
    const item = pending().find(x => x.equipmentId === 'U5');
    const r = await apply.confirmPending(item.id);
    expect(r.ok).toBe(false);
    expect(r.needsDecision).toBe(true);
  });
});

describe('apply routing — we are the blocker: no vendor chase at all', () => {
  it('awaiting_approval posts an internal note only, no dealer-ask staged', async () => {
    const decision = {
      equipmentId: 'U6', _workRequestId: 'wr-6', relayHasLatest: false,
      nextActionType: 'post_to_relay', followUpNeeded: false, isStale: false,
      relayNote: 'Dealer submitted an estimate awaiting approval; internal review required.',
      dealerAsk: '', repairPhase: 'awaiting_approval', waitingOn: 'approval', threadOfRecord: 'offsite',
      confidence: 0.9,
    };
    const res = await apply.applyReconcile(decision, { cfg: CFG_STAGE });
    expect(res.posts.some(p => p.kind === 'dealer-ask' || p.kind === 'reply-to-vendor')).toBe(false);
    const gap = res.posts.find(p => p.kind === 'gap-fill');
    expect(gap.destination).toBe('relay_internal');
  });
});

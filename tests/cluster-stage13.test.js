import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);

const paths = require('../src/config/paths');
function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-stage13-'));
  paths.setDataDir(dir);
  return dir;
}
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('Stage 13 — Slack auto-reply state is in the sync allowlist', () => {
  const { isShared } = require('../src/cluster/sync-engine');

  it('Slack watermark/config keys are SHARED (so failover continues from the watermark)', () => {
    expect(isShared('slackDMAutoReplyConfig')).toBe(true);
    expect(isShared('slackChannelWatchConfig')).toBe(true);
  });

  it('Slack reply-dedup logs are SHARED (fleet-wide dedup → no double-reply)', () => {
    expect(isShared('slackDMReplies')).toBe(true);
    expect(isShared('slackChannelReplies')).toBe(true);
  });

  it('Slack thread/confirm/inbound tracking is SHARED (consistent across failover)', () => {
    expect(isShared('slackDMThreadReplyCount')).toBe(true);
    expect(isShared('slackMentionThreads')).toBe(true);
    expect(isShared('slackJustMePendingConfirm')).toBe(true);
    expect(isShared('slackInboundLifecycle')).toBe(true);
  });

  it('the Slack SESSION TOKEN is NOT synced (device-specific credential, never crosses machines)', () => {
    // slack_config.json is read via P.slackConfig, keyed in the store as
    // 'slackConfig' if at all — it must never be on the shared allowlist.
    expect(isShared('slackConfig')).toBe(false);
    expect(isShared('credentialsStore')).toBe(false);
  });

  it('exactly-once inbound claim ledgers remain SHARED (were already, still are)', () => {
    expect(isShared('fasInboundClaims')).toBe(true);
    expect(isShared('fasIdempotency')).toBe(true);
  });
});

describe('Stage 13 — leader publishes Slack config; standby does not', () => {
  let cluster, store;
  beforeEach(() => { freshDataDir(); store = require('../src/store'); cluster = require('../src/cluster'); cluster._reset(); });
  afterEach(async () => { try { await cluster.stop(); } catch (_) {} store.setWriteHook(null); });

  it('a LEADER auto-publishes a slackDMAutoReplyConfig write to the event log', async () => {
    cluster.init({ enabled: true, mode: 'ACTIVE', force: true });
    cluster.start({ setTimer: () => 0, clearTimer: () => {}, noSyncTimer: true, publishDebounceMs: 5 });
    const coord = cluster.getCoord();
    const a = await coord.tryAcquireLeadership(cluster.getInstanceId(), 'ACTIVE', 30000);
    cluster._setLease(a.record.fencingToken, a.record.expiresAt);

    // The laptop (leader) updates its DM auto-reply watermark — a normal write.
    store.save('slackDMAutoReplyConfig', { enabled: true, threads: { D123: { lastSeenTs: '1700000000.0001', name: 'Partner' } } });
    await tick();

    const log = await coord.readEventsSince(0, 100);
    const ev = log.events.find(e => e.key === 'slackDMAutoReplyConfig');
    expect(ev).toBeTruthy();
    expect(ev.doc.enabled).toBe(true);
    expect(ev.doc.threads.D123.lastSeenTs).toBe('1700000000.0001');
  });

  it('a STANDBY does NOT publish a slackDMAutoReplyConfig write', async () => {
    cluster.init({ enabled: true, mode: 'STANDBY', force: true });
    cluster.start({ setTimer: () => 0, clearTimer: () => {}, noSyncTimer: true });
    expect(cluster.isLeader()).toBe(false);
    store.save('slackDMAutoReplyConfig', { enabled: true, threads: {} });
    await tick();
    const log = await cluster.getCoord().readEventsSince(0, 100);
    expect(log.events.length).toBe(0);
  });
});

describe('Stage 13 — a standby APPLIES the synced watermark (continues, no catch-up)', () => {
  let cluster, store;
  beforeEach(() => { freshDataDir(); store = require('../src/store'); cluster = require('../src/cluster'); cluster._reset(); });
  afterEach(async () => { try { await cluster.stop(); } catch (_) {} store.setWriteHook(null); });

  it('pulling a leader-published watermark applies it to the standby store', async () => {
    cluster.init({ enabled: true, mode: 'STANDBY', force: true });
    cluster.start({ setTimer: () => 0, clearTimer: () => {}, noSyncTimer: true });
    const coord = cluster.getCoord();

    // Leader (another instance) published an auto-reply config with a watermark.
    await coord.appendEvent({
      key: 'slackDMAutoReplyConfig', version: 1,
      doc: { enabled: true, threads: { D999: { lastSeenTs: '1700000500.0003', name: 'Carrier' } } },
      instanceId: 'LAPTOP', token: 7,
    });

    await cluster.pullSharedState();
    const applied = store.load('slackDMAutoReplyConfig', null);
    expect(applied).toBeTruthy();
    expect(applied.enabled).toBe(true);
    // The standby now holds the SAME watermark the laptop had → on promotion it
    // answers only messages newer than this ts, never the backlog.
    expect(applied.threads.D999.lastSeenTs).toBe('1700000500.0003');
  });
});

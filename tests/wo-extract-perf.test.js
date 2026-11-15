// tests/wo-extract-perf.test.js — relay-extract AC25 size and safety: per-WO block cap,
// 2 MB fleet cap after refreshFleetFacts, renderer projection, snippet cap, 253-row time.
process.env.TZ = 'America/New_York';
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const X = require('../src/repair-intel/wo-extract');
const F = require('../src/repair-intel/wo-facts');

const NOW = Date.parse('2026-11-11T15:00:00Z');
const TODAY = '2026-11-11';
const ON = { enabled: true, aiOutput: true };
const pad = (n) => String(n).padStart(2, '0');

function bigRelay(n) {
  const comments = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2026, 8, 1) + i * 3600000 * 4);
    const md = pad((i % 12) + 1) + '/' + pad((i % 27) + 1);
    comments.push({
      timestamp: d.toISOString(), createdBy: i % 3 ? 'fasuser' + (i % 7) : 'Amerit', internalOnly: false, externalConsumers: [],
      text: 'Update ' + i + ': Part #' + (85150000 + i) + ' under Order #' + (3010280000 + i) + ' estimated ship date is ' + md
        + '. RO# 891-' + String(10000000 + i) + ' Tech ETA 11/12, ETC 11/' + pad((i % 20) + 1) + '. Called the dealer at (555) 010-' + String(1000 + (i % 9000)).slice(-4)
        + ', no answer. ETC Delay Reason-SOURCING_PARTS',
    });
  }
  return { id: 'svc-big', workOrders: [], workRequest: { id: 'wr-big', createdBy: 'Fleet Ops Center', createdDateTime: Date.parse('2026-08-30T12:00:00Z'), comments } };
}
function bigNotes(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2026, 8, 2) + i * 3600000 * 5);
    const ca = pad(d.getUTCMonth() + 1) + '/' + pad(d.getUTCDate()) + '/26 ' + pad((i % 11) + 1) + ':' + pad(i % 60) + ' am EDT';
    out.push({ id: 900000 + i, from: { groupId: -1, name: 'Dealer Advisor', location: 'M & K Truck Centers - Dunmore, PA (Volvo)', job_role: 'service_advisor' },
      recipients: [], subject: 'Status ' + i, created_at: ca,
      message: 'PART # ' + (86150000 + i) + ' ORDER # ' + (4010280000 + i) + ' RO # ' + (30319 + i) + 'SP DEALER CODE 5948D ETR is 11/' + pad((i % 25) + 1) + '/2026 Est Approved $' + (1000 + i) + '.00' });
  }
  return out;
}

const relayBlock = X.extractRelay(bigRelay(400), { now: NOW });
const offsiteBlock = X.extractDecisivNotes(bigNotes(300), { estimateId: '1', now: NOW });

function fleet() {
  const rows = [];
  for (let i = 0; i < 253; i++) {
    const r = { equipmentId: 'U' + i, workRequestId: 'wr-' + i, dealerName: '', subVendor: '', vendor: 'Amerit' };
    if (i < 34) { r.relayFacts = JSON.parse(JSON.stringify(relayBlock)); r.offsiteFacts = JSON.parse(JSON.stringify(offsiteBlock)); r.relayFactsWr = r.workRequestId; }
    rows.push(r);
  }
  return rows;
}
const blockBytes = (rows) => rows.reduce((s, r) => s + F.FACT_BLOCK_KEYS.reduce((t, k) => t + (r[k] ? JSON.stringify(r[k]).length : 0), 0), 0);

describe('AC25 size and safety', () => {
  it('400-comment WO -> relayFacts <= 32 KB with truncated > 0', () => {
    expect(relayBlock.counts.comments).toBe(400);
    expect(JSON.stringify(relayBlock).length).toBeLessThanOrEqual(32 * 1024);
    expect(relayBlock.counts.truncated).toBeGreaterThan(0);
    expect(JSON.stringify(offsiteBlock).length).toBeLessThanOrEqual(40 * 1024);
  });
  it('no snippet exceeds 140 chars', () => {
    for (const f of relayBlock.facts.concat(offsiteBlock.facts)) expect(f.snippet.length).toBeLessThanOrEqual(140);
  });
  it('253-row fleet with 34 full-size rows -> blocks <= 2 MB after refreshFleetFacts', () => {
    const rows = fleet();
    expect(blockBytes(rows)).toBeGreaterThan(2 * 1024 * 1024);
    F.refreshFleetFacts(rows, ON, TODAY);
    expect(blockBytes(rows)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(rows[0].partNumbers).not.toBe('');
    expect(rows.slice(0, 34).some((r) => r.relayFacts.counts.truncated > relayBlock.counts.truncated || r.offsiteFacts.counts.truncated > offsiteBlock.counts.truncated)).toBe(true);
  });
  it('253-row refreshFleetFacts < 150 ms', () => {
    F.refreshFleetFacts(fleet(), ON, TODAY);   // warm-up
    // Best of 3 fresh fleets (each run trims), measured as process CPU time (vitest runs each file in
    // its own fork), so the bound is the code's cost and not parallel-suite scheduler contention.
    let ms = Infinity;
    for (let i = 0; i < 3; i++) {
      const rows = fleet();
      const c0 = process.cpuUsage();
      F.refreshFleetFacts(rows, ON, TODAY);
      const c = process.cpuUsage(c0);
      ms = Math.min(ms, (c.user + c.system) / 1000);
    }
    expect(ms).toBeLessThan(150);
  });
  it('rendererView / rendererRow strip the blocks; the source keeps them', () => {
    const rows = fleet().slice(0, 40);
    const d = { rows, meta: 1 };
    const v = F.rendererView(d);
    expect(v).not.toBe(d);
    expect(v.meta).toBe(1);
    for (const r of v.rows) { expect('relayFacts' in r).toBe(false); expect('offsiteFacts' in r).toBe(false); }
    expect(d.rows[0].relayFacts).toBeTruthy();
    expect(v.rows[39]).toBe(d.rows[39]);           // rows without blocks are not copied
    const plain = { rows: [{ equipmentId: 'A' }] };
    expect(F.rendererView(plain)).toBe(plain);
    const one = F.rendererRow(rows[0]);
    expect('relayFacts' in one).toBe(false);
    expect(rows[0].relayFacts).toBeTruthy();
    expect(F.rendererRow(null)).toBe(null);
  });
});

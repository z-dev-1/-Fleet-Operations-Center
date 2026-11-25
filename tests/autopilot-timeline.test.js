// tests/autopilot-timeline.test.js — Autopilot V2 §7.3 timeline reuse and proposals, pure part (AC-22).
process.env.TZ = 'America/New_York';
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const timeline = require('../src/autopilot/timeline');
const evidence = require('../src/autopilot/evidence');
const F = require('./helpers/autopilot-fakes.cjs');
const { runInvestigation } = require('../src/autopilot/investigate');
const { createLimiter } = require('../src/autopilot/limiter');

const NOW = Date.parse('2026-11-20T15:00:00Z');
const DOC = {
  322283: {
    timeline: ['11/15 - Vendor: unit arrived', '11/16 - Vendor: diagnosis turbo', '11/17 - Hidden line text', '11/18 - Waiting on road test', 'not a dated line'].join('\n'),
    priorHistory: '10/01 - Prior WR: brakes',
    hiddenEntries: ['11/17 - Hidden line text'],
    manualEntries: ['11/18 - Waiting on road test'],
    timelineDigest: { v: 1, lines: ['11/16 - Turbo diagnosed', 'no date here'], generatedAt: '2026-11-19T12:00:00Z' },
  },
};

describe('publishedItems', () => {
  const items = timeline.publishedItems(DOC, '322283', { now: NOW });
  const lines = items.filter((it) => it.field === 'line');

  it('hidden lines removed, undated lines ignored, priorHistory kept', () => {
    expect(lines.map((it) => it.value)).toEqual(['10/01 - Prior WR: brakes', '11/15 - Vendor: unit arrived', '11/16 - Vendor: diagnosis turbo', '11/18 - Waiting on road test']);
  });

  it('manual lines are untrusted_text + manual_entry; others derived_ai; observedAt from MM/DD', () => {
    const manual = lines.find((it) => /road test/.test(it.value));
    expect(manual.trust).toBe('untrusted_text');
    expect(manual.flags).toContain('manual_entry');
    for (const it of lines.filter((x) => x !== manual)) { expect(it.trust).toBe('derived_ai'); expect(it.flags).not.toContain('manual_entry'); }
    expect(lines[1].observedAt).toBe(Date.parse('2026-11-15T12:00:00'));
    expect(lines[0].observedAt).toBe(Date.parse('2026-10-01T12:00:00'));
    for (const it of items) { expect(it.source).toBe('timeline'); expect(it.authorityTag).toBe(null); expect(it.retrievedAt).toBe(NOW); }
  });

  it('digest lines only for v === 1; undated digest lines use generatedAt', () => {
    const dig = items.filter((it) => it.field === 'digest');
    expect(dig.map((it) => it.sourceRef)).toEqual(['timeline/digest/0', 'timeline/digest/1']);
    expect(dig[0].trust).toBe('derived_ai');
    expect(dig[1].observedAt).toBe(Date.parse('2026-11-19T12:00:00Z'));
    const v2 = timeline.publishedItems({ 322283: Object.assign({}, DOC['322283'], { timelineDigest: { v: 2, lines: ['11/16 - x'] } }) }, '322283', { now: NOW });
    expect(v2.filter((it) => it.field === 'digest')).toEqual([]);
  });

  it('caps: 60 lines + 12 digest lines, values <= 300', () => {
    const many = Array.from({ length: 80 }, (_, i) => '11/' + String((i % 19) + 1).padStart(2, '0') + ' - line ' + i + ' ' + 'x'.repeat(400)).join('\n');
    const doc = { U1: { timeline: many, timelineDigest: { v: 1, lines: Array.from({ length: 20 }, (_, i) => '11/1' + (i % 9) + ' - d' + i) } } };
    const it2 = timeline.publishedItems(doc, 'u1', { now: NOW });
    expect(it2.filter((x) => x.field === 'line').length).toBe(60);
    expect(it2.filter((x) => x.field === 'digest').length).toBe(12);
    for (const x of it2) expect(String(x.value).length).toBeLessThanOrEqual(300);
  });
});

describe('buildProposals', () => {
  const col = evidence.createCollector({ now: NOW });
  const stage = col.add('decisiv', 'stage', 'repair', { entry: { since: '2026-11-19T14:00:00Z' }, retrievedAt: NOW }, { sourceRef: 'decisiv/1' });
  const fallback = col.add('aap_cache', 'estimateStatus', 'pending', { row: {}, buildAtMs: NOW - 1000 }, { sourceRef: 'row/estimateStatus' });
  const etc = col.add('dtna', 'repairEtc', '2026-11-25', { entry: { stageSince: '2026-11-18T10:00:00Z' } }, { sourceRef: 'dtna/C1' });
  const tl = timeline.publishedItems(DOC, '322283', { now: NOW });
  const rec = { case_id: 'c1', unit_id: '322283', episode_key: '322283:2026-11-15' };
  const output = { generatedBy: 'ai', inferences: [
    { statement: 'Repair resumed after the parts arrived', confidence: 0.7, evidenceIds: [stage.evidenceId] },
    { statement: 'Low confidence guess', confidence: 0.4, evidenceIds: [stage.evidenceId] },
    { statement: 'Circular from the timeline', confidence: 0.9, evidenceIds: [tl[1].evidenceId] },
  ] };
  const items = col.items.concat(tl);

  it('verified from structured source-timed items; inferred from supported inferences >= 0.6', () => {
    const rows = timeline.buildProposals({ rec, items, output, published: {}, hiddenSigs: [], runId: 'r1', now: NOW });
    const desc = rows.map((r) => r.basis + ':' + r.kind + ':' + r.description);
    expect(desc).toContain('verified:stage:Stage: repair (Decisiv)');
    expect(desc).toContain('verified:eta:Repair ETC 2026-11-25 stated (offsiteevent)');
    expect(desc).toContain('inferred:inference:Repair resumed after the parts arrived');
    expect(desc.some((d) => /estimate/i.test(d))).toBe(false);          // build-time observedAt is not a source time
    expect(desc.some((d) => /Low confidence|Circular/.test(d))).toBe(false);
    expect(fallback.observedFrom).toBe('buildAt');
    for (const r of rows) {
      expect(r.fingerprint).toMatch(/^[a-f0-9]{40}$/);
      expect(r.evidence_ref).toMatch(/^ev_/);
      expect(r.episode_key).toBe('322283:2026-11-15');
      expect(r.run_id).toBe('r1');
    }
    expect(rows.length).toBeLessThanOrEqual(20);
  });

  it('the same evidence twice gives the same fingerprints (deduplicated)', () => {
    const a = timeline.buildProposals({ rec, items: items.concat(items), output, runId: 'r1', now: NOW });
    const b = timeline.buildProposals({ rec, items, output, runId: 'r2', now: NOW + 3600e3 });
    expect(new Set(a.map((r) => r.fingerprint)).size).toBe(a.length);
    expect(a.map((r) => r.fingerprint)).toEqual(b.map((r) => r.fingerprint));
  });

  it('a published or hidden line with the same signature on the same MM/DD is skipped', () => {
    const all = timeline.buildProposals({ rec, items, output, now: NOW });
    const st = all.find((r) => r.kind === 'stage');
    const md = new Date(st.event_at);
    const mmdd = String(md.getMonth() + 1).padStart(2, '0') + '/' + String(md.getDate()).padStart(2, '0');
    const sig = 'stage: repair (decisiv)';
    const pub = timeline.buildProposals({ rec, items, output, published: { [mmdd]: [sig] }, now: NOW });
    expect(pub.some((r) => r.kind === 'stage')).toBe(false);
    const hid = timeline.buildProposals({ rec, items, output, hiddenSigs: [sig], now: NOW });
    expect(hid.some((r) => r.kind === 'stage')).toBe(false);
    const other = timeline.buildProposals({ rec, items, output, published: { '01/01': [sig] }, now: NOW });
    expect(other.some((r) => r.kind === 'stage')).toBe(true);
  });

  it('publishedIndex groups signatures by MM/DD and lists hidden signatures', () => {
    const ix = timeline.publishedIndex(DOC, '322283');
    expect(ix.published['11/15']).toEqual(['vendor: unit arrived']);
    expect(ix.hiddenSigs).toEqual(['hidden line text']);
  });
});

describe('full multi-turn run (AC-22)', () => {
  const U = '322283';
  const turn = (tools) => ({ schemaVersion: 2, decision: 'request_tools', tools, memory: {} });
  const finalFrom = (o) => ({ schemaVersion: 2, decision: 'final', result: F.aiReply(o.prompt) });

  it('notesStore is byte-identical after a multi-turn run; a second run on the same evidence adds no duplicate proposals', async () => {
    F.freshDb('tlrun');
    F.schema.ensureSchema();
    const ck = F.clock();
    const w = F.mkWorld({
      rows: [F.baseRow({ asistSrUrl: F.SR, decisivCaseId: '21350186' })], isolated: true,
      dtna: { [U]: [{ caseId: 'C1', unitId: U, offsiteStage: 'repair', stageSince: '2026-11-18T00:00:00Z', repairEtc: '2026-11-25' }] },
      decisivStatus: () => ({ ok: true, value: { stage: 'repair', status: 'open' } }),
    });
    w.docs.notesStore = JSON.parse(JSON.stringify(DOC));
    const before = JSON.stringify(w.docs.notesStore);
    const cfg = F.cfgOf({ features: { liveReads: true, multiTurn: true } });
    const reason = F.fakePlanner([turn([{ tool: 'dtna_case', args: { unit: U } }, { tool: 'existing_timeline', args: { unit: U } }]), finalFrom,
      turn([{ tool: 'dtna_case', args: { unit: U } }]), finalFrom]);
    const deps = () => ({ ports: F.fakePorts(w), cfg, now: ck.now, rand: () => 0.5, owner: 'own', reason, limiter: createLimiter({ now: ck.now, random: () => 0 }), trigger: 'new' });
    const { caseId } = F.seedCase(U);
    expect((await runInvestigation(caseId, deps())).aiStatus).toBe('ok');
    expect(JSON.stringify(w.docs.notesStore)).toBe(before);
    const first = F.cs.listProposals(caseId);
    expect(first.length).toBeGreaterThan(0);
    ck.advance(F.H);
    expect(F.cs.requestDeep(caseId, { now: ck.now() }).ok).toBe(true);
    expect((await runInvestigation(caseId, Object.assign(deps(), { trigger: 'manual' }))).aiStatus).toBe('ok');
    expect(JSON.stringify(w.docs.notesStore)).toBe(before);
    const second = F.cs.listProposals(caseId);
    expect(second.map((p) => p.fingerprint)).toEqual(first.map((p) => p.fingerprint));
    expect(reason.remaining()).toBe(0);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const sug = require('../src/orcha/escalation-suggest');

const OPTIONS = [
  { value: 'MCS_LEAD', displayText: 'MCS Lead' },
  { value: 'MCS_HIGH_VALUE_ESTIMATE', displayText: 'High Value Estimate' },
  { value: 'TOM_PENDING_ACTION', displayText: 'TOM Pending Action' },
  { value: 'FAS', displayText: 'FAS' },
];
const ROW = { equipmentId: '320160', domicileSite: 'DXX1', vendor: 'Rush', workDuration: '3d 2h 5m' };

function rule(row, canon, current = [], options = OPTIONS) {
  return sug.deterministicSuggestion({ row: { ...ROW, ...row }, canon, options, current });
}

describe('deterministicSuggestion', () => {
  it('high estimate -> MCS_HIGH_VALUE_ESTIMATE', () => {
    const s = rule({ estimatePendingCost: '$6,200.00' }, { waitingOn: 'us' });
    expect(s.team).toBe('MCS_HIGH_VALUE_ESTIMATE');
    expect(s.source).toBe('rules');
    expect(s.comment).toContain('320160');
    expect(s.comment).toContain('High Value Estimate');
  });
  it('approval with cost -> MCS_HIGH_VALUE_ESTIMATE, without cost -> TOM_PENDING_ACTION', () => {
    expect(rule({ estimatePendingCost: 800 }, { waitingOn: 'approval' }).team).toBe('MCS_HIGH_VALUE_ESTIMATE');
    expect(rule({ estimatePendingCost: '' }, { waitingOn: 'approval' }).team).toBe('TOM_PENDING_ACTION');
  });
  it('vendor/parts 7+ days -> MCS_LEAD, else FAS', () => {
    expect(rule({ workDuration: '9d 1h 0m' }, { waitingOn: 'parts' }).team).toBe('MCS_LEAD');
    expect(rule({ workDuration: 8 }, { waitingOn: 'vendor' }).team).toBe('MCS_LEAD');
    expect(rule({ workDuration: '2d 0h 0m' }, { waitingOn: 'vendor' }).team).toBe('FAS');
  });
  it('days down falls back to row.created', () => {
    const created = new Date(Date.now() - 10 * 86400000).toISOString();
    expect(rule({ workDuration: '', created }, { waitingOn: 'vendor' }).team).toBe('MCS_LEAD');
  });
  it('default -> MCS_LEAD, else first selectable', () => {
    expect(rule({}, { waitingOn: 'us' }).team).toBe('MCS_LEAD');
    expect(rule({}, null, ['MCS_LEAD']).team).toBe('MCS_HIGH_VALUE_ESTIMATE');
  });
  it('skips an already-applied team', () => {
    expect(rule({ estimatePendingCost: 9000 }, { waitingOn: 'us' }, ['MCS_HIGH_VALUE_ESTIMATE']).team).toBe('MCS_LEAD');
  });
  it('no selectable options -> team null', () => {
    const s = rule({}, {}, [], []);
    expect(s.team).toBeNull();
    expect(s.comment).toBe('');
    expect(rule({}, {}, OPTIONS.map((o) => o.value)).team).toBeNull();
  });
  it('clips the comment to 2000 chars', () => {
    const s = rule({}, { waitingOn: 'us', situation: 'x'.repeat(5000) });
    expect(s.comment.length).toBe(2000);
  });
});

describe('buildEscalationPrompt', () => {
  it('lists only selectable values', () => {
    const p = sug.buildEscalationPrompt({ unitId: '320160', unitContext: 'ctx', options: OPTIONS, current: ['FAS', 'MCS_LEAD'] });
    expect(p).toContain('MCS_HIGH_VALUE_ESTIMATE — High Value Estimate');
    expect(p).toContain('TOM_PENDING_ACTION');
    expect(p).not.toMatch(/^FAS —/m);
    expect(p).not.toContain('MCS_LEAD —');
    expect(p).toContain('ctx');
  });
});

describe('suggestEscalation', () => {
  const baseDeps = {
    getRow: (id) => ({ ...ROW, equipmentId: id }),
    getCanonical: () => ({ waitingOn: 'us', status: 'in_repair' }),
    buildUnitContext: () => 'UNIT CONTEXT',
  };

  it('uses a valid AI answer wrapped in prose', async () => {
    const ask = vi.fn(async () => 'Sure! {"team":"fas","comment":"Vendor not responding {see notes}","rationale":"Stalled"} hope that helps');
    const s = await sug.suggestEscalation({ unitId: '320160', options: OPTIONS, current: [] }, { ...baseDeps, ask });
    expect(s).toEqual({ team: 'FAS', comment: 'Vendor not responding {see notes}', rationale: 'Stalled', source: 'ai' });
    const [, opts] = ask.mock.calls[0];
    expect(opts).toMatchObject({ maxTokens: 700, priority: 'high' });
    expect(opts.signal).toBeDefined();
  });
  it('falls back when AI picks an unlisted team', async () => {
    const ask = async () => '{"team":"NOPE","comment":"x","rationale":"y"}';
    const s = await sug.suggestEscalation({ unitId: '320160', options: OPTIONS, current: [] }, { ...baseDeps, ask });
    expect(s.source).toBe('rules');
    expect(s.team).toBe('MCS_LEAD');
    expect(s.aiError).toBeTruthy();
  });
  it('falls back when AI picks an already-applied team', async () => {
    const ask = async () => '{"team":"FAS","comment":"x"}';
    const s = await sug.suggestEscalation({ unitId: '320160', options: OPTIONS, current: ['FAS'] }, { ...baseDeps, ask });
    expect(s.source).toBe('rules');
  });
  it('falls back with aiError when AI throws', async () => {
    const ask = async () => { throw new Error('lanes down'); };
    const s = await sug.suggestEscalation({ unitId: '320160', options: OPTIONS, current: [] }, { ...baseDeps, ask });
    expect(s.source).toBe('rules');
    expect(s.aiError).toBe('lanes down');
  });
  it('falls back on timeout when ask never resolves', async () => {
    const ask = () => new Promise(() => {});
    const s = await sug.suggestEscalation({ unitId: '320160', options: OPTIONS, current: [] }, { ...baseDeps, ask, timeoutMs: 20 });
    expect(s.source).toBe('rules');
    expect(s.aiError).toMatch(/timed out/);
  });
  it('does not call AI when nothing is selectable', async () => {
    const ask = vi.fn();
    const s = await sug.suggestEscalation({ unitId: '320160', options: OPTIONS, current: OPTIONS.map((o) => o.value) }, { ...baseDeps, ask });
    expect(s.team).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });
  it('survives getCanonical throwing', async () => {
    const ask = async () => { throw new Error('x'); };
    const s = await sug.suggestEscalation({ unitId: '320160', options: OPTIONS, current: [] },
      { ...baseDeps, getCanonical: () => { throw new Error('boom'); }, ask });
    expect(s.team).toBe('MCS_LEAD');
  });
});

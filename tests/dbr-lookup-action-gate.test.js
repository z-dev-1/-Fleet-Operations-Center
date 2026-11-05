// DBR_LOOKUP Just Me action-gate rule (plan.md D9, FEAT-002 step 8): a read-only
// rule that needs the dbr/uptime keyword AND the target (or my/mine) typed by Z.
// Every other rule is unchanged.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const gate = require('../src/justme-context/action-gate');

const run = (typed, actions, contacts) => gate.filterActions(actions, { typedText: typed, contacts: contacts || [] });

describe('DBR_LOOKUP gate rule', () => {
  const allow = [
    ["what's the DBR for AUVTE?", { type: 'DBR_LOOKUP', target: 'AUVTE' }],
    ['dbr for my sites', { type: 'DBR_LOOKUP', kind: 'mine' }],
    ['dbr for mine', { type: 'DBR_LOOKUP' }],
    ['uptime for oak-w', { type: 'DBR_LOOKUP', target: 'OAK-W' }],
  ];
  for (const [typed, a] of allow) {
    it('allow: "' + typed + '" → ' + JSON.stringify(a), () => {
      const r = run(typed, [a]);
      expect(r.dropped).toEqual([]);
      expect(r.allowed).toEqual([a]);
    });
  }

  it('drops a target Z did not type (TARGET)', () => {
    expect(run('dbr for AUVTE', [{ type: 'DBR_LOOKUP', target: 'OAK-W' }]).dropped)
      .toEqual([{ type: 'DBR_LOOKUP', reason: gate.DROP.TARGET }]);
  });
  it('drops kind:mine when Z did not say my/mine (TARGET)', () => {
    expect(run('dbr for AUVTE', [{ type: 'DBR_LOOKUP', kind: 'mine' }]).dropped)
      .toEqual([{ type: 'DBR_LOOKUP', reason: gate.DROP.TARGET }]);
  });
  it('a target only partly typed is not a whole token (TARGET)', () => {
    expect(run('dbr for AUVTE2', [{ type: 'DBR_LOOKUP', target: 'AUVTE' }]).dropped[0].reason).toBe(gate.DROP.TARGET);
  });
  it('a 1-char or over-long target is dropped (TARGET)', () => {
    expect(run('dbr for a', [{ type: 'DBR_LOOKUP', target: 'a' }]).dropped[0].reason).toBe(gate.DROP.TARGET);
    const long = 'x'.repeat(25);
    expect(run('dbr for ' + long, [{ type: 'DBR_LOOKUP', target: long }]).dropped[0].reason).toBe(gate.DROP.TARGET);
  });
  it('a content-proposed lookup has no keyword in Z\'s text (NOT_COMMAND)', () => {
    expect(run('summarize this', [{ type: 'DBR_LOOKUP', target: 'AUVTE' }]).dropped)
      .toEqual([{ type: 'DBR_LOOKUP', reason: gate.DROP.NOT_COMMAND }]);
  });
  it('the keyword alone does not let a content target through (AUVTE typed nowhere)', () => {
    expect(run('summarize this dbr report', [{ type: 'DBR_LOOKUP', target: 'AUVTE' }]).dropped[0].reason).toBe(gate.DROP.TARGET);
  });
  it('empty typed text drops it (NO_TEXT)', () => {
    expect(run('', [{ type: 'DBR_LOOKUP', target: 'AUVTE' }]).dropped)
      .toEqual([{ type: 'DBR_LOOKUP', reason: gate.DROP.NO_TEXT }]);
  });
  it('has no free-text screening fields (read-only, nothing outward)', () => {
    const a = { type: 'DBR_LOOKUP', target: 'AUVTE', kind: 'domicile' };
    expect(run('dbr for auvte', [a]).allowed[0]).toEqual(a);
  });
});

describe('other rules unchanged next to DBR_LOOKUP', () => {
  it('DBR_PULL still needs a command verb', () => {
    expect(run('get dbr data', [{ type: 'DBR_PULL' }]).allowed).toHaveLength(1);
    expect(run("what's the dbr", [{ type: 'DBR_PULL' }]).dropped[0].reason).toBe(gate.DROP.NOT_COMMAND);
  });
  it('SLACK / EMAIL not typed are still dropped alongside an allowed lookup', () => {
    const r = run('dbr for AUVTE', [
      { type: 'DBR_LOOKUP', target: 'AUVTE' },
      { type: 'SLACK', recipient: 'bob', message: 'hi' },
      { type: 'EMAIL', to: 'bob@example.com', subject: 's', body: 'b' },
    ]);
    expect(r.allowed.map((a) => a.type)).toEqual(['DBR_LOOKUP']);
    expect(r.dropped.map((d) => d.type)).toEqual(['SLACK', 'EMAIL']);
  });
  it('only DBR_LOOKUP was added to ACTION_RULES', () => {
    expect(Object.keys(gate.ACTION_RULES)).toEqual([
      'SYNC', 'SP_PUSH', 'DBR_PULL', 'BRIEFING', 'EMAIL_TRIAGE', 'DAILY_NOTES', 'TIMELINE', 'CREATE_WR', 'REMIND', 'PIN',
      'UNPIN', 'SCHEDULE', 'ASK_INTERNAL', 'SLACK', 'EMAIL', 'MOVE_UNIT', 'APPROVE_WR', 'REVIEW_QUEUE', 'READ_SLACK',
      'DRAFT_FOLLOWUPS', 'DBR_LOOKUP',
    ]);
  });
});

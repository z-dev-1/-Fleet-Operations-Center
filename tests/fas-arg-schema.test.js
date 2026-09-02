import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { validateArgs, capResult, MAX_RESULT_CHARS } = require('../src/orcha/fas/arg-schema');

describe('Part 15: central argument validation', () => {
  it('accepts valid GET_UNIT args and drops unknown fields', () => {
    const r = validateArgs('GET_UNIT', { unit: '320160', bogus: 'x', nested: { a: 1 } });
    expect(r.ok).toBe(true);
    expect(r.cleaned.unit).toBe('320160');
    expect(r.cleaned.bogus).toBeUndefined(); // unknown field dropped
  });

  it('rejects a missing required field', () => {
    const r = validateArgs('GET_UNIT', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unit/);
  });

  it('rejects an invalid unit format', () => {
    const r = validateArgs('GET_UNIT', { unit: 'drop table; --' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unit/);
  });

  it('rejects an over-length string', () => {
    const r = validateArgs('ASK_INTERNAL', { question: 'x'.repeat(5000) });
    expect(r.ok).toBe(false);
  });

  it('validates and normalizes operator/domicile codes to uppercase', () => {
    const r = validateArgs('SEARCH_SLACK', { operator: 'tuzr', keywords: 'amerit' });
    expect(r.ok).toBe(true);
    expect(r.cleaned.operator).toBe('TUZR');
  });

  it('rejects an invalid date for CREATE_REMINDER.when', () => {
    const bad = validateArgs('CREATE_REMINDER', { note: 'x', when: 'someday' });
    expect(bad.ok).toBe(false);
    const good = validateArgs('CREATE_REMINDER', { note: 'x', when: new Date(Date.now() + 864e5).toISOString() });
    expect(good.ok).toBe(true);
  });

  it('MOVE_UNIT requires an aap-na URL for assetUrl', () => {
    const bad = validateArgs('MOVE_UNIT', { unit: '320160', state: 'Active', assetUrl: 'https://evil.example/x' });
    expect(bad.ok).toBe(false);
    const good = validateArgs('MOVE_UNIT', { unit: '320160', state: 'Active', assetUrl: 'https://aap-na.corp.amazon.com/v2/service/abc' });
    expect(good.ok).toBe(true);
  });

  it('SEND_SLACK_MESSAGE requires channelId + message', () => {
    expect(validateArgs('SEND_SLACK_MESSAGE', { message: 'hi' }).ok).toBe(false);
    expect(validateArgs('SEND_SLACK_MESSAGE', { channelId: 'C123', message: 'hi' }).ok).toBe(true);
  });

  it('always carries slackId through for authorization context', () => {
    const r = validateArgs('GET_UNIT', { unit: '320160', slackId: 'U_ABC' });
    expect(r.cleaned.slackId).toBe('U_ABC');
  });

  it('capResult truncates an oversized result', () => {
    const huge = { ok: true, verifiedFacts: [{ field: 'x', value: 'y'.repeat(MAX_RESULT_CHARS + 100) }] };
    const capped = capResult(huge);
    expect(capped.truncated).toBe(true);
  });

  it('unknown/unschemad tool: shallow-validates but does not reject', () => {
    const r = validateArgs('SOME_UNKNOWN_TOOL', { a: 'ok', b: 5 });
    expect(r.ok).toBe(true);
    expect(r.cleaned.a).toBe('ok');
  });
});

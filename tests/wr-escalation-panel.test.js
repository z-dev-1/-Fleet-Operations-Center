// tests/wr-escalation-panel.test.js
// Renderer Escalation card (unit detail → Repair tab): pure helpers exported
// from the real unit-detail.js with its deps mocked. No IPC/POST happens here.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../renderer/src/js/bridge.js', () => ({ notes: {}, ai: {}, aap: {}, relay: {}, vendor: {}, files: {} }));
vi.mock('../renderer/src/js/bus.js', () => ({ default: { on() {}, emit() {}, off() {} } }));
vi.mock('../renderer/src/js/state.js', () => ({ default: { get() {}, set() {}, on() {} } }));
vi.mock('../renderer/src/js/components/toast.js', () => ({ default: { show() {} } }));
vi.mock('../renderer/src/js/views/vendor-review-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/dealer-wo-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/wr-modal.js', () => ({ open() {}, readFileAsAttachment: async () => null }));

const m = await import('../renderer/src/js/views/unit-detail.js');

const OPTS = [
  { value: 'MCS_LEAD', displayText: 'MCS Lead' },
  { value: 'FAS', displayText: 'FAS' },
  { value: 'MCS_LEAD', displayText: 'MCS Lead dup' },
  { value: 'MCS_CARRIER_UPDATE_REQUEST', displayText: 'Carrier Update Request' },
];

describe('escalationAaid', () => {
  it('reads the aaid from assetUrl', () => {
    expect(m.escalationAaid({ assetUrl: 'https://aap-na.corp.amazon.com/v2/asset/abc-123?x=1' })).toBe('abc-123');
  });
  it('prefers unit.aaid', () => {
    expect(m.escalationAaid({ aaid: 'A1', assetUrl: 'https://x/v2/asset/B2' })).toBe('A1');
  });
  it('returns empty when none', () => {
    expect(m.escalationAaid({})).toBe('');
    expect(m.escalationAaid(null)).toBe('');
  });
});

describe('parseEscalationList', () => {
  it('splits a ;/, string, trims and dedupes', () => {
    expect(m.parseEscalationList('MCS_LEAD; FAS, MCS_LEAD;')).toEqual(['MCS_LEAD', 'FAS']);
  });
  it('accepts arrays', () => {
    expect(m.parseEscalationList([' FAS ', 'FAS', 'TOM_PENDING_ACTION'])).toEqual(['FAS', 'TOM_PENDING_ACTION']);
  });
  it('null -> []', () => {
    expect(m.parseEscalationList(null)).toEqual([]);
  });
});

describe('escalationSelectable', () => {
  it('excludes current and dedupes by value', () => {
    const s = m.escalationSelectable(OPTS, ['FAS']);
    expect(s.map((o) => o.value)).toEqual(['MCS_LEAD', 'MCS_CARRIER_UPDATE_REQUEST']);
    expect(s[0].displayText).toBe('MCS Lead');
  });
});

describe('validateEscalationDraft', () => {
  it('requires a team', () => {
    expect(m.validateEscalationDraft({ team: '', comment: 'x', current: [] }).ok).toBe(false);
  });
  it('rejects an already-applied team', () => {
    expect(m.validateEscalationDraft({ team: 'FAS', comment: 'x', current: ['FAS'] }).ok).toBe(false);
  });
  it('requires a comment', () => {
    expect(m.validateEscalationDraft({ team: 'FAS', comment: '   ', current: [] }).ok).toBe(false);
  });
  it('rejects a 2001-char comment', () => {
    const v = m.validateEscalationDraft({ team: 'FAS', comment: 'a'.repeat(2001), current: [] });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/2000/);
  });
  it('accepts a valid draft', () => {
    expect(m.validateEscalationDraft({ team: 'FAS', comment: 'Vendor unresponsive 8 days', current: ['MCS_LEAD'] })).toEqual({ ok: true, error: null });
  });
});

describe('validateDeEscalation', () => {
  it('carrier update removal needs a comment', () => {
    const cur = ['MCS_CARRIER_UPDATE_REQUEST'];
    expect(m.validateDeEscalation({ value: m.ESC_CARRIER_UPDATE, comment: '', current: cur }).ok).toBe(false);
    expect(m.validateDeEscalation({ value: m.ESC_CARRIER_UPDATE, comment: 'Updated ETA sent', current: cur }).ok).toBe(true);
  });
  it('normal value does not need a comment', () => {
    expect(m.validateDeEscalation({ value: 'FAS', comment: '', current: ['FAS'] }).ok).toBe(true);
  });
  it('rejects a value not in current', () => {
    expect(m.validateDeEscalation({ value: 'FAS', comment: 'x', current: ['MCS_LEAD'] }).ok).toBe(false);
  });
});

describe('buildEscalationPayload', () => {
  it('has workRequestId/aaid/add/remove/comment and no createdBy', () => {
    const unit = { workRequestId: 'wr-1', assetUrl: 'https://aap-na.corp.amazon.com/v2/asset/aa-9', createdBy: 'evil' };
    const p = m.buildEscalationPayload(unit, { add: ['FAS'], remove: [], comment: 'why' });
    expect(p).toEqual({ workRequestId: 'wr-1', aaid: 'aa-9', add: ['FAS'], remove: [], comment: 'why' });
    expect('createdBy' in p).toBe(false);
  });
});

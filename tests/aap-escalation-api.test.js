import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'aap-escalation-api-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const aap = require('../src/scrapers/aap_api');

const OPTS = {
  escalations: [
    { value: 'MCS_LEAD', displayText: 'MCS Lead', deprecated: false },
    { value: 'FAS', displayText: '' },
    { value: 'OLD_TEAM', displayText: 'Old', deprecated: true },
    { value: '  ', displayText: 'Blank' },
    { value: 'MCS_LEAD', displayText: 'Dupe' },
  ],
};
const EXPECTED = [{ value: 'MCS_LEAD', displayText: 'MCS Lead' }, { value: 'FAS', displayText: 'FAS' }];
const NOW = new Date('2026-11-01T12:34:56.000Z');
const BASE = { workRequestId: 'WR-1', aaid: 'aaid_1', createdBy: 'zilasant', now: NOW };

describe('_parseEscalationOptions', () => {
  it('parses an object body, dropping deprecated/blank and deduping', () => {
    expect(aap._parseEscalationOptions(OPTS)).toEqual(EXPECTED);
  });
  it('parses a JSON-string body', () => {
    expect(aap._parseEscalationOptions(JSON.stringify(OPTS))).toEqual(EXPECTED);
  });
  it('parses an array-wrapped body', () => {
    expect(aap._parseEscalationOptions([OPTS])).toEqual(EXPECTED);
  });
  it('returns [] on junk', () => {
    expect(aap._parseEscalationOptions(null)).toEqual([]);
    expect(aap._parseEscalationOptions('not json')).toEqual([]);
    expect(aap._parseEscalationOptions({ escalations: 'x' })).toEqual([]);
  });
});

describe('getEscalationOptions', () => {
  it('GETs maintenanceConfiguration with the encoded fleetId via deps.apiGet', async () => {
    const apiGet = vi.fn(async () => OPTS);
    const out = await aap.getEscalationOptions('fleet id/1', { apiGet });
    expect(apiGet).toHaveBeenCalledWith('/api/v1/maintenanceConfiguration?fleetIds=' + encodeURIComponent('fleet id/1'));
    expect(out).toEqual(EXPECTED);
  });
  it('rejects an empty fleetId with NO_FLEET_ID', async () => {
    const apiGet = vi.fn();
    await expect(aap.getEscalationOptions('', { apiGet })).rejects.toMatchObject({ code: 'NO_FLEET_ID' });
    expect(apiGet).not.toHaveBeenCalled();
  });
});

describe('_buildUpdateEscalationsBody', () => {
  it('builds an internal add body', () => {
    const body = aap._buildUpdateEscalationsBody({ ...BASE, add: [' MCS_LEAD ', 'MCS_LEAD'], remove: [], comment: ' Down 9 days ' });
    expect(body).toEqual({
      workRequestId: 'WR-1',
      aaid: 'aaid_1',
      escalationsToAdd: ['MCS_LEAD'],
      escalationsToRemove: [],
      reasonComment: { timestamp: NOW.toISOString(), text: 'Down 9 days', createdBy: 'zilasant', internalOnly: true, externalConsumers: [] },
    });
  });
  it('allows a normal remove without a comment (text "")', () => {
    const body = aap._buildUpdateEscalationsBody({ ...BASE, add: [], remove: ['FAS'] });
    expect(body.escalationsToRemove).toEqual(['FAS']);
    expect(body.reasonComment.text).toBe('');
    expect(body.reasonComment.internalOnly).toBe(true);
    expect(body.reasonComment.externalConsumers).toEqual([]);
  });
  it('carrier-update removal alone is INTERNAL ONLY (user decision 2026-10-30), text sent as typed', () => {
    const comment = 'Jane Doe - Amazon Logistics (Fleet Support): estimate $1,234 approved, unit ready';
    const body = aap._buildUpdateEscalationsBody({ ...BASE, remove: [aap.CARRIER_UPDATE_ESCALATION], comment });
    expect(body.escalationsToRemove).toEqual([aap.CARRIER_UPDATE_ESCALATION]);
    expect(body.reasonComment.internalOnly).toBe(true);
    expect(body.reasonComment.externalConsumers).toEqual([]);
    expect(body.reasonComment.text).toBe(comment);
  });
  it('every change shape is internal-only with no external consumers', () => {
    const shapes = [
      { add: ['MCS_LEAD'], remove: [], comment: 'Need lead' },
      { add: [], remove: ['FAS'], comment: '' },
      { add: [], remove: ['FAS'], comment: 'Resolved' },
      { add: ['MCS_LEAD'], remove: ['FAS'], comment: 'Swap' },
      { add: [], remove: [aap.CARRIER_UPDATE_ESCALATION], comment: 'Carrier updated' },
    ];
    for (const s of shapes) {
      const body = aap._buildUpdateEscalationsBody({ ...BASE, ...s });
      expect(body.reasonComment.internalOnly).toBe(true);
      expect(body.reasonComment.externalConsumers).toEqual([]);
    }
  });
  it('carrier-update removal requires a comment', () => {
    expect(() => aap._buildUpdateEscalationsBody({ ...BASE, remove: [aap.CARRIER_UPDATE_ESCALATION], comment: '  ' }))
      .toThrow(expect.objectContaining({ code: 'ESCALATION_INVALID' }));
  });
  it('rejects carrier-update removal combined with another change', () => {
    expect(() => aap._buildUpdateEscalationsBody({ ...BASE, remove: [aap.CARRIER_UPDATE_ESCALATION, 'FAS'], comment: 'x' }))
      .toThrow(/by itself/);
    expect(() => aap._buildUpdateEscalationsBody({ ...BASE, add: ['MCS_LEAD'], remove: [aap.CARRIER_UPDATE_ESCALATION], comment: 'x' }))
      .toThrow(/by itself/);
  });
  it('rejects add without a comment', () => {
    expect(() => aap._buildUpdateEscalationsBody({ ...BASE, add: ['MCS_LEAD'], comment: '' }))
      .toThrow(expect.objectContaining({ code: 'ESCALATION_INVALID' }));
  });
  it('rejects a 2001-char comment', () => {
    expect(() => aap._buildUpdateEscalationsBody({ ...BASE, add: ['MCS_LEAD'], comment: 'a'.repeat(aap.ESCALATION_COMMENT_MAX + 1) }))
      .toThrow(expect.objectContaining({ code: 'ESCALATION_INVALID' }));
  });
  it('rejects a value in both lists', () => {
    expect(() => aap._buildUpdateEscalationsBody({ ...BASE, add: ['FAS'], remove: ['FAS'], comment: 'x' }))
      .toThrow(expect.objectContaining({ code: 'ESCALATION_INVALID' }));
  });
  it('rejects an empty change', () => {
    expect(() => aap._buildUpdateEscalationsBody({ ...BASE, add: [], remove: [], comment: 'x' }))
      .toThrow(expect.objectContaining({ code: 'ESCALATION_INVALID' }));
  });
  it('requires workRequestId, aaid and createdBy', () => {
    for (const k of ['workRequestId', 'aaid', 'createdBy']) {
      expect(() => aap._buildUpdateEscalationsBody({ ...BASE, [k]: '', add: ['FAS'], comment: 'x' }))
        .toThrow(expect.objectContaining({ code: 'ESCALATION_INVALID' }));
    }
  });
});

describe('updateEscalations', () => {
  it('POSTs the body to /api/v1/workRequest/updateEscalations via deps.apiPost and parses a string response', async () => {
    const apiPost = vi.fn(async () => '{"status":"OK"}');
    const out = await aap.updateEscalations({ ...BASE, add: ['MCS_LEAD'], comment: 'Needs lead' }, { apiPost });
    expect(apiPost).toHaveBeenCalledTimes(1);
    const [p, body] = apiPost.mock.calls[0];
    expect(p).toBe('/api/v1/workRequest/updateEscalations');
    expect(body.escalationsToAdd).toEqual(['MCS_LEAD']);
    expect(body.reasonComment.createdBy).toBe('zilasant');
    expect(out).toEqual({ ok: true, response: { status: 'OK' }, add: ['MCS_LEAD'], remove: [] });
  });
  it('throws before posting on an invalid change', async () => {
    const apiPost = vi.fn();
    await expect(aap.updateEscalations({ ...BASE, add: ['MCS_LEAD'] }, { apiPost })).rejects.toMatchObject({ code: 'ESCALATION_INVALID' });
    expect(apiPost).not.toHaveBeenCalled();
  });
});

describe('_currentEscalations / _hasEscalateFeature / _userAlias', () => {
  it('reads current escalations in every supported shape', () => {
    expect(aap._currentEscalations({ escalations: ['MCS_LEAD', ' FAS ', 'FAS'] })).toEqual(['MCS_LEAD', 'FAS']);
    expect(aap._currentEscalations({ escalations: [{ value: 'MCS_LEAD' }, { value: '' }] })).toEqual(['MCS_LEAD']);
    expect(aap._currentEscalations({ escalations: 'MCS_LEAD; FAS,TOM_PENDING_ACTION' })).toEqual(['MCS_LEAD', 'FAS', 'TOM_PENDING_ACTION']);
    expect(aap._currentEscalations({ escalations: null })).toEqual([]);
    expect(aap._currentEscalations(null)).toEqual([]);
    expect(aap._currentEscalations({ workRequest: { escalations: ['FAS'] } })).toEqual(['FAS']);
    expect(aap._currentEscalations(JSON.stringify({ escalations: ['FAS'] }))).toEqual(['FAS']);
  });
  it('detects the ESCALATE_SERVICE feature', () => {
    expect(aap._hasEscalateFeature({ activeFeatures: ['X', 'ESCALATE_SERVICE'] })).toBe(true);
    expect(aap._hasEscalateFeature({ user: { activeFeatures: ['ESCALATE_SERVICE'] } })).toBe(true);
    expect(aap._hasEscalateFeature({ activeFeatures: ['X'] })).toBe(false);
    expect(aap._hasEscalateFeature(null)).toBe(false);
    expect(aap._hasEscalateFeature(JSON.stringify({ activeFeatures: ['ESCALATE_SERVICE'] }))).toBe(true);
  });
  it('resolves the user alias', () => {
    expect(aap._userAlias({ userName: ' zilasant ' })).toBe('zilasant');
    expect(aap._userAlias({ alias: 'a' })).toBe('a');
    expect(aap._userAlias({})).toBe('');
  });
});

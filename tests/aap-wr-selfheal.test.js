import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const aap = require('../src/scrapers/aap_api');

// The exact AAP validation messages captured live from /createRepair.
const MSG_COMMENT_CREATEDBY = "AAP API 400: \"1 validation error detected: Value null at 'workRequestInput.comments.1.member.createdBy' failed to satisfy constraint: Member must not be null\"";
const MSG_DAMAGE_NULL = 'AAP API 500: "JSON parse error: Instantiation of [simple type, class com.amazon.assetlifecyclewebappservice.webapp.controller.api.model.CreateRepairInput] value failed for JSON property damageDescription due to missing (therefore NULL) value for creator parameter damageDescription which is a non-nullable type"';
// Real message has literal ["comments"] in the reference chain (unescaped).
const MSG_COMMENT_STRING = 'AAP API 500: JSON parse error: Cannot construct instance of Comment ... (through reference chain: CreateRepairInput["comments"]->java.util.ArrayList[0])';

describe('AAP self-heal — _parseAapErrorField', () => {
  it('AWS-style path → normalized field (strips workRequestInput + index.member)', () => {
    expect(aap._parseAapErrorField(MSG_COMMENT_CREATEDBY)).toBe('comments.createdBy');
  });
  it('Jackson "for JSON property X" → field', () => {
    expect(aap._parseAapErrorField(MSG_DAMAGE_NULL)).toBe('damageDescription');
  });
  it('Jackson reference chain → dotted path', () => {
    expect(aap._parseAapErrorField(MSG_COMMENT_STRING)).toBe('comments');
  });
  it('unmappable message → null', () => {
    expect(aap._parseAapErrorField('AAP API 503: service unavailable')).toBeNull();
  });
});

describe('AAP self-heal — _correctCreateRepairField', () => {
  it('fixes null comment createdBy → non-null + externalConsumers[]', () => {
    const body = { comments: [{ text: 'hi', internalOnly: true, createdBy: null }] };
    const r = aap._correctCreateRepairField(body, 'comments.createdBy', MSG_COMMENT_CREATEDBY);
    expect(r.changed).toBe(true);
    expect(r.body.comments[0].createdBy).toBeTruthy();
    expect(Array.isArray(r.body.comments[0].externalConsumers)).toBe(true);
    expect(typeof r.body.comments[0].timestamp).toBe('string');
  });
  it('fixes null damageDescription → falls back to title', () => {
    const r = aap._correctCreateRepairField({ title: 'ABS inspection', damageDescription: null }, 'damageDescription', MSG_DAMAGE_NULL);
    expect(r.changed).toBe(true);
    expect(r.body.damageDescription).toBe('ABS inspection');
  });
  it('urgent + null urgencyReason → default; non-urgent → no change', () => {
    const urgent = aap._correctCreateRepairField({ urgent: true, urgencyReason: null }, 'urgencyReason', 'urgencyReason must not be null');
    expect(urgent.changed).toBe(true);
    expect(urgent.body.urgencyReason).toBeTruthy();
    const calm = aap._correctCreateRepairField({ urgent: false, urgencyReason: null }, 'urgencyReason', 'urgencyReason must not be null');
    expect(calm.changed).toBe(false);
  });
  it('null currentLocation coords → filled 0,0 + country + timeZone', () => {
    const r = aap._correctCreateRepairField({ currentLocation: { latitude: null, longitude: null } }, 'currentLocation.latitude', 'must not be null');
    expect(r.changed).toBe(true);
    expect(r.body.currentLocation.latitude).toBe(0);
    expect(r.body.currentLocation.country).toBeTruthy();
  });
  it('null supplierId → NOT auto-corrected (cannot invent a branch)', () => {
    const r = aap._correctCreateRepairField({ supplierId: null }, 'supplierId', 'supplierId must not be null');
    expect(r.changed).toBe(false);
  });
  it('recommendationInfo nulls → required keys filled', () => {
    const r = aap._correctCreateRepairField({ recommendationInfo: {} }, 'recommendationInfo.groupingId', 'must not be null');
    expect(r.changed).toBe(true);
    expect('groupingId' in r.body.recommendationInfo).toBe(true);
    expect(r.body.recommendationInfo.recommendationOverridden).toBe(false);
  });
  it('does not mutate the input body (pure)', () => {
    const body = { damageDescription: null, title: 'T' };
    aap._correctCreateRepairField(body, 'damageDescription', MSG_DAMAGE_NULL);
    expect(body.damageDescription).toBeNull(); // original untouched
  });
});

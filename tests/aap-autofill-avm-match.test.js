// The "Open in AAP (autofill)" engine receives raw AVM codes (BUMPER_ASSEMBLY)
// but AAP's wizard options are spaced labels ("Bumper Assembly"). The engine
// must type the spaced label and match options on normalized text, or the raw
// underscored code is left sitting in the AAP field.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const engine = require('../src/scrapers/aap_autofill_engine');

describe('autofill engine AVM option matching', () => {
  it.each([
    ['ELECTRICAL_SYSTEM', 'Electrical System'],
    ['SOLENOID_ASSEMBLY', 'Solenoid Assembly'],
    ['bumper_assembly', 'Bumper Assembly'],
    ['DRIVE_LEFT_REAR_OUTSIDE', 'Drive Left Rear Outside'],
  ])('raw code %s matches AAP option "%s"', (code, option) => {
    expect(engine._avmMatch(option, code, false)).toBe(true);
    expect(engine._avmLabel(code)).toBe(option);
  });

  it('already-spaced labels still match and are typed unchanged', () => {
    expect(engine._avmMatch('Electrical System', 'Electrical System', false)).toBe(true);
    expect(engine._avmMatch('Steer Left', 'Steer Left', false)).toBe(true);
    expect(engine._avmLabel('Steer Left')).toBe('Steer Left');
  });

  it('single-word codes still match', () => {
    expect(engine._avmMatch('Coolant', 'COOLANT', false)).toBe(true);
    expect(engine._avmLabel('ENGINE')).toBe('Engine');
  });

  it('exact mode does not match a longer option; includes mode does', () => {
    expect(engine._avmMatch('Check Engine Light', 'ENGINE', false)).toBe(false);
    expect(engine._avmMatch('Check Engine Light', 'ENGINE', true)).toBe(true);
  });

  it('empty values never match', () => {
    expect(engine._avmMatch('', 'ENGINE', true)).toBe(false);
    expect(engine._avmMatch('Engine', '', true)).toBe(false);
  });
});

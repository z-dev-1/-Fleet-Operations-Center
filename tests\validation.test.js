import { describe, it, expect } from 'vitest';

// Isolated validation logic (mirrors _safe.js validateInput)
function validateInput(data, schema) {
  if (!schema) return { ok: true };
  for (const [key, rule] of Object.entries(schema)) {
    const val = data && data[key];
    if (rule.required && (val === undefined || val === null || val === '')) {
      return { ok: false, error: key + ' is required' };
    }
    if (rule.type && val !== undefined && val !== null) {
      if (rule.type === 'string' && typeof val !== 'string') return { ok: false, error: key + ' must be a string' };
      if (rule.type === 'number' && typeof val !== 'number') return { ok: false, error: key + ' must be a number' };
      if (rule.type === 'array' && !Array.isArray(val)) return { ok: false, error: key + ' must be an array' };
    }
    if (rule.maxLen && typeof val === 'string' && val.length > rule.maxLen) {
      return { ok: false, error: key + ' exceeds max length (' + rule.maxLen + ')' };
    }
  }
  return { ok: true };
}

describe('IPC Input Validation', () => {
  it('should pass valid input', () => {
    const result = validateInput(
      { name: 'John', age: 30 },
      { name: { required: true, type: 'string' }, age: { type: 'number' } }
    );
    expect(result.ok).toBe(true);
  });

  it('should fail on missing required field', () => {
    const result = validateInput(
      { age: 30 },
      { name: { required: true, type: 'string' } }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('name');
  });

  it('should fail on wrong type', () => {
    const result = validateInput(
      { name: 123 },
      { name: { type: 'string' } }
    );
    expect(result.ok).toBe(false);
  });

  it('should fail on maxLen exceeded', () => {
    const result = validateInput(
      { msg: 'a'.repeat(5001) },
      { msg: { type: 'string', maxLen: 5000 } }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('max length');
  });

  it('should pass with no schema', () => {
    const result = validateInput({ anything: true }, null);
    expect(result.ok).toBe(true);
  });
});

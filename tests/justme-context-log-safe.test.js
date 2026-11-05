import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { errTag } = require('../src/justme-context/log-safe');

describe('errTag', () => {
  it('uses code, then name', () => {
    expect(errTag({ code: 'ERR_BUFFER_TOO_LARGE', message: 'secret' })).toBe('ERR_BUFFER_TOO_LARGE');
    expect(errTag(new SyntaxError('SENTINEL-CONTENT-7f3a'))).toBe('SyntaxError');
  });
  it('never includes the message', () => {
    expect(errTag(new Error('bad token SENTINEL-CONTENT-7f3a at https://x.example/?t=secret'))).toBe('Error');
  });
  it('strips unsafe characters and caps length', () => {
    expect(errTag({ code: 'a b/c:d' })).toBe('abcd');
    expect(errTag({ code: 'X'.repeat(100) })).toHaveLength(40);
    expect(errTag({ code: ' / ' })).toBe('Error');
  });
  it('handles null and non-objects', () => {
    expect(errTag(null)).toBe('Error');
    expect(errTag(undefined)).toBe('Error');
    expect(errTag('boom')).toBe('Error');
  });
});

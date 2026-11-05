// Fix 2 core: the credential screen used on vision text and on context-turn AI replies.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { SECRET_RES, findSecret } = require('../src/justme-context/secret-scrub');

const FAKE_AKIA = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
const HITS = {
  'httponly-cookie': '#HttpOnly_.midway-auth.amazon.com\tTRUE\t/\tTRUE\t0\tsession\tabc',
  'cookie-jar-line': 'w.amazon.com\tFALSE\t/\tTRUE\t1893456000\tname\tvalue',
  'slack-token': 'token is xoxc-1234567890-abcdef here',
  'aws-access-key': 'key ' + FAKE_AKIA + ' end',
  'aws-secret-key': 'aws_secret_access_key = abc',
  jwt: 'bearer ' + FAKE_JWT,
  'private-key': '-----BEGIN RSA PRIVATE KEY-----\nMIIE',
};

describe('findSecret', () => {
  for (const [name, text] of Object.entries(HITS)) {
    it('detects ' + name, () => { expect(findSecret(text)).toBe(name); });
  }
  it('also detects xoxd and ASIA forms', () => {
    expect(findSecret('xoxd-ABCDEFGHIJ1234')).toBe('slack-token');
    expect(findSecret('ASIA' + 'ABCDEFGHIJKLMNOP')).toBe('aws-access-key');
  });
  it('every named pattern has a hit row', () => {
    expect(SECRET_RES.map((p) => p.name).sort()).toEqual(Object.keys(HITS).sort());
  });
  it('benign text is not flagged', () => {
    expect(findSecret('password reset done')).toBeNull();
    expect(findSecret('units 1234567890 2083 208336 320160')).toBeNull();
    expect(findSecret('see https://x.example/?q=eyJhbGci for details')).toBeNull();
    expect(findSecret('xox is a word, xoxo too')).toBeNull();
    expect(findSecret('AKIAshort')).toBeNull();
    expect(findSecret('')).toBeNull();
    expect(findSecret(null)).toBeNull();
    expect(findSecret(42)).toBeNull();
  });
  it('returns only the pattern name, never the matched text', () => {
    for (const text of Object.values(HITS)) {
      const r = findSecret(text);
      expect(typeof r).toBe('string');
      expect(text).not.toContain(r + '!');
      expect(r).toMatch(/^[a-z-]+$/);
      expect(r.includes('xoxc')).toBe(false);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { pickOffsiteFromConversation } = require('../src/scrapers/relay');

describe('pickOffsiteFromConversation — newest case wins', () => {
  it('picks the LAST (newest) estimate link when a case was cancelled and reopened', () => {
    // Relay conversation is oldest-first, so the reopened case link appears last.
    // 322468: cancelled 21262927, reopened 21318595.
    const convData = {
      estimateLinks: [
        { url: 'https://volvopg.asist.decisiv.net/fleet/estimates/21262927' },
        { url: 'https://volvopg.asist.decisiv.net/fleet/estimates/21318595' },
      ],
    };
    const picked = pickOffsiteFromConversation(convData);
    expect(picked.url).toContain('21318595');
    expect(picked.url).not.toContain('21262927');
  });

  it('falls back to the newest service_request when no estimates', () => {
    const picked = pickOffsiteFromConversation({
      requestLinks: [
        { url: 'https://volvopg.asist.decisiv.net/service_requests/992258' },
        { url: 'https://volvopg.asist.decisiv.net/service_requests/999001' },
      ],
    });
    expect(picked.url).toContain('999001');
  });

  it('prefers estimates over requests (kind order unchanged)', () => {
    const picked = pickOffsiteFromConversation({
      estimateLinks: [{ url: 'est/1' }, { url: 'est/2' }],
      requestLinks: [{ url: 'sr/1' }],
    });
    expect(picked.url).toBe('est/2'); // newest estimate, not the SR
  });

  it('uses the newest DTNA link when only DTNA present', () => {
    const picked = pickOffsiteFromConversation({
      dtnaLinks: [{ url: 'dtna/a' }, { url: 'dtna/b' }],
    });
    expect(picked.url).toBe('dtna/b');
  });

  it('returns null when there are no links', () => {
    expect(pickOffsiteFromConversation({})).toBeNull();
    expect(pickOffsiteFromConversation(null)).toBeNull();
  });
});

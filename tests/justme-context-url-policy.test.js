// url-policy.js: T-URLS / T-CLASSIFY (design §9.1-9.2, §19), fix 5 RENDER_STATIC_HOSTS
// shape, fix 15 isLoopbackOrLinkLocal.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const P = require('../src/justme-context/url-policy');
const { REASONS, LIMITS } = require('../src/justme-context/constants');

describe('extractUrls (T-URLS)', () => {
  it('reads <url> and <url|label> tokens and skips channel/user/special tokens', () => {
    const t = 'see <https://w.amazon.com/a|wiki> and <#C123|ops> <@U999> <!here> <mailto:x@y.com|mail>';
    expect(P.extractUrls(t)).toEqual(['https://w.amazon.com/a']);
  });
  it('reads bare URLs outside tokens and strips trailing punctuation', () => {
    expect(P.extractUrls('go to https://example.com/x. now, or https://example.org/y), ok')).toEqual(['https://example.com/x', 'https://example.org/y']);
  });
  it('keeps a balanced closing bracket inside the URL', () => {
    expect(P.extractUrls('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
    expect(P.extractUrls('(https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
  });
  it('decodes Slack entities after token parsing', () => {
    expect(P.extractUrls('<https://example.com/?a=1&amp;b=2>')).toEqual(['https://example.com/?a=1&b=2']);
  });
  it('dedupes on href and caps at MAX_LINKS', () => {
    const many = Array.from({ length: 15 }, (_, i) => 'https://example.com/' + i).join(' ');
    expect(P.extractUrls(many)).toHaveLength(LIMITS.MAX_LINKS);
    expect(P.extractUrls('<https://example.com/a> https://example.com/a')).toEqual(['https://example.com/a']);
    expect(P.extractUrls(many, 50)).toHaveLength(15);
  });
  it('drops URLs over 2,048 chars and ignores non-web schemes', () => {
    expect(P.extractUrls('https://example.com/' + 'a'.repeat(2100))).toEqual([]);
    expect(P.extractUrls('<ftp://example.com/x> file:///c:/x')).toEqual([]);
  });
  it('malformed input returns []', () => {
    expect(P.extractUrls(undefined)).toEqual([]);
    expect(P.extractUrls(42)).toEqual([]);
  });
});

describe('stripForIntent', () => {
  it('removes tokens, bare URLs and mentions and collapses whitespace', () => {
    expect(P.stripForIntent('<@U123>  summarize   <https://w.amazon.com/a|wiki> https://x.com/y  please')).toBe('summarize please');
    expect(P.stripForIntent('<https://x.com>')).toBe('');
  });
});

describe('classifyUrl (T-CLASSIFY)', () => {
  const k = (u) => P.classifyUrl(u).kind;
  it('blocks non-web schemes, credentials, non-standard ports', () => {
    expect(P.classifyUrl('ftp://x.com/')).toMatchObject({ kind: 'blocked', reason: REASONS.ONLY_WEB });
    expect(P.classifyUrl('not a url')).toMatchObject({ kind: 'blocked', reason: REASONS.ONLY_WEB });
    expect(P.classifyUrl('https://u:p@example.com/')).toMatchObject({ kind: 'blocked', reason: REASONS.URL_CREDENTIALS });
    expect(P.classifyUrl('https://example.com:8443/')).toMatchObject({ kind: 'blocked', reason: REASONS.NONSTANDARD_PORT });
    expect(k('https://example.com:443/')).toBe('external');
  });
  it('IP literals: private blocked, public external (incl. WHATWG-normalized forms)', () => {
    for (const u of ['http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://10.0.0.5/', 'http://169.254.169.254/',
      'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[64:ff9b::a00:1]/', 'http://[fec0::1]/', 'http://[2002:7f00:1::]/']) {
      expect(P.classifyUrl(u), u).toMatchObject({ kind: 'blocked', reason: REASONS.PRIVATE_ADDRESS });
    }
    expect(k('http://8.8.8.8/')).toBe('external');
    expect(k('http://[2606:4700::1111]/')).toBe('external');
  });
  it('local host names are blocked', () => {
    for (const u of ['http://localhost/', 'http://a.localhost/', 'http://printer.local/', 'http://x.internal/', 'http://nas.home.arpa/', 'http://intranet/']) {
      expect(P.classifyUrl(u), u).toMatchObject({ kind: 'blocked', reason: REASONS.LOCAL_HOST });
    }
  });
  it('Slack hosts: file permalinks carry the id, message links are not opened', () => {
    expect(P.classifyUrl('https://amazon.enterprise.slack.com/files/U12345/F0ABC123/report.pdf')).toMatchObject({ kind: 'slack', fileId: 'F0ABC123' });
    expect(P.classifyUrl('https://files.slack.com/files-pri/T0123-F0ABC123/report.pdf')).toMatchObject({ kind: 'slack', fileId: 'F0ABC123' });
    expect(P.classifyUrl('https://amazon.enterprise.slack.com/archives/C1/p123')).toMatchObject({ kind: 'slack', reason: REASONS.SLACK_MESSAGE_LINK });
    expect(k('https://slack-edge.com/x')).toBe('external');
    expect(k('https://slack-files.com/x')).toBe('external');
    expect(k('https://slack-imgs.com/x')).toBe('external');
  });
  it('vendor hosts get their partition (exact host lookup)', () => {
    expect(P.classifyUrl('https://fleet.uptake.com/x')).toMatchObject({ kind: 'vendor', partition: 'persist:vendor-uptake' });
    expect(k('https://evil.fleet.uptake.com/x')).toBe('external');
  });
  it('internal suffixes use the dot boundary; http internal is blocked', () => {
    for (const u of ['https://w.amazon.com/x', 'https://amazon.com/', 'https://x.a2z.com/', 'https://code.amazon.dev/', 'https://x.aws.dev/',
      'https://quip-amazon.com/abc', 'https://amazon.sharepoint.com/sites/x', 'https://amazon-my.sharepoint.com/personal/x']) {
      expect(k(u), u).toBe('internal');
    }
    for (const u of ['https://evil-amazon.com/', 'https://amazon.com.evil.io/', 'https://bucket.s3.amazonaws.com/x', 'https://evil.sharepoint.com/']) {
      expect(k(u), u).toBe('external');
    }
    expect(P.classifyUrl('http://w.amazon.com/x')).toMatchObject({ kind: 'blocked', reason: REASONS.INTERNAL_HTTP });
  });
  it('trailing-dot normalization', () => {
    expect(k('https://w.amazon.com./x')).toBe('internal');
    expect(k('https://evil.com./')).toBe('external');
    expect(P.classifyUrl('https://fleet.uptake.com./')).toMatchObject({ kind: 'vendor', partition: 'persist:vendor-uptake' });
  });
});

describe('isBlockedAddress', () => {
  const blocked = ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.0.0.1', '192.0.2.1',
    '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '64:ff9b:1::1', '::a00:1', '100::1', '2001::1',
    '2001:db8::1', 'fc00::1', 'fd12::1', 'fe80::1', 'fec0::1', 'ff02::1', '2002:7f00:1::', '::ffff:0:7f00:1', '[::1]', 'not-an-ip'];
  const allowed = ['8.8.8.8', '1.1.1.1', '2002:808:808::', '2606:4700::1111'];
  for (const a of blocked) it('blocks ' + a, () => expect(P.isBlockedAddress(a)).toBe(true));
  for (const a of allowed) it('allows ' + a, () => expect(P.isBlockedAddress(a)).toBe(false));
});

describe('isLoopbackOrLinkLocal (fix 15)', () => {
  const table = [
    ['127.0.0.1', true], ['127.255.1.2', true], ['::1', true], ['169.254.1.1', true], ['169.254.169.254', true],
    ['fe80::1', true], ['febf::1', true], ['::ffff:127.0.0.1', true],
    ['10.1.2.3', false], ['192.168.0.1', false], ['8.8.8.8', false], ['fec0::1', false], ['fc00::1', false], ['2606:4700::1111', false], ['junk', false],
  ];
  for (const [ip, want] of table) it(ip + ' -> ' + want, () => expect(P.isLoopbackOrLinkLocal(ip)).toBe(want));
});

describe('host lists', () => {
  it('RENDER_STATIC_HOSTS: exact hosts only (no entry starts with * or .), vendor empty', () => {
    for (const cls of Object.keys(P.RENDER_STATIC_HOSTS)) {
      for (const h of P.RENDER_STATIC_HOSTS[cls]) {
        expect(h.startsWith('*') || h.startsWith('.'), h).toBe(false);
        expect(h).toBe(h.toLowerCase());
      }
    }
    expect(P.RENDER_STATIC_HOSTS.internal).toContain('res.cdn.office.net');
    expect(P.RENDER_STATIC_HOSTS.internal.some((h) => /akamaihd|cloudfront/.test(h))).toBe(false);
    expect(P.RENDER_STATIC_HOSTS.vendor).toEqual([]);
  });
  it('exports the other lists', () => {
    expect(P.SLACK_AUTH_HOSTS).toEqual(['slack.com']);
    expect(P.SLACK_FOLLOW_HOSTS).toEqual(['slack.com', 'slack-edge.com', 'slack-files.com']);
    expect(P.SSO_NAV_HOSTS).toContain('login.microsoftonline.com');
    expect(P.INTERNAL_SUFFIXES).not.toContain('amazonaws.com');
  });
  it('slackFileIdFromPermalink and linkLabel', () => {
    expect(P.slackFileIdFromPermalink('https://x.slack.com/files/U1/F0ABC/name.pdf')).toBe('F0ABC');
    expect(P.slackFileIdFromPermalink('https://x.slack.com/archives/C1/p1')).toBe(null);
    expect(P.linkLabel('https://w.amazon.com/bin/view/Some/Long/Path/That/Goes/On/And/On?token=secret#frag')).toBe('w.amazon.com/bin/view/Some/Long/Path/That/Goes/On/An');
    expect(P.linkLabel('https://example.com/?q=1')).toBe('example.com');
  });
});

// tests/email-intel-static-guards.test.js — source-level guards for the Email Triage Intelligence
// module: R8.6 no Graph/EWS endpoints, NFR-6 no raw Promise.race over relay.ask, NFR-7 dependencies
// unchanged, NFR-8 off-limits files untouched + import allow/deny lists (F-30), F-10 owa_reader.js
// pinned by hash, R7.5 no send/delete outside confirm executors, R7.7 isolated lane only,
// no Promise.all over AI calls, F-11 reply-compose guard (placeholder until reply/** exists).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = '50419ba';
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const OWN_FILES = [...walk(path.join(ROOT, 'src/email-intel')), path.join(ROOT, 'src/ipc/email-intel.js')];
const read = (p) => fs.readFileSync(p, 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');

function git(...args) {
  try { return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 }); } catch (_) { return null; }
}

describe('module inventory', () => {
  it('the Phase 0 files exist', () => {
    for (const f of ['constants', 'redact', 'flags', 'stores', 'untrusted', 'confirm', 'index']) expect(fs.existsSync(path.join(ROOT, 'src/email-intel', f + '.js'))).toBe(true);
    expect(OWN_FILES.length).toBeGreaterThanOrEqual(8);
  });
});

describe('R8.6 no Graph / EWS / OWA service endpoints and no auth modules', () => {
  const ENDPOINT_RE = /graph\.microsoft\.com|graph\.windows\.net|\/EWS\/|Exchange\.asmx|service\.svc|\/owa\/service|outlook\.office365\.com\/api|\/api\/v2\.0|login\.microsoftonline\.com\/.*\/oauth2/i;
  it('no source file under src/email-intel or src/ipc/email-intel.js mentions those endpoints', () => {
    for (const f of OWN_FILES) expect(stripComments(read(f)), rel(f)).not.toMatch(ENDPOINT_RE);
  });
});

describe('NFR-6 AI calls', () => {
  it('no raw Promise.race([relay.ask( in the module', () => {
    for (const f of OWN_FILES) expect(read(f), rel(f)).not.toMatch(/Promise\.race\(\s*\[\s*relay\.ask\(/);
  });

  it('R7.7 every askWithTimeout call is isolated:true and names a source (nothing may reach the tool-enabled lane)', () => {
    for (const f of OWN_FILES) {
      const src = stripComments(read(f));
      let i = -1;
      while ((i = src.indexOf('askWithTimeout(', i + 1)) !== -1) {
        const call = src.slice(i, i + 600);
        expect(call, rel(f)).toMatch(/isolated:\s*true/);
        expect(call, rel(f)).toMatch(/source:\s*'email_intel'/);
      }
      expect(src, rel(f)).not.toMatch(/relay\.ask\(/);
    }
  });

  it('no Promise.all over AI calls (scan calls are serialized through the AI queue)', () => {
    for (const f of OWN_FILES) {
      const src = stripComments(read(f)).split('\n');
      src.forEach((line, n) => {
        if (!/Promise\.all(Settled)?\(/.test(line)) return;
        const window = src.slice(n, n + 4).join('\n');
        expect(window, rel(f) + ':' + (n + 1)).not.toMatch(/askIsolated|askWithTimeout|relay\.|analyze/i);
      });
    }
  });
});

describe('NFR-7 dependencies', () => {
  const EXPECTED = {
    '@aws-sdk/client-bedrock-runtime': '^3.1073.0', '@aws-sdk/credential-providers': '^3.1073.0', '@kenjiuno/msgreader': '1.29.0',
    'heic-convert': '2.1.0', jszip: '^3.10.1', juice: '^12.1.1', mailparser: '3.14.1', mammoth: '1.13.0', nodemailer: '^9.0.1',
    'pdfjs-dist': '6.4.299', playwright: '^1.61.1', ws: '^8.21.0', xlsx: 'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz',
  };
  it('package.json dependencies are exactly the base set', () => {
    const now = JSON.parse(read(path.join(ROOT, 'package.json'))).dependencies;
    expect(now).toEqual(EXPECTED);
    const baseBlob = git('show', BASE + ':package.json');
    if (baseBlob) expect(now).toEqual(JSON.parse(baseBlob).dependencies);
  });
});

describe('NFR-8 off-limits files and import lists', () => {
  const OFF_LIMITS = [
    /^src\/asana\//, /\.bak-agent-wiring$/, /^src\/scrapers\/aap_custom_form_probe\.js$/, /^tests\/fixtures\/rca-template\.json$/,
    /^src\/auth\//, /(^|[\\/_.-])(midway|aea)([\\/_.-]|$)/i, /auth-supervisor|auth-propagation|injectCookies/i,
    /^src\/ipc\/ai\.js$/, /^src\/longdwell\//, /^src\/ipc\/long-dwell-sp/, /sp_sheet_page\.js$/, /^renderer\/.*long-?dwell/i, /^src\/store\/.*long_dwell/i,
    /^src\/scrapers\/owa_reader\.js$/, /^src\/scrapers\/email_intel\.js$/, /^src\/scrapers\/convo_parse\.js$/, /^src\/ipc\/notes\.js$/,
    /^src\/orcha\/relay\.js$/, /^src\/orcha\/reason\.js$/, /^src\/workers\/supervisor\.js$/, /^src\/slack\//, /^\.agents\//,
  ];
  it('no off-limits file differs from base (committed or working tree)', () => {
    const committed = git('diff', '--name-only', BASE);
    if (committed == null) return;   // git unavailable: skip
    const files = committed.split('\n').map((s) => s.trim()).filter(Boolean);
    expect(files).toContain('src/config/perf-flags.js');   // the diff is real, so an empty offender list means something
    const offenders = files.filter((f) => OFF_LIMITS.some((re) => re.test(f)));
    expect(offenders).toEqual([]);
    const untracked = (git('ls-files', '--others', '--exclude-standard') || '').split('\n').map((s) => s.trim()).filter(Boolean);
    expect(untracked.filter((f) => OFF_LIMITS.some((re) => re.test(f)))).toEqual([]);
  });

  // F-30: explicit deny and allow lists for require() in the module (call-only reuse).
  const DENY = [
    /^src\/auth\//, /(^|\/)(midway|aea|auth-supervisor|auth-propagation|injectCookies)/i, /^src\/slack\//, /^src\/asana\//, /^src\/ipc\/ai$/,
    /^src\/ipc\/long-dwell-sp/, /^src\/scrapers\/aap_custom_form_probe$/, /bak-agent-wiring/, /long_dwell/i, /^src\/longdwell\//, /^src\/cluster\/aea-keepalive$/, /graph|ews/i,
  ];
  const ALLOW = new Set([
    'src/justme-context/extract-host', 'src/justme-context/secret-scrub', 'src/justme-context/constants', 'src/orcha/fas/injection-guard', 'src/orcha/fas/roster-lookup',
    'src/orcha/relay', 'src/orcha/reason', 'src/orcha/canonical_state', 'src/orcha/repair-history',
    'src/scrapers/owa_reader', 'src/scrapers/owa-mailer', 'src/scrapers/email_actions', 'src/scrapers/email_intel', 'src/scrapers/email_triage',
    'src/store/index', 'src/store', 'src/config/perf-flags', 'src/config/paths', 'src/jobs/index', 'src/jobs', 'src/workers/supervisor',
    'src/cluster/index', 'src/cluster', 'src/utils/logger', 'src/utils/errors', 'src/ipc/notes', 'src/ipc/_safe',
    'src/auth/auth-report',   // single named read-only exception: currentStatus() only, never .report(
  ]);
  const NODE_ALLOW = new Set(['electron', 'crypto', 'fs', 'path', 'os']);

  it('every require() in src/email-intel/** and src/ipc/email-intel.js is on the allow list and off the deny list', () => {
    for (const f of OWN_FILES) {
      const src = read(f);
      for (const m of src.matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)) {
        const spec = m[2];
        if (!spec.startsWith('.')) { expect(NODE_ALLOW.has(spec), rel(f) + ' requires ' + spec).toBe(true); continue; }
        const target = rel(path.resolve(path.dirname(f), spec)).replace(/\.js$/, '');
        for (const re of DENY) {
          if (target === 'src/auth/auth-report') continue;
          expect(re.test(target), rel(f) + ' requires denied ' + target).toBe(false);
        }
        if (target.startsWith('src/email-intel/') || target === 'src/email-intel') continue;
        expect(ALLOW.has(target), rel(f) + ' requires ' + target + ' which is not on the allow list').toBe(true);
        if (target === 'src/auth/auth-report') expect(src).not.toMatch(/\.report\(/);
      }
    }
  });
});

describe('F-10 owa_reader.js is never edited', () => {
  const LF_SHA256 = 'b37ec507170e13d9969123fd6a1e13fd5a93a35103d4d8034b4cd9071222f290';   // base blob, LF line endings
  it('content hash equals the base blob (line-ending independent)', () => {
    const text = read(path.join(ROOT, 'src/scrapers/owa_reader.js')).replace(/\r\n/g, '\n');
    expect(crypto.createHash('sha256').update(text).digest('hex')).toBe(LF_SHA256);
  });
});

describe('R7.5 no send / delete / approve outside confirm executors', () => {
  // Calls that mutate the mailbox, post a message, or write the timeline on a user's behalf.
  const CONSEQUENTIAL_CALLS = /\b(sendReply|sendViaOwa|sendThreadReply|deleteMessage|sendReadyDm|sendSlackMessage|postMessage)\s*\(/;
  // owa_reply.js defines sendThreadReply (the Send click); executors.js is its only caller (after token + native dialog).
  const EXECUTOR_FILE = /^src\/email-intel\/(.*\/)?(executors?\.js|[^/]*-executor\.js|reply\/owa[-_]reply\.js)$/;
  it('only executor files (registered through confirm.registerExecutor) may call them', () => {
    for (const f of OWN_FILES) {
      if (EXECUTOR_FILE.test(rel(f))) continue;
      expect(stripComments(read(f)), rel(f)).not.toMatch(CONSEQUENTIAL_CALLS);
    }
  });
  it('confirm.js itself calls no sender; executors run only through confirm()', () => {
    const src = stripComments(read(path.join(ROOT, 'src/email-intel/confirm.js')));
    expect(src).not.toMatch(CONSEQUENTIAL_CALLS);
    expect(src).toMatch(/dialog\.showMessageBox/);
  });
});

describe('F-11 reply compose guard', () => {
  it('the select-all insert path (_insertBody / _buildInsertScript) is never used by the module', () => {
    for (const f of OWN_FILES) expect(stripComments(read(f)), rel(f)).not.toMatch(/_insertBody|_buildInsertScript/);
  });
  it('F-11 select-all insert path is never used on reply', () => {
    const files = walk(path.join(ROOT, 'src/email-intel/reply'));
    expect(files.map((f) => path.basename(f)).sort()).toEqual(['context.js', 'draft.js', 'owa_reply.js', 'page-scripts.js', 'recipients.js', 'reconcile-send.js', 'risk.js', 'send-guard.js']);
    for (const f of files) {
      const src = read(f);                                                     // raw text: not even a comment may name them
      expect(src, rel(f)).not.toMatch(/_insertBody|_buildInsertScript/);
      expect(src, rel(f)).not.toMatch(/selectNodeContents|selectAll|clipboard|\.paste\(|innerHTML\s*=(?!=)/);
      expect(src, rel(f)).not.toMatch(/sendViaOwa\(/);                         // the threaded path never opens a new compose
    }
    // the reply page scripts are built from the prepend script only, and the mailer exports used are the additive ones
    const mailer = require('../src/scrapers/owa-mailer');
    for (const k of ['_verifySentItems', '_waitFor', '_buildSendButtonProbeScript']) expect(typeof mailer[k]).toBe('function');
    expect(mailer._insertBody).toBeUndefined();
  });
});

describe('constants are frozen and the confidence threshold is pinned', () => {
  it('AUTO_APPLY_MIN_CONFIDENCE is 0.75 and the constants object is frozen', () => {
    const C = require('../src/email-intel/constants');
    expect(C.AUTO_APPLY_MIN_CONFIDENCE).toBe(0.75);
    expect(Object.isFrozen(C)).toBe(true);
    expect(C.MAX_MESSAGES_BYTES).toBe(8_000_000);
    expect(C.MESSAGES_EVICT_TARGET_RATIO).toBe(0.75);
    expect(C.STORED_BODY_CAP_OLD).toBe(2_000);
    expect(C.OLD_MESSAGE_AGE_MS).toBe(7 * 86_400_000);
    expect(C.AI_CONCURRENCY).toBe(1);
    expect(C.SCAN_DEADLINE_MS).toBeLessThan(30 * 60_000);
  });
});

// tests/email-api-sos-eos-untouched.test.js — AC-18 / FR-5.1 / FR-5.3: SOS/EOS (src/scheduler/*, owa-mailer.js) are not
// changed by the Email Triage API transport; FR-4.2 the DOM files are kept unchanged; FR-7.1 src/dev stays as it was.
// Diffs against the branch base 4c0e1f4. Skips when git or the base commit is not available (NFR-8 pattern).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = '4c0e1f4';

function git(...args) {
  try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 }); } catch (_) { return null; }
}
const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
const hasBase = () => git('cat-file', '-e', BASE + '^{commit}') !== null;

describe('SOS/EOS untouched', () => {
  it('AC-18 scheduler and owa-mailer.js diff is empty vs 4c0e1f4 (committed and working tree)', () => {
    if (!hasBase()) return;                                                    // git unavailable: skip
    const paths = ['src/scheduler', 'src/scrapers/owa-mailer.js'];
    expect(lines(git('diff', '--name-only', BASE, '--', ...paths))).toEqual([]);
    expect(lines(git('diff', '--name-only', '--', ...paths))).toEqual([]);
    expect(lines(git('diff', '--name-only', '--cached', '--', ...paths))).toEqual([]);
    expect(lines(git('ls-files', '--others', '--exclude-standard', '--', ...paths))).toEqual([]);
  }, 120_000);

  it('FR-4.2 the DOM files still exist and are unchanged vs base', () => {
    const files = ['src/scrapers/owa_reader.js', 'src/email-intel/capture/owa_capture.js', 'src/email-intel/capture/dom-probe.js', 'src/email-intel/capture/page-scripts.js',
      'src/email-intel/reply/owa_reply.js', 'src/email-intel/reply/page-scripts.js', 'src/email-intel/attach/fetch.js', 'src/scrapers/email_triage.js', 'src/scrapers/email_actions.js'];
    for (const f of files) expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true);
    if (!hasBase()) return;
    expect(lines(git('diff', '--name-only', BASE, '--', ...files))).toEqual([]);
    expect(lines(git('diff', '--name-only', '--', ...files))).toEqual([]);
  }, 120_000);

  it('FR-7.1 src/dev files are unchanged vs base', () => {
    expect(fs.existsSync(path.join(ROOT, 'src/dev/dev-owa-probe.js'))).toBe(true);
    if (!hasBase()) return;
    expect(lines(git('diff', '--name-only', BASE, '--', 'src/dev'))).toEqual([]);
    expect(lines(git('diff', '--name-only', '--', 'src/dev'))).toEqual([]);
    expect(lines(git('ls-files', '--others', '--exclude-standard', '--', 'src/dev'))).toEqual([]);
  }, 120_000);
});

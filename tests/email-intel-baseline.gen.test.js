// tests/email-intel-baseline.gen.test.js — env-gated generator for the Email
// Triage Intelligence flag-OFF golden (plan.md FEAT-001 commit 2, F2-02).
// Run ONCE from the main repo, at the export-only overlay commit and before any
// other source edit; never regenerate it later:
//   $env:FLEET_GEN_BASELINE='1'; npx vitest run --root ".worktrees/email-intel" tests/email-intel-baseline.gen.test.js
// Skipped unless FLEET_GEN_BASELINE=1 (counts toward the documented skipped total).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as fx from './fixtures/email-intel-fixture.js';

const OVERLAY = 'renderer/src/js/components/email-triage-overlay.js';
const BASE = '50419ba';
const git = (...args) => execFileSync('git', ['-C', fx.ROOT, ...args], { encoding: 'utf8' }).trim();

describe.skipIf(process.env.FLEET_GEN_BASELINE !== '1')('generate email-intel baseline', () => {
  it('writes tests/fixtures/email-intel-baseline.json', async () => {
    const numstat = git('diff', '--numstat', BASE, '--', OVERLAY);
    const sourceDiff = git('status', '--porcelain', '--', 'src', 'renderer', 'preload.js');
    const out = await fx.captureAll();
    out.meta = {
      baseCommit: BASE,
      capturedAtCommit: git('rev-parse', 'HEAD'),
      overlayNumstat: numstat,
      sourceTreeDirtyAtCapture: sourceDiff,
    };
    const file = fileURLToPath(new URL('./fixtures/email-intel-baseline.json', import.meta.url));
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
    expect(numstat).toBe('1\t0\t' + OVERLAY);
    expect(sourceDiff).toBe('');
  }, 120000);
});

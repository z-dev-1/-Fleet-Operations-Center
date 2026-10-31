// tests/awareness-no-direct-sends.test.js
// Static guards for the context-aware assistant (design §D16.8, AC14).
// Main-process half; FEAT-003 appends the renderer checks.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('no direct Slack sends from proactive sources (AC14)', () => {
  for (const rel of ['src/orcha/deep-scan.js', 'src/orcha/proactive-alerts.js']) {
    it(rel + ' has no sendToChannel( call and no ch.mode === \'justme\'', () => {
      const code = stripComments(read(rel));
      expect(code).not.toMatch(/\bsendToChannel\s*\(/);
      expect(code).not.toContain("ch.mode === 'justme'");
    });
  }
});

describe('decisivReadyGate unchanged', () => {
  // sha1 of the function source (LF line endings) at base commit dd3a550.
  const BASE_SHA1 = '0a31ea3c74dd4f33f649ca5bc905c9effe20c89b';
  it('function body matches the dd3a550 snapshot', () => {
    const s = read('src/scrapers/ready_pickup_notify.js');
    const i = s.indexOf('function decisivReadyGate(');
    expect(i).toBeGreaterThanOrEqual(0);
    const j = s.indexOf('\n}\n', i);
    const fn = s.slice(i, j + 2);
    expect(crypto.createHash('sha1').update(fn).digest('hex')).toBe(BASE_SHA1);
  });
});

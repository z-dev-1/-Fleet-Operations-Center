// tests/rca-autofill-thread.test.js — RCA autofill hands the AI the newest
// work-order comments plus the original complaint (first entry), within a
// 30,000-char budget, with a visible marker at the gap. settings.ai.fullContext
// OFF keeps the legacy tail slice(-9000). relay.ask is spied; no real model.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const LABEL = 'WORK ORDER THREAD (oldest first; a marked gap means older comments were trimmed):\n';
const MARKER_RE = /\[… \d+ older lines trimmed to fit the AI budget …\]/;
const MARKER_LEN_MAX = '[… 99999 older lines trimmed to fit the AI budget …]'.length + 1;

function thread(chars) {
  const lines = ['09/13 - ORIGINAL_COMPLAINT driver reports hood detached on the driver side'];
  let i = 0;
  while (lines.join('\n').length < chars) {
    i++;
    lines.push(String(9 + Math.floor(i / 400) % 3).padStart(2, '0') + '/' + String(1 + (i % 28)).padStart(2, '0') +
      ' - update ' + i + ' ' + 'z'.repeat(90));
  }
  lines.push('11/09 - NEWEST_LINE carrier confirmed vendor assignment');
  return lines.join('\n');
}

const threadSection = (prompt) => {
  const i = prompt.indexOf(LABEL);
  expect(i).toBeGreaterThan(-1);
  return prompt.slice(i + LABEL.length, prompt.length - 1); // prompt ends with '\n'
};

describe('rca/autofill.js _aiFill thread budget', () => {
  const tmpDir = path.join(os.tmpdir(), 'rca-thread-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  require('../src/config/paths').setDataDir(tmpDir);
  const relay = require('../src/orcha/relay');
  const fleetBrain = require('../src/orcha/fleet-brain');
  const { installFakeFleetBrain, baseRelaySetup } = require('./helpers/ai-gateway-fakes.cjs');
  const autofill = require('../src/rca/autofill');
  let prompts;
  beforeEach(() => {
    baseRelaySetup(relay); installFakeFleetBrain(vi, fleetBrain);
    prompts = [];
    vi.spyOn(relay, 'ask').mockImplementation(async (p) => { prompts.push(p); return '{"complaint":"hood detached"}'; });
  });
  afterEach(() => { relay.__test__.reset(); vi.restoreAllMocks(); });

  it('40k thread: keeps the original complaint + newest line + marker within 30,000', async () => {
    const t = thread(40000);
    expect(t.length).toBeGreaterThan(40000);
    const res = await autofill._aiFill({ fields: [] }, {}, t, null, { fullContext: true });
    expect(res.values).toEqual({ complaint: 'hood detached' });
    expect(res.threadTrimmed).toBeGreaterThan(0);
    const sec = threadSection(prompts[0]);
    expect(sec).toContain('ORIGINAL_COMPLAINT');
    expect(sec).toContain('NEWEST_LINE');
    expect(MARKER_RE.test(sec)).toBe(true);
    expect(sec.length).toBeLessThanOrEqual(30000 + MARKER_LEN_MAX);
    expect(sec.split('\n').pop()).toContain('NEWEST_LINE');
  });

  it('fullContext:false keeps the legacy tail slice(-9000)', async () => {
    const t = thread(40000);
    const res = await autofill._aiFill({ fields: [] }, {}, t, null, { fullContext: false });
    expect(res).toEqual({ values: { complaint: 'hood detached' } });
    expect(threadSection(prompts[0])).toBe(t.slice(-9000));
  });

  it('short thread is passed whole with no marker', async () => {
    const t = thread(2000);
    const res = await autofill._aiFill({ fields: [] }, {}, t, null, { fullContext: true });
    expect(res).toEqual({ values: { complaint: 'hood detached' } });
    const sec = threadSection(prompts[0]);
    expect(sec).toBe(t);
    expect(MARKER_RE.test(sec)).toBe(false);
  });

  it('keeps the anti-fabrication rule verbatim', async () => {
    await autofill._aiFill({ fields: [] }, {}, thread(40000), null, { fullContext: true });
    expect(prompts[0]).toContain('- Ground every value in the facts and work-order thread below. Do NOT invent parts, costs, dates or causes.\n');
  });

  it("unparseable reply keeps {values:{}, error:'AI reply was not JSON'}", async () => {
    relay.ask.mockImplementation(async () => 'I could not tell.');
    expect(await autofill._aiFill({ fields: [] }, {}, thread(40000), null, { fullContext: true }))
      .toEqual({ values: {}, error: 'AI reply was not JSON' });
  });
});

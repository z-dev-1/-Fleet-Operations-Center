// tests/relay-reconcile-budget.test.js — the reconcile brief keeps the NEWEST
// part of each long blob (so "who spoke last" is computed on the real last
// comment), at 12,000 / 6,000 / 6,000 chars with settings.ai.fullContext on and
// the legacy 6,000 / 6,000 / 2,500 when off. Pure: no AI call.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'rr-budget-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);

const reconcile = require('../src/scrapers/relay_reconcile');

const MARKER_RE = /\[… \d+ older lines trimmed to fit the AI budget …\]/;
const MARKER_LEN_MAX = '[… 99999 older lines trimmed to fit the AI budget …]'.length + 1;
const PROMPT_CAP = 55000;

// Three entries per day from Jan 1 so even the longest feed stays within one year.
const day = (i) => new Date(2026, 0, 1 + Math.floor(i / 3));
const mmdd = (i) => { const d = day(i); return String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0'); };

// Oldest-first Relay conversation: overview header, "Conversation" marker, then
// author / MM/DD/YYYY date / text blocks. The last text contains NEWEST_MARK.
function conversation(chars) {
  const lines = ['B20038 Work Request', 'HEADER_ANCHOR Service Overview', 'Conversation'];
  let i = 0;
  const block = (k, text) => [k % 2 ? 'Jane Doe - Acme Truck Repair' : 'Z SANTIAGO - Amazon Logistics', mmdd(k) + '/2026 09:00 AM', text];
  while (lines.join('\n').length < chars) { lines.push(...block(i, 'update ' + i + ' ' + 'q'.repeat(100))); i++; }
  lines.push(...block(i, 'NEWEST_MARK vendor confirmed parts arrived, repair scheduled'));
  return lines.join('\n');
}

function feed(chars, tag) {
  const lines = [];
  let i = 0;
  while (lines.join('\n').length < chars) { lines.push(mmdd(i) + ' - ' + tag + ' ' + i + ' ' + 'w'.repeat(80)); i++; }
  lines.push(mmdd(i) + ' - ' + tag + '_NEWEST final line');
  return lines.join('\n');
}

describe('relay_reconcile _unitBrief newest-first budgets', () => {
  it('flag ON: 20k conversation keeps the anchor header + marker + newest comment within 12,000', () => {
    const conv = conversation(20000);
    const b = reconcile._unitBrief({ equipmentId: 'B20038', fullConversation: conv }, { fullContext: true });
    expect(b.relayConversation).toContain('NEWEST_MARK');
    expect(b.relayConversation).toContain('HEADER_ANCHOR');
    expect(MARKER_RE.test(b.relayConversation)).toBe(true);
    expect(b.relayConversation.length).toBeLessThanOrEqual(12000 + MARKER_LEN_MAX);
    expect(b.relayConversation.length).toBeGreaterThan(6000);
    expect(b.relayComments.length).toBeGreaterThan(0);
    expect(b.relayComments[b.relayComments.length - 1].text).toContain('NEWEST_MARK');
  });

  it('flag ON: a 5k timeline is kept whole', () => {
    const tl = feed(5000, 'TL');
    const b = reconcile._unitBrief({ equipmentId: 'B20038', repairTimeline: tl }, { fullContext: true });
    expect(b.relayTimeline).toBe(tl);
  });

  it('flag OFF: legacy sizes, still newest-first', () => {
    const b = reconcile._unitBrief({ equipmentId: 'B20038', fullConversation: conversation(20000), repairTimeline: feed(5000, 'TL') },
      { fullContext: false });
    expect(b.relayConversation.length).toBeLessThanOrEqual(6000 + MARKER_LEN_MAX);
    expect(b.relayConversation).toContain('NEWEST_MARK');
    expect(b.relayTimeline.length).toBeLessThanOrEqual(2500 + MARKER_LEN_MAX);
    expect(b.relayTimeline).toContain('TL_NEWEST final line');
    expect(MARKER_RE.test(b.relayTimeline)).toBe(true);
  });

  it('offsite notes keep the newest lines at 6,000', () => {
    const b = reconcile._unitBrief({ equipmentId: 'B20038', asistNotes: feed(20000, 'OFF') }, { fullContext: true });
    expect(b.offsiteNotes.length).toBeLessThanOrEqual(6000 + MARKER_LEN_MAX);
    expect(b.offsiteNotes).toContain('OFF_NEWEST final line');
  });

  it('short blobs are unchanged (trim + NUL strip only)', () => {
    const b = reconcile._unitBrief({ equipmentId: 'B1', fullConversation: '  hello\u0000 world  ', repairTimeline: 'x' }, { fullContext: true });
    expect(b.relayConversation).toBe('hello world');
    expect(b.relayTimeline).toBe('x');
  });

  it('prompt from 40k conv + 20k offsite + 10k timeline stays under PROMPT_CAP', () => {
    const brief = reconcile._unitBrief({
      equipmentId: 'B20038', vendor: 'Acme', _workRequestId: 'wr',
      fullConversation: conversation(40000), asistNotes: feed(20000, 'OFF'), repairTimeline: feed(10000, 'TL'),
      cause: 'c'.repeat(2000), correction: 'k'.repeat(2000), issueSummary: 'i'.repeat(2000),
    }, { fullContext: true });
    const prompt = reconcile.buildReconcilePrompt(brief, reconcile.DEFAULT_CONFIG);
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_CAP);
    expect(prompt).toContain('NEWEST_MARK');
    expect(prompt).toContain('TL_NEWEST final line');
    expect(prompt).toContain('OFF_NEWEST final line');
  });
});

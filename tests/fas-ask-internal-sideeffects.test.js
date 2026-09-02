import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-askint-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const tools = require('../src/orcha/fas/tool-registry');
const askInternalMod = require('../src/orcha/ask-internal');
const profiles = require('../src/orcha/fas/sender-profiles');

const internal = () => ({ slackId: 'U_INT', name: 'Z', type: 'internal', operators: [], domiciles: [],
  allowedDataCategories: profiles.DATA_CATEGORIES.slice(), permittedRequestTypes: profiles.REQUEST_TYPES.slice() });

beforeEach(() => { store.save('fasPlaybook', {}); store.save('fasKnowledgeDrafts', []); });
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('Part 9: ASK_INTERNAL side effects are mode-gated', () => {
  it('SHADOW mode: does NOT contact AITeammate (no outbound), returns proposed-only', async () => {
    const spy = vi.spyOn(askInternalMod, 'askInternal').mockResolvedValue({ ok: true, answer: 'x' });
    const res = await tools.runTool('ASK_INTERNAL', { question: 'policy?' }, { profile: internal(), mode: 'shadow' });
    expect(spy).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.proposedOnly).toBe(true);
  });

  it('DISABLED mode: also does not contact AITeammate', async () => {
    const spy = vi.spyOn(askInternalMod, 'askInternal').mockResolvedValue({ ok: true, answer: 'x' });
    const res = await tools.runTool('ASK_INTERNAL', { question: 'policy?' }, { profile: internal(), mode: 'disabled' });
    expect(spy).not.toHaveBeenCalled();
    expect(res.proposedOnly).toBe(true);
  });

  it('APPROVAL mode without explicit permission: does not contact AITeammate (requires approval)', async () => {
    const spy = vi.spyOn(askInternalMod, 'askInternal').mockResolvedValue({ ok: true, answer: 'x' });
    const res = await tools.runTool('ASK_INTERNAL', { question: 'policy?' }, { profile: internal(), mode: 'approval', approvedAutomaticActions: [] });
    expect(spy).not.toHaveBeenCalled();
    expect(res.requiresApproval).toBe(true);
  });

  it('APPROVAL mode WITH explicit permission: contacts AITeammate', async () => {
    const spy = vi.spyOn(askInternalMod, 'askInternal').mockResolvedValue({ ok: true, answer: 'the guidance' });
    const res = await tools.runTool('ASK_INTERNAL', { question: 'policy?' }, { profile: internal(), mode: 'approval', approvedAutomaticActions: ['ASK_INTERNAL'] });
    expect(spy).toHaveBeenCalledOnce();
    expect(res.ok).toBe(true);
    expect(res.verifiedFacts[0].value).toBe('the guidance');
  });

  it('AUTONOMOUS mode: contacts AITeammate (internal low-risk read)', async () => {
    const spy = vi.spyOn(askInternalMod, 'askInternal').mockResolvedValue({ ok: true, answer: 'auto guidance' });
    const res = await tools.runTool('ASK_INTERNAL', { question: 'policy?' }, { profile: internal(), mode: 'autonomous' });
    expect(spy).toHaveBeenCalledOnce();
    expect(res.ok).toBe(true);
  });

  it('external sender is denied regardless of mode', async () => {
    const carrier = { slackId: 'U_C', name: 'C', type: 'carrier', operators: ['TUZR'], domiciles: [], allowedDataCategories: ['unit_status'], permittedRequestTypes: ['unit_status'] };
    const res = await tools.runTool('ASK_INTERNAL', { question: 'x' }, { profile: carrier, mode: 'autonomous' });
    expect(res.denied).toBe(true);
  });
});

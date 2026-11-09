// tests/ai-json-call-sites.test.js — every AI-reply JSON call site fixed in
// fix/ai-json-parse parses an Aki-style wrapped reply (prose + ```json fence +
// trailing text), keeps its original error messages for non-JSON replies, and
// still parses a clean bare-JSON reply identically. The renderer / heartbeat
// parse lines are not exported, so the real source lines are sliced and run in
// a sandbox (same pattern as tests/helpers/dbr-renderer-src.js). No real model
// is ever called: replies are fixed strings and relay.ask is spied.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import * as esm from '../renderer/src/js/util/ai-json.js';
import { _stripCosts } from '../renderer/src/js/longdwell-ai.js';
import {
  AKI_LONGDWELL_REPLY, AKI_LONGDWELL_REPLY_RAW_NL, LD_EXPECTED,
  AKI_RCA_REPLY, RCA_VALUES, AKI_WR_REPLY, WR_VALUES, AKI_WBR_REPLY, WBR_VALUES, AKI_HB_REPLY, HB_VALUES,
} from './helpers/aki-style-replies.js';
import {
  CSV, WR_MODAL, DAILY_CALL, HEARTBEAT, readLines, sliceLines, includes, exactly, aiFillRowLines,
} from './helpers/ai-json-callsite-src.js';
const require = createRequire(import.meta.url);
const cjs = require('../src/utils/ai-json');

const LD_FIELDS = { delayReason: LD_EXPECTED.delayReason, escalationLevel: LD_EXPECTED.escalationLevel, summary: _stripCosts(LD_EXPECTED.summary).slice(0, 4000) };
const CLEAN_LD = JSON.stringify(LD_EXPECTED);

describe('analytics.js _aiFillRow parse', () => {
  const slice = sliceLines(aiFillRowLines('analytics.js#_aiFillRow'), "const text = result.text || '';", includes('let summary'), 'analytics parse');
  const run = new Function('result', 'extractJsonObject', '_stripCosts', slice + '\nreturn { delayReason, escalationLevel, summary };');
  const parse = (text) => run({ ok: true, text }, esm.extractJsonObject, _stripCosts);
  it('Aki-wrapped replies parse to the three fields', () => {
    expect(parse(AKI_LONGDWELL_REPLY)).toEqual(LD_FIELDS);
    expect(parse(AKI_LONGDWELL_REPLY_RAW_NL)).toEqual(LD_FIELDS);
  });
  it('clean bare JSON is unchanged', () => { expect(parse(CLEAN_LD)).toEqual(LD_FIELDS); });
  it('keeps the original error messages', () => {
    expect(() => parse('no json here')).toThrow(new Error('AI response was not JSON'));
    expect(() => parse('{bad json}')).toThrow(/^Could not parse AI JSON: /);
  });
});

describe('longdwell-csv.js _aiFillRow parse', () => {
  const sanitizeSrc = sliceLines(readLines(CSV), 'function _sanitizeAiJson(', exactly('}'), '_sanitizeAiJson');
  const _sanitizeAiJson = new Function(sanitizeSrc + '\nreturn _sanitizeAiJson;')();
  const slice = sliceLines(aiFillRowLines('longdwell-csv.js#_aiFillRow'), "const textOut = result.text || '';", includes('let notes'), 'csv parse');
  const run = new Function('result', 'extractJsonObject', '_stripCosts', '_sanitizeAiJson', slice + '\nreturn { delayReason, escalation, notes };');
  const parse = (text) => run({ ok: true, text }, esm.extractJsonObject, _stripCosts, _sanitizeAiJson);
  const want = { delayReason: LD_EXPECTED.delayReason, escalation: LD_EXPECTED.escalationLevel, notes: _stripCosts(LD_EXPECTED.summary).slice(0, 8000) };
  it('Aki-wrapped replies parse to the three fields', () => {
    expect(parse(AKI_LONGDWELL_REPLY)).toEqual(want);
    expect(parse(AKI_LONGDWELL_REPLY_RAW_NL)).toEqual(want);
  });
  it('clean bare JSON is unchanged', () => { expect(parse(CLEAN_LD)).toEqual(want); });
  it('keeps the original error messages', () => {
    expect(() => parse('no json here')).toThrow(new Error('AI response was not JSON'));
    expect(() => parse('{bad json}')).toThrow(/^Could not parse AI JSON: /);
  });
});

describe('wr-modal.js _runAIAssist parse', () => {
  const slice = sliceLines(readLines(WR_MODAL), "let ai = typeof text === 'string' ? extractJsonObject(text)", includes('ai = JSON.parse(match[0]);'), 'wr parse');
  const run = new Function('text', 'extractJsonObject', 'toast', slice + '\n}\nreturn ai;');
  it('Aki-wrapped reply yields title/issue/vendor', () => {
    const toast = { show: vi.fn() };
    expect(run(AKI_WR_REPLY, esm.extractJsonObject, toast)).toEqual(WR_VALUES);
    expect(toast.show).not.toHaveBeenCalled();
  });
  it('clean bare JSON is unchanged', () => {
    expect(run(JSON.stringify(WR_VALUES), esm.extractJsonObject, { show: vi.fn() })).toEqual(WR_VALUES);
  });
  it('no JSON keeps the original warn toast', () => {
    const toast = { show: vi.fn() };
    expect(run('no data', esm.extractJsonObject, toast)).toBeUndefined();
    expect(toast.show).toHaveBeenCalledWith('warn', 'AI returned no data (AI service may be down) — fill fields manually', 4000);
  });
});

describe('daily-call.js _parseWbrJson', () => {
  const src = sliceLines(readLines(DAILY_CALL), 'function _parseWbrJson(', exactly('}'), '_parseWbrJson');
  const _parseWbrJson = new Function('extractJsonObject', src + '\nreturn _parseWbrJson;')(esm.extractJsonObject);
  it('Aki-wrapped reply yields bridge/actions', () => {
    expect(_parseWbrJson(AKI_WBR_REPLY)).toEqual(WBR_VALUES);
  });
  it('clean JSON and the truncated field-grab fallback still work', () => {
    expect(_parseWbrJson(JSON.stringify(WBR_VALUES))).toEqual(WBR_VALUES);
    // Reply cut off mid "actions": the existing grab fallback recovers "bridge".
    expect(_parseWbrJson('{"bridge": "Down units up 3 WoW", "actions": "Escalate')).toEqual({ bridge: 'Down units up 3 WoW', actions: '' });
    expect(_parseWbrJson('nothing useful')).toBeNull();
  });
});

describe('heartbeat.js _autoInferRCA parse', () => {
  const lines = readLines(HEARTBEAT);
  const head = sliceLines(lines, 'let parsed = extractJsonObject(text);', includes("reason: 'response not JSON'"), 'heartbeat parse');
  const endIdx = lines.findIndex((l) => l.includes("reason: 'response not JSON'"));
  const closing = lines[endIdx + 1];
  expect(closing.trim()).toBe('}');
  const run = new Function('text', 'unitId', 'rcaStore', 'results', 'logger', 'extractJsonObject',
    'try {\n' + head + '\n' + closing + '\n} catch (e) { results.push({ unitId, inferred: false, reason: e.message }); }\nreturn results;');
  const go = (text) => {
    const rcaStore = {};
    const results = run(text, 'B13014', rcaStore, [], { info: vi.fn() }, cjs.extractJsonObject);
    return { rcaStore, results };
  };
  it('Aki-wrapped reply infers the codes', () => {
    const { rcaStore, results } = go(AKI_HB_REPLY);
    expect(results).toEqual([{ unitId: 'B13014', inferred: true, codes: HB_VALUES }]);
    expect(rcaStore.B13014).toMatchObject({ ...HB_VALUES, source: 'heartbeat-auto' });
  });
  it('clean bare JSON is unchanged', () => {
    expect(go(JSON.stringify(HB_VALUES)).results[0]).toEqual({ unitId: 'B13014', inferred: true, codes: HB_VALUES });
  });
  it('keeps the original failure reasons', () => {
    expect(go('I am not sure.').results).toEqual([{ unitId: 'B13014', inferred: false, reason: 'response not JSON' }]);
    const bad = go('{bad}').results[0];
    expect(bad.inferred).toBe(false);
    let msg; try { JSON.parse('{bad}'); } catch (e) { msg = e.message; }
    expect(bad.reason).toBe(msg);
  });
});

describe('rca/autofill.js _aiFill (real module, relay.ask faked)', () => {
  const tmpDir = path.join(os.tmpdir(), 'ai-json-sites-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  require('../src/config/paths').setDataDir(tmpDir);
  const relay = require('../src/orcha/relay');
  const fleetBrain = require('../src/orcha/fleet-brain');
  const { installFakeFleetBrain, baseRelaySetup } = require('./helpers/ai-gateway-fakes.cjs');
  const autofill = require('../src/rca/autofill');
  beforeEach(() => { baseRelaySetup(relay); installFakeFleetBrain(vi, fleetBrain); });
  afterEach(() => { relay.__test__.reset(); vi.restoreAllMocks(); });
  it('Aki-wrapped reply fills the RCA values', async () => {
    vi.spyOn(relay, 'ask').mockResolvedValue(AKI_RCA_REPLY);
    expect(await autofill._aiFill({ fields: [] }, {}, '', null)).toEqual({ values: RCA_VALUES });
  });
  it('clean bare JSON is unchanged', async () => {
    vi.spyOn(relay, 'ask').mockResolvedValue(JSON.stringify(RCA_VALUES));
    expect(await autofill._aiFill({ fields: [] }, {}, '', null)).toEqual({ values: RCA_VALUES });
  });
  it("prose-only reply keeps 'AI reply was not JSON'", async () => {
    vi.spyOn(relay, 'ask').mockResolvedValue('I could not determine the root cause from this thread.');
    expect(await autofill._aiFill({ fields: [] }, {}, '', null)).toEqual({ values: {}, error: 'AI reply was not JSON' });
  });
});

// tests/ai-json.test.js — tolerant AI-reply JSON extractor. Runs the same
// cases against both twins (src/utils/ai-json.js CJS, renderer/src/js/util/
// ai-json.js ESM) and checks their shared bodies stay byte-identical.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import * as esm from '../renderer/src/js/util/ai-json.js';
import { AKI_LONGDWELL_REPLY, AKI_LONGDWELL_REPLY_RAW_NL, LD_EXPECTED } from './helpers/aki-style-replies.js';
const require = createRequire(import.meta.url);
const cjs = require('../src/utils/ai-json');

const OBJ = { delayReason: 'Parts Delay', escalationLevel: 'SEV3', summary: 'line one\nline two' };
const OBJ_TXT = JSON.stringify(OBJ);

describe.each([['cjs', cjs], ['esm', esm]])('ai-json extractor (%s)', (_name, m) => {
  const { extractJsonObject, extractJsonArray } = m;

  it('bare object is returned unchanged', () => {
    expect(extractJsonObject(OBJ_TXT)).toEqual(JSON.parse(OBJ_TXT));
    expect(extractJsonObject('  ' + JSON.stringify(OBJ, null, 2) + '\n')).toEqual(OBJ);
  });
  it('```json fenced', () => {
    expect(extractJsonObject('```json\n' + OBJ_TXT + '\n```')).toEqual(OBJ);
  });
  it('``` fenced without a language tag', () => {
    expect(extractJsonObject('```\n' + OBJ_TXT + '\n```')).toEqual(OBJ);
  });
  it('leading prose', () => {
    expect(extractJsonObject('Here is the JSON:\n' + OBJ_TXT)).toEqual(OBJ);
  });
  it('trailing prose', () => {
    expect(extractJsonObject(OBJ_TXT + '\n\nLet me know if you need more. OK via aki')).toEqual(OBJ);
  });
  it('stray { in prose before the real object', () => {
    expect(extractJsonObject('Thinking { about this one.\n' + OBJ_TXT)).toEqual(OBJ);
  });
  it('a {x} pair before the object and a } after it', () => {
    expect(extractJsonObject('Template uses {unitId} here.\n' + OBJ_TXT + '\nDone } bye')).toEqual(OBJ);
  });
  it('nested objects return the outer object', () => {
    const nested = { a: { b: { c: 1 } }, d: [{ e: 2 }] };
    expect(extractJsonObject('Result: ' + JSON.stringify(nested) + ' end')).toEqual(nested);
  });
  it('strings containing braces, brackets and escaped quotes', () => {
    const tricky = { summary: 'He said "use {this}" and ] then }', note: 'back\\slash "q" {' };
    expect(extractJsonObject('prose { ' + 'x\n' + JSON.stringify(tricky) + '\ntrailing }')).toEqual(tricky);
  });
  it('raw newlines inside a string value are repaired', () => {
    expect(extractJsonObject('Sure:\n{"summary": "line one\nline two", "x": "a\tb"}')).toEqual({ summary: 'line one\nline two', x: 'a\tb' });
  });
  it('smart-quote delimiters', () => {
    expect(extractJsonObject('{\u201Ca\u201D: \u201Cb\u201D}')).toEqual({ a: 'b' });
  });
  it('trailing comma', () => {
    expect(extractJsonObject('{"a": 1, "b": [1, 2,],}')).toEqual({ a: 1, b: [1, 2] });
  });
  it('top-level array via extractJsonArray', () => {
    expect(extractJsonArray('[1, 2, 3]')).toEqual([1, 2, 3]);
    const arr = [{ name: 'A' }, { name: 'B [x]' }];
    expect(extractJsonArray('Dealers found [see below]:\n```json\n' + JSON.stringify(arr) + '\n```\nthanks')).toEqual(arr);
    expect(extractJsonArray('Dealers [see below]:\n' + JSON.stringify(arr) + '\nthanks')).toEqual(arr);
  });
  it('extractJsonObject does not return a top-level array', () => {
    const v = extractJsonObject('[{"a":1}]');
    expect(Array.isArray(v)).toBe(false);
    expect(extractJsonObject('[1,2,3]')).toBeNull();
    expect(extractJsonArray(OBJ_TXT)).toBeNull();
  });
  it('no JSON returns null without throwing', () => {
    for (const v of ['Sorry, I could not determine that.', '', null, undefined, 123, {}, { text: OBJ_TXT }]) {
      expect(extractJsonObject(v)).toBeNull();
      expect(extractJsonArray(v)).toBeNull();
    }
  });
  it('unbalanced / truncated object returns null', () => {
    expect(extractJsonObject('{"delayReason": "Parts Delay", "summary": "cut off')).toBeNull();
    expect(extractJsonObject('{bad json}')).toBeNull();
  });
  it('~3000-char Aki-style reply (fence + prose + stray braces)', () => {
    expect(AKI_LONGDWELL_REPLY.length).toBeGreaterThanOrEqual(2900);
    expect(extractJsonObject(AKI_LONGDWELL_REPLY)).toEqual(LD_EXPECTED);
  });
  it('~3000-char Aki-style reply with RAW newlines inside the summary', () => {
    expect(extractJsonObject(AKI_LONGDWELL_REPLY_RAW_NL)).toEqual(LD_EXPECTED);
  });
  it('Aki-style reply without the fence still parses (whole-text scan)', () => {
    const unfenced = AKI_LONGDWELL_REPLY.replace('```json\n', '').replace('\n```', '');
    expect(extractJsonObject(unfenced)).toEqual(LD_EXPECTED);
  });
});

describe('ai-json twins', () => {
  const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  const body = (t) => {
    const a = t.indexOf('// >>> ai-json shared body');
    const b = t.indexOf('// <<< ai-json shared body');
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    return t.slice(a, b);
  };
  it('shared body is byte-identical in the CJS and ESM twins', () => {
    expect(body(read('../src/utils/ai-json.js'))).toBe(body(read('../renderer/src/js/util/ai-json.js')));
  });
});

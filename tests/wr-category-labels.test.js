// tests/wr-category-labels.test.js
//
// WR modal Category / Sub-category / Sub-sub-category dropdowns showed AAP's
// underscore codes (TOTAL_VEHICLE, CHECK_ENGINE_LIGHT) as option labels when
// the avmCodes node had no displayName (getAvmTree falls back to the code).
// Fix: avmOptionsHtml humanizes the LABEL via formatAvmLabel; the option VALUE
// and the submitted areaPairs codes are unchanged.
//
// formatAvmLabel is imported for real (pure util). avmOptionsHtml /
// buildAreaPairsPayload are mirrored (wr-modal.js pulls in bridge.js + DOM),
// and a source check pins the real avmOptionsHtml to the mirrored shape.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { formatAvmLabel } from '../renderer/src/js/util/avm-label.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WR_MODAL_SRC = fs.readFileSync(path.join(__dirname, '../renderer/src/js/views/wr-modal.js'), 'utf8');
const DRAFT_INBOX_SRC = fs.readFileSync(path.join(__dirname, '../renderer/src/js/components/draft-inbox.js'), 'utf8');

// ── Mirrors (wr-modal.js) ──────────────────────────────────────────────────
const _safe = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const _safeAttr = (s) => _safe(s).replace(/"/g, '&quot;');
function avmOptionsHtml(items, selected, placeholder) {
  const opts = ['<option value="">' + _safe(placeholder || '-- Select --') + '</option>'];
  for (const it of (items || [])) {
    const code = (it && it.code != null) ? String(it.code) : '';
    const name = formatAvmLabel((it && (it.displayName || it.code)) || '');
    const sel = (selected != null && String(selected) === code) ? ' selected' : '';
    opts.push('<option value="' + _safeAttr(code) + '"' + sel + '>' + _safe(name) + '</option>');
  }
  return opts.join('');
}
function buildAreaPairsPayload(rows) {
  const out = [];
  for (const r of (rows || [])) {
    if (!r) continue;
    const area = String(r.area || '').trim();
    const sub = String(r.subcategory || '').trim();
    const subSub = String(r.subSubcategory || '').trim();
    if (!area && !sub) continue;
    out.push({ area, subcategory: sub, subSubcategory: subSub });
  }
  return out;
}
function parseOptions(html) {
  const re = /<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g;
  const out = []; let m;
  while ((m = re.exec(html))) if (m[1]) out.push({ value: m[1], label: m[2] });
  return out;
}

// Parsed-tree items as getAvmTree produces them when AAP sends no displayName
// (displayName = code) plus a mixed-case underscored one and a clean one.
const ITEMS = [
  { code: 'BODY', displayName: 'BODY' },
  { code: 'TOTAL_VEHICLE', displayName: 'TOTAL_VEHICLE' },
  { code: 'CHECK_ENGINE_LIGHT', displayName: 'CHECK_ENGINE_LIGHT' },
  { code: 'CEL_AIR_TEMPERATURE', displayName: 'CEL_AIR_TEMPERATURE' },
  { code: 'HVAC_ASSEMBLY', displayName: 'HVAC_ASSEMBLY' },
  { code: 'EV_CHARGING_SYSTEM' },
  { code: 'Check_Engine_Light', displayName: 'Check_Engine_Light' },
  { code: 'TIR_STEER_L', displayName: 'Steer Left' },
];

describe('formatAvmLabel', () => {
  it('turns underscore codes into spaced Title Case', () => {
    expect(formatAvmLabel('TOTAL_VEHICLE')).toBe('Total Vehicle');
    expect(formatAvmLabel('CHECK_ENGINE_LIGHT')).toBe('Check Engine Light');
    expect(formatAvmLabel('Check_Engine_Light')).toBe('Check Engine Light');
  });
  it('keeps known acronyms upper case', () => {
    expect(formatAvmLabel('CEL_AIR_TEMPERATURE')).toBe('CEL Air Temperature');
    expect(formatAvmLabel('HVAC')).toBe('HVAC');
    expect(formatAvmLabel('HVAC_ASSEMBLY')).toBe('HVAC Assembly');
    expect(formatAvmLabel('ADAS')).toBe('ADAS');
    expect(formatAvmLabel('EV_CHARGING_SYSTEM')).toBe('EV Charging System');
    expect(formatAvmLabel('DEF_ASSEMBLY')).toBe('DEF Assembly');
    expect(formatAvmLabel('GPS_TRACKING')).toBe('GPS Tracking');
    expect(formatAvmLabel('TOW')).toBe('TOW');
  });
  it('handles punctuation and small words in the hardcoded fallback lists', () => {
    expect(formatAvmLabel('ACCIDENT/RECOVERY')).toBe('Accident/Recovery');
    expect(formatAvmLabel('MIRRORS AND VISOR')).toBe('Mirrors and Visor');
    expect(formatAvmLabel('BULBS, FUSES')).toBe('Bulbs, Fuses');
    expect(formatAvmLabel('FLEETEDGE-AI BOX')).toBe('Fleetedge-AI Box');
  });
  it('leaves real mixed-case displayNames alone', () => {
    expect(formatAvmLabel('Steer Left')).toBe('Steer Left');
    expect(formatAvmLabel('HALO TIRE INFLATOR (GEN 1 and GEN 2)')).toBe('HALO TIRE INFLATOR (GEN 1 and GEN 2)');
  });
  it('is safe on empty input', () => {
    expect(formatAvmLabel('')).toBe('');
    expect(formatAvmLabel(null)).toBe('');
    expect(formatAvmLabel(undefined)).toBe('');
  });
});

describe('avmOptionsHtml: labels spaced, values unchanged', () => {
  const opts = parseOptions(avmOptionsHtml(ITEMS, 'TOTAL_VEHICLE', '-- Category --'));

  it('no option label contains an underscore', () => {
    expect(opts).toHaveLength(ITEMS.length);
    for (const o of opts) expect(o.label).not.toMatch(/_/);
  });

  it('labels read as human text, including acronym cases', () => {
    expect(opts.map((o) => o.label)).toEqual([
      'Body', 'Total Vehicle', 'Check Engine Light', 'CEL Air Temperature',
      'HVAC Assembly', 'EV Charging System', 'Check Engine Light', 'Steer Left',
    ]);
  });

  it('option VALUES are the exact AAP codes (underscores kept)', () => {
    expect(opts.map((o) => o.value)).toEqual(ITEMS.map((i) => i.code));
  });

  it('pre-selection still matches on the code', () => {
    const html = avmOptionsHtml(ITEMS, 'TOTAL_VEHICLE', '-- Category --');
    expect(html).toContain('<option value="TOTAL_VEHICLE" selected>Total Vehicle</option>');
  });
});

describe('submitted codes are unchanged by the label fix', () => {
  it('buildAreaPairsPayload sends the selected option values (codes) verbatim', () => {
    // The submit path reads <select>.value, i.e. the option value = code.
    const opts = parseOptions(avmOptionsHtml(ITEMS, '', ''));
    const val = (code) => opts.find((o) => o.value === code).value;
    const pairs = buildAreaPairsPayload([
      { area: val('BODY'), subcategory: val('TOTAL_VEHICLE'), subSubcategory: '' },
      { area: val('CHECK_ENGINE_LIGHT'), subcategory: val('CEL_AIR_TEMPERATURE'), subSubcategory: '' },
      { area: 'TOW', subcategory: 'MECHANICAL ISSUE', subSubcategory: '' },
    ]);
    expect(pairs).toEqual([
      { area: 'BODY', subcategory: 'TOTAL_VEHICLE', subSubcategory: '' },
      { area: 'CHECK_ENGINE_LIGHT', subcategory: 'CEL_AIR_TEMPERATURE', subSubcategory: '' },
      { area: 'TOW', subcategory: 'MECHANICAL ISSUE', subSubcategory: '' },
    ]);
  });
});

describe('source pins (mirrors stay in sync with the real modules)', () => {
  it('wr-modal avmOptionsHtml formats the label and keeps value = code', () => {
    expect(WR_MODAL_SRC).toContain("import { formatAvmLabel } from '../util/avm-label.js';");
    expect(WR_MODAL_SRC).toContain("const name = formatAvmLabel((it && (it.displayName || it.code)) || '');");
    expect(WR_MODAL_SRC).toContain(`opts.push('<option value="' + _safeAttr(code) + '"' + sel + '>' + _safe(name) + '</option>');`);
  });
  it('wr-modal buildAreaPairsPayload still reads raw r.area / r.subcategory / r.subSubcategory', () => {
    expect(WR_MODAL_SRC).toContain("const area = String(r.area || '').trim();");
    expect(WR_MODAL_SRC).toContain("const sub = String(r.subcategory || '').trim();");
    expect(WR_MODAL_SRC).toContain("const subSub = String(r.subSubcategory || '').trim();");
    expect(WR_MODAL_SRC).toContain('out.push({ area, subcategory: sub, subSubcategory: subSub });');
    // formatAvmLabel is used only for the option label, never on the payload.
    const codeLines = WR_MODAL_SRC.split('\n').filter((l) => !/^\s*\/\//.test(l));
    expect(codeLines.filter((l) => l.includes('formatAvmLabel(')).length).toBe(1);
  });
  it('draft-inbox review card formats the Area display', () => {
    expect(DRAFT_INBOX_SRC).toContain("import { formatAvmLabel } from '../util/avm-label.js';");
    expect(DRAFT_INBOX_SRC).toMatch(/_esc\(formatAvmLabel\(wr\.aiArea/);
    expect(DRAFT_INBOX_SRC).toMatch(/_esc\(formatAvmLabel\(wr\.aiSubcategory/);
  });
});

// tests/wr-modal-live-lookups.test.js
//
// Coverage for the WR modal's LIVE, auto-populating cascading dropdowns
// (vendor + Category L1 -> Sub-category L2 -> Sub-sub-category L3), fed from
// AAP's avmCodes + vendorConfigs endpoints via window.aapApi.
//
// Per this project's convention (see wr-modal-ai-assist-fix.test.js and
// wr-tow-title-direction.test.js), the pure data/transform logic is MIRRORED
// here rather than importing the renderer module (which pulls in ../bridge.js
// + DOM) or the aap_api client (which calls its own module-internal apiGet that
// can't be spied). These mirrors must stay in sync with:
//   - getVendorConfigs / getAvmTree parsing in src/scrapers/aap_api.js
//   - avmTypeForUnit / avmOptionsHtml / buildAreaPairsPayload in
//     renderer/src/js/views/wr-modal.js
//   - the suggestedItems builder in _buildWoBody (aap_api.js) and
//     createWorkRequest (aap_create_wr.js)
//
// They prove: vendor list filters to wrEnabled, the avmTree cascades
// L1 -> L2 -> L3 with L3 ONLY for parents that have children (Tires), TOW stays
// a passthrough, and the submit payload carries all three codes.
import { describe, it, expect } from 'vitest';

// ── Mirror: getVendorConfigs parsing (aap_api.js) ──────────────────────────
function parseVendorConfigs(raw) {
  const arr = Array.isArray(raw) ? raw : (raw && raw.vendorConfigs) || [];
  return arr.map((v) => ({
    vendorId: v.vendorId,
    vendorName: v.vendorName || v.vendorId,
    uuid: v.uuid || null,
    suppliers: Array.isArray(v.suppliers) ? v.suppliers : [],
    supplierRequired: !!v.supplierRequired,
    enabledFeatures: Array.isArray(v.enabledFeatures) ? v.enabledFeatures : [],
    wrEnabled: (Array.isArray(v.enabledFeatures) ? v.enabledFeatures : []).some((f) => /WORK_REQUEST_CREATION|UNPLANNED/.test(String(f))),
  }));
}

// ── Mirror: getAvmTree parsing (aap_api.js) ────────────────────────────────
function parseAvmTree(raw) {
  const l1 = (raw && raw.l1Codes || []).map((c) => ({ code: c.code, displayName: c.displayName || c.code }));
  const l2ByParent = {};
  (raw && raw.l2Codes || []).forEach((c) => {
    const item = { code: c.code, displayName: c.displayName || c.code };
    (Array.isArray(c.l1Parents) ? c.l1Parents : []).forEach((p) => { (l2ByParent[p] = l2ByParent[p] || []).push(item); });
  });
  const l3ByParent = {};
  (raw && raw.l3Codes || []).forEach((c) => {
    const item = { code: c.code, displayName: c.displayName || c.code };
    (Array.isArray(c.l2Parents) ? c.l2Parents : []).forEach((p) => { (l3ByParent[p] = l3ByParent[p] || []).push(item); });
  });
  const reasons = (raw && raw.reasonsForRepair || []).map((r) => (typeof r === 'string' ? { code: r, displayName: r } : { code: r.code, displayName: r.displayName || r.code }));
  return { l1, l2ByParent, l3ByParent, reasons };
}

// ── Mirror: renderer helpers (wr-modal.js) ─────────────────────────────────
const TOW_L1_CODE = 'TOW';
const TOW_REASONS = ['MECHANICAL ISSUE', 'IMPOUND', 'ABANDONED EQUIPMENT', 'ACCIDENT/RECOVERY'];

function avmTypeForUnit(unit) {
  const u = unit || {};
  const hay = [u.bodyType, u.assetType, u.assetDefinitionKey, u.equipmentType, u.type]
    .filter(Boolean).join(' ').toLowerCase();
  if (/box/.test(hay)) return 'boxTruck';
  if (/tractor|sleeper|day\s*cab|daycab/.test(hay)) return 'tractor';
  return 'boxTruck';
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

// L2/L3 lookups from a parsed tree, with the synthetic TOW passthrough.
function l2ItemsFor(tree, l1code) {
  if (String(l1code) === TOW_L1_CODE) return TOW_REASONS.map((r) => ({ code: r, displayName: r }));
  return (tree && tree.l2ByParent && tree.l2ByParent[l1code]) || [];
}
function l3ItemsFor(tree, l2code) {
  return (tree && tree.l3ByParent && tree.l3ByParent[l2code]) || [];
}

// ── Mirror: suggestedItems builder (aap_api._buildWoBody / create_wr) ──────
function buildSuggestedItems(areaPairs) {
  return (areaPairs || [])
    .filter(p => p && (p.area || p.subcategory))
    .map(p => ({ level1: p.area || '', level2: p.subcategory || '', level3: p.subSubcategory || '' }));
}

// ── Fixtures ───────────────────────────────────────────────────────────────
const RAW_VENDORS = {
  vendorConfigs: [
    { vendorId: 'COX', vendorName: 'COX', enabledFeatures: ['WORK_REQUEST_CREATION'] },
    { vendorId: 'AMERIT', vendorName: 'AMERIT', enabledFeatures: ['UNPLANNED_WR'] },
    { vendorId: 'LEGACY', vendorName: 'Legacy Only', enabledFeatures: ['PLANNED_PM'] }, // NOT wrEnabled
    { vendorId: 'NOFEAT', vendorName: 'No Features' },                                   // NOT wrEnabled
  ],
};

// A tractor avmCodes tree: most L1 have L2 but no L3; TIRES has L2 with L3.
const RAW_TREE = {
  l1Codes: [
    { code: 'BRK', displayName: 'Brakes' },
    { code: 'TIR', displayName: 'Tires' },
  ],
  l2Codes: [
    { code: 'BRK_PAD', displayName: 'Brake Pads', l1Parents: ['BRK'] },
    { code: 'TIR_POS', displayName: 'Tire Position', l1Parents: ['TIR'] },
  ],
  l3Codes: [
    // Only TIR_POS has children (steer/drive positions) — Brakes has none.
    { code: 'TIR_STEER_L', displayName: 'Steer Left', l2Parents: ['TIR_POS'] },
    { code: 'TIR_STEER_R', displayName: 'Steer Right', l2Parents: ['TIR_POS'] },
  ],
  reasonsForRepair: ['WEAR', 'DAMAGE'],
};

describe('vendor dropdown filters to wrEnabled', () => {
  it('keeps only vendors with a WR-creation / UNPLANNED feature', () => {
    const parsed = parseVendorConfigs(RAW_VENDORS);
    const enabled = parsed.filter((v) => v.wrEnabled).map((v) => v.vendorName);
    expect(enabled).toEqual(['COX', 'AMERIT']);
    // The vendors without the feature are present in the parse but filtered out
    // of the dropdown.
    expect(parsed.find((v) => v.vendorName === 'Legacy Only').wrEnabled).toBe(false);
    expect(parsed.find((v) => v.vendorName === 'No Features').wrEnabled).toBe(false);
  });

  it('option value == vendorName (submit reads #wr-vendor .value)', () => {
    const parsed = parseVendorConfigs(RAW_VENDORS).filter((v) => v.wrEnabled);
    for (const v of parsed) expect(v.vendorName).toBeTruthy();
  });
});

describe('avmTree cascades L1 -> L2 -> L3', () => {
  const tree = parseAvmTree(RAW_TREE);

  it('parses L1 + the L2-by-parent / L3-by-parent maps', () => {
    expect(tree.l1.map((c) => c.code)).toEqual(['BRK', 'TIR']);
    expect(tree.l2ByParent.BRK.map((c) => c.code)).toEqual(['BRK_PAD']);
    expect(tree.l2ByParent.TIR.map((c) => c.code)).toEqual(['TIR_POS']);
  });

  it('shows L3 ONLY for L2 parents that have children (Tires has it, Brakes does not)', () => {
    // Brakes -> Brake Pads: no L3 -> select stays hidden.
    expect(l3ItemsFor(tree, 'BRK_PAD')).toHaveLength(0);
    // Tires -> Tire Position: L3 present -> select shows.
    const tireL3 = l3ItemsFor(tree, 'TIR_POS');
    expect(tireL3.map((c) => c.code)).toEqual(['TIR_STEER_L', 'TIR_STEER_R']);
  });

  it('option value = code, label = displayName', () => {
    expect(tree.l2ByParent.TIR[0]).toEqual({ code: 'TIR_POS', displayName: 'Tire Position' });
    expect(l3ItemsFor(tree, 'TIR_POS')[0]).toEqual({ code: 'TIR_STEER_L', displayName: 'Steer Left' });
  });
});

describe('equipmentType derivation from the unit', () => {
  it('box bodies -> boxTruck', () => {
    expect(avmTypeForUnit({ bodyType: 'DRY_BOX' })).toBe('boxTruck');
    expect(avmTypeForUnit({ assetType: 'boxTruck' })).toBe('boxTruck');
  });
  it('tractor / sleeper / day cab -> tractor', () => {
    expect(avmTypeForUnit({ bodyType: 'SLEEPER' })).toBe('tractor');
    expect(avmTypeForUnit({ assetType: 'tractor' })).toBe('tractor');
    expect(avmTypeForUnit({ bodyType: 'DAY CAB' })).toBe('tractor');
  });
  it('unknown -> boxTruck (usable default)', () => {
    expect(avmTypeForUnit({})).toBe('boxTruck');
    expect(avmTypeForUnit(null)).toBe('boxTruck');
  });
});

describe('TOW passthrough', () => {
  const tree = parseAvmTree(RAW_TREE);

  it('TOW is selectable with its reason list as L2 even though it is not an avmCode', () => {
    const towL2 = l2ItemsFor(tree, TOW_L1_CODE);
    expect(towL2.map((c) => c.code)).toContain('MECHANICAL ISSUE');
    // TOW has no L3.
    expect(l3ItemsFor(tree, 'MECHANICAL ISSUE')).toHaveLength(0);
  });

  it('a TOW area pair survives the payload builder unchanged', () => {
    const pairs = buildAreaPairsPayload([{ area: 'TOW', subcategory: 'MECHANICAL ISSUE', subSubcategory: '' }]);
    expect(pairs).toEqual([{ area: 'TOW', subcategory: 'MECHANICAL ISSUE', subSubcategory: '' }]);
    const items = buildSuggestedItems(pairs);
    expect(items).toEqual([{ level1: 'TOW', level2: 'MECHANICAL ISSUE', level3: '' }]);
  });
});

describe('submit payload carries the 3 codes', () => {
  it('a Tires pick (L1/L2/L3) maps to level1/level2/level3 codes in suggestedItems', () => {
    const rows = [{ area: 'TIR', subcategory: 'TIR_POS', subSubcategory: 'TIR_STEER_L' }];
    const pairs = buildAreaPairsPayload(rows);
    expect(pairs).toEqual([{ area: 'TIR', subcategory: 'TIR_POS', subSubcategory: 'TIR_STEER_L' }]);
    const items = buildSuggestedItems(pairs);
    expect(items).toEqual([{ level1: 'TIR', level2: 'TIR_POS', level3: 'TIR_STEER_L' }]);
  });

  it('a no-L3 pick (Brakes) leaves level3 empty', () => {
    const pairs = buildAreaPairsPayload([{ area: 'BRK', subcategory: 'BRK_PAD', subSubcategory: '' }]);
    const items = buildSuggestedItems(pairs);
    expect(items).toEqual([{ level1: 'BRK', level2: 'BRK_PAD', level3: '' }]);
  });

  it('drops fully-empty rows but keeps rows with any value', () => {
    const pairs = buildAreaPairsPayload([
      { area: '', subcategory: '', subSubcategory: '' },
      { area: 'BRK', subcategory: '', subSubcategory: '' },
    ]);
    expect(pairs).toEqual([{ area: 'BRK', subcategory: '', subSubcategory: '' }]);
  });
});

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-mm-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const docIntel = require('../src/ai/document-intelligence');
const imgIntel = require('../src/ai/image-intelligence');
const cache = require('../src/ai/evidence-cache');
const bedrock = require('../src/scrapers/bedrock');

beforeEach(() => { store.save('aiEvidenceCache', []); });
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

// ── document-intelligence parser ────────────────────────────────────────────
describe('document-intelligence — parseExtraction', () => {
  it('parses a typed invoice with field confidences + identifiers', () => {
    const raw = JSON.stringify({
      documentType: 'invoice', summary: 'Amerit invoice for 322355',
      fields: { unit: { value: '322355', confidence: 0.98 }, totalAmount: { value: '$14,800', confidence: 0.9 },
                vendor: { value: 'Amerit', confidence: 0.95 }, vin: { value: null, confidence: 0 } },
      identifiers: { units: ['322355'], vins: [] },
    });
    const p = docIntel.parseExtraction(raw);
    expect(p.documentType).toBe('invoice');
    expect(p.fields.unit.value).toBe('322355');
    expect(p.fields.vin).toBeUndefined();           // null value dropped
    expect(p.identifiers.units).toContain('322355');
  });
  it('unknown doc type coerced to other; garbage → empty', () => {
    expect(docIntel.parseExtraction(JSON.stringify({ documentType: 'zzz', fields: {} })).documentType).toBe('other');
    expect(docIntel.parseExtraction('not json').documentType).toBe('other');
  });
});

describe('document-intelligence — extractDocument (vision stubbed)', () => {
  it('extracts + caches a repair estimate', async () => {
    vi.spyOn(bedrock, 'readFileWithVision').mockResolvedValue({ ok: true, kind: 'document',
      text: JSON.stringify({ documentType: 'repair_estimate', summary: 'estimate', fields: { unit: { value: '320160', confidence: 0.97 }, estimateAmount: { value: '$3,200', confidence: 0.9 } }, identifiers: { units: ['320160'], vins: [] } }) });
    const file = { name: 'estimate.pdf', mimetype: 'application/pdf', buffer: Buffer.from('x'), id: 'F1', size: 10 };
    const r = await docIntel.extractDocument(file);
    expect(r.ok).toBe(true);
    expect(r.documentType).toBe('repair_estimate');
    expect(r.units).toContain('320160');
    // second call should hit cache (vision NOT called again)
    bedrock.readFileWithVision.mockClear();
    const r2 = await docIntel.extractDocument(file);
    expect(r2.cached).toBe(true);
    expect(bedrock.readFileWithVision).not.toHaveBeenCalled();
  });
});

// ── image-intelligence parser + safety invariant ───────────────────────────
describe('image-intelligence — parseAnalysis', () => {
  it('parses a damage photo with side/area/severity', () => {
    const raw = JSON.stringify({ imageType: 'vehicle_damage', confidence: 0.86, summary: 'front passenger damage',
      damage: { side: 'passenger', area: 'front bumper', observations: ['visible dent', 'scrape'], severity: 'moderate_visual', confidence: 0.84 },
      visibleText: '', identifiers: { units: ['322355'], vins: [] } });
    const a = imgIntel.parseAnalysis(raw);
    expect(a.imageType).toBe('vehicle_damage');
    expect(a.damage.side).toBe('passenger');
    expect(a.damage.severity).toBe('moderate_visual');
    expect(a.identifiers.units).toContain('322355');
  });
  it('strips safety-certification language (spec #34)', () => {
    const raw = JSON.stringify({ imageType: 'vehicle_damage', confidence: 0.8, summary: 'Minor dent, safe to operate and cosmetic only.',
      damage: { side: 'driver', area: 'door', observations: ['dent'], severity: 'minor_visual', confidence: 0.8 }, visibleText: '', identifiers: { units: [], vins: [] } });
    const a = imgIntel.parseAnalysis(raw);
    expect(a.summary).not.toMatch(/safe to operate/i);
    expect(a.summary).not.toMatch(/cosmetic only/i);
  });
  it('invalid side/severity → safe defaults', () => {
    const raw = JSON.stringify({ imageType: 'vehicle_damage', confidence: 0.5, damage: { side: 'sideways', area: 'x', observations: [], severity: 'totaled' }, identifiers: {} });
    const a = imgIntel.parseAnalysis(raw);
    expect(imgIntel.SIDES).toContain(a.damage.side);
    expect(imgIntel.SEVERITIES).toContain(a.damage.severity);
  });
  it('screenshot → reads visible text', () => {
    const raw = JSON.stringify({ imageType: 'app_screenshot', confidence: 0.9, summary: 'AAP screenshot', damage: null, visibleText: 'Unit 320160 UNAVAILABLE', identifiers: { units: ['320160'], vins: [] } });
    const a = imgIntel.parseAnalysis(raw);
    expect(a.imageType).toBe('app_screenshot');
    expect(a.visibleText).toMatch(/UNAVAILABLE/);
  });
});

describe('image-intelligence — consolidateDamage (spec #35)', () => {
  it('same side+area across photos → same_damage_multiple_angles', () => {
    const c = imgIntel.consolidateDamage([
      { damage: { side: 'passenger', area: 'front bumper', severity: 'moderate_visual' }, identifiers: { units: ['322355'] } },
      { damage: { side: 'passenger', area: 'front bumper', severity: 'minor_visual' }, identifiers: { units: ['322355'] } },
    ]);
    expect(c.ok).toBe(true);
    expect(c.relationship).toBe('same_damage_multiple_angles');
    expect(c.severity).toBe('moderate_visual');  // worst wins
    expect(c.note).toMatch(/NOT a mechanical or safety/i);
  });
  it('different sides → multiple_damage_locations', () => {
    const c = imgIntel.consolidateDamage([
      { damage: { side: 'driver', area: 'door', severity: 'minor_visual' }, identifiers: {} },
      { damage: { side: 'rear', area: 'bumper', severity: 'severe_visual' }, identifiers: {} },
    ]);
    expect(c.relationship).toBe('multiple_damage_locations');
    expect(c.severity).toBe('severe_visual');
  });
});

// ── evidence-cache ──────────────────────────────────────────────────────────
describe('evidence-cache', () => {
  it('fileKey prefers id+size; falls back to content hash', () => {
    expect(cache.fileKey({ id: 'F1', size: 100 })).toBe('file:F1:100');
    expect(cache.fileKey({})).toBeNull();
    expect(cache.hashContent(Buffer.from('abc'))).toMatch(/^hash:/);
  });
  it('put/get round-trips a compact extraction; stores no raw bytes', () => {
    cache.put('file:F9', { kind: 'document', summary: 's', fields: { unit: { value: '1' } }, rawBytes: 'SHOULD_NOT_PERSIST' });
    const hit = cache.get('file:F9');
    expect(hit.extraction.summary).toBe('s');
    expect(hit.extraction.rawBytes).toBeUndefined();
  });
  it('stale URL entry is a miss', () => {
    const arr = [{ key: 'url:http://x', kind: 'url', extraction: {}, cachedAt: new Date(Date.now() - 999 * 3600 * 1000).toISOString() }];
    store.save('aiEvidenceCache', arr);
    expect(cache.get('url:http://x')).toBeNull();
  });
});

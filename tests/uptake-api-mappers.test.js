import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const uptake = require('../src/scrapers/uptake');

// The asset-ui /insights/search element shape (confirmed from live capture):
// each array element nests asset + insight under `assetInsight`, and the
// insight's human fields live under insight.insightMetadata.
function apiInsightEl({
  insightId = 'ins-1',
  title = 'Low Coolant Level',
  riskFactor = 'Cooling System',
  recommendedAction = 'Top off coolant and inspect for leaks.',
  description = 'Coolant level trending low over 14 days.',
  insightCategory = 'FAULT',
  actionState = 'OPEN',
  startTs = '2026-08-01T00:00:00Z',
  endTs = '2026-08-27T00:00:00Z',
  visibleInUi = true,
  riskScore = 72,
  severity = 'HIGH',
  media = [],
} = {}) {
  return {
    actionState,
    severity,
    riskScore,
    assetInsight: {
      assetInsightId: 'ai-1',
      severity,
      riskScore,
      insight: {
        insightId,
        startTs,
        endTs,
        visibleInUi,
        insightMetadata: { title, riskFactor, recommendedAction, description, insightCategory, severity },
        media,
      },
    },
  };
}

describe('uptake API mapper — mapApiInsight', () => {
  const UUID = 'abcd1234-0000-1111-2222-aaaabbbbcccc';

  it('maps the nested asset-ui shape to the flat insight model', () => {
    const out = uptake.mapApiInsight(apiInsightEl(), UUID);
    expect(out.title).toBe('Low Coolant Level');
    expect(out.subsystem).toBe('Cooling System');       // from riskFactor
    expect(out.recommended).toBe('Top off coolant and inspect for leaks.');
    expect(out.summary).toBe('Coolant level trending low over 14 days.');
    expect(out.type).toBe('FAULT');
    expect(out.status).toBe('OPEN');                     // from actionState
    expect(out.firstSeen).toBe('2026-08-01T00:00:00Z');  // startTs
    expect(out.lastSeen).toBe('2026-08-27T00:00:00Z');   // endTs
    expect(out.stillActive).toBe(true);                  // visibleInUi
    expect(out.riskScore).toBe(72);
  });

  it('builds the insight URL from the asset uuid + insight id', () => {
    const out = uptake.mapApiInsight(apiInsightEl({ insightId: 'ins-99' }), UUID);
    expect(out.url).toBe('https://fleet.uptake.com/asset/' + UUID + '/insights/ins-99');
    expect(out._insightId).toBe('ins-99');
    expect(out._assetUuid).toBe(UUID);
  });

  it('falls back to assetInsightId for the URL when insight.insightId is absent', () => {
    // insightId = ins.insightId || ai.assetInsightId — so a blank insightId
    // still yields a URL built from the assetInsightId (here "ai-1").
    const out = uptake.mapApiInsight(apiInsightEl({ insightId: '' }), UUID);
    expect(out.url).toBe('https://fleet.uptake.com/asset/' + UUID + '/insights/ai-1');
  });

  it('has an empty URL when the asset uuid is missing', () => {
    expect(uptake.mapApiInsight(apiInsightEl(), '').url).toBe('');
  });

  it('collects every PNG media link, sorted by leading index', () => {
    const media = [
      { mediaDataType: 'image/png', mediaFileLink: 'supporting_evidence/x/2_line_chart_fig.png' },
      { mediaDataType: 'image/png', mediaFileLink: 'supporting_evidence/x/1_fault_chart_fig.png' },
      { mediaDataType: 'application/pdf', mediaFileLink: 'supporting_evidence/x/report.pdf' }, // ignored
    ];
    const out = uptake.mapApiInsight(apiInsightEl({ media }), UUID);
    expect(out._mediaPngs).toEqual([
      'supporting_evidence/x/1_fault_chart_fig.png',
      'supporting_evidence/x/2_line_chart_fig.png',
    ]);
    expect(out._mediaPng).toBe('supporting_evidence/x/1_fault_chart_fig.png'); // first = backward-compat single
  });

  it('matches a .png link even when mediaDataType is absent', () => {
    const media = [{ mediaFileLink: 'supporting_evidence/y/1_chart.png' }];
    const out = uptake.mapApiInsight(apiInsightEl({ media }), UUID);
    expect(out._mediaPngs).toEqual(['supporting_evidence/y/1_chart.png']);
  });

  it('handles an empty element object without throwing', () => {
    // The mapper is only ever fed a real array element from insights/search;
    // an empty object is the safe-degenerate case (no media, blank fields).
    expect(() => uptake.mapApiInsight({}, UUID)).not.toThrow();
    const out = uptake.mapApiInsight({}, UUID);
    expect(out._mediaPngs).toEqual([]);
    expect(out.title).toBe('');
    expect(out.url).toBe(''); // no insightId -> no url
  });
});

describe('uptake API mapper — mapApiAsset', () => {
  it('reads attributes tolerant of casing variants (Vin/vin, modelname/Model)', () => {
    const a = uptake.mapApiAsset({
      attributes: {
        Vin: '1XKAD49X0MJ123456',
        modelname: 'Cascadia',
        'Model Year': '2021',
        manufacturername: 'Freightliner',
        fueltype: 'Diesel',
        operator: 'JLIT',
        domicilesite: 'EOFE01',
        assettype: 'tractor',
        TSP: 'TSP-5',
      },
      customerAssetName: '520024',
    });
    expect(a.vin).toBe('1XKAD49X0MJ123456');
    expect(a.model).toBe('Cascadia');
    expect(a.modelYear).toBe('2021');
    expect(a.manufacturer).toBe('Freightliner');
    expect(a.fuelType).toBe('Diesel');
    expect(a.operator).toBe('JLIT');
    expect(a.domicile).toBe('EOFE01');
    expect(a.assetType).toBe('tractor');
    expect(a.tsp).toBe('TSP-5');
    expect(a.customerName).toBe('520024');
  });

  it('falls back to the alternate casing when the primary key is absent', () => {
    const a = uptake.mapApiAsset({ attributes: { vin: 'v2', Model: 'M2', Make: 'Volvo', 'Fuel Type': 'CNG' } });
    expect(a.vin).toBe('v2');
    expect(a.model).toBe('M2');
    expect(a.manufacturer).toBe('Volvo');
    expect(a.fuelType).toBe('CNG');
  });

  it('never throws on empty input', () => {
    expect(() => uptake.mapApiAsset(null)).not.toThrow();
    expect(uptake.mapApiAsset({}).vin).toBe('');
  });
});

describe('uptake API mapper — mediaUrlCandidates', () => {
  it('builds the confirmed /api/media/insights?file= URL with encoding', () => {
    const urls = uptake.mediaUrlCandidates('supporting_evidence/abc/1_fault_chart_fig.png');
    expect(urls).toEqual([
      'https://fleet.uptake.com/api/media/insights?file='
      + encodeURIComponent('supporting_evidence/abc/1_fault_chart_fig.png'),
    ]);
  });

  it('strips a leading slash before encoding', () => {
    const urls = uptake.mediaUrlCandidates('/supporting_evidence/abc/1.png');
    expect(urls[0]).toContain('file=' + encodeURIComponent('supporting_evidence/abc/1.png'));
  });

  it('returns [] for an empty link', () => {
    expect(uptake.mediaUrlCandidates('')).toEqual([]);
    expect(uptake.mediaUrlCandidates(null)).toEqual([]);
  });
});

describe('uptake merge — mergeUptakeIntoRows', () => {
  const rows = [
    { equipmentId: '520024', vin: 'ATSVIN', model: 'ATS-Model', manufacturer: 'ATS-Make', modelYear: '2020' },
    { equipmentId: '999999' }, // no uptake match
  ];

  it('joins uptake units to AAP rows by NUMERIC equipment id', () => {
    const units = [{ id: 'A520024', riskScore: 88, riskLabel: 'High', insightCount: 3, insightsList: [{ title: 'x' }] }];
    const out = uptake.mergeUptakeIntoRows(rows, units);
    const joined = out.find(r => r.equipmentId === '520024');
    expect(joined.uptakeSynced).toBe(true);
    expect(joined.riskScore).toBe(88);
    expect(joined.riskLabel).toBe('High');
    expect(joined.insights).toBe(3);
    expect(joined.insightsList).toEqual([{ title: 'x' }]);
    expect(joined.uptakeSyncedAt).toBeTruthy();
  });

  it('leaves unmatched rows unsynced with a null risk score', () => {
    const out = uptake.mergeUptakeIntoRows(rows, [{ id: '520024', riskScore: 10 }]);
    const unmatched = out.find(r => r.equipmentId === '999999');
    expect(unmatched.uptakeSynced).toBe(false);
    expect(unmatched.riskScore).toBeNull();
  });

  it('keeps ATS as the source of truth for make/model/year (never overwritten by uptake)', () => {
    // Merge rule: model/manufacturer/modelYear use `row.X || m.X` (ATS first);
    // vin uses `m.vin || row.vin` (uptake first). Lock both precedences in.
    const units = [{ id: '520024', riskScore: 50, model: 'UP-Model', manufacturer: 'UP-Make', modelYear: '1999', vin: 'UPVIN' }];
    const out = uptake.mergeUptakeIntoRows(rows, units);
    const joined = out.find(r => r.equipmentId === '520024');
    expect(joined.model).toBe('ATS-Model');          // ATS wins (row.model first)
    expect(joined.manufacturer).toBe('ATS-Make');    // ATS wins
    expect(joined.modelYear).toBe('2020');           // ATS wins
    expect(joined.vin).toBe('UPVIN');                // vin: uptake wins (m.vin first)
  });

  it('fills vin from ATS when uptake has none', () => {
    const units = [{ id: '520024', riskScore: 50 }]; // no vin on the uptake unit
    const out = uptake.mergeUptakeIntoRows(rows, units);
    expect(out.find(r => r.equipmentId === '520024').vin).toBe('ATSVIN');
  });

  it('with no uptake units, marks every row unsynced (no crash)', () => {
    const out = uptake.mergeUptakeIntoRows(rows, []);
    expect(out.every(r => r.uptakeSynced === false)).toBe(true);
    expect(out.length).toBe(2);
  });
});

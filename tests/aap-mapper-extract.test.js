// tests/aap-mapper-extract.test.js — relay-extract mapper-side extraction. FEAT-001 part:
// utils/salesforce-url is a byte-identical move of aap_wo_scraper.buildSalesforceUrl and of
// the inline builder relay.js Phase 3 used (FEAT-003 extends this file with toFleetRow / PM).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const { buildSalesforceUrl } = require('../src/utils/salesforce-url');

// The 1eabe04 aap_wo_scraper.js:75-90 body, verbatim.
function oldScraperBuilder(caseNumber) {
  if (!caseNumber) return '';
  const sfJson = JSON.stringify({
    componentDef: 'forceSearch:searchPageDesktop',
    attributes: {
      term: caseNumber,
      scopeMap: { type: 'TOP_RESULTS' },
      context: { FILTERS: {}, disableIntentQuery: false, disableSpellCorrection: false },
      groupId: 'DEFAULT'
    },
    state: {}
  });
  return 'https://amazonfreightpartner.lightning.force.com/one/one.app#' +
    Buffer.from(sfJson).toString('base64');
}
// The 1eabe04 relay.js:1102-1104 inline builder, verbatim.
function oldRelayInline(caseNumber) {
  const _sfJson = JSON.stringify({"componentDef":"forceSearch:searchPageDesktop","attributes":{"term":caseNumber,"scopeMap":{"type":"TOP_RESULTS"},"context":{"FILTERS":{},"disableIntentQuery":false,"disableSpellCorrection":false},"groupId":"DEFAULT"},"state":{}});
  return 'https://amazonfreightpartner.lightning.force.com/one/one.app#' + Buffer.from(_sfJson).toString('base64');
}

describe('utils/salesforce-url', () => {
  it('equals the old builders on 3 case numbers', () => {
    for (const cn of ['00034630', '00034983', '00176990']) {
      expect(buildSalesforceUrl(cn)).toBe(oldScraperBuilder(cn));
      expect(buildSalesforceUrl(cn)).toBe(oldRelayInline(cn));
    }
  });
  it('empty case number -> empty string', () => {
    expect(buildSalesforceUrl('')).toBe('');
    expect(buildSalesforceUrl(null)).toBe('');
  });
  it('aap_wo_scraper and relay.js delegate to the shared builder', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const scraper = fs.readFileSync(path.join(root, 'src/scrapers/aap_wo_scraper.js'), 'utf8');
    const relay = fs.readFileSync(path.join(root, 'src/scrapers/relay.js'), 'utf8');
    expect(scraper).toContain("require('../utils/salesforce-url').buildSalesforceUrl(caseNumber)");
    expect(relay).toContain("require('../utils/salesforce-url').buildSalesforceUrl(convSalesforce.caseNumber)");
    expect(relay).not.toContain('forceSearch:searchPageDesktop');
  });
});

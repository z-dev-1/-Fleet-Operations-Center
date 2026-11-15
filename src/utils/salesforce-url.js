'use strict';
// utils/salesforce-url.js — pure Salesforce case deep-link builder.
// Moved byte-identical from scrapers/aap_wo_scraper.js so main-process code that
// must not require electron (mapper, relay merge, extractor) can share it.

// Salesforce: build deep-link URL from case number (same logic as relay.js Phase 3)
function buildSalesforceUrl(caseNumber) {
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

module.exports = { buildSalesforceUrl };

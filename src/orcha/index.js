'use strict';
/**
 * orcha/index.js — Orcha Engine Registry [V-C]
 *
 * Central export for all Orcha engine modules.
 * Import from here rather than individual files to keep coupling clean.
 *
 * Usage:
 *   const { relay, context, guardian, orchestrator } = require('./orcha');
 *   const { recordCorrection, suggestVendor }        = require('./orcha').learn;
 */

module.exports = {
  relay:             require('./relay'),
  context:           require('./context'),
  guardian:          require('./guardian'),
  orchestrator:      require('./orchestrator'),
  learn:             require('./learn'),
  priority:          require('./priority'),
  deepScan:          require('./deep-scan'),
  retention:         require('./retention'),
  autoLogin:         require('./auto-login'),
  playwrightBridge:  require('./playwright_bridge'),
  workflowLearn:     require('./workflow-learn'),
};

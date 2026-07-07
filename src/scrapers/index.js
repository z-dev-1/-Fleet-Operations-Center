'use strict';
/**
 * scrapers/index.js — Scraper Registry [V-C]
 *
 * Central export for all scraper modules.
 * Browser-injected scripts (aap_autofill_engine, sp_push_script) are read
 * as raw text by their IPC handlers — they are NOT exported here.
 *
 * Usage:
 *   const { scrapeAAP }          = require('./scrapers').aap;
 *   const { ensureAuthenticated } = require('./scrapers').auth;
 *   const scrapers = require('./scrapers');
 */

module.exports = {
  aap:              require('./aap'),
  auth:             require('./auth'),
  relay:            require('./relay'),
  uptake:           require('./uptake'),
  dailyNotes:       require('./daily_notes'),
  sharepoint:       require('./sharepoint_push'),
  slackSend:        require('./slack_send'),
  emailBuilder:     require('./emailBuilder'),
  emailSender:      require('./email_sender'),
  geofence:         require('./geofence_scraper'),
  setLifecycle:     require('./setLifecycle'),
  orchaWs:          require('./orcha_ws'),
  orchaLearn:       require('./orcha_learn'),
  orchaPriority:    require('./orcha_priority'),
  bedrock:          require('./bedrock'),
  adaptiveScraper:  require('./adaptive_scraper'),
  aapAdaptiveAgent: require('./aap_adaptive_agent'),
  aapCreateWr:      require('./aap_create_wr'),
  pwScraper:        require('./pw_scraper'),
  playwrightAuth:   require('./playwright_auth'),
  // Browser-injected scripts (raw text — loaded via fs.readFileSync in IPC):
  //   aap_autofill_engine.js  — injected by ipc/scrapers.js
  //   sp_push_script.js       — injected by ipc/scrapers.js
};

'use strict';
// Builds sample SOS/EOS report HTML from the redesign fixtures into docs/.
// Usage: node scripts/build-eos-samples.js
// Uses a throwaway data dir so the real emailLastSnapshot is never touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../src/config/paths').setDataDir(fs.mkdtempSync(path.join(os.tmpdir(), 'eos-samples-')));
const store = require('../src/store');
const { buildEmail } = require('../src/scrapers/emailBuilder');
const fx = require('../tests/fixtures/eos-report-fixtures');

const outDir = path.join(__dirname, '..', 'docs');
fs.mkdirSync(outDir, { recursive: true });
const jobs = [['_built_eos_auvte.html', fx.auvte], ['_built_eos_mixed.html', fx.mixed]];
for (const [name, f] of jobs) {
  fx.seedBaseline(store, f);
  const html = buildEmail({
    operator: f.operator, domicile: f.domicile, slot: f.slot, units: f.units, testMode: false,
    relayCache: f.relayCache, notesStore: f.notesStore, emailNote: 'Yard closes early Friday',
  });
  fs.writeFileSync(path.join(outDir, name), html);
  console.log(name, html.length, JSON.stringify(buildEmail._lastSubjectSuffix));
}

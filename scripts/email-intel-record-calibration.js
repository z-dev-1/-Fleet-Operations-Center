#!/usr/bin/env node
'use strict';
/**
 * scripts/email-intel-record-calibration.js — MANUAL, never run in CI (design 3.7; R7.2, F-15, probe P-CALIB).
 *
 * Records live isolated-lane outputs for the SYNTHETIC calibration cases in
 * tests/fixtures/email-intel/calibration/cases.json (no mailbox access, no real mail, no PII).
 * Each output is written to tests/fixtures/email-intel/calibration/recorded/live-<caseId>.json with
 * provenance { recordedBy:'live-lane', model, promptVersion, recordedAt, caseId, rawText }.
 *
 * Fail-closed: if the isolated lane is unusable (relay cannot load, isolatedLaneAvailable() is false,
 * or any call fails), the script exits non-zero WITHOUT writing anything. It only ever calls the
 * isolated (tool-less) lane through email-intel's lane.js; there is no fallback lane.
 *
 * Usage: node scripts/email-intel-record-calibration.js [--only <caseId>]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'tests', 'fixtures', 'email-intel', 'calibration');

async function main(argv) {
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
  let relay;
  try { relay = require(path.join(ROOT, 'src', 'orcha', 'relay')); } catch (e) {
    process.stderr.write('isolated lane unusable: relay could not be loaded (' + (e && e.name) + ')\n');
    return 2;
  }
  if (typeof relay.isolatedLaneAvailable !== 'function' || relay.isolatedLaneAvailable() !== true) {
    process.stderr.write('isolated lane unusable: isolatedLaneAvailable() is false; nothing written\n');
    return 3;
  }
  const lane = require(path.join(ROOT, 'src', 'email-intel', 'understand', 'lane'));
  const cal = require(path.join(ROOT, 'src', 'email-intel', 'understand', 'calibration'));
  const untrusted = require(path.join(ROOT, 'src', 'email-intel', 'untrusted'));
  const C = require(path.join(ROOT, 'src', 'email-intel', 'constants'));
  lane._setRelayForTests(relay);
  const json = JSON.parse(fs.readFileSync(path.join(DIR, 'cases.json'), 'utf8'));
  const set = cal.loadSet(json);
  const cases = set.cases.filter((c) => !only || c.id === only);
  let model = null;
  try { model = typeof relay.getClaudeModel === 'function' ? (relay.getClaudeModel() || null) : null; } catch (_) { model = null; }
  const outputs = [];
  for (const c of cases) {                                     // one call at a time (no parallel AI calls)
    const { prompt } = cal.casePrompt(c, set, untrusted.newNonce());
    const r = await lane.askIsolated(prompt, { trigger: 'manual' });
    if (!r.ok) {
      process.stderr.write('isolated lane unusable: call failed for case ' + c.id + ' (' + r.error + '); nothing written\n');
      return 4;
    }
    outputs.push({ recordedBy: 'live-lane', model, promptVersion: C.PROMPT_VERSION, recordedAt: new Date().toISOString(), caseId: c.id, rawText: r.text });
  }
  fs.mkdirSync(path.join(DIR, 'recorded'), { recursive: true });
  for (const o of outputs) fs.writeFileSync(path.join(DIR, 'recorded', 'live-' + o.caseId + '.json'), JSON.stringify(o, null, 1) + '\n');
  process.stdout.write('recorded ' + outputs.length + ' live-lane outputs\n');
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write('calibration recording failed (' + (e && e.name) + '); nothing written\n');
    process.exitCode = 1;
  });
}

module.exports = { main };

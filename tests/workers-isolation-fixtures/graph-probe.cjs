'use strict';
// Require-graph probe (review M3). Hooks Module._load, requires the target
// given in argv[2] and, for the canonical entry, runs OPS['canonical.buildAll']
// on 3 synthetic rows so canonical_state's lazy requires load too. Prints the
// JSON list of { request, resolved } to stdout.
const Module = require('module');

const records = [];
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  let resolved = null;
  try { resolved = Module._resolveFilename(request, parent, isMain); } catch (_) { /* builtin or missing */ }
  records.push({ request: String(request), resolved: resolved ? String(resolved) : null });
  return origLoad.apply(this, arguments);
};

const target = require('path').resolve(process.argv[2]);
const mod = require(target);
if (mod && mod.OPS && typeof mod.OPS['canonical.buildAll'] === 'function') {
  mod.OPS['canonical.buildAll']({
    rows: [
      { equipmentId: 'P1', lifecycleState: 'Unavailable', issueSummary: 'turbo replacement', offsiteStage: 'ready', offsiteStageSince: '2026-10-29T09:00:00Z', relayConversation: 'driver: unit ready?' },
      { equipmentId: 'P2', lifecycleState: 'Available' },
      { equipmentId: 'P3', lifecycleState: 'Unavailable', offsiteStage: 'repair', offsiteStageDetail: 'Road Test', asistNotes: 'parts on order' },
    ],
    prior: { P1: { equipmentId: 'P1', status: 'in_repair', updatedAt: '2026-10-29T08:00:00Z' } },
  });
}
process.stdout.write(JSON.stringify(records));

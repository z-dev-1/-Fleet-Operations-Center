'use strict';
/**
 * orcha/fas/config.js — Digital FAS configuration (Stage 5/7/12 knobs + modes).
 *
 * Persisted in the `fasConfig` store. New installs/upgrades DEFAULT TO SHADOW
 * mode — the agent researches and drafts but takes NO outbound or mutating
 * action — so broader autonomy is never silently enabled.
 */

const store = require('../../store');

const DEFAULTS = {
  enabled: false,               // master switch for the FAS agent path (off until opted in)
  mode: 'shadow',               // shadow | approval | autonomous
  maxSteps: 6,                  // max research iterations per message
  maxRuntimeMs: 45000,          // hard cap on total agent runtime per message
  maxToolResultChars: 6000,     // cap on a single tool result fed to the model
  dataFreshnessMs: 6 * 60 * 60 * 1000, // fleet data older than this is "stale"
  retry: { maxRetries: 4, baseBackoffMs: 30000, maxBackoffMs: 15 * 60 * 1000 }, // bounded AI retry w/ backoff
  contextBudgetChars: 24000,    // configurable context budget (provider-independent)
  approvedAutomaticActions: [], // action tool names allowed to run automatically in autonomous mode
  approvedLinkDomains: [        // Stage 3 allowlist (used later)
    'aap-na.corp.amazon.com',
    'fleet.uptake.com',
    'amazon.sharepoint.com',
  ],
};

function get() {
  const raw = store.load('fasConfig', null);
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  // Shallow-merge so new default keys appear for existing installs without
  // clobbering user settings.
  return {
    ...DEFAULTS,
    ...raw,
    retry: { ...DEFAULTS.retry, ...(raw.retry || {}) },
    approvedAutomaticActions: raw.approvedAutomaticActions || DEFAULTS.approvedAutomaticActions,
    approvedLinkDomains: raw.approvedLinkDomains || DEFAULTS.approvedLinkDomains,
  };
}

function save(patch) {
  const cur = get();
  const next = { ...cur, ...(patch || {}), updatedAt: new Date().toISOString() };
  // Never allow autonomous mode to be set without the master switch on — and
  // even then, keep the safer default unless explicitly requested.
  if (next.mode && !['shadow', 'approval', 'autonomous'].includes(next.mode)) next.mode = 'shadow';
  store.save('fasConfig', next);
  return next;
}

module.exports = { get, save, DEFAULTS };

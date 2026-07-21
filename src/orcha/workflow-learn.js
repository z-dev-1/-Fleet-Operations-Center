'use strict';
/**
 * orcha/workflow-learn.js -- Workflow Intelligence: Pattern Mining [Phase 8, Phase 2]
 *
 * Sibling to patterns.js, but mines ACTION SEQUENCES tied to a repeated
 * trigger context, not outcome statistics. Example from the original spec:
 * "every time an Engine Misfire occurs on an Amerit asset, I always create a
 * Relay WO + send a partner email + notify Slack + update notes" -- this
 * module is what notices that repetition and turns it into a queryable
 * pattern, without the user tagging anything manually.
 *
 * Does NOT suggest anything to the user (that's Phase 3 / recommend.js) and
 * does NOT execute anything (that's Phase 4 / orchestrator.js). This module
 * only watches and remembers -- exactly the same division of responsibility
 * patterns.js already has relative to recommend.js and orchestrator.js.
 *
 * Trigger point: called from src/ipc/workflow-intel.js's wi:stop-recording
 * handler, right after a new recording is saved. NOT hooked into the fleet
 * sync cycle -- verified via full-repo search that patterns.js's own
 * runPatternLearning() is itself never called anywhere (dormant, same as
 * guardian.js/orchestrator.js were before they got wired in Stage 28), so
 * this module deliberately does not assume that hook exists or fires.
 *
 * See docs/PHASE8_WORKFLOW_INTELLIGENCE_PLAN.md §4 for the full design.
 */

const path   = require('path');
const fs     = require('fs');
const logger = require('../utils/logger')('workflow-learn');
const store  = require('../store');

const MIN_OCCURRENCES  = 3;   // matches the app's own existing "3-unit minimum" convention (Daily Call trends)
const MAX_TRACKED_IDS  = 10;  // cap workflowIds per pattern to keep the store small

// -- Coarse issue-keyword bucketing ------------------------------------------
// Not meant to be exhaustive -- just enough to group "Engine Misfire" type
// recurring situations without requiring the user to tag anything. Falls
// back to the first few words of whatever text was captured if nothing
// matches, so unmatched text still buckets consistently rather than being
// dropped.
const KNOWN_KEYWORDS = [
  'engine misfire', 'engine', 'misfire', 'transmission', 'brake', 'brakes',
  'tire', 'tires', 'electrical', 'battery', 'alternator', 'turbo', 'coolant',
  'oil leak', 'leak', 'suspension', 'axle', 'clutch', 'fuel', 'sensor',
  'exhaust', 'starter', 'radiator', 'belt', 'hose', 'wiring',
];

function _norm(s) {
  return String(s || '').trim().toLowerCase();
}

function _extractKeyword(text) {
  const t = _norm(text);
  if (!t) return '';
  const hit = KNOWN_KEYWORDS.find(k => t.includes(k));
  if (hit) return hit;
  return t.split(/\s+/).slice(0, 3).join(' ').slice(0, 40);
}

/**
 * Builds a grouping signature from a recording's triggerContext. Returns
 * null if there isn't enough signal to group on (fewer than 2 of
 * vendor/component/keyword present) -- weak/empty context is deliberately
 * excluded from mining rather than lumped into a noisy catch-all bucket.
 */
function _buildSignature(triggerContext) {
  const ctx = triggerContext || {};
  const vendor    = _norm(ctx.vendor);
  const component = _norm(ctx.component);
  const keyword   = _extractKeyword(ctx.issueKeyword);

  const parts = [vendor, component, keyword].filter(Boolean);
  if (parts.length < 2) return null;
  return parts.join('|');
}

// -- Step-sequence similarity (Levenshtein over step *types*, not full steps) --
function _stepTypeSequence(steps) {
  return (steps || []).map(s => s.type);
}

function _seqDistance(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function _seqSimilarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - (_seqDistance(a, b) / maxLen);
}

// -- Persistence -----------------------------------------------------------------

function _loadPatterns() {
  return store.load('workflowPatterns', { patterns: [], lastUpdated: null });
}

function _savePatterns(data) {
  data.lastUpdated = new Date().toISOString();
  store.save('workflowPatterns', data);
}

// -- Main entry point --------------------------------------------------------------

/**
 * recordNewWorkflow(recording) -- called once per newly-saved WorkflowRecording.
 * @returns {Object|null} the updated/created pattern entry, or null if the
 *          recording's trigger context was too weak to mine.
 */
function recordNewWorkflow(recording) {
  if (!recording || !Array.isArray(recording.steps)) return null;

  const signature = _buildSignature(recording.triggerContext);
  if (!signature) {
    logger.info(`Recording "${recording.name}" has no usable trigger context -- skipped mining`);
    return null;
  }

  const data = _loadPatterns();
  const now = new Date().toISOString();
  const seq = _stepTypeSequence(recording.steps);

  let pattern = data.patterns.find(p => p.signature === signature);

  if (!pattern) {
    pattern = {
      signature,
      triggerContext: {
        vendor:    _norm(recording.triggerContext.vendor),
        component: _norm(recording.triggerContext.component),
        keyword:   _extractKeyword(recording.triggerContext.issueKeyword),
      },
      workflowIds: [recording.id],
      canonicalSequence: seq,
      occurrences: 1,
      consistency: 1,
      confirmed: false,
      firstSeen: now,
      lastSeen: now,
    };
    data.patterns.push(pattern);
    logger.info(`New pattern candidate: "${signature}" (1st occurrence, workflow "${recording.name}")`);
  } else {
    if (!pattern.workflowIds.includes(recording.id)) {
      pattern.workflowIds.unshift(recording.id);
      if (pattern.workflowIds.length > MAX_TRACKED_IDS) pattern.workflowIds.length = MAX_TRACKED_IDS;
    }
    pattern.occurrences = pattern.workflowIds.length;
    pattern.consistency = _seqSimilarity(pattern.canonicalSequence, seq);
    pattern.lastSeen = now;
    pattern.confirmed = pattern.occurrences >= MIN_OCCURRENCES;

    logger.info(
      `Pattern "${signature}" now ${pattern.occurrences}x (consistency ${Math.round(pattern.consistency * 100)}%)` +
      (pattern.confirmed ? ' -- CONFIRMED (3+ occurrences)' : '')
    );
  }

  _savePatterns(data);
  return pattern;
}

/**
 * getPatternForContext(triggerContext) -- looks up a CONFIRMED pattern
 * matching the given context. Returns null if no confirmed pattern exists.
 *
 * Not called by anything yet -- this is the hook Phase 3 (recommend.js's
 * SUGGEST_WORKFLOW action type) will use to decide whether to proactively
 * suggest a workflow. Exists now, wired later -- same pattern this codebase
 * already used for guardian.js/orchestrator.js before Stage 28 wired them in.
 */
function getPatternForContext(triggerContext) {
  const signature = _buildSignature(triggerContext);
  if (!signature) return null;
  const data = _loadPatterns();
  const pattern = data.patterns.find(p => p.signature === signature && p.confirmed);
  return pattern || null;
}

/**
 * listPatterns() -- all mined patterns (confirmed or not), most recently
 * seen first. Used by future library/insights UI.
 */
function listPatterns() {
  const data = _loadPatterns();
  return data.patterns.slice().sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
}

/**
 * rebuildFromLibrary() -- full re-mine from scratch over every saved
 * recording, oldest first (so occurrence counts/consistency build up the
 * same way they would have live). Useful after bulk import, or if the
 * mining heuristic above changes and needs to re-apply to existing data.
 */
function rebuildFromLibrary() {
  const library = store.load('workflowRecordings', {});
  const recordings = Object.values(library).sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
  );
  _savePatterns({ patterns: [], lastUpdated: null }); // reset
  let mined = 0;
  for (const rec of recordings) {
    if (recordNewWorkflow(rec)) mined++;
  }
  logger.info(`Rebuilt patterns from ${recordings.length} recordings (${mined} had usable trigger context)`);
  return listPatterns();
}

module.exports = { recordNewWorkflow, getPatternForContext, listPatterns, rebuildFromLibrary };

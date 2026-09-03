'use strict';

// Delta sync: only process units whose key fields changed since last sync
function _deltaFilter(newRows, prevRows) {
  if (!prevRows || !prevRows.length) return { changed: newRows, unchanged: [] };
  
  const prevMap = {};
  prevRows.forEach(function(r) { prevMap[r.equipmentId] = r; });
  
  const changed = [];
  const unchanged = [];
  
  newRows.forEach(function(r) {
    const prev = prevMap[r.equipmentId];
    if (!prev) { changed.push(r); return; }
    
    // Check key fields for changes
    const fields = ['lifecycleState', 'lifecycleReason', 'vendor', 'workDuration', 'riskScore', 'etc'];
    const hasChange = fields.some(function(f) { return String(r[f] || '') !== String(prev[f] || ''); });
    
    if (hasChange) changed.push(r);
    else unchanged.push(r);
  });
  
  return { changed, unchanged };
}


/**
 * src/sync/index.js  [Version C]
 *
 * Full sync orchestration: Auth -> AAP -> Uptake + Relay (parallel) -> Merge
 *                          -> Priority -> Orcha Deep Scan -> Bubble notify
 *
 * Differences from V-B sync.js:
 *   - All file I/O goes through store.load / store.save (atomic, consistent)
 *   - P.aapCache replaces inline app.getPath('userData') + manual join
 *   - No inline fs/path/app requires — P.* handles all paths
 *   - Debug appendFileSync probes removed (logger replaces them)
 *   - DEFAULTS.SYNC_INTERVAL_MS consumed by app.js, not duplicated here
 *   - Module paths corrected for V-C layout (../orcha/, ../store, ../config/)
 *
 * ctx (provided by app.js) must expose:
 *   get/set isSyncing       — guard flag
 *   get/set lastData        — last successful payload
 *   getMainWindow()         — BrowserWindow ref
 *   getTray()               — Tray ref (may be null)
 *   getBubbleWin()          — bubble BrowserWindow (may be null)
 *   pushData(payload)       — sends 'fleet:data' to renderer
 *   pushStatus(msg)         — sends 'fleet:status' to renderer
 *   pushError(msg)          — sends 'fleet:error' to renderer
 *   pushBubbleNotification  — sends status-change alerts to bubble
 *   ensureAuthenticated(win)— returns Promise (rejects on cancel)
 *   scrapeAAP()             — returns Promise<{ rows, count, scrapedAt }>
 *   scrapeUptake()          — returns Promise<{ units, count, scrapedAt }>
 *   scrapeRelay(rows, onBatch, cache) — returns Promise<{ results, updatedCache }>
 *   mergeUptakeIntoRows(rows, units)        — returns merged rows
 *   mergeRelayIntoRows(rows, relay, notes)  — returns merged rows
 */

const crypto = require('crypto');
const logger  = require('../utils/logger')('sync');
const { P }   = require('../config/paths');
const store   = require('../store');
const { runOrchaDeepScan } = require('../orcha/deep-scan');
const { prioritizeUnits }  = require('../orcha/priority');

// ---------------------------------------------------------------------------
// Uptake fingerprint — SHA-1 over (id, riskScore, insightsList) so we can
// skip a live scrape when data hasn't changed since last run.
// ---------------------------------------------------------------------------
function _uptakeFingerprintOf(units) {
  if (!Array.isArray(units) || !units.length) return '';
  const items = units
    .map(u => ({
      id:  u.id,
      rs:  u.riskScore,
      ins: (u.insightsList || []).map(i => i.title).sort().join('|'),
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return crypto.createHash('sha1').update(JSON.stringify(items)).digest('hex');
}

function _loadUptakeHash()  { return store.load('uptakeHash', {}); }
function _saveUptakeHash(h) { store.save('uptakeHash', h); }

// ---------------------------------------------------------------------------
// createSyncEngine(ctx) — factory so app.js can inject all shared state
// Returns { runFullSync }
// ---------------------------------------------------------------------------
function createSyncEngine(ctx) {

  // Deep-scan runs asynchronously AFTER the scrape phase sets isSyncing=false, so
  // the isSyncing guard alone does NOT prevent the next sync cycle (5-min timer)
  // from starting a SECOND deep-scan while the first is still running. Observed
  // live: two concurrent deep-scans each spawning AI calls, competing for the
  // 3-worker claude-code pool and stalling everything. This flag serializes deep
  // scans: a new sync is skipped while a deep-scan from a prior cycle is active.
  let _deepScanInProgress = false;

  async function runFullSync() {
    // ── Structured sync result contract (Task #4) ──────────────────────────
    // Every exit path returns this object so the backend scheduler can gate a
    // job on real, honest sync status instead of guessing from side effects.
    // Shape: { ok, startedAt, completedAt, rowCount, syncedAt, dataAgeMs,
    //          sourcesUpdated:[], sourcesFailed:[], usedCache, errors:[] }
    // NOTE: `ok` means the sync ORCHESTRATION completed and produced a usable
    // fleet payload — it does NOT by itself assert freshness. Freshness is a
    // separate gate (src/scheduler/freshness.js) that inspects dataAgeMs,
    // rowCount, sourcesFailed and usedCache. `usedCache:true` is surfaced so a
    // gate can refuse to present cached data as fresh.
    const _result = {
      ok: false,
      startedAt: new Date().toISOString(),
      completedAt: null,
      rowCount: 0,
      syncedAt: null,
      dataAgeMs: null,
      sourcesUpdated: [],
      sourcesFailed: [],
      usedCache: false,
      errors: [],
    };
    const _markUpdated = (s) => { if (!_result.sourcesUpdated.includes(s)) _result.sourcesUpdated.push(s); };
    const _markFailed  = (s, msg) => {
      if (!_result.sourcesFailed.includes(s)) _result.sourcesFailed.push(s);
      if (msg) _result.errors.push({ source: s, message: String(msg).slice(0, 300) });
    };
    const _finish = () => { _result.completedAt = new Date().toISOString(); return _result; };

    if (ctx.isSyncing) {
      ctx.pushStatus('Sync already in progress...');
      _result.errors.push({ source: 'guard', message: 'sync already in progress' });
      // Report the current cached payload's age so a gate has something to judge.
      try {
        const _fd = store.load('fleetData', {});
        if (_fd && _fd.syncedAt) { _result.syncedAt = _fd.syncedAt; _result.rowCount = Array.isArray(_fd.rows) ? _fd.rows.length : 0; _result.dataAgeMs = Date.now() - new Date(_fd.syncedAt).getTime(); _result.usedCache = true; }
      } catch (_) {}
      return _finish();
    }
    if (_deepScanInProgress) {
      logger.info('Skipping sync — deep scan from previous cycle still running');
      ctx.pushStatus('Orcha deep scan still running — skipping this sync cycle');
      _result.errors.push({ source: 'guard', message: 'deep scan from previous cycle still running' });
      try {
        const _fd = store.load('fleetData', {});
        if (_fd && _fd.syncedAt) { _result.syncedAt = _fd.syncedAt; _result.rowCount = Array.isArray(_fd.rows) ? _fd.rows.length : 0; _result.dataAgeMs = Date.now() - new Date(_fd.syncedAt).getTime(); _result.usedCache = true; }
      } catch (_) {}
      return _finish();
    }
    ctx.isSyncing = true;
    logger.info('Starting sync...');

    try {
      // ── Step 1: Auth ────────────────────────────────────────────────────
      ctx.pushStatus('\uD83D\uDD10 Checking authentication...');
      try {
        await ctx.ensureAuthenticated(ctx.getMainWindow());
      } catch (authErr) {
        ctx.pushError('Login cancelled or timed out: ' + authErr.message);
        // S7: fire structured auth-failure for session-expiry codes so the
        // renderer can show the mwinit prompt. User-cancel has no .code.
        const _isSessionErr = authErr.code === 'RELAY_SESSION_INVALID' ||
                              authErr.code === 'MIDWAY_SESSION_INVALID';
        if (_isSessionErr) {
          logger.warn('[Sync] Auth session failure — code:', authErr.code);
          ctx.pushAuthFailure({ code: authErr.code, message: authErr.message });
        }
        ctx.isSyncing = false;
        _markFailed('auth', authErr.message);
        return _finish();
      }

      // ── Step 2: AAP — read from aap_cache.json (populated by main-window scrape)
      // AEA extension blocks hidden BrowserWindow scrapes, so AAP data is always
      // sourced from the cache written by the live main window.
      ctx.pushStatus('\uD83D\uDD04 Reading AAP inventory...');
      let aapResult;
      try {
        const cached = store.load('aapCache', null);
        if (cached && cached.count > 10) {
          aapResult = cached;
          const ageMin = Math.round((Date.now() - new Date(cached.scrapedAt).getTime()) / 60000);
          logger.info(`AAP cache: ${cached.count} units (${ageMin}min old)`);
          // AAP is ALWAYS sourced from the aap_cache written by the live main
          // window (the AEA extension blocks hidden scrapes) — so a populated
          // cache is the normal, expected "updated" source, not a degraded
          // fallback. Only flag usedCache when the cache is stale/empty below.
          _markUpdated('aap');
        } else {
          aapResult = { rows: [], count: 0, scrapedAt: new Date().toISOString() };
          logger.info('AAP cache empty or missing — waiting for main window scrape');
          _markFailed('aap', 'AAP cache empty or missing (' + (cached ? cached.count : 0) + ' units)');
        }

        // Diff against previous state for diagnostics
        if (ctx.lastData && ctx.lastData.rows && aapResult.rows.length > 0) {
          const prev = new Map(ctx.lastData.rows.map(u => [u.equipmentId, u]));
          let changed = 0, added = 0;
          for (const unit of aapResult.rows) {
            const old = prev.get(unit.equipmentId);
            if (!old) { added++; continue; }
            if (old.lifecycleState !== unit.lifecycleState ||
                old.lifecycleReason !== unit.lifecycleReason) {
              changed++;
              logger.info(
                `[Diff] ${unit.equipmentId}: ` +
                `${old.lifecycleState || ''}/${old.lifecycleReason || ''} \u2192 ` +
                `${unit.lifecycleState || ''}/${unit.lifecycleReason || ''}`
              );
            }
          }
          if (changed || added) logger.info(`[Diff] Summary: ${changed} changed, ${added} added`);
        }

        ctx.pushStatus(`AAP: ${aapResult.count} units \u2014 syncing Uptake...`);

        // Progressive push #1 — AAP data live, no Uptake/Relay enrichment yet
        const _notesNow = store.load('notesStore', {});
        const _aapOnly  = ctx.mergeRelayIntoRows(
          ctx.mergeUptakeIntoRows(aapResult.rows, []), {}, _notesNow
        );
        ctx.pushData({
          rows: _aapOnly, count: _aapOnly.length,
          aapScrapedAt: aapResult.scrapedAt,
          uptakeScrapedAt: null, uptakeCount: 0, relayCount: 0,
          syncedAt: new Date().toISOString(), stale: false, partial: 'aap',
        });
        ctx.pushStatus(`\uD83D\uDCCB ${_aapOnly.length} units loaded \u2014 Uptake + Relay syncing...`);

      } catch (aapErr) {
        ctx.pushError('AAP read failed: ' + aapErr.message);
        if (ctx.lastData) ctx.pushData({ ...ctx.lastData, stale: true });
        ctx.isSyncing = false;
        _markFailed('aap', aapErr.message);
        // Report the (now stale) cached payload age so a gate can judge.
        try {
          const _fd = store.load('fleetData', {});
          if (_fd && _fd.syncedAt) { _result.syncedAt = _fd.syncedAt; _result.rowCount = Array.isArray(_fd.rows) ? _fd.rows.length : 0; _result.dataAgeMs = Date.now() - new Date(_fd.syncedAt).getTime(); _result.usedCache = true; }
        } catch (_) {}
        return _finish();
      }

      // ── Steps 3 + 4: Uptake + Relay — parallel ──────────────────────────
      ctx.pushStatus('\u26A1 Syncing Uptake + Relay in parallel...');
      let uptakeResult      = { units: [], count: 0 };
      let relayData         = {};
      let _liveUptakeUnits  = [];
      let _relayPartial     = {};

      // Called on every Relay batch completion — pushes progressive updates
      function onRelayBatch({ results, batchNum }) {
        _relayPartial = results;
        try {
          const _n    = store.load('notesStore', {});
          const _rows = ctx.mergeRelayIntoRows(
            ctx.mergeUptakeIntoRows(aapResult.rows, _liveUptakeUnits), _relayPartial, _n
          );
          ctx.pushData({
            rows: _rows, count: _rows.length,
            aapScrapedAt: aapResult.scrapedAt,
            uptakeScrapedAt: null,
            uptakeCount: _liveUptakeUnits.length,
            relayCount: Object.keys(_relayPartial).length,
            syncedAt: new Date().toISOString(), stale: false,
            partial: 'relay-batch-' + batchNum,
          });
          ctx.pushStatus(
            `\uD83D\uDD27 Relay: ${Object.keys(_relayPartial).length} units detailed (batch ${batchNum})...`
          );
        } catch (e) {
          logger.warn('Relay batch push error:', e.message);
        }
      }

      // Uptake IIFE — skips live scrape when cached data is <1 h old
      const uptakePromise = (function () {
        const _hs  = _loadUptakeHash();
        const _age = _hs.scrapedAt
          ? (Date.now() - new Date(_hs.scrapedAt).getTime())
          : Infinity;
        if (_hs.fingerprint && Array.isArray(_hs.units) && _hs.units.length &&
            _age < 1 * 3600 * 1000) {
          ctx.pushStatus('Uptake: using recent cache (<1h) \u2014 Relay syncing...');
          logger.info(`Uptake: skipping scrape (cached, age=${Math.round(_age / 60000)}min)`);
          _liveUptakeUnits = _hs.units;
          return Promise.resolve({
            units: _hs.units, count: _hs.units.length,
            scrapedAt: _hs.scrapedAt, _fromCache: true,
          });
        }
        return ctx.scrapeUptake().then(res => {
          if (res && Array.isArray(res.units)) {
            _liveUptakeUnits = res.units;
            try {
              const _n    = store.load('notesStore', {});
              const _rows = ctx.mergeRelayIntoRows(
                ctx.mergeUptakeIntoRows(aapResult.rows, _liveUptakeUnits), _relayPartial, _n
              );
              ctx.pushData({
                rows: _rows, count: _rows.length,
                aapScrapedAt: aapResult.scrapedAt,
                uptakeScrapedAt: res.scrapedAt,
                uptakeCount: _liveUptakeUnits.length,
                relayCount: Object.keys(_relayPartial).length,
                syncedAt: new Date().toISOString(), stale: false, partial: 'uptake',
              });
              ctx.pushStatus(
                `\uD83D\uDD0D Uptake: ${_liveUptakeUnits.length} units enriched \u2014 Relay finishing...`
              );
            } catch (e) {
              logger.warn('Uptake mid-push error:', e.message);
            }
          }
          return res;
        });
      })();

      const relayCache = store.load('relayCache', {});
      const [uptakeOutcome, relayOutcome] = await Promise.allSettled([
        uptakePromise,
        ctx.scrapeRelay(aapResult.rows, onRelayBatch, relayCache),
      ]);

      // ── Process Uptake outcome ───────────────────────────────────────────
      if (uptakeOutcome.status === 'fulfilled') {
        uptakeResult = uptakeOutcome.value;
        logger.info(`Uptake: ${uptakeResult.count} units`);
        if (uptakeResult && uptakeResult._fromCache) { _result.usedCache = true; _markUpdated('uptake-cache'); }
        else if (uptakeResult && Array.isArray(uptakeResult.units) && uptakeResult.units.length) _markUpdated('uptake');
        // BUG FIX (2026-07-14): a "fulfilled" outcome with 0 units (e.g. the
        // master-timeout path resolving too early, or a genuinely empty scrape)
        // previously fell straight through to the final merge with an empty
        // array, wiping Uptake enrichment fleet-wide. Fall back to cache here
        // too, matching the rejected-outcome fallback added just below.
        if (!uptakeResult.units || !uptakeResult.units.length) {
          const _cachedUptake2 = _loadUptakeHash();
          if (_cachedUptake2.units && _cachedUptake2.units.length) {
            uptakeResult = { units: _cachedUptake2.units, count: _cachedUptake2.units.length, scrapedAt: _cachedUptake2.scrapedAt, _fromCache: true };
            logger.info(`Uptake returned 0 \u2014 using ${_cachedUptake2.units.length} cached units (age since ${_cachedUptake2.scrapedAt})`);
            _result.usedCache = true; _markFailed('uptake', 'live returned 0 units — used cache');
          } else {
            _markFailed('uptake', 'live returned 0 units, no cache available');
          }
        }
        if (!uptakeResult._fromCache &&
            Array.isArray(uptakeResult.units) && uptakeResult.units.length) {
          const _newFp = _uptakeFingerprintOf(uptakeResult.units);
          const _oldFp = (_loadUptakeHash()).fingerprint || '';
          if (_newFp !== _oldFp) {
            _saveUptakeHash({
              fingerprint: _newFp,
              units:       uptakeResult.units,
              scrapedAt:   uptakeResult.scrapedAt || new Date().toISOString(),
            });
            logger.info('Uptake fingerprint updated');
          } else {
            logger.info('Uptake fingerprint unchanged — no new risks');
          }
        }
      } else {
        logger.warn('Uptake failed (non-fatal):', uptakeOutcome.reason && uptakeOutcome.reason.message);
        _markFailed('uptake', (uptakeOutcome.reason && uptakeOutcome.reason.message) || 'uptake scrape rejected');
        // BUG FIX (2026-07-14): Relay already falls back to its persisted cache
        // on failure (see relayOutcome handling below) -- Uptake had no
        // equivalent, so a failed/timed-out scrape left uptakeResult at its
        // {units:[], count:0} default, and the final merge below would wipe
        // Uptake enrichment for every unit even when a perfectly good cache
        // exists on disk. Fall back to it, same as Relay.
        {
          const _cachedUptake = _loadUptakeHash();
          if (_cachedUptake.units && _cachedUptake.units.length) {
            uptakeResult = { units: _cachedUptake.units, count: _cachedUptake.units.length, scrapedAt: _cachedUptake.scrapedAt, _fromCache: true };
            logger.info(`Uptake failed \u2014 using ${_cachedUptake.units.length} cached units (age since ${_cachedUptake.scrapedAt})`);
            _result.usedCache = true;
          }
        }
      }

      // ── Process Relay outcome ────────────────────────────────────────────
      if (relayOutcome.status === 'fulfilled') {
        const _relayOutcome = relayOutcome.value;
        relayData = _relayOutcome.results || _relayOutcome; // back-compat if shape differs
        if (!relayData || Object.keys(relayData).length === 0) {
          relayData = store.load('relayCache', {});
          logger.info(`Relay returned 0 — using cached (${Object.keys(relayData).length} entries)`);
          _result.usedCache = true; _markFailed('relay', 'live returned 0 entries — used cache');
        } else {
          _markUpdated('relay');
        }
        if (_relayOutcome.updatedCache) store.save('relayCache', _relayOutcome.updatedCache);
        logger.info(`Relay: ${Object.keys(relayData).length} units detailed`);
      } else {
        logger.warn('Relay failed (non-fatal):', relayOutcome.reason && relayOutcome.reason.message);
        relayData = store.load('relayCache', {});
        logger.info(`Using cached relay data (${Object.keys(relayData).length} entries)`);
        _result.usedCache = true; _markFailed('relay', (relayOutcome.reason && relayOutcome.reason.message) || 'relay scrape rejected');
      }

      // ── Step 5: Merge ────────────────────────────────────────────────────
      // Re-read aap_cache in case a main-window rescan completed mid-sync
      const freshCache = store.load('aapCache', null);
      if (freshCache && freshCache.count > 0 &&
          freshCache.scrapedAt !== aapResult.scrapedAt) {
        logger.info(
          `AAP cache refreshed mid-sync ` +
          `(was ${aapResult.count} \u2192 now ${freshCache.count}). Using fresh data.`
        );
        aapResult = freshCache;
      }

      const notesStore  = store.load('notesStore', {});
      let mergedRows    = ctx.mergeUptakeIntoRows(aapResult.rows, uptakeResult.units || []);
      mergedRows        = ctx.mergeRelayIntoRows(mergedRows, relayData, notesStore);

      const uptakeCount = uptakeResult.count || 0;
      let   relayCount  = Object.keys(relayData).length;

      // If relay came back empty, fall back to persisted cache so the panel isn't blank
      if (relayCount === 0) {
        const cachedRelay = store.load('relayCache', {});
        const cachedCount = Object.keys(cachedRelay).length;
        if (cachedCount > 0) {
          relayData  = cachedRelay;
          relayCount = cachedCount;
          logger.info(`Relay live=0 — using ${cachedCount} cached entries`);
          mergedRows = ctx.mergeRelayIntoRows(mergedRows, relayData, store.load('notesStore', {}));
        }
      }

      // Phase 3 reliability fix: merge live relay data ON TOP of cache instead of
      // replacing entirely based on count. Live data is always fresher per-unit;
      // cache fills gaps for units not in the current live scrape.
      // Strategy: cache provides baseline, live results overlay per equipmentId.
      if (relayCount > 0) {
        try {
          const _fullRelay = store.load('relayCache', {});
          const _fCount = Object.keys(_fullRelay).length;
          if (_fCount > relayCount) {
            // Merge: start with cache, overlay live on top (live wins per-unit)
            const merged = Object.assign({}, _fullRelay, relayData);
            relayData  = merged;
            relayCount = Object.keys(merged).length;
            mergedRows = ctx.mergeRelayIntoRows(mergedRows, relayData, store.load('notesStore', {}));
            logger.info('Relay: merged ' + _fCount + ' cached + ' + Object.keys(relayData).length + ' live → ' + relayCount + ' total (live wins per-unit)');
          }
        } catch (_fe) { logger.warn('Relay force-read failed: ' + _fe.message); }
      }

      const payload = {
        rows:            mergedRows,
        count:           mergedRows.length,
        aapScrapedAt:    aapResult.scrapedAt,
        uptakeScrapedAt: uptakeResult.scrapedAt || null,
        uptakeCount,
        relayCount,
        screenshotPath:  uptakeResult.screenshotPath || null,
        syncedAt:        new Date().toISOString(),
        stale:           false,
      };

      ctx.lastData = payload;
      store.save('fleetData', payload);
      ctx.pushData(payload);

      // Populate the structured sync result from the freshly-built payload.
      _result.ok = true;
      _result.rowCount = mergedRows.length;
      _result.syncedAt = payload.syncedAt;
      _result.dataAgeMs = 0; // just synced
      if (!_result.sourcesUpdated.length && !_result.sourcesFailed.length) _markUpdated('aap');

      // Digital FAS: reconcile any pending MOVE_UNIT verifications against the
      // freshly-synced lifecycle state — resolve to done/failed (Part 5), THEN
      // resume any reply transaction that was waiting on that verification —
      // send the truthful reply exactly once or fail it for operator review
      // (Part 7). Both run after fleetData is saved above.
      try {
        const executor = require('../orcha/fas/executor');
        const rec = executor.reconcileVerifyingLifecycle();
        if (rec && (rec.resolved || rec.failed)) logger.info('FAS lifecycle reconcile: ' + rec.resolved + ' confirmed, ' + rec.failed + ' failed');
        const runner = require('../orcha/fas/runner');
        const res = await runner.resumeVerifiedTransactions();
        if (res && (res.resumed || res.failed)) logger.info('FAS txn resume: ' + res.resumed + ' sent, ' + res.failed + ' failed-review');
      } catch (e) { logger.warn('FAS lifecycle reconcile/resume failed: ' + e.message); }

      const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      ctx.pushStatus(
        `\u2705 Live \u00B7 ${mergedRows.length} units \u00B7 ` +
        `${uptakeCount} Uptake \u00B7 ${relayCount} Relay \u00B7 ${t}`
      );
      const tray = ctx.getTray();
      if (tray) tray.setToolTip(`FleetStatus \u00B7 ${mergedRows.length} units \u00B7 synced ${t}`);

      // ── Priority Queue ───────────────────────────────────────────────────
      const priorityResult = prioritizeUnits(mergedRows);
      for (const pu of priorityResult.units) {
        const row = mergedRows.find(r => r.equipmentId === pu.equipmentId);
        if (row) row._priority = pu._priority;
      }
      logger.info(
        `Priority: \uD83D\uDD34${priorityResult.counts.action} action | ` +
        `\uD83D\uDFE1${priorityResult.counts.watch} watch | ` +
        `\uD83D\uDFE2${priorityResult.counts.track} on track`
      );
      logger.info(`Sync complete: ${mergedRows.length} units, ${uptakeCount} Uptake, ${relayCount} Relay`);

      // ── Orcha Deep Scan — non-blocking, non-fatal ────────────────────────
      // Guarded by _deepScanInProgress so the next sync cycle won't launch a
      // second, competing deep-scan while this one is still running.
      _deepScanInProgress = true;
      setTimeout(() => { runOrchaDeepScan(mergedRows, {
        pushData:        ctx.pushData,
        pushStatus:      ctx.pushStatus,
        payload,
        uptakeCount,
        relayCount,
      })
        .catch(e => logger.error('Orcha Deep Scan error (non-fatal):', e.message))
        .finally(() => { _deepScanInProgress = false; }); }, 15000); // Wait 15s for relay extraction to finish

      // ── Bubble notifications — status-change detection ───────────────────
      const prevRows = (ctx.lastData && ctx.lastData._prevRows) || [];
      const prevMap  = {};
      prevRows.forEach(r => { if (r.id) prevMap[r.id] = r; });
      mergedRows.forEach(r => {
        if (!r.id) return;
        const prev = prevMap[r.id];
        if (!prev) return;
        const wasUnavail = /unavailable/i.test(prev.atsState  || prev.lifecycleState || '');
        const isUnavail  = /unavailable/i.test(r.atsState     || r.lifecycleState    || '');
        if (!wasUnavail && isUnavail) {
          ctx.pushBubbleNotification({
            unit: r.id, type: 'unavail',
            message: 'Status changed to UNAVAILABLE' +
              (r.relayStatus ? ' \u2014 ' + r.relayStatus : ''),
            altId: r.altId || '',
          });
        }
        if (wasUnavail && !isUnavail) {
          ctx.pushBubbleNotification({
            unit: r.id, type: 'active',
            message: 'Back ACTIVE \u2014 unit cleared',
            altId: r.altId || '',
          });
        }
        if (r.riskScore >= 80 && (!prev.riskScore || prev.riskScore < 80)) {
          ctx.pushBubbleNotification({
            unit: r.id, type: 'risk',
            message: `Risk score jumped to ${r.riskScore}% \u2014 action needed`,
            altId: r.altId || '',
          });
        }
      });

      // Snapshot minimal prev-row state for next run's diff
      payload._prevRows = mergedRows.map(r => ({
        id:             r.id,
        atsState:       r.atsState,
        lifecycleState: r.lifecycleState,
        riskScore:      r.riskScore,
        relayStatus:    r.relayStatus,
        altId:          r.altId,
      }));

      // Update bubble badge (count of unavailable units)
      const bubbleWin   = ctx.getBubbleWin();
      const unavailNow  = mergedRows.filter(r =>
        /unavailable/i.test(r.atsState || r.lifecycleState || '')
      ).length;
      if (bubbleWin && !bubbleWin.isDestroyed()) {
        bubbleWin.webContents.send('bubble:badge', unavailNow);
      }

    } catch (e) {
      logger.error('Unexpected sync error:', e.message, e.stack);
      ctx.pushError('Sync error: ' + e.message);
      _result.ok = false;
      _result.errors.push({ source: 'sync', message: String(e.message).slice(0, 300) });
      // Surface last known cached payload age so a gate can still judge.
      try {
        const _fd = store.load('fleetData', {});
        if (_fd && _fd.syncedAt && !_result.syncedAt) {
          _result.syncedAt = _fd.syncedAt;
          _result.rowCount = Array.isArray(_fd.rows) ? _fd.rows.length : 0;
          _result.dataAgeMs = Date.now() - new Date(_fd.syncedAt).getTime();
          _result.usedCache = true;
        }
      } catch (_) {}
    } finally {
      ctx.isSyncing = false;
    }
    return _finish();
  }

  return { runFullSync };
}

module.exports = { createSyncEngine };

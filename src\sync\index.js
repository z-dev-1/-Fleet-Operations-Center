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
 *   - No inline fs/path/app requires â€” P.* handles all paths
 *   - Debug appendFileSync probes removed (logger replaces them)
 *   - DEFAULTS.SYNC_INTERVAL_MS consumed by app.js, not duplicated here
 *   - Module paths corrected for V-C layout (../orcha/, ../store, ../config/)
 *
 * ctx (provided by app.js) must expose:
 *   get/set isSyncing       â€” guard flag
 *   get/set lastData        â€” last successful payload
 *   getMainWindow()         â€” BrowserWindow ref
 *   getTray()               â€” Tray ref (may be null)
 *   getBubbleWin()          â€” bubble BrowserWindow (may be null)
 *   pushData(payload)       â€” sends 'fleet:data' to renderer
 *   pushStatus(msg)         â€” sends 'fleet:status' to renderer
 *   pushError(msg)          â€” sends 'fleet:error' to renderer
 *   pushBubbleNotification  â€” sends status-change alerts to bubble
 *   ensureAuthenticated(win)â€” returns Promise (rejects on cancel)
 *   scrapeAAP()             â€” returns Promise<{ rows, count, scrapedAt }>
 *   scrapeUptake()          â€” returns Promise<{ units, count, scrapedAt }>
 *   scrapeRelay(rows, onBatch, cache) â€” returns Promise<{ results, updatedCache }>
 *   mergeUptakeIntoRows(rows, units)        â€” returns merged rows
 *   mergeRelayIntoRows(rows, relay, notes)  â€” returns merged rows
 */

const crypto = require('crypto');
const logger  = require('../utils/logger')('sync');
const { P }   = require('../config/paths');
const store   = require('../store');
const { runOrchaDeepScan } = require('../orcha/deep-scan');
const { prioritizeUnits }  = require('../orcha/priority');

// ---------------------------------------------------------------------------
// Uptake fingerprint â€” SHA-1 over (id, riskScore, insightsList) so we can
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
// createSyncEngine(ctx) â€” factory so app.js can inject all shared state
// Returns { runFullSync }
// ---------------------------------------------------------------------------
function createSyncEngine(ctx) {

  async function runFullSync() {
    if (ctx.isSyncing) {
      ctx.pushStatus('Sync already in progress...');
      return;
    }
    ctx.isSyncing = true;
    logger.info('Starting sync...');

    try {
      // â”€â”€ Step 1: Auth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
          logger.warn('[Sync] Auth session failure â€” code:', authErr.code);
          ctx.pushAuthFailure({ code: authErr.code, message: authErr.message });
        }
        ctx.isSyncing = false;
        return;
      }

      // â”€â”€ Step 2: AAP â€” read from aap_cache.json (populated by main-window scrape)
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
        } else {
          aapResult = { rows: [], count: 0, scrapedAt: new Date().toISOString() };
          logger.info('AAP cache empty or missing â€” waiting for main window scrape');
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

        // Progressive push #1 â€” AAP data live, no Uptake/Relay enrichment yet
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
        return;
      }

      // â”€â”€ Steps 3 + 4: Uptake + Relay â€” parallel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      ctx.pushStatus('\u26A1 Syncing Uptake + Relay in parallel...');
      let uptakeResult      = { units: [], count: 0 };
      let relayData         = {};
      let _liveUptakeUnits  = [];
      let _relayPartial     = {};

      // Called on every Relay batch completion â€” pushes progressive updates
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

      // Uptake IIFE â€” skips live scrape when cached data is <1 h old
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

      // â”€â”€ Process Uptake outcome â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (uptakeOutcome.status === 'fulfilled') {
        uptakeResult = uptakeOutcome.value;
        logger.info(`Uptake: ${uptakeResult.count} units`);
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
            logger.info('Uptake fingerprint unchanged â€” no new risks');
          }
        }
      } else {
        logger.warn('Uptake failed (non-fatal):', uptakeOutcome.reason && uptakeOutcome.reason.message);
      }

      // â”€â”€ Process Relay outcome â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (relayOutcome.status === 'fulfilled') {
        const _relayOutcome = relayOutcome.value;
        relayData = _relayOutcome.results || _relayOutcome; // back-compat if shape differs
        if (!relayData || Object.keys(relayData).length === 0) {
          relayData = store.load('relayCache', {});
          logger.info(`Relay returned 0 â€” using cached (${Object.keys(relayData).length} entries)`);
        }
        if (_relayOutcome.updatedCache) store.save('relayCache', _relayOutcome.updatedCache);
        logger.info(`Relay: ${Object.keys(relayData).length} units detailed`);
      } else {
        logger.warn('Relay failed (non-fatal):', relayOutcome.reason && relayOutcome.reason.message);
        relayData = store.load('relayCache', {});
        logger.info(`Using cached relay data (${Object.keys(relayData).length} entries)`);
      }

      // â”€â”€ Step 5: Merge â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
          logger.info(`Relay live=0 â€” using ${cachedCount} cached entries`);
          try { const _rP = require('../config/paths').P; const _rRaw = require('fs').readFileSync(_rP.relayCache, 'utf8'); relayData = JSON.parse(_rRaw); logger.info('Relay: ' + Object.keys(relayData).length + ' units detailed'); } catch(_re) { logger.warn('Relay cache read failed: ' + _re.message); }
      mergedRows = ctx.mergeRelayIntoRows(mergedRows, relayData, store.load('notesStore', {}));
        }
      }

      // FORCE: Always re-merge from full relay_cache.json (live scrape may be partial)
      try { const _fP = require('../config/paths').P; const _fRaw = require('fs').readFileSync(_fP.relayCache, 'utf8'); const _fullRelay = JSON.parse(_fRaw); const _fCount = Object.keys(_fullRelay).length; if (_fCount > Object.keys(relayData).length) { relayData = _fullRelay; relayCount = _fCount; mergedRows = ctx.mergeRelayIntoRows(mergedRows, relayData, store.load('notesStore', {})); logger.info('Relay: force-merged ' + _fCount + ' from cache (live was ' + relayCount + ')'); } } catch(_fe) { logger.warn('Relay force-read failed: ' + _fe.message); }

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

      const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      ctx.pushStatus(
        `\u2705 Live \u00B7 ${mergedRows.length} units \u00B7 ` +
        `${uptakeCount} Uptake \u00B7 ${relayCount} Relay \u00B7 ${t}`
      );
      const tray = ctx.getTray();
      if (tray) tray.setToolTip(`FleetStatus \u00B7 ${mergedRows.length} units \u00B7 synced ${t}`);

      // â”€â”€ Priority Queue â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

      // â”€â”€ Orcha Deep Scan â€” non-blocking, non-fatal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      setTimeout(() => { runOrchaDeepScan(mergedRows, {
        pushData:        ctx.pushData,
        pushStatus:      ctx.pushStatus,
        payload,
        uptakeCount,
        relayCount,
      }).catch(e => logger.error('Orcha Deep Scan error (non-fatal):', e.message)); }, 15000); // Wait 15s for relay extraction to finish

      // â”€â”€ Bubble notifications â€” status-change detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    } finally {
      ctx.isSyncing = false;
    }
  }

  return { runFullSync };
}

module.exports = { createSyncEngine };

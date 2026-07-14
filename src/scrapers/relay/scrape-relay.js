// Extracted from relay.js
// Function: scrapeRelay
// Length: 2723 chars

async function scrapeRelay(aapRows, onBatchDone, relayCache) {
  // H-3: block duplicate concurrent scrapes
  if (_relayLock) {
    logger.warn('[Relay] scrapeRelay() already in progress ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â aborting duplicate call');
    return { results: {}, updatedCache: relayCache || {}, _skipped: true };
  }
  _relayLock = true;
  try {
  const targets = (aapRows || []).filter(r =>
    r.lifecycleState && r.lifecycleState.toUpperCase() === 'UNAVAILABLE' && r.equipmentId
  );

  logger.info('[Relay] Scraping', targets.length, 'unavailable units... (cache entries:', relayCache ? Object.keys(relayCache).length : 0, ')');

  const results = {};
  const updatedCache = Object.assign({}, relayCache || {});
  const partition = ''; // use default session ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â same as auth.js midway injection
  let skippedFleetNet = 0;
  let cacheHits = 0;

  for (let i = 0; i < targets.length; i += MAX_CONCURRENT) {
    const batch = targets.slice(i, i + MAX_CONCURRENT);
    const batchResults = await Promise.all(
      batch.map(r => withRetry(
        () => scrapeUnitPage(r.equipmentId, partition, relayCache),
        { attempts: 2, backoffMs: 2000, label: `relay:${r.equipmentId}` }
      ).catch(e => { logger.warn('[Relay] scrapeUnitPage exhausted for', r.equipmentId, e.message); return null; }))
    );
    batch.forEach((r, idx) => {
      const res = batchResults[idx];
      if (res && res._skippedFleetNet) {
        skippedFleetNet++;
      } else if (res) {
        results[r.equipmentId] = res;
        // Update cache with fresh result (whether cache hit or full scrape)
        updatedCache[r.equipmentId] = res;
        if (res._cacheHit) cacheHits++;
      }
    });
    const batchNum = Math.floor(i / MAX_CONCURRENT) + 1;
    logger.info('[Relay] Batch', batchNum, 'done -',
      Object.keys(results).length, 'total,', cacheHits, 'cache hits,', skippedFleetNet, 'FleetNet skips');
    // Progressive push after each batch
    if (typeof onBatchDone === 'function') {
      try { onBatchDone({ results: { ...results }, done: false, batchNum }); } catch(_) {}
    }
  }

  logger.info('[Relay] Complete:', Object.keys(results).length, '/', targets.length,
    'units |', cacheHits, 'cache hits |', skippedFleetNet, 'FleetNet skips');
  return { results, updatedCache };
  } finally {
    _relayLock = false;
  }
}

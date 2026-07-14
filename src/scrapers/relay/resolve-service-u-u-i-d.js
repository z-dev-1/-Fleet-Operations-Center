// Extracted from relay.js
// Function: resolveServiceUUID
// Length: 3824 chars

async function resolveServiceUUID(equipmentId, partition) {
  logger.info('[Relay] resolveServiceUUID called for', equipmentId);
  const tabs = [
    garageUrl('Unplanned', equipmentId),
    garageUrl('Planned', equipmentId),
    garageUrl('All', equipmentId),   // fallback: catches WIPs that don't appear under Unplanned/Planned
  ];
  const labels = ['Unplanned', 'Planned', 'All'];

  // States that mean the WR is closed ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â skip these and keep looking for an active one
  const CLOSED_STATES = /^(Completed|Cancelled)$/i;

  for (let t = 0; t < tabs.length; t++) {
    const rows = await scrapeGarageList(tabs[t], equipmentId, partition);
    if (!rows.length) continue;

    // Log all rows so we can see what was considered
    rows.forEach(r => logger.info('[Relay]', equipmentId, '  row:', r.vendor||'?', '|', r.state||'no-state', '|', (r.title||'').slice(0,40)));

    // Prefer an active (non-closed, non-FleetNet) WR first
    const active = rows.find(r => !isFleetNetVendor(r.vendor) && !CLOSED_STATES.test(r.state || ''));
    if (active) {
      logger.info('[Relay]', equipmentId, '->', labels[t], 'ACTIVE UUID:', active.uuid, 'vendor:', active.vendor||'?', 'state:', active.state||'?', 'title:', (active.title||'').slice(0,40));
      return active.uuid;
    }

    // No active WR on this tab ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â try next tab before falling back
    const skipReasons = rows.map(r => `${r.vendor||'?'}/${r.state||'?'}`).join(', ');
    logger.info('[Relay]', equipmentId, '-', labels[t], rows.length, 'rows all closed/FleetNet (', skipReasons, ') ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â trying next tab');
  }

  // No active WR found on any tab ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â fall back to most recent non-FleetNet, non-Cancelled WR
  logger.info('[Relay]', equipmentId, 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â no active WR found, trying fallback (excluding Cancelled/Completed)');
  for (let t = 0; t < tabs.length; t++) {
    const rows = await scrapeGarageList(tabs[t], equipmentId, partition);
    const fallback = rows.find(r => !isFleetNetVendor(r.vendor) && !CLOSED_STATES.test(r.state || ''));
    if (fallback) {
      logger.info('[Relay]', equipmentId, '-> FALLBACK UUID:', fallback.uuid, 'vendor:', fallback.vendor||'?', 'state:', fallback.state||'?');
      return fallback.uuid;
    }
  }

  // Absolute last resort: any non-FleetNet WR (even Cancelled)
  for (let t = 0; t < tabs.length; t++) {
    const rows = await scrapeGarageList(tabs[t], equipmentId, partition);
    const last = rows.find(r => !isFleetNetVendor(r.vendor));
    if (last) {
      logger.info('[Relay]', equipmentId, '-> LAST-RESORT UUID (Cancelled?):', last.uuid, last.state);
      return last.uuid;
    }
  }

  logger.info('[Relay]', equipmentId, 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â no valid WR found on any tab');
  return null;
}

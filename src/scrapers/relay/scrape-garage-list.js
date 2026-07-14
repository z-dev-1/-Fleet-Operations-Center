// Extracted from relay.js
// Function: scrapeGarageList
// Length: 4076 chars

async function scrapeGarageList(url, equipmentId, partition) {
  return new Promise((resolve) => {
    logger.info('[Relay] Garage Promise created for', equipmentId);
    let settled = false;
    let lastUrl = '';
    try {

    const win = new BrowserWindow({
      show:        false,
      skipTaskbar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, partition }
    });

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { win.destroy(); } catch(_) {}
      resolve(result);
    };

    // Master timeout ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â 25s to handle slow Midway redirect chains
    const timer = setTimeout(() => {
      logger.info('[Relay] Garage TIMEOUT 25s for', equipmentId, '| lastUrl:', lastUrl.slice(0, 80));
      done([]);
    }, 25000);

    // Attempt extract ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â called after any page settles on AAP domain
    let _pollCount = 0;
    const tryExtract = async () => {
      if (!win || win.isDestroyed()) return;
      const curUrl = win.webContents.getURL();
      lastUrl = curUrl;

      if (!/aap-na\.corp\.amazon\.com/i.test(curUrl)) {
        // Still on auth/midway ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â keep waiting
        return;
      }

      _pollCount++;
      try {
        const rows = await win.webContents.executeJavaScript(safewrap(GARAGE_LIST_SCRIPT));
        if (Array.isArray(rows) && rows.length > 0) {
          logger.info('[Relay] Garage found', rows.length, 'rows for', equipmentId, 'after', _pollCount, 'polls');
          done(rows);
          return;
        }
      } catch(e) {
        logger.info('[Relay] Garage extract error', equipmentId, e.message);
      }

      if (_pollCount >= 20) {
        // Log what's on the page for debugging
        try {
          const txt = await win.webContents.executeJavaScript('document.body.innerText.slice(0,250)');
          logger.info('[Relay] Garage gave up for', equipmentId, '| page:', String(txt).replace(/\n/g,' ').slice(0,200));
        } catch(_) {}
        done([]);
        return;
      }

      setTimeout(tryExtract, 500);
    };

    // Hook all relevant load events
    win.webContents.on('did-finish-load', () => {
      const u = win.webContents.getURL();
      logger.info('[Relay] Garage did-finish-load', equipmentId, '|', u.slice(0, 80));
      // Give React 1.5s to mount the table, then start polling
      setTimeout(tryExtract, 1500);
    });

    win.webContents.on('did-navigate', (_, navUrl) => {
      logger.info('[Relay] Garage did-navigate', equipmentId, '|', navUrl.slice(0, 80));
    });

    win.webContents.on('did-stop-loading', () => {
      if (win.isDestroyed()) return;
      const u = win.webContents.getURL();
      // Only try if we're on AAP and haven't settled yet
      if (!settled && /aap-na\.corp\.amazon\.com/i.test(u)) {
        setTimeout(tryExtract, 1500);
      }
    });

    win.webContents.on('did-fail-load', (_, code, desc) => {
      if (code !== -3) {
        logger.info('[Relay] Garage did-fail-load', equipmentId, code, desc);
        done([]);
      }
    });

    logger.info('[Relay] Garage loadURL called for', equipmentId, '|', url.slice(0,80));
    logger.info('[Relay] WR page loadURL for', equipmentId, '|', url.slice(0,80));
    win.loadURL(url);
    } catch(promErr) {
      logger.info('[Relay] Garage Promise body error for', equipmentId, promErr.message);
      try { win.destroy(); } catch(_) {}
      resolve([]);
    }
  });
}

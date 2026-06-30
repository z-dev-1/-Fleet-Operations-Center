'use strict';
// ── WR Click-Capture ─────────────────────────────────────────────────────────
// Clicks the WR anchor for each unavailable unit and intercepts the React Router
// navigation to capture the real work-order list URL.
//
// Business rules:
//   Unavailable + reason matches "expired inspection" → click PLANNED column
//   Unavailable + any other reason                   → click UNPLANNED column
//
// Called from _runAAPScrapeLoop after JS_EXTRACT_TABLE.
// Returns { eqId: { url, col } } map.

async function captureWRUrls(win, wrRows, label, logger) {
  if (!wrRows || wrRows.length === 0) return {};
  const urlMap = {};

  logger.info('[' + label + '] WR click-capture start: ' + wrRows.length + ' units');

  for (const wr of wrRows) {
    try {
      const capturedUrl = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          win.webContents.removeListener('will-navigate',        onNav);
          win.webContents.removeListener('did-navigate-in-page', onNavInPage);
          logger.warn('[' + label + '] WR capture timeout eq=' + wr.eqId + ' col=' + wr.colToClick);
          resolve(null);
        }, 2500);

        function onNav(e, url) {
          clearTimeout(timer);
          win.webContents.removeListener('will-navigate',        onNav);
          win.webContents.removeListener('did-navigate-in-page', onNavInPage);
          e.preventDefault();
          resolve(url);
        }

        function onNavInPage(_e, url, isMain) {
          if (!isMain) return;
          clearTimeout(timer);
          win.webContents.removeListener('will-navigate',        onNav);
          win.webContents.removeListener('did-navigate-in-page', onNavInPage);
          win.webContents.goBack();
          resolve(url);
        }

        win.webContents.on('will-navigate',        onNav);
        win.webContents.on('did-navigate-in-page', onNavInPage);

        const clickScript = `(function(){
  var tables = document.querySelectorAll('table');
  var t = null;
  for (var i = 0; i < tables.length; i++) {
    if (tables[i].querySelector('tbody tr')) { t = tables[i]; break; }
  }
  if (!t) return 'no_table';
  var row = t.querySelectorAll('tbody tr')[${wr.rowIdx}];
  if (!row) return 'no_row';
  var cell = row.querySelectorAll('td')[${wr.colIdx}];
  if (!cell) return 'no_cell';
  var a = cell.querySelector('a, button');
  if (!a) return 'no_anchor';
  a.click();
  return 'clicked';
})()`;

        win.webContents.executeJavaScript(clickScript)
          .then(function(r) {
            logger.info('[' + label + '] WR click eq=' + wr.eqId + ' ' + wr.colToClick + ' -> ' + r);
            if (r !== 'clicked') {
              clearTimeout(timer);
              win.webContents.removeListener('will-navigate',        onNav);
              win.webContents.removeListener('did-navigate-in-page', onNavInPage);
              resolve(null);
            }
          })
          .catch(function() {
            clearTimeout(timer);
            win.webContents.removeListener('will-navigate',        onNav);
            win.webContents.removeListener('did-navigate-in-page', onNavInPage);
            resolve(null);
          });
      });

      if (capturedUrl) {
        urlMap[wr.eqId] = { url: capturedUrl, col: wr.colToClick };
        logger.info('[' + label + '] WR URL eq=' + wr.eqId +
          ' (' + wr.colToClick + '): ' + capturedUrl.substring(0, 100));
      }
    } catch (e) {
      logger.warn('[' + label + '] WR capture error eq=' + wr.eqId + ': ' + e.message);
    }

    await new Promise(r => setTimeout(r, 200));
  }

  logger.info('[' + label + '] WR click-capture done: ' + Object.keys(urlMap).length + ' URLs captured');
  return urlMap;
}

module.exports = { captureWRUrls };

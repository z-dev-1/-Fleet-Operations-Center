'use strict';
// ── WR Click-Capture v4 ───────────────────────────────────────────────────────
// AAP WR links are same-page query param changes (?tab=Unplanned&states=...&eqId=...).
// They call replaceState (not pushState) and the URL changes immediately.
// Strategy: snapshot location.href BEFORE click, read it AFTER click (synchronous),
// then restore via replaceState back to the original URL.

function buildCaptureScript(rowIdx, colIdx) {
  return `(function(){
  // Snapshot the current URL
  var before = window.location.href;

  // Find table + cell
  var tables = document.querySelectorAll('table');
  var t = null;
  for (var i = 0; i < tables.length; i++) {
    if (tables[i].querySelector('tbody tr')) { t = tables[i]; break; }
  }
  if (!t) return { ok: false, reason: 'no_table' };

  var row = t.querySelectorAll('tbody tr')[${rowIdx}];
  if (!row) return { ok: false, reason: 'no_row' };

  var cell = row.querySelectorAll('td')[${colIdx}];
  if (!cell) return { ok: false, reason: 'no_cell' };

  var a = cell.querySelector('a, button');
  if (!a) return { ok: false, reason: 'no_anchor' };

  // Click — React Router mutates location synchronously via replaceState
  a.click();

  // Read the URL immediately after click
  var after = window.location.href;

  // Restore to original URL so the fleet table stays visible
  if (after !== before) {
    history.replaceState(history.state, '', before);
  }

  return {
    ok:          true,
    capturedUrl: after !== before ? after : null,
    before:      before,
    after:       after,
  };
})()`;
}

const AAP_BASE = 'https://aap-na.corp.amazon.com';

function resolveUrl(url) {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  return AAP_BASE + (url.startsWith('/') ? url : '/' + url);
}

async function captureWRUrls(win, wrRows, label, logger) {
  if (!wrRows || wrRows.length === 0) return {};
  const urlMap = {};

  logger.info('[' + label + '] WR click-capture v4 start: ' + wrRows.length + ' units');

  for (const wr of wrRows) {
    try {
      const script = buildCaptureScript(wr.rowIdx, wr.colIdx);
      const result = await win.webContents.executeJavaScript(script);

      if (result && result.ok) {
        logger.info('[' + label + '] WR eq=' + wr.eqId +
          ' before=' + (result.before || '').slice(0, 120) +
          ' after='  + (result.after  || '').slice(0, 120));
      }

      if (result && result.ok && result.capturedUrl) {
        const url = resolveUrl(result.capturedUrl);
        urlMap[wr.eqId] = { url, col: wr.colToClick };
        logger.info('[' + label + '] WR URL captured eq=' + wr.eqId +
          ' (' + wr.colToClick + '): ' + url);
      } else if (result && !result.ok) {
        logger.warn('[' + label + '] WR miss eq=' + wr.eqId + ' reason=' + result.reason);
      } else {
        logger.warn('[' + label + '] WR miss eq=' + wr.eqId + ' (before===after, url unchanged)');
      }
    } catch (e) {
      logger.warn('[' + label + '] WR error eq=' + wr.eqId + ': ' + e.message);
    }

    await new Promise(r => setTimeout(r, 150));
  }

  logger.info('[' + label + '] WR click-capture done: ' +
    Object.keys(urlMap).length + '/' + wrRows.length + ' captured');
  return urlMap;
}

module.exports = { captureWRUrls };

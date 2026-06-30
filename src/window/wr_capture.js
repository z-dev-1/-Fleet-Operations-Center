'use strict';
// ── WR Click-Capture v2 ───────────────────────────────────────────────────────
// React Router calls history.pushState() when a link is clicked —
// Electron does NOT fire did-navigate-in-page for pushState.
// Solution: patch history.pushState in the page before clicking,
// capture the URL it was called with, then restore pushState and go back.
//
// Business rules:
//   Unavailable + reason matches "expired inspection" → click PLANNED column
//   Unavailable + any other reason                   → click UNPLANNED column

// Script to inject into the page: patches history.pushState and clicks the anchor.
// Returns { clickResult, capturedUrl } synchronously after the click.
function buildCaptureScript(rowIdx, colIdx) {
  return `(function(){
  // 1. Patch history.pushState to intercept React Router navigation
  var _captured = null;
  var _origPush = history.pushState.bind(history);
  history.pushState = function(state, title, url) {
    _captured = url ? String(url) : null;
    // Don't actually navigate — we only want the URL
    // (React Router will handle its own state; we call orig to keep React happy)
    _origPush(state, title, url);
  };

  // 2. Find the table and cell
  var tables = document.querySelectorAll('table');
  var t = null;
  for (var i = 0; i < tables.length; i++) {
    if (tables[i].querySelector('tbody tr')) { t = tables[i]; break; }
  }
  if (!t) { history.pushState = _origPush; return { ok: false, reason: 'no_table' }; }

  var row = t.querySelectorAll('tbody tr')[${rowIdx}];
  if (!row) { history.pushState = _origPush; return { ok: false, reason: 'no_row' }; }

  var cell = row.querySelectorAll('td')[${colIdx}];
  if (!cell) { history.pushState = _origPush; return { ok: false, reason: 'no_cell' }; }

  var a = cell.querySelector('a, button');
  if (!a) { history.pushState = _origPush; return { ok: false, reason: 'no_anchor' }; }

  // 3. Click — React Router's onClick fires synchronously -> calls history.pushState
  a.click();

  // 4. Restore pushState
  history.pushState = _origPush;

  // 5. If pushState was called, go back to the fleet table
  if (_captured) {
    history.back();
  }

  return { ok: true, capturedUrl: _captured };
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

  logger.info('[' + label + '] WR click-capture start: ' + wrRows.length + ' unavailable units');

  for (const wr of wrRows) {
    try {
      const script = buildCaptureScript(wr.rowIdx, wr.colIdx);
      const result = await win.webContents.executeJavaScript(script);

      if (result && result.ok && result.capturedUrl) {
        const url = resolveUrl(result.capturedUrl);
        urlMap[wr.eqId] = { url, col: wr.colToClick };
        logger.info('[' + label + '] WR URL eq=' + wr.eqId +
          ' (' + wr.colToClick + '): ' + url);
      } else {
        logger.warn('[' + label + '] WR capture miss eq=' + wr.eqId +
          ' reason=' + (result && result.reason || 'no_pushState'));
      }
    } catch (e) {
      logger.warn('[' + label + '] WR capture error eq=' + wr.eqId + ': ' + e.message);
    }

    await new Promise(r => setTimeout(r, 150)); // brief pause between rows
  }

  logger.info('[' + label + '] WR click-capture done: ' +
    Object.keys(urlMap).length + '/' + wrRows.length + ' captured');
  return urlMap;
}

module.exports = { captureWRUrls };

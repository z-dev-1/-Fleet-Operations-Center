'use strict';
// ── WR Click-Capture v5 ───────────────────────────────────────────────────────
// AAP WR links update location.href asynchronously (React Router defers the
// replaceState to a microtask/setTimeout). We must:
//   1. Click the anchor
//   2. Wait a tick for React to flush (Promise.resolve or short setTimeout)
//   3. Read window.location.href
//   4. Restore via replaceState
//
// We do this via executeJavaScript returning a Promise so the async wait
// happens inside the page context.

function buildCaptureScript(rowIdx, colIdx) {
  return `(async function(){
  var before = window.location.href;

  // Find table + cell
  var tables = document.querySelectorAll('table');
  var t = null;
  for (var i = 0; i < tables.length; i++) {
    if (tables[i].querySelector('tbody tr')) { t = tables[i]; break; }
  }
  if (!t) return { ok: false, reason: 'no_table', before: before };

  var row = t.querySelectorAll('tbody tr')[${rowIdx}];
  if (!row) return { ok: false, reason: 'no_row_' + ${rowIdx}, before: before };

  var cell = row.querySelectorAll('td')[${colIdx}];
  if (!cell) return { ok: false, reason: 'no_cell_' + ${colIdx}, before: before };

  var a = cell.querySelector('a, button');
  if (!a) return { ok: false, reason: 'no_anchor', before: before };

  // Click
  a.click();

  // Wait for React Router's async replaceState (microtask + possible rAF)
  await new Promise(function(r){ setTimeout(r, 80); });

  var after = window.location.href;

  // Restore immediately — replaceState is synchronous
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

  logger.info('[' + label + '] WR click-capture v5 start: ' + wrRows.length + ' units');

  for (const wr of wrRows) {
    try {
      const script = buildCaptureScript(wr.rowIdx, wr.colIdx);
      const result = await win.webContents.executeJavaScript(script);

      logger.info('[' + label + '] WR eq=' + wr.eqId +
        ' ok=' + (result && result.ok) +
        ' url=' + (result && result.capturedUrl ? result.capturedUrl.slice(0, 200) : 'null') +
        ' reason=' + (result && result.reason || '-') +
        '\n  before=' + (result && result.before || '').slice(0, 200) +
        '\n  after='  + (result && result.after  || '').slice(0, 200));

      if (result && result.ok && result.capturedUrl) {
        const url = resolveUrl(result.capturedUrl);
        urlMap[wr.eqId] = { url, col: wr.colToClick };
        logger.info('[' + label + '] ✓ WR URL eq=' + wr.eqId +
          ' (' + wr.colToClick + '): ' + url);
      } else if (result && !result.ok) {
        logger.warn('[' + label + '] WR miss eq=' + wr.eqId + ' reason=' + result.reason);
      } else {
        logger.warn('[' + label + '] WR no-change eq=' + wr.eqId);
      }
    } catch (e) {
      logger.warn('[' + label + '] WR error eq=' + wr.eqId + ': ' + e.message);
    }

    await new Promise(r => setTimeout(r, 100));
  }

  logger.info('[' + label + '] WR click-capture done: ' +
    Object.keys(urlMap).length + '/' + wrRows.length + ' captured');
  return urlMap;
}

module.exports = { captureWRUrls };

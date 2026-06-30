'use strict';
// ── WR Click-Capture v3 ───────────────────────────────────────────────────────
// Intercepts ALL history mutation methods + location.href setter before click,
// then reads what changed after a short microtask delay.

function buildCaptureScript(rowIdx, colIdx) {
  return `(function(){
  var _captured = null;
  var _origPush    = history.pushState.bind(history);
  var _origReplace = history.replaceState.bind(history);

  // Intercept pushState
  history.pushState = function(state, title, url) {
    if (url) _captured = String(url);
    _origPush(state, title, url);
  };
  // Intercept replaceState
  history.replaceState = function(state, title, url) {
    if (url) _captured = String(url);
    _origReplace(state, title, url);
  };
  // Intercept location.assign
  var _origAssign = location.assign.bind(location);
  location.assign = function(url) {
    _captured = String(url);
    // Don't actually navigate
  };

  // Snapshot URL before click
  var beforeHref = window.location.href;

  // Find table + cell
  var tables = document.querySelectorAll('table');
  var t = null;
  for (var i = 0; i < tables.length; i++) {
    if (tables[i].querySelector('tbody tr')) { t = tables[i]; break; }
  }
  if (!t) {
    history.pushState = _origPush;
    history.replaceState = _origReplace;
    location.assign = _origAssign;
    return { ok: false, reason: 'no_table' };
  }

  var row = t.querySelectorAll('tbody tr')[${rowIdx}];
  if (!row) {
    history.pushState = _origPush;
    history.replaceState = _origReplace;
    location.assign = _origAssign;
    return { ok: false, reason: 'no_row' };
  }

  var cell = row.querySelectorAll('td')[${colIdx}];
  if (!cell) {
    history.pushState = _origPush;
    history.replaceState = _origReplace;
    location.assign = _origAssign;
    return { ok: false, reason: 'no_cell' };
  }

  var a = cell.querySelector('a, button');
  if (!a) {
    history.pushState = _origPush;
    history.replaceState = _origReplace;
    location.assign = _origAssign;
    return { ok: false, reason: 'no_anchor' };
  }

  // Click — React Router fires onClick synchronously
  a.click();

  // Restore
  history.pushState = _origPush;
  history.replaceState = _origReplace;
  location.assign = _origAssign;

  // Check if URL changed via location.href (some routers just assign href)
  var afterHref = window.location.href;
  if (!_captured && afterHref !== beforeHref) {
    _captured = afterHref;
  }

  // If we navigated, go back
  if (_captured && afterHref !== beforeHref) {
    history.back();
  }

  return {
    ok:         true,
    capturedUrl: _captured,
    beforeHref:  beforeHref.slice(0, 100),
    afterHref:   afterHref.slice(0, 100),
    method:      _captured ? 'intercepted' : 'none'
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

  logger.info('[' + label + '] WR click-capture v3 start: ' + wrRows.length + ' units');

  for (const wr of wrRows) {
    try {
      const script = buildCaptureScript(wr.rowIdx, wr.colIdx);
      const result = await win.webContents.executeJavaScript(script);

      logger.info('[' + label + '] WR capture eq=' + wr.eqId +
        ' ok=' + (result && result.ok) +
        ' method=' + (result && result.method || '?') +
        ' before=' + (result && result.beforeHref || '') +
        ' after=' + (result && result.afterHref || '') +
        ' url=' + (result && result.capturedUrl || 'null'));

      if (result && result.ok && result.capturedUrl) {
        const url = resolveUrl(result.capturedUrl);
        urlMap[wr.eqId] = { url, col: wr.colToClick };
      } else if (result && !result.ok) {
        logger.warn('[' + label + '] WR capture miss eq=' + wr.eqId + ' reason=' + result.reason);
      }
    } catch (e) {
      logger.warn('[' + label + '] WR capture error eq=' + wr.eqId + ': ' + e.message);
    }

    await new Promise(r => setTimeout(r, 200));
  }

  logger.info('[' + label + '] WR click-capture done: ' +
    Object.keys(urlMap).length + '/' + wrRows.length + ' captured');
  return urlMap;
}

module.exports = { captureWRUrls };

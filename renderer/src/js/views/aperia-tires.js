/**
 * aperia-tires.js — "Aperia tires" section in the unit-detail Intel pane.
 *
 * Rendering makes no Aperia call; wiring reads status and auto-loads once when
 * connected (window.aperia.unit, 5-min per-unit cache so re-renders do not
 * re-query; never a sign-in). Signed out, the "Load Aperia tires" button stays;
 * a click always calls window.aperia.unit({ assetId }) and renders the tire table (flags),
 * GPS (outside-US warning, map links) and the unit's open tire issues with
 * their recommended actions. Every value is escaped; links carry
 * data-aperia-ext and open through window.files.openExternal (https only).
 */

const _esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const FLAG_CLASS = {
  'CRITICAL LOW': 'critical',
  'LOW': 'low',
  'HIGH': 'high',
  'STALE': 'stale',
  'NO READING': 'noread',
  'SENSOR FAULT': 'fault',
  'OK': 'ok',
};

/** _httpsUrl(u) -> the URL when it parses as https, else ''. */
function _httpsUrl(u) {
  if (typeof u !== 'string' || !/^https:\/\//i.test(u)) return '';
  try { return new URL(u).protocol === 'https:' ? u : ''; } catch (_) { return ''; }
}

const _num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const _cell = (v) => { const n = _num(v); return n == null ? '\u2014' : String(n); };
const _delta = (v) => { const n = _num(v); return n == null ? '\u2014' : (n > 0 ? '+' + n : String(n)); };

/** aperiaTireSectionHtml(unit) -> '' without an equipmentId, else the section with the Load button. */
export function aperiaTireSectionHtml(unit) {
  const id = String((unit && unit.equipmentId) == null ? '' : unit.equipmentId).trim();
  if (!id) return '';
  return '<div class="dp-section-title">Aperia tires</div>' +
    '<div class="dp-aperia">' +
      '<button type="button" class="dp-aperia-load-btn" data-aperia-load="' + _esc(id) + '">Load Aperia tires</button>' +
      '<div class="dp-aperia-result"></div>' +
    '</div>';
}

/** errorText(code) -> the message shown for a failed lookup. */
export function errorText(code) {
  const c = String(code || '');
  if (c === 'APERIA_SIGNIN_REQUIRED' || c === 'APERIA_SESSION_EXPIRED') {
    return 'Aperia sign-in needed. Sign in from the Aperia pill in the status bar, then press Load again.';
  }
  if (c === 'APERIA_UNIT_NOT_FOUND') return 'This unit is not in Aperia.';
  if (c === 'APERIA_BUSY') return 'An Aperia pull is running. Try again when it finishes.';
  return 'Aperia lookup failed (' + (c || 'unknown') + ').';
}

function _flagHtml(flag) {
  const f = String(flag || '');
  if (!f) return '<span class="dp-aperia-flag dp-aperia-flag--none">no target</span>';
  const cls = FLAG_CLASS[f] || 'none';
  return '<span class="dp-aperia-flag dp-aperia-flag--' + cls + '">' + _esc(f) + '</span>';
}

function _tableHtml(tires) {
  if (!tires.length) return '<div class="dp-empty">No tire sensors in Aperia for this unit.</div>';
  return '<table class="dp-aperia-table"><thead><tr>' +
    '<th>Position</th><th>PSI</th><th>Target</th><th>\u0394</th><th>Temp \u00b0F</th><th>Read (ET)</th><th>Flag</th>' +
    '</tr></thead><tbody>' +
    tires.map((t) => {
      const r = t || {};
      const pos = r.positionName || r.position || '';
      return '<tr class="dp-aperia-row">' +
        '<td>' + _esc(pos) + (r.shortPosition ? ' <span class="dp-aperia-pos">' + _esc(r.shortPosition) + '</span>' : '') + '</td>' +
        '<td>' + _esc(_cell(r.pressure)) + '</td>' +
        '<td>' + _esc(_cell(r.setPoint)) + '</td>' +
        '<td>' + _esc(_delta(r.deltaPsi)) + '</td>' +
        '<td>' + _esc(_cell(r.temperatureF)) + '</td>' +
        '<td>' + _esc(r.readAtEt || '\u2014') + '</td>' +
        '<td>' + _flagHtml(r.flag) + '</td>' +
      '</tr>';
    }).join('') +
    '</tbody></table>';
}

function _gpsHtml(gps, reason) {
  const g = gps && typeof gps === 'object' ? gps : null;
  const lat = g ? _num(g.lat) : null;
  const lng = g ? _num(g.lng) : null;
  if (!g || lat == null || lng == null) {
    const why = reason === 'PLACEHOLDER' ? ' (Aperia reports a placeholder position)' : ' (no position reported)';
    return '<div class="dp-aperia-gps dp-aperia-gps--none">No GPS' + _esc(why) + '</div>';
  }
  const img = _httpsUrl(g.mapImageUrl);
  const maps = _httpsUrl(g.mapsUrl);
  return '<div class="dp-aperia-gps">' +
    'GPS: ' + _esc(lat.toFixed(5) + ', ' + lng.toFixed(5)) + (g.atEt ? ' \u00b7 ' + _esc(g.atEt) : '') +
    (g.outsideUs ? '<div class="dp-aperia-gps-warn">\u26a0 GPS is outside the US. Treat this position as suspect.</div>' : '') +
    '<div class="dp-aperia-links">' +
      (img ? '<a href="#" class="dp-aperia-link" data-aperia-ext="' + _esc(img) + '">Map image \u2197</a> ' : '') +
      (maps ? '<a href="#" class="dp-aperia-link" data-aperia-ext="' + _esc(maps) + '">Google Maps \u2197</a>' : '') +
    '</div>' +
  '</div>';
}

function _issuesHtml(issues) {
  if (!issues.length) return '<div class="dp-aperia-issues dp-empty">No open tire issues.</div>';
  return '<ul class="dp-aperia-issues">' + issues.map((i) => {
    const x = i || {};
    const actions = Array.isArray(x.actions) ? x.actions : [];
    return '<li class="dp-aperia-issue">' +
      '<span class="dp-aperia-sev dp-aperia-sev--' + _esc(String(x.severity || '').toLowerCase()) + '">' + _esc(x.severity || '?') + '</span> ' +
      _esc(x.positionName || x.position || '') + ' \u2013 ' + _esc(String(x.type || '').replace(/_/g, ' ')) +
      (x.resolveBy ? ' \u00b7 resolve ' + _esc(x.resolveBy) : '') +
      (x.createdEt ? ' \u00b7 ' + _esc(x.createdEt) : '') +
      (actions.length ? '<ul class="dp-aperia-actions">' + actions.map((a) => '<li>' + _esc(a) + '</li>').join('') + '</ul>' : '') +
    '</li>';
  }).join('') + '</ul>';
}

/** renderTireResult(result) -> HTML for an aperia.unit() result ({ok, unit} | {ok:false, code}) or a bare unit. */
export function renderTireResult(result) {
  const r = result && typeof result === 'object' ? result : null;
  if (!r) return '<div class="dp-aperia-error">' + _esc(errorText('')) + '</div>';
  if (r.ok === false) return '<div class="dp-aperia-error">' + _esc(errorText(r.code)) + '</div>';
  const u = r.unit && typeof r.unit === 'object' ? r.unit : r;
  const tires = Array.isArray(u.tires) ? u.tires : [];
  const issues = Array.isArray(u.issues) ? u.issues : [];
  const meta = [u.fleetVehicleId, u.domicile, u.group].filter((v) => v != null && v !== '').map(_esc).join(' \u00b7 ');
  return '<div class="dp-aperia-meta">' + meta + '</div>' +
    _tableHtml(tires) + _gpsHtml(u.gps, u.gpsReason) + _issuesHtml(issues);
}

// assetId (upper case) -> { at, result }: an auto-load within AUTO_CACHE_MS re-renders without a call.
const AUTO_CACHE_MS = 5 * 60e3;
const _autoCache = new Map();
const _cacheKey = (id) => String(id || '').toUpperCase();

/** _resetAutoCacheForTests() — clear the per-unit auto-load cache. */
export function _resetAutoCacheForTests() { _autoCache.clear(); }

/**
 * wireAperiaTires(root, unit, deps) -> binds the Load button and the result links once, then reads
 * aperia.status() and, when connected, auto-loads the unit once (5-min cache). Never signs in.
 */
export function wireAperiaTires(root, unit, deps) {
  if (!root || typeof root.querySelector !== 'function') return;
  const btn = root.querySelector('[data-aperia-load]');
  const out = root.querySelector('.dp-aperia-result');
  if (!btn || !out || btn.hasAttribute('data-aperia-bound')) return;
  btn.setAttribute('data-aperia-bound', '1');
  const d = deps || {};
  const win = typeof window !== 'undefined' ? window : {};
  const aperia = () => (d.aperia !== undefined ? d.aperia : win.aperia) || null;
  const files = () => (d.files !== undefined ? d.files : win.files) || null;
  const assetId = String(btn.getAttribute('data-aperia-load') || (unit && unit.equipmentId) || '').trim();

  const key = _cacheKey(assetId);
  const rendered = (html) => { out.innerHTML = html; btn.textContent = 'Refresh Aperia tires'; };

  /** load(force) — one aperia.unit call (force: always; else a fresh cached result renders with no call). */
  function load(force) {
    if (btn.disabled) return;
    const ap = aperia();
    if (!ap || typeof ap.unit !== 'function') {
      out.innerHTML = '<div class="dp-aperia-error">Aperia is not available in this build.</div>';
      return;
    }
    const hit = _autoCache.get(key);
    if (!force && hit && Date.now() - hit.at < AUTO_CACHE_MS) { rendered(renderTireResult(hit.result)); return; }
    btn.disabled = true;
    out.innerHTML = '<div class="dp-empty">Loading Aperia tires\u2026</div>';
    Promise.resolve().then(() => ap.unit({ assetId }))
      .then((r) => {
        if (r && r.ok) _autoCache.set(key, { at: Date.now(), result: r });
        rendered(renderTireResult(r));
      })
      .catch(() => { rendered('<div class="dp-aperia-error">' + _esc(errorText('APERIA_INTERNAL')) + '</div>'); })
      .finally(() => { btn.disabled = false; });
  }

  btn.addEventListener('click', () => load(true));

  // Auto-load once when Aperia is already connected; otherwise the Load button stays as is.
  const ap0 = aperia();
  if (ap0 && typeof ap0.status === 'function') {
    Promise.resolve().then(() => ap0.status())
      .then((s) => { if (s && s.state === 'connected') load(false); })
      .catch(() => {});
  }

  out.addEventListener('click', (e) => {
    const t = e && e.target;
    const a = t && typeof t.closest === 'function' ? t.closest('[data-aperia-ext]') : null;
    if (!a) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    const url = _httpsUrl(a.getAttribute('data-aperia-ext'));
    const f = files();
    if (url && f && typeof f.openExternal === 'function') {
      try { Promise.resolve(f.openExternal(url)).catch(() => {}); } catch (_) {}
    }
  });
}

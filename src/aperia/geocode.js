'use strict';
/**
 * src/aperia/geocode.js — street address for an Aperia GPS point, for the underinflation share message.
 * Wraps the app's existing reverse geocoder, src/scrapers/aap_api.js reverseGeocodeGps (HERE via the AAP
 * map credentials). There is no Google Maps key in the app; swap the backend here if one is added.
 *
 *   reverseGeocode(lat, lng, { timeoutMs = 8000 }, deps) -> Promise<string|null>
 *     null for non-finite, 0,0 or the Aperia placeholder point, a null result, a throw or a timeout.
 *     deps.reverseGeocodeGps replaces the backend (tests).
 *
 * Never throws. Logs { op:'geocode', ok, ms } only — never the coordinates or the address.
 */
const { isPlaceholderGps } = require('./rules');
const log = require('../utils/logger')('aperia');

const DEFAULT_TIMEOUT_MS = 8000;

function _format(r) {
  if (!r || typeof r !== 'object') return null;
  const label = typeof r.locLabel === 'string' ? r.locLabel.trim() : '';
  if (label) return label;
  const tail = (String(r.locState || '') + ' ' + String(r.locZip || '')).trim();
  const s = [r.locStreet, r.locCity, tail].map((x) => String(x || '').trim()).filter(Boolean).join(', ');
  return s || null;
}

async function reverseGeocode(lat, lng, opts, deps) {
  const t0 = Date.now();
  const la = Number(lat);
  const ln = Number(lng);
  if (lat === null || lng === null || !Number.isFinite(la) || !Number.isFinite(ln) || (la === 0 && ln === 0) || isPlaceholderGps(la, ln)) return null;
  const timeoutMs = opts && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  let out = null;
  try {
    const fn = (deps && deps.reverseGeocodeGps) || require('../scrapers/aap_api').reverseGeocodeGps;
    const r = await new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs);
      try { if (t && typeof t.unref === 'function') t.unref(); } catch (_) {}
      Promise.resolve()
        .then(() => fn(la, ln))
        .then((v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } },
          () => { if (!done) { done = true; clearTimeout(t); resolve(null); } });
    });
    out = _format(r);
  } catch (_) { out = null; }
  log.info('[aperia] share', { op: 'geocode', ok: !!out, ms: Date.now() - t0 });
  return out;
}

module.exports = { reverseGeocode, DEFAULT_TIMEOUT_MS, _format };

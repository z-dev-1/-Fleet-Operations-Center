'use strict';
/**
 * vendors/volvo/api.js -- Volvo / ASIST dealer work order (service request)
 * via ASIST's own HTTP endpoints instead of driving the portal UI. (2026-10-28)
 *
 * Mapped live with read-only browser probes (nothing submitted):
 *   1. GET  /fleet/search.json?search_query[...]=...&search_query[query]={unit}
 *        -> { "Fleet Vehicles": { results: [ { id, unit_number?, display_vehicle, ... } ] } }
 *        results[].id is ASIST's internal vehicle_id (NOT the unit number).
 *        Cached per unit in store 'volvoVehicleIds' so the lookup runs once.
 *   2. GET  /shared/vehicles/{vehicle_id}/open_cases -> HTML fragment
 *        "Displaying all N open cases" (duplicate warning only, never blocks).
 *   3. Load /fleet/vehicles/{vehicle_id}/request_service/VASCC1 in the warm
 *        authenticated Decisiv window and READ the live form (CSRF token +
 *        ASIST's prefilled values: primary contact, mileage, defaults). No
 *        clicking, no typing.
 *   4. Operator reviews the exact values in the app's review modal.
 *   5. ONLY after Approve: POST /fleet/service_requests ONCE (never retried,
 *        so a slow reply can't create a duplicate SR).
 *   6. Read the new SR number from the reply, write the Relay note.
 *
 * Operator-chosen values (2026-10-28):
 *   dealer            VASCC1 (all Volvo requests go there)
 *   service advisor   35970 "**EMS Case Update*"
 *   ck16 priority     1 - Scheduled
 *   ck14 reason       01 - Breakdown
 *   ck17 repair site  blank
 *   ck82 complaint    AI picks the best fit (one or several) from ASIST's list
 *   Complaint = Notes = attachment Description = the Dealer WO "Issue Details"
 *     text (FAS pickup block ending "Please assign unit to <dealer> <addr> for
 *     [Mobile ]service")
 *   Breakdown City/State/Location = the unit's domicile (Contact Book)
 *   Auth Number       the AMZ dealer-tracking number (altId; editable on review)
 *   Requested Appointment Time = when the WO is created (format read off the
 *     live input)
 *   File              Uptake screenshots (auto) + user files. ASIST's form has
 *     ONE file field: several images are combined into one PDF unless the
 *     field accepts multiple files.
 *
 * The old portal-driving flow (index.js) stays as a fallback: set
 * VOLVO_PORTAL_FLOW=1 to use it instead.
 */

const logger = require('../../utils/logger')('volvo-api');

const ORIGIN       = 'https://volvopg.asist.decisiv.net';
const DEALER_CODE  = 'VASCC1';
const FIELD = {
  dealer:      'service_request[to_dealer_id]',
  vehicle:     'service_request[vehicle_id]',
  advisor:     'service_request[to_user_id]',
  complaint:   'service_request[complaint]',
  note:        'service_request[initial_note]',
  city:        'service_request[breakdown_city]',
  state:       'service_request[breakdown_state]',
  priority:    'service_request[vmrs_ck16_code]',
  site:        'service_request[vmrs_ck17_code]',
  reason:      'service_request[vmrs_ck14_code]',
  ck82:        'service_request[vmrs_ck82_codes][]',
  mileage:     'service_request[vehicle_mileage]',
  mainUser:    'new_case_main_user_id',
  location:    'service_request[breakdown_location]',
  auth:        'service_request[auth_number]',
  appt:        'service_request[customer_requested_appointment_time]',
  reqTime:     'service_request[customer_requested_time]',
  fileDesc:    'service_request[download][description]',
  file:        'service_request[download][attachment]',
};
const MAX_ATTACH_BYTES = 20 * 1024 * 1024; // keep the request a sane size
const DEFAULTS = {
  advisor:  { value: '35970', label: '**EMS Case Update*' },
  priority: { value: '1',     label: '1 - Scheduled' },
  reason:   { value: '01',    label: '01 - Breakdown' },
  site:     { value: '',      label: '(blank)' },
};
const MAX_CK82        = 3;
const AI_TIMEOUT_MS   = 60_000;
const FORM_LOAD_MS    = 30_000;
const FORM_SETTLE_MS  = 2_500;
const FORM_READY_MS   = 8_000;

// ─── Pure helpers (unit-tested) ────────────────────────────────────────────────

function searchPath(unitNumber) {
  return '/fleet/search.json?search_query%5Bfield%5D=unit_number'
    + '&search_query%5Bmodel%5D=vehicle'
    + '&search_query%5Boptions%5D%5Binclude_external%5D=true'
    + '&search_query%5Bquery%5D=' + encodeURIComponent(String(unitNumber));
}

function formPath(vehicleId) {
  return '/fleet/vehicles/' + encodeURIComponent(String(vehicleId)) + '/request_service/' + DEALER_CODE;
}

/**
 * pickVehicle(json, unitNumber) -> { vehicleId, display } or throws.
 * Exact unit-number match wins; a single result is accepted; several
 * non-matching results are refused (never guess the truck).
 */
function pickVehicle(json, unitNumber) {
  const block = json && (json['Fleet Vehicles'] || json.fleet_vehicles || json.vehicles);
  const results = (block && Array.isArray(block.results)) ? block.results : [];
  if (!results.length) {
    throw Object.assign(new Error('Unit ' + unitNumber + ' was not found in Volvo ASIST'), { code: 'VOLVO_VEHICLE_NOT_FOUND' });
  }
  const want = String(unitNumber).trim().toUpperCase();
  const unitOf = (r) => String(r.unit_number || r.unitNumber || r.unit || '').trim().toUpperCase();
  const exact = results.filter(r => unitOf(r) === want);
  const chosen = exact.length === 1 ? exact[0] : (results.length === 1 ? results[0] : null);
  if (!chosen || chosen.id == null) {
    throw Object.assign(new Error('Unit ' + unitNumber + ' matched ' + results.length + ' vehicles in Volvo ASIST; not guessing which one'), { code: 'VOLVO_VEHICLE_AMBIGUOUS' });
  }
  return { vehicleId: String(chosen.id), display: String(chosen.display_vehicle || '').trim() };
}

/** parseOpenCases(html) -> number of open cases (0 when none / unreadable). */
function parseOpenCases(html) {
  const s = String(html || '');
  const m = s.match(/Displaying\s*(?:<b>)?\s*(?:all\s*)?(\d+)/i) || s.match(/(\d+)\s*(?:<\/b>)?\s*open\s+cases?/i);
  return m ? parseInt(m[1], 10) : 0;
}

/** parseCityState('Fontana, CA') -> { city:'Fontana', state:'CA' } */
function parseCityState(s) {
  const raw = String(s || '').trim();
  if (!raw) return { city: '', state: '' };
  const parts = raw.split(',').map(x => x.trim()).filter(Boolean);
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  const st = (last.match(/^([A-Za-z]{2})\b/) || [])[1];
  if (st) return { city: parts.slice(0, -1).join(', '), state: st.toUpperCase() };
  return { city: raw, state: '' };
}

const _p2 = (n) => String(n).padStart(2, '0');

/**
 * formatTime(date, info) -> the WO-creation time in the format the ASIST
 * input expects. `info` is what READ_FORM_SCRIPT saw on the live input
 * (type / placeholder / data-* format hints). Default = MM/DD/YYYY hh:mm AM.
 */
function formatTime(date, info) {
  const d = date instanceof Date ? date : new Date(date);
  const Y = d.getFullYear(), M = _p2(d.getMonth() + 1), D = _p2(d.getDate());
  const H = d.getHours(), m = _p2(d.getMinutes());
  const h12 = _p2(((H + 11) % 12) + 1), ap = H < 12 ? 'AM' : 'PM';
  const t = String((info && info.type) || '').toLowerCase();
  if (t === 'datetime-local') return Y + '-' + M + '-' + D + 'T' + _p2(H) + ':' + m;
  if (t === 'date') return Y + '-' + M + '-' + D;
  if (t === 'time') return _p2(H) + ':' + m;
  const hint = [info && info.placeholder, ...Object.values((info && info.data) || {})].filter(Boolean).join(' ');
  if (/\byyyy-mm-dd/i.test(hint)) return Y + '-' + M + '-' + D + (/hh?:mm|HH/i.test(hint) ? ' ' + _p2(H) + ':' + m : '');
  if (/dd\/mm\/yyyy/i.test(hint) && !/mm\/dd/i.test(hint)) return D + '/' + M + '/' + Y + ' ' + h12 + ':' + m + ' ' + ap;
  return M + '/' + D + '/' + Y + ' ' + h12 + ':' + m + ' ' + ap;
}

/** dataUrl -> { name, mime, b64, bytes } (null if not a base64 data URL) */
function parseDataUrl(name, dataUrl) {
  const m = String(dataUrl || '').match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/);
  if (!m) return null;
  const b64 = m[2];
  const bytes = Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
  return { name: String(name || 'attachment'), mime: m[1] || 'application/octet-stream', b64, bytes };
}

/**
 * planAttachments(list, fileInfo) -> { send:[{name,mime,b64}], mergeImages:[...], dropped:[names], note }
 * ASIST's form has ONE file field. If it accepts several (multiple), send all.
 * Otherwise: one file goes as-is; several images get merged into one PDF;
 * extra non-image files that can't be merged are listed as dropped.
 */
function planAttachments(list, fileInfo) {
  const parsed = (list || []).map(a => parseDataUrl(a && a.name, a && a.dataUrl)).filter(Boolean);
  const dropped = [];
  let total = 0;
  const kept = [];
  for (const p of parsed) {
    if (total + p.bytes > MAX_ATTACH_BYTES) { dropped.push(p.name + ' (too large)'); continue; }
    total += p.bytes; kept.push(p);
  }
  if (!kept.length) return { send: [], mergeImages: [], dropped, note: '' };
  if (!fileInfo) return { send: [], mergeImages: [], dropped: dropped.concat(kept.map(k => k.name + ' (ASIST form has no file field)')), note: '' };
  if (fileInfo.multiple || kept.length === 1) return { send: kept, mergeImages: [], dropped, note: '' };
  const images = kept.filter(k => /^image\//i.test(k.mime));
  const others = kept.filter(k => !/^image\//i.test(k.mime));
  if (images.length >= 2 || (images.length && others.length === 0)) {
    return { send: [], mergeImages: images, dropped: dropped.concat(others.map(o => o.name + ' (only one file per request; images were combined into a PDF)')),
      note: images.length + ' images combined into one PDF (ASIST takes one file per request)' };
  }
  // one image + PDFs, or several PDFs: send the first, list the rest
  return { send: [kept[0]], mergeImages: [], dropped: dropped.concat(kept.slice(1).map(k => k.name + ' (ASIST takes one file per request)')), note: '' };
}

/** Replace every occurrence of `name` with a single [name, value] entry. */
function setField(entries, name, value) {
  const out = [];
  let placed = false;
  for (const [k, v] of entries) {
    if (k !== name) { out.push([k, v]); continue; }
    if (!placed) { out.push([k, value]); placed = true; }
  }
  if (!placed) out.push([name, value]);
  return out;
}

/** Replace all occurrences of a multi-value field with `values`. */
function setMulti(entries, name, values) {
  const add = (values || []).map(v => [name, v]);
  const out = [];
  let inserted = false;
  for (const [k, v] of entries) {
    if (k === name) { if (!inserted) { out.push(...add); inserted = true; } continue; }
    out.push([k, v]);
  }
  if (!inserted) out.push(...add);
  return out;
}

function getField(entries, name) {
  const e = entries.find(([k]) => k === name);
  return e ? e[1] : '';
}

/**
 * buildPayload(liveEntries, input) -> entries ready to POST.
 * Starts from what ASIST itself prefilled (token, primary contact, mileage,
 * hidden fields) and overrides only what we own.
 */
function buildPayload(liveEntries, input) {
  let e = (liveEntries || []).filter(p => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string');
  e = setField(e, FIELD.dealer, DEALER_CODE);
  e = setField(e, FIELD.vehicle, String(input.vehicleId));
  e = setField(e, FIELD.advisor, DEFAULTS.advisor.value);
  e = setField(e, FIELD.priority, DEFAULTS.priority.value);
  e = setField(e, FIELD.reason, DEFAULTS.reason.value);
  e = setField(e, FIELD.site, DEFAULTS.site.value);
  e = setField(e, FIELD.complaint, String(input.complaint || ''));
  if (input.note) e = setField(e, FIELD.note, String(input.note));
  if (input.city) e = setField(e, FIELD.city, String(input.city));
  if (input.state) e = setField(e, FIELD.state, String(input.state));
  if (input.location) e = setField(e, FIELD.location, String(input.location));
  if (input.authNumber) e = setField(e, FIELD.auth, String(input.authNumber));
  if (input.apptTime) e = setField(e, FIELD.appt, String(input.apptTime));
  if (input.reqTime) e = setField(e, FIELD.reqTime, String(input.reqTime));
  if (input.hasFile) e = setField(e, FIELD.fileDesc, String(input.complaint || ''));
  if (Array.isArray(input.ck82) && input.ck82.length) e = setMulti(e, FIELD.ck82, input.ck82);
  if (input.commit && input.commit[0] && !e.some(([k]) => k === input.commit[0])) e.push([input.commit[0], input.commit[1] || '']);
  return e;
}

/** Human-readable lines for the review modal (exactly what will be sent). */
function buildPreview(entries, ctx) {
  const labelOf = (code) => {
    const o = (ctx.ck82Options || []).find(([v]) => v === code);
    return o ? o[1] : code;
  };
  const codes = entries.filter(([k]) => k === FIELD.ck82).map(([, v]) => labelOf(v));
  const complaint = getField(entries, FIELD.complaint);
  const lines = [
    'Vehicle: ' + (ctx.display ? ctx.display + ' ' : '') + '(ASIST id ' + getField(entries, FIELD.vehicle) + ')',
    'Dealer: ' + DEALER_CODE,
    'Service advisor: ' + DEFAULTS.advisor.label,
    'Priority: ' + DEFAULTS.priority.label,
    'Reason: ' + DEFAULTS.reason.label,
    'Repair site: ' + DEFAULTS.site.label,
    'Complaint codes: ' + (codes.length ? codes.join('; ') : '(none)') + (ctx.ck82Source === 'ai' ? '  [AI picked]' : ctx.ck82Source === 'default' ? '  [ASIST default - AI could not pick; cancel if wrong]' : ''),
    'Breakdown: ' + ([getField(entries, FIELD.city), getField(entries, FIELD.state)].filter(Boolean).join(', ') || '(blank)'),
    'Mileage: ' + (getField(entries, FIELD.mileage) || '(blank)'),
    'Primary contact: ' + (getField(entries, FIELD.mainUser) ? 'you (ASIST prefilled)' : '(none - ASIST did not prefill)'),
  ];
  lines.push('Breakdown Location: ' + (getField(entries, FIELD.location) || '(blank)'));
  lines.push('Requested Appointment Time: ' + (getField(entries, FIELD.appt) || '(blank)')
    + (getField(entries, FIELD.reqTime) ? ' / ' + getField(entries, FIELD.reqTime) : ''));
  lines.push('Auth Number: ' + (getField(entries, FIELD.auth) || '(blank - no AMZ number yet)'));
  const att = ctx.attach || { send: [], mergeImages: [], dropped: [] };
  const files = att.send.map(f => f.name).concat(att.mergeImages.length ? ['attachments.pdf (' + att.mergeImages.map(f => f.name).join(', ') + ')'] : []);
  lines.push('File: ' + (files.length ? files.join('; ') : '(none)') + (att.note ? '  [' + att.note + ']' : ''));
  if (att.dropped && att.dropped.length) lines.push('NOT attached: ' + att.dropped.join('; '));
  const note = getField(entries, FIELD.note);
  lines.push('Complaint / Notes' + (files.length ? ' / Description' : '') + (note && note !== complaint ? ' (Notes differ)' : '') + ':');
  lines.push(complaint.length > 1200 ? complaint.slice(0, 1200) + '...' : complaint);
  return lines;
}

/**
 * parseSubmitResult(r) -> { outcome:'created'|'rejected'|'unconfirmed', srNumber, srUrl, detail }
 * r = { status, url, title, flash, snippet }
 */
function parseSubmitResult(r) {
  r = r || {};
  const url = String(r.url || '');
  const text = String(r.snippet || '') + ' ' + String(r.title || '') + ' ' + String(r.flash || '');
  const detail = [r.status && ('HTTP ' + r.status), r.flash, r.error].filter(Boolean).join(' | ');
  if (!r.status || r.status < 200 || r.status >= 400) {
    // 4xx = ASIST refused the form; 5xx/0 = unknown whether it was created.
    const outcome = (r.status >= 400 && r.status < 500) ? 'rejected' : 'unconfirmed';
    return { outcome, srNumber: '', srUrl: url, detail: detail || 'no response' };
  }
  const looksLikeError = /error|can't be blank|can.t be blank|prohibited|invalid|required|must be/i.test(String(r.flash || ''));
  const fromUrl = url.match(/\/(?:service_requests|estimates|cases)\/(\d{5,})/i);
  if (fromUrl && !/request_service/i.test(url)) return { outcome: 'created', srNumber: fromUrl[1], srUrl: url, detail };
  if (/\/request_service\//i.test(url)) {
    // ASIST re-rendered the form = validation failed, nothing created.
    return { outcome: 'rejected', srNumber: '', srUrl: url, detail: detail || 'ASIST returned the form again (validation error)' };
  }
  if (!r.redirected) {
    // Rails renders the form again at the POST url when validation fails; a
    // successful create redirects. No redirect + error text = rejected; no
    // redirect without an error = unknown (never guess "created").
    return { outcome: looksLikeError ? 'rejected' : 'unconfirmed', srNumber: '', srUrl: url, detail: detail || 'no redirect after submit' };
  }
  const fromText = text.match(/(?:Case|Service\s*Request|SR)\s*#\s*:?\s*(\d{6,10})/i);
  if (fromText) return { outcome: 'created', srNumber: fromText[1], srUrl: url, detail };
  return { outcome: 'unconfirmed', srNumber: '', srUrl: url, detail: detail || 'no SR number in reply' };
}

function buildCk82Prompt(complaint, options) {
  return [
    'Choose VMRS complaint codes (code key 82) for a Volvo dealer service request.',
    'Complaint:',
    '"""', String(complaint || '').slice(0, 1500), '"""',
    '',
    'Allowed codes (pick ONLY from this list):',
    options.map(([v, t]) => t || v).join('\n'),
    '',
    'Pick the code that best fits. Add a 2nd or 3rd code ONLY if the complaint clearly describes separate symptoms.',
    'Reply with JSON only, e.g. {"codes":["021"]}',
  ].join('\n');
}

/** parseCk82Reply(text, options) -> valid codes (max 3), [] if none usable. */
function parseCk82Reply(text, options) {
  const allowed = new Set((options || []).map(([v]) => v));
  let codes = [];
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (m) { try { const j = JSON.parse(m[0]); if (Array.isArray(j.codes)) codes = j.codes.map(c => String(c).trim()); } catch (_) {} }
  const seen = new Set();
  return codes.map(c => c.split(/\s|-/)[0]).filter(c => allowed.has(c) && !seen.has(c) && seen.add(c)).slice(0, MAX_CK82);
}

// ─── Cache ────────────────────────────────────────────────────────────────────

function _cacheGet(unitNumber) {
  try { const all = require('../../store').load('volvoVehicleIds', {}) || {}; return all[String(unitNumber)] || null; }
  catch (_) { return null; }
}
function _cacheSet(unitNumber, rec) {
  try {
    const store = require('../../store');
    const all = store.load('volvoVehicleIds', {}) || {};
    if (rec) all[String(unitNumber)] = rec; else delete all[String(unitNumber)];
    store.save('volvoVehicleIds', all);
  } catch (e) { logger.warn('[volvo-api] cache save failed: ' + e.message); }
}

// ─── In-page scripts (run inside the authenticated Decisiv window) ───────────

const READ_FORM_SCRIPT = `(function () {
  try {
    var form = Array.prototype.find.call(document.forms, function (f) {
      return /\\/fleet\\/service_requests\\/?$/.test(f.getAttribute('action') || '');
    });
    if (!form) return { ok: false, url: location.href, title: document.title || '' };
    var entries = [];
    new FormData(form).forEach(function (v, k) { if (typeof v === 'string') entries.push([k, v]); });
    var commit = form.querySelector('input[type=submit][name=commit], button[name=commit]');
    var sel = form.querySelector('select[name="service_request[vmrs_ck82_codes][]"]');
    var ck82 = sel ? Array.prototype.map.call(sel.options, function (o) { return [o.value, (o.text || '').trim()]; })
      .filter(function (x) { return x[0]; }) : [];
    var meta = document.querySelector('meta[name="csrf-token"]');
    var mainUser = form.querySelector('[name="new_case_main_user_id"]');
    // Describe an input so the app can format values the way ASIST expects.
    function info(name) {
      var el = form.querySelector('[name="' + name + '"]');
      if (!el) return null;
      var data = {};
      for (var i = 0; i < el.attributes.length; i++) {
        var a = el.attributes[i];
        if (/^data-/.test(a.name)) data[a.name] = String(a.value).slice(0, 80);
      }
      return { tag: el.tagName.toLowerCase(), type: el.type || '', placeholder: el.getAttribute('placeholder') || '',
        className: String(el.className || '').slice(0, 120), value: el.value || '', data: data, multiple: !!el.multiple,
        accept: el.getAttribute('accept') || '' };
    }
    var fileEl = form.querySelector('input[type=file]');
    return { ok: true, url: location.href, entries: entries, ck82: ck82,
      commit: commit ? [commit.name, commit.value || ''] : null,
      token: meta ? meta.content : '', mainUser: mainUser ? mainUser.value : '',
      enctype: form.getAttribute('enctype') || '',
      apptInfo: info('service_request[customer_requested_appointment_time]'),
      timeInfo: info('service_request[customer_requested_time]'),
      fileInfo: fileEl ? { name: fileEl.name, multiple: !!fileEl.multiple, accept: fileEl.getAttribute('accept') || '' } : null };
  } catch (e) { return { ok: false, url: location.href, error: String(e && e.message || e) }; }
})()`;

function _openCasesScript(vehicleId) {
  return `(async function () {
    try {
      var r = await fetch(${JSON.stringify('/shared/vehicles/' + encodeURIComponent(vehicleId) + '/open_cases')},
        { credentials: 'include', headers: { 'Accept': 'text/html', 'X-Requested-With': 'XMLHttpRequest' } });
      return { status: r.status, html: (await r.text()).slice(0, 4000) };
    } catch (e) { return { status: 0, html: '', error: String(e && e.message || e) }; }
  })()`;
}

function _postScript(entries, token, files, fileField) {
  return `(async function () {
    try {
      var E = ${JSON.stringify(entries)};
      var F = ${JSON.stringify((files || []).map(f => ({ name: f.name, mime: f.mime, b64: f.b64 })))};
      var fd = new FormData();
      E.forEach(function (p) { fd.append(p[0], p[1]); });
      F.forEach(function (f) {
        var bin = atob(f.b64), u8 = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        fd.append(${JSON.stringify(fileField || FIELD.file)}, new File([u8], f.name, { type: f.mime }));
      });
      var r = await fetch('/fleet/service_requests', {
        method: 'POST', credentials: 'include', body: fd,
        headers: { 'X-CSRF-Token': ${JSON.stringify(token || '')}, 'Accept': 'text/html,application/xhtml+xml' }
      });
      var t = await r.text();
      var doc = new DOMParser().parseFromString(t, 'text/html');
      var f = doc.querySelector('.flash, .alert, .notice, #flash, #flash_messages, .error_messages, #errorExplanation, .errorExplanation');
      return { status: r.status, url: r.url, redirected: r.redirected, title: doc.title || '',
        flash: f ? f.textContent.replace(/\\s+/g, ' ').trim().slice(0, 400) : '',
        snippet: t.replace(/\\s+/g, ' ').slice(0, 2000) };
    } catch (e) { return { status: 0, error: String(e && e.message || e) }; }
  })()`;
}

function _isLoginUrl(u) { return /\/login\b|\/sign[_-]?in\b|\/authentication\/|midway-auth|\/SSO\//i.test(u || ''); }
const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

function _loadUrl(win, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return; done = true; clearTimeout(t);
      win.webContents.removeListener('did-finish-load', onOk);
      win.webContents.removeListener('did-fail-load', onFail);
      err ? reject(err) : resolve();
    };
    const onOk = () => finish();
    const onFail = (_e, code, desc, _u, isMain) => { if (isMain !== false) finish(new Error('load failed: ' + desc + ' (' + code + ')')); };
    const t = setTimeout(() => finish(new Error('form page load timed out')), timeoutMs);
    win.webContents.on('did-finish-load', onOk);
    win.webContents.on('did-fail-load', onFail);
    win.loadURL(url);
  });
}

// Load the Request Service form in the warm window and read it (no clicking).
async function _readForm(win, vehicleId, settleMs = FORM_SETTLE_MS) {
  await _loadUrl(win, ORIGIN + formPath(vehicleId), FORM_LOAD_MS);
  await _sleep(settleMs);
  const deadline = Date.now() + FORM_READY_MS;
  let r = null;
  do {
    r = await win.webContents.executeJavaScript(READ_FORM_SCRIPT, true);
    if (r && r.ok && r.mainUser) break;           // React contact widget populated
    if (r && !r.ok && _isLoginUrl(r.url)) break;  // session lapsed
    await _sleep(500);
  } while (Date.now() < deadline);
  return r;
}

// Combine images into ONE PDF (one image per page) for ASIST's single file
// field. Renders offscreen from temp files, prints to PDF, cleans up.
async function _imagesToPdf(images) {
  const { BrowserWindow } = require('electron');
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volvo-att-'));
  let win = null;
  try {
    const ext = (mime) => (/png/i.test(mime) ? '.png' : /gif/i.test(mime) ? '.gif' : /webp/i.test(mime) ? '.webp' : '.jpg');
    const imgs = images.map((im, i) => { const f = 'img' + i + ext(im.mime); fs.writeFileSync(path.join(dir, f), Buffer.from(im.b64, 'base64')); return f; });
    const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const html = '<!doctype html><html><head><meta charset="utf-8"><style>'
      + '@page{size:Letter;margin:0.4in}body{margin:0;font:11px Arial,sans-serif}'
      + '.pg{page-break-after:always;text-align:center}.pg:last-child{page-break-after:auto}'
      + 'img{max-width:100%;max-height:9.6in;object-fit:contain}.cap{margin:4px 0;color:#555}</style></head><body>'
      + imgs.map((f, i) => '<div class="pg"><div class="cap">' + esc(images[i].name) + '</div><img src="' + f + '"></div>').join('')
      + '</body></html>';
    const htmlPath = path.join(dir, 'index.html');
    fs.writeFileSync(htmlPath, html);
    win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true, javascript: false } });
    await win.loadFile(htmlPath);
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'Letter' });
    return { name: 'attachments.pdf', mime: 'application/pdf', b64: Buffer.from(pdf).toString('base64') };
  } finally {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
    try { require('fs').rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function _askAi(prompt) {
  const relay = require('../../orcha/relay');
  return Promise.race([
    relay.ask(prompt, { priority: 'high', requestId: 'volvo-ck82-' + Date.now() }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('AI timeout')), AI_TIMEOUT_MS)),
  ]);
}

async function _resolveVehicle(decisiv, cache, unitNumber, { skipCache } = {}) {
  const cached = skipCache ? null : cache.get(unitNumber);
  if (cached && cached.vehicleId) return { ...cached, fromCache: true };
  const json = await decisiv.apiGet('volvo', searchPath(unitNumber));
  const v = pickVehicle(json, unitNumber);
  cache.set(unitNumber, { vehicleId: v.vehicleId, display: v.display, savedAt: new Date().toISOString() });
  logger.info('[volvo-api] unit ' + unitNumber + ' -> ASIST vehicle ' + v.vehicleId + ' (' + v.display + ')');
  return { ...v, fromCache: false };
}

/**
 * runApi(workflow, unit, altId, opts) -- same contract as VolvoWorkflow.run().
 * opts: { approveSignal, workflowId, formData }
 */
async function runApi(workflow, unit, altId, opts = {}, deps = {}) {
  const decisiv   = deps.decisiv || require('../../scrapers/decisiv_api');
  const sendToAll = deps.sendToAll || require('../base/vendor-workflow').sendToAll;
  const askAi     = deps.askAi || _askAi;
  const cache     = deps.cache || { get: _cacheGet, set: _cacheSet };
  const { approveSignal, workflowId } = opts;
  // A Cancel can arrive while we're still loading (before we await the
  // signal). Mark it handled now; we still see it when we await below.
  if (approveSignal && typeof approveSignal.catch === 'function') approveSignal.catch(() => {});
  const formData  = opts.formData || {};
  const unitNumber = String(unit.unitNumber || unit.equipmentId || unit.id || '').trim();
  const step = (s, extra) => workflow.progress(s, { workflowId, unit: unitNumber, ...(extra || {}) });
  if (!unitNumber) throw new Error('volvo: unit number missing');
  logger.info('[volvo-api][' + (workflowId || '') + '] start unit ' + unitNumber);

  // 1. Vehicle id (cached after the first lookup)
  step('resolving-vehicle');
  let vehicle = await _resolveVehicle(decisiv, cache, unitNumber);

  // 2-3. Open cases + read the live form (one locked window session)
  step('loading-form');
  const readAll = async (vid) => decisiv.withWindow('volvo', async (win) => {
    let openCount = 0;
    try { const oc = await win.webContents.executeJavaScript(_openCasesScript(vid), true); openCount = parseOpenCases(oc && oc.html); }
    catch (e) { logger.warn('[volvo-api] open cases check failed (non-fatal): ' + e.message); }
    const form = await _readForm(win, vid, deps.settleMs);
    return { openCount, form };
  });
  let { openCount, form } = await readAll(vehicle.vehicleId);
  if ((!form || !form.ok) && vehicle.fromCache && !(form && _isLoginUrl(form.url))) {
    // Saved id may be stale (unit re-registered) -- look it up fresh once.
    logger.warn('[volvo-api] form not found with cached vehicle ' + vehicle.vehicleId + '; re-resolving');
    cache.set(unitNumber, null);
    vehicle = await _resolveVehicle(decisiv, cache, unitNumber, { skipCache: true });
    ({ openCount, form } = await readAll(vehicle.vehicleId));
  }
  if (!form || !form.ok) {
    if (form && _isLoginUrl(form.url)) {
      try { decisiv.dispose(); } catch (_) {}
      throw Object.assign(new Error('Volvo ASIST login needed - session expired. Try again after signing in.'), { code: 'VOLVO_LOGIN' });
    }
    throw Object.assign(new Error('Could not open the ASIST Request Service form for unit ' + unitNumber + (form && form.error ? ': ' + form.error : '')), { code: 'VOLVO_FORM' });
  }

  // 4. Complaint codes (AI picks from ASIST's own list; fallback = ASIST default)
  const complaint = String(formData.issue || unit.issueDetails || unit.issueSummary || '').trim();
  let ck82 = [];
  let ck82Source = 'default';
  if (complaint && form.ck82 && form.ck82.length) {
    step('choosing-codes');
    try {
      ck82 = parseCk82Reply(await askAi(buildCk82Prompt(complaint, form.ck82)), form.ck82);
      if (ck82.length) ck82Source = 'ai';
    } catch (e) { logger.warn('[volvo-api] AI code pick failed (using ASIST default): ' + e.message); }
  }

  // Attachments: Uptake screenshots + user files from the Dealer WO form.
  const attach = planAttachments(formData.attachments, form.fileInfo);
  if (attach.mergeImages.length) {
    step('preparing-attachments');
    try {
      const pdf = await (deps.mergeToPdf || _imagesToPdf)(attach.mergeImages);
      attach.send = [pdf];
    } catch (e) {
      logger.warn('[volvo-api] combining images into a PDF failed: ' + e.message);
      attach.send = [attach.mergeImages[0]];
      attach.dropped = attach.dropped.concat(attach.mergeImages.slice(1).map(f => f.name + ' (could not combine into a PDF)'));
      attach.note = '';
      attach.mergeImages = [];
    }
  }

  // Requested Appointment Time = when this WO is created, in ASIST's format.
  const now = deps.now ? deps.now() : new Date();
  const apptTime = formatTime(now, form.apptInfo);
  const apptIsDateOnly = form.apptInfo && /^date$/i.test(form.apptInfo.type);
  const reqTime = form.timeInfo && (apptIsDateOnly || /^time$/i.test(form.timeInfo.type)) ? formatTime(now, form.timeInfo) : '';
  logger.info('[volvo-api] time fields: appt=' + JSON.stringify(form.apptInfo || null).slice(0, 300)
    + ' req=' + JSON.stringify(form.timeInfo || null).slice(0, 300) + ' file=' + JSON.stringify(form.fileInfo || null));

  const { city, state } = parseCityState(formData.cityState);
  const payloadInput = {
    vehicleId: vehicle.vehicleId, complaint, city, state, ck82,
    note: complaint,                       // Notes = Complaint (same text)
    location: String(formData.breakdownLocation || '').trim(),
    authNumber: altId || '',               // AMZ dealer-tracking number
    apptTime, reqTime,
    hasFile: attach.send.length > 0,       // Description = same text, with the file
    commit: form.commit,
  };
  const payload = buildPayload(form.entries, payloadInput);
  const previewLines = buildPreview(payload, { display: vehicle.display, ck82Options: form.ck82, ck82Source, attach });
  logger.info('[volvo-api] payload ready: ' + previewLines.slice(0, 9).join(' | '));

  // 5. Review gate -- nothing has been sent yet
  sendToAll('vendor:review-ready', {
    workflowId, vendor: 'volvo', unit: unitNumber, altId: altId || '',
    portalUrl: '',
    isDuplicate: openCount > 0, caseNumber: openCount > 0 ? (openCount + ' open') : '',
    instructions: 'Nothing has been sent yet. Approve sends this service request to Volvo ASIST (' + DEALER_CODE + ') once. Cancel sends nothing.'
      + (openCount > 0 ? ' Note: ASIST shows ' + openCount + ' open case(s) for this vehicle.' : ''),
    previewLines,
  });
  step('review-ready');

  let approveData;
  try { approveData = await approveSignal; }
  catch (cancelErr) { step('cancelled'); logger.info('[volvo-api] cancelled, nothing sent | unit ' + unitNumber); throw cancelErr; }
  if (!approveData || !approveData.approved) throw new Error('volvo: approved=false');
  const finalAltId = approveData.altId || altId || '';
  // Auth Number follows the AMZ number as corrected on the review screen.
  const finalPayload = finalAltId !== (altId || '') ? setField(payload, FIELD.auth, finalAltId) : payload;

  // 6. Submit ONCE (no retry -- a retry could create a duplicate SR)
  step('submitting');
  const fileField = (form.fileInfo && form.fileInfo.name) || FIELD.file;
  const reply = await decisiv.withWindow('volvo', (win) =>
    win.webContents.executeJavaScript(_postScript(finalPayload, form.token, attach.send, fileField), true));
  const res = parseSubmitResult(reply);
  logger.info('[volvo-api] submit reply: status=' + (reply && reply.status) + ' url=' + String(reply && reply.url || '').slice(0, 120)
    + ' title=' + String(reply && reply.title || '').slice(0, 80) + ' flash=' + String(reply && reply.flash || '').slice(0, 200)
    + ' -> ' + res.outcome + (res.srNumber ? ' SR ' + res.srNumber : ''));

  if (res.outcome === 'rejected') {
    throw Object.assign(new Error('Volvo ASIST rejected the request (nothing created): ' + res.detail), { code: 'VOLVO_REJECTED' });
  }
  if (res.outcome === 'unconfirmed') {
    throw Object.assign(new Error('Sent to Volvo ASIST but the SR number could not be confirmed. Check ASIST for unit ' + unitNumber + ' BEFORE trying again. (' + res.detail + ')'), { code: 'VOLVO_UNCONFIRMED' });
  }

  step('sr-created', { srNumber: res.srNumber, srUrl: res.srUrl });
  if (typeof workflow._writeToRelay === 'function') {
    await workflow._writeToRelay(unit, finalAltId, res.srNumber, res.srUrl)
      .catch(e => logger.warn('[volvo-api] relay note (non-fatal): ' + e.message));
  }
  sendToAll('vendor:complete', {
    workflowId, vendor: 'volvo', unit: unitNumber, altId: finalAltId,
    srNumber: res.srNumber, srUrl: res.srUrl, caseNumber: res.srNumber, caseUrl: res.srUrl,
    dealerCode: DEALER_CODE, dealerName: 'Volvo ' + DEALER_CODE,
  });
  return { srNumber: res.srNumber, srUrl: res.srUrl, caseNumber: res.srNumber, portalUrl: res.srUrl };
}

module.exports = {
  runApi,
  DEALER_CODE, DEFAULTS, FIELD,
  // exported for tests
  searchPath, formPath, pickVehicle, parseOpenCases, parseCityState,
  formatTime, parseDataUrl, planAttachments,
  setField, setMulti, buildPayload, buildPreview, parseSubmitResult,
  buildCk82Prompt, parseCk82Reply,
};

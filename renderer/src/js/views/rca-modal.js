/**
 * rca-modal.js — Root Cause Analysis form for one work order.
 *
 * Opened from the History tab's Repair timeline cards. Loads a pre-filled
 * draft (window.rca.draft: saved RCA in edit mode, else data + AI), renders the
 * Relay template's fields (with their dependsOn show/hide rules), and submits
 * to AAP through the Relay template API (window.rca.submit) ONLY when the user
 * clicks Submit. Nothing is sent before that.
 */

import modal from '../components/modal.js';
import toast from '../components/toast.js';

const DISPLAY_ONLY = new Set(['textHeaderLabel', 'textBodyLabel']);
const LONG_TEXT = new Set(['complaint', 'cause', 'correction', 'fasComments']);

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Same rule as Relay's dependsOn check: every key must match; an array value
// matches when any element is allowed.
function isVisible(field, values) {
  const dep = field && field.dependsOn;
  if (dep == null) return true;
  for (const key of Object.keys(dep)) {
    const allowed = Array.isArray(dep[key]) ? dep[key] : [dep[key]];
    const v = values[key];
    if (Array.isArray(v)) { if (!v.some((x) => allowed.includes(x))) return false; }
    else if (!allowed.includes(v)) return false;
  }
  return true;
}

function isRequired(f) {
  if (typeof f.required === 'string') return f.required === 'true';
  return f.required !== false;
}

const SOURCE_LABEL = { aap: 'AAP prefill', ai: 'AI', data: 'from data', saved: 'saved', default: 'default', rule: 'suggested \u2014 check' };

// Display value for a date field: raw epoch ms / ISO / YYYY-MM-DD -> local YYYY-MM-DD.
function dateValue(v) {
  if (v == null || v === '') return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?Z$/.test(s)) return s.slice(0, 10);
  const t = typeof v === 'number' ? v : (/^\d{10,}$/.test(s) ? Number(s) : Date.parse(s));
  if (isNaN(t)) return '';
  const d = new Date(t);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function fieldHtml(f, value, source, locked) {
  const id = 'rca-f-' + f.propertyName;
  const dis = locked ? ' disabled' : '';
  const req = isRequired(f) ? '<span class="rca-req" title="Required">*</span>' : '';
  const src = source ? '<span class="rca-src rca-src--' + esc(source) + '">' + esc(SOURCE_LABEL[source] || source) + '</span>' : '';
  const hint = locked
    ? '<div class="rca-hint">Prefilled by AAP \u2014 sent exactly as AAP sends it.</div>'
    : (f.helperText ? '<div class="rca-hint">' + esc(String(f.helperText).split('\n')[0].slice(0, 160)) + '</div>' : '');
  let input = '';
  switch (f.fieldType) {
    case 'selectInput': {
      // Like AAP's form, a value that isn't one of the options is still shown.
      const opts = (Array.isArray(f.selectOptions) ? f.selectOptions : []).slice();
      (Array.isArray(value) ? value : (value != null && value !== '' ? [value] : [])).forEach((v) => { if (!opts.includes(v)) opts.push(String(v)); });
      if (f.allowsMultiple) {
        const sel = Array.isArray(value) ? value : (value ? [value] : []);
        input = '<div class="rca-multi" id="' + id + '">' + opts.map((o) =>
          '<label class="rca-check"><input type="checkbox" value="' + esc(o) + '"' + (sel.includes(o) ? ' checked' : '') + dis + '> ' + esc(o) + '</label>'
        ).join('') + '</div>';
      } else {
        input = '<select id="' + id + '" class="rca-input"' + dis + '><option value=""></option>' + opts.map((o) =>
          '<option value="' + esc(o) + '"' + (String(o) === String(value) ? ' selected' : '') + '>' + esc(o) + '</option>'
        ).join('') + '</select>';
      }
      break;
    }
    case 'booleanInput':
      input = '<select id="' + id + '" class="rca-input"' + dis + '><option value=""></option>' +
        '<option value="true"' + (value === true ? ' selected' : '') + '>Yes</option>' +
        '<option value="false"' + (value === false ? ' selected' : '') + '>No</option></select>';
      break;
    case 'dateInput':
      input = '<input type="date" id="' + id + '" class="rca-input" value="' + esc(dateValue(value)) + '"' + dis + '>';
      break;
    case 'textAreaInput':
      input = '<textarea id="' + id + '" class="rca-input" rows="3"' + dis + '>' + esc(value || '') + '</textarea>';
      break;
    default:
      if (f.textInputType === 'number' && !locked) {
        input = '<input type="number" step="0.01" min="0" id="' + id + '" class="rca-input" value="' + esc(value == null ? '' : value) + '">';
      } else if (LONG_TEXT.has(f.propertyName)) {
        input = '<textarea id="' + id + '" class="rca-input" rows="2"' + dis + '>' + esc(value || '') + '</textarea>';
      } else {
        input = '<input type="text" id="' + id + '" class="rca-input" value="' + esc(value == null ? '' : value) + '"' + dis + '>';
      }
  }
  return '<div class="rca-field' + (locked ? ' rca-field--locked' : '') + '" data-prop="' + esc(f.propertyName) + '">' +
    '<label class="rca-label" for="' + id + '" title="' + esc(f.helperText || '') + '">' + esc(f.displayName || f.propertyName) + req + src + '</label>' +
    input + hint + '<div class="rca-err"></div></div>';
}

function readValue(f, root) {
  const el = root.querySelector('#rca-f-' + CSS.escape(f.propertyName));
  if (!el) return undefined;
  if (f.fieldType === 'selectInput' && f.allowsMultiple) {
    return Array.from(el.querySelectorAll('input[type=checkbox]:checked')).map((c) => c.value);
  }
  const v = el.value;
  if (f.fieldType === 'booleanInput') return v === 'true' ? true : (v === 'false' ? false : undefined);
  if (v === '' || v == null) return undefined;
  return v; // dates stay 'YYYY-MM-DD'; main normalizes to Relay's ISO format
}

// Values for submit/visibility. AAP-prefilled (locked) fields come from the
// draft's raw values, never from the inputs (the main process re-derives them).
function collect(fields, root, lockedVals) {
  const out = Object.assign({}, lockedVals || {});
  for (const f of fields) {
    if (lockedVals && f.propertyName in lockedVals) continue;
    const v = readValue(f, root);
    if (v === undefined || (Array.isArray(v) && !v.length)) continue;
    out[f.propertyName] = v;
  }
  return out;
}

function applyVisibility(fields, root, lockedVals) {
  const vals = collect(fields, root, lockedVals);
  for (const f of fields) {
    const wrap = root.querySelector('.rca-field[data-prop="' + CSS.escape(f.propertyName) + '"]');
    if (wrap) wrap.style.display = isVisible(f, vals) ? '' : 'none';
  }
}

function pickUnit(u) {
  const keys = ['equipmentId', 'domicileSite', 'operator', 'owner', 'program', 'bodyType', 'assetType', 'manufacturer',
    'engineManufacturer', 'model', 'fuelType', 'vendor', 'vendorWorkOrderId', 'workRequestId', '_serviceId'];
  const o = {};
  keys.forEach((k) => { if (u && u[k] != null && u[k] !== '') o[k] = String(u[k]); });
  return o;
}

/**
 * open({ unit, entry, onDone })
 *   entry: Repair timeline entry ({ workOrderId, reportedAt, vendor, ... })
 *   onDone({ at, mode }) is called after a successful submit.
 */
export function open({ unit, entry, onDone }) {
  if (!window.rca) { toast.show('error', 'RCA bridge unavailable — restart the app', 4000); return; }
  const equipmentId = (unit && (unit.equipmentId || unit.id)) || '';
  const workOrderId = entry && entry.workOrderId;
  // lockedVals = AAP's prefilled values for the selected work order (raw, locked).
  let state = { template: null, fields: [], existing: null, busy: false, lockedVals: {}, workOrder: null };

  const title = 'Root Cause Analysis \u2014 ' + equipmentId + (entry && entry.vendor ? ' \u00b7 ' + entry.vendor : '');

  async function submit() {
    if (state.busy || !state.template) return;
    const panel = document.querySelector('.modal-panel');
    const root = panel && panel.querySelector('.rca-form');
    if (!root) return;
    root.querySelectorAll('.rca-err').forEach((e) => { e.textContent = ''; });
    root.querySelectorAll('.rca-field--bad').forEach((e) => e.classList.remove('rca-field--bad'));
    const all = collect(state.fields, root, state.lockedVals);
    const values = {};
    state.fields.forEach((f) => {
      if (f.propertyName in state.lockedVals) return; // main re-derives AAP's prefill
      if (f.propertyName in all && isVisible(f, all)) values[f.propertyName] = all[f.propertyName];
    });

    const btn = panel.querySelector('[data-modal-action="1"]');
    state.busy = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Submitting\u2026'; }
    let res;
    try {
      res = await window.rca.submit({ equipmentId, workOrderId, vendorWorkOrderId: state.workOrder, values,
        responseId: state.existing && state.existing.responseId });
    } catch (e) { res = { ok: false, error: (e && e.message) || 'error' }; }
    state.busy = false;
    if (btn) { btn.disabled = false; btn.textContent = state.existing ? 'Update RCA in AAP' : 'Submit to AAP'; }

    if (res && res.ok) {
      toast.show('success', 'RCA ' + (res.mode === 'update' ? 'updated' : 'submitted') + ' for ' + equipmentId, 3500);
      modal.close();
      if (onDone) onDone({ at: res.at, mode: res.mode });
      return;
    }
    if (res && Array.isArray(res.errors) && res.errors.length) {
      res.errors.forEach((er) => {
        const wrap = root.querySelector('.rca-field[data-prop="' + CSS.escape(er.field) + '"]');
        if (wrap) { wrap.classList.add('rca-field--bad'); const m = wrap.querySelector('.rca-err'); if (m) m.textContent = er.message; }
      });
      const first = root.querySelector('.rca-field--bad');
      if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
      toast.show('warn', res.errors.length + ' field' + (res.errors.length === 1 ? '' : 's') + ' still need an answer', 4000);
      return;
    }
    const msg = (res && res.error) || 'Submit failed';
    const top = root.querySelector('.rca-banner-err');
    if (top) { top.textContent = msg; top.style.display = ''; }
    toast.show('error', 'RCA not submitted: ' + msg, 6000);
  }

  // Load (or reload, when the work order changes) the draft and render the form.
  async function load(panel, vendorWorkOrderId) {
    const root = panel.querySelector('.rca-form');
    const submitBtn = panel.querySelector('[data-modal-action="1"]');
    if (!root) return;
    if (submitBtn) submitBtn.disabled = true;
    root.innerHTML = '<div class="rca-loading">Building the RCA draft from the work order\u2026 (AI may take up to a minute)</div>';
    let d;
    try {
      d = await window.rca.draft({ equipmentId, workOrderId, vendorWorkOrderId: vendorWorkOrderId || null, unit: pickUnit(unit) });
    } catch (e) { d = { ok: false, error: (e && e.message) || 'error' }; }
    if (!d || !d.ok || !d.template) {
      root.innerHTML = '<div class="rca-banner-err">Could not load the RCA form: ' + esc((d && d.error) || 'unknown error') + '</div>';
      return;
    }
    state.template = d.template;
    state.existing = d.existing || null;
    state.workOrder = d.selectedWorkOrder || null;
    state.fields = (d.template.fields || []).filter((f) => f && f.propertyName && !DISPLAY_ONLY.has(f.fieldType));
    const values = d.values || {};
    const sources = d.sources || {};
    const lockedSet = new Set(d.locked || []);
    state.lockedVals = {};
    lockedSet.forEach((k) => { if (k in values) state.lockedVals[k] = values[k]; });

    const notes = [];
    if (state.existing) notes.push('An RCA is already saved in AAP for this work order \u2014 submitting will UPDATE it.');
    if (d.aiError) notes.push('AI fill unavailable (' + d.aiError + ') \u2014 please complete the remaining fields.');
    (d.warnings || []).slice(0, 6).forEach((w) => notes.push((w.label || w.field) + ': ' + w.message));
    const wos = Array.isArray(d.workOrders) ? d.workOrders : [];
    const woPicker = wos.length > 1
      ? '<div class="rca-wo"><label class="rca-label" for="rca-wo-select">Work order for auto-populating fields</label>' +
        '<select id="rca-wo-select" class="rca-input">' + wos.map((w) =>
          '<option value="' + esc(w.vendorWorkOrderId) + '"' + (w.vendorWorkOrderId === state.workOrder ? ' selected' : '') + '>' + esc(w.vendorWorkOrderId) + '</option>'
        ).join('') + '</select><div class="rca-hint">This WR has ' + wos.length + ' work orders \u2014 AAP keeps one RCA per work order.</div></div>'
      : '';
    root.innerHTML =
      '<div class="rca-meta">WR <a href="#" class="rca-wr-link">' + esc(workOrderId) + '</a>' +
        (state.workOrder ? ' \u00b7 work order ' + esc(state.workOrder) : '') + ' \u00b7 Review every field before submitting. ' +
        '<span class="rca-src rca-src--aap">AAP prefill</span> = locked, same as AAP fills it; ' +
        '<span class="rca-src rca-src--ai">AI</span> = suggested.</div>' +
      woPicker +
      (notes.length ? '<div class="rca-notes">' + notes.map((n) => '<div>' + esc(n) + '</div>').join('') + '</div>' : '') +
      '<div class="rca-banner-err" style="display:none"></div>' +
      '<div class="rca-grid">' + state.fields.map((f) => fieldHtml(f, values[f.propertyName], sources[f.propertyName], lockedSet.has(f.propertyName))).join('') + '</div>';
    root.onchange = (ev) => {
      if (ev.target && ev.target.id === 'rca-wo-select') { load(panel, ev.target.value); return; }
      applyVisibility(state.fields, root, state.lockedVals);
    };
    const link = root.querySelector('.rca-wr-link');
    if (link) link.addEventListener('click', (ev) => {
      ev.preventDefault();
      const url = 'https://aap-na.corp.amazon.com/v2/service/' + workOrderId + '?tab=CustomForms';
      if (window.aap && window.aap.openUrl) window.aap.openUrl(url);
    });
    applyVisibility(state.fields, root, state.lockedVals);
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = state.existing ? 'Update RCA in AAP' : 'Submit to AAP';
    }
  }

  modal.show({
    title,
    width: 760,
    body: '<div class="rca-form"></div>',
    actions: [
      { label: 'Cancel', onClick: () => modal.close() },
      { label: 'Submit to AAP', cls: 'primary', onClick: submit },
    ],
    // The shared modal overlay sits at z-index 900, below the unit detail
    // drawer (9500) this is opened from — lift it while the RCA form is open.
    onClose: () => { const ov = document.querySelector('.modal-ov'); if (ov) ov.style.zIndex = '900'; },
    onMount: (panel) => {
      if (panel.parentElement) panel.parentElement.style.zIndex = '9800';
      load(panel, null);
    },
  });
}

export default { open };

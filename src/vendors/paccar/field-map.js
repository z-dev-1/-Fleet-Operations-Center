'use strict';
/**
 * vendors/paccar/field-map.js -- PACCAR portal field descriptors [V-C]
 * S23-6 (2026-06-28): Selector arrays + value extractors for paccarpg.decisiv.net
 *
 * Each descriptor:
 *   key       -- logical field name (used in results + logging)
 *   label     -- human-readable label for progress / debug
 *   selectors -- CSS selectors tried left-to-right; first present match wins
 *   required  -- if true + value is empty => warn (non-fatal)
 *   getValue  -- (unit, altId) => string  (runs in Node context before injection)
 *
 * buildFillScript(unit, altId) => injectable JS string for webContents.executeJavaScript()
 * Returns { ok: true, results: { [key]: boolean } }
 */

const FIELDS = [
  {
    key:       'vin',
    label:     'VIN',
    selectors: ['[name=vin]', '[name=vehicle_vin]', '[data-field=vin]', '#vin'],
    required:  true,
    getValue:  (unit)         => unit.vin        || unit.vehicleId   || '',
  },
  {
    key:       'unit_number',
    label:     'Unit Number',
    selectors: ['[name=unit_number]', '[name=asset_id]', '[data-field=unit_number]'],
    required:  false,
    getValue:  (unit)         => unit.unitNumber || unit.equipmentId || '',
  },
  {
    key:       'reference_number',
    label:     'Reference # (altId)',
    selectors: ['[name=reference_number]', '[name=po_number]', '[data-field=reference_number]'],
    required:  false,
    getValue:  (_unit, altId) => altId           || '',
  },
  {
    key:       'odometer',
    label:     'Odometer',
    selectors: ['[name=odometer]', '[name=mileage]', '[data-field=odometer]'],
    required:  false,
    getValue:  (unit)         => String(unit.mileage || unit.odometer || ''),
  },
  {
    key:       'complaint',
    label:     'Complaint / Notes',
    selectors: ['[name=complaint]', '[name=customer_complaint]', 'textarea[name=notes]'],
    required:  false,
    getValue:  (unit, altId)  =>
      'Amazon Fleet Ref: ' + (altId || '') +
      ' | Unit: '          + (unit.unitNumber || unit.equipmentId || ''),
  },
];

/**
 * buildFillScript(unit, altId)
 * Returns a self-executing JS string safe for webContents.executeJavaScript().
 * Field values are resolved in Node context and JSON-serialised into the script —
 * no eval of untrusted input, no manual string-escape hazards from field values.
 */
function buildFillScript(unit, altId) {
  const payload = FIELDS.map(f => ({
    key:       f.key,
    selectors: f.selectors,
    value:     f.getValue(unit, altId),
    required:  f.required,
  }));

  return (
    '(function(){'
    + 'var sv=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;'
    + 'var tvs=(Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")||{}).set;'
    + 'function dispatch(el){el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));}'
    + 'function fill(list,val){for(var i=0;i<list.length;i++){var el=document.querySelector(list[i]);if(el){if(el.tagName==="TEXTAREA"&&tvs)tvs.call(el,val);else sv.call(el,val);dispatch(el);return true;}}return false;}'
    + 'var fields=' + JSON.stringify(payload) + ';'
    + 'var results={};'
    + 'for(var i=0;i<fields.length;i++){var f=fields[i];results[f.key]=fill(f.selectors,f.value);}'
    + 'return {ok:true,results:results};'
    + '})()'
  );
}

module.exports = { FIELDS, buildFillScript };

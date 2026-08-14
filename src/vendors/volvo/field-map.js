'use strict';
/**
 * vendors/volvo/field-map.js -- Volvo/ASIST SR form field map [V-C]
 * Updated 2026-07-27: selectors confirmed live against volvopg.asist.decisiv.net
 *
 * The ASIST SR form at /fleet/vehicles/{id}/request_service/{dealer_code} uses:
 *   - #complaint textarea  (required -- re-enables submit button via React input event)
 *   - #est_note textarea   (optional notes)
 *   - #input-3 radio       (primaryContact=2 = Enter Contact Information, React controlled)
 *   - Contact fields rendered by React after #input-3 fires:
 *       input[name='service_request[primary_contact_first_name]']
 *       input[name='service_request[primary_contact_last_name]']
 *       input[name='service_request[primary_contact_email]']
 *       input[name='service_request[primary_contact_mobile_phone]']:not([type='hidden'])
 *   - #input-13 radio      (driverContact=4 = Same As Primary, React controlled)
 *   - #service_request_breakdown_city
 *   - #service_request_breakdown_state
 *   - #send-request-bottom / #send-request-top  (submit, disabled until complaint fires input)
 *
 * React fiber pattern: direct .click() and dispatchEvent('click') do NOT update
 * React state on these radios. Must walk __reactFiber and call memoizedProps.onChange.
 */

/**
 * buildFillScript(unit, altId, opts)
 *
 * @param {object} unit
 * @param {string} altId            Relay WO reference
 * @param {object} [opts]
 * @param {string} [opts.complaint]          Override complaint text
 * @param {string} [opts.notes]              Notes field (#est_note)
 * @param {object} [opts.contact]            { firstName, lastName, email, phone }
 * @param {string} [opts.breakdownCity]
 * @param {string} [opts.breakdownState]
 * @returns {string}  Self-executing JS for webContents.executeJavaScript()
 *                    Returns { ok, radioFired, contactFilled, submitEnabled }
 */
function buildFillScript(unit, altId, opts) {
  opts = opts || {};
  var unitNum = unit.unitNumber || unit.equipmentId || unit.id || '';
  var vin     = unit.vin || '';

  var complaint = opts.complaint || (
    'Amazon Fleet Unit: ' + unitNum +
    (vin   ? ' | VIN: '       + vin   : '') +
    (altId ? ' | Relay Ref: ' + altId : '')
  );

  var contact = opts.contact || {
    firstName: unit.pocFirstName || unit.contactFirstName || '',
    lastName:  unit.pocLastName  || unit.contactLastName  || '',
    email:     unit.pocEmail     || unit.contactEmail     || '',
    phone:     unit.pocPhone     || unit.contactPhone     || '',
  };

  var payload = {
    complaint:      complaint,
    notes:          opts.notes          || '',
    contact:        contact,
    breakdownCity:  opts.breakdownCity  || unit.city  || '',
    breakdownState: opts.breakdownState || unit.state || '',
  };

  // React fiber onChange trigger -- the only reliable way to switch React-controlled radios.
  // Must be inlined into the script because it runs in the renderer context.
  var reactRadioFn = [
    'function triggerReactRadio(el){',
    '  if(!el)return false;',
    '  el.checked=true;',
    '  var fk=Object.keys(el).find(function(k){return k.indexOf("__reactFiber")===0;});',
    '  if(!fk)return false;',
    '  var inst=el[fk];',
    '  while(inst){',
    '    if(inst.memoizedProps&&typeof inst.memoizedProps.onChange==="function"){',
    '      inst.memoizedProps.onChange({target:el,currentTarget:el});',
    '      return true;',
    '    }',
    '    inst=inst.return;',
    '  }',
    '  return false;',
    '}',
  ].join('');

  return (
    '(function(){' +
    reactRadioFn +
    'var result={ok:false,radioFired:false,contactFilled:false,submitEnabled:false};' +
    'var p=' + JSON.stringify(payload) + ';' +

    // 1. complaint
    'var complaint=document.getElementById("complaint");' +
    'if(complaint){complaint.value=p.complaint;complaint.dispatchEvent(new Event("input",{bubbles:true}));complaint.dispatchEvent(new Event("change",{bubbles:true}));}' +

    // 2. notes
    'if(p.notes){var notes=document.getElementById("est_note");if(notes){notes.value=p.notes;notes.dispatchEvent(new Event("input",{bubbles:true}));}}' +

    // 3. primaryContact radio -> value=2 (Enter Contact Information)
    'var pcRadio=document.getElementById("input-3");' +
    'result.radioFired=triggerReactRadio(pcRadio);' +

    // 4. contact fields (React renders them after radio fires)
    'function fillContact(){' +
      'var fn=document.querySelector(\'input[name="service_request[primary_contact_first_name]"]\')||null;' +
      'var ln=document.querySelector(\'input[name="service_request[primary_contact_last_name]"]\')||null;' +
      'var em=document.querySelector(\'input[name="service_request[primary_contact_email]"]\')||null;' +
      'var ph=document.querySelector(\'input[name="service_request[primary_contact_mobile_phone]"]:not([type="hidden"])\')||null;' +
      'if(!fn)return false;' +
      'if(p.contact.firstName){fn.value=p.contact.firstName;fn.dispatchEvent(new Event("input",{bubbles:true}));}' +
      'if(p.contact.lastName&&ln){ln.value=p.contact.lastName;ln.dispatchEvent(new Event("input",{bubbles:true}));}' +
      'if(p.contact.email&&em){em.value=p.contact.email;em.dispatchEvent(new Event("input",{bubbles:true}));}' +
      'if(p.contact.phone&&ph){ph.value=p.contact.phone;ph.dispatchEvent(new Event("input",{bubbles:true}));}' +
      'return true;' +
    '}' +
    'result.contactFilled=fillContact();' +
    'if(!result.contactFilled){setTimeout(function(){fillContact();},100);}' +

    // 5. driverContact radio -> value=4 (Same As Primary)
    'var drRadio=document.getElementById("input-13");' +
    'triggerReactRadio(drRadio);' +

    // 6. breakdown city / state
    'if(p.breakdownCity){var city=document.getElementById("service_request_breakdown_city");if(city){city.value=p.breakdownCity;city.dispatchEvent(new Event("input",{bubbles:true}));}}' +
    'if(p.breakdownState){var st=document.getElementById("service_request_breakdown_state");if(st){st.value=p.breakdownState;st.dispatchEvent(new Event("change",{bubbles:true}));}}' +

    // 7. re-fire complaint to ensure submit button is enabled
    'if(complaint){complaint.dispatchEvent(new Event("input",{bubbles:true}));}' +

    // 8. check submit button state
    'var btn=document.getElementById("send-request-bottom")||document.getElementById("send-request-top");' +
    'result.submitEnabled=btn?!btn.disabled:false;' +
    'result.ok=true;' +
    'return result;' +
    '})()'
  );
}

/**
 * buildSubmitScript()
 * Re-fires complaint input event (ensures React enables the button) then clicks submit.
 * @returns {string}  Returns { clicked, label, disabled }
 */
function buildSubmitScript() {
  return (
    '(function(){' +
    'var complaint=document.getElementById("complaint");' +
    'if(complaint){complaint.dispatchEvent(new Event("input",{bubbles:true}));}' +
    'var btn=document.getElementById("send-request-bottom")||document.getElementById("send-request-top");' +
    'if(btn&&!btn.disabled){btn.click();return{clicked:true,label:(btn.value||btn.textContent||"").trim().slice(0,40)};}' +
    'return{clicked:false,disabled:btn?btn.disabled:"not found"};' +
    '})()'
  );
}

module.exports = { buildFillScript, buildSubmitScript };
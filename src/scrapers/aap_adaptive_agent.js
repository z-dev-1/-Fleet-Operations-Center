'use strict';
/**
 * AAP Adaptive Agent — Orcha-powered Work Request Creation
 * 
 * Instead of hardcoded selectors, this agent:
 * 1. Reads the current page DOM (visible inputs, buttons, labels, dropdowns)
 * 2. Sends the snapshot + payload to Orcha
 * 3. Orcha returns structured instructions (click X, type Y, select Z)
 * 4. Executes instructions
 * 5. Repeats until wizard is complete
 * 
 * This survives AAP UI changes because Orcha reads and adapts in real-time.
 */

const { BrowserWindow } = require('electron');
const path = require('path');
const logger = require('../utils/logger').createLogger('aap_adaptive_agent');
// FEATURE (2026-07-22): real Relay Garage/AAP wizard SOP (screens, field
// rules, urgency triggers, tow-specific fields, vendor-by-scenario), given
// directly by the user, replacing the previous generic/guessed wizard-step
// description below. See src/orcha/aap_wizard_knowledge.js for full scope
// notes on what's included vs deliberately excluded.
const { WIZARD_KNOWLEDGE } = require('../orcha/aap_wizard_knowledge');

// L-3: named constant — was an unnamed inline 15000 in the did-finish-load timeout
const PAGE_LOAD_TIMEOUT_MS = 15_000;

// ═══════════════════════════════════════════════════════════════
// DOM SNAPSHOT — injected into BrowserWindow to read the page
// ═══════════════════════════════════════════════════════════════
const SNAPSHOT_SCRIPT = `
(function() {
  const snapshot = { url: location.href, title: document.title, elements: [], pageText: '' };
  
  // Get visible page text (headings, labels, paragraphs) for context
  const textEls = document.querySelectorAll('h1,h2,h3,h4,h5,h6,label,p,span,legend,th,td');
  const textSet = new Set();
  textEls.forEach(el => {
    if (el.offsetParent === null && !el.closest('[role="dialog"]')) return; // hidden
    const t = (el.innerText || el.textContent || '').trim();
    if (t && t.length < 200 && t.length > 1) textSet.add(t);
  });
  snapshot.pageText = Array.from(textSet).slice(0, 80).join(' | ');
  
  // Gather all interactive elements
  const interactives = document.querySelectorAll(
    'input, textarea, select, button, [role="button"], [role="combobox"], [role="radio"], [role="checkbox"], [role="option"], [role="listbox"], [contenteditable="true"]'
  );
  
  // Visibility test that ALSO accepts fixed-position / transform-laid-out
  // controls (AAP's Next button lives in a fixed footer, and freshly-hydrated
  // React controls can have offsetParent === null while still being on-screen).
  // The old "offsetParent === null" gate silently dropped exactly those — which
  // is why only ~10 elements came through and the AI never saw the real Next
  // button. Treat an element as visible if it has a non-zero rendered box.
  function _isVisible(el) {
    if (el.type === 'file') return true;
    if (el.offsetParent !== null) return true;
    if (el.closest('[role="dialog"]')) return true;
    try {
      const r = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    } catch (e) { return false; }
  }

  interactives.forEach((el, idx) => {
    // Skip truly-hidden elements only.
    if (!_isVisible(el)) return;
    
    // Find associated label
    let label = '';
    if (el.id) {
      const labelEl = document.querySelector('label[for="' + el.id + '"]');
      if (labelEl) label = (labelEl.innerText || labelEl.textContent || '').trim();
    }
    if (!label) {
      const closest = el.closest('label, [class*="field"], [class*="form-group"], [data-testid]');
      if (closest) label = (closest.querySelector('label, legend, .label, [class*="label"]') || {}).innerText || '';
      if (!label) label = (closest || {}).innerText || '';
    }
    if (!label) label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '';
    label = label.trim().substring(0, 100);
    
    const entry = {
      idx: idx,
      tag: el.tagName.toLowerCase(),
      type: el.type || el.getAttribute('role') || '',
      id: el.id || '',
      name: el.name || '',
      label: label,
      value: el.value || '',
      checked: el.checked || false,
      disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
      placeholder: el.placeholder || '',
      text: (el.innerText || el.textContent || '').trim().substring(0, 80),
      ariaLabel: el.getAttribute('aria-label') || '',
      ariaExpanded: el.getAttribute('aria-expanded'),
      options: [],
      visible: _isVisible(el)
    };
    
    // For select elements, get options
    if (el.tagName === 'SELECT') {
      entry.options = Array.from(el.options).map(o => ({ value: o.value, text: o.text, selected: o.selected }));
    }
    
    // For radio/checkbox, get the group
    if (el.type === 'radio' || el.type === 'checkbox') {
      entry.groupName = el.name;
    }
    
    snapshot.elements.push(entry);
  });
  
  // Also capture any visible dropdown options (for open comboboxes)
  const options = document.querySelectorAll('[role="option"], [role="listitem"]');
  const visibleOptions = [];
  options.forEach(o => {
    if (o.offsetParent === null) return;
    visibleOptions.push((o.innerText || o.textContent || '').trim().substring(0, 100));
  });
  if (visibleOptions.length > 0) {
    snapshot.openDropdownOptions = visibleOptions.slice(0, 30);
  }
  
  // Detect modals
  const modals = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]');
  modals.forEach(m => {
    if (m.offsetParent !== null || m.style.display !== 'none') {
      snapshot.modalVisible = true;
      snapshot.modalText = (m.innerText || '').trim().substring(0, 300);
    }
  });
  
  // Check for loading/spinners
  const spinners = document.querySelectorAll('[class*="spinner"], [class*="loading"], [class*="skeleton"], [aria-busy="true"]');
  snapshot.isLoading = Array.from(spinners).some(s => s.offsetParent !== null);
  
  // Check for error messages
  const errors = document.querySelectorAll('[class*="error"], [class*="Error"], [role="alert"]');
  const visErrors = [];
  errors.forEach(e => { if (e.offsetParent !== null) visErrors.push((e.innerText || '').trim()); });
  if (visErrors.length > 0) snapshot.errors = visErrors;

  // ── Explicit primary-button scan (Next / Submit / Continue) ───────────────
  // On this wizard the Next button lives at the BOTTOM of a long scrollable
  // page (below "Other Open Work"), so it's rendered but off-screen. The
  // element loop above may or may not surface it clearly, so scan for it
  // directly and report its exact state — text, disabled, and whether it's
  // currently in the viewport — so the AI/executor knows it exists and whether
  // it can be clicked yet.
  (function() {
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    const navBtn = btns.find(b => {
      const t = (b.innerText || b.textContent || '').trim();
      return /^(next|continue|save\\s*&?\\s*continue|proceed|submit|submit request)$/i.test(t);
    });
    if (navBtn) {
      let inView = false;
      try { const r = navBtn.getBoundingClientRect(); inView = r.top >= 0 && r.bottom <= (window.innerHeight || 9999); } catch (e) {}
      snapshot.primaryButton = {
        text: (navBtn.innerText || navBtn.textContent || '').trim().substring(0, 40),
        disabled: navBtn.disabled || navBtn.getAttribute('aria-disabled') === 'true',
        inView: inView,
      };
    }
  })();

  // ── Current wizard step (left-side stepper) ───────────────────────────────
  // Report which step is highlighted so the AI, stuck detection, AND the
  // per-step recipe engine can tell which step we're on and whether the wizard
  // actually advanced. The AAP stepper (see live screenshots) renders each step
  // as a row with a status marker: a checkmark for completed steps, a filled
  // dot for the CURRENT step, and hollow dots for future steps. We try, in
  // order: (1) an explicit aria-current marker, (2) framework "active/current"
  // classes, (3) heuristic — the known step names present as a list, with the
  // current one identified by not-yet-completed styling. Best-effort; falls
  // back to a name match against the known AAP step list.
  (function() {
    const KNOWN = ['Select Equipment','Asset Condition','Location','Work Request Details','Issue Details','Select Vendor','Comments','Review'];
    let cur = document.querySelector('[aria-current="step"], [aria-current="true"], [class*="stepper"] [class*="active"], [class*="Step"][class*="active"], [class*="current"]');
    if (cur) {
      const t = (cur.innerText || cur.textContent || '').trim();
      // Normalize to a known step name if the marker text contains one.
      const hit = KNOWN.find(k => t.toLowerCase().includes(k.toLowerCase()));
      snapshot.currentStep = (hit || t).substring(0, 60);
    }
    // Also expose the full step list + which look completed, so the recipe
    // engine can reason about ordering even when markers are ambiguous.
    try {
      const rows = Array.from(document.querySelectorAll('a, li, div, span')).filter(el => {
        const t = (el.innerText || '').trim();
        return KNOWN.includes(t);
      });
      if (rows.length) {
        snapshot.stepList = KNOWN.filter(k => rows.some(r => (r.innerText || '').trim() === k));
      }
    } catch (e) {}
  })();

  return JSON.stringify(snapshot);
})();
`;

// ═══════════════════════════════════════════════════════════════
// ACTION EXECUTOR — injected to perform actions on the page
// ═══════════════════════════════════════════════════════════════
function buildActionScript(actions) {
  return `
(async function() {
  const results = [];
  
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  
  function setReactValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, String(value));
    else el.value = String(value);
    ['input', 'change', 'keyup'].forEach(t => {
      try { el.dispatchEvent(new Event(t, { bubbles: true })); } catch(e) {}
    });
  }
  
  function fullClick(el) {
    // INSTANT scroll (not smooth) so the element is actually in view BEFORE we
    // dispatch the click — a smooth scroll is async and the old code fired the
    // click while the page was still scrolling, so an off-screen Next button
    // (bottom of this long wizard page) never actually got clicked.
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch(e) {}
    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(type => {
      try {
        el.dispatchEvent(type.startsWith('pointer')
          ? new PointerEvent(type, { bubbles: true, cancelable: true })
          : new MouseEvent(type, { bubbles: true, cancelable: true }));
      } catch(e) {}
    });
    try { el.click(); el.focus(); } catch(e) {}
  }

  function isDisabled(el) {
    return !!(el && (el.disabled || el.getAttribute('aria-disabled') === 'true'));
  }

  // Find the wizard's primary nav button by its label text.
  function findNavButton(label) {
    const want = String(label || '').toLowerCase();
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    // Exact-ish match first (avoid matching "Next steps" etc.)
    return btns.find(b => {
      const t = (b.innerText || b.textContent || '').trim().toLowerCase();
      return want ? (t === want || t.startsWith(want)) : /^(next|continue|save\\s*&?\\s*continue|proceed)$/.test(t);
    }) || null;
  }
  
  function findElement(selector) {
    // Try multiple strategies to find the element
    // Strategy 1: By index (from snapshot)
    if (selector.idx !== undefined) {
      const all = document.querySelectorAll('input, textarea, select, button, [role="button"], [role="combobox"], [role="radio"], [role="checkbox"], [role="option"], [contenteditable="true"]');
      if (all[selector.idx]) return all[selector.idx];
    }
    // Strategy 2: By ID
    if (selector.id) {
      const el = document.getElementById(selector.id);
      if (el) return el;
    }
    // Strategy 3: By text content (buttons, labels)
    if (selector.text) {
      const target = selector.text.trim();
      const candidates = document.querySelectorAll(selector.tag || 'button, [role="button"], label, [role="option"]');
      for (const c of candidates) {
        const ct = (c.innerText || c.textContent || '').trim();
        if (ct === target || ct.includes(target) || target.includes(ct)) return c;
      }
    }
    // Strategy 4: By aria-label
    if (selector.ariaLabel) {
      const el = document.querySelector('[aria-label="' + selector.ariaLabel.replace(/"/g, '\\\\"') + '"]');
      if (el) return el;
    }
    // Strategy 5: By placeholder
    if (selector.placeholder) {
      const el = document.querySelector('[placeholder*="' + selector.placeholder.replace(/"/g, '\\\\"') + '"]');
      if (el) return el;
    }
    // Strategy 6: By label text (find label, then associated input)
    if (selector.label) {
      const labels = document.querySelectorAll('label');
      for (const l of labels) {
        if ((l.innerText || '').trim().toLowerCase().includes(selector.label.toLowerCase())) {
          if (l.htmlFor) return document.getElementById(l.htmlFor);
          const input = l.querySelector('input, textarea, select');
          if (input) return input;
        }
      }
    }
    return null;
  }
  
  const actions = ${JSON.stringify(actions)};
  
  for (const action of actions) {
    await sleep(action.delay || 300);
    
    try {
      if (action.type === 'click') {
        const el = findElement(action.target);
        const _tgt = action.target.text || action.target.id || 'idx:' + action.target.idx;
        // AUTO-PROMOTE a plain click on the wizard's Next/Continue button into
        // the robust clickNext path. The AI keeps emitting {type:"click",
        // target:{text:"Next"}} (see live logs), which used to "succeed" even
        // when the button was off-screen/disabled and nothing happened — the
        // exact cause of the 8-step no-progress loop. If the click target is a
        // nav button, fall through to the clickNext behavior (scroll + wait for
        // enabled + verify the page actually changed).
        const _navText = String(_tgt || '').trim().toLowerCase();
        const _isNav = /^(next|continue|save\\s*&?\\s*continue|proceed|submit|submit request)$/.test(_navText);
        if (_isNav) {
          action = { type: 'clickNext', label: (action.target && action.target.text) || 'Next', _promotedFrom: 'click' };
          // fall through to the clickNext handler below
        } else if (!el) { results.push({ ok: false, action: 'click', error: 'Element not found', target: action.target }); }
        else if (isDisabled(el)) {
          // Never report a disabled click as success — that's what taught the
          // AI that clicking a disabled Next "worked" and made it loop.
          results.push({ ok: false, action: 'click', error: 'target is disabled — cannot click', disabled: true, target: _tgt });
        } else {
          fullClick(el);
          results.push({ ok: true, action: 'click', target: _tgt });
        }
      }
      if (action.type === 'clickNext') {
        // Robust wizard-advance: find the Next/Continue button (even below the
        // fold), scroll it into view, WAIT until it's enabled (up to 10s), click
        // it, then VERIFY the page changed. Returns a clear disabled/no-effect
        // signal instead of a false success.
        const label = action.label || 'Next';
        let btn = findNavButton(label);
        if (!btn) { results.push({ ok: false, action: 'clickNext', error: 'Next/Continue button not found on page' }); }
        else {
          try { btn.scrollIntoView({ block: 'center' }); } catch(e) {}
          // Wait for enabled (unit data / required fields still loading).
          const t0 = Date.now();
          while (isDisabled(btn) && Date.now() - t0 < 10000) {
            await sleep(300);
            btn = findNavButton(label) || btn;
            try { btn.scrollIntoView({ block: 'center' }); } catch(e) {}
          }
          if (isDisabled(btn)) {
            results.push({ ok: false, action: 'clickNext', error: 'Next stayed disabled 10s — a required field on this step is not filled yet', disabled: true });
          } else {
            // Capture a STABLE step marker before clicking so we can tell a
            // real step transition from mere hydration churn. Prefer the
            // left-side stepper's current-step label; fall back to the set of
            // field labels present (structure, not values); last resort URL.
            function _stepMarker() {
              const cur = document.querySelector('[aria-current="step"], [aria-current="true"], [class*="stepper"] [class*="active"], [class*="Step"][class*="active"], [class*="current"]');
              if (cur) return 'S:' + (cur.innerText || cur.textContent || '').trim().slice(0, 60);
              const labels = Array.from(document.querySelectorAll('label, legend'))
                .map(l => (l.innerText || '').trim()).filter(Boolean).sort().join('|');
              return 'L:' + labels.slice(0, 400);
            }
            const beforeUrl = location.href;
            const beforeMarker = _stepMarker();
            fullClick(btn);
            // Verify it advanced: URL or the step marker changed within ~5s.
            // (5s, not 3s — a wizard step transition can render slower than the
            // old 3s window, which produced false "did not change" signals.)
            let advanced = false;
            const t1 = Date.now();
            while (Date.now() - t1 < 5000) {
              await sleep(300);
              if (location.href !== beforeUrl || _stepMarker() !== beforeMarker) { advanced = true; break; }
            }
            results.push(advanced
              ? { ok: true, action: 'clickNext', advanced: true }
              : { ok: false, action: 'clickNext', error: 'clicked Next but the page did not change', noEffect: true });
          }
        }
      }
      else if (action.type === 'type') {
        const el = findElement(action.target);
        if (el) {
          el.focus();
          if (action.clear) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); await sleep(100); }
          if (action.charByChar) {
            // Type character by character (for combobox search)
            const text = String(action.value);
            for (let i = 1; i <= text.length; i++) {
              setReactValue(el, text.slice(0, i));
              await sleep(action.charDelay || 60);
            }
          } else {
            setReactValue(el, action.value);
          }
          results.push({ ok: true, action: 'type', value: action.value });
        }
        else results.push({ ok: false, action: 'type', error: 'Element not found', target: action.target });
      }
      else if (action.type === 'select') {
        const el = findElement(action.target);
        if (el && el.tagName === 'SELECT') {
          el.value = action.value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          results.push({ ok: true, action: 'select', value: action.value });
        }
        else results.push({ ok: false, action: 'select', error: 'Select not found' });
      }
      else if (action.type === 'radio') {
        // Click a radio by its label text
        const labels = document.querySelectorAll('label');
        let clicked = false;
        for (const l of labels) {
          if ((l.innerText || '').trim().toLowerCase().includes(action.value.toLowerCase())) {
            const radio = l.querySelector('input[type="radio"]') || l;
            fullClick(radio);
            // Also try native checked setter
            if (radio.type === 'radio') {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked');
              if (setter && setter.set) setter.set.call(radio, true);
              radio.dispatchEvent(new Event('change', { bubbles: true }));
            }
            clicked = true;
            break;
          }
        }
        results.push({ ok: clicked, action: 'radio', value: action.value });
      }
      else if (action.type === 'wait') {
        await sleep(action.duration || 1000);
        results.push({ ok: true, action: 'wait', duration: action.duration });
      }
      else if (action.type === 'waitForOption') {
        // Wait for a dropdown option to appear, then click it
        //
        // BUG FIX (2026-07-22): default timeout raised 5000ms -> 8000ms.
        // Real evidence from the accumulated aapLessons store showed the
        // EXACT SAME action (e.g. typing a domicile code, waiting for its
        // dropdown option) both succeeding and failing across different
        // runs -- a classic race condition against AAP's dropdown render
        // time, not a wrong-approach problem. 5s wasn't consistently
        // enough. The AI is now also told (see aap_wizard_knowledge.js's
        // injected WIZARD RULES) to explicitly pass timeout:8000+ itself,
        // but this default is raised too in case it omits one.
        const target = String(action.value).trim().toUpperCase();
        let found = null;
        const t0 = Date.now();
        while (!found && Date.now() - t0 < (action.timeout || 8000)) {
          const opts = document.querySelectorAll('[role="option"], button[role="option"]');
          for (const o of opts) {
            const ot = (o.innerText || o.textContent || o.getAttribute('aria-label') || '').trim().toUpperCase();
            if (ot === target || ot.includes(target) || target.includes(ot)) { found = o; break; }
          }
          if (!found) await sleep(100);
        }
        if (found) { fullClick(found); results.push({ ok: true, action: 'waitForOption', value: action.value }); }
        // FEATURE (2026-07-22): tag this error distinctly (timeoutLikely)
        // so the lesson-writing code in runAdaptiveWR can give the AI
        // accurate guidance ("probably just needed longer, retry the same
        // approach") instead of the old blanket "TRY DIFFERENT APPROACH"
        // message, which was actively misleading for what is usually a
        // pure timing issue rather than a wrong strategy.
        else results.push({ ok: false, action: 'waitForOption', error: 'Option not found: ' + action.value, timeoutLikely: true });
      }
    } catch(e) {
      results.push({ ok: false, action: action.type, error: e.message });
    }
  }
  
  return JSON.stringify(results);
})();
`;
}

// ═══════════════════════════════════════════════════════════════
// ORCHA PROMPT BUILDER — constructs the AI prompt for each step
// ═══════════════════════════════════════════════════════════════
function buildPrompt(snapshot, payload, stepHistory, lessonContext, autoSubmit) {
  return `You are Orcha, filling out an AAP (Amazon Asset Portal) Work Request wizard. You can see the current page state below.

YOUR GOAL: Fill the fields on the CURRENT page with the correct values from the payload, then click "Next" to advance. ${autoSubmit ? 'On the final Review page, click Submit.' : 'DO NOT submit. When you reach the final Review/Submit page with everything filled, respond with a single {"type":"DONE_REVIEW"} action instead of clicking Submit — the user will review and submit manually.'}

THE LIVE WIZARD IS THE SOURCE OF TRUTH — READ IT EVERY STEP:
- The page state below (INTERACTIVE ELEMENTS + open dropdown options) reflects the wizard AS IT IS RIGHT NOW. Use ONLY what is shown there.
- The wizard can change at any time — fields, steps, dropdown options, and required questions may be added, removed, or renamed. Do not assume it matches any previous version or any example.
- For a dropdown/combobox: only choose a value that ACTUALLY APPEARS in that field's current options. To see a field's options, open it (click it / type into it) — the next page snapshot will list its live options; then pick the closest matching REAL option. Never type or select an option that is not present.
- NEVER invent components, subcategories, locations, repair types, reasons, dropdown options, or unit info. If the payload's intended value has no matching live option, pick the closest real option that fits; if none fits, skip that field and note what's missing.
- If a field is already filled correctly, leave it. After any Next / dropdown selection / step change, the page will be re-read and you'll get a fresh snapshot — work from that new snapshot, not from a remembered older one.

CRITICAL FORMAT RULE (repeated at the end too, but stated here first in case this
prompt ever gets truncated): your entire response must be ONLY a JSON array of
action objects -- no explanation, no markdown, no code fences, no restating the
task.

PAYLOAD (data to fill):
${JSON.stringify(payload, null, 2)}

CURRENT PAGE STATE:
- URL: ${snapshot.url}
- Page text: ${snapshot.pageText}
- Loading: ${snapshot.isLoading}
- Modal visible: ${snapshot.modalVisible || false}${snapshot.modalText ? '\n- Modal text: ' + snapshot.modalText : ''}
${snapshot.errors ? '- ERRORS: ' + snapshot.errors.join(', ') : ''}
${snapshot.currentStep ? '- Current wizard step: ' + snapshot.currentStep : ''}
${snapshot.primaryButton ? '- Primary button: "' + snapshot.primaryButton.text + '" (disabled=' + snapshot.primaryButton.disabled + ', inView=' + snapshot.primaryButton.inView + ') — use {"type":"clickNext"} to press it' : ''}
${snapshot.openDropdownOptions ? '- Open dropdown options: ' + snapshot.openDropdownOptions.join(', ') : ''}

INTERACTIVE ELEMENTS:
${snapshot.elements.filter(e => e.visible || e.type === 'file').map(e => 
  `[${e.idx}] ${e.tag} type="${e.type}" id="${e.id}" label="${e.label}" value="${e.value}" text="${e.text}" placeholder="${e.placeholder}" checked=${e.checked} disabled=${e.disabled}${e.options.length ? ' options=[' + e.options.map(o => o.text).join(',') + ']' : ''}`
).join('\n')}

STEP HISTORY (what we've done so far):
${stepHistory.slice(-5).map(h => '- ' + h).join('\n') || '(none yet)'}

${WIZARD_KNOWLEDGE}

WIZARD RULES (mechanical -- how to execute actions, applies regardless of which screen you're on):
- This is a multi-page wizard. Fill visible fields on the CURRENT screen using the domain guidance above, then advance.
- TO ADVANCE THE WIZARD, ALWAYS use { "type": "clickNext" } — do NOT use a plain click on "Next". clickNext scrolls the Next button into view (it is often BELOW the fold at the bottom of a long page), WAITS until it is enabled, clicks it, and VERIFIES the page actually changed. Use { "type": "clickNext", "label": "Continue" } if the button says something other than "Next". (A plain click on a button literally labelled Next/Continue/Submit is auto-upgraded to clickNext for you, but you should still emit clickNext directly.)
- IMPORTANT — SELECT EQUIPMENT (screen 1): the Next button starts DISABLED and only enables AFTER you type the Asset ID AND the asset data (VIN/Make/Model) finishes auto-populating. Correct sequence for step 1: type the Asset ID into the equipment field, THEN emit ONE { "type": "clickNext" } as the LAST action — it waits for the button to enable on its own. Do NOT emit several clicks; do NOT click before typing the ID.
- If your previous turn was a click/clickNext on Next and the page did NOT advance (you'll see a NOTE saying so, or a clickNext result with noEffect/disabled), the required field for THIS step is not satisfied yet. Do NOT click Next again. Instead fill the missing field the page shows, or if everything looks filled emit a single { "type": "wait", "duration": 2000 } to let it settle, then clickNext once.
- The primaryButton field in CURRENT PAGE STATE tells you the Next/Submit button's text, whether it is disabled, and whether it's in view. If primaryButton.disabled is true, a REQUIRED FIELD on this step is not filled yet — fill it; do NOT try to click Next. Never click a disabled button.
- If STEP HISTORY says "the previous action did NOT change the page", do NOT repeat that action. Either fill a missing required field, or use clickNext (which handles scrolling + enabled-wait), or emit a single { "type": "wait", "duration": 1500 } if the page still looks like it's loading.
- For combobox inputs (role="combobox"): type the value using charByChar:true with charDelay:80, then use a waitForOption action with a generous timeout (8000ms or more -- AAP's dropdown can be slow to render, don't give up early) to wait for the dropdown, then click the matching option.
- If a field is already filled correctly, skip it and move on.
- For radio buttons: use action type "radio" with the label text.
- If a modal is visible, handle it first (e.g., click Confirm).
- If page is loading, respond with a single "wait" action.
- If you see errors, note them and try to fix.
- After filling all fields on the page, advance with clickNext as the last action.
- If this is the confirmation/success page (WR ID visible), respond with DONE.

RESPOND WITH A JSON ARRAY OF ACTIONS. Each action is an object:
- { "type": "clickNext" } ← ALWAYS use this to advance (scrolls to Next, waits for enabled, clicks, verifies). Optionally { "type": "clickNext", "label": "Continue" }
- { "type": "click", "target": { "text": "Some option" } } ← for non-nav clicks (options, checkboxes)
- { "type": "type", "target": { "id": "wr-title" }, "value": "CEL on - Engine fault", "clear": true }
- { "type": "type", "target": { "placeholder": "Enter Asset ID" }, "value": "T-8821", "charByChar": true, "charDelay": 80 }
- { "type": "radio", "value": "Unsafe to Move" }
- { "type": "select", "target": { "idx": 5 }, "value": "Tires" }
- { "type": "waitForOption", "value": "T-8821", "timeout": 8000 }
- { "type": "wait", "duration": 2000 }
- { "type": "DONE", "workRequestId": "WR-12345" } ← ONLY when a WR confirmation/ID is actually shown after a real submit
- { "type": "DONE_REVIEW" } ← when everything is filled and you're on the final Review/Submit page but must NOT submit (default) — hand off to the user

PAST LESSONS FROM PREVIOUS ATTEMPTS:
${lessonContext}

RESPOND WITH ONLY THE JSON ARRAY. No explanation, no markdown, no code fences.`;
}

// ═══════════════════════════════════════════════════════════════
// MAIN AGENT LOOP
// ═══════════════════════════════════════════════════════════════

// Watch user interactions and learn from corrections
const WATCH_SCRIPT = `
(function() {
  if (window.__fleetWatching) return 'already_watching';
  window.__fleetWatching = true;
  window.__fleetUserActions = [];
  
  document.addEventListener('click', (e) => {
    const el = e.target.closest('button, [role="button"], [role="option"], [role="radio"], input, select, a, [role="combobox"]');
    if (!el) return;
    const label = el.getAttribute('aria-label') || el.innerText || el.placeholder || el.id || '';
    window.__fleetUserActions.push({
      type: 'click',
      tag: el.tagName.toLowerCase(),
      label: label.trim().substring(0, 80),
      role: el.getAttribute('role') || el.type || '',
      id: el.id || '',
      ts: Date.now()
    });
  }, true);
  
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT')) return;
    window.__fleetUserActions.push({
      type: 'input',
      tag: el.tagName.toLowerCase(),
      label: el.getAttribute('aria-label') || el.placeholder || el.id || '',
      value: el.value.substring(0, 50),
      id: el.id || '',
      ts: Date.now()
    });
  }, true);
  
  return 'watching';
})();
`;

// Collect what user did
const COLLECT_SCRIPT = `
(function() {
  const actions = window.__fleetUserActions || [];
  window.__fleetUserActions = [];
  return JSON.stringify(actions);
})();
`;

// FEATURE (2026-07-22): lesson-quality helpers. Real evidence pulled from
// the accumulated aapLessons store showed two concrete quality problems:
//   1. Page-hint bucketing used the first 50 chars of raw page text, which
//      is dominated by generic chrome ("Dark mode | Contact us | New
//      Unplanned Request for...") that renders IDENTICALLY on nearly every
//      wizard screen -- so almost all lessons collapsed into one
//      meaningless bucket, making "PAST LESSONS" barely relevant to
//      whichever screen the agent is actually on.
//   2. Low-information duplicate entries (bare "click WORKED" with no
//      detail on what was clicked) filled the capped 50-slot buffer,
//      crowding out rarer, more informative failure lessons.
// _stepTag() matches known screen names from the real wizard SOP
// (aap_wizard_knowledge.js) instead of blindly truncating; _describeActions
// includes the actual click/type target text where available.
const KNOWN_SCREEN_TAGS = [
  'Select Equipment', 'Location', 'Work Request Details', 'Asset Condition',
  'Issue Details', 'Comments', 'Review', 'Submit', 'Vendor',
];
function _stepTag(pageText) {
  const hit = KNOWN_SCREEN_TAGS.find(tag => pageText.toUpperCase().includes(tag.toUpperCase()));
  return hit || pageText.substring(0, 40);
}
function _describeActions(actions) {
  return actions.map(a => {
    const target = (a.target && (a.target.text || a.target.id || a.target.placeholder)) || '';
    const val = a.value ? '=' + String(a.value).substring(0, 30) : '';
    return a.type + (target ? ' [' + target + ']' : '') + val;
  }).join(', ');
}

// ═══════════════════════════════════════════════════════════════
// PER-STEP RECIPE LEARNING (cautious / self-healing)
// ═══════════════════════════════════════════════════════════════
// The AAP wizard tells us which step we're on (the left-side stepper: "Select
// Equipment", "Asset Condition", "Location", ...). Instead of asking the AI to
// re-derive every step from scratch on every run, we remember the SEQUENCE OF
// ACTIONS that successfully advanced each NAMED step, then replay it on future
// runs — but only after it has proven itself (successCount >= REPLAY_MIN_WINS),
// and always verifying the page actually advanced. If a replay fails, we drop
// that recipe and fall back to the AI, which re-learns it. Keying by step NAME
// (not position) is what makes "sometimes more steps, sometimes fewer" work:
// an unknown step name simply has no recipe and goes to the AI.
//
// Recipes are NOT dumb keystroke macros. Per-unit values (Asset ID, location
// code, issue text) change every run, so on capture we TEMPLATIZE action
// values that match a payload field into {{field}} placeholders, and on replay
// we HYDRATE them back from the CURRENT payload. Structure is reused; values
// are always current.
const REPLAY_MIN_WINS = 2; // cautious: only auto-replay after 2 clean successes
const RECIPE_STORE_KEY = 'aapStepRecipes';
const RECIPE_UNREPLAYABLE_TYPES = new Set(['DONE', 'DONE_REVIEW']);

// Normalize a step name to a stable key (lowercase, collapse whitespace).
function _normStep(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ').substring(0, 60);
}

// Flatten payload into a list of {field, value} for templatizing. Only
// primitive string/number leaves are useful as fill values.
function _payloadPairs(payload) {
  const pairs = [];
  const walk = (obj, prefix) => {
    if (obj == null) return;
    if (Array.isArray(obj)) { obj.forEach((v, i) => walk(v, prefix + '[' + i + ']')); return; }
    if (typeof obj === 'object') { for (const k of Object.keys(obj)) walk(obj[k], prefix ? prefix + '.' + k : k); return; }
    const s = String(obj);
    if (s.length >= 2) pairs.push({ field: prefix, value: s });
  };
  walk(payload || {}, '');
  // Longest values first so we replace the most specific match, not a short
  // substring that happens to collide.
  return pairs.sort((a, b) => b.value.length - a.value.length);
}

// Replace any action value that exactly equals a payload value with a
// {{field}} placeholder, so the recipe is unit-agnostic.
function _templatizeActions(actions, payload) {
  const pairs = _payloadPairs(payload);
  const byValue = new Map();
  pairs.forEach(p => { if (!byValue.has(p.value)) byValue.set(p.value, p.field); });
  return actions.map(a => {
    const copy = JSON.parse(JSON.stringify(a));
    if (copy.value !== undefined && copy.value !== null) {
      const v = String(copy.value);
      if (byValue.has(v)) copy.value = '{{' + byValue.get(v) + '}}';
    }
    // Templatize a target's text/value the same way (e.g. a location code
    // typed into a combobox target).
    if (copy.target && typeof copy.target === 'object') {
      for (const key of ['text', 'value']) {
        if (copy.target[key] && byValue.has(String(copy.target[key]))) {
          copy.target[key] = '{{' + byValue.get(String(copy.target[key])) + '}}';
        }
      }
    }
    return copy;
  });
}

// Resolve a dotted/bracketed field path against the payload.
function _resolvePath(payload, path) {
  try {
    return path.split('.').reduce((o, seg) => {
      const m = seg.match(/^(.+?)\[(\d+)\]$/);
      if (m) return o == null ? undefined : o[m[1]][Number(m[2])];
      return o == null ? undefined : o[seg];
    }, payload);
  } catch (e) { return undefined; }
}

// Fill {{field}} placeholders in a stored recipe from the CURRENT payload.
// Returns { actions, ok }. ok=false if any placeholder can't be resolved (a
// required per-unit value is missing) — in that case we must NOT replay, and
// let the AI handle the step live.
function _hydrateActions(templateActions, payload) {
  let ok = true;
  const fill = (val) => {
    if (typeof val !== 'string') return val;
    const m = val.match(/^\{\{(.+)\}\}$/);
    if (!m) return val;
    const resolved = _resolvePath(payload, m[1]);
    if (resolved === undefined || resolved === null || String(resolved).length === 0) { ok = false; return val; }
    return String(resolved);
  };
  const actions = templateActions.map(a => {
    const copy = JSON.parse(JSON.stringify(a));
    if (copy.value !== undefined) copy.value = fill(copy.value);
    if (copy.target && typeof copy.target === 'object') {
      for (const key of ['text', 'value']) if (copy.target[key] !== undefined) copy.target[key] = fill(copy.target[key]);
    }
    return copy;
  });
  return { actions, ok };
}

function _loadRecipes(store) {
  const r = store.load(RECIPE_STORE_KEY, {});
  return (r && typeof r === 'object') ? r : {};
}
function _saveRecipes(store, recipes) { store.save(RECIPE_STORE_KEY, recipes); }

async function runAdaptiveWR(payload, askAI, log, opts) {
  if (!log) log = console.log;
  opts = opts || {};
  // autoSubmit controls whether the agent is allowed to click the final
  // Submit button. Default FALSE per the user's spec: fill the whole wizard
  // reading the live page each step, then STOP at Review and hand off — never
  // submit unless explicitly told to. Set autoSubmit:true to let it submit.
  const autoSubmit = opts.autoSubmit === true;
  log('[AdaptiveWR] Starting for unit: ' + (payload.unit || payload.asset_id) + ' | autoSubmit=' + autoSubmit);
  
  const aapUrl = 'https://aap-na.corp.amazon.com/v2/page/891a81dc-538d-4f10-be93-441545840a24';
  
  // Open AAP in a BrowserWindow
  const win = new BrowserWindow({
    width: 1280, height: 900,
    title: '\u{1F9E0} AAP Work Request \u2014 ' + (payload.unit || ''),
    show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  // Workflow Intelligence: attach capture if a recording is currently in
  // progress -- this is THE window a user manually finishes a WR in after
  // the AI loop gets stuck or picks the wrong option (confirmed real cases:
  // wrong Asset Condition, missed Title). Capturing what the human actually
  // did here, across a few real runs (standard repair / tow / dealer-routed),
  // is what feeds the recorded-replay engine this is being built towards.
  // Observation-only -- see action_capture.js's header for the safety note.
  try {
    const { getActiveSessionId } = require('../ipc/workflow-intel');
    const activeSession = getActiveSessionId();
    if (activeSession) {
      const { attachCapture } = require('../window/action_capture');
      attachCapture(win, activeSession);
    }
  } catch (e) {
    log('[AdaptiveWR] Workflow Intelligence capture attach failed: ' + e.message);
  }

  // FIX (2026-07-23): if AAP's wizard form has an unsaved-changes guard,
  // Electron's default behavior on window close is to run the page's
  // beforeunload handler and show a native "Leave Site?" confirm dialog --
  // which can render behind/off the visible window, making the close (X)
  // button look like it's just not working. This is a user-initiated abort
  // of an in-progress automation, not a real navigation with real user
  // data at risk, so always allow the close through immediately.
  win.webContents.on('will-prevent-unload', (event) => { event.preventDefault(); });

  win.loadURL(aapUrl);
  log('[AdaptiveWR] AAP window opened, waiting for load...');
  
  // Wait for initial page load
  await new Promise(resolve => {
    win.webContents.on('did-finish-load', () => resolve());
    setTimeout(resolve, PAGE_LOAD_TIMEOUT_MS); // L-3: named constant replaces magic number
  });
  await sleep(3000); // Extra wait for React to render
  
  const stepHistory = [];
  
  // Load past lessons (what worked/failed before)
  const store = require('../store');
  const lessons = store.load('aapLessons', []);
  const lessonContext = lessons.length > 0
    ? '\nPAST LESSONS (what worked before on this wizard):\n' + lessons.slice(-15).map(l => '- ' + l).join('\n') + '\n'
    : '';

  // Per-step recipes — proven action sequences keyed by step name. Loaded once
  // per run; replayed (task #2) and updated on success (task #3).
  const recipes = _loadRecipes(store);
  // Snapshot the wizard step-identity so we can tell if a set of executed
  // actions actually ADVANCED the wizard (moved off the current step) rather
  // than merely running without error. Mirrors _pageSig's step-identity logic.
  const _stepIdentity = (s) => (s && (s.currentStep || '')) + '::' + ((s && s.url) || '');
  // Re-snapshot and report whether the wizard advanced off `beforeIdentity`.
  const _didAdvance = async (beforeIdentity) => {
    // Give the page up to ~5s to transition (a step change can render slowly).
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      await sleep(400);
      try {
        const raw = await win.webContents.executeJavaScript(SNAPSHOT_SCRIPT);
        const s = JSON.parse(raw);
        if (_stepIdentity(s) !== beforeIdentity) return true;
      } catch (e) {}
    }
    return false;
  };
  let maxSteps = 30; // Safety limit
  let step = 0;
  let result = { ok: false, error: 'Max steps reached' };
  // Stuck detection: if the page signature (step + URL + text + element
  // fingerprint) doesn't change across consecutive turns, the AI is repeating
  // an action that isn't advancing the wizard. Bail to WATCH MODE after a few
  // no-progress turns instead of burning all 30 steps clicking into the void.
  let _prevSig = '';
  let _noProgress = 0;
  // STUCK SIGNATURE — must reflect "are we still on the SAME wizard step",
  // NOT a byte-exact page fingerprint. Earlier this included pageText and every
  // element's live .value, so async React hydration (e.g. "New Unplanned
  // Request" -> "...for B62060", asset fields filling in) mutated the signature
  // every turn and _noProgress kept resetting to 0 — the loop clicked a
  // dead/off-screen Next 8+ times and stuck detection never fired. Base the
  // signature on step IDENTITY only: which step the stepper shows, the wizard
  // URL, and the STRUCTURE of fields present (tag+id+label — NOT their values,
  // NOT their disabled state, NOT free page text). If that structural identity
  // is unchanged across turns, we're on the same step and not advancing.
  const _pageSig = (s) => {
    if (!s) return '';
    const els = (s.elements || [])
      .map(e => e.tag + ':' + (e.id || e.label || e.text || ''))
      .sort()
      .join('|');
    return (s.currentStep || '') + '::' + (s.url || '') + '::' + els;
  };
  
  while (step < maxSteps) {
    step++;
    log(`[AdaptiveWR] Step ${step}/${maxSteps}`);
    
    // 1. Check if window was closed
    if (win.isDestroyed()) {
      log('[AdaptiveWR] Window closed by user. Aborting.');
      result = { ok: false, error: 'Window closed' };
      break;
    }
    
    // 2. Snapshot the DOM
    let snapshot;
    try {
      const raw = await win.webContents.executeJavaScript(SNAPSHOT_SCRIPT);
      snapshot = JSON.parse(raw);
    } catch (e) {
      log('[AdaptiveWR] Snapshot error: ' + e.message);
      await sleep(2000);
      continue;
    }
    
    // 3. Skip if loading
    if (snapshot.isLoading) {
      log('[AdaptiveWR] Page loading, waiting...');
      await sleep(1500);
      continue;
    }
    
    log(`[AdaptiveWR] Page has ${snapshot.elements.length} elements. Text: ${snapshot.pageText.substring(0, 100)}...`);

    // 3b. STUCK DETECTION — did the last turn's actions change anything?
    const _sig = _pageSig(snapshot);
    if (_sig && _sig === _prevSig) {
      _noProgress++;
      log('[AdaptiveWR] No page change since last step (x' + _noProgress + ')');
      if (_noProgress >= 3) {
        log('[AdaptiveWR] Stuck — page has not advanced in 3 turns. Stopping and handing off to WATCH MODE.');
        result = { ok: false, error: 'Wizard did not advance (stuck on same step). The AAP window is open — finish this step manually (e.g. scroll down and click Next); the agent will learn from what you do.' };
        break;
      }
    } else {
      _noProgress = 0;
    }
    _prevSig = _sig;
    // Tell the AI, in-band, that its last action didn't move the page so it
    // tries something different (e.g. clickNext / scroll) instead of repeating.
    if (_noProgress > 0) {
      stepHistory.push('NOTE: the previous action did NOT change the page — do NOT repeat it. If you need to advance, use {"type":"clickNext"} (it scrolls the Next button into view, waits for it to be enabled, and verifies the page changed). If a required field is still empty, fill it first.');
    }

    // 3c. PER-STEP RECIPE REPLAY (cautious) — if we've already learned a proven
    // recipe for THIS named step, replay it directly instead of asking the AI.
    // This is what makes repeat runs fast: a perfected step is recognized by
    // name and executed without guessing. Guarded heavily:
    //   - only when we can identify the step name (from the stepper),
    //   - only after the recipe has succeeded REPLAY_MIN_WINS times,
    //   - only if every {{payload}} placeholder resolves for THIS unit,
    //   - never for Review/Submit in no-submit mode (let the stop-logic handle it),
    //   - always verified: if the page doesn't advance, the recipe is dropped
    //     and we fall through to the AI, which re-learns it.
    const _stepKey = _normStep(snapshot.currentStep);
    const _recipe = _stepKey ? recipes[_stepKey] : null;
    const _reviewish = /review|submit/.test(_stepKey);
    if (_recipe && _recipe.actions && (_recipe.successCount || 0) >= REPLAY_MIN_WINS && !_reviewish) {
      const { actions: hydrated, ok: hydratedOk } = _hydrateActions(_recipe.actions, payload);
      if (!hydratedOk) {
        log(`[AdaptiveWR] Recipe for "${snapshot.currentStep}" needs a value this unit doesn't have — using AI for this step.`);
      } else {
        log(`[AdaptiveWR] ▶ Replaying learned recipe for "${snapshot.currentStep}" (wins=${_recipe.successCount}) — no AI needed.`);
        const _beforeId = _stepIdentity(snapshot);
        let replayResults = [];
        try {
          const rawR = await win.webContents.executeJavaScript(buildActionScript(hydrated));
          replayResults = JSON.parse(rawR);
        } catch (e) {
          log('[AdaptiveWR] Recipe execution error: ' + e.message);
        }
        const replaySummary = replayResults.map(r => `${r.action}:${r.ok ? '✓' : '✗'}`).join(', ');
        const advanced = await _didAdvance(_beforeId);
        if (advanced) {
          _recipe.successCount = (_recipe.successCount || 0) + 1;
          _recipe.lastUsed = Date.now();
          recipes[_stepKey] = _recipe;
          _saveRecipes(store, recipes);
          stepHistory.push(`Step ${step}: [recipe replay] "${snapshot.currentStep}" → ${replaySummary} → advanced`);
          log(`[AdaptiveWR] ✓ Recipe advanced "${snapshot.currentStep}".`);
          await sleep(1500);
          continue; // step done without an AI call
        }
        // Recipe didn't advance the wizard — it's stale (page changed). Drop it
        // and fall through to the AI to re-learn this step.
        log(`[AdaptiveWR] ✗ Recipe for "${snapshot.currentStep}" did not advance — discarding and asking AI.`);
        delete recipes[_stepKey];
        _saveRecipes(store, recipes);
        stepHistory.push(`NOTE: a saved shortcut for "${snapshot.currentStep}" failed and was discarded; figure this step out fresh from the live page.`);
      }
    }

    // 4. Ask Orcha what to do
    const prompt = buildPrompt(snapshot, payload, stepHistory, lessonContext, autoSubmit);
    let aiResponse;
    try {
      log('[AdaptiveWR] Asking Orcha...');
      const aiResult = await askAI(prompt);
      aiResponse = (aiResult && aiResult.text) ? aiResult.text.trim() : (typeof aiResult === 'string' ? aiResult.trim() : '');
    } catch (e) {
      log('[AdaptiveWR] Orcha error: ' + e.message);
      await sleep(2000);
      continue;
    }
    
    // 5. Parse Orcha's response
    let actions;
    try {
      // Strip markdown code fences if present
      let cleaned = aiResponse.replace(/```json?\s*/g, '').replace(/```\s*/g, '').trim();
      actions = JSON.parse(cleaned);
    } catch (e) {
      log('[AdaptiveWR] Failed to parse Orcha response: ' + aiResponse.substring(0, 200));
      stepHistory.push('ERROR: Could not parse AI response');
      await sleep(1000);
      continue;
    }
    
    // 6a. DONE_REVIEW — AI filled everything and stopped at Review without
    // submitting (the default, no-auto-submit flow). Hand off to the user.
    const reviewAction = actions.find(a => a.type === 'DONE_REVIEW');
    if (reviewAction) {
      log('[AdaptiveWR] Filled and stopped at Review — handing off for manual submit.');
      result = {
        ok: true,
        workRequestId: 'READY-TO-SUBMIT',
        readyToSubmit: true,
        message: 'Work Request is filled and ready in the AAP window — review it and click Submit to finish. Nothing was submitted automatically.',
      };
      break;
    }

    // 6b. Check for DONE signal (AI saw a real confirmation/WR-ID page after submit)
    const doneAction = actions.find(a => a.type === 'DONE');
    if (doneAction) {
      log('[AdaptiveWR] ✅ DONE! WR ID: ' + (doneAction.workRequestId || 'unknown'));
      result = { ok: true, workRequestId: doneAction.workRequestId || 'SUBMITTED' };
      break;
    }

    // NO-SUBMIT STOP (default). Per the user's spec, the agent fills the whole
    // wizard reading the live page each step, but must NOT submit unless
    // autoSubmit was explicitly requested. If this step's actions include a
    // click on the final Submit button, intercept it: stop one click short,
    // leave the fully-filled Review page open, and report "ready to submit".
    // The AKI_DRY_RUN_WR=1 env var forces this behavior too (test safety net).
    if (!autoSubmit || process.env.AKI_DRY_RUN_WR === '1') {
      const submitAction = actions.find(a => {
        if (!/^click$/i.test(a.type || '')) return false;
        const t = a.target || {};
        const label = String(t.text || t.id || t.placeholder || t.ariaLabel || '').toLowerCase();
        // Match the final submit button, not "Save & Continue"/"Next".
        return /\bsubmit\b/.test(label) && !/save|continue|next/.test(label);
      });
      if (submitAction) {
        log('[AdaptiveWR] Filled and stopped at Review — NOT submitting (autoSubmit=' + autoSubmit + '). Review the AAP window and click Submit yourself.');
        result = {
          ok: true,
          workRequestId: 'READY-TO-SUBMIT',
          readyToSubmit: true,
          message: 'Work Request is filled and ready in the AAP window — review it and click Submit to finish. Nothing was submitted automatically.',
        };
        break;
      }
    }

    // 7. Execute actions
    log(`[AdaptiveWR] Executing ${actions.length} actions...`);
    // Capture the step identity BEFORE executing so we can tell (section 8b) if
    // these AI-derived actions actually advanced the wizard — the trigger for
    // saving them as this step's recipe.
    const _learnStepName = snapshot.currentStep || '';
    const _learnBeforeId = _stepIdentity(snapshot);
    let actionResults;
    try {
      const execScript = buildActionScript(actions);
      const rawResults = await win.webContents.executeJavaScript(execScript);
      actionResults = JSON.parse(rawResults);
    } catch (e) {
      log('[AdaptiveWR] Execution error: ' + e.message);
      stepHistory.push('ERROR executing: ' + e.message);
      await sleep(2000);
      continue;
    }
    
    // 8. Log results
    const summary = actionResults.map(r => `${r.action}:${r.ok ? '✓' : '✗ ' + (r.error || '')}`).join(', ');
    log(`[AdaptiveWR] Results: ${summary}`);
    stepHistory.push(`Step ${step}: ${actions.map(a => a.type + (a.value ? '=' + String(a.value).substring(0, 20) : '')).join(', ')} → ${summary}`);
    
    // Learn from results
    // FEATURE (2026-07-22): rewritten for lesson quality -- see the
    // _stepTag/_describeActions helpers above for the full rationale
    // (generic page-hint collisions + low-info duplicate entries were
    // drowning out the few genuinely useful lessons in the capped buffer).
    const stepTag = _stepTag(snapshot.pageText);
    const allOk = actionResults.every(r => r.ok);
    if (allOk && actions.length > 0) {
      const lesson = 'On "' + stepTag + '": ' + _describeActions(actions) + ' WORKED';
      if (lessons[lessons.length - 1] !== lesson) { // dedup exact repeats
        lessons.push(lesson);
        if (lessons.length > 50) lessons.splice(0, lessons.length - 50);
        store.save('aapLessons', lessons);
      }
    } else {
      const failedActions = actionResults.filter(r => !r.ok);
      if (failedActions.length > 0) {
        // FEATURE (2026-07-22): if every failure is tagged timeoutLikely
        // (see waitForOption above), the real fix is almost always "wait
        // longer and retry the same approach" -- NOT a different
        // approach. The old blanket "TRY DIFFERENT APPROACH" message was
        // actively misleading for this common case, confirmed by real
        // evidence of the same action succeeding and failing across runs.
        const allTimeouts = failedActions.every(r => r.timeoutLikely);
        const advice = allTimeouts
          ? '- LIKELY JUST NEEDS A LONGER WAIT: retry the SAME approach with a longer waitForOption timeout (10000ms+), do not switch strategy'
          : '- TRY DIFFERENT APPROACH';
        const lesson = 'On "' + stepTag + '": ' + failedActions.map(r => r.action + ' FAILED: ' + (r.error || '')).join(', ') + ' ' + advice;
        if (lessons[lessons.length - 1] !== lesson) {
          lessons.push(lesson);
          if (lessons.length > 50) lessons.splice(0, lessons.length - 50);
          store.save('aapLessons', lessons);
        }
      }
    }

    // 8b. LEARN A PER-STEP RECIPE (task #3). If these AI-derived actions ran
    // cleanly AND actually advanced the wizard off this step, remember the
    // sequence as the recipe for this named step so future runs can replay it
    // without an AI call. We templatize per-unit values into {{payload}}
    // placeholders so the recipe is unit-agnostic. Confidence builds up over
    // runs (successCount); replay only kicks in at REPLAY_MIN_WINS (see 3c).
    // Skipped for Review/Submit (no advance there) and when the step name is
    // unknown (can't key a recipe reliably).
    const _learnKey = _normStep(_learnStepName);
    const _learnReviewish = /review|submit/.test(_learnKey);
    if (_learnKey && !_learnReviewish && allOk && actions.length > 0) {
      // Only worth learning if these actions moved the wizard forward.
      const advancedForLearning = await _didAdvance(_learnBeforeId);
      if (advancedForLearning) {
        const template = _templatizeActions(actions, payload);
        const existing = recipes[_learnKey];
        // If the templatized sequence matches what we already stored, just bump
        // confidence; otherwise (first time, or the step's flow changed) store
        // the new sequence and reset confidence to 1.
        const sameAsStored = existing && JSON.stringify(existing.actions) === JSON.stringify(template);
        recipes[_learnKey] = {
          actions: template,
          successCount: sameAsStored ? (existing.successCount || 0) + 1 : 1,
          lastUsed: Date.now(),
          unitHint: payload.unit || payload.asset_id || '',
        };
        _saveRecipes(store, recipes);
        log(`[AdaptiveWR] 📗 Learned recipe for "${_learnStepName}" (wins=${recipes[_learnKey].successCount}${recipes[_learnKey].successCount >= REPLAY_MIN_WINS ? ' — will auto-replay next time' : ', needs ' + (REPLAY_MIN_WINS - recipes[_learnKey].successCount) + ' more to auto-replay'}).`);
      }
    }

    // 9. Wait for page to react
    // FIX (2026-07-23): a flat 1.5s wait was sometimes not enough for a
    // wizard step transition (e.g. Asset Condition -> next step) to finish
    // rendering before the next snapshot was taken, which could re-read the
    // same still-settling page and effectively get the loop stuck retrying
    // the same step. Give navigation-style clicks (Next/Continue/Save &
    // Continue/Proceed) extra time to land.
    const clickedNav = actions.some(a => a.type === 'clickNext' || (a.type === 'click' &&
      /\b(next|continue|proceed|save\s*&?\s*continue)\b/i.test((a.target && a.target.text) || '')));
    await sleep(clickedNav ? 3500 : 1500);
  }
  
  // Close window after a delay (let user see confirmation)
  if (!win.isDestroyed()) {
    if (result.ok) {
      log('[AdaptiveWR] Success! Window stays open for review.');
    } else {
      // BUG FIX (2026-07-16): a 'GOT STUCK after 0 steps' lessons.push() used
      // to sit right after `let step = 0;` ABOVE the while loop, firing
      // unconditionally on EVERY single call to runAdaptiveWR -- success or
      // failure -- always claiming "0 steps" since step hadn't incremented
      // yet. This polluted the 'aapLessons' store (capped at 50 entries,
      // fed directly into every future prompt as "PAST LESSONS") with a
      // false negative signal on every run, which could crowd out real
      // learned lessons quickly. Moved the real stuck-logging to here --
      // the actual failure branch, with the real step count and real last
      // page from stepHistory.
      lessons.push('GOT STUCK after ' + step + ' steps. Last page: ' + (stepHistory[stepHistory.length - 1] || 'unknown'));
      if (lessons.length > 50) lessons.splice(0, lessons.length - 50);
      store.save('aapLessons', lessons);
      log('[AdaptiveWR] Failed: ' + result.error + '. Switching to WATCH MODE - complete the form manually and I will learn.');
      
      // Start watching user actions
      try { await win.webContents.executeJavaScript(WATCH_SCRIPT); } catch(e) {}
      
      // Poll for user actions every 5 seconds for 3 minutes
      let watchTime = 0;
      const watchInterval = setInterval(async () => {
        watchTime += 5000;
        if (win.isDestroyed() || watchTime > 180000) {
          clearInterval(watchInterval);
          return;
        }
        try {
          const raw = await win.webContents.executeJavaScript(COLLECT_SCRIPT);
          const userActions = JSON.parse(raw);
          if (userActions.length > 0) {
            const pageText = await win.webContents.executeJavaScript('document.title + " | " + (document.querySelector("h1,h2,h3") || {}).innerText || ""');
            userActions.forEach(action => {
              const lesson = 'USER CORRECTION on "' + (pageText || '').substring(0, 40) + '": ' + action.type + ' ' + action.tag + ' label="' + action.label + '"' + (action.value ? ' value="' + action.value + '"' : '');
              lessons.push(lesson);
              log('[AdaptiveWR] Learned: ' + lesson);
            });
            if (lessons.length > 50) lessons.splice(0, lessons.length - 50);
            store.save('aapLessons', lessons);
          }
        } catch(e) {}
      }, 5000);
    }
  }
  
  return { ...result, steps: step, history: stepHistory };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { runAdaptiveWR };

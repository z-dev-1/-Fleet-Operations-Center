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
  
  interactives.forEach((el, idx) => {
    // Skip hidden elements
    if (el.offsetParent === null && el.type !== 'file' && !el.closest('[role="dialog"]')) return;
    
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
      visible: el.offsetParent !== null || el.type === 'file'
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
    try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(e) {}
    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(type => {
      try {
        el.dispatchEvent(type.startsWith('pointer')
          ? new PointerEvent(type, { bubbles: true, cancelable: true })
          : new MouseEvent(type, { bubbles: true, cancelable: true }));
      } catch(e) {}
    });
    try { el.click(); el.focus(); } catch(e) {}
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
        if (el) { fullClick(el); results.push({ ok: true, action: 'click', target: action.target.text || action.target.id || 'idx:' + action.target.idx }); }
        else results.push({ ok: false, action: 'click', error: 'Element not found', target: action.target });
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
        const target = String(action.value).trim().toUpperCase();
        let found = null;
        const t0 = Date.now();
        while (!found && Date.now() - t0 < (action.timeout || 5000)) {
          const opts = document.querySelectorAll('[role="option"], button[role="option"]');
          for (const o of opts) {
            const ot = (o.innerText || o.textContent || o.getAttribute('aria-label') || '').trim().toUpperCase();
            if (ot === target || ot.includes(target) || target.includes(ot)) { found = o; break; }
          }
          if (!found) await sleep(100);
        }
        if (found) { fullClick(found); results.push({ ok: true, action: 'waitForOption', value: action.value }); }
        else results.push({ ok: false, action: 'waitForOption', error: 'Option not found: ' + action.value });
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
function buildPrompt(snapshot, payload, stepHistory) {
  return `You are Orcha, filling out an AAP (Amazon Asset Portal) Work Request wizard. You can see the current page state below.

YOUR GOAL: Fill all fields on the current page with the correct values from the payload, then click "Next" (or "Submit" on the final page).

PAYLOAD (data to fill):
${JSON.stringify(payload, null, 2)}

CURRENT PAGE STATE:
- URL: ${snapshot.url}
- Page text: ${snapshot.pageText}
- Loading: ${snapshot.isLoading}
- Modal visible: ${snapshot.modalVisible || false}${snapshot.modalText ? '\n- Modal text: ' + snapshot.modalText : ''}
${snapshot.errors ? '- ERRORS: ' + snapshot.errors.join(', ') : ''}
${snapshot.openDropdownOptions ? '- Open dropdown options: ' + snapshot.openDropdownOptions.join(', ') : ''}

INTERACTIVE ELEMENTS:
${snapshot.elements.filter(e => e.visible || e.type === 'file').map(e => 
  `[${e.idx}] ${e.tag} type="${e.type}" id="${e.id}" label="${e.label}" value="${e.value}" text="${e.text}" placeholder="${e.placeholder}" checked=${e.checked} disabled=${e.disabled}${e.options.length ? ' options=[' + e.options.map(o => o.text).join(',') + ']' : ''}`
).join('\n')}

STEP HISTORY (what we've done so far):
${stepHistory.slice(-5).map(h => '- ' + h).join('\n') || '(none yet)'}

AAP WIZARD STEPS (in order):\n- Step 1: Equipment/Asset - type unit ID in combobox, select from dropdown\n- Step 2: Location - select "Off Site" radio button. For GeoFence/domicile combobox: type the domicile code (ABE40, AVP40, etc) and select it. If it asks for address, skip or type the domicile.\n- Step 3: Work Request Details - select Area dropdown (e.g. Engine, Brakes, Electrical, Tires). Select Subcategory. Type the Title/description. Select Urgency if shown.\n- Step 4: Vendor/Assignment - if vendor field shown, select the vendor from dropdown\n- Step 5: Review/Submit - click Submit or Save\n- After submit: success page shows WR ID\n\nWIZARD RULES:
- This is a multi-page wizard. Fill visible fields, then click Next.
- For combobox inputs (role="combobox"): type the value using charByChar:true with charDelay:80, then use waitForOption action to wait for dropdown, then click the matching option.\n- LOCATION STEP: Always click "Off Site" radio first. Then find the GeoFence/Location combobox and type the domicile code from payload (e.g. ABE40). Wait for option then click it. Then click Next.\n- WORK REQUEST DETAILS: Find Area dropdown and select the first areaPair.area. Find Subcategory and select areaPair.subcategory. Type title in the title/description field. Then click Next.\n- If a field is already filled correctly, skip it and move on.
- For radio buttons: use action type "radio" with the label text.
- If a modal is visible, handle it first (e.g., click Confirm).
- If page is loading, respond with a single "wait" action.
- If you see errors, note them and try to fix.
- After filling all fields on the page, ALWAYS click Next/Submit as the last action.
- If this is the confirmation/success page (WR ID visible), respond with DONE.

RESPOND WITH A JSON ARRAY OF ACTIONS. Each action is an object:
- { "type": "click", "target": { "text": "Next" } }
- { "type": "type", "target": { "id": "wr-title" }, "value": "CEL on - Engine fault", "clear": true }
- { "type": "type", "target": { "placeholder": "Enter Asset ID" }, "value": "T-8821", "charByChar": true, "charDelay": 80 }
- { "type": "radio", "value": "Unsafe to Move" }
- { "type": "select", "target": { "idx": 5 }, "value": "Tires" }
- { "type": "waitForOption", "value": "T-8821", "timeout": 8000 }
- { "type": "wait", "duration": 2000 }
- { "type": "DONE", "workRequestId": "WR-12345" } ← when wizard is complete

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

async function runAdaptiveWR(payload, askAI, log) {
  if (!log) log = console.log;
  log('[AdaptiveWR] Starting for unit: ' + (payload.unit || payload.asset_id));
  
  const aapUrl = 'https://aap-na.corp.amazon.com/v2/page/891a81dc-538d-4f10-be93-441545840a24';
  
  // Open AAP in a BrowserWindow
  const win = new BrowserWindow({
    width: 1280, height: 900,
    title: '⚡ AAP Work Request — ' + (payload.unit || ''),
    show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  
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
  let maxSteps = 30; // Safety limit
  let step = 0;
  let result = { ok: false, error: 'Max steps reached' };
  // Save what we got stuck on
  lessons.push('GOT STUCK after ' + step + ' steps. Last page: ' + (stepHistory[stepHistory.length-1] || 'unknown'));
  store.save('aapLessons', lessons);
  
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
    
    // 4. Ask Orcha what to do
    const prompt = buildPrompt(snapshot, payload, stepHistory);
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
    
    // 6. Check for DONE signal
    const doneAction = actions.find(a => a.type === 'DONE');
    if (doneAction) {
      log('[AdaptiveWR] ✅ DONE! WR ID: ' + (doneAction.workRequestId || 'unknown'));
      result = { ok: true, workRequestId: doneAction.workRequestId || 'SUBMITTED' };
      break;
    }
    
    // 7. Execute actions
    log(`[AdaptiveWR] Executing ${actions.length} actions...`);
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
    const allOk = actionResults.every(r => r.ok);
    if (allOk && actions.length > 0) {
      const pageHint = snapshot.pageText.substring(0, 50);
      lessons.push('On page "' + pageHint + '": ' + actions.map(a => a.type + (a.value ? '=' + String(a.value).substring(0, 30) : '')).join(', ') + ' WORKED');
      if (lessons.length > 50) lessons.splice(0, lessons.length - 50);
      store.save('aapLessons', lessons);
    } else {
      const failedActions = actionResults.filter(r => !r.ok);
      if (failedActions.length > 0) {
        const pageHint = snapshot.pageText.substring(0, 50);
        lessons.push('On page "' + pageHint + '": ' + failedActions.map(r => r.action + ' FAILED: ' + (r.error || '')).join(', ') + ' - TRY DIFFERENT APPROACH');
        if (lessons.length > 50) lessons.splice(0, lessons.length - 50);
        store.save('aapLessons', lessons);
      }
    }
    
    // 9. Wait for page to react
    await sleep(1500);
  }
  
  // Close window after a delay (let user see confirmation)
  if (!win.isDestroyed()) {
    if (result.ok) {
      log('[AdaptiveWR] Success! Window stays open for review.');
    } else {
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

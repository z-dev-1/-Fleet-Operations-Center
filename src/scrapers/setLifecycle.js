'use strict';
/**
 * setLifecycle.js
 * Automates the AAP "Modify Asset Lifecycle State" modal for a given unit.
 * Uses the  session (already authenticated).
 *
 * Usage:
 *   const { setLifecycleState } = require('./scrapers/setLifecycle');
 *   await setLifecycleState({ equipmentId: '322168', state: 'Active', reason: '' });
 *   await setLifecycleState({ equipmentId: '322168', state: 'Unavailable', reason: 'Offsite Shop Repair' });
 */

const { BrowserWindow, session } = require('electron');
const logger = require('../utils/logger').createLogger('setLifecycle');

const TIMEOUT_MS = 30000;

function log(...args) { logger.info('[SetLifecycle]', ...args); }

/**
 * @param {object} opts
 * @param {string} opts.equipmentId  - e.g. '322168'
 * @param {string} opts.assetUrl     - full AAP asset URL e.g. https://aap-na.corp.amazon.com/v2/asset/aaid_xxx
 * @param {string} opts.state        - 'Active' | 'Unavailable' | 'End of Life' | 'Ordered'
 * @param {string} [opts.reason]     - lifecycle reason e.g. 'Healthy', 'Offsite Shop Repair'
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function setLifecycleState({ equipmentId, assetUrl, state, reason }) {
  if (!assetUrl) {
    return { success: false, message: 'Asset URL not available — re-sync the app to fetch the AAP asset URL for this unit, then try again.' };
  }
  const url = assetUrl;
  log('Starting lifecycle change for', equipmentId, '->', state, reason ? '(' + reason + ')' : '', '| url:', url.slice(0, 80));

  return new Promise((resolve) => {
    const ses = session.defaultSession;
    let settled = false;

    const win = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      width: 1400,
      height: 900,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        session: ses,
      },
    });

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { win.destroy(); } catch(_) {}
      resolve(result);
    };

    const timer = setTimeout(() => {
      done({ success: false, message: 'Timeout: page did not respond in time' });
    }, TIMEOUT_MS);

    win.webContents.on('console-message', (_, level, msg, line) => {
      // level: 0=verbose,1=info,2=warn,3=error — log everything from our [LC] prefix + all warnings/errors
      if (level >= 2 || msg.startsWith('[LC]') || msg.startsWith('[POST-TAB')) {
        console.log('[SetLifecycle-WIN]', msg.slice(0, 200));
      }
    });

    win.webContents.on('did-finish-load', async () => {
      const curUrl = win.webContents.getURL();
      log('Page loaded:', curUrl.slice(0, 80));

      // Must be on AAP domain
      if (!/aap-na\.corp\.amazon\.com/i.test(curUrl)) {
        log('Not on AAP yet (auth redirect?) — waiting...');
        return; // will fire again after redirect chain settles
      }

      // Give React time to mount (Location tab loads first, then we'll switch tabs)
      await sleep(3000);

      try {
        const fs = require('fs'), path = require('path'), os = require('os');
        const logPath = path.join(os.homedir(), 'AppData', 'Roaming', 'fleet-status-app', 'relay-debug.log');

        // BTN DUMP fires INSIDE the automation script, AFTER the Asset Details tab click,
        // so we see exactly what's on screen when findPencilBtn() runs.
        // The automation script logs its own post-tab-click dump via console.log.

        const result = await win.webContents.executeJavaScript(
          buildAutomationScript(state, reason)
        );
        log('Automation result:', JSON.stringify(result));
        fs.appendFileSync(logPath, '[SetLifecycle] Result: ' + JSON.stringify(result) + '\n');
        done(result);
      } catch(e) {
        log('executeJavaScript error:', e.message);
        done({ success: false, message: 'Script error: ' + e.message });
      }
    });

    // Navigate to the Overview tab — the lifecycle edit pencil lives in the
    // asset header on the Overview/default tab, NOT on Attributes or Location.
    const baseUrl = url.split('?')[0];
    log('Navigating to asset page:', baseUrl.slice(0, 80));
    win.loadURL(baseUrl);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Builds the in-page automation script as a string.
 * Runs inside the AAP renderer context.
 */
function buildAutomationScript(targetState, targetReason) {
  return `
(async function() {
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function findButton(labelText) {
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    return btns.find(b => (b.textContent || '').trim().toLowerCase().includes(labelText.toLowerCase())) || null;
  }

  function findPencilBtn() {
    // Strategy 1: aria-label or data-testid
    var ariaSelectors = [
      'button[aria-label*="edit" i]',
      'button[aria-label*="modify" i]',
      'button[aria-label*="lifecycle" i]',
      '[data-testid*="edit-lifecycle"]',
      '[data-testid*="modify-lifecycle"]',
    ];
    for (var s = 0; s < ariaSelectors.length; s++) {
      var el = document.querySelector(ariaSelectors[s]);
      if (el) return el;
    }

    // Strategy 2: find an element whose text exactly matches a lifecycle state,
    // then walk up its ancestor chain looking for a sibling icon-only SVG button.
    // Uses TreeWalker instead of XPath to avoid XPathResult global issues.
    var stateLabels = ['Unavailable', 'Active', 'Ordered', 'End of Life'];
    var walker = document.body ? document.createTreeWalker(document.body, 0x4 /* NodeFilter.SHOW_TEXT */, null, false) : null;
    var stateEl = null;
    if (walker) {
      var nd;
      outer: while ((nd = walker.nextNode())) {
        var txt = (nd.nodeValue || '').trim();
        for (var ls = 0; ls < stateLabels.length; ls++) {
          if (txt === stateLabels[ls]) {
            stateEl = nd.parentElement;
            break outer;
          }
        }
      }
    }
    if (stateEl) {
      var node = stateEl.parentElement;
      for (var d = 0; d < 5 && node; d++, node = node.parentElement) {
        var btns2 = Array.from(node.querySelectorAll('button'));
        var pencil2 = btns2.find(function(b) {
          var t = (b.textContent || '').trim();
          return t.length < 3 && b.querySelector('svg');
        });
        if (pencil2) return pencil2;
      }
    }

    // Strategy 3: css-1k5y1ng class (observed in both Attributes and Overview BTN DUMPs)
    // There may be two of them — pick the one NOT inside a map/canvas wrapper
    var byClass = Array.from(document.querySelectorAll('button.css-1k5y1ng'));
    for (var bc = 0; bc < byClass.length; bc++) {
      var inMap = false;
      var p = byClass[bc].parentElement;
      for (var depth = 0; depth < 8 && p; depth++, p = p.parentElement) {
        var cls = (p.className || '').toLowerCase();
        if (cls.indexOf('map') !== -1 || cls.indexOf('canvas') !== -1 || cls.indexOf('marker') !== -1) {
          inMap = true; break;
        }
      }
      if (!inMap) return byClass[bc];
    }

    // Strategy 4: first icon-only SVG button after "Utilization" button
    // (BTN DUMP shows Utilization at index 8, then icon buttons at 10-12)
    var allBtns = Array.from(document.querySelectorAll('button'));
    var utilIdx = -1;
    for (var i = 0; i < allBtns.length; i++) {
      if ((allBtns[i].textContent || '').trim().toLowerCase() === 'utilization') {
        utilIdx = i; break;
      }
    }
    if (utilIdx !== -1) {
      for (var j = utilIdx + 1; j < Math.min(utilIdx + 6, allBtns.length); j++) {
        var txt = (allBtns[j].textContent || '').trim();
        if (txt.length < 3 && allBtns[j].querySelector('svg')) return allBtns[j];
      }
    }

    return null;
  }

  // ── Dropdown helpers ────────────────────────────────────────────────────
  // AAP uses Chakra UI custom dropdowns (not native <select>).
  // Strategy: click the trigger button to open the listbox, then click the
  // matching option element by text.

  function findDropdownTrigger(labelText, modalEl) {
    // 1. Find a label matching labelText inside the modal
    var labels = Array.from((modalEl || document).querySelectorAll(
      'label, [class*="label"], [id*="label"]'
    ));
    var lbl = labels.find(function(l) {
      return (l.textContent || '').trim().toLowerCase().includes(labelText.toLowerCase());
    });

    if (lbl) {
      // Walk up to form-control / field container (max 4 levels)
      var container = lbl.parentElement;
      for (var d = 0; d < 4 && container; d++) {
        // Native select
        var nativeSel = container.querySelector('select');
        if (nativeSel) return { el: nativeSel, isNative: true };
        // Chakra button trigger: role=combobox, or a button with class containing "select"
        var trigger = container.querySelector(
          '[role="combobox"], button[aria-haspopup], button[aria-expanded]'
        );
        if (trigger) return { el: trigger, isNative: false };
        container = container.parentElement;
      }
    }

    // 2. Fallback: grab all dropdowns inside modal in order
    //    First one = state, second one = reason
    if (modalEl) {
      var allTriggers = Array.from(modalEl.querySelectorAll(
        'select, [role="combobox"], button[aria-haspopup="listbox"]'
      ));
      console.log('[LC] fallback triggers in modal: ' + allTriggers.length);
      if (labelText.toLowerCase().includes('reason') && allTriggers.length >= 2) {
        var t = allTriggers[1];
        return { el: t, isNative: t.tagName === 'SELECT' };
      }
      if (allTriggers.length >= 1) {
        var t2 = allTriggers[0];
        return { el: t2, isNative: t2.tagName === 'SELECT' };
      }
    }
    return null;
  }

  async function setDropdownValue(labelText, value, modalEl) {
    var found = findDropdownTrigger(labelText, modalEl);
    if (!found) {
      console.log('[LC] setDropdownValue: no trigger found for: ' + labelText);
      return false;
    }
    var el = found.el;
    console.log('[LC] trigger for "' + labelText + '": ' + el.tagName +
      ' isNative=' + found.isNative + ' text="' + (el.textContent||'').trim().slice(0,40) + '"');

    if (found.isNative) {
      // ── Native <select> path ─────────────────────────────────────────
      var opts = el.options || [];
      var matchedVal = null;
      for (var i = 0; i < opts.length; i++) {
        var ov = (opts[i].value || '').trim();
        var ot = (opts[i].text  || '').trim();
        if (ov.toLowerCase() === value.toLowerCase() || ot.toLowerCase() === value.toLowerCase()) {
          matchedVal = ov; break;
        }
      }
      console.log('[LC] native select matched: ' + matchedVal);
      if (!matchedVal) return false;

      // Native setter via prototype chain
      var proto2 = el, nativeSetter = null;
      while ((proto2 = Object.getPrototypeOf(proto2))) {
        var desc2 = Object.getOwnPropertyDescriptor(proto2, 'value');
        if (desc2 && typeof desc2.set === 'function') { nativeSetter = desc2.set; break; }
      }
      if (nativeSetter) nativeSetter.call(el, matchedVal); else el.value = matchedVal;

      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      // Try __reactEventHandlers / __reactProps
      var evtKey2 = Object.keys(el).find(function(k) {
        return k.startsWith('__reactEventHandlers') || k.startsWith('__reactProps');
      });
      if (evtKey2 && el[evtKey2] && typeof el[evtKey2].onChange === 'function') {
        el[evtKey2].onChange({ target: el, currentTarget: el, type: 'change' });
      }
      console.log('[LC] native select value after set: ' + el.value);
      return true;

    } else {
      // ── Custom Chakra dropdown path ───────────────────────────────────
      // Step 1: click the trigger to open the listbox
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, view: window }));
      await sleep(1200); // Chakra portals can be slow to render

      // Step 2: broad option search — Chakra renders into a portal at body level
      // Try multiple selectors in priority order
      var OPTION_SELECTORS = [
        '[role="option"]',
        '[role="menuitem"]',
        '[role="listbox"] li',
        'ul[role="listbox"] > li',
        '[data-value]',
        '[class*="chakra-select__option"]',
        '[class*="chakra-menu__menuitem"]',
        '[id*="option"]',
      ];
      var options = [];
      for (var si = 0; si < OPTION_SELECTORS.length; si++) {
        try {
          var found2 = Array.from(document.querySelectorAll(OPTION_SELECTORS[si]));
          if (found2.length > 1) { options = found2; break; } // >1 means the listbox opened
        } catch(e) { console.warn('[LC] OPTION_SELECTORS loop error:', e && e.message); }
      }

      // Dump ALL found options for diagnosis
      console.log('[LC] dropdown options (' + options.length + '): ' +
        options.slice(0,10).map(function(o){
          return '"' + (o.textContent||'').trim().slice(0,20) + '"[' + o.tagName + ']';
        }).join(', '));

      // Also dump the body's aria-live / portal regions for deeper debug
      var portals = Array.from(document.querySelectorAll('[role="listbox"], [role="menu"]'));
      console.log('[LC] listbox/menu regions: ' + portals.length + ' | ' +
        portals.map(function(p){ return p.tagName+'#'+(p.id||'')+'.'+(p.className||'').slice(0,20)+' children='+p.children.length; }).join(' | '));

      var opt = options.find(function(o) {
        return (o.textContent || '').trim().toLowerCase() === value.toLowerCase();
      });
      if (!opt) {
        opt = options.find(function(o) {
          return (o.textContent || '').trim().toLowerCase().includes(value.toLowerCase());
        });
      }
      if (!opt) {
        console.log('[LC] no matching option for: ' + value + ' — dumping body portal HTML');
        // Dump first 800 chars of any open portal
        var portalEl = document.querySelector('[role="listbox"], [role="menu"], [class*="popover"], [class*="dropdown"]');
        if (portalEl) console.log('[LC] portal HTML: ' + portalEl.innerHTML.slice(0, 800));
        // Close the dropdown
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, keyCode: 27 }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, keyCode: 27 }));
        return false;
      }
      console.log('[LC] clicking option: "' + (opt.textContent||'').trim() + '"');
      opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      opt.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }));
      opt.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, view: window }));
      await sleep(500);
      return true;
    }
  }

  function findApplyBtn() {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find(b => /apply/i.test(b.textContent)) || null;
  }

  // ── Step 0: Navigate to "Asset Details" tab ─────────────────────────────
  // Default landing is the Location/map tab. The lifecycle pencil is only
  // rendered on the Asset Details tab. Try three ways to get there.
  const assetDetailsTab = (function() {
    var candidates = Array.from(document.querySelectorAll('button, a, [role="tab"], [role="link"]'));
    return candidates.find(function(b) {
      return (b.textContent || '').trim().toLowerCase() === 'asset details';
    }) || null;
  })();

  // Log what tab we found
  console.log('[LC] assetDetailsTab found:', assetDetailsTab ? assetDetailsTab.tagName + '.' + (assetDetailsTab.className||'').slice(0,40) : 'null');

  if (assetDetailsTab) {
    // Method 1: href navigation (works if it's an <a> tag)
    var href = assetDetailsTab.getAttribute('href');
    console.log('[LC] assetDetailsTab href:', href || 'none');
    if (href && href !== '#') {
      window.location.href = href;
      await sleep(3000);
    } else {
      // Method 2: real MouseEvent dispatch (triggers React router)
      assetDetailsTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      await sleep(2500);
    }
  } else {
    console.log('[LC] No Asset Details tab found — proceeding anyway');
  }

  // Post-tab-click BTN DUMP — verify we're on the right tab now
  (function() {
    var btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    var dump = btns.map(function(b, i) {
      return i + '|' + (b.textContent||'').trim().slice(0,40) + '|' +
        (b.getAttribute('aria-label')||'') + '|' + (b.className||'').slice(0,50);
    });
    console.log('[POST-TAB BTN DUMP] ' + dump.length + ' buttons: ' + JSON.stringify(dump));
  })();
  await sleep(200);

  // ── Step 1: Click the pencil edit button ────────────────────────────────
  const pencilBtn = findPencilBtn();
  if (!pencilBtn) return { success: false, message: 'Could not find lifecycle edit button (pencil) — Asset Details tab may not have rendered' };

  pencilBtn.click();
  await sleep(1500);

  // ── Step 2: Verify modal opened ─────────────────────────────────────────
  const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"]');
  if (!modal) return { success: false, message: 'Modify Lifecycle modal did not open' };

  // ── Step 3: Set Lifecycle State dropdown ────────────────────────────────
  console.log('[LC] Setting state dropdown to: ${targetState}');
  var stateOk = await setDropdownValue('lifecycle state', ${JSON.stringify(targetState)}, modal);
  if (!stateOk) return { success: false, message: 'Could not set Lifecycle State to ${targetState}' };
  await sleep(800); // allow React to update reason options after state change

  // ── Step 4: Set Reason dropdown ─────────────────────────────────────────
  console.log('[LC] Setting reason dropdown to: ${targetReason || ''}');
  var reasonOk = await setDropdownValue('reason', ${JSON.stringify(targetReason || '')}, modal);
  if (!reasonOk) return { success: false, message: 'Could not set Lifecycle Reason to ${targetReason || ''}' };

  // ── Step 5: Log modal state before applying ─────────────────────────────
  // Read back what the trigger buttons show as their current text
  var stateFound2  = findDropdownTrigger('lifecycle state', modal);
  var reasonFound2 = findDropdownTrigger('reason', modal);
  console.log('[LC] PRE-APPLY state trigger text: ' +
    (stateFound2  ? (stateFound2.el.textContent  || '').trim().slice(0,40) : 'not found'));
  console.log('[LC] PRE-APPLY reason trigger text: ' +
    (reasonFound2 ? (reasonFound2.el.textContent || '').trim().slice(0,40) : 'not found'));

  // ── Step 6: Click Apply Change ──────────────────────────────────────────
  const applyBtn = findApplyBtn();
  if (!applyBtn) return { success: false, message: 'Could not find Apply Change button' };
  if (applyBtn.disabled) return { success: false, message: 'Apply Change button is disabled' };

  console.log('[LC] Clicking Apply Change...');
  applyBtn.click();
  await sleep(2000);

  // ── Step 7: Confirm modal closed (success) ──────────────────────────────
  const stillOpen = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"]');
  if (stillOpen) {
    // Check for error message inside modal
    const errEl = stillOpen.querySelector('[class*="error"], [class*="alert"], [role="alert"]');
    const errMsg = errEl ? errEl.textContent.trim() : '';
    return { success: false, message: errMsg || 'Modal still open after Apply — change may have failed' };
  }

  return { success: true, message: 'Lifecycle state changed to ' + ${JSON.stringify(targetState)} };
})();
  `;
}

module.exports = { setLifecycleState };

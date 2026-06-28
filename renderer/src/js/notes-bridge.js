/**
 * notes-bridge.js  — Module 2, Stage 1
 * Wires the drawer "Notes" tab to window.notes.saveUnit() / window.notes.getUnit()
 * instead of localStorage. Falls back to localStorage silently when window.notes
 * is absent (browser dev mode).
 *
 * IPC contract (preload exposes window.notes):
 *   window.notes.getUnit(equipmentId)   → { equipmentId, repairStatus, primaryComponent,
 *                                           salesforceCase, salesforceCaseUrl,
 *                                           offsiteShopEvent, offsiteShopEventUrl, notes }
 *   window.notes.saveUnit(payload)      → { ok, note }
 *   window.notes.deleteUnit(equipmentId)→ { ok }
 */

(function () {
  'use strict';

  const HAS_NOTES = typeof window.notes !== 'undefined' &&
                    typeof window.notes.saveUnit === 'function';

  function lsGet(uid) {
    try { return localStorage.getItem('fo_note_' + uid) || ''; } catch (e) { return ''; }
  }
  function lsSet(uid, val) {
    try { localStorage.setItem('fo_note_' + uid, val); } catch (e) {}
  }

  /* ── load saved fields into structured inputs ───────────────────── */

  async function loadNoteFields(uid) {
    let data = {};
    if (HAS_NOTES) {
      try { data = await window.notes.getUnit(uid) || {}; } catch (e) {}
    }

    const set = function (id, val) {
      const el = document.getElementById(id);
      if (el) el.value = val || '';
    };
    set('noteRepairStatus',   data.repairStatus);
    set('notePrimaryComp',    data.primaryComponent);
    set('noteSfCase',         data.salesforceCase);
    set('noteSfCaseUrl',      data.salesforceCaseUrl);
    set('noteOffsiteEvent',   data.offsiteShopEvent);
    set('noteOffsiteEventUrl',data.offsiteShopEventUrl);

    const na = document.getElementById('notesArea');
    if (na) { na.value = data.notes || lsGet(uid); }
  }

  /* ── build structured fields HTML ─────────────────────────────── */

  function buildNotesTabExtra(uid) {
    return [
      '<div class="dr-st">Structured Fields</div>',
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">',

      '  <div>',
      '    <div class="dr-fl">Repair Status</div>',
      '    <select id="noteRepairStatus" style="width:100%;padding:5px 8px;font-size:11px;background:var(--el);color:var(--fg);border:1px solid var(--bdr);border-radius:5px;font-family:inherit">',
      '      <option value="">— select —</option>',
      '      <option>In Diagnosis</option>',
      '      <option>Parts Ordered</option>',
      '      <option>Repair In Progress</option>',
      '      <option>Waiting on Vendor</option>',
      '      <option>Ready for Pickup</option>',
      '      <option>RCA Complete</option>',
      '    </select>',
      '  </div>',

      '  <div>',
      '    <div class="dr-fl">Primary Component</div>',
      '    <input id="notePrimaryComp" style="width:100%;box-sizing:border-box;background:var(--el);color:var(--fg);border:1px solid var(--bdr);border-radius:5px;padding:5px 8px;font-size:11px;font-family:inherit" placeholder="e.g. Transmission" />',
      '  </div>',

      '  <div>',
      '    <div class="dr-fl">Salesforce Case #</div>',
      '    <input id="noteSfCase" style="width:100%;box-sizing:border-box;background:var(--el);color:var(--fg);border:1px solid var(--bdr);border-radius:5px;padding:5px 8px;font-size:11px;font-family:var(--mono)" placeholder="SF-XXXXXXXX" />',
      '  </div>',

      '  <div>',
      '    <div class="dr-fl">SF Case URL</div>',
      '    <input id="noteSfCaseUrl" style="width:100%;box-sizing:border-box;background:var(--el);color:var(--fg);border:1px solid var(--bdr);border-radius:5px;padding:5px 8px;font-size:11px;font-family:inherit" placeholder="https://..." />',
      '  </div>',

      '  <div>',
      '    <div class="dr-fl">Offsite Shop Event</div>',
      '    <input id="noteOffsiteEvent" style="width:100%;box-sizing:border-box;background:var(--el);color:var(--fg);border:1px solid var(--bdr);border-radius:5px;padding:5px 8px;font-size:11px;font-family:inherit" placeholder="Event name / #" />',
      '  </div>',

      '  <div>',
      '    <div class="dr-fl">Offsite Event URL</div>',
      '    <input id="noteOffsiteEventUrl" style="width:100%;box-sizing:border-box;background:var(--el);color:var(--fg);border:1px solid var(--bdr);border-radius:5px;padding:5px 8px;font-size:11px;font-family:inherit" placeholder="https://..." />',
      '  </div>',

      '</div>',

      '<div class="dr-st">Free Notes</div>',
      '<textarea class="notes-area" id="notesArea" placeholder="Add operational notes for this unit..."',
      '  oninput="autoSaveNote(\'' + uid + '\', this)"></textarea>',

      '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px">',
      '  <span id="noteLastSaved" style="font-size:9px;color:var(--mut);font-family:var(--mono)"></span>',
      '  <button class="notes-save" onclick="saveNote(\'' + uid + '\', document.getElementById(\'notesArea\'))">Save note</button>',
      '</div>',
    ].join('\n');
  }

  /* ── inject structured notes into tab-nt (safe, idempotent) ────── */

  function injectNotesTab(uid) {
    const tabNt = document.getElementById('tab-nt');
    if (!tabNt) return;
    // only replace if we haven't already wired this uid
    if (tabNt.dataset.nbUid === uid) return;
    tabNt.dataset.nbUid = uid;
    tabNt.innerHTML = buildNotesTabExtra(uid);
    loadNoteFields(uid);
  }

  /* ── patch drTab to inject when Notes tab is clicked ───────────── */
  // The original drTab(btn, 'nt') call activates tab-nt.
  // We intercept it to inject our structured fields on first open.

  function patchDrTab() {
    const orig = window.drTab;
    if (typeof orig !== 'function') return false;
    window.drTab = function (btn, id) {
      orig(btn, id);
      if (id === 'nt') {
        // _curDrawerUid is set by the original openDrawerByUid
        const uid = window._curDrawerUid;
        if (uid) injectNotesTab(uid);
      }
    };
    return true;
  }

  /* ── patch openDrawerByUid to inject when drawer opens on Notes ─── */
  // Also covers programmatic openDrawerByUid calls (queue items).
  // We inject after a short delay to let the original DOM build finish.

  function patchOpenDrawerByUid() {
    const orig = window.openDrawerByUid;
    if (typeof orig !== 'function') return false;
    window.openDrawerByUid = function (uid) {
      orig(uid);
      // Give the drawer's innerHTML time to render (original uses setTimeout 50ms internally)
      setTimeout(function () {
        injectNotesTab(uid);
      }, 80);
    };
    return true;
  }

  /* ── boot: patch both, retry if not ready yet ───────────────────── */

  function boot() {
    const tabPatched = patchDrTab();
    const drawerPatched = patchOpenDrawerByUid();
    if (!tabPatched || !drawerPatched) {
      // Functions not defined yet — shouldn't happen but retry once
      setTimeout(function () {
        if (!window._nbDrTabPatched) { patchDrTab(); window._nbDrTabPatched = true; }
        if (!window._nbDrawerPatched) { patchOpenDrawerByUid(); window._nbDrawerPatched = true; }
      }, 200);
    }
  }

  boot();

  /* ── replace saveNote() ────────────────────────────────────────── */

  window.saveNote = async function (uid, ta) {
    const notes               = ta ? ta.value : '';
    const repairStatus        = (document.getElementById('noteRepairStatus')    || {}).value || '';
    const primaryComponent    = (document.getElementById('notePrimaryComp')     || {}).value || '';
    const salesforceCase      = (document.getElementById('noteSfCase')          || {}).value || '';
    const salesforceCaseUrl   = (document.getElementById('noteSfCaseUrl')       || {}).value || '';
    const offsiteShopEvent    = (document.getElementById('noteOffsiteEvent')    || {}).value || '';
    const offsiteShopEventUrl = (document.getElementById('noteOffsiteEventUrl') || {}).value || '';

    const payload = {
      equipmentId: uid,
      notes,
      repairStatus,
      primaryComponent,
      salesforceCase,
      salesforceCaseUrl,
      offsiteShopEvent,
      offsiteShopEventUrl,
    };

    // always keep localStorage in sync as fallback
    lsSet(uid, notes);

    const ts = document.getElementById('noteLastSaved');

    if (HAS_NOTES) {
      try {
        const result = await window.notes.saveUnit(payload);
        if (result && result.ok) {
          if (ts) { ts.textContent = 'Last saved: ' + new Date().toLocaleTimeString(); ts.style.color = 'var(--mut)'; }
          if (typeof window.toast === 'function') window.toast('Note saved for ' + uid, 'success', 'Notes');
        } else {
          console.warn('[notes-bridge] saveUnit returned not-ok:', result);
          if (typeof window.toast === 'function') window.toast('Note save failed (IPC error)', 'error', 'Notes');
        }
      } catch (err) {
        console.error('[notes-bridge] saveUnit IPC error:', err);
        if (ts) { ts.textContent = 'Saved locally: ' + new Date().toLocaleTimeString(); ts.style.color = 'var(--org)'; }
        if (typeof window.toast === 'function') window.toast('Note saved locally (IPC unavailable)', 'warning', 'Notes');
      }
    } else {
      // dev / browser mode — localStorage already written above
      if (ts) { ts.textContent = 'Saved: ' + new Date().toLocaleTimeString(); ts.style.color = 'var(--mut)'; }
      if (typeof window.toast === 'function') window.toast('Note saved (dev: localStorage)', 'info', 'Notes');
    }
  };

  /* ── replace autoSaveNote() ────────────────────────────────────── */

  window.autoSaveNote = function (uid, ta) {
    const ts = document.getElementById('noteLastSaved');
    if (ts) { ts.textContent = 'Unsaved changes...'; ts.style.color = 'var(--org)'; }

    clearTimeout(ta._nt);
    ta._nt = setTimeout(async function () {
      await window.saveNote(uid, ta);
    }, 1400);
  };

  /* ── boot log ───────────────────────────────────────────────────── */

  console.log('[notes-bridge] Module 2 loaded. Mode:', HAS_NOTES ? 'Electron/IPC' : 'browser/localStorage');

})();

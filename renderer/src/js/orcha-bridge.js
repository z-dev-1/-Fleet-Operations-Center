/**
 * orcha-bridge.js — Module 6: Orcha Deep Process Bridge
 * Fleet Ops V-C, Stage 2
 *
 * Wires the Orcha AI intelligence layer into the drawer UI:
 *   - Patches window.runOrchaDeepProcess(unitIds[]) — callable from context
 *     menu "Run Orcha" and the drawer header action button.
 *   - Calls orcha:deep-process → updates drawer .ai-box, .ai-act, .ai-stamp,
 *     .tl (repair timeline) and UNITS[uid] cache live.
 *   - Registers window.runOrchaVendorSuggest(unit) → orcha:suggest-vendor
 *   - Registers window.recordOrchaCorrection(correction) → orcha:record-correction
 *   - Injects "⚡ Run Orcha" button into drawer actions panel on draw
 *   - Injects "⚡ Run Orcha" item into context menu
 *   - Shows an in-place loading overlay on .ai-box while IPC in flight
 *   - Commits corrected UNITS fields back on result (intel, next, confidence, tl)
 *
 * Capability flags (captured once at load time):
 *   HAS_ORCHA_DEEP   — window.ai.deepProcess available
 *   HAS_ORCHA_LEARN  — window.ai.recordCorrection available
 *
 * Dev fallback: canned response with 1200ms delay when no IPC.
 * window._orchaBridge debug handle exposed.
 */

(function () {
  'use strict';

  /* ── 1. Capability detection ────────────────────────────────────────── */
  const HAS_ORCHA_DEEP  = !!(window.ai && typeof window.ai.deepProcess       === 'function');
  const HAS_ORCHA_LEARN = !!(window.ai && typeof window.ai.recordCorrection   === 'function');
  const HAS_VENDOR_SUGG = !!(window.ai && typeof window.ai.suggestVendor      === 'function');

  /* ── 2. Dev canned response ─────────────────────────────────────────── */
  const DEV_INTEL = [
    'Deep scan complete. Unit confirmed at vendor. Parts on order, ETA within 24h. No blockers identified.',
    'Analysis updated. Diagnosis complete — root cause confirmed. Awaiting parts arrival.',
    'Intelligence refresh: SLA risk elevated. Recommend immediate vendor escalation.',
    'Orcha processed: All subsystems reviewed. Current repair stage matches vendor report.',
  ];
  let _devIdx = 0;

  /* ── 3. State ───────────────────────────────────────────────────────── */
  const _state = {
    running: false,
    lastProcessed: [],
    lastResult: null,
  };

  /* ── 4. AI-box loading overlay ──────────────────────────────────────── */

  function _showAiLoading(uid) {
    const box = _getAiBox();
    if (!box) return;
    box.setAttribute('data-orcha-orig', box.innerHTML);
    box.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;padding:8px 0">' +
        '<div style="display:flex;gap:4px">' +
          '<span style="width:6px;height:6px;border-radius:50%;background:var(--acc);animation:dt 1.2s ease-in-out infinite"></span>' +
          '<span style="width:6px;height:6px;border-radius:50%;background:var(--acc);animation:dt 1.2s ease-in-out .2s infinite"></span>' +
          '<span style="width:6px;height:6px;border-radius:50%;background:var(--acc);animation:dt 1.2s ease-in-out .4s infinite"></span>' +
        '</div>' +
        '<span style="font-size:11px;color:var(--txt2)">Orcha processing ' + (uid || '') + '...</span>' +
      '</div>';
  }

  function _restoreAiBox() {
    const box = _getAiBox();
    if (!box) return;
    const orig = box.getAttribute('data-orcha-orig');
    if (orig) {
      box.innerHTML = orig;
      box.removeAttribute('data-orcha-orig');
    }
  }

  function _getAiBox() {
    // Active drawer overview tab's ai-box
    const tab = document.getElementById('tab-ov');
    if (tab) return tab.querySelector('.ai-box');
    return document.querySelector('.ai-box');
  }

  /* ── 5. Drawer update after result ──────────────────────────────────── */

  function _applyResultToDrawer(unit, uid) {
    const now = new Date().toLocaleTimeString('en-US', {
      hour12: false, hour: '2-digit', minute: '2-digit',
    });

    // Update UNITS cache
    if (window.UNITS && window.UNITS[uid]) {
      if (unit.issueSummary)   window.UNITS[uid].intel      = unit.issueSummary;
      if (unit.repairTimeline) window.UNITS[uid].tl         = unit.repairTimeline;
      if (unit.notes)          { /* notes handled by notes-bridge */ }
    }

    // Update .ai-box content
    const box = _getAiBox();
    if (box) {
      const cached = window.UNITS && window.UNITS[uid];
      const intel  = (cached && cached.intel)  || unit.issueSummary  || 'Processing complete.';
      const next   = (cached && cached.next)   || '';
      const conf   = (cached && cached.confidence) || 'UPDATED';

      box.innerHTML =
        intel +
        (next ? '<div class="ai-act">NEXT: ' + next + '</div>' : '') +
        '<div class="ai-stamp">ORCHA &middot; ' + now + ' &middot; <span>' + conf + '</span></div>';
    }

    // Append new timeline entries if returned
    if (unit.repairTimeline && Array.isArray(unit.repairTimeline)) {
      const tl = document.querySelector('#tab-ov .tl');
      if (tl) {
        const iconMap = {
          SCAN:'🔍', VENDOR:'🚛', DIAG:'🔧', PARTS:'📦',
          REPAIR:'✅', WR:'📋', UPDATE:'📝', ORCHA:'🤖',
        };
        const clsMap = {
          SCAN:'scan', VENDOR:'vendor', DIAG:'diag', PARTS:'parts',
          REPAIR:'repair', WR:'scan', UPDATE:'scan', ORCHA:'scan',
        };
        // Prepend new entries (most recent first)
        const newEntries = unit.repairTimeline.slice(0, 3);
        newEntries.reverse().forEach(function (e) {
          const item = document.createElement('div');
          item.className = 'tl-item';
          item.innerHTML =
            '<span class="tl-icon">' + (iconMap[e.k] || '📌') + '</span>' +
            '<div style="flex:1">' +
              '<div>' +
                '<span class="tl-badge ' + (clsMap[e.k] || '') + '">' + e.k + '</span>' +
                '<span class="tl-t" style="font-size:9px;color:var(--mut)">' + (e.t || now) + '</span>' +
              '</div>' +
              '<div class="tl-d">' + (e.d || '') + '</div>' +
            '</div>';
          tl.insertBefore(item, tl.firstChild);
        });
      }
    }

    // Update notes area if open
    if (unit.notes) {
      const na = document.getElementById('notesArea');
      if (na && window._curDrawerUid === uid) {
        na.value = unit.notes;
      }
    }
  }

  /* ── 6. Core: deep process ──────────────────────────────────────────── */

  async function runOrchaDeepProcess(unitIds) {
    if (!unitIds || !unitIds.length) {
      if (typeof window.toast === 'function') {
        window.toast('No units selected for Orcha processing', 'warning', 'Orcha');
      }
      return;
    }

    if (_state.running) {
      if (typeof window.toast === 'function') {
        window.toast('Orcha is already processing — please wait', 'info', 'Orcha');
      }
      return;
    }

    _state.running = true;
    _state.lastProcessed = unitIds;

    const primaryUid = unitIds[0];

    // Show loading state on drawer ai-box
    _showAiLoading(primaryUid);

    if (typeof window.toast === 'function') {
      window.toast(
        'Processing ' + unitIds.length + ' unit' + (unitIds.length > 1 ? 's' : '') + '...',
        'info',
        'Orcha AI'
      );
    }

    try {
      let result;

      if (HAS_ORCHA_DEEP) {
        result = await window.ai.deepProcess(unitIds);
      } else {
        // Dev fallback: synthesise a plausible result
        await new Promise(function (r) { setTimeout(r, 1200); });
        result = {
          processed: unitIds.length,
          units: unitIds.map(function (id) {
            return {
              equipmentId:    id,
              issueSummary:   DEV_INTEL[_devIdx++ % DEV_INTEL.length],
              repairTimeline: [{ t: new Date().toLocaleTimeString('en-US', {hour12:false,hour:'2-digit',minute:'2-digit'}), k: 'ORCHA', d: 'Intelligence refresh — dev mode.' }],
              notes:          '',
            };
          }),
        };
      }

      _state.lastResult = result;

      if (result && result.units && result.units.length) {
        result.units.forEach(function (unit) {
          _applyResultToDrawer(unit, unit.equipmentId);
        });

        if (typeof window.toast === 'function') {
          window.toast(
            'Processed ' + result.processed + ' unit' + (result.processed > 1 ? 's' : ''),
            'success',
            'Orcha AI'
          );
        }
      } else {
        _restoreAiBox();
        if (typeof window.toast === 'function') {
          window.toast('No intelligence updates returned', 'info', 'Orcha AI');
        }
      }

    } catch (err) {
      _restoreAiBox();
      console.warn('[orcha-bridge] deepProcess error:', err);
      if (typeof window.toast === 'function') {
        window.toast('Orcha processing failed — ' + (err.message || 'IPC error'), 'warning', 'Orcha AI');
      }
    } finally {
      _state.running = false;
    }
  }

  /* ── 7. Vendor suggest ──────────────────────────────────────────────── */

  async function runOrchaVendorSuggest(unit) {
    if (!HAS_VENDOR_SUGG) return null;
    try {
      return await window.ai.suggestVendor(unit);
    } catch (e) {
      console.warn('[orcha-bridge] suggestVendor error:', e);
      return null;
    }
  }

  /* ── 8. Correction recording ────────────────────────────────────────── */

  function recordOrchaCorrection(correction) {
    if (!HAS_ORCHA_LEARN) return;
    try {
      window.ai.recordCorrection(correction);
    } catch (e) {
      console.warn('[orcha-bridge] recordCorrection error:', e);
    }
  }

  /* ── 9. "Run Orcha" button injected into drawer actions ─────────────── */

  function _injectDrawerButton() {
    const actions = document.getElementById('drActions');
    if (!actions || document.getElementById('orcha-run-btn')) return;

    const btn = document.createElement('button');
    btn.id        = 'orcha-run-btn';
    btn.className = 'btn primary';
    btn.innerHTML = '&#9889; Run Orcha';
    btn.title     = 'Run Orcha intelligence refresh on this unit';
    btn.onclick   = function () {
      const uid = window._curDrawerUid;
      if (uid) {
        runOrchaDeepProcess([uid]).catch(function () {});
      } else {
        if (typeof window.toast === 'function') {
          window.toast('Open a unit drawer first', 'warning', 'Orcha');
        }
      }
    };

    // Insert as first button in the actions grid
    actions.insertBefore(btn, actions.firstChild);
  }

  /* ── 10. "Run Orcha" injected into context menu ──────────────────────── */

  function _injectCtxMenuItem() {
    const menu = document.getElementById('ctxMenu');
    if (!menu || document.getElementById('ctx-orcha-item')) return;

    // Find the first separator to insert before it
    const sep = menu.querySelector('.ctx-sep');

    const item = document.createElement('button');
    item.id        = 'ctx-orcha-item';
    item.className = 'ctx-item';
    item.innerHTML = '<span class="ctx-icon">&#9889;</span>Run Orcha AI';
    item.onclick   = function () {
      const uid = window.ctxTarget;
      if (typeof window.closeCtx === 'function') window.closeCtx();
      if (uid) {
        runOrchaDeepProcess([uid]).catch(function () {});
      }
    };

    if (sep) {
      menu.insertBefore(item, sep);
    } else {
      menu.appendChild(item);
    }
  }

  /* ── 11. Observe drawer open to inject button ────────────────────────── */

  function _watchDrawer() {
    const drawer = document.getElementById('drawer');
    if (!drawer) return;

    const obs = new MutationObserver(function (mutations) {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'class') {
          if (drawer.classList.contains('open')) {
            // S21-E: 200ms primary + 500ms retry if drActions not ready yet
            setTimeout(_injectDrawerButton, 200);
            setTimeout(function() {
              if (!document.getElementById('orcha-run-btn')) _injectDrawerButton();
            }, 500);
          }
        }
      }
    });

    obs.observe(drawer, { attributes: true });
  }

  /* ── 12. Boot ────────────────────────────────────────────────────────── */

  function boot() {
    // Expose global entry points
    window.runOrchaDeepProcess   = runOrchaDeepProcess;
    window.runOrchaVendorSuggest = runOrchaVendorSuggest;
    window.recordOrchaCorrection = recordOrchaCorrection;

    // Wire context menu
    _injectCtxMenuItem();

    // Watch for drawer opens
    _watchDrawer();

    // If drawer is already open on boot (rare), inject now
    const drawer = document.getElementById('drawer');
    if (drawer && drawer.classList.contains('open')) {
      setTimeout(_injectDrawerButton, 200); // S21-E: 200ms
    }

    const mode = HAS_ORCHA_DEEP ? 'IPC mode' : 'dev mode';
    console.log(
      '[orcha-bridge] loaded —', mode,
      '(deep=' + HAS_ORCHA_DEEP +
      ' learn=' + HAS_ORCHA_LEARN +
      ' vendor=' + HAS_VENDOR_SUGG + ')'
    );
  }

  /* ── 13. Debug handle ────────────────────────────────────────────────── */

  window._orchaBridge = {
    version:             '1.0.0',
    HAS_ORCHA_DEEP:       HAS_ORCHA_DEEP,
    HAS_ORCHA_LEARN:      HAS_ORCHA_LEARN,
    HAS_VENDOR_SUGG:      HAS_VENDOR_SUGG,
    state:                _state,
    runDeepProcess:       runOrchaDeepProcess,
    runVendorSuggest:     runOrchaVendorSuggest,
    recordCorrection:     recordOrchaCorrection,
    injectDrawerButton:   _injectDrawerButton,
  };

  /* ── 14. Start ───────────────────────────────────────────────────────── */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();

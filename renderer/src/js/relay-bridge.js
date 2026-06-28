/**
 * relay-bridge.js  —  Module 3: Relay IPC Bridge
 * ─────────────────────────────────────────────────────────────────────────────
 * Patches window.commitRelay() so that selecting a new relay status:
 *   1. Updates the UI tag + UNITS[uid].relay (existing behaviour, preserved)
 *   2. Writes to localStorage fo_relays (existing behaviour, preserved)
 *   3. Calls window.aap.setLifecycle() to persist the change in AAP
 *
 * Relay → AAP lifecycle mapping
 * ┌─────────────────┬─────────────┬─────────────────────────┐
 * │ Relay value     │ AAP state   │ AAP reason              │
 * ├─────────────────┼─────────────┼─────────────────────────┤
 * │ Available       │ Active      │ Healthy                 │
 * │ In Progress     │ Unavailable │ In Progress             │
 * │ Pending Parts   │ Unavailable │ Pending Parts           │
 * │ Pending Diag    │ Unavailable │ Pending Diagnosis       │
 * │ Offsite Shop    │ Unavailable │ Offsite Shop Repair     │
 * │ Accident        │ Unavailable │ Accident                │
 * └─────────────────┴─────────────┴─────────────────────────┘
 *
 * Dev mode (no window.aap): falls back to localStorage only, shows a toast
 * indicating dev mode. No errors thrown.
 *
 * Bulk relay (applyBulkRelay): also patched — runs the same IPC path per unit.
 *
 * Exposes window._relayBridge for console debugging.
 */

(function () {
  'use strict';

  /* ── Constants ─────────────────────────────────────────────────────────── */

  const HAS_AAP = typeof window.aap !== 'undefined' &&
                  typeof window.aap.setLifecycle === 'function';

  /**
   * Maps relay display value → { state, reason } for window.aap.setLifecycle
   */
  const RELAY_TO_LIFECYCLE = {
    'Available':     { state: 'Active',      reason: 'Healthy' },
    'In Progress':   { state: 'Unavailable', reason: 'In Progress' },
    'Pending Parts': { state: 'Unavailable', reason: 'Pending Parts' },
    'Pending Diag':  { state: 'Unavailable', reason: 'Pending Diagnosis' },
    'Offsite Shop':  { state: 'Unavailable', reason: 'Offsite Shop Repair' },
    'Accident':      { state: 'Unavailable', reason: 'Accident' },
  };

  /* ── Helper: resolve assetUrl for a uid ────────────────────────────────── */

  function getAssetUrl(uid) {
    const u = (typeof UNITS !== 'undefined') ? UNITS[uid] : null;
    return (u && u.assetUrl) ? u.assetUrl : null;
  }

  /* ── Helper: get lifecycle params for a relay value ────────────────────── */

  function lifecycleFor(relayVal) {
    return RELAY_TO_LIFECYCLE[relayVal] || { state: 'Unavailable', reason: relayVal };
  }

  /* ── Helper: show a toast (safe wrapper) ───────────────────────────────── */

  function showToast(msg, type, title) {
    if (typeof window.toast === 'function') {
      window.toast(msg, type || 'info', title || 'Relay');
    }
  }

  /* ── Core IPC commit ────────────────────────────────────────────────────── */

  /**
   * Sends the lifecycle change to AAP for a single unit.
   * @param {string} uid        - e.g. 'T-7743'
   * @param {string} relayVal   - e.g. 'Pending Parts'
   * @returns {Promise<void>}
   */
  async function commitToAAP(uid, relayVal) {
    if (!HAS_AAP) {
      // Dev / browser mode — localStorage already written by original fn
      showToast(
        uid + ' → ' + relayVal + ' (dev: localStorage only)',
        'info',
        'Relay'
      );
      return;
    }

    const assetUrl = getAssetUrl(uid);
    const { state, reason } = lifecycleFor(relayVal);

    // Optimistic UI toast — immediate feedback before async completes
    showToast(uid + ' → ' + relayVal + ' — syncing AAP...', 'info', 'Relay');

    try {
      const result = await window.aap.setLifecycle(uid, assetUrl, state, reason);

      if (result && result.success) {
        showToast(
          uid + ' → ' + relayVal + ' — AAP updated ✓',
          'success',
          'Relay Synced'
        );
      } else {
        const msg = (result && result.message) ? result.message : 'AAP returned no confirmation';
        showToast(
          uid + ' — AAP sync failed: ' + msg,
          'warning',
          'Relay Warning'
        );
        console.warn('[relay-bridge] setLifecycle failed for', uid, ':', msg);
      }
    } catch (err) {
      showToast(
        uid + ' — AAP error: ' + (err.message || err),
        'error',
        'Relay Error'
      );
      console.error('[relay-bridge] setLifecycle threw for', uid, ':', err);
    }
  }

  /* ── Patch commitRelay ──────────────────────────────────────────────────── */

  const _originalCommitRelay = window.commitRelay;

  window.commitRelay = function (sel, uid) {
    // 1. Run original: updates tag, UNITS[uid].relay, localStorage fo_relays
    //    Original also calls toast("Relay updated...") — we suppress its toast
    //    by temporarily muting, then restore. Simpler: just let it fire; our
    //    AAP toast replaces the meaning (no double-toast for AAP mode).
    if (typeof _originalCommitRelay === 'function') {
      _originalCommitRelay.call(this, sel, uid);
    } else {
      // Fallback: minimal original logic if somehow not present at wrap time
      const td = sel.parentNode;
      const span = td && td.querySelector('span.tag');
      const val = sel.value;
      const clsMap = {
        'Pending Parts': 'orange',
        'Offsite Shop':  'red',
        'In Progress':   'blue',
        'Available':     'green',
        'Pending Diag':  'purple',
        'Accident':      'gray',
      };
      if (span) {
        span.textContent = val;
        span.className = 'tag ' + (clsMap[val] || 'gray');
      }
      sel.style.display = 'none';
      if (span) span.style.display = '';
      if (typeof UNITS !== 'undefined' && UNITS[uid]) UNITS[uid].relay = val;
      try {
        const s = JSON.parse(localStorage.getItem('fo_relays') || '{}');
        s[uid] = val;
        localStorage.setItem('fo_relays', JSON.stringify(s));
      } catch (_e) { /* ignore */ }
    }

    // 2. Fire AAP IPC (async, non-blocking)
    const relayVal = sel.value;
    commitToAAP(uid, relayVal);
  };

  /* ── Patch applyBulkRelay ───────────────────────────────────────────────── */

  const _originalBulkRelay = window.applyBulkRelay;

  window.applyBulkRelay = function () {
    // Collect checked units + new relay value BEFORE calling original
    // (original clears selection, so we snapshot first)
    const sel = document.getElementById('bulkRelayPick');
    const val = sel ? sel.value : null;
    const checkedUids = [];

    if (val) {
      document.querySelectorAll('.row-cb.unit-cb:checked').forEach(function (cb) {
        const row = cb.closest('tr');
        if (!row) return;
        const uidEl = row.querySelector('.uid');
        if (!uidEl) return;
        const uid = uidEl.textContent.trim().replace(/[↑↓→]/g, '');
        if (uid) checkedUids.push(uid);
      });
    }

    // Run original (handles UI + localStorage + clears selection)
    if (typeof _originalBulkRelay === 'function') {
      _originalBulkRelay.call(this);
    }

    // Fire AAP IPC for each unit (sequential with 200ms gap to avoid floods)
    if (val && checkedUids.length > 0) {
      checkedUids.reduce(function (chain, uid, idx) {
        return chain.then(function () {
          return new Promise(function (resolve) {
            setTimeout(function () {
              commitToAAP(uid, val).finally(resolve);
            }, idx === 0 ? 0 : 200);
          });
        });
      }, Promise.resolve());
    }
  };

  /* ── Debug handle ───────────────────────────────────────────────────────── */

  window._relayBridge = {
    version:         '1.0.0',
    HAS_AAP:         HAS_AAP,
    RELAY_TO_LIFECYCLE: RELAY_TO_LIFECYCLE,
    commitToAAP:     commitToAAP,
    lifecycleFor:    lifecycleFor,
  };

  console.log(
    '[relay-bridge] loaded — mode:',
    HAS_AAP ? 'Electron (AAP IPC active)' : 'Dev (localStorage only)'
  );

})();

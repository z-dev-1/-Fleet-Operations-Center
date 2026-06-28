/**
 * aap-bridge.js — Module 8: AAP Adaptive Scan + WR Create + Autofill
 * Fleet Ops V-C, Stage 2
 *
 * ⚠ HIGH-RISK MODULE — all write operations require explicit user confirmation.
 *
 * Surfaces:
 *   Scan
 *     window.runAdaptiveScan(units[])        → adaptive:scan-batch IPC
 *     window.runAdaptiveExtract(opts)        → adaptive:extract  IPC
 *   Work Request
 *     window.createWorkRequest(payload,unit) → aap:create-wr   IPC  (WRITE)
 *     window.runAdaptiveWR(payload)          → aap:adaptive    IPC  (WRITE)
 *   Autofill
 *     window.launchAutofill(url, payload)    → aap:autofill    IPC  (WRITE — opens BrowserWindow)
 *   Lifecycle
 *     window.setLifecycle(id,url,state,reason) → aap:set-lifecycle IPC (WRITE)
 *   URL
 *     window.openAAPUrl(url)                 → aap:open-url    IPC
 *
 * Write-gate: every write path shows a modal-style confirmation card
 * before any IPC call is made. The user must click "Confirm" or the
 * operation is abandoned — the card shows exactly what will be written.
 *
 * Progress stream: `aap:onWRProgress` events pipe into a live log panel
 * inside the WR modal while the operation is in flight.
 *
 * UI entry points:
 *   - Drawer action panel → "⚡ Create WR" button (write-gated)
 *   - Drawer action panel → "🔄 Adaptive Scan" button (read-only, no gate)
 *   - Right-click context menu → "Create Work Request" item
 *   - Right-click context menu → "Open in AAP" item
 *   - Lifecycle pill in drawer → click → set-lifecycle modal
 *
 * In-flight locks per operation type prevent double-fire.
 * Dev fallback: canned responses with 900ms simulated delay.
 * window._aapBridge debug handle exposed.
 */

(function () {
  'use strict';

  /* ── 1. Capability detection ────────────────────────────────────────── */
  const HAS_AAP       = !!(window.aap       && typeof window.aap.createWR         === 'function');
  const HAS_ADAPTIVE  = !!(window.aap       && typeof window.aap.adaptiveScanBatch=== 'function');
  const HAS_AUTOFILL  = !!(window.aap       && typeof window.aap.autofill         === 'function');
  const HAS_LIFECYCLE = !!(window.aap       && typeof window.aap.setLifecycle     === 'function');
  const HAS_OPEN_URL  = !!(window.aap       && typeof window.aap.openUrl          === 'function');
  const HAS_WR_PROG   = !!(window.aap       && typeof window.aap.onWRProgress     === 'function');

  /* ── 2. In-flight locks ─────────────────────────────────────────────── */
  const _lock = {
    scan:      false,
    createWR:  false,
    autofill:  false,
    lifecycle: false,
  };

  /* ── 3. Write-gate (confirmation modal) ─────────────────────────────── */
  /**
   * Show a blocking confirmation overlay.
   * Returns a Promise<boolean> — resolves true only if user clicks Confirm.
   */
  function _writeGate(opts) {
    return new Promise(function (resolve) {
      const id = 'aap-write-gate-' + Date.now();

      const overlay = document.createElement('div');
      overlay.id = id;
      overlay.style.cssText =
        'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999;' +
        'background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;' +
        'animation:fadeIn .12s ease';

      const card = document.createElement('div');
      card.style.cssText =
        'background:var(--bg2,#1a1f2c);border:1px solid var(--bdr,rgba(240,246,252,.12));' +
        'border-radius:10px;padding:24px 28px;max-width:480px;width:90%;' +
        'box-shadow:0 20px 60px rgba(0,0,0,.6);font-family:var(--font,"SF Pro Text",system-ui,sans-serif)';

      // Badge row
      const badge = document.createElement('div');
      badge.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:14px';
      badge.innerHTML =
        '<span style="background:#e53e3e;color:#fff;font-size:9px;font-weight:800;' +
        'padding:2px 7px;border-radius:4px;letter-spacing:.05em">WRITE OPERATION</span>' +
        '<span style="font-size:13px;font-weight:700;color:var(--txt,#eaeaea)">' +
        (opts.title || 'Confirm Action') + '</span>';

      // Description
      const desc = document.createElement('div');
      desc.style.cssText = 'font-size:12px;color:var(--txt2,#8b949e);margin-bottom:16px;line-height:1.5';
      desc.textContent = opts.description || 'This operation will write data to an external system.';

      // Detail table
      let detailHtml = '';
      if (opts.details && typeof opts.details === 'object') {
        detailHtml = '<div style="background:var(--el,rgba(255,255,255,.05));border-radius:6px;' +
          'padding:10px 14px;margin-bottom:16px;font-size:11px;font-family:var(--mono,monospace)">';
        Object.entries(opts.details).forEach(function (pair) {
          if (pair[1] === null || pair[1] === undefined || pair[1] === '') return;
          detailHtml +=
            '<div style="display:flex;gap:8px;padding:2px 0;border-bottom:1px solid rgba(240,246,252,.05)">' +
            '<span style="color:var(--mut,#6e7681);min-width:110px;flex-shrink:0">' + pair[0] + '</span>' +
            '<span style="color:var(--acc2,#58a6ff);word-break:break-all">' + String(pair[1]).slice(0, 120) + '</span>' +
            '</div>';
        });
        detailHtml += '</div>';
      }

      // Buttons
      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:10px;justify-content:flex-end';
      btns.innerHTML =
        '<button id="aap-gate-cancel" style="padding:7px 18px;background:var(--el,rgba(255,255,255,.08));' +
        'border:1px solid var(--bdr,rgba(240,246,252,.12));border-radius:6px;color:var(--txt2,#8b949e);' +
        'font-size:12px;cursor:pointer">Cancel</button>' +
        '<button id="aap-gate-confirm" style="padding:7px 18px;background:#e53e3e;border:none;' +
        'border-radius:6px;color:#fff;font-size:12px;font-weight:700;cursor:pointer">' +
        (opts.confirmLabel || 'Confirm') + '</button>';

      card.appendChild(badge);
      card.appendChild(desc);
      if (detailHtml) {
        const detailEl = document.createElement('div');
        detailEl.innerHTML = detailHtml;
        card.appendChild(detailEl);
      }
      card.appendChild(btns);
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      function _done(val) {
        overlay.remove();
        resolve(val);
      }

      card.querySelector('#aap-gate-cancel').addEventListener('click',  function () { _done(false); });
      card.querySelector('#aap-gate-confirm').addEventListener('click', function () { _done(true); });
      overlay.addEventListener('click', function (e) { if (e.target === overlay) _done(false); });
    });
  }

  /* ── 4. Progress log panel ───────────────────────────────────────────── */
  function _makeProgressPanel(title) {
    const wrap = document.createElement('div');
    wrap.id = 'aap-progress-wrap';
    wrap.style.cssText =
      'position:fixed;bottom:20px;right:20px;width:340px;background:var(--bg2,#1a1f2c);' +
      'border:1px solid var(--bdr,rgba(240,246,252,.12));border-radius:8px;z-index:8000;' +
      'box-shadow:0 8px 32px rgba(0,0,0,.5);overflow:hidden;animation:slideUp .15s ease';

    wrap.innerHTML =
      '<div style="padding:8px 12px;background:var(--el,rgba(255,255,255,.06));display:flex;' +
      'align-items:center;justify-content:space-between">' +
        '<span style="font-size:11px;font-weight:700;color:var(--txt,#eaeaea)">' + title + '</span>' +
        '<span id="aap-prog-spinner" style="color:var(--acc,#1f6feb);font-size:10px;animation:spin 1s linear infinite">⟳</span>' +
      '</div>' +
      '<div id="aap-prog-log" style="max-height:160px;overflow-y:auto;padding:8px 12px;' +
      'font-size:10px;font-family:var(--mono,monospace);color:var(--txt2,#8b949e);line-height:1.6"></div>';

    document.body.appendChild(wrap);
    return wrap;
  }

  function _appendLog(wrap, msg) {
    const log = wrap && wrap.querySelector('#aap-prog-log');
    if (!log) return;
    const line = document.createElement('div');
    line.style.cssText = 'padding:1px 0;border-bottom:1px solid rgba(240,246,252,.04)';
    line.textContent = msg;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  function _closeProgressPanel(wrap) {
    if (!wrap) return;
    setTimeout(function () { wrap.remove(); }, 1800);
    const spinner = wrap.querySelector('#aap-prog-spinner');
    if (spinner) { spinner.style.animation = 'none'; spinner.textContent = '✓'; spinner.style.color = '#38a169'; }
  }

  /* ── 5. Scan (read-only — no gate) ──────────────────────────────────── */

  async function runAdaptiveScan(units) {
    if (_lock.scan) {
      if (typeof window.toast === 'function') window.toast('Scan already in progress', 'info', 'AAP');
      return;
    }
    if (!Array.isArray(units) || !units.length) {
      if (typeof window.toast === 'function') window.toast('No units provided for scan', 'warning', 'AAP');
      return;
    }

    _lock.scan = true;
    const panel = _makeProgressPanel('Adaptive Scan — ' + units.length + ' unit' + (units.length !== 1 ? 's' : ''));
    _appendLog(panel, 'Starting scan for ' + units.length + ' unit(s)...');

    try {
      let result;
      if (HAS_ADAPTIVE) {
        // Wire progress stream if available
        if (HAS_WR_PROG) {
          window.aap.onWRProgress(function (msg) { _appendLog(panel, msg); });
        }
        result = await window.aap.adaptiveScanBatch(units);
      } else {
        // Dev fallback
        await new Promise(function (r) { setTimeout(r, 900); });
        _appendLog(panel, '[dev] Simulated scan complete for ' + units.length + ' unit(s)');
        result = { ok: true, updated: units.length, dev: true };
      }

      _closeProgressPanel(panel);

      if (result && result.ok !== false) {
        if (typeof window.toast === 'function') {
          window.toast('Scan complete — ' + (result.updated || units.length) + ' unit(s) updated', 'success', 'AAP Scan');
        }
      } else {
        if (typeof window.toast === 'function') {
          window.toast('Scan finished with errors', 'warning', 'AAP Scan');
        }
      }

      return result;
    } catch (e) {
      _closeProgressPanel(panel);
      console.warn('[aap-bridge] runAdaptiveScan error:', e);
      if (typeof window.toast === 'function') window.toast('Scan failed: ' + e.message, 'warning', 'AAP Scan');
    } finally {
      _lock.scan = false;
    }
  }

  async function runAdaptiveExtract(opts) {
    if (!HAS_ADAPTIVE || !(window.aap && typeof window.aap.adaptiveExtract === 'function')) return null;
    try {
      return await window.aap.adaptiveExtract(opts);
    } catch (e) {
      console.warn('[aap-bridge] adaptiveExtract error:', e);
      return null;
    }
  }

  /* ── 6. Open AAP URL ─────────────────────────────────────────────────── */

  function openAAPUrl(url) {
    if (!url) return;
    if (HAS_OPEN_URL) {
      window.aap.openUrl(url).catch(function (e) { console.warn('[aap-bridge] openUrl error:', e); });
    } else {
      // Dev fallback — log only
      console.log('[aap-bridge] openAAPUrl (dev):', url);
    }
  }

  /* ── 7. Create Work Request (WRITE — gate required) ─────────────────── */

  async function createWorkRequest(payload, unit) {
    if (_lock.createWR) {
      if (typeof window.toast === 'function') window.toast('WR creation already in progress', 'info', 'AAP');
      return;
    }

    const unitLabel = (payload && payload.unit) || (unit && unit.unitId) || '?';

    const confirmed = await _writeGate({
      title:        'Create Work Request',
      description:  'This will submit a new Work Request in AAP. The record will be created immediately and cannot be auto-reversed.',
      confirmLabel: 'Create WR',
      details: {
        'Unit':        unitLabel,
        'Title':       payload && payload.title,
        'Vendor':      payload && payload.vendor,
        'Issue':       payload && (payload.issue || payload.damageDescription),
        'Urgent':      payload && payload.urgent,
        'Domicile':    (unit && unit.site) || (payload && payload.domicile),
        'ARC Claim':   payload && payload.arcClaim,
        'SIM':         payload && payload.simNumber,
      },
    });

    if (!confirmed) return { cancelled: true };

    _lock.createWR = true;
    const panel = _makeProgressPanel('Creating WR — ' + unitLabel);
    _appendLog(panel, 'Submitting WR for ' + unitLabel + '...');

    try {
      let result;
      if (HAS_AAP) {
        if (HAS_WR_PROG) {
          window.aap.onWRProgress(function (msg) { _appendLog(panel, msg); });
        }
        result = await window.aap.createWR(payload, unit);
      } else {
        await new Promise(function (r) { setTimeout(r, 900); });
        result = { ok: true, wrId: 'DEV-' + Date.now(), dev: true };
        _appendLog(panel, '[dev] WR created: ' + result.wrId);
      }

      _closeProgressPanel(panel);

      if (result && result.ok !== false) {
        const wrId = result.wrId || result.id || '';
        if (typeof window.toast === 'function') {
          window.toast('WR created' + (wrId ? ': ' + wrId : ''), 'success', 'Work Request');
        }
        // Patch UNITS cache if result contains updated unit data
        if (result.unit && window.UNITS && unitLabel !== '?') {
          const key = Object.keys(window.UNITS).find(function (k) {
            return window.UNITS[k].unitId === unitLabel || k === unitLabel;
          });
          if (key) Object.assign(window.UNITS[key], result.unit);
        }
      } else {
        const err = (result && result.error) || 'Unknown error';
        if (typeof window.toast === 'function') {
          window.toast('WR creation failed: ' + err, 'warning', 'Work Request');
        }
      }

      return result;
    } catch (e) {
      _closeProgressPanel(panel);
      console.warn('[aap-bridge] createWorkRequest error:', e);
      if (typeof window.toast === 'function') {
        window.toast('WR creation failed: ' + e.message, 'warning', 'Work Request');
      }
    } finally {
      _lock.createWR = false;
    }
  }

  /* ── 8. Adaptive WR agent (WRITE — gate required) ───────────────────── */

  async function runAdaptiveWR(payload) {
    if (_lock.createWR) {
      if (typeof window.toast === 'function') window.toast('WR operation already in progress', 'info', 'AAP');
      return;
    }

    const unitLabel = (payload && payload.unit) || '?';

    const confirmed = await _writeGate({
      title:        'Run Adaptive WR Agent',
      description:  'The adaptive agent will analyze the unit and submit a Work Request automatically. This is a write operation.',
      confirmLabel: 'Run Agent',
      details: {
        'Unit':     unitLabel,
        'Issue':    payload && payload.issue,
        'Vendor':   payload && payload.vendor,
        'Urgent':   payload && payload.urgent,
      },
    });

    if (!confirmed) return { cancelled: true };

    _lock.createWR = true;
    const panel = _makeProgressPanel('Adaptive WR Agent — ' + unitLabel);
    _appendLog(panel, 'Starting adaptive WR agent for ' + unitLabel + '...');

    try {
      let result;
      if (HAS_AAP && window.aap && typeof window.aap.runAdaptive === 'function') {
        if (HAS_WR_PROG) {
          window.aap.onWRProgress(function (msg) { _appendLog(panel, msg); });
        }
        result = await window.aap.runAdaptive(payload);
      } else {
        await new Promise(function (r) { setTimeout(r, 900); });
        result = { ok: true, dev: true, message: 'Adaptive WR simulated' };
        _appendLog(panel, '[dev] Adaptive WR complete');
      }

      _closeProgressPanel(panel);

      if (result && result.ok !== false) {
        if (typeof window.toast === 'function') {
          window.toast('Adaptive WR complete', 'success', 'AAP');
        }
      } else {
        if (typeof window.toast === 'function') {
          window.toast('Adaptive WR failed: ' + ((result && result.error) || 'error'), 'warning', 'AAP');
        }
      }

      return result;
    } catch (e) {
      _closeProgressPanel(panel);
      console.warn('[aap-bridge] runAdaptiveWR error:', e);
      if (typeof window.toast === 'function') {
        window.toast('Adaptive WR failed: ' + e.message, 'warning', 'AAP');
      }
    } finally {
      _lock.createWR = false;
    }
  }

  /* ── 9. Autofill (WRITE — gate required, opens BrowserWindow) ────────── */

  async function launchAutofill(url, payload) {
    if (_lock.autofill) {
      if (typeof window.toast === 'function') window.toast('Autofill already in progress', 'info', 'AAP');
      return;
    }
    if (!url) {
      if (typeof window.toast === 'function') window.toast('No URL provided for autofill', 'warning', 'AAP');
      return;
    }

    const confirmed = await _writeGate({
      title:        'Launch AAP Autofill',
      description:  'A browser window will open and the autofill engine will attempt to populate and submit the WR form. Review the form before it submits.',
      confirmLabel: 'Open Autofill',
      details: {
        'URL':    url.slice(0, 80) + (url.length > 80 ? '...' : ''),
        'Unit':   payload && payload.unit,
        'Title':  payload && payload.title,
      },
    });

    if (!confirmed) return { cancelled: true };

    _lock.autofill = true;
    if (typeof window.toast === 'function') window.toast('Launching autofill...', 'info', 'AAP Autofill');

    try {
      let result;
      if (HAS_AUTOFILL) {
        result = await window.aap.autofill(url, payload);
      } else {
        await new Promise(function (r) { setTimeout(r, 900); });
        result = { ok: true, dev: true };
        console.log('[aap-bridge] Autofill (dev) — url:', url);
      }

      if (result && result.ok !== false) {
        if (typeof window.toast === 'function') {
          window.toast('Autofill window opened', 'success', 'AAP Autofill');
        }
      }

      return result;
    } catch (e) {
      console.warn('[aap-bridge] launchAutofill error:', e);
      if (typeof window.toast === 'function') {
        window.toast('Autofill failed: ' + e.message, 'warning', 'AAP Autofill');
      }
    } finally {
      _lock.autofill = false;
    }
  }

  /* ── 10. Lifecycle state change (WRITE — gate required) ─────────────── */

  const LIFECYCLE_STATES  = ['Active', 'Unavailable', 'End of Life', 'Ordered'];
  const LIFECYCLE_REASONS = {
    'Active':      ['Healthy', 'Returned to Service', 'Other'],
    'Unavailable': ['Offsite Shop Repair', 'Waiting Parts', 'DEA - Asset Shortage', 'PM Due', 'Other'],
    'End of Life': ['Decommissioned', 'Totaled', 'Sold', 'Other'],
    'Ordered':     ['New Asset', 'Replacement', 'Other'],
  };

  function _buildLifecycleModal(unit) {
    return new Promise(function (resolve) {
      const id = 'aap-lc-modal-' + Date.now();

      const overlay = document.createElement('div');
      overlay.id = id;
      overlay.style.cssText =
        'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9998;' +
        'background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center';

      const unitLabel = (unit && (unit.unitId || unit.id)) || '?';

      const stateOpts = LIFECYCLE_STATES.map(function (s) {
        return '<option value="' + s + '">' + s + '</option>';
      }).join('');

      const reasonOpts = Object.values(LIFECYCLE_REASONS).flat()
        .filter(function (v, i, a) { return a.indexOf(v) === i; })
        .map(function (r) { return '<option value="' + r + '">' + r + '</option>'; })
        .join('');

      const inputStyle = 'width:100%;background:var(--el,rgba(255,255,255,.06));border:1px solid ' +
        'var(--bdr,rgba(240,246,252,.12));border-radius:5px;padding:7px 10px;color:var(--txt,#eaeaea);' +
        'font-size:12px;outline:none;box-sizing:border-box';

      overlay.innerHTML =
        '<div style="background:var(--bg2,#1a1f2c);border:1px solid var(--bdr,rgba(240,246,252,.12));' +
        'border-radius:10px;padding:24px 28px;max-width:440px;width:90%;' +
        'box-shadow:0 20px 60px rgba(0,0,0,.6);font-family:var(--font,system-ui,sans-serif)">' +

          '<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">' +
            '<span style="background:#e53e3e;color:#fff;font-size:9px;font-weight:800;' +
            'padding:2px 7px;border-radius:4px">WRITE OPERATION</span>' +
            '<span style="font-size:13px;font-weight:700;color:var(--txt,#eaeaea)">Set Lifecycle State</span>' +
          '</div>' +

          '<div style="font-size:11px;color:var(--txt2,#8b949e);margin-bottom:14px">' +
            'Unit: <strong style="color:var(--acc2,#58a6ff)">' + unitLabel + '</strong>' +
          '</div>' +

          '<div style="margin-bottom:12px">' +
            '<label style="font-size:11px;color:var(--mut,#6e7681);display:block;margin-bottom:4px">New State</label>' +
            '<select id="lc-state-sel" style="' + inputStyle + '">' + stateOpts + '</select>' +
          '</div>' +

          '<div style="margin-bottom:12px">' +
            '<label style="font-size:11px;color:var(--mut,#6e7681);display:block;margin-bottom:4px">Reason</label>' +
            '<select id="lc-reason-sel" style="' + inputStyle + '">' + reasonOpts + '</select>' +
          '</div>' +

          '<div style="margin-bottom:20px">' +
            '<label style="font-size:11px;color:var(--mut,#6e7681);display:block;margin-bottom:4px">Notes (optional)</label>' +
            '<input id="lc-notes-in" type="text" placeholder="e.g. Returned from shop 2026-06-28" style="' + inputStyle + '">' +
          '</div>' +

          '<div style="display:flex;gap:10px;justify-content:flex-end">' +
            '<button id="lc-cancel" style="padding:7px 18px;background:var(--el,rgba(255,255,255,.08));' +
            'border:1px solid var(--bdr,rgba(240,246,252,.12));border-radius:6px;color:var(--txt2,#8b949e);' +
            'font-size:12px;cursor:pointer">Cancel</button>' +
            '<button id="lc-confirm" style="padding:7px 18px;background:#e53e3e;border:none;' +
            'border-radius:6px;color:#fff;font-size:12px;font-weight:700;cursor:pointer">Set Lifecycle</button>' +
          '</div>' +

        '</div>';

      document.body.appendChild(overlay);

      // Update reason options when state changes
      const stateSel  = overlay.querySelector('#lc-state-sel');
      const reasonSel = overlay.querySelector('#lc-reason-sel');

      stateSel.addEventListener('change', function () {
        const reasons = LIFECYCLE_REASONS[stateSel.value] || ['Other'];
        reasonSel.innerHTML = reasons.map(function (r) {
          return '<option value="' + r + '">' + r + '</option>';
        }).join('');
      });

      function _close(val) { overlay.remove(); resolve(val); }

      overlay.querySelector('#lc-cancel').addEventListener('click', function () { _close(null); });
      overlay.querySelector('#lc-confirm').addEventListener('click', function () {
        _close({
          state:  stateSel.value,
          reason: reasonSel.value,
          notes:  (overlay.querySelector('#lc-notes-in') || {}).value || '',
        });
      });
      overlay.addEventListener('click', function (e) { if (e.target === overlay) _close(null); });
    });
  }

  async function setLifecycle(equipmentId, assetUrl, stateIn, reasonIn) {
    if (_lock.lifecycle) {
      if (typeof window.toast === 'function') window.toast('Lifecycle change in progress', 'info', 'AAP');
      return;
    }

    // If state/reason not provided, show interactive modal
    let state  = stateIn;
    let reason = reasonIn;

    if (!state) {
      const unit = window.UNITS && (window.UNITS[equipmentId] || Object.values(window.UNITS).find(function (u) { return u.aaid === equipmentId; }));
      const choice = await _buildLifecycleModal(unit || { unitId: equipmentId });
      if (!choice) return { cancelled: true };
      state  = choice.state;
      reason = choice.reason;
    }

    // Gate confirmation even after modal (shows exactly what will be sent)
    const confirmed = await _writeGate({
      title:        'Confirm Lifecycle Change',
      description:  'This will update the unit lifecycle state in AAP immediately.',
      confirmLabel: 'Apply Change',
      details: {
        'Equipment ID': equipmentId,
        'New State':    state,
        'Reason':       reason,
        'URL':          assetUrl ? assetUrl.slice(0, 60) + '...' : '(auto-resolve)',
      },
    });

    if (!confirmed) return { cancelled: true };

    _lock.lifecycle = true;

    try {
      let result;
      if (HAS_LIFECYCLE) {
        result = await window.aap.setLifecycle(equipmentId, assetUrl, state, reason);
      } else {
        await new Promise(function (r) { setTimeout(r, 900); });
        result = { ok: true, dev: true };
        console.log('[aap-bridge] setLifecycle (dev):', equipmentId, state, reason);
      }

      if (result && result.ok !== false) {
        if (typeof window.toast === 'function') {
          window.toast('Lifecycle set to ' + state, 'success', 'AAP Lifecycle');
        }
        // Patch UNITS cache
        if (window.UNITS) {
          const key = Object.keys(window.UNITS).find(function (k) {
            return window.UNITS[k].aaid === equipmentId || k === equipmentId;
          });
          if (key) {
            window.UNITS[key].lifecycleState = state;
            window.UNITS[key].lifecycleReason = reason;
          }
        }
      } else {
        const err = (result && result.error) || 'Unknown error';
        if (typeof window.toast === 'function') {
          window.toast('Lifecycle change failed: ' + err, 'warning', 'AAP Lifecycle');
        }
      }

      return result;
    } catch (e) {
      console.warn('[aap-bridge] setLifecycle error:', e);
      if (typeof window.toast === 'function') {
        window.toast('Lifecycle change failed: ' + e.message, 'warning', 'AAP Lifecycle');
      }
    } finally {
      _lock.lifecycle = false;
    }
  }

  /* ── 11. Drawer + context menu injection ─────────────────────────────── */

  function _injectDrawerButtons() {
    const panel = document.querySelector('.drawer-actions-panel, .drawer-actions, #drawerActions');
    if (!panel || panel.dataset.aapInjected) return;
    panel.dataset.aapInjected = '1';

    // "Create WR" button — WRITE (visible treatment)
    const wrBtn = document.createElement('button');
    wrBtn.className = 'action-btn';
    wrBtn.style.cssText = 'border-left:2px solid #e53e3e;';
    wrBtn.innerHTML = '📋 Create WR';
    wrBtn.title = 'Create a Work Request in AAP (write operation)';
    wrBtn.addEventListener('click', function () {
      const unit = typeof window._getActiveUnit === 'function' ? window._getActiveUnit() : null;
      if (!unit) {
        if (typeof window.toast === 'function') window.toast('No unit selected', 'warning', 'AAP');
        return;
      }
      const payload = _collectPayload(unit);
      createWorkRequest(payload, unit);
    });

    // "Adaptive Scan" button — read-only
    const scanBtn = document.createElement('button');
    scanBtn.className = 'action-btn';
    scanBtn.innerHTML = '🔄 Adaptive Scan';
    scanBtn.title = 'Run adaptive scrape on this unit (read-only)';
    scanBtn.addEventListener('click', function () {
      const unit = typeof window._getActiveUnit === 'function' ? window._getActiveUnit() : null;
      if (!unit) {
        if (typeof window.toast === 'function') window.toast('No unit selected', 'warning', 'AAP');
        return;
      }
      runAdaptiveScan([unit]);
    });

    panel.appendChild(wrBtn);
    panel.appendChild(scanBtn);
  }

  function _injectContextMenuItems() {
    const menu = document.getElementById('contextMenu') || document.querySelector('.ctx-menu, #ctx-menu');
    if (!menu || menu.dataset.aapInjected) return;
    menu.dataset.aapInjected = '1';

    const wrItem = document.createElement('div');
    wrItem.className = 'ctx-item';
    wrItem.innerHTML = '📋 Create Work Request';
    wrItem.addEventListener('click', function () {
      menu.style.display = 'none';
      const unit = typeof window._ctxUnit !== 'undefined' ? window._ctxUnit : null;
      if (!unit) return;
      const payload = _collectPayload(unit);
      createWorkRequest(payload, unit);
    });

    const openItem = document.createElement('div');
    openItem.className = 'ctx-item';
    openItem.innerHTML = '🔗 Open in AAP';
    openItem.addEventListener('click', function () {
      menu.style.display = 'none';
      const unit = typeof window._ctxUnit !== 'undefined' ? window._ctxUnit : null;
      const url = unit && (unit.assetUrl || unit.aapUrl);
      if (!url) {
        if (typeof window.toast === 'function') window.toast('No AAP URL for this unit', 'warning', 'AAP');
        return;
      }
      openAAPUrl(url);
    });

    menu.appendChild(wrItem);
    menu.appendChild(openItem);
  }

  /** Collect a sensible WR payload from a UNITS entry */
  function _collectPayload(unit) {
    return {
      unit:        unit.unitId || unit.id || '',
      title:       'Fleet Issue — ' + (unit.unitId || ''),
      issue:       unit.aiSummary || unit.notes || '',
      vendor:      unit.vendor || unit.vendorSuggested || '',
      urgent:      unit.urgent === true ? 'Yes' : 'No',
      urgencyReason: unit.urgencyReason || '',
      domicile:    unit.site || unit.domicile || '',
      contactName:  '',
      contactPhone: '',
      arcClaim:    unit.arcClaim || '',
      simNumber:   unit.simNumber || '',
      areaPairs:   unit.areaPairs || [],
      comments:    unit.notes || '',
      shareWith:   '',
    };
  }

  /* ── 12. MutationObserver for drawer open ───────────────────────────── */

  function _watchDrawer() {
    const drawer = document.getElementById('drawer') || document.querySelector('.drawer, #unitDrawer');
    if (!drawer) return;

    const obs = new MutationObserver(function (mutations) {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'class') {
          if (drawer.classList.contains('open')) {
            setTimeout(_injectDrawerButtons, 80);
            setTimeout(_injectContextMenuItems, 80);
          }
        }
      }
    });
    obs.observe(drawer, { attributes: true });
  }

  /* ── 13. Boot ────────────────────────────────────────────────────────── */

  function boot() {
    window.runAdaptiveScan    = runAdaptiveScan;
    window.runAdaptiveExtract = runAdaptiveExtract;
    window.createWorkRequest  = createWorkRequest;
    window.runAdaptiveWR      = runAdaptiveWR;
    window.launchAutofill     = launchAutofill;
    window.setLifecycle       = setLifecycle;
    window.openAAPUrl         = openAAPUrl;

    _watchDrawer();
    // Try immediate injection in case drawer is already open
    setTimeout(_injectDrawerButtons, 200);
    setTimeout(_injectContextMenuItems, 200);

    console.log(
      '[aap-bridge] loaded — IPC:' + HAS_AAP +
      ' adaptive:' + HAS_ADAPTIVE +
      ' autofill:' + HAS_AUTOFILL +
      ' lifecycle:' + HAS_LIFECYCLE
    );
  }

  /* ── 14. Debug handle ────────────────────────────────────────────────── */

  window._aapBridge = {
    version:           '1.0.0',
    HAS_AAP:            HAS_AAP,
    HAS_ADAPTIVE:       HAS_ADAPTIVE,
    HAS_AUTOFILL:       HAS_AUTOFILL,
    HAS_LIFECYCLE:      HAS_LIFECYCLE,
    HAS_OPEN_URL:       HAS_OPEN_URL,
    locks:             _lock,
    runAdaptiveScan:    runAdaptiveScan,
    runAdaptiveExtract: runAdaptiveExtract,
    createWorkRequest:  createWorkRequest,
    runAdaptiveWR:      runAdaptiveWR,
    launchAutofill:     launchAutofill,
    setLifecycle:       setLifecycle,
    openAAPUrl:         openAAPUrl,
    collectPayload:     _collectPayload,
  };

  /* ── 15. Start ───────────────────────────────────────────────────────── */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();

/**
 * daily-notes-bridge.js — Module 7: Daily Notes Automation Bridge
 * Fleet Ops V-C, Stage 2
 *
 * Orchestrates the long-running daily notes AI pipeline:
 *
 * Run pipeline
 *   window.runDailyNotes(units[])         → daily-notes:run IPC
 *   - Streams progress events via daily-notes:progress into a live sidebar panel
 *   - On completion: hydrates each unit row + notes area + UNITS cache
 *   - Calls window.saveNote(unitId, note) for each unit that has a new note
 *
 * Log
 *   window.getDailyNotesLog()             → daily-notes:get-log IPC
 *   - Returns array of prior run summaries for the log panel
 *
 * Side-by-side windows
 *   window.openDailyWindows(opts)         → daily-notes:open-windows IPC
 *   opts: { unitId, relayUrl, offsiteUrl }
 *
 * UI entry points
 *   - Topbar "Daily Notes" button → run pipeline for all loaded UNITS
 *   - Right-click context menu → "Run Daily Note" for single unit
 *   - Progress sidebar: live streaming log + per-unit status chips
 *   - Results panel: accordion of outcomes, click-to-accept individual notes
 *
 * Capability flags (captured once at load time):
 *   HAS_DAILY_RUN   — window.ai.runDailyNotes available
 *   HAS_DAILY_LOG   — window.ai.getDailyNotesLog available
 *   HAS_DAILY_PROG  — window.ai.onDailyNotesProgress available
 *   HAS_DAILY_WIN   — window.ai.openDailyWindows available
 *
 * Progress: events pipe in real-time from main process via IPC push.
 * In-flight lock prevents double-fire while run is active.
 * Dev fallback: canned results with streaming simulation.
 * window._dailyNotesBridge debug handle exposed.
 */

(function () {
  'use strict';

  /* ── 1. Capability detection ────────────────────────────────────────── */
  const HAS_DAILY_RUN  = !!(window.ai && typeof window.ai.runDailyNotes         === 'function');
  const HAS_DAILY_LOG  = !!(window.ai && typeof window.ai.getDailyNotesLog      === 'function');
  const HAS_DAILY_PROG = !!(window.ai && typeof window.ai.onDailyNotesProgress  === 'function');
  const HAS_DAILY_WIN  = !!(window.ai && typeof window.ai.openDailyWindows      === 'function');

  /* ── 2. State ────────────────────────────────────────────────────────── */
  const _state = {
    running:    false,
    lastResults: null,
  };

  /* ── 3. Progress sidebar ─────────────────────────────────────────────── */

  function _buildProgressSidebar(unitCount) {
    _destroyProgressSidebar();

    const panel = document.createElement('div');
    panel.id    = 'dn-progress-panel';
    panel.style.cssText =
      'position:fixed;right:0;top:0;width:320px;height:100vh;z-index:8500;' +
      'background:var(--bg,#0d1117);border-left:1px solid var(--bdr,rgba(240,246,252,.12));' +
      'display:flex;flex-direction:column;overflow:hidden;' +
      'animation:slideInRight .18s ease;font-family:var(--font,system-ui,sans-serif)';

    panel.innerHTML =
      /* header */
      '<div style="padding:14px 16px;background:var(--el,rgba(255,255,255,.05));' +
      'border-bottom:1px solid var(--bdr,rgba(240,246,252,.08));flex-shrink:0">' +
        '<div style="display:flex;align-items:center;justify-content:space-between">' +
          '<div style="display:flex;align-items:center;gap:8px">' +
            '<span id="dn-spin" style="color:var(--acc,#1f6feb);animation:spin 1s linear infinite;font-size:14px">⟳</span>' +
            '<span style="font-size:12px;font-weight:700;color:var(--txt,#eaeaea)">Daily Notes Running</span>' +
          '</div>' +
          '<button id="dn-close-btn" title="Close panel (does not stop run)" ' +
          'style="background:none;border:none;color:var(--mut,#6e7681);cursor:pointer;font-size:14px;padding:2px 6px">✕</button>' +
        '</div>' +
        '<div style="margin-top:8px;display:flex;align-items:center;gap:6px">' +
          '<div id="dn-prog-bar-wrap" style="flex:1;height:4px;background:var(--el2,rgba(255,255,255,.08));border-radius:2px;overflow:hidden">' +
            '<div id="dn-prog-bar" style="height:4px;width:0%;background:var(--acc,#1f6feb);border-radius:2px;transition:width .3s ease"></div>' +
          '</div>' +
          '<span id="dn-prog-label" style="font-size:10px;color:var(--mut,#6e7681);white-space:nowrap">0 / ' + unitCount + '</span>' +
        '</div>' +
      '</div>' +

      /* unit status chips */
      '<div id="dn-unit-chips" style="padding:10px 12px;display:flex;flex-wrap:wrap;gap:5px;' +
      'border-bottom:1px solid var(--bdr,rgba(240,246,252,.08));flex-shrink:0;max-height:90px;overflow-y:auto"></div>' +

      /* log stream */
      '<div id="dn-log-stream" style="flex:1;overflow-y:auto;padding:8px 12px;' +
      'font-size:10px;font-family:var(--mono,monospace);color:var(--txt2,#8b949e);line-height:1.65"></div>';

    document.body.appendChild(panel);

    panel.querySelector('#dn-close-btn').addEventListener('click', _destroyProgressSidebar);
    return panel;
  }

  function _destroyProgressSidebar() {
    const old = document.getElementById('dn-progress-panel');
    if (old) old.remove();
  }

  function _logLine(panel, msg) {
    const stream = panel && panel.querySelector('#dn-log-stream');
    if (!stream) return;

    // Colorise key prefixes
    let color = 'var(--txt2,#8b949e)';
    if (/error|fail/i.test(msg))     color = 'var(--red,#f85149)';
    else if (/complete|done|✓/i.test(msg)) color = 'var(--grn,#3fb950)';
    else if (/AI|orcha/i.test(msg))  color = 'var(--acc,#1f6feb)';
    else if (/decision/i.test(msg))  color = 'var(--acc2,#58a6ff)';

    const line = document.createElement('div');
    line.style.cssText = 'padding:1px 0;color:' + color;
    line.textContent = msg;
    stream.appendChild(line);
    stream.scrollTop = stream.scrollHeight;
  }

  function _updateProgress(panel, done, total) {
    const bar   = panel && panel.querySelector('#dn-prog-bar');
    const label = panel && panel.querySelector('#dn-prog-label');
    if (bar)   bar.style.width = Math.round((done / total) * 100) + '%';
    if (label) label.textContent = done + ' / ' + total;
  }

  function _setChipState(panel, unitId, state) {
    // state: 'running' | 'done' | 'skip' | 'error'
    if (!panel) return;
    const chips  = panel.querySelector('#dn-unit-chips');
    if (!chips)  return;

    let chip = chips.querySelector('[data-uid="' + unitId + '"]');
    if (!chip) {
      chip = document.createElement('div');
      chip.dataset.uid = unitId;
      chip.style.cssText =
        'font-size:9px;font-family:var(--mono,monospace);padding:2px 6px;border-radius:3px;' +
        'border:1px solid transparent;transition:all .2s';
      chip.textContent = unitId;
      chips.appendChild(chip);
    }

    const styles = {
      running: 'background:rgba(31,111,235,.2);border-color:var(--acc,#1f6feb);color:var(--acc,#1f6feb)',
      done:    'background:rgba(63,185,80,.15);border-color:var(--grn,#3fb950);color:var(--grn,#3fb950)',
      skip:    'background:rgba(139,148,158,.1);border-color:rgba(139,148,158,.3);color:var(--mut,#6e7681)',
      error:   'background:rgba(248,81,73,.15);border-color:var(--red,#f85149);color:var(--red,#f85149)',
    };
    chip.style.cssText = chip.style.cssText.replace(/;$/, '') + ';' + (styles[state] || styles.skip);
  }

  function _finaliseSidebar(panel) {
    const spinner = panel && panel.querySelector('#dn-spin');
    if (spinner) { spinner.style.animation = 'none'; spinner.textContent = '✓'; spinner.style.color = 'var(--grn,#3fb950)'; }
    const header  = panel && panel.querySelector('div');
    if (header) {
      const titleEl = header.querySelector('span:nth-child(2)');
      if (titleEl) titleEl.textContent = 'Daily Notes Complete';
    }
  }

  /* ── 4. Results panel ────────────────────────────────────────────────── */

  function _buildResultsPanel(results, panel) {
    _destroyResultsPanel();

    const hasNotes = results.filter(function (r) { return r.hasChanges && r.note; });
    const skipped  = results.filter(function (r) { return !r.hasChanges; });
    const errors   = results.filter(function (r) { return r.decision === 'ERROR'; });

    const rPanel = document.createElement('div');
    rPanel.id    = 'dn-results-panel';
    rPanel.style.cssText =
      'position:fixed;right:' + (document.getElementById('dn-progress-panel') ? '320px' : '0') + ';top:0;' +
      'width:380px;height:100vh;z-index:8400;' +
      'background:var(--bg2,#1a1f2c);border-left:1px solid var(--bdr,rgba(240,246,252,.12));' +
      'display:flex;flex-direction:column;overflow:hidden;' +
      'animation:slideInRight .2s ease;font-family:var(--font,system-ui,sans-serif)';

    const summary =
      '<div style="padding:12px 16px;background:var(--el,rgba(255,255,255,.05));' +
      'border-bottom:1px solid var(--bdr,rgba(240,246,252,.08));flex-shrink:0">' +
        '<div style="font-size:12px;font-weight:700;color:var(--txt,#eaeaea);margin-bottom:8px">Results — ' +
          new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + '</div>' +
        '<div style="display:flex;gap:12px;font-size:11px">' +
          '<span style="color:var(--grn,#3fb950)">✓ ' + hasNotes.length + ' notes</span>' +
          '<span style="color:var(--mut,#6e7681)">– ' + skipped.length + ' skipped</span>' +
          (errors.length ? '<span style="color:var(--red,#f85149)">✗ ' + errors.length + ' errors</span>' : '') +
        '</div>' +
        '<div style="margin-top:10px;display:flex;gap:6px">' +
          '<button id="dn-accept-all" style="flex:1;padding:6px;background:var(--acc,#1f6feb);border:none;' +
          'border-radius:5px;color:#fff;font-size:11px;font-weight:700;cursor:pointer">Accept All (' + hasNotes.length + ')</button>' +
          '<button id="dn-close-results" style="padding:6px 10px;background:var(--el,rgba(255,255,255,.08));' +
          'border:1px solid var(--bdr,rgba(240,246,252,.12));border-radius:5px;color:var(--txt2,#8b949e);' +
          'font-size:11px;cursor:pointer">Close</button>' +
        '</div>' +
      '</div>';

    const itemsHtml = results.map(function (r) {
      const hasNote   = r.hasChanges && r.note;
      const isError   = r.decision === 'ERROR';
      const accentCol = isError ? 'var(--red,#f85149)' : (hasNote ? 'var(--grn,#3fb950)' : 'var(--mut,#6e7681)');
      const dot       = isError ? '✗' : (hasNote ? '✓' : '–');

      return '<div class="dn-result-item" data-uid="' + r.unitId + '" ' +
        'style="padding:10px 14px;border-bottom:1px solid rgba(240,246,252,.05)">' +

        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:' + (hasNote ? '6px' : '0') + '">' +
          '<span style="color:' + accentCol + ';font-size:11px;width:12px;flex-shrink:0">' + dot + '</span>' +
          '<span style="font-size:11px;font-weight:600;color:var(--txt,#eaeaea);flex:1">' + r.unitId + '</span>' +
          (r.vendor ? '<span style="font-size:9px;color:var(--mut,#6e7681);text-align:right">' + r.vendor.slice(0, 22) + '</span>' : '') +
        '</div>' +

        (hasNote
          ? '<div style="background:var(--el,rgba(255,255,255,.05));border-radius:5px;padding:7px 10px;' +
            'font-size:11px;color:var(--txt2,#8b949e);line-height:1.5;margin-bottom:6px">' +
            _escHtml(r.note) + '</div>' +
            '<div style="display:flex;gap:6px">' +
              '<button class="dn-accept-one" data-uid="' + r.unitId + '" data-note="' + _escAttr(r.note) + '" ' +
              'style="flex:1;padding:4px;background:rgba(63,185,80,.15);border:1px solid var(--grn,#3fb950);' +
              'border-radius:4px;color:var(--grn,#3fb950);font-size:10px;cursor:pointer">Accept</button>' +
              (r.woUrl
                ? '<button class="dn-open-win" data-uid="' + r.unitId + '" ' +
                  'data-relay="' + _escAttr(r.woUrl) + '" data-offsite="' + _escAttr(r.offsiteUrl || '') + '" ' +
                  'style="padding:4px 8px;background:rgba(31,111,235,.15);border:1px solid var(--acc,#1f6feb);' +
                  'border-radius:4px;color:var(--acc,#1f6feb);font-size:10px;cursor:pointer">🔗</button>'
                : '') +
            '</div>'
          : '<div style="font-size:10px;color:var(--mut,#6e7681)">' +
            (isError ? _escHtml(r.note || r.reason) : 'No update — ' + _escHtml(r.reason || 'no changes detected')) +
            '</div>'
        ) +

        '</div>';
    }).join('');

    rPanel.innerHTML =
      summary +
      '<div style="flex:1;overflow-y:auto">' + itemsHtml + '</div>';

    document.body.appendChild(rPanel);

    // Accept all
    rPanel.querySelector('#dn-accept-all').addEventListener('click', function () {
      hasNotes.forEach(function (r) { _acceptNote(r.unitId, r.note); });
      if (typeof window.toast === 'function') {
        window.toast('Accepted ' + hasNotes.length + ' note' + (hasNotes.length !== 1 ? 's' : ''), 'success', 'Daily Notes');
      }
      _destroyResultsPanel();
      _destroyProgressSidebar();
    });

    // Close
    rPanel.querySelector('#dn-close-results').addEventListener('click', function () {
      _destroyResultsPanel();
      _destroyProgressSidebar();
    });

    // Individual accepts
    rPanel.querySelectorAll('.dn-accept-one').forEach(function (btn) {
      btn.addEventListener('click', function () {
        _acceptNote(btn.dataset.uid, btn.dataset.note);
        const item = btn.closest('.dn-result-item');
        if (item) {
          item.style.opacity = '0.4';
          btn.disabled = true;
          btn.textContent = '✓ Accepted';
        }
      });
    });

    // Open side-by-side windows
    rPanel.querySelectorAll('.dn-open-win').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openDailyWindows({
          unitId:     btn.dataset.uid,
          relayUrl:   btn.dataset.relay,
          offsiteUrl: btn.dataset.offsite || '',
        });
      });
    });
  }

  function _destroyResultsPanel() {
    const old = document.getElementById('dn-results-panel');
    if (old) old.remove();
  }

  function _escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function _escAttr(s) {
    return String(s || '').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  /* ── 5. Accept a note → saveNote → UNITS cache ───────────────────────── */

  function _acceptNote(unitId, note) {
    if (!unitId || !note) return;

    // Use existing saveNote bridge (notes-bridge.js) if available
    if (typeof window.saveNote === 'function') {
      window.saveNote(unitId, note).catch(function (e) {
        console.warn('[daily-notes-bridge] saveNote error for', unitId, e);
      });
    }

    // Patch UNITS cache directly too
    if (window.UNITS) {
      const key = Object.keys(window.UNITS).find(function (k) {
        return window.UNITS[k].unitId === unitId || window.UNITS[k].id === unitId || k === unitId;
      });
      if (key) {
        const existing = window.UNITS[key].savedNotes || '';
        const date     = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' });
        window.UNITS[key].savedNotes = (existing ? existing + '\n' : '') + date + ' — ' + note;
      }
    }

    // If notes area is visible and matches this unit, update it
    const notesArea = document.getElementById('notesArea');
    const drawerUnitId = document.querySelector('[data-active-unit]')
      && document.querySelector('[data-active-unit]').dataset.activeUnit;

    if (notesArea && drawerUnitId === unitId) {
      const date  = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' });
      const entry = date + ' — ' + note;
      notesArea.value = (notesArea.value ? notesArea.value + '\n' : '') + entry;
    }
  }

  /* ── 6. runDailyNotes ────────────────────────────────────────────────── */

  async function runDailyNotes(units) {
    if (_state.running) {
      if (typeof window.toast === 'function') window.toast('Daily Notes run already in progress', 'info', 'Daily Notes');
      return;
    }
    if (!Array.isArray(units) || !units.length) {
      if (typeof window.toast === 'function') window.toast('No units provided', 'warning', 'Daily Notes');
      return;
    }

    // Filter to units with altId (backend does same filter, mirror it here for count)
    const eligible = units.filter(function (u) { return u.altId && String(u.altId).trim(); });
    if (!eligible.length) {
      if (typeof window.toast === 'function') {
        window.toast('No units have Alt IDs — nothing to run', 'info', 'Daily Notes');
      }
      return;
    }

    _state.running = true;
    const panel = _buildProgressSidebar(eligible.length);
    _logLine(panel, 'Starting daily notes for ' + eligible.length + ' unit(s)...');

    let doneCount = 0;

    // Wire progress stream before invoking run
    if (HAS_DAILY_PROG) {
      window.ai.onDailyNotesProgress(function (msg) {
        _logLine(panel, msg);

        // Parse "Unit X" out of progress messages to update chips
        const unitMatch = msg.match(/Unit\s+([A-Z0-9\-]+)/i);
        if (unitMatch) {
          const uid = unitMatch[1];
          if (/error/i.test(msg))   _setChipState(panel, uid, 'error');
          else if (/Decision/i.test(msg)) {
            if (/NO_ACTION/i.test(msg)) _setChipState(panel, uid, 'skip');
            else                         _setChipState(panel, uid, 'done');
            doneCount++;
            _updateProgress(panel, doneCount, eligible.length);
          } else {
            _setChipState(panel, uid, 'running');
          }
        }
      });
    }

    try {
      let results;

      if (HAS_DAILY_RUN) {
        results = await window.ai.runDailyNotes(units);
      } else {
        // Dev fallback — simulate streaming
        results = [];
        for (let i = 0; i < eligible.length; i++) {
          const u = eligible[i];
          await new Promise(function (r) { setTimeout(r, 220); });
          _setChipState(panel, u.unitId || u.id, 'running');
          _logLine(panel, '[DailyNotes] (' + (i + 1) + '/' + eligible.length + ') Unit ' + (u.unitId || u.id) + ' — ' + u.altId);
          await new Promise(function (r) { setTimeout(r, 280); });

          const hasNote = i % 3 !== 2; // 2 in 3 get a note in dev mode
          _setChipState(panel, u.unitId || u.id, hasNote ? 'done' : 'skip');
          doneCount++;
          _updateProgress(panel, doneCount, eligible.length);

          results.push({
            unitId:     u.unitId || u.id || 'UNIT' + i,
            altId:      u.altId,
            vendor:     u.vendor || 'Vendor ' + i,
            woUrl:      '',
            offsiteUrl: '',
            note:       hasNote ? '[dev] Simulated note for unit ' + (u.unitId || u.id) + '. Parts on order, ETA 2 days.' : '',
            hasChanges: hasNote,
            decision:   hasNote ? 'NEW_UPDATE' : 'NO_ACTION_NEEDED',
            reason:     hasNote ? 'Dev simulation' : 'No changes',
          });
        }
      }

      _state.lastResults = results;
      _finaliseSidebar(panel);

      const noteCount = results.filter(function (r) { return r.hasChanges && r.note; }).length;
      _logLine(panel, '✓ Complete — ' + noteCount + ' note(s) generated.');

      if (typeof window.toast === 'function') {
        window.toast('Daily Notes complete — ' + noteCount + ' note' + (noteCount !== 1 ? 's' : '') + ' ready', 'success', 'Daily Notes');
      }

      // Show results panel after short pause
      setTimeout(function () { _buildResultsPanel(results, panel); }, 600);

      return results;

    } catch (e) {
      _finaliseSidebar(panel);
      _logLine(panel, '✗ Run failed: ' + e.message);
      console.warn('[daily-notes-bridge] runDailyNotes error:', e);
      if (typeof window.toast === 'function') {
        window.toast('Daily Notes run failed: ' + e.message, 'warning', 'Daily Notes');
      }
    } finally {
      _state.running = false;
    }
  }

  /* ── 7. getDailyNotesLog ─────────────────────────────────────────────── */

  async function getDailyNotesLog() {
    if (!HAS_DAILY_LOG) return [];
    try {
      return await window.ai.getDailyNotesLog();
    } catch (e) {
      console.warn('[daily-notes-bridge] getDailyNotesLog error:', e);
      return [];
    }
  }

  /* ── 8. openDailyWindows ─────────────────────────────────────────────── */

  async function openDailyWindows(opts) {
    if (!opts || (!opts.relayUrl && !opts.offsiteUrl)) {
      if (typeof window.toast === 'function') window.toast('No URLs provided for daily windows', 'warning', 'Daily Notes');
      return;
    }
    if (!HAS_DAILY_WIN) {
      // Dev fallback — nothing to open
      console.log('[daily-notes-bridge] openDailyWindows (dev):', opts);
      return;
    }
    try {
      const r = await window.ai.openDailyWindows(opts);
      if (r && r.opened > 0 && typeof window.toast === 'function') {
        window.toast('Opened ' + r.opened + ' window' + (r.opened !== 1 ? 's' : ''), 'info', 'Daily Notes');
      }
      return r;
    } catch (e) {
      console.warn('[daily-notes-bridge] openDailyWindows error:', e);
    }
  }

  /* ── 9. Topbar button injection ─────────────────────────────────────── */

  function _injectTopbarButton() {
    // Target the topbar action group — look for a known sibling like the chat or settings button
    const topbar = document.getElementById('topbar') || document.querySelector('.topbar, header');
    if (!topbar || document.getElementById('dn-topbar-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'dn-topbar-btn';
    btn.className = 'tb-btn';
    btn.innerHTML = '📋 Daily Notes';
    btn.title = 'Run Daily Notes AI for all loaded units';
    btn.style.cssText =
      'padding:4px 10px;background:var(--el,rgba(255,255,255,.08));' +
      'border:1px solid var(--bdr,rgba(240,246,252,.12));border-radius:5px;' +
      'color:var(--txt2,#8b949e);font-size:11px;font-weight:600;cursor:pointer;' +
      'transition:background .15s,color .15s';

    btn.addEventListener('mouseenter', function () {
      btn.style.background = 'rgba(31,111,235,.18)';
      btn.style.color      = 'var(--acc2,#58a6ff)';
    });
    btn.addEventListener('mouseleave', function () {
      btn.style.background = 'var(--el,rgba(255,255,255,.08))';
      btn.style.color      = 'var(--txt2,#8b949e)';
    });

    btn.addEventListener('click', function () {
      if (_state.running) {
        if (typeof window.toast === 'function') window.toast('Run already in progress', 'info', 'Daily Notes');
        return;
      }
      const units = window.UNITS ? Object.values(window.UNITS) : [];
      if (!units.length) {
        if (typeof window.toast === 'function') window.toast('No units loaded', 'warning', 'Daily Notes');
        return;
      }
      runDailyNotes(units);
    });

    topbar.appendChild(btn);
  }

  /* ── 10. Context menu injection ─────────────────────────────────────── */

  function _injectContextMenuItem() {
    const menu = document.getElementById('contextMenu') || document.querySelector('.ctx-menu, #ctx-menu');
    if (!menu || menu.dataset.dnInjected) return;
    menu.dataset.dnInjected = '1';

    const item = document.createElement('div');
    item.className = 'ctx-item';
    item.innerHTML = '📋 Run Daily Note';
    item.addEventListener('click', function () {
      menu.style.display = 'none';
      const unit = typeof window._ctxUnit !== 'undefined' ? window._ctxUnit : null;
      if (!unit) return;
      runDailyNotes([unit]);
    });

    menu.appendChild(item);
  }

  /* ── 11. Boot ────────────────────────────────────────────────────────── */

  function boot() {
    window.runDailyNotes    = runDailyNotes;
    window.getDailyNotesLog = getDailyNotesLog;
    window.openDailyWindows = openDailyWindows;

    _injectTopbarButton();
    _injectContextMenuItem();

    console.log(
      '[daily-notes-bridge] loaded — run:' + HAS_DAILY_RUN +
      ' log:' + HAS_DAILY_LOG +
      ' progress:' + HAS_DAILY_PROG +
      ' windows:' + HAS_DAILY_WIN
    );
  }

  /* ── 12. Debug handle ────────────────────────────────────────────────── */

  window._dailyNotesBridge = {
    version:         '1.0.0',
    HAS_DAILY_RUN:    HAS_DAILY_RUN,
    HAS_DAILY_LOG:    HAS_DAILY_LOG,
    HAS_DAILY_PROG:   HAS_DAILY_PROG,
    HAS_DAILY_WIN:    HAS_DAILY_WIN,
    state:           _state,
    runDailyNotes:    runDailyNotes,
    getDailyNotesLog: getDailyNotesLog,
    openDailyWindows: openDailyWindows,
  };

  /* ── 13. Start ───────────────────────────────────────────────────────── */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();

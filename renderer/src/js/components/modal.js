/**
 * modal.js — Reusable modal component
 *
 * Phase 5: Single modal system for the entire app. Replaces hand-coded
 * overlay/backdrop/keyboard patterns scattered across views.
 *
 * Usage:
 *   import modal from '../components/modal.js';
 *
 *   // Simple alert
 *   modal.show({ title: 'Done', body: '<p>Task completed.</p>' });
 *
 *   // Confirmation with actions
 *   modal.show({
 *     title: 'Delete Unit',
 *     body: '<p>Are you sure?</p>',
 *     width: 420,
 *     actions: [
 *       { label: 'Cancel', cls: '', onClick: () => modal.close() },
 *       { label: 'Delete', cls: 'danger', onClick: () => { doDelete(); modal.close(); } },
 *     ]
 *   });
 *
 *   // Custom HTML form
 *   modal.show({
 *     title: 'Edit Notes',
 *     body: '<textarea id="m-notes"></textarea>',
 *     width: 560,
 *     onMount: (el) => { el.querySelector('#m-notes').focus(); },
 *     actions: [
 *       { label: 'Save', cls: 'primary', onClick: () => { ... } },
 *     ]
 *   });
 *
 *   modal.close();  // programmatic close
 */

let _overlay = null;
let _panel   = null;
let _onClose = null;

function _esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function _ensureDOM() {
  if (_overlay) return;

  _overlay = document.createElement('div');
  _overlay.className = 'modal-ov';
  _overlay.style.cssText = 'position:fixed;inset:0;background:rgba(13,17,23,.65);backdrop-filter:blur(4px);z-index:900;opacity:0;pointer-events:none;transition:opacity .25s;display:flex;align-items:center;justify-content:center;';

  _panel = document.createElement('div');
  _panel.className = 'modal-panel';
  _panel.style.cssText = 'background:var(--panel,#161b22);border:1px solid var(--bdrs,#30363d);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.6);max-height:85vh;display:flex;flex-direction:column;overflow:hidden;transform:scale(.95);transition:transform .25s cubic-bezier(.22,1,.36,1);';

  _overlay.appendChild(_panel);
  document.body.appendChild(_overlay);

  // Backdrop click → close
  _overlay.addEventListener('click', (e) => {
    if (e.target === _overlay) close();
  });

  // Escape key → close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _overlay.style.opacity === '1') close();
  });
}

/**
 * show(opts) — Open a modal
 * @param {object} opts
 * @param {string} opts.title     - Header text (plain text, escaped internally)
 * @param {string} opts.body      - Inner HTML for the body area
 * @param {number} [opts.width]   - Panel width in px (default 480)
 * @param {Array}  [opts.actions] - Footer buttons: [{ label, cls, onClick }]
 * @param {Function} [opts.onMount] - Called with panel element after DOM is rendered
 * @param {Function} [opts.onClose] - Called when modal closes (any reason)
 */
function show(opts = {}) {
  _ensureDOM();

  const width = opts.width || 480;
  _panel.style.width = width + 'px';
  _onClose = opts.onClose || null;

  // Build inner HTML
  let html = '';

  // Header
  html += '<div style="padding:18px 22px 14px;border-bottom:1px solid var(--bdr,#21262d);display:flex;align-items:center;justify-content:space-between;">';
  html += '<div style="font-size:14px;font-weight:700;color:var(--txt,#e6edf3);">' + _esc(opts.title || '') + '</div>';
  html += '<button class="modal-x" style="width:26px;height:26px;border-radius:6px;border:1px solid var(--bdr,#21262d);background:var(--el,#21262d);color:var(--txt2,#8b949e);cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;transition:all .2s;">✕</button>';
  html += '</div>';

  // Body
  html += '<div class="modal-body" style="padding:18px 22px;flex:1;overflow-y:auto;font-size:12px;line-height:1.7;color:var(--txt2,#8b949e);">';
  html += opts.body || '';
  html += '</div>';

  // Actions
  if (opts.actions && opts.actions.length) {
    html += '<div style="padding:12px 22px 16px;border-top:1px solid var(--bdr,#21262d);display:flex;gap:8px;justify-content:flex-end;">';
    opts.actions.forEach((a, i) => {
      const cls = a.cls || '';
      html += '<button class="btn ' + cls + '" data-modal-action="' + i + '" style="padding:8px 16px;border-radius:7px;font-size:11px;font-weight:600;border:1px solid var(--bdr,#21262d);background:var(--el,#21262d);color:var(--txt,#e6edf3);cursor:pointer;transition:all .2s;">' + _esc(a.label) + '</button>';
    });
    html += '</div>';
  }

  _panel.innerHTML = html;

  // Wire close button
  const xBtn = _panel.querySelector('.modal-x');
  if (xBtn) xBtn.addEventListener('click', close);

  // Wire action buttons
  if (opts.actions) {
    _panel.querySelectorAll('[data-modal-action]').forEach((btn) => {
      const idx = parseInt(btn.dataset.modalAction, 10);
      const action = opts.actions[idx];
      if (action && action.onClick) btn.addEventListener('click', action.onClick);
    });
  }

  // Show with animation
  requestAnimationFrame(() => {
    _overlay.style.opacity = '1';
    _overlay.style.pointerEvents = 'all';
    _panel.style.transform = 'scale(1)';
  });

  // onMount callback
  if (opts.onMount) {
    requestAnimationFrame(() => opts.onMount(_panel));
  }
}

/**
 * close() — Close the modal
 */
function close() {
  if (!_overlay) return;
  _overlay.style.opacity = '0';
  _overlay.style.pointerEvents = 'none';
  _panel.style.transform = 'scale(.95)';
  if (_onClose) { try { _onClose(); } catch (_) {} _onClose = null; }
}

/**
 * isOpen() — Check if modal is currently visible
 */
function isOpen() {
  return _overlay && _overlay.style.opacity === '1';
}

export default { show, close, isOpen };

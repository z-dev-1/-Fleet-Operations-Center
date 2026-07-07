/**
 * context-menu.js — Shared singleton right-click context menu
 *
 * Usage:
 *   import { showContextMenu } from '../components/context-menu.js';
 *
 *   showContextMenu(event, {
 *     header: { title: 'UNIT-001', sub: 'Kenworth T680' },
 *     items: [
 *       { icon: '🔧', label: 'Open Dealer WO', action: () => {...} },
 *       { sep: true },
 *       { icon: '📋', label: 'Copy ID',        action: () => {...} },
 *       { icon: '🗑️', label: 'Delete',          action: () => {...}, danger: true },
 *     ],
 *   });
 *
 * The menu auto-closes on: item click, outside click, Escape, scroll.
 */

let _el   = null;
let _open = false;

function _ensure() {
  if (_el) return;
  _el = document.createElement('div');
  _el.className = 'ctx-menu';
  _el.setAttribute('role', 'menu');
  document.body.appendChild(_el);

  document.addEventListener('mousedown', (e) => {
    if (_open && !_el.contains(e.target)) _close();
  });
  document.addEventListener('keydown', (e) => {
    if (_open && e.key === 'Escape') _close();
  });
  window.addEventListener('scroll', _close, { passive: true, capture: true });
}

function _close() {
  if (!_el) return;
  _el.classList.remove('open');
  _open = false;
  setTimeout(() => { if (_el && !_open) _el.innerHTML = ''; }, 160);
}

/**
 * @param {MouseEvent}  event   contextmenu event (used for positioning)
 * @param {{ header?: { title: string, sub?: string }, items: Array }} opts
 */
export function showContextMenu(event, opts) {
  event.preventDefault();
  _ensure();
  _close();

  const { header, items = [] } = opts;

  let html = '';

  if (header) {
    html += '<div class="ctx-head">'
          +   '<div class="ctx-uid">'  + _esc(header.title) + '</div>'
          +   (header.sub ? '<div class="ctx-sub">' + _esc(header.sub) + '</div>' : '')
          + '</div>';
  }

  items.forEach((item) => {
    if (item.sep) {
      html += '<div class="ctx-sep"></div>';
    } else {
      html += '<button class="ctx-item' + (item.danger ? ' danger' : '') + '" role="menuitem">'
            +   '<span class="ctx-icon">' + (item.icon || '') + '</span>'
            +   _esc(item.label)
            + '</button>';
    }
  });

  _el.innerHTML = html;

  // Wire actions — skip separators
  const btns    = Array.from(_el.querySelectorAll('.ctx-item'));
  const actions = items.filter((i) => !i.sep).map((i) => i.action || null);
  btns.forEach((btn, i) => {
    if (actions[i]) {
      btn.addEventListener('click', () => {
        _close();
        actions[i]();
      });
    }
  });

  // Position — flip if near viewport edge
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const mx = event.clientX;
  const my = event.clientY;

  _el.style.left    = '0px';
  _el.style.top     = '-9999px';
  _el.style.display = 'block';
  _el.classList.add('open');
  _open = true;

  requestAnimationFrame(() => {
    const mw = _el.offsetWidth  || 200;
    const mh = _el.offsetHeight || 150;
    const x  = (mx + mw > vw - 8) ? mx - mw : mx;
    const y  = (my + mh > vh - 8) ? my - mh : my;
    _el.style.left = x + 'px';
    _el.style.top  = y + 'px';
  });
}

function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/**
 * toast.js -- Toast notification component (compact, non-intrusive)
 *
 * Listens for 'ui:toast' bus events and renders dismissable toasts.
 * Also used directly: toast.show(type, message, duration?)
 *
 * Types: 'info' | 'success' | 'warn' | 'error'
 */

import bus from '../bus.js';

let _container = null;

function _getContainer() {
  if (!_container) {
    _container = document.createElement('div');
    _container.id = 'toast-container';
    _container.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:2000;display:flex;flex-direction:column;gap:5px;align-items:flex-start;pointer-events:none;max-width:260px;';
    document.body.appendChild(_container);
  }
  return _container;
}

function show(type = 'info', message = '', duration = 2500) {
  const el = document.createElement('div');
  el.style.cssText = 'pointer-events:all;display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:6px;font-size:10px;font-family:inherit;color:#ccd6e0;background:rgba(22,34,51,0.92);border:1px solid rgba(88,166,255,0.15);box-shadow:0 2px 8px rgba(0,0,0,0.3);backdrop-filter:blur(8px);opacity:0;transform:translateX(-12px);transition:opacity 0.2s ease,transform 0.2s ease;max-width:240px;word-break:break-word;line-height:1.3;';

  // Type-specific left accent
  const accents = { success: '#3fb950', warn: '#d29922', error: '#f85149', info: '#58a6ff' };
  el.style.borderLeft = '2px solid ' + (accents[type] || accents.info);

  el.textContent = message;

  const close = document.createElement('button');
  close.style.cssText = 'background:none;border:none;color:#6b7b8d;cursor:pointer;font-size:10px;padding:0 2px;margin-left:4px;line-height:1;flex-shrink:0;';
  close.textContent = '\u00d7';
  close.addEventListener('click', () => dismiss(el));
  el.appendChild(close);

  _getContainer().appendChild(el);

  // Animate in
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateX(0)';
  });

  // Auto-dismiss
  if (duration > 0) {
    setTimeout(() => dismiss(el), duration);
  }
}

function dismiss(el) {
  if (!el || !el.parentNode) return;
  el.style.opacity = '0';
  el.style.transform = 'translateX(-12px)';
  // Force remove after transition (fallback if transitionend doesn't fire)
  setTimeout(() => { if (el.parentNode) el.remove(); }, 300);
}

/** Wire bus listener -- call once at startup. */
export function init() {
  bus.on('ui:toast', ({ type, message, duration }) => {
    show(type, message, duration);
  });
}

export const toast = { show };
export default toast;

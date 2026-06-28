/**
 * toast.js -- Toast notification component
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
    document.body.appendChild(_container);
  }
  return _container;
}

function show(type = 'info', message = '', duration = 4000) {
  const el = document.createElement('div');
  el.className = 'toast toast--' + type;
  el.textContent = message;

  const close = document.createElement('button');
  close.className = 'toast__close';
  close.textContent = 'x';
  close.addEventListener('click', () => dismiss(el));
  el.appendChild(close);

  _getContainer().appendChild(el);

  // Trigger CSS enter animation on next frame
  requestAnimationFrame(() => el.classList.add('toast--visible'));

  if (duration > 0) {
    setTimeout(() => dismiss(el), duration);
  }
}

function dismiss(el) {
  el.classList.remove('toast--visible');
  el.classList.add('toast--leaving');
  el.addEventListener('transitionend', () => el.remove(), { once: true });
}

/** Wire bus listener -- call once at startup. */
export function init() {
  bus.on('ui:toast', ({ type, message, duration }) => {
    show(type, message, duration);
  });
}

export const toast = { show };
export default toast;

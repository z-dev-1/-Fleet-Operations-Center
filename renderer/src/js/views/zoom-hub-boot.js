/**
 * views/zoom-hub-boot.js -- renderer flag gate for the Zoom hub (flags zoom.*, default OFF).
 *
 *   1. no window.zoomHub            -> return (nothing happens)
 *   2. flags() fails or !ok         -> return
 *   3. !enabled or no area on       -> return: no DOM, no CSS, no import
 *   4. otherwise import('./zoom-hub.js') and init(mount, flags)
 *
 * Main owns the real gate (DISABLED stubs); this is the UX half. This module never touches the camera.
 */
function _defaultHub() {
  return typeof window !== 'undefined' ? window.zoomHub : undefined;
}

export async function boot(mount, deps = {}) {
  try {
    const hub = Object.prototype.hasOwnProperty.call(deps, 'zoomHub') ? deps.zoomHub : _defaultHub();
    if (!hub || typeof hub.flags !== 'function') return false;
    const f = await hub.flags();
    if (!f || f.ok !== true) return false;
    if (!f.enabled || !(f.data || f.studio)) return false;
    const load = typeof deps.load === 'function' ? deps.load : () => import('./zoom-hub.js');
    const mod = await load();
    mod.init(mount, { enabled: !!f.enabled, data: !!f.data, studio: !!f.studio, write: !!f.write, obs: !!f.obs });
    return true;
  } catch (e) {
    try { console.warn('[zoom-hub] boot failed', e && e.name); } catch (_) {}
    return false;
  }
}

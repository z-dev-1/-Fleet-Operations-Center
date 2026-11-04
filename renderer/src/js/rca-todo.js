/**
 * rca-todo.js — fleet-wide "RCA to do" list (shared by the overview tile and the
 * fleet table badge).
 *
 * Source: window.rca.todo() — COMPLETED work orders finished in the last 9 days
 * with no RCA yet (same rule as the History tab's RCA button). Loads the fast
 * local answer first, then a live AAP check that drops RCAs filled in
 * elsewhere. Refreshes every 10 min, after any RCA submit, and emits
 * bus 'rca:todo' whenever the list changes.
 */

import bus from './bus.js';

const REFRESH_MS = 10 * 60 * 1000;
let _items = [];
let _byUnit = new Map();
let _timer = null;
let _inflight = null;

function _set(items) {
  const next = Array.isArray(items) ? items : [];
  const sig = next.map((i) => i.workOrderId).join(',');
  const prev = _items.map((i) => i.workOrderId).join(',');
  _items = next;
  _byUnit = new Map();
  for (const it of next) {
    const k = String(it.equipmentId || '');
    if (!_byUnit.has(k)) _byUnit.set(k, []);
    _byUnit.get(k).push(it);
  }
  if (sig !== prev) bus.emit('rca:todo', { items: _items });
}

export function refresh() {
  if (!window.rca || typeof window.rca.todo !== 'function') return Promise.resolve(_items);
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const fast = await window.rca.todo({ live: false });
      if (fast && fast.ok) _set(fast.items);
      const live = await window.rca.todo({ live: true });
      if (live && live.ok) _set(live.items);
    } catch (_) { /* keep the last good list */ }
    finally { _inflight = null; }
    return _items;
  })();
  return _inflight;
}

export function start() {
  if (_timer) return;
  // Give the app a moment to finish its first fleet load before the first check.
  setTimeout(refresh, 8000);
  _timer = setInterval(refresh, REFRESH_MS);
  bus.on('rca:submitted', () => refresh());
}

export const items   = () => _items.slice();
export const forUnit = (equipmentId) => (_byUnit.get(String(equipmentId || '')) || []).slice();
export const unitIds = () => new Set(_byUnit.keys());

export default { start, refresh, items, forUnit, unitIds };

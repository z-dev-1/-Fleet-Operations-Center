/**
 * aperia-pill-logic.js — pure helpers for the bottom status-bar Aperia pill
 * (#tb-aperia) and the Aperia panel. No DOM, no window.aperia calls.
 *
 * status = window.aperia.status() result: { state:'signed-out'|'connecting'|
 * 'connected'|'expired', alerts:'off'|'ws'|'polling', minutes, lastPullAt, ... }.
 */

const TITLE = 'Aperia HALO Connect: click for sign-in, tire alerts, issues and the bulk tire tool. ' +
  'This pill never checks Aperia on its own.';

/** alertsOn(status) -> true when the tire-alert watcher is running (ws or polling). */
export function alertsOn(status) {
  const a = status && status.alerts;
  return a === 'ws' || a === 'polling';
}

/** aperiaPill(status) -> { cls, text, title } for #tb-aperia. */
export function aperiaPill(status) {
  const st = status && typeof status === 'object' ? status.state : null;
  const pill = (color, text) => ({ cls: 'tb-aperia tb-aperia--' + color, text, title: TITLE });
  if (st === 'connected') return alertsOn(status) ? pill('green', 'Aperia: Alerts ON') : pill('green', 'Aperia: Connected');
  if (st === 'signed-out') return pill('grey', 'Aperia: Signed out');
  if (st === 'connecting') return pill('grey', 'Aperia: Connecting\u2026');
  if (st === 'expired') return pill('amber', 'Aperia: Expired');
  return pill('grey', 'Aperia \u2026');
}

/** alertsLabel(status) -> 'Tire Alerts: ON' | 'Tire Alerts: OFF'. */
export function alertsLabel(status) {
  return alertsOn(status) ? 'Tire Alerts: ON' : 'Tire Alerts: OFF';
}

const _ET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

/** fmtEt(iso) -> 'M/D/YYYY, h:mm AM EST' in America/New_York, '' for an invalid or absent time. */
export function fmtEt(iso) {
  if (iso == null || iso === '') return '';
  const ms = Date.parse(String(iso));
  if (!Number.isFinite(ms)) return '';
  return _ET.format(new Date(ms)).replace(/[\u202f\u00a0]/g, ' ');
}

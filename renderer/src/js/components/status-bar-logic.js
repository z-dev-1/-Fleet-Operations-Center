/**
 * status-bar-logic.js — Pure logic for the bottom status bar.
 *
 * NO DOM, NO bus, NO bridge imports — so it can be unit-tested under vitest's
 * node environment (the renderer bridge touches window.* which isn't available
 * there). status-bar.js imports these and wires them to the DOM + event bus.
 *
 * This is the single place the sync-state color/label rules live, and the
 * ordering + "last successful sync" bookkeeping — there is no competing
 * sync-state system.
 */

// Freshness thresholds (ms).
export const FRESH_MS = 10 * 60 * 1000;   // <= 10m since successful sync = green
export const STALE_MS = 60 * 60 * 1000;   // > 60m = excessively stale (red)

/** HTML-escape backend-provided text before rendering. */
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Human "N ago" for a timestamp, relative to `now` (injectable for tests). */
export function timeSince(ts, now) {
  if (!ts) return 'never';
  const n = (typeof now === 'number') ? now : Date.now();
  let sec = Math.round((n - ts) / 1000);
  if (sec < 0) sec = 0;
  if (sec < 60) return sec + 's ago';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h ago';
  const day = Math.floor(hr / 24);
  return day + 'd ago';
}

/** A fresh, empty status-bar fleet snapshot. */
export function emptyFleet() {
  return {
    count: 0, unavailCount: 0,
    syncedAt: null, lastSuccessfulSyncAt: null,
    partial: null, usedCache: false, stale: false,
    inProgress: false, authRequired: false, failed: false,
    seq: 0,
  };
}

/** Count unavailable units from raw fleet rows. */
export function countUnavailable(rows) {
  return (rows || []).filter(r => /unavailable/i.test(r.atsState || r.lifecycleState || '')).length;
}

/**
 * absorbFleetSlice(current, incoming) -> next snapshot
 *
 * PURE reducer. Merges an incoming fleet state slice into the current status-bar
 * snapshot, honoring seq ordering (older payloads are ignored) and the rule that
 * only a fresh, complete payload clears failure/auth flags. Returns a NEW object
 * ({...current} when the incoming payload is rejected as out-of-order).
 */
export function absorbFleetSlice(current, incoming) {
  const cur = current || emptyFleet();
  if (!incoming) return { ...cur };
  // Out-of-order guard: never let an older payload overwrite newer info.
  if (typeof incoming.seq === 'number' && typeof cur.seq === 'number' && incoming.seq < cur.seq) {
    return { ...cur };
  }
  const next = { ...cur };
  if (typeof incoming.seq === 'number') next.seq = incoming.seq;
  next.count = incoming.count || (incoming.rows ? incoming.rows.length : cur.count) || 0;
  if (incoming.rows) next.unavailCount = countUnavailable(incoming.rows);
  next.syncedAt = incoming.syncedAt || null;
  next.lastSuccessfulSyncAt = incoming.lastSuccessfulSyncAt || cur.lastSuccessfulSyncAt || null;
  next.partial = incoming.partial || null;
  next.usedCache = !!incoming.usedCache;
  next.stale = !!incoming.stale;
  next.inProgress = !!incoming.partial;   // a non-partial payload ends the burst
  if (!incoming.partial && !incoming.usedCache && !incoming.stale && incoming.syncedAt) {
    next.failed = false;
    next.authRequired = false;
  }
  return next;
}

/**
 * deriveStatus(f, opts) -> { state, color, label, ageText }
 *
 * PURE. Decides the structured state, its color, a short label, and the age
 * text from the authoritative fleet fields (f) and { now }.
 *
 *   green = complete, successful, sufficiently fresh sync
 *   amber = cached / partial / aging / auth-required
 *   red   = failed / unusable / excessively stale
 *
 * The age text always reflects the LAST SUCCESSFUL sync — never a cached or
 * partial "syncedAt" — and when the latest attempt failed but a prior success
 * exists it says so explicitly.
 */
export function deriveStatus(f, opts) {
  f = f || {};
  const now = (opts && typeof opts.now === 'number') ? opts.now : Date.now();
  const lastOk = f.lastSuccessfulSyncAt || null;
  const ageMs = lastOk ? (now - lastOk) : null;

  let ageText;
  if (f.failed && lastOk) {
    ageText = 'Last successful sync: ' + timeSince(lastOk, now) + ' \u00b7 latest attempt failed';
  } else if (lastOk) {
    ageText = 'Last sync: ' + timeSince(lastOk, now);
  } else {
    ageText = 'Last sync: never';
  }

  if (f.authRequired) {
    return { state: 'auth-required', color: 'amber', label: 'Authentication required', ageText };
  }
  if (f.failed) {
    return { state: 'sync-failed', color: 'red', label: 'Sync failed', ageText };
  }
  if (f.partial) {
    return { state: 'partial-sync', color: 'amber', label: 'Partial sync', ageText };
  }
  if (f.inProgress) {
    return { state: 'syncing', color: 'amber', label: 'Syncing', ageText };
  }
  if (f.usedCache || f.stale) {
    const excessivelyStale = ageMs != null && ageMs > STALE_MS;
    return {
      state: excessivelyStale ? 'stale' : 'cached',
      color: excessivelyStale ? 'red' : 'amber',
      label: excessivelyStale ? 'Stale data' : 'Cached data',
      ageText,
    };
  }
  if (lastOk) {
    if (ageMs != null && ageMs > STALE_MS) {
      return { state: 'stale', color: 'red', label: 'Stale data', ageText };
    }
    if (ageMs != null && ageMs <= FRESH_MS) {
      return { state: 'synced', color: 'green', label: 'Synced', ageText };
    }
    return { state: 'aging', color: 'amber', label: 'Aging data', ageText };
  }
  return { state: 'connecting', color: 'grey', label: 'Connecting', ageText };
}

function colorClass(color) {
  return color === 'green' ? 'sb-dot--green'
       : color === 'red'   ? 'sb-dot--red'
       : color === 'grey'  ? 'sb-dot--grey'
       : 'sb-dot--amber';
}

/**
 * renderHtml(view) -> string
 *
 * PURE. Builds the exact innerHTML the status bar shows, so the rendered output
 * (state label + age, counts, transient message, AI dot, version) is testable
 * without a DOM. All backend-provided text (status/error message) is escaped.
 *
 * view: { fleet, now, aiConnected, version, statusMsg, statusIsError }
 */
export function renderHtml(view) {
  view = view || {};
  const f = view.fleet || emptyFleet();
  const st = deriveStatus(f, { now: view.now });
  const statusMsg = view.statusMsg || '';
  const msgHtml = statusMsg
    ? '<span class="sb-sep">\u2502</span><span class="sb-item sb-msg' +
      (view.statusIsError ? ' sb-msg--error' : '') + '">' + esc(statusMsg) + '</span>'
    : '';
  const version = view.version || '';
  return '<div class="sb-bar">' +
      '<div class="sb-left">' +
        '<span class="sb-item sb-sync-ago" title="' + esc(st.label) + '">' +
          '<span class="sb-dot ' + colorClass(st.color) + '"></span>' +
          '<span class="sb-state-label">' + esc(st.label) + '</span>' +
          '<span class="sb-sep-dot">\u00b7</span>' +
          esc(st.ageText) +
        '</span>' +
        '<span class="sb-sep">\u2502</span>' +
        '<span class="sb-item">' + (f.count || 0) + ' units</span>' +
        '<span class="sb-sep">\u2502</span>' +
        '<span class="sb-item sb-unavail">' + (f.unavailCount || 0) + ' unavailable</span>' +
        msgHtml +
      '</div>' +
      '<div class="sb-right">' +
        '<span class="sb-item">' +
          '<span class="sb-dot ' + (view.aiConnected ? 'sb-dot--green' : 'sb-dot--red') + '"></span>' +
          'AI: ' + (view.aiConnected ? 'Connected' : 'Disconnected') +
        '</span>' +
        '<span class="sb-sep">\u2502</span>' +
        '<span class="sb-item sb-version">' + esc(version ? ('v' + version) : '\u2026') + '</span>' +
      '</div>' +
    '</div>';
}

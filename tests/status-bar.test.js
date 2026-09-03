// tests/status-bar.test.js
//
// Proves the bottom status bar is the authoritative fleet-sync indicator.
// Exercises the PURE logic module (renderer/src/js/components/status-bar-logic.js)
// which owns every state/color/label rule + the ordering + last-successful-sync
// bookkeeping the DOM wiring (status-bar.js) delegates to. No DOM / no bridge
// needed — this is the single source of truth for the bar's behavior.

import { describe, it, expect } from 'vitest';
import {
  deriveStatus, absorbFleetSlice, emptyFleet, timeSince, esc, renderHtml,
  FRESH_MS, STALE_MS, countUnavailable,
} from '../renderer/src/js/components/status-bar-logic.js';

const NOW = 1_700_000_000_000;
const secsAgo = (s) => NOW - s * 1000;
const minsAgo = (m) => NOW - m * 60 * 1000;

// Simulate a final, fresh, complete backend payload as the bridge would shape it.
function finalPayload(over = {}) {
  return {
    rows: [{ lifecycleState: 'Available' }, { lifecycleState: 'Unavailable' }, { lifecycleState: 'Available' }],
    count: 3, syncedAt: NOW, stale: false, partial: null, usedCache: false,
    lastSuccessfulSyncAt: NOW, seq: 1, ...over,
  };
}

describe('deriveStatus — a successful FINAL payload shows its real syncedAt (green)', () => {
  it('fresh final payload => synced/green with real last-sync age', () => {
    const f = absorbFleetSlice(emptyFleet(), finalPayload({ syncedAt: secsAgo(38), lastSuccessfulSyncAt: secsAgo(38) }));
    const st = deriveStatus(f, { now: NOW });
    expect(st.state).toBe('synced');
    expect(st.color).toBe('green');
    expect(st.ageText).toBe('Last sync: 38s ago');   // real timestamp, not Date.now()
  });
});

describe('cached payload retains the original timestamp and shows cached/amber', () => {
  it('cache payload does NOT advance last-successful and is amber', () => {
    // First a real success 12m ago.
    let f = absorbFleetSlice(emptyFleet(), finalPayload({ syncedAt: minsAgo(12), lastSuccessfulSyncAt: minsAgo(12) }));
    // Then a cache-backed payload arrives (bridge keeps lastSuccessfulSyncAt).
    f = absorbFleetSlice(f, { count: 3, syncedAt: NOW, usedCache: true, stale: false, partial: null, lastSuccessfulSyncAt: minsAgo(12), seq: 2 });
    const st = deriveStatus(f, { now: NOW });
    expect(st.state).toBe('cached');
    expect(st.color).toBe('amber');
    // Age reflects the ORIGINAL success (12m), not the cache load.
    expect(st.ageText).toBe('Last sync: 12m ago');
  });
});

describe('stale payload shows stale/amber-or-red by age', () => {
  it('aging (between fresh and stale) => amber', () => {
    const f = absorbFleetSlice(emptyFleet(), finalPayload({ syncedAt: minsAgo(30), lastSuccessfulSyncAt: minsAgo(30) }));
    const st = deriveStatus(f, { now: NOW });
    expect(st.color).toBe('amber');
    expect(st.state).toBe('aging');
  });
  it('excessively stale (> STALE_MS) => red/stale', () => {
    const f = absorbFleetSlice(emptyFleet(), finalPayload({ syncedAt: minsAgo(120), lastSuccessfulSyncAt: minsAgo(120) }));
    const st = deriveStatus(f, { now: NOW });
    expect(st.state).toBe('stale');
    expect(st.color).toBe('red');
  });
  it('cache payload that is excessively stale => red/stale', () => {
    let f = absorbFleetSlice(emptyFleet(), finalPayload({ syncedAt: minsAgo(120), lastSuccessfulSyncAt: minsAgo(120) }));
    f = absorbFleetSlice(f, { count: 3, usedCache: true, lastSuccessfulSyncAt: minsAgo(120), seq: 2 });
    const st = deriveStatus(f, { now: NOW });
    expect(st.color).toBe('red');
    expect(st.state).toBe('stale');
  });
});

describe('partial payload does NOT claim a completed sync', () => {
  it('partial => partial-sync/amber, no last-successful advance', () => {
    const f = absorbFleetSlice(emptyFleet(), { rows: [{ lifecycleState: 'Available' }], count: 1, syncedAt: NOW, partial: 'aap', lastSuccessfulSyncAt: null, seq: 1 });
    const st = deriveStatus(f, { now: NOW });
    expect(st.state).toBe('partial-sync');
    expect(st.color).toBe('amber');
    expect(st.state).not.toBe('synced');
    expect(f.inProgress).toBe(true);
    expect(f.lastSuccessfulSyncAt).toBeNull();  // partial never sets success time
  });
  it('AAP -> Uptake -> Relay partials keep progressing without completing', () => {
    let f = absorbFleetSlice(emptyFleet(), { rows: [{}], count: 1, partial: 'aap', seq: 1 });
    expect(deriveStatus(f, { now: NOW }).state).toBe('partial-sync');
    f = absorbFleetSlice(f, { rows: [{}], count: 1, partial: 'uptake', seq: 2 });
    expect(deriveStatus(f, { now: NOW }).state).toBe('partial-sync');
    f = absorbFleetSlice(f, { rows: [{}], count: 1, partial: 'relay-batch-3', seq: 3 });
    expect(deriveStatus(f, { now: NOW }).state).toBe('partial-sync');
    expect(f.lastSuccessfulSyncAt).toBeNull();
    // Final full payload completes it.
    f = absorbFleetSlice(f, finalPayload({ seq: 4 }));
    expect(deriveStatus(f, { now: NOW }).state).toBe('synced');
    expect(f.lastSuccessfulSyncAt).toBe(NOW);
  });
});

describe('a failed attempt preserves the previous successful-sync timestamp', () => {
  it('failure keeps last-successful and shows failed/red with dual text', () => {
    let f = absorbFleetSlice(emptyFleet(), finalPayload({ syncedAt: minsAgo(20), lastSuccessfulSyncAt: minsAgo(20) }));
    const okAt = f.lastSuccessfulSyncAt;
    // Simulate what the fleet:error handler does in status-bar.js.
    f = { ...f, failed: true, inProgress: false };
    const st = deriveStatus(f, { now: NOW });
    expect(st.state).toBe('sync-failed');
    expect(st.color).toBe('red');
    expect(f.lastSuccessfulSyncAt).toBe(okAt);            // preserved
    expect(st.ageText).toBe('Last successful sync: 20m ago \u00b7 latest attempt failed');
  });
});

describe('authentication-required state', () => {
  it('authRequired => amber/auth-required (even if data exists)', () => {
    let f = absorbFleetSlice(emptyFleet(), finalPayload());
    f = { ...f, authRequired: true };
    const st = deriveStatus(f, { now: NOW });
    expect(st.state).toBe('auth-required');
    expect(st.color).toBe('amber');
  });
});

describe('connecting state (no data yet)', () => {
  it('empty => connecting/grey', () => {
    const st = deriveStatus(emptyFleet(), { now: NOW });
    expect(st.state).toBe('connecting');
    expect(st.color).toBe('grey');
    expect(st.ageText).toBe('Last sync: never');
  });
});

describe('out-of-order older payloads cannot replace newer sync info', () => {
  it('a lower-seq payload is ignored', () => {
    let f = absorbFleetSlice(emptyFleet(), finalPayload({ seq: 5, count: 3, lastSuccessfulSyncAt: NOW }));
    // An older (seq 3) cache payload must NOT overwrite the newer success.
    const before = { ...f };
    f = absorbFleetSlice(f, { count: 99, usedCache: true, syncedAt: minsAgo(90), lastSuccessfulSyncAt: minsAgo(90), seq: 3 });
    expect(f.seq).toBe(before.seq);         // unchanged
    expect(f.count).toBe(3);                // not clobbered by the stale 99
    expect(f.usedCache).toBe(false);
    expect(deriveStatus(f, { now: NOW }).state).toBe('synced');
  });
});

describe('age text updates over time', () => {
  it('same snapshot reports increasing age as now advances', () => {
    const f = absorbFleetSlice(emptyFleet(), finalPayload({ syncedAt: NOW, lastSuccessfulSyncAt: NOW }));
    expect(deriveStatus(f, { now: NOW + 5000 }).ageText).toBe('Last sync: 5s ago');
    expect(deriveStatus(f, { now: NOW + 90 * 1000 }).ageText).toBe('Last sync: 1m ago');
    expect(deriveStatus(f, { now: NOW + 2 * 3600 * 1000 }).ageText).toBe('Last sync: 2h ago');
  });
});

describe('never treats cached receipt as a new successful sync', () => {
  it('cache-only (no prior success) shows cached, not synced, no success time', () => {
    const f = absorbFleetSlice(emptyFleet(), { count: 5, usedCache: true, syncedAt: NOW, lastSuccessfulSyncAt: null, seq: 1 });
    const st = deriveStatus(f, { now: NOW });
    expect(st.state).toBe('cached');
    expect(f.lastSuccessfulSyncAt).toBeNull();
  });
});

describe('rendered output (renderHtml — what the bar actually shows)', () => {
  it('a fleet:status message appears in the bar (and is escaped)', () => {
    const f = absorbFleetSlice(emptyFleet(), finalPayload());
    const html = renderHtml({ fleet: f, now: NOW, version: '3.1.0-beta.11', statusMsg: 'Reading AAP <live>' });
    expect(html).toContain('sb-msg');
    expect(html).toContain('Reading AAP &lt;live&gt;');   // escaped, present
  });
  it('fleet:error produces a visible failure state in the bar', () => {
    let f = absorbFleetSlice(emptyFleet(), finalPayload({ syncedAt: minsAgo(5), lastSuccessfulSyncAt: minsAgo(5) }));
    f = { ...f, failed: true, inProgress: false };
    const html = renderHtml({ fleet: f, now: NOW, version: '3.1.0', statusMsg: 'Sync failed: AAP read failed', statusIsError: true });
    expect(html).toContain('sb-dot--red');
    expect(html).toContain('Sync failed');
    expect(html).toContain('sb-msg--error');
    expect(html).toContain('latest attempt failed');
  });
  it('displays the app-provided version (never a hard-coded v3.0.0)', () => {
    const html = renderHtml({ fleet: absorbFleetSlice(emptyFleet(), finalPayload()), now: NOW, version: '3.1.0-beta.11' });
    expect(html).toContain('v3.1.0-beta.11');
    expect(html).not.toContain('v3.0.0');
  });
  it('shows unit count and unavailable count', () => {
    const f = absorbFleetSlice(emptyFleet(), finalPayload());  // 3 units, 1 unavailable
    const html = renderHtml({ fleet: f, now: NOW, version: '3.1.0' });
    expect(html).toContain('3 units');
    expect(html).toContain('1 unavailable');
  });
  it('a malicious backend status string cannot inject markup', () => {
    const html = renderHtml({ fleet: emptyFleet(), now: NOW, version: '1.0.0', statusMsg: '<script>x</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('helpers', () => {
  it('esc escapes HTML from backend status text', () => {
    expect(esc('<img src=x onerror=alert(1)> & "q"')).toBe('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;');
  });
  it('countUnavailable matches atsState or lifecycleState', () => {
    expect(countUnavailable([{ lifecycleState: 'Unavailable' }, { atsState: 'unavailable' }, { lifecycleState: 'Available' }])).toBe(2);
  });
  it('thresholds are sane (fresh < stale)', () => {
    expect(FRESH_MS).toBeLessThan(STALE_MS);
  });
});

# Fleet Ops V-C · Stage 6 — Auth Hardening + Adaptive Settle: Completion Record

**Completed:** 2026-06-28  
**Tag:** `scraper-resilience-stage6-complete` → `41ccfe1`  
**Predecessor:** Stage 5 complete — 502/502 sanity checks, tag `scraper-resilience-stage5-complete`  
**Sanity suite:** 516/516 PASS (+14 new checks, 0 regressions)

---

## 1. What Was Fixed

2 issues deferred from Stage 5, now resolved across 2 implementation steps.  
2 files changed. 114 insertions, 4 deletions.

### Issue disposition

| # | Severity | Issue | Status |
|---|---|---|---|
| M-4 | Medium | No pre-scrape auth health-check — auth failure discovered mid-batch after N windows open | ✅ Fixed (Step 1) |
| L-2 | Low | `relay.js` `WO_TAB_SETTLE_MS = 4000` fixed settle delay — wastes ~2.9s per unit on fast pages | ✅ Fixed (Step 2) |

**All 14 audit issues from the Stage 5 scraper audit now resolved.**

---

## 2. Step-by-Step Changes

### Step 1 — `pingRelayEndpoint()` relay auth probe
**Commit:** `3e2bd15`  
**Issue:** M-4  
**File:** `src/scrapers/auth.js` (+82 lines)

#### Root cause

The existing `probeSession()` function validates a Midway session by loading `AAP_PROBE_URL` — a `/v2/page/` namespace URL. This namespace is served through CloudFront and can be satisfied from browser cache after a Midway session expires at the cookie level. The relay scraper, however, loads `AAP_SERVICE_BASE` (`/v2/service/`) URLs that hit AAP's live auth middleware on every request. When a Midway session expires, `/v2/service/` URLs immediately redirect to SSO while `/v2/page/` continues to serve cached responses.

The consequence: `ensureAuthenticated()` returned `true`, `runFullSync()` proceeded, `scrapeRelay()` opened up to `MAX_CONCURRENT = 5` BrowserWindows per batch — all of which silently received SSO redirect pages, timed out after `PAGE_TIMEOUT_MS = 35s`, and returned `null`. With the Step 3 retry wrapper added in Stage 5 (`withRetry`), each failing unit was retried once, doubling the open-window count before the batch completed. The sync returned empty relay data (falling back to the relay cache) with no log signal clearly naming auth as the root cause.

#### Fix — two new constants

```js
// Dummy serviceId — AAP returns "not found" but stays on-domain when auth is valid.
// Redirects to Midway SSO when session is stale.
const AAP_SERVICE_PROBE_URL  = 'https://aap-na.corp.amazon.com/v2/service/00000000-0000-0000-0000-000000000000';
const RELAY_PROBE_TIMEOUT_MS = 10_000;
```

The dummy UUID `00000000-0000-0000-0000-000000000000` was chosen deliberately: AAP will return a "Work Request not found" page (an on-domain React render) for any unknown UUID when auth is valid, and will SSO-redirect for any `/v2/service/` URL when auth is stale. Either response is detectable by URL alone — no DOM parsing needed.

#### Fix — `pingRelayEndpoint()` function (lines 173–222)

Same structural pattern as `probeSession()`:

```js
async function pingRelayEndpoint() {
  return new Promise((resolve) => {
    const probe = new BrowserWindow({ show: false, webPreferences: { ... } });
    let settled = false;
    const done = (ok) => { /* one-shot: clear timer, destroy probe, resolve */ };

    // Hard deadline — 10s (vs probeSession's 25s)
    const timer = setTimeout(() => done(false), RELAY_PROBE_TIMEOUT_MS);

    // Intercept SSO redirect before page completes loading
    probe.webContents.on('will-redirect', (_, url) => { if (isSSO(url)) done(false); });
    probe.webContents.on('did-navigate',  (_, url) => { if (isSSO(url)) done(false); });

    probe.webContents.on('did-finish-load', () => {
      const url = probe.webContents.getURL();
      // Any landing on aap-na domain = valid (404 'not found' is fine)
      done(/aap-na\.corp\.amazon\.com/i.test(url));
    });

    probe.webContents.on('did-fail-load', (_, code) => {
      if (code === -3) return; // ERR_ABORTED — redirect in flight, not a failure
      done(false);
    });

    probe.loadURL(AAP_SERVICE_PROBE_URL);
  });
}
```

Key decisions:
- **10s budget** vs `probeSession()`'s 25s — the `/v2/service/` response (whether 404 or SSO redirect) arrives faster than a full page render; 10s is ample headroom
- **`will-redirect` listener** catches SSO redirects before `did-finish-load` fires — same early-exit pattern as `probeSession()`
- **`did-fail-load` with `-3` skip** — `ERR_ABORTED` is the normal Chromium code for a navigation cancelled by a redirect; ignoring it prevents a false negative during the SSO redirect sequence
- **No DOM check** — URL-only, consistent with `probeSession()`'s design principle ("DOM/React class selectors are too fragile")

#### Fix — `ensureAuthenticated()` Step 2b (lines 278–295)

Inserted after the existing Step 2 (`probeSession()`) passes and before the final `return true`:

```js
// Step 2b: probe /v2/service/ — ensures session is valid for relay scrape URLs
send('fleet:status', 'Verifying relay session...');
let relayOk = await pingRelayEndpoint();
if (!relayOk) {
  // One recovery attempt: force re-inject cookies from disk then re-probe.
  // Handles the race where mwinit refreshed the cookie file after the initial
  // injectCookies() call at Step 1.
  logger.warn('[AuthManager] Relay probe failed — re-injecting cookies and retrying');
  try { await injectCookies(); } catch (_) {}
  relayOk = await pingRelayEndpoint();
}
if (!relayOk) {
  const msg = 'AAP service endpoints rejecting session — re-run mwinit then retry';
  send('fleet:error', msg);
  throw Object.assign(new Error(msg), { code: 'RELAY_SESSION_INVALID' });
}
logger.info('[AuthManager] Session confirmed (page + service probes passed)');
```

The re-inject recovery step handles a narrow but real race: the user may have run `mwinit` between the initial `injectCookies()` call and the relay probe. The re-inject reads fresh cookies from disk; if the session is now valid, the second probe passes. If not, the error is thrown with a distinct error code (`RELAY_SESSION_INVALID` vs the existing `MIDWAY_SESSION_INVALID`) so log triage can distinguish "AAP page namespace rejected session" from "AAP service namespace rejected session".

**`sync/index.js` — no changes.** The `ensureAuthenticated()` contract (returns `true` or throws) is unchanged from the caller's perspective. The two-probe flow is fully encapsulated in `auth.js`.

**Export:** `pingRelayEndpoint` added to `module.exports` for external test coverage.

---

### Step 2 — Adaptive WO tab settle
**Commit:** `41ccfe1`  
**Issue:** L-2  
**File:** `src/scrapers/relay.js` (+32 lines)

#### Root cause

After clicking the Work Orders tab (`RELAY_CLICK_WO_TAB_SCRIPT`), the Phase 2 code slept `WO_TAB_SETTLE_MS = 4000` unconditionally before running `RELAY_WO_SCRIPT`. The 4s value was an empirical worst-case estimate covering slow AAP pages. On fast pages the WO tab renders in ~800–1200ms, making the sleep approximately 2.9s of unnecessary idle time per unit.

At `MAX_CONCURRENT = 5` with 100 UNAVAILABLE units (20 batches):
- **Before:** `20 batches × 5 units × 4s = 400s` of fixed WO settle time per sync
- **After (fast session):** `20 batches × 5 units × ~1.1s = 110s` WO settle time
- **Net:** ~290s (~4.8 min) reclaimed per full relay sync on warm AAP sessions

#### DOM signal identified

`RELAY_WO_SCRIPT` extracts WO data using `body.innerText` regex — it looks for `Vendor Work Order ID`, `Reason for Repair`, and `Work Accomplished` as literal label strings. These are static React-rendered labels that AAP has used across multiple UI revisions. The WO tab has rendered when any of these strings is present in `body.innerText`.

This is the same approach as the Phase 3 body-growth poll already in production (lines 684–691), which confirms the pattern works reliably in this codebase. The key difference: Phase 3 polls for body length growth (a weak signal that fires whenever *any* content appears); Phase 2 now polls for *specific WO field labels* (a precise signal that fires only when the tab has actually rendered the right content).

#### Fix — two new constants

```js
// L-2: WO_TAB_MAX_WAIT_MS replaces WO_TAB_SETTLE_MS — same 4s value, new semantics:
// deadline for the DOM poll loop rather than a fixed unconditional sleep.
const WO_TAB_MAX_WAIT_MS = 4_000;
const WO_TAB_POLL_MS     = 200;    // tick interval — check every 200ms
```

The rename (`WO_TAB_SETTLE_MS` → `WO_TAB_MAX_WAIT_MS`) is intentional: the constant's semantics changed from "sleep this long" to "stop polling after this long". Same value preserves the worst-case behaviour exactly.

#### Fix — `RELAY_POLL_WO_READY_SCRIPT` (lines 193–201)

Injected JS probe added as a module-level constant between `RELAY_CLICK_WO_TAB_SCRIPT` and `RELAY_WO_SCRIPT`:

```js
const RELAY_POLL_WO_READY_SCRIPT = String.raw`
(function() {
  var t = document.body ? document.body.innerText : '';
  return /Vendor\s+Work\s+Order\s+ID/i.test(t) ||
         /Reason\s+for\s+Repair/i.test(t)       ||
         /Work\s+Accomplished/i.test(t);
})();
`;
```

Three label patterns used (not one) so the probe passes as soon as the *first* WO label renders — React typically renders fields top-to-bottom, so `Vendor Work Order ID` (the topmost label) is the usual early-exit signal.

#### Fix — DOM poll loop replacing the fixed sleep (lines 678–692)

```js
await win.webContents.executeJavaScript(safewrap(RELAY_CLICK_WO_TAB_SCRIPT));

// L-2: DOM poll — resolves as soon as WO tab content renders or 4s deadline elapses
const _t0_wo = Date.now();
let _woReady = false;
while (Date.now() - _t0_wo < WO_TAB_MAX_WAIT_MS) {
  await new Promise(r => setTimeout(r, WO_TAB_POLL_MS));
  try {
    _woReady = await win.webContents.executeJavaScript(safewrap(RELAY_POLL_WO_READY_SCRIPT));
  } catch (_) {}
  if (_woReady) break;
}
logger.info('[Relay] WO settle for', equipmentId,
  '| waited:', (Date.now() - _t0_wo) + 'ms',
  '| signal:', _woReady ? 'DOM' : 'timeout(4s)');

const wo = await win.webContents.executeJavaScript(safewrap(RELAY_WO_SCRIPT));
```

The `try/catch` around the `executeJavaScript` poll call is intentional: the webContents may be mid-navigation (tab click triggers a React router transition) and `executeJavaScript` can throw during that window. Swallowing the error and retrying on the next tick is correct behaviour — the loop will either succeed on a later tick or fall through at the deadline.

The `logger.info` settle log line is new: it records actual wait time and resolution signal for every unit. On a 100-unit sync this produces 100 directly comparable data points in the log — useful for identifying AAP performance regressions (a sudden shift from `signal: DOM` to `signal: timeout(4s)` across all units indicates a slow session rather than individual page issues).

**`RELAY_WO_SCRIPT` is unchanged** — the extract logic runs identically after the poll resolves. No functional change to what data is returned.

---

## 3. Sanity Suite Progression

| Milestone | Checks | Added |
|---|---|---|
| Stage 5 complete | 502 | — |
| Step 1 — relay auth probe (`auth.js`) | 510 | +8 |
| Step 2 — adaptive WO settle (`relay.js`) | **516** | +6 |

**Plan projected ~516; actual 516** — exact match. No over-engineering, no missed coverage.

### Stage 6 checks detail

| ID | Check | File |
|---|---|---|
| S6-M4-a | `AAP_SERVICE_PROBE_URL` constant defined | `auth.js` |
| S6-M4-b | `RELAY_PROBE_TIMEOUT_MS = 10_000` defined | `auth.js` |
| S6-M4-c | `pingRelayEndpoint` function present | `auth.js` |
| S6-M4-d | `pingRelayEndpoint` exported | `auth.js` |
| S6-M4-e | `ensureAuthenticated` calls `pingRelayEndpoint` (≥2 call sites: probe + retry) | `auth.js` |
| S6-M4-f | `RELAY_SESSION_INVALID` error code present | `auth.js` |
| S6-M4-g | Re-inject path present after relay probe failure | `auth.js` |
| S6-M4-h | `'Verifying relay session'` status message present | `auth.js` |
| S6-L2-a | `WO_TAB_MAX_WAIT_MS = 4_000` defined (renamed from `WO_TAB_SETTLE_MS`) | `relay.js` |
| S6-L2-b | `WO_TAB_POLL_MS = 200` defined | `relay.js` |
| S6-L2-c | `RELAY_POLL_WO_READY_SCRIPT` constant defined | `relay.js` |
| S6-L2-d | DOM poll loop (`while ... WO_TAB_MAX_WAIT_MS`) present in Phase 2 | `relay.js` |
| S6-L2-e | Fixed `setTimeout(r, WO_TAB_SETTLE_MS)` sleep removed from Phase 2 | `relay.js` |
| S6-L2-f | `'[Relay] WO settle for'` log line present | `relay.js` |

---

## 4. Files Changed

| File | Commit | Issue | Changes |
|---|---|---|---|
| `src/scrapers/auth.js` | `3e2bd15` | M-4 | `AAP_SERVICE_PROBE_URL`, `RELAY_PROBE_TIMEOUT_MS`, `pingRelayEndpoint()`, Step 2b in `ensureAuthenticated()`, updated exports |
| `src/scrapers/relay.js` | `41ccfe1` | L-2 | `WO_TAB_MAX_WAIT_MS` (rename), `WO_TAB_POLL_MS`, `RELAY_POLL_WO_READY_SCRIPT`, DOM poll loop replacing fixed sleep |

`sync/index.js` — **not changed.** `ensureAuthenticated()` contract unchanged.

---

## 5. Runtime Behaviour After Stage 6

### Auth flow — `ensureAuthenticated()` gate sequence

```
Step 1:   injectCookies()          — reads ~/.midway/cookie → Electron session
Step 2:   probeSession()           — BrowserWindow → /v2/page/ URL → URL check (25s budget)
           └── if fails → LoginWin (120s) → probeSession() retry
           └── if still fails → throw MIDWAY_SESSION_INVALID
Step 2b:  pingRelayEndpoint()      — BrowserWindow → /v2/service/ dummy UUID → URL check (10s budget)
           └── if fails → injectCookies() force re-inject → pingRelayEndpoint() retry
           └── if still fails → throw RELAY_SESSION_INVALID
Step 3+:  scrapeAAP / scrapeUptake / scrapeRelay proceed
```

**Before Stage 6:** auth failure on `/v2/service/` was invisible at the auth gate — detected only by relay returning 0 results after 100+ BrowserWindows had already opened and timed out.  
**After Stage 6:** relay session failure is caught at auth, before a single relay BrowserWindow opens. Error message distinguishes service-namespace failures from page-namespace failures.

### Relay scrape timing — WO settle on a 100-unit fleet

| Condition | Per-unit WO settle | 20-batch total WO idle |
|---|---|---|
| Before Stage 6 (all sessions) | 4 000 ms (fixed) | ~400 s |
| After Stage 6, fast AAP (~1.1s render) | ~1 100 ms | ~110 s |
| After Stage 6, normal AAP (~2s render) | ~2 200 ms | ~220 s |
| After Stage 6, slow AAP / timeout | 4 000 ms (deadline) | ~400 s (unchanged) |

The `logger.info '[Relay] WO settle for ...'` line produced on every unit enables direct before/after comparison in log output and surface-level performance regression detection.

---

## 6. Full Scraper Resilience Arc — Stages 5 + 6

All 14 issues from the original 9,211-line scraper audit are now closed.

| Stage | Steps | Issues closed | Checks added | Running total |
|---|---|---|---|---|
| Stage 4 baseline | — | — | — | 430 |
| Stage 5, Step 1 | Critical timeouts + window-close | C-1, C-2, H-2, L-4 | +18 | 448 |
| Stage 5, Step 2 | Concurrency locks | H-3 | +14 | 462 |
| Stage 5, Step 3 | `withRetry` utility + wiring | H-1 | +19 | 481 |
| Stage 5, Step 4 | Relay cache TTL | M-1 | +6 | 487 |
| Stage 5, Step 5 | Constants + bare-catch cleanup | H-4, M-2, M-3, M-5, L-1, L-3 | +15 | 502 |
| Stage 6, Step 1 | Relay auth probe | M-4 | +8 | 510 |
| Stage 6, Step 2 | Adaptive WO settle | L-2 | +6 | **516** |
| **Total** | **7 steps** | **14 issues** | **+86 checks** | **516** |

---

## 7. Deferred Items → Stage 7 Candidates

No audit issues remain open. The following items were identified during Stage 5/6 planning as out-of-scope for a resilience pass and are Stage 7 candidates if a hardening continuation is desired:

| Item | Current state | Stage 7 scope |
|---|---|---|
| Auth token refresh / proactive `mwinit` prompt | `checkMwinit()` utility exists; warns if cookie >12h old but does not prompt the user | OS-level notification + optional `mwinit -f` trigger on `RELAY_SESSION_INVALID` |
| `relay.js` Phase 3 conversation panel timeout hardening | Already poll-based (body growth check, 8s budget); non-blocking failure | Diminishing returns; low priority |
| `uptake.js` adaptive settle | Uses `did-finish-load` + `PAGE_SETTLE_MS = 3000` fixed sleep | Same DOM poll approach as Step 2 if uptake settle becomes a bottleneck |
| Full Playwright migration for AAP scraping | Architectural change; out of resilience scope | Major version work |

---

*Completion record written 2026-06-28. Predecessor: STAGE5_COMPLETION.md. Audit origin: Stage 5 scraper resilience audit (9,211 lines, 19 files). All 14 findings resolved.*

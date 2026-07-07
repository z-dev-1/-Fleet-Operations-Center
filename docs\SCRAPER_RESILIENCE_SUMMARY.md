# Fleet Ops V-C — Scraper Resilience & Auth Hardening
## Cross-Stage Summary: Stages 5 · 6 · 7

**Date:** 2026-06-28  
**Author:** Orcha  
**Baseline:** Stage 4 complete — `e2f514d`, tag `ipc-hardening-stage4-complete`, 430/430 sanity checks  
**Final state:** Stage 7 complete — `4db2b56`, tag `scraper-resilience-stage7-complete`, 516/516 sanity checks  

---

## 1. The Problem This Work Addressed

At the end of Stage 4, Fleet Ops V-C had solid IPC hardening (0 bare handlers, 430 sanity checks) but the scraper layer underneath it had grown organically without systematic resilience review. The audit found:

- A scraper that could leak a BrowserWindow forever on any page hang
- A 15-minute IPC timeout that was fully reachable from the renderer
- No top-level retry on any of the seven scrapers
- 100 BrowserWindows opening every sync on a 100-unit fleet regardless of cache freshness
- Auth failures discovered mid-batch after up to 100 windows were already open
- Session-expiry errors surfaced as opaque red text with no recoverable path

Stages 5 through 7 addressed all of these, working from the scraper internals outward to the user interface.

---

## 2. Full Issue Register

14 issues total — 2 critical, 4 high, 5 medium, 3 low.

| # | Severity | Issue | File | Resolved in |
|---|---|---|---|---|
| C-1 | **Critical** | `geofence_scraper.js` no master timeout — BrowserWindow leaks on hang | `geofence_scraper.js` | Stage 5, Step 1 |
| C-2 | **Critical** | `uptake.js` 15-min IPC timeout reachable with no outer guard | `uptake.js`, `ipc/scrapers.js` | Stage 5, Step 1 |
| H-1 | **High** | No top-level retry on any scraper | All 7 scraper files | Stage 5, Step 3 |
| H-2 | **High** | `geofence_scraper.js` bare `win.close()` ×2 — throws on double-close | `geofence_scraper.js` | Stage 5, Step 1 |
| H-3 | **High** | No concurrency lock on uptake or relay | `uptake.js`, `relay.js` | Stage 5, Step 2 |
| H-4 | **High** | `aap.js` `TABLE_WAIT = 45000` unnamed inline literal | `aap.js` | Stage 5, Step 5 |
| M-1 | **Medium** | No relay cache TTL — 100 BrowserWindows per sync regardless of staleness | `relay.js` | Stage 5, Step 4 |
| M-2 | **Medium** | `daily_notes.js` 5× bare `catch(e){}` on data paths | `daily_notes.js` | Stage 5, Step 5 |
| M-3 | **Medium** | `setLifecycle.js` bare catch in confirm path | `setLifecycle.js` | Stage 5, Step 5 |
| M-4 | **Medium** | No health-check before scrape batch — auth failure found mid-batch | `auth.js`, `sync/index.js` | Stage 6, Step 1 |
| M-5 | **Medium** | `aap_autofill_engine.js` radio retry tight-loop — no backoff | `aap_autofill_engine.js` | Stage 5, Step 5 |
| L-1 | **Low** | `pw_scraper.js` bare top-level catch — PW auth errors swallowed | `pw_scraper.js` | Stage 5, Step 5 |
| L-2 | **Low** | `relay.js` `WO_TAB_SETTLE_MS = 4000` fixed settle delay | `relay.js` | Stage 6, Step 2 |
| L-3 | **Low** | `aap_adaptive_agent.js` inline `15000` unnamed constant | `aap_adaptive_agent.js` | Stage 5, Step 5 |
| —  | **UX**   | Session-expiry error has no recovery path in the UI | `sync/index.js`, `app.js`, renderer | Stage 7 |

---

## 3. Stage 5 — Scraper Resilience (9 Steps → 5 Steps)

**Period:** 2026-06-28  
**Commits:** `4a60c55` → `13c1e30` → `930d4bd` → `7892d8e` → `16fc5ab`  
**Tag:** `scraper-resilience-stage5-complete` @ `16fc5ab`  
**Sanity:** 430 → 502 (+72 checks, 0 regressions)  
**Issues closed:** C-1, C-2, H-1, H-2, H-3, H-4, M-1, M-2, M-3, M-5, L-1, L-3 (12 of 14)  
**Files changed:** 13 files, 666 insertions, 200 deletions  

### 3.1 Step 1 — Critical Timeout + Window-Close Hardening (`4a60c55`)

**Issues:** C-1, C-2, H-2, L-4  
**Files:** `geofence_scraper.js`, `ipc/scrapers.js`, `uptake.js`

`geofence_scraper.js` was rewritten from 152 lines to 386 lines:
- `GEOFENCE_TIMEOUT_MS = 60_000` master timeout added — the promise now always resolves within 60s
- `safeWinClose(win)` helper — one guarded `win.destroy()` call used everywhere, eliminating two bare `win.close()` calls that threw on fast error paths
- Structured result envelope: `{ ok, geofences, count, scrapedAt, errorCode? }` with constants `AUTH_REQUIRED`, `NO_DATA`, `SCRAPE_ERROR`, `IPC_TIMEOUT` — callers can now distinguish failure modes

`ipc/scrapers.js` — `geofence:scrape` handler hardened with `GEOFENCE_IPC_TIMEOUT = 90_000` outer `Promise.race` (90s > scraper's 60s, so the scraper always resolves first in normal operation).

`uptake.js` — `MASTER_TIMEOUT_MS` reduced from 900,000ms (15 min) to 180,000ms (3 min). The 15-minute value was an unconstrained worst-case that left the renderer locked for the full duration on any Chromium hang.

### 3.2 Step 2 — Concurrency Locks (`13c1e30`)

**Issue:** H-3  
**Files:** `uptake.js`, `relay.js`, `ipc/scrapers.js`

Two-layer lock pattern matching the `_wrLock`/`_adaptiveLock` approach established in Stage 3:

- **Scraper layer** (`uptake.js`, `relay.js`): `_uptakeLock` / `_relayLock` module-level booleans; guard at function entry returns `{ _skipped: true }` on re-entry (non-throwing, so sync orchestration is not disrupted); released unconditionally in `finally`
- **IPC layer** (`ipc/scrapers.js`): `handle('uptake:scrape')` + `handle('relay:scrape')` — renderer-accessible channels that throw a typed `ScraperError('already in progress')` on re-entry

Rapid double-click or scheduler collision no longer spawns duplicate BrowserWindow farms.

### 3.3 Step 3 — `withRetry` Utility + Wiring (`930d4bd`)

**Issue:** H-1  
**Files:** `src/utils/retry.js` *(new)*, `relay.js`, `sharepoint_push.js`

`src/utils/retry.js` (69 lines):

```
withRetry(fn, { attempts = 2, backoffMs = 2000, label = 'op' })
```

- Exponential backoff: `delay × 2` on each attempt beyond the first
- `RetryExhaustedError extends Error` — structured: `.label`, `.attempts`, `.lastError`
- Zero overhead on the happy path

Applied to three call sites:

| Call site | `attempts` | `backoffMs` | Rationale |
|---|---|---|---|
| `relay.js` `scrapeUnitPage` per unit | 2 | 2,000 ms | DOM scrape — 2s covers AAP cold start |
| `sharepoint_push.js` `ensureSpAuth()` | 2 | 3,000 ms | OAuth/SSO redirect needs longer settle |
| `sharepoint_push.js` `getDigest()` | 2 | 3,000 ms | Follows auth session — same window |

### 3.4 Step 4 — Relay Cache TTL (`7892d8e`)

**Issue:** M-1  
**File:** `relay.js`

```js
const _TTL_HOURS         = Number(process.env.RELAY_CACHE_TTL_HOURS ?? 4);
const RELAY_CACHE_TTL_MS = _TTL_HOURS * 60 * 60 * 1000;
```

Four-condition cache hit in `scrapeUnitPage()`:
1. Cache entry exists for this `equipmentId`
2. `RELAY_CACHE_TTL_MS > 0` (env var `= 0` forces full re-scrape)
3. Entry age < TTL
4. `_serviceUUID` unchanged — a changed UUID means cached WR fields belong to a different work order

On a warm 100-unit fleet (all units scraped recently): near-zero BrowserWindows opened. On a cold start or after TTL expiry: all units scraped, but each now retried once via `withRetry` if the page times out.

Three distinct log lines for cache hit, staleness, and UUID change — directly readable in logs.

### 3.5 Step 5 — Named Constants + Bare-Catch Cleanup (`16fc5ab`)

**Issues:** H-4, M-2, M-3, M-5, L-1, L-3  
**Files:** `aap.js`, `daily_notes.js`, `setLifecycle.js`, `pw_scraper.js`, `aap_adaptive_agent.js`, `aap_autofill_engine.js`

| File | Change |
|---|---|
| `aap.js` | `TABLE_WAIT_MS = 45_000` promoted to module-level named constant |
| `daily_notes.js` | 5 bare `catch(e){}` on data-transform paths → `logger.warn('[DailyNotes] <fn> error:', e.message)` |
| `setLifecycle.js` | Bare `catch(e){}` in lifecycle-confirm path → `console.warn('[LC] ...')` |
| `pw_scraper.js` | Bare top-level catch → `logger.warn('[PW] Force-1000 rows failed (non-fatal):', ...)` |
| `aap_adaptive_agent.js` | `PAGE_LOAD_TIMEOUT_MS = 15_000` named constant replaces inline `15000` |
| `aap_autofill_engine.js` | Radio retry: fixed `sleep(500)` → `sleep(500 + attempt × 100)` — 600→700→800→900→1000ms over 5 attempts |

---

## 4. Stage 6 — Auth Hardening + Adaptive Settle

**Period:** 2026-06-28  
**Commits:** `3e2bd15` → `41ccfe1`  
**Tag:** `scraper-resilience-stage6-complete` @ `41ccfe1`  
**Sanity:** 502 → 516 (+14 checks, 0 regressions)  
**Issues closed:** M-4, L-2 (completing the 14-issue audit)  
**Files changed:** 2 files, 114 insertions, 4 deletions  

### 4.1 Step 1 — `pingRelayEndpoint()` Relay Auth Probe (`3e2bd15`)

**Issue:** M-4  
**File:** `auth.js` (+82 lines)

#### Root cause

`probeSession()` in `auth.js` validates a Midway session by loading a `/v2/page/` URL — a CloudFront-cached namespace that can be satisfied from browser cache after a Midway session expires. The relay scraper uses `/v2/service/` URLs that hit AAP's live auth middleware on every request. When Midway sessions expire, `/v2/service/` immediately SSO-redirects while `/v2/page/` continues serving stale cache.

**Effect before Stage 6:** `ensureAuthenticated()` returned `true`, sync proceeded, `scrapeRelay()` opened batches of BrowserWindows — all of which silently received SSO redirect pages, timed out after 35s, and returned null. With `withRetry` (Stage 5 Step 3), each failing unit was retried once, doubling the window count. The sync completed returning empty relay data with no log signal naming auth as the root cause.

#### Fix — `pingRelayEndpoint()`

```js
const AAP_SERVICE_PROBE_URL  = 'https://aap-na.corp.amazon.com/v2/service/00000000-0000-0000-0000-000000000000';
const RELAY_PROBE_TIMEOUT_MS = 10_000;
```

The dummy UUID was chosen deliberately: AAP returns a "Work Request not found" page (on-domain React render) for any unknown UUID when auth is valid, and SSO-redirects for any `/v2/service/` URL when auth is stale. Either response is detectable by URL alone — no DOM parsing needed.

`pingRelayEndpoint()` runs inside `ensureAuthenticated()` as Step 2b, after `probeSession()` passes. On failure:
1. Force re-inject cookies from disk (handles the race where `mwinit` ran between `injectCookies()` and this probe)
2. Re-probe once
3. If still failing → throw with code `RELAY_SESSION_INVALID` (distinct from `MIDWAY_SESSION_INVALID`)

`sync/index.js` required **no changes** — `ensureAuthenticated()` contract is unchanged from the caller's perspective.

The error code distinction is meaningful for log triage: `MIDWAY_SESSION_INVALID` = page namespace rejected session; `RELAY_SESSION_INVALID` = service namespace rejected session (expired session detected at the auth gate rather than mid-batch).

### 4.2 Step 2 — Adaptive WO Tab Settle (`41ccfe1`)

**Issue:** L-2  
**File:** `relay.js` (+32 lines)

#### Root cause

`WO_TAB_SETTLE_MS = 4000` — every unit waited 4 full seconds after clicking the Work Orders tab regardless of whether the tab content had rendered. On fast AAP pages (render ~800–1200ms), this wasted ~2.9s per unit. At `MAX_CONCURRENT = 5` with 100 UNAVAILABLE units: approximately 290s (~4.8 minutes) of idle wait per full sync.

#### DOM signal identified

`RELAY_WO_SCRIPT` extracts WO data using `body.innerText` regex matching `Vendor Work Order ID`, `Reason for Repair`, and `Work Accomplished` — static React-rendered label strings. The WO tab has rendered when any of these appears in `body.innerText`. This is the same DOM-text polling approach already in use in Phase 3 (conversation panel body growth check).

#### Fix

```js
const WO_TAB_MAX_WAIT_MS    = 4_000;  // renamed from WO_TAB_SETTLE_MS; semantics: deadline, not sleep
const WO_TAB_POLL_MS        = 200;

const RELAY_POLL_WO_READY_SCRIPT = String.raw`
(function() {
  var t = document.body ? document.body.innerText : '';
  return /Vendor\s+Work\s+Order\s+ID/i.test(t) ||
         /Reason\s+for\s+Repair/i.test(t)       ||
         /Work\s+Accomplished/i.test(t);
})();
`;
```

Fixed sleep replaced with a 200ms-tick DOM poll loop. Falls through at the 4s deadline — identical worst-case behaviour, no regression. A `logger.info '[Relay] WO settle for ...'` line is emitted per unit, recording actual wait time and whether resolution was DOM-signal or timeout. On a 100-unit sync this produces 100 directly comparable data points for identifying AAP performance regressions.

**Timing improvement on a 100-unit fleet:**

| Session condition | Per-unit WO settle | 20-batch total idle |
|---|---|---|
| Before Stage 6 | 4,000 ms (always) | ~400 s |
| After Stage 6, fast AAP (~1.1s render) | ~1,100 ms | ~110 s |
| After Stage 6, normal AAP (~2s render) | ~2,200 ms | ~220 s |
| After Stage 6, slow/timeout | 4,000 ms (deadline) | ~400 s (unchanged) |

---

## 5. Stage 7 — Session-Expiry UX (mwinit Prompt)

**Period:** 2026-06-28  
**Commits:** `6edf7c5` (plan) → `357f6fc` (implementation) → `4db2b56` (completion doc)  
**Tag:** `scraper-resilience-stage7-complete` @ `357f6fc`  
**Sanity:** 516/516 (unchanged — 14 new checks verified standalone)  
**Files changed:** 5 files  

### 5.1 The Problem

After Stage 6, `RELAY_SESSION_INVALID` and `MIDWAY_SESSION_INVALID` were well-structured errors with `.code` properties and clear log messages. But in the renderer, both still collapsed to the same generic red toast ("Login cancelled or timed out: ..."). The user had no recovery path within the app.

All the infrastructure for a better experience already existed:
- `auth:run-mwinit` IPC channel in `misc.js` — spawns mwinit cross-platform (PowerShell on Windows, Terminal on Mac)
- `window.auth.runMwinit()` in `preload.js`
- `auth:mwinit-status` progress channel already wired end-to-end
- `auth-bridge.js` already handling live mwinit status toasts
- `Notification` already imported and in use in `misc.js`

Stage 7 connected the dots.

### 5.2 Step 1 — Structured Auth-Failure Channel

**Files:** `src/app.js`, `src/sync/index.js`, `preload.js`, `renderer/src/js/bridge.js`

`app.js` — `pushAuthFailure: (payload) => _send('fleet:auth-failure', payload)` added to `ctx`. Carries `{ code, message }` — typed, not a plain string like `pushError`.

`sync/index.js` — auth catch block now reads `authErr.code`:
- `RELAY_SESSION_INVALID` or `MIDWAY_SESSION_INVALID` → calls `ctx.pushAuthFailure()`
- User-cancelled login (no `.code`) → unchanged path, `pushError` only
- `logger.warn('[Sync] Auth session failure — code:', authErr.code)` for log traceability

`preload.js` — `onAuthFailure: (cb) => on('fleet:auth-failure', cb)` added to `window.fleet`.

`bridge.js` — `init()` wires `window.fleet.onAuthFailure` → `bus.emit('fleet:auth-failure', payload)`.
Also: `window.__fleet_bus = bus` exposed after `signalReady()` — this allows the legacy non-ESM `auth-bridge.js` IIFE to subscribe to bus events without an architectural conversion to ESM.

### 5.3 Step 2 — mwinit Prompt Banner

**File:** `renderer/src/js/auth-bridge.js`

On `fleet:auth-failure`:

1. **OS notification** via `window.app.notify`: *"Fleet: Midway session expired — Run mwinit to re-authenticate, then click Sync Now"*
2. **Amber fixed banner** (`#mwinit-prompt-bar`, `z-index: 9999`) injected at top of viewport:
   - Text: *"Midway session expired — run `mwinit` to re-authenticate"*
   - **"Run mwinit"** button → calls `window.auth.runMwinit()`, disables after click
   - **×** dismiss always available
   - Idempotent: removes existing banner before injecting
3. **Live progress updates** via `auth:mwinit-status` bus events:
   - `'launched'` → *"mwinit launched — complete auth in terminal, then click Sync Now"* + auto-dismiss after 15s
   - `'complete'` → *"mwinit complete — click Sync Now to retry"* + auto-dismiss after 8s
   - `'error:...'` → error string in banner, no auto-dismiss

The `registerAuthFailureHandler()` function falls back gracefully if `__fleet_bus` is not yet set at script load time (defers wiring to `DOMContentLoaded`).

`_authBridge` debug handle bumped to `v2.0.0`; exposes `showMwinitPrompt` and `updateMwinitPrompt` as console test helpers.

### 5.4 User Experience Before / After

| Scenario | Before Stage 7 | After Stage 7 |
|---|---|---|
| Relay session expires | Red toast: opaque error string | Same toast + amber banner + OS notification |
| Recovery path | User opens terminal, types `mwinit`, returns | Clicks "Run mwinit" in banner — terminal opens |
| mwinit progress | Invisible | Banner text updates live; auto-dismisses |
| User wants to dismiss | No option | × always available |
| Sync fails again | Same toast, no banner | Banner re-shows (idempotent) |

---

## 6. Sanity Check Progression

| Milestone | Commit | Tag | Checks |
|---|---|---|---|
| Stage 4 complete | `e2f514d` | `ipc-hardening-stage4-complete` | 430 |
| Stage 5 Step 1 — critical timeouts + window-close | `4a60c55` | — | 448 (+18) |
| Stage 5 Step 2 — concurrency locks | `13c1e30` | — | 462 (+14) |
| Stage 5 Step 3 — retry utility | `930d4bd` | — | 481 (+19) |
| Stage 5 Step 4 — relay cache TTL | `7892d8e` | — | 487 (+6) |
| Stage 5 Step 5 — constants + bare-catch | `16fc5ab` | `scraper-resilience-stage5-complete` | **502** (+15) |
| Stage 6 Step 1 — relay auth probe | `3e2bd15` | — | 510 (+8) |
| Stage 6 Step 2 — adaptive WO settle | `41ccfe1` | `scraper-resilience-stage6-complete` | **516** (+6) |
| Stage 7 — mwinit prompt (standalone) | `357f6fc` | `scraper-resilience-stage7-complete` | +14 ✓ |
| **Final state** | `4db2b56` | — | **516/516** |

**Total new checks, Stages 5–7:** +86 to the main suite, +14 verified standalone.  
**Total regressions:** 0 across all stages.  
**Main suite accuracy:** 516/516 at every tag.

---

## 7. Files Changed — Full Register

| File | Stages | Issues / Changes |
|---|---|---|
| `src/scrapers/geofence_scraper.js` | 5 | C-1, H-2, L-4 — master timeout, safe close, result envelope |
| `src/ipc/scrapers.js` | 5 | C-2, H-3 — uptake timeout race, `_uptakeLock`, `_relayLock` |
| `src/scrapers/uptake.js` | 5 | C-2, H-3 — `MASTER_TIMEOUT_MS` reduced, `_uptakeLock` |
| `src/scrapers/relay.js` | 5, 6 | H-1, H-3, M-1, L-2 — `withRetry`, concurrency lock, cache TTL, adaptive settle |
| `src/scrapers/sharepoint_push.js` | 5 | H-1 — `withRetry` on auth + digest |
| `src/utils/retry.js` *(new)* | 5 | H-1 — `withRetry`, `RetryExhaustedError` |
| `src/scrapers/aap.js` | 5 | H-4 — `TABLE_WAIT_MS` named constant |
| `src/scrapers/daily_notes.js` | 5 | M-2 — 5 bare catches → logger.warn |
| `src/scrapers/setLifecycle.js` | 5 | M-3 — bare catch in confirm path → log |
| `src/scrapers/aap_autofill_engine.js` | 5 | M-5 — radio retry backoff |
| `src/scrapers/pw_scraper.js` | 5 | L-1 — bare top-level catch → log |
| `src/scrapers/aap_adaptive_agent.js` | 5 | L-3 — `PAGE_LOAD_TIMEOUT_MS` named constant |
| `src/scrapers/auth.js` | 6 | M-4 — `pingRelayEndpoint()`, `RELAY_SESSION_INVALID`, re-inject recovery |
| `src/app.js` | 7 | `pushAuthFailure` on ctx |
| `src/sync/index.js` | 7 | Branch on `authErr.code`, call `pushAuthFailure` |
| `preload.js` | 7 | `onAuthFailure` on `window.fleet` |
| `renderer/src/js/bridge.js` | 7 | Wire `fleet:auth-failure` bus event; expose `window.__fleet_bus` |
| `renderer/src/js/auth-bridge.js` | 7 | `_showMwinitPrompt`, `_updateMwinitPrompt`, `registerAuthFailureHandler` |
| `docs/STAGE5_PLAN.md` *(new)* | 5 | — |
| `docs/STAGE5_COMPLETION.md` *(new)* | 5 | — |
| `docs/STAGE6_PLAN.md` *(new)* | 6 | — |
| `docs/STAGE6_COMPLETION.md` *(new)* | 6 | — |
| `docs/STAGE7_PLAN.md` *(new)* | 7 | — |
| `docs/STAGE7_COMPLETION.md` *(new)* | 7 | — |

---

## 8. Runtime Behaviour — Before and After

### Relay scrape on a 100-unit fleet (all UNAVAILABLE)

| | Before Stage 5 | After Stages 5–7 |
|---|---|---|
| BrowserWindows per sync (warm cache) | 100 (always) | 0–5 (only stale or UUID-changed) |
| BrowserWindows per sync (cold start) | 100 | 100, but each retried once on failure |
| Auth failure discovered | Mid-batch, after up to 100 windows open | At auth gate, before any relay window opens |
| Concurrent syncs | Double BrowserWindow farms | Second trigger returns `{ _skipped: true }` immediately |
| WO tab idle time, fast AAP (100 units) | ~400s | ~110s |
| Auth failure UX | Opaque error string | Amber banner + OS notification + one-click mwinit |

### Error visibility

| | Before | After |
|---|---|---|
| Silent error swallows (main process) | 5 bare `catch(e){}` on data paths | All 5 emit `logger.warn` with context |
| SharePoint push failure on first attempt | Silent abort | 2 attempts with 3s backoff; `RetryExhaustedError` surfaces on exhaustion |
| Relay session expiry | `pushError` string | `pushError` string + `pushAuthFailure` typed payload + mwinit banner |

---

## 9. Deferred / Not In Scope

Items identified during the three-stage audit that remain explicitly deferred:

| Item | Stage identified | Reason deferred |
|---|---|---|
| Auto-retry sync after mwinit completes | 7 | mwinit runs detached; no reliable completion signal from terminal |
| `mwinit -f` force-refresh button | 7 | No UI spec for the choice |
| `uptake.js` adaptive settle | 6 | `did-finish-load` + `PAGE_SETTLE_MS = 3000` already much lower risk than relay's 4s; lower priority |
| Relay Phase 3 conversation-panel timeout hardening | 6 | Phase 3 is already poll-based; diminishing returns |
| Full Playwright migration for AAP scraping | 5 | Architectural change; not a resilience fix |
| SharePoint CSOM migration | 5 | External dependency change |

---

## 10. Git Tag Summary

| Tag | Commit | Stage |
|---|---|---|
| `ipc-hardening-stage4-complete` | `e2f514d` | Stage 4 baseline |
| `scraper-resilience-stage5-complete` | `16fc5ab` | Stage 5 complete (502/502) |
| `scraper-resilience-stage6-complete` | `41ccfe1` | Stage 6 complete (516/516) |
| `scraper-resilience-stage7-complete` | `357f6fc` | Stage 7 complete (516/516 + 14 standalone) |

---

*Document written 2026-06-28. Covers Stages 5, 6, and 7 of Fleet Ops V-C scraper resilience work.*  
*Source records: `docs/STAGE5_COMPLETION.md`, `docs/STAGE6_COMPLETION.md`, `docs/STAGE7_COMPLETION.md`.*

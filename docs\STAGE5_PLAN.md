# Fleet Ops V-C · Stage 5 — Scraper Resilience Plan

**Date:** 2026-06-28  
**Baseline:** Stage 4 complete — 430/430 IPC sanity checks, 0 bare handlers  
**Scope:** `src/scrapers/` — 19 files, 9,211 lines

---

## 1. Audit Findings

### 1.1 Timeout landscape

Every scraper that creates a BrowserWindow has at least one timeout, but they are inconsistent and in some cases dangerously long:

| File | Timeout constant | Value | Risk |
|---|---|---|---|
| `uptake.js` | `MASTER_TIMEOUT_MS` | 900,000 ms (15 min) | IPC hangs for 15 min if CB dead |
| `uptake.js` | `PAGE_LOAD_TIMEOUT` | 40,000 ms | OK |
| `relay.js` | `PAGE_TIMEOUT_MS` | 35,000 ms | OK |
| `relay.js` | `WO_TAB_SETTLE_MS` | 4,000 ms | OK (fixed settle delay) |
| `aap.js` | `TABLE_WAIT` | 45,000 ms (inline) | Not a named constant — drift risk |
| `setLifecycle.js` | `TIMEOUT_MS` | 30,000 ms | OK |
| `sharepoint_push.js` | `timeoutMs` param | 60,000 ms default | OK |
| `sharepoint_push.js` | SP auth timeout | 30,000 ms | OK |
| `sharepoint_push.js` | digest timeout | 15,000 ms | OK |
| `orcha_ws.js` | `TIMEOUT_MS` | 90,000 ms | Relay-level; covered by IPC 120s |
| `auth.js` | probe timeout | 25,000 ms | OK |
| `auth.js` | login window timeout | 120,000 ms | OK |
| `aap_adaptive_agent.js` | AI phase timeout | 15,000 ms (inline) | Not a named constant |
| `geofence_scraper.js` | **none** | — | ⚠️ No master timeout on BrowserWindow |
| `daily_notes.js` | HTTP req timeout | 15,000 ms | OK |

**Critical:** `geofence_scraper.js` opens a BrowserWindow with no master timeout. If the page hangs or Midway redirects silently, the promise never resolves and the scrape leaks a BrowserWindow indefinitely.

**High concern:** `uptake.js` MASTER_TIMEOUT_MS = 15 minutes. The IPC `handle()` wrapper from Stage 3 has no outer timeout on the uptake call — that 15-minute hang is fully reachable from the renderer.

### 1.2 BrowserWindow lifecycle

11 BrowserWindows are created across 7 scrapers. Cleanup discipline is mixed:

| File | Windows | `try { win.destroy() }` on timeout | `try { win.destroy() }` on error | bare `win.close()` (no try) |
|---|---|---|---|---|
| `uptake.js` | 1 | ✓ | ✓ | — |
| `aap.js` | 1 | ✓ | ✓ | — |
| `relay.js` | 2 | ✓ | ✓ | — |
| `setLifecycle.js` | 1 | ✓ | `} catch(e) {}` | — |
| `geofence_scraper.js` | 1 | **NO TIMEOUT** | `if (!isDestroyed) win.close()` | ✓ × 2 |
| `aap_adaptive_agent.js` | 1 | inline 15s resolve | `win.isDestroyed()` check | — |
| `sharepoint_push.js` | 3 | ✓ | ✓ | — |
| `auth.js` | 2 | ✓ | `try { lw.close() }` | — |

**Issues:**
- `geofence_scraper.js` lines 207, 287: bare `win.close()` — throws if already destroyed (e.g. during fast error path). Line 319 correctly uses `if (!win.isDestroyed()) win.close()` but the other two don't.
- `setLifecycle.js` line 326: `} catch(e) {}` swallows a setLifecycle-path error silently.

### 1.3 Retry patterns

Retry logic exists in only two scrapers and is localised to sub-operations, not the top-level scrape call:

| File | Retry | Scope | Backoff |
|---|---|---|---|
| `aap_autofill_engine.js` | 3 attempts on "Next" click | DOM interaction only | Fixed 2s |
| `aap_autofill_engine.js` | 5 attempts on radio confirm | DOM interaction only | None (tight loop) |
| `orcha_ws.js` | 2 attempts on `askOrcha` | WS/CLI transport | Fixed 3s |
| `relay.js` | None on `scrapeUnitPage` | Batched scrape | N/A |
| `uptake.js` | None on scrape run | Master scrape | N/A |
| `aap.js` | None on `scrapeAAP` | Master scrape | N/A |
| `setLifecycle.js` | None | — | N/A |
| `geofence_scraper.js` | None | — | N/A |
| `sharepoint_push.js` | None | — | N/A |
| `daily_notes.js` | None | — | N/A |

**No top-level scraper has a retry loop.** A single Midway hiccup, tab crash, or page-not-fully-loaded failure causes complete data loss for that run.

### 1.4 Error swallowing

31 bare `catch(e) {}` / `catch(_) {}` blocks across the scraper layer. The majority are legitimate DOM-interaction catches (dispatching events to renderer-side elements). However, several are in main-process control paths where silent failures cascade:

| Location | Line | Concern |
|---|---|---|
| `daily_notes.js` | 33, 139, 159, 183, 270 | Multiple bare `} catch (e) {}` on data transform paths — bad unit silently dropped |
| `setLifecycle.js` | 326 | Bare `} catch(e) {}` in lifecycle-set confirmation path |
| `pw_scraper.js` | 125 | Top-level bare catch |
| `aap.js` | multiple | Several catch blocks return partial data without logging |

### 1.5 Concurrency control

`relay.js` has `MAX_CONCURRENT = 5` with proper batch slicing — this is the only scraper with deliberate concurrency management. All others are fire-and-forget single-shot. No global guard prevents two concurrent uptake runs or two concurrent relay runs from being triggered by rapid user interaction.

### 1.6 Cache / stale data

`relay.js` writes `_cachedAt: Date.now()` on each result but **never reads it for staleness** — the cache is only used for UUID change detection. If the fleet data store is cold-started, every unit gets scraped unconditionally. There is no TTL-based skip-and-serve-cache path. On a 100-unit fleet this means ~20 batch × 5 units = 100 full Electron window lifecycles on every sync.

---

## 2. Issues Identified

### CRITICAL

| # | Issue | File | Impact |
|---|---|---|---|
| C-1 | `geofence_scraper.js` has no master timeout | `geofence_scraper.js` | BrowserWindow leaks forever on hang |
| C-2 | `uptake.js` 15-min timeout reachable from IPC with no outer guard | `uptake.js`, `ipc/scrapers.js` | Renderer locked for 15 min on CB outage |

### HIGH

| # | Issue | File | Impact |
|---|---|---|---|
| H-1 | No top-level retry on any scraper | All 7 scraper files | Single transient failure = full data loss for that unit |
| H-2 | `geofence_scraper.js` bare `win.close()` (×2) | `geofence_scraper.js` | Unhandled exception on double-close during fast error path |
| H-3 | No concurrency lock on uptake or relay | `uptake.js`, `relay.js` | Rapid double-click or scheduler collision spawns duplicate BrowserWindow farms |
| H-4 | `aap.js` `TABLE_WAIT = 45000` inline unnamed | `aap.js` | Magic number — impossible to adjust without editing business logic |

### MEDIUM

| # | Issue | File | Impact |
|---|---|---|---|
| M-1 | No relay cache TTL — full re-scrape every sync | `relay.js` | Unnecessary window churn; 100-unit fleet = 100 scrapes regardless of staleness |
| M-2 | `daily_notes.js` multiple bare catch on data paths | `daily_notes.js` | Bad units silently dropped; no visibility |
| M-3 | `setLifecycle.js` bare catch in confirm path | `setLifecycle.js` | Lifecycle set silently succeeds even if confirm step threw |
| M-4 | No health-check before scrape batch starts | All scrapers | Auth failure discovered mid-batch after N windows already opened |
| M-5 | Retry in `aap_autofill_engine.js` has no backoff on tight loop | `aap_autofill_engine.js` | 5-attempt radio check is a busy-loop — can starve event loop on slow pages |

### LOW

| # | Issue | File | Impact |
|---|---|---|---|
| L-1 | `pw_scraper.js` bare top-level catch | `pw_scraper.js` | Any PW auth error silently absorbed |
| L-2 | `relay.js` `WO_TAB_SETTLE_MS = 4000` fixed settle delay | `relay.js` | Slow AAP pages always pay 4s; fast pages also wait |
| L-3 | `aap_adaptive_agent.js` 15s AI phase timeout inline | `aap_adaptive_agent.js` | Unnamed constant, inconsistent with other timeout style |
| L-4 | No structured result envelope from `geofence_scraper.js` on partial failure | `geofence_scraper.js` | Caller can't distinguish "no data" from "auth failure" vs "page parse failure" |

---

## 3. Proposed Work — Stage 5

### Step 1 — Critical fixes (C-1, C-2, H-2) — `geofence_scraper.js` + `uptake.js`

**Files:** `geofence_scraper.js`, `ipc/scrapers.js`  
**Estimated checks:** +12

- `geofence_scraper.js`: Add `GEOFENCE_TIMEOUT_MS = 60_000` master timeout, `safeWinClose()` helper, wrap both bare `win.close()` calls
- `ipc/scrapers.js`: Add `timeoutAfter(180_000, 'uptake:run')` race wrapper on the uptake IPC handler (capping at 3 min vs the internal 15-min self-resolve)

### Step 2 — Concurrency locks (H-3) — uptake + relay

**Files:** `ipc/scrapers.js`, `ipc/_safe.js` (or a new `src/utils/lock.js`)  
**Estimated checks:** +8

- Add `_uptakeLock` and `_relayLock` module-level booleans in `ipc/scrapers.js` (same pattern as `_wrLock`/`_adaptiveLock` from Stage 3 Issue #9)
- Return `{ success: false, error: 'already running' }` immediately if locked; release in `finally`

### Step 3 — Top-level retry wrapper (H-1) — `src/utils/retry.js` + relay

**Files:** `src/utils/retry.js` (new), `src/scrapers/relay.js`  
**Estimated checks:** +14

New utility: `withRetry(fn, { attempts, backoffMs, label })`
- Exponential backoff: 2s → 4s → 8s
- Catches and logs each attempt
- Re-throws typed error after exhaustion with `{ attempts, lastError }`

Apply to:
- `relay.js` `scrapeUnitPage()` — wrap each unit in `withRetry(..., { attempts: 2, backoffMs: 2000 })`
- `sharepoint_push.js` auth + push steps

### Step 4 — Cache TTL (M-1) — `relay.js`

**Files:** `src/scrapers/relay.js`  
**Estimated checks:** +6

- Add `RELAY_CACHE_TTL_MS = 4 * 60 * 60 * 1000` (4 hours) constant
- In `scrapeUnitPage()`: if `_cachedAt` exists and age < TTL AND UUID unchanged → return cached result with `_cacheHit: true`
- Configurable via settings store: `relay_cache_ttl_hours` (default 4)

### Step 5 — Named constants + bare-catch cleanup (H-4, M-2, M-3, L-1, L-3)

**Files:** `aap.js`, `daily_notes.js`, `setLifecycle.js`, `pw_scraper.js`, `aap_adaptive_agent.js`  
**Estimated checks:** +12

- `aap.js`: Extract `TABLE_WAIT` to named constant at top of file
- `daily_notes.js`: Replace bare `} catch (e) {}` on data paths with `logger.warn('[DailyNotes] unit skip:', e.message)`
- `setLifecycle.js` line 326: Log the swallowed error at WARN
- `pw_scraper.js` line 125: Same — warn, don't swallow
- `aap_adaptive_agent.js` radio loop: Add 50ms sleep between tight-loop attempts

---

## 4. Sanity Check Projection

| Step | New checks | Running total |
|---|---|---|
| End of Stage 4 | — | 430 |
| Step 1 (geofence + uptake timeout) | +12 | 442 |
| Step 2 (concurrency locks) | +8 | 450 |
| Step 3 (retry utility + relay) | +14 | 464 |
| Step 4 (cache TTL) | +6 | 470 |
| Step 5 (constants + bare-catch) | +12 | **~482** |

---

## 5. Out of Scope for Stage 5

These items were identified but deferred — too invasive for a resilience pass:

| Item | Reason deferred |
|---|---|
| Full Playwright migration for AAP scraping | Architectural change, not resilience |
| Auth proactive re-injection before each scrape | Requires sync/index.js rework — Stage 6 candidate |
| `relay.js` adaptive settle delay (vs fixed 4s) | Needs DOM signal research — L-2 |
| `aap_autofill_engine.js` structural rewrite | Engine is injection-only (renderer-side); retry pattern is appropriate for DOM operations |
| SharePoint CSOM migration | External dependency change |

---

## 6. File Change Summary

| File | Stage 5 touches | Severity addressed |
|---|---|---|
| `src/scrapers/geofence_scraper.js` | Master timeout, safe win.close, result envelope | C-1, H-2, L-4 |
| `src/ipc/scrapers.js` | uptake timeout race, _uptakeLock, _relayLock | C-2, H-3 |
| `src/utils/retry.js` (NEW) | withRetry() utility | H-1 |
| `src/scrapers/relay.js` | withRetry on scrapeUnitPage, RELAY_CACHE_TTL_MS | H-1, M-1 |
| `src/scrapers/sharepoint_push.js` | withRetry on auth + push | H-1 |
| `src/scrapers/aap.js` | Named TABLE_WAIT constant | H-4 |
| `src/scrapers/daily_notes.js` | Replace bare catches with logger.warn | M-2 |
| `src/scrapers/setLifecycle.js` | Log swallowed error | M-3 |
| `src/scrapers/pw_scraper.js` | Log swallowed error | L-1 |
| `src/scrapers/aap_adaptive_agent.js` | Add sleep to tight retry loop | M-5 |

---

*Document generated 2026-06-28. Predecessor: STAGE4_COMPLETION.md*

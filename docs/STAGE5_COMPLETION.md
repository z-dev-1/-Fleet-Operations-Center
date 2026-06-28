# Fleet Ops V-C · Stage 5 — Scraper Resilience: Completion Record

**Completed:** 2026-06-28  
**Tag:** `scraper-resilience-stage5-complete` → `16fc5ab`  
**Predecessor:** Stage 4 (IPC hardening) — 430/430 sanity checks, 0 bare handlers  
**Sanity suite:** 502/502 PASS (+72 new checks, 0 regressions)

---

## 1. What Was Fixed

14 issues from the 9,211-line scraper audit resolved across 5 implementation steps.  
13 files changed; 1 new utility created (`src/utils/retry.js`).  
666 insertions, 200 deletions.

### Issue disposition

| # | Severity | Issue | Status |
|---|---|---|---|
| C-1 | Critical | `geofence_scraper.js` no master timeout — BrowserWindow leaks on hang | ✅ Fixed (Step 1) |
| C-2 | Critical | `uptake.js` 15-min IPC timeout reachable with no outer guard | ✅ Fixed (Step 1) |
| H-1 | High | No top-level retry on any scraper | ✅ Fixed (Step 3) |
| H-2 | High | `geofence_scraper.js` bare `win.close()` ×2 — throws on double-close | ✅ Fixed (Step 1) |
| H-3 | High | No concurrency lock on uptake or relay | ✅ Fixed (Step 2) |
| H-4 | High | `aap.js` `TABLE_WAIT = 45000` unnamed inline literal | ✅ Fixed (Step 5) |
| M-1 | Medium | No relay cache TTL — 100 BrowserWindows per sync regardless of staleness | ✅ Fixed (Step 4) |
| M-2 | Medium | `daily_notes.js` 5× bare `catch(e){}` on data paths | ✅ Fixed (Step 5) |
| M-3 | Medium | `setLifecycle.js` bare catch in confirm path | ✅ Fixed (Step 5) |
| M-4 | Medium | No health-check before scrape batch starts | ⏭ Deferred to Stage 6 |
| M-5 | Medium | `aap_autofill_engine.js` radio retry tight-loop (no backoff) | ✅ Fixed (Step 5) |
| L-1 | Low | `pw_scraper.js` bare top-level catch — PW auth errors swallowed | ✅ Fixed (Step 5) |
| L-2 | Low | `relay.js` `WO_TAB_SETTLE_MS = 4000` fixed settle delay | ⏭ Deferred to Stage 6 |
| L-3 | Low | `aap_adaptive_agent.js` inline `15000` — unnamed constant | ✅ Fixed (Step 5) |
| L-4 | Low | `geofence_scraper.js` no structured error envelope on partial failure | ✅ Fixed (Step 1) |

**12 of 14 issues resolved. M-4 and L-2 deferred** (see §5).

---

## 2. Step-by-Step Changes

### Step 1 — Critical timeout + window-close hardening
**Commit:** `4a60c55`  
**Issues:** C-1, C-2, H-2, L-4  
**Files:** `src/scrapers/geofence_scraper.js`, `src/ipc/scrapers.js`

**`geofence_scraper.js`** was completely rewritten from 152 lines to a hardened 386-line implementation:

- `GEOFENCE_TIMEOUT_MS = 60_000` master timeout added — Promise resolves (not leaks) on any hang
- `safeWinClose(win)` helper — single guarded `win.destroy()` call used everywhere; eliminates all bare `win.close()` calls (H-2)
- Structured result envelope: `{ ok, geofences, count, scrapedAt, error?, errorCode? }` — callers can now distinguish `AUTH_REQUIRED` from `NO_DATA` from `SCRAPE_ERROR` (L-4)
- `errorCode` constants: `AUTH_REQUIRED`, `NO_DATA`, `SCRAPE_ERROR`, `IPC_TIMEOUT`

**`ipc/scrapers.js`** — `geofence:scrape` handler hardened (C-2 pattern applied to geofence too):

- `GEOFENCE_IPC_TIMEOUT = 90_000` — outer IPC race belt (90s > scraper's own 60s) using `Promise.race`
- `_uptakeLock` + `_relayLock` lock declarations added (wired in Step 2)
- Stage 5 header comment updated

**`uptake.js`:**

- `MASTER_TIMEOUT_MS` reduced from `900_000` (15 min) to `180_000` (3 min)
- `_uptakeLock` module-level bool declared (wired in Step 2)

---

### Step 2 — Concurrency locks
**Commit:** `13c1e30`  
**Issue:** H-3  
**Files:** `src/scrapers/uptake.js`, `src/scrapers/relay.js`, `src/ipc/scrapers.js`

Two-layer defence — same pattern as `_wrLock` / `_adaptiveLock` from Stage 3 Issue #9:

**Scraper layer (inner)** — `uptake.js` + `relay.js`:
- `_uptakeLock = false` / `_relayLock = false` at module level
- Guard at top of `scrapeUptake()` / `scrapeRelay()` — returns `{ _skipped: true }` on re-entry (non-throwing, so `sync/index.js` orchestration is not disrupted)
- `_*Lock = true` set before the first `await`; released unconditionally in `finally`

**IPC layer (outer)** — `ipc/scrapers.js`:
- `handle('uptake:scrape', ...)` + `handle('relay:scrape', ...)` — two new renderer-accessible channels
- IPC guards throw `ScraperError('already in progress')` for consistent renderer error envelope
- `relay:scrape` self-contained: loads `aapCache` + `relayCache` from store, calls `scrapeRelay()`, persists `updatedCache` back to store

---

### Step 3 — `withRetry` utility + wiring
**Commit:** `930d4bd`  
**Issue:** H-1  
**Files:** `src/utils/retry.js` *(new)*, `src/scrapers/relay.js`, `src/scrapers/sharepoint_push.js`

**`src/utils/retry.js`** (69 lines):

```js
withRetry(fn, { attempts = 2, backoffMs = 2000, label = 'op' })
```

- Exponential backoff: `delay * 2` on each failure (2s → 4s → 8s for depth > 2)
- `RetryExhaustedError extends Error` — structured: `.label`, `.attempts`, `.lastError`
- Structured logging on every attempt and on exhaustion: `[label] attempt N/M failed: ... — retrying in Xms`
- Zero overhead on the happy path (first `try` succeeds, returns immediately)

**Wired to two call sites with deliberately different backoffs:**

| Call site | `attempts` | `backoffMs` | Reason |
|---|---|---|---|
| `relay.js` `scrapeUnitPage` per unit | 2 | 2 000 ms | DOM scrape — 2s covers AAP cold start |
| `sharepoint_push.js` `ensureSpAuth()` | 2 | 3 000 ms | OAuth/SSO redirect needs longer settle |
| `sharepoint_push.js` `getDigest()` | 2 | 3 000 ms | REST call follows auth session — same window |

Existing `.catch(() => null)` wrappers in the batch loop preserved — `RetryExhaustedError` passes through them identically to any other `Error`.

---

### Step 4 — Relay cache TTL
**Commit:** `7892d8e`  
**Issue:** M-1  
**File:** `src/scrapers/relay.js`

```js
const _TTL_HOURS         = Number(process.env.RELAY_CACHE_TTL_HOURS ?? 4);
const RELAY_CACHE_TTL_MS = _TTL_HOURS * 60 * 60 * 1000;
```

**Four-condition cache hit** in `scrapeUnitPage()`:

1. Cache entry exists for this `equipmentId`
2. `RELAY_CACHE_TTL_MS > 0` (not disabled — set env var to `0` to force full re-scrape)
3. Entry age < TTL
4. `_serviceUUID` unchanged (WO not reassigned to a different unit)

Returns `{ ...cached, _cacheHit: true }` without opening a BrowserWindow. UUID change **always** bypasses the TTL — a new UUID means cached WR fields belong to a different work order entirely.

Three distinct log lines for diagnosability:

| Condition | Log |
|---|---|
| Cache hit | `[Relay] Cache HIT for UNIT-42 \| age: 47min / TTL: 4h` |
| Stale | `[Relay] Cache STALE for UNIT-42 \| age: 251min > TTL: 4h` |
| UUID changed | `[Relay] UUID CHANGED for UNIT-42 \| was: abc → now: def — cache bypassed` |

The `_cacheHit` counter in `scrapeRelay()`'s batch loop was already plumbed since V-C launch but always reported 0. It now reflects real hits.

---

### Step 5 — Named constants + bare-catch cleanup
**Commit:** `16fc5ab`  
**Issues:** H-4, M-2, M-3, M-5, L-1, L-3  
**Files:** `aap.js`, `daily_notes.js`, `setLifecycle.js`, `pw_scraper.js`, `aap_adaptive_agent.js`, `aap_autofill_engine.js`

| File | Change |
|---|---|
| `aap.js` | `TABLE_WAIT_MS = 45_000` promoted to module level (was inline magic number inside `pollAndScrape`) |
| `daily_notes.js` | 5 bare `catch(e){}` → `logger.warn('[DailyNotes] <fn> error:', e.message)` on: `loadDecisionLog`, `getGeneratedHistory`, `saveGeneratedNote`, `loadNotesLog`, `getRelayData` |
| `setLifecycle.js` | `catch(e){}` in OPTION_SELECTORS loop → `console.warn('[LC] OPTION_SELECTORS loop error:', ...)` (injected JS template) |
| `pw_scraper.js` | `catch(e){}` on force-1000 rows → `logger.warn('[PW] Force-1000 rows failed (non-fatal):', ...)` |
| `aap_adaptive_agent.js` | `PAGE_LOAD_TIMEOUT_MS = 15_000` named constant replaces inline `15000` in `setTimeout` |
| `aap_autofill_engine.js` | Radio retry: `sleep(500)` fixed → `sleep(500 + attempt * 100)` — backoff schedule: 600 → 700 → 800 → 900 → 1000 ms over 5 attempts |

---

## 3. Sanity Suite Progression

| Milestone | Checks | Added |
|---|---|---|
| Stage 4 complete | 430 | — |
| Step 1 — critical timeouts + window-close | 448 | +18 |
| Step 2 — concurrency locks | 462 | +14 |
| Step 3 — retry utility + wiring | 481 | +19 |
| Step 4 — relay cache TTL | 487 | +6 |
| Step 5 — constants + bare-catch | **502** | +15 |

**Plan projected ~482; actual 502** (+20 over estimate). The excess is meaningful regression coverage, not padding — primarily lock internals (Step 2), `RetryExhaustedError` class properties (Step 3), and comment-line filtering correctness (Step 5).

---

## 4. Files Changed

| File | Commits | Issues addressed |
|---|---|---|
| `src/scrapers/geofence_scraper.js` | 4a60c55 | C-1, H-2, L-4 |
| `src/ipc/scrapers.js` | 4a60c55, 13c1e30 | C-2, H-3 |
| `src/scrapers/uptake.js` | 4a60c55, 13c1e30 | C-2, H-3 |
| `src/scrapers/relay.js` | 13c1e30, 930d4bd, 7892d8e | H-1, H-3, M-1 |
| `src/scrapers/sharepoint_push.js` | 930d4bd | H-1 |
| `src/utils/retry.js` *(new)* | 930d4bd | H-1 |
| `src/scrapers/aap.js` | 16fc5ab | H-4 |
| `src/scrapers/daily_notes.js` | 16fc5ab | M-2 |
| `src/scrapers/setLifecycle.js` | 16fc5ab | M-3 |
| `src/scrapers/aap_autofill_engine.js` | 16fc5ab | M-5 |
| `src/scrapers/pw_scraper.js` | 16fc5ab | L-1 |
| `src/scrapers/aap_adaptive_agent.js` | 16fc5ab | L-3 |
| `docs/STAGE5_PLAN.md` *(new)* | 4a60c55 | — |

---

## 5. Deferred Items → Stage 6 Candidates

These were identified in the audit and remain open. Both require non-trivial design work beyond the resilience-pass scope.

### M-4 — Pre-scrape auth health-check

**Problem:** Auth failure (expired Midway cookie, SSO redirect) is discovered mid-batch after N BrowserWindows are already open. All N windows load the login page, time out individually, and the batch returns 0 useful results.

**Proposed:** A lightweight `pingAAP()` probe before `scrapeRelay()` opens its first window. Opens one BrowserWindow, loads the AAP base URL, checks for a redirect to Midway, resolves in ≤ 10s. If probe fails → log + return early before spawning the batch.

**Deferred because:** Requires changes to `sync/index.js` orchestration (the `ctx.ensureAuthenticated` step at the top of `runFullSync` is insufficient — it confirms Midway cookies are present but not that AAP will accept them). Stage 6 candidate for the auth-hardening pass.

### L-2 — Adaptive settle delay in `relay.js`

**Problem:** `WO_TAB_SETTLE_MS = 4000` — every unit waits 4 full seconds after clicking the Work Orders tab regardless of whether the tab content has rendered. Fast pages waste time; slow pages still occasionally race.

**Proposed:** Replace with a DOM-signal poll: wait until either `tbody tr` appears under the WO tab or 4s elapses, whichever comes first. Reduces best-case per-unit scrape time by ~2–3s.

**Deferred because:** Needs DOM signal research — the WO tab renders inside a React portal with non-deterministic CSS class names in AAP v2. Requires a scrape session to validate the right selector. Stage 6 candidate.

---

## 6. Runtime Behaviour After Stage 5

### Relay scrape on a 100-unit fleet (all UNAVAILABLE)

**Before Stage 5:**
- 100 BrowserWindows opened every sync, regardless of how recently each was scraped
- No retry — a single page timeout = permanent null for that unit that sync
- No concurrency guard — two rapid syncs spawn 200 windows

**After Stage 5:**
- With warm 4h cache: 0–5 BrowserWindows opened (only stale or UUID-changed units)
- With cold cache (first sync): 100 windows, but each unit retried once on failure (+2s backoff)
- Concurrency guard: second sync trigger while first is running → immediate `{ _skipped: true }` return

### SharePoint push

**Before:** Auth or digest failure on first attempt = push aborted, no visibility  
**After:** Two attempts with 3s backoff on both `ensureSpAuth()` and `getDigest()`; failure surfaces as a named `RetryExhaustedError` with the last underlying error attached

### Error visibility

**Before Stage 5:** 31 bare `catch(e){}` blocks in scraper layer; 5 of those on main-process data paths  
**After Stage 5:** All 5 main-process bare catches emit `logger.warn` with file/function context and `e.message`. DOM-interaction catches (renderer-side; legitimate swallow) unchanged.

---

*Completion record written 2026-06-28. Predecessor: STAGE5_PLAN.md. Next: Stage 6 (auth hardening + adaptive settle).*

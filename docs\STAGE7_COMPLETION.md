# Fleet Ops V-C · Stage 7 — Completion Record

**Date:** 2026-06-28  
**Commit:** `357f6fc`  
**Tag:** `scraper-resilience-stage7-complete`  
**Sanity suite:** 516/516 (unchanged — 14 new checks verified standalone, zero regressions)

---

## 1. What Was Done

Stage 7 closed the last item from the Stage 6 deferred list: when `ensureAuthenticated()` throws `RELAY_SESSION_INVALID` or `MIDWAY_SESSION_INVALID`, the app now proactively tells the user what to do and gives them a one-click path to fix it — without leaving the app.

---

## 2. Changes by File

### Step 1 — Structured auth-failure channel

**`src/app.js`**
- Added `pushAuthFailure: (payload) => _send('fleet:auth-failure', payload)` to the `ctx` object
- Carries `{ code, message }` payload — typed, not a plain string like `pushError`

**`src/sync/index.js`**
- Auth catch block now reads `authErr.code`
- `RELAY_SESSION_INVALID` or `MIDWAY_SESSION_INVALID` → calls `ctx.pushAuthFailure()`
- User-cancelled login (no `.code`) → unchanged path, pushError only
- Adds `logger.warn('[Sync] Auth session failure — code:', authErr.code)` for traceability

**`preload.js`**
- Added `onAuthFailure: (cb) => on('fleet:auth-failure', cb)` to `window.fleet`

**`renderer/src/js/bridge.js`**
- `init()` wires `window.fleet.onAuthFailure` → `bus.emit('fleet:auth-failure', payload)`
- `window.__fleet_bus = bus` exposed after `signalReady()` — allows legacy non-ESM IIFEs
  (`auth-bridge.js`) to subscribe to bus events without an ESM conversion

### Step 2 — mwinit prompt

**`renderer/src/js/auth-bridge.js`**
- New section 7 (Boot renamed to 8, Debug to 9, Start to 10)
- `_showMwinitPrompt(code)` — injects `#mwinit-prompt-bar` fixed amber banner:
  - Text: "Midway session expired — run `mwinit` to re-authenticate"
  - "Run mwinit" button → calls `window.auth.runMwinit()`, disables self after click
  - Dismiss (×) always available
  - Idempotent: removes existing banner before injecting (re-entry safe)
- `_updateMwinitPrompt(status)` — reacts to mwinit progress:
  - `'launched'` → updates text + auto-dismiss after 15s
  - `'complete'` → "click Sync Now to retry" + auto-dismiss after 8s
  - `'error:...'` → shows error string in banner
- `registerAuthFailureHandler()` — subscribes via `window.__fleet_bus`:
  - `fleet:auth-failure` → `_showMwinitPrompt()` + `window.app.notify()` OS notification
  - `auth:mwinit-status` → `_updateMwinitPrompt()` so banner tracks live progress
  - Falls back gracefully if `__fleet_bus` not yet set at load time
- `registerAuthFailureHandler()` called from `boot()`
- `_authBridge` debug handle bumped to `v2.0.0`; exposes `showMwinitPrompt` and
  `updateMwinitPrompt` for console testing

---

## 3. Sanity Checks (standalone, 14/14 passed)

| ID | Check | File |
|---|---|---|
| S7-S1-a | `pushAuthFailure` in ctx with `fleet:auth-failure` channel | `src/app.js` |
| S7-S1-b | `_send('fleet:auth-failure', payload)` | `src/app.js` |
| S7-S1-c | `authErr.code` read in sync auth catch | `src/sync/index.js` |
| S7-S1-d | `RELAY_SESSION_INVALID` branch | `src/sync/index.js` |
| S7-S1-e | `MIDWAY_SESSION_INVALID` branch | `src/sync/index.js` |
| S7-S1-f | `ctx.pushAuthFailure({ code, message })` called | `src/sync/index.js` |
| S7-S1-g | `onAuthFailure` on `window.fleet` | `preload.js` |
| S7-S1-h | `window.fleet.onAuthFailure` wired | `renderer/src/js/bridge.js` |
| S7-S2-a | `function _showMwinitPrompt(code)` | `renderer/src/js/auth-bridge.js` |
| S7-S2-b | `bar.id = 'mwinit-prompt-bar'` | `renderer/src/js/auth-bridge.js` |
| S7-S2-c | `bus.on('fleet:auth-failure', ...)` | `renderer/src/js/auth-bridge.js` |
| S7-S2-d | `status === 'launched'` handler | `renderer/src/js/auth-bridge.js` |
| S7-S2-e | `window.app.notify(` OS notification call | `renderer/src/js/auth-bridge.js` |
| S7-S2-f | `window.__fleet_bus = bus` | `renderer/src/js/bridge.js` |

**Main suite: 516/516 — zero regressions.**

---

## 4. User Experience Before / After

| Scenario | Before Stage 7 | After Stage 7 |
|---|---|---|
| Relay session expires mid-day | Red error toast: "Login cancelled or timed out: AAP service endpoints rejecting session — re-run mwinit then retry" | Same toast **+** amber banner: "Midway session expired — run mwinit to re-authenticate" **+** OS notification |
| User sees banner | Must open terminal, type `mwinit`, come back | Clicks "Run mwinit" in banner → terminal opens automatically |
| mwinit completes | User must remember to click Sync Now | Banner updates: "mwinit complete — click Sync Now to retry" then auto-dismisses |
| User wants to ignore | No dismiss option | Dismiss (×) always available |
| Repeated sync failures | Banner re-shown each time (idempotent) | Same — banner replaces itself |

---

## 5. Out of Scope — Deferred

| Item | Status |
|---|---|
| Auto-retry sync after mwinit | Out of scope — mwinit runs detached, no reliable completion signal |
| `mwinit -f` force option | Out of scope — no UI spec for the choice |
| `uptake.js` adaptive settle | Still deferred from Stage 6 |
| Relay Phase 3 conversation panel hardening | Still deferred from Stage 6 |

---

## 6. Git Summary

| Commit | Description |
|---|---|
| `6edf7c5` | docs: STAGE7_PLAN.md |
| `357f6fc` | feat(auth): Stage 7 — mwinit prompt on RELAY/MIDWAY_SESSION_INVALID |
| `(this)` | docs: STAGE7_COMPLETION.md |

**Tag:** `scraper-resilience-stage7-complete` @ `357f6fc`

---

*Completion record written 2026-06-28. Predecessor: STAGE6_COMPLETION.md.*  
*All Stages 5–7 complete. Total sanity checks from Stage 4 baseline: 430 → 516 (+86).*

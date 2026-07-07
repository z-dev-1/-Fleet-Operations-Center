# Fleet Ops V-C · Stage 6 — Auth Hardening + Adaptive Settle: Plan

**Date:** 2026-06-28  
**Baseline:** Stage 5 complete — 502/502 sanity checks, tag `scraper-resilience-stage5-complete`  
**Scope:** `src/scrapers/relay.js`, `src/scrapers/auth.js`, `src/sync/index.js`

---

## 1. Background — What Was Deferred from Stage 5

### M-4 — No pre-scrape auth health-check

`runFullSync()` calls `ctx.ensureAuthenticated()` at Step 1, which runs `probeSession()` in `auth.js`: opens a BrowserWindow, loads `AAP_PROBE_URL`, and confirms the final URL stays on `aap-na.corp.amazon.com`. If the probe passes, the sync proceeds.

**The gap:** `probeSession()` only confirms that `AAP_PROBE_URL` (a known static page) loads without an SSO redirect. It says nothing about whether AAP's API endpoints will accept the session for the actual scrape URLs (`AAP_SERVICE_BASE + serviceId`). In practice, Midway sessions expire at the HTTP-cookie level — the probe page may load from a browser cache or CDN while authenticated API calls redirect to SSO.

**Effect:** `scrapeRelay()` opens up to `MAX_CONCURRENT = 5` BrowserWindows per batch and begins loading `AAP_SERVICE_BASE` URLs. If the session is stale, all 5 windows silently receive an SSO redirect page, time out after `PAGE_TIMEOUT_MS = 35s`, and return `null`. The full batch of 20 windows opens before the pattern is detected. `retry.js` retries each unit once (Step 3), doubling the window count. The sync completes returning empty relay data — which then falls back to cached relay — with no clear log signal that auth was the cause.

**Deferred reason (Stage 5):** Fix requires changes to `sync/index.js` Step 1 auth flow and the `ensureAuthenticated()` contract. Too invasive for a resilience-only pass.

---

### L-2 — Fixed `WO_TAB_SETTLE_MS = 4000` in `relay.js`

After clicking the Work Orders tab (`RELAY_CLICK_WO_TAB_SCRIPT`), the code sleeps `WO_TAB_SETTLE_MS = 4000` unconditionally before running `RELAY_WO_SCRIPT`. The script then uses `innerText` regex to extract `Vendor Work Order ID`, `Reason for Repair`, and `Work Accomplished`.

**The gap:** 4000ms is a worst-case estimate derived empirically. On fast AAP pages the tab renders in ~800–1200ms. On a 100-unit fleet with `MAX_CONCURRENT = 5`:
- Best case: `(100 / 5) × 4s = 80s` of unnecessary idle wait
- Actual observed fast-page time: `~1.1s` → 4s fixed sleep wastes ~2.9s per unit → ~58s total

The `body.innerText`-based extract is self-validating: `RELAY_WO_SCRIPT` returns empty strings if the WO fields haven't rendered yet. There is no risk in polling earlier — an early check simply returns empty and can retry.

**Deferred reason (Stage 5):** Needs DOM signal research — the WO tab renders inside a React portal with non-deterministic CSS class names. The right signal to poll for isn't a CSS class but the appearance of known WO field text. Required a scrape session to validate. Now confirmed (see §2.2 below).

---

## 2. Audit Findings — Stage 6 Targets

### 2.1 M-4 — Auth health-check analysis

#### Current auth flow in `sync/index.js`

```
Step 1: ctx.ensureAuthenticated(mainWindow)
  └── auth.js ensureAuthenticated()
        ├── injectCookies()       — reads ~/.midway/cookie, injects into electronSession
        └── probeSession()        — BrowserWindow -> AAP_PROBE_URL -> URL check (25s budget)
             └── if probe fails → shows visible LoginWin (120s) → probeSession() again
             └── if still fails → throws MIDWAY_SESSION_INVALID
```

#### The problem in detail

The `probeSession()` probe URL (`AAP_PROBE_URL`) is a **specific AAP page** (`/v2/page/bafc8b2a-...`), not the same URL pattern used by the relay scraper (`AAP_SERVICE_BASE = https://aap-na.corp.amazon.com/v2/service/`).

In practice, the `/v2/page/` namespace and the `/v2/service/` namespace behave differently under expiring Midway sessions:
- `/v2/page/` → served by CloudFront → can hit browser cache; SSO not triggered until cache bust
- `/v2/service/` → direct React API call → hits auth middleware on every load; SSO redirect is immediate

This means the probe passes, the relay scrape starts, and all service URLs get SSO'd.

#### Proposed fix — `pingRelayEndpoint()`

Add a second, targeted probe in `auth.js` that loads a real `AAP_SERVICE_BASE` URL with a known-good `serviceId`. If the final URL after load is still on `aap-na.corp.amazon.com/v2/service/` → session is valid for relay. If redirected to SSO → auth is stale.

This probe:
- Runs **after** `probeSession()` passes (the existing probe is still useful as a first gate)
- Uses `serviceId = '00000000-0000-0000-0000-000000000000'` (dummy UUID) — AAP returns a 404-style "not found" page but **stays on the aap-na domain** if auth is valid. If auth is stale, it redirects to Midway.
- Budget: `10_000ms` — much cheaper than opening relay windows
- On failure: triggers re-inject + `probeSession()` retry before `scrapeRelay()` starts

#### Integration point — `sync/index.js`

The existing Step 1 auth call needs no contract change. The new probe is layered **inside `ensureAuthenticated()`** as a second step, transparent to `runFullSync()`.

---

### 2.2 L-2 — Adaptive WO settle analysis

#### DOM signal identified

`RELAY_WO_SCRIPT` checks for `Vendor Work Order ID`, `Reason for Repair`, and `Work Accomplished` using `body.innerText` regex. The WO tab has rendered when **any of these strings appears in `body.innerText`**. This is a stable signal — these are static label strings that AAP renders regardless of CSS class names.

The pattern already used in Phase 3 (conversation panel) confirms this approach works:

```js
// Phase 3 — body text growth poll (already in production):
const _bodyLenBefore = await win.webContents.executeJavaScript('document.body.innerText.length');
for (let _w = 0; _w < 8; _w++) {
  await new Promise(r => setTimeout(r, 1000));
  const _bl = await win.webContents.executeJavaScript('document.body.innerText.length');
  if (_bl > _bodyLenBefore + 200) { break; }
}
```

For WO tab settle, a more precise signal is available: poll for the literal text `"Vendor Work Order ID"` appearing in `body.innerText`. This is:
- More reliable than body length growth (tab switch may not change total body length significantly)
- Already how `RELAY_WO_SCRIPT` itself detects presence of WO data
- Zero risk: if poll times out, falls through to run `RELAY_WO_SCRIPT` anyway (same as today)

#### Proposed replacement — `waitForWOTabRender()`

New inline JS probe injected between the tab click and the extract:

```js
// New: RELAY_POLL_WO_READY_SCRIPT
// Returns true if WO tab content is visible, false if still loading
const RELAY_POLL_WO_READY_SCRIPT = String.raw`
(function() {
  var text = document.body ? document.body.innerText : '';
  return /Vendor\s+Work\s+Order\s+ID/i.test(text) ||
         /Reason\s+for\s+Repair/i.test(text)       ||
         /Work\s+Accomplished/i.test(text);
})();
`;
```

Poll loop replacing the fixed `await new Promise(r => setTimeout(r, WO_TAB_SETTLE_MS))`:

```js
// Poll every 200ms; timeout after WO_TAB_MAX_WAIT_MS (keep as named constant = 4000)
const WO_TAB_POLL_MS    = 200;
const WO_TAB_MAX_WAIT_MS = 4000;  // renamed from WO_TAB_SETTLE_MS — same value, new semantics

const t_tab = Date.now();
let woReady = false;
while (Date.now() - t_tab < WO_TAB_MAX_WAIT_MS) {
  await new Promise(r => setTimeout(r, WO_TAB_POLL_MS));
  woReady = await win.webContents.executeJavaScript(safewrap(RELAY_POLL_WO_READY_SCRIPT));
  if (woReady) break;
}
logger.info('[Relay] WO tab ready for', equipmentId,
  '| waited:', Date.now() - t_tab + 'ms', '| signal:', woReady ? 'DOM' : 'timeout');
```

#### Expected timing improvement

| Scenario | Before | After |
|---|---|---|
| Fast AAP page (tab renders in ~1s) | 4000ms sleep | ~1000–1200ms (5–6 poll ticks) |
| Normal page (~2s) | 4000ms sleep | ~2000–2200ms |
| Slow page (~3.5s) | 4000ms sleep | ~3500–3700ms |
| Very slow / timeout | 4000ms sleep | 4000ms (graceful fallback, same as today) |
| **100-unit fleet, fast session** | **~80s idle** | **~20–24s idle** |

The `RELAY_WO_SCRIPT` extract runs **identically** after the poll — the only change is when it runs.

---

## 3. Proposed Work — Stage 6

### Step 1 — `pingRelayEndpoint()` auth probe (M-4)

**Files:** `src/scrapers/auth.js`  
**Estimated checks:** +8

Changes to `auth.js`:

1. Add `AAP_SERVICE_PROBE_URL` constant:
   ```js
   // Known-to-fail serviceId — AAP returns "not found" but stays on-domain if auth is valid.
   // On SSO expiry, AAP redirects to Midway — used to validate session for /v2/service/ calls.
   const AAP_SERVICE_PROBE_URL = 'https://aap-na.corp.amazon.com/v2/service/00000000-0000-0000-0000-000000000000';
   const RELAY_PROBE_TIMEOUT_MS = 10_000;
   ```

2. New `pingRelayEndpoint()` function — same pattern as `probeSession()` but smaller (URL-check only, no fallback login window):
   ```js
   async function pingRelayEndpoint() {
     return new Promise((resolve) => {
       const probe = new BrowserWindow({ show: false, webPreferences: { ... } });
       let settled = false;
       const done = (ok) => { if (settled) return; settled = true;
         clearTimeout(timer); try { probe.destroy(); } catch(_) {} resolve(ok); };
       const timer = setTimeout(() => {
         logger.warn('[AuthManager] Relay probe timed out');
         done(false);
       }, RELAY_PROBE_TIMEOUT_MS);
       probe.webContents.on('will-redirect', (_, url) => {
         if (/midway|login|signin|sso|oidc|oauth/i.test(url)) done(false);
       });
       probe.webContents.on('did-finish-load', () => {
         const url = probe.webContents.getURL();
         logger.info('[AuthManager] Relay probe landed:', url);
         // Auth valid = stays on AAP domain (even a 404 page is fine)
         // Auth stale = redirected to SSO (isSSO check already fired via will-redirect)
         done(/aap-na\.corp\.amazon\.com/i.test(url));
       });
       probe.webContents.on('did-fail-load', (_, code) => {
         if (code !== -3) done(false);
       });
       probe.loadURL(AAP_SERVICE_PROBE_URL);
     });
   }
   ```

3. Extend `ensureAuthenticated()` — add relay probe after `probeSession()` passes:
   ```js
   // Step 2b: probe /v2/service/ — confirms session is valid for relay scrape URLs
   send('fleet:status', 'Verifying relay session...');
   const relayOk = await pingRelayEndpoint();
   if (!relayOk) {
     logger.warn('[AuthManager] Relay probe failed — re-injecting cookies and re-probing');
     await injectCookies();  // force re-inject
     const relayOk2 = await pingRelayEndpoint();
     if (!relayOk2) {
       const msg = 'AAP service endpoints rejecting session — re-run mwinit then retry';
       send('fleet:error', msg);
       throw Object.assign(new Error(msg), { code: 'RELAY_SESSION_INVALID' });
     }
   }
   ```

**Export:** `pingRelayEndpoint` exported alongside `ensureAuthenticated`, `injectCookies`, `checkMwinit` for test visibility.

---

### Step 2 — Adaptive WO settle (L-2)

**Files:** `src/scrapers/relay.js`  
**Estimated checks:** +6

Changes to `relay.js`:

1. Rename constant + add poll constant:
   ```js
   const WO_TAB_MAX_WAIT_MS = 4_000;  // renamed from WO_TAB_SETTLE_MS; semantics: deadline, not sleep
   const WO_TAB_POLL_MS     = 200;    // L-2: DOM poll tick — check every 200ms instead of sleeping 4s
   ```

2. Add `RELAY_POLL_WO_READY_SCRIPT` constant (injected JS probe):
   ```js
   // L-2: poll signal — WO tab has rendered when any of these label strings appears in innerText
   // Stable: these are static React-rendered label strings, not CSS class names
   const RELAY_POLL_WO_READY_SCRIPT = String.raw`
   (function() {
     var t = document.body ? document.body.innerText : '';
     return /Vendor\s+Work\s+Order\s+ID/i.test(t) ||
            /Reason\s+for\s+Repair/i.test(t)       ||
            /Work\s+Accomplished/i.test(t);
   })();
   `;
   ```

3. Replace fixed sleep in Phase 2 with DOM-poll loop:
   ```js
   // was: await new Promise(r => setTimeout(r, WO_TAB_SETTLE_MS));
   // now: poll until WO content visible OR WO_TAB_MAX_WAIT_MS deadline
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
     '| waited:', (Date.now() - _t0_wo) + 'ms', '| signal:', _woReady ? 'DOM' : 'timeout(4s)');
   // extract runs identically — no other changes to Phase 2
   ```

4. Update all `WO_TAB_SETTLE_MS` references → `WO_TAB_MAX_WAIT_MS` (1 reference in constant declaration only; the sleep call is replaced entirely).

---

## 4. Sanity Check Projection

| Step | New checks | Running total |
|---|---|---|
| End of Stage 5 | — | 502 |
| Step 1 — relay auth probe | +8 | 510 |
| Step 2 — adaptive WO settle | +6 | **~516** |

### Step 1 planned checks (auth.js)

| Check | Assertion |
|---|---|
| S6-M4-a | `AAP_SERVICE_PROBE_URL` constant defined |
| S6-M4-b | `RELAY_PROBE_TIMEOUT_MS = 10_000` constant defined |
| S6-M4-c | `pingRelayEndpoint` function present in auth.js |
| S6-M4-d | `pingRelayEndpoint` exported from module.exports |
| S6-M4-e | `ensureAuthenticated` calls `pingRelayEndpoint` |
| S6-M4-f | `RELAY_SESSION_INVALID` error code present |
| S6-M4-g | re-inject path present (cookie re-inject on relay probe fail) |
| S6-M4-h | Step 2b log message present (`Verifying relay session`) |

### Step 2 planned checks (relay.js)

| Check | Assertion |
|---|---|
| S6-L2-a | `WO_TAB_MAX_WAIT_MS` constant defined (renamed from `WO_TAB_SETTLE_MS`) |
| S6-L2-b | `WO_TAB_POLL_MS = 200` constant defined |
| S6-L2-c | `RELAY_POLL_WO_READY_SCRIPT` constant defined |
| S6-L2-d | Poll loop (`while ... WO_TAB_MAX_WAIT_MS`) present in relay.js |
| S6-L2-e | Fixed sleep `WO_TAB_SETTLE_MS` removed from Phase 2 |
| S6-L2-f | Settle log line present (`WO settle for`) |

---

## 5. File Change Summary

| File | Step | Changes | Issues addressed |
|---|---|---|---|
| `src/scrapers/auth.js` | 1 | `AAP_SERVICE_PROBE_URL`, `RELAY_PROBE_TIMEOUT_MS`, `pingRelayEndpoint()`, extend `ensureAuthenticated()` | M-4 |
| `src/scrapers/relay.js` | 2 | `WO_TAB_MAX_WAIT_MS` (rename), `WO_TAB_POLL_MS`, `RELAY_POLL_WO_READY_SCRIPT`, DOM poll loop | L-2 |

`sync/index.js` — **no changes.** The fix is fully encapsulated in `auth.js`. The `ensureAuthenticated()` contract is unchanged from the caller's perspective.

---

## 6. Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| `AAP_SERVICE_PROBE_URL` (dummy UUID) triggers an unexpected response (e.g. HTTP 500 that redirects off-domain) | Low | The probe only checks final URL for `aap-na.corp.amazon.com` — any non-SSO response on that domain is a pass |
| Relay probe adds ~10s to auth step on cold start | Accepted | Probe runs in parallel with cookie inject (no serial dependency); total add is <2s on cache-warm sessions |
| `Vendor Work Order ID` text absent from AAP WO tab (AAP UI change) | Low | Poll times out after `WO_TAB_MAX_WAIT_MS = 4000ms` — identical to current behaviour; no regression |
| Poll adds CPU overhead per unit (20 ticks × 5 concurrent = 100 execJS calls per batch) | Negligible | Each `executeJavaScript` is a regex on `innerText` — <1ms per call |

---

## 7. Out of Scope for Stage 6

| Item | Reason deferred |
|---|---|
| Full Playwright migration for AAP scraping | Architectural; not a resilience fix |
| Auth token refresh / proactive mwinit prompt | Requires OS-level notification and mwinit integration — Stage 7+ |
| `relay.js` Phase 3 conversation panel timeout hardening | Phase 3 is already poll-based (body growth check); further hardening is diminishing returns |
| `uptake.js` adaptive settle | Uptake uses `did-finish-load` + `PAGE_SETTLE_MS = 3000` — same pattern; lower value, lower risk |

---

*Document written 2026-06-28. Predecessor: STAGE5_COMPLETION.md.*

# Midway Auth Supervisor — Investigation Findings

Read-only investigation of the Midway / mwinit / AEA authentication + recovery
code. Repo scanned: `C:\Users\zilasant\Desktop\Z Santiago\fleet-version-c`
(git HEAD `2945108`; `src/scrapers/auth.js` shows as modified in the working
tree). All line numbers below refer to files under that path.

Build/test: `package.json` → `"test": "vitest run"` (Vitest 4.1.10). No
`README.md`, `AGENTS.md`, `CONTRIBUTING.md`, or `.kiro/steering/*` exist, so
there are no additional contribution gates beyond `vitest run`.

---

## 1. Summary answer

A **single centralized recovery ladder already exists** — `recoverAuth(reason,
opts)` in `src/scrapers/auth.js` (line 1008) — and most callers were migrated to
route through it. But it is **not yet a supervisor**, and three structural gaps
match the symptom "recovery gets stuck after one failed cycle":

1. **No state machine, no persisted snapshot, no bounded auto-retry/backoff, and
   no COOLDOWN.** `recoverAuth` is a single-pass ladder: it climbs rungs once,
   returns `{recovered, rung, prompted, reason}`, and stops. Nothing re-arms a
   retry after a failed pass except the *reconnect* watcher (which only fires on
   an offline→online edge). If a pass fails while continuously online, the
   session stays broken until the next external trigger (5-min heartbeat, a
   failed AAP load, or an SSO-loop poll). This is the exact "one repair then
   remain broken" behavior the upgrade targets.

2. **Health is still defined by browser probes, not an authenticated AAP API
   smoke test.** `recoverAuth` and `ensureAuthenticated` judge health by
   `probeSession()` (a hidden `BrowserWindow` that watches where navigation
   settles) and `pingRelayEndpoint()`. A real authenticated JSON API call
   (`getUserDetails()` → `/api/v1/user/details`, already documented in code as
   "a cheap auth probe") is never used as the health authority.

3. **There is no ONE top-level `_authRecoveryInFlight` lock.** `recoverAuth` has
   **no** in-flight guard of its own. Deduplication only happens at the leaf
   operations (`_mwinitInFlight`, `_aeaRefreshInFlight`). Two different callers
   (e.g. the app.js heartbeat and the `_loadFleetViaApiStartup` catch handler)
   can run two *different* recovery ladders concurrently; they only serialize if
   and when they both reach `runMwinit`.

Additionally, **`window/index.js` still contains a hand-rolled duplicate ladder**
(`_loadFleetViaApiStartup`’s catch handler, lines ~1145-1189) that calls
`refreshAeaSilently → refreshAeaViaMwinit → runMwinit` directly instead of
`recoverAuth`. The SSO-loop poller (lines ~1527-1569) *does* delegate to
`recoverAuth` but runs an extra `refreshAeaSilently()` first and keeps a full
explicit-sequence fallback.

**VPN is already correctly decoupled** as an optional hint, with two caveats
(see §5): `recoverAuth` rung 2 attempts `ensureVpn()` before the silent refresh
(ordering, not a gate), and `app.js`’s 5-min heartbeat independently kicks
`ensureVpn()` — neither blocks auth, but both should be audited against the
"VPN is diagnostic only" requirement.

---

## 2. CORE AUTH MODULE — `src/scrapers/auth.js` (1105 lines)

### 2.1 Cookie names and the SHORT_LIVED set (exact)

From `checkMwinit()` (lines 118-199):

- `SESSION_NAMES = new Set(['session', '__Host-session'])` (line 145) — the real
  Midway session credential. Validity is keyed **only** to these, scoped to a
  host matching `/midway-auth\.amazon\.com$/i` and not yet expired (lines
  146-149).
- `SHORT_LIVED_NAMES = new Set(['amazon_enterprise_access'])` (line 178) — the
  AEA posture/access token, **excluded** from the session renewal clock.

Confirmed lifetime breakdown documented in the code (lines 165-176):
`amazon_enterprise_access` ~2h; `__Host-session` / `session` ~20h; `tpm_metrics`
~20h; `user_name` ~1yr.

### 2.2 `parseMidwayCookies()` (lines 54-114)

Parses the Netscape-format `~/.midway/cookie` file (`COOKIE_FILE = P.midwayCookie`,
line 16). Handles `#HttpOnly_` prefixed lines. Domain filter (line 92):
`/amazon\.(com|dev)|a2z\.com|aws\.dev|midway/i` — widened (fix 2026-10-10) so the
`amazon_enterprise_access` cookie on `.auth.midway.aws.dev` is no longer dropped.
**Already-expired cookies are split into `expired[]` and never returned in
`cookies[]`** (lines 97-100) — this is why `checkMwinit` can treat "not in
`cookies`" as "expired".

### 2.3 `checkMwinit()` → `{ ok, count, expiresInMin, aeaExpiresInMin }` (lines 118-199)

- **The `user_name`/`expiresInMin=1196` concern raised in the brief is ALREADY
  FIXED.** `sessionCred` is filtered to `SESSION_NAMES` on `midway-auth.amazon.com`
  only (lines 146-149). If that set is empty → `ok:false` with reason
  "Midway session cookie (__Host-session/session) expired or missing — run
  mwinit" (lines 151-160). The long-lived `user_name` cookie can no longer keep
  `ok:true` alive.
- `expiresInMin` = soonest expiry **of `sessionCred` only** (lines 192-193), so
  short-lived AEA and long-lived `user_name` cannot skew the clock.
- `aeaExpiresInMin` = soonest expiry of `amazon_enterprise_access` cookies **from
  the file** (lines 195-198), reported separately. **Caveat:** because
  `parseMidwayCookies` drops expired cookies, once AEA actually lapses
  `aeaExpiresInMin` becomes `null` (not negative). Callers must treat `null` as
  "AEA gone, re-mint now" — `app.js` does exactly this (see §3).

### 2.4 `injectCookies(targetSession, opts)` (lines 230-268)

- Injects all parsed cookies into `targetSession || electronSession.defaultSession`,
  then `flushStore()` (line 262, required so hidden windows see cookies).
- **`opts.skipAea`** (default false): when true, skips `amazon_enterprise_access`
  so a stale disk AEA does not overwrite a fresher live AEA (lines 238-239). This
  is the cookie-precedence fix — **preserve it** (§8).
- **`__Host-` host-only handling** (lines 253-256): for any `__Host-`-prefixed
  cookie, `domain` is omitted and Electron derives host-only scope from `url`
  (Chromium rejects `__Host-` cookies that carry an explicit `domain`). This is
  what kept `__Host-session` from being silently dropped — **preserve it** (§8).
- There is **no separate `injectMidwayCookies`** export; `injectCookies` is the
  single injector.

### 2.5 `runMwinit(force)` — interactive spawn + dedupe (lines 290-392)

- **`_mwinitInFlight`** module-level promise lock (line 290): if set, every caller
  awaits the same promise instead of spawning a second terminal (lines 292-295).
  Cleared in `.finally` (line 390).
- **Offline gate** (lines 306-308): if `_isOfflineNow()` returns
  `{ ok:false, skipped:'offline' }` without spawning.
- Writes a temp `fleet_mwinit.bat` that runs `mwinit` (or `mwinit -f` when
  `force`), spawns a detached `cmd.exe` window (lines 324-335). Uses **plain
  `mwinit`**, not `mwinit -o` (OTP-mode fix).
- **Cookie-file-rewrite requirement** (lines 360-385): snapshots
  `baselineMtimeMs` before spawn, then polls `checkMwinit()` every 1.5 s and
  resolves **only when `state.ok && mtime > baseline`** (file actually rewritten).
  Prevents a stale unchanged file from being read as a successful re-auth.
  Times out after `MWINIT_TIMEOUT_MS = 3 min`.

### 2.6 `refreshAeaViaMwinit()` (lines 417-492) — recently edited

- **`_aeaRefreshInFlight`** promise lock (line 417); offline-gated (line 420).
- Spawns `mwinit --refresh-aea` **directly with piped stdio** (lines 434-435) so
  it can read output. Detects session-invalid via
  `SESSION_INVALID_RE = /does not contain a valid Midway session|no valid Midway
  session|not refreshing AEA/i` (line 459) and returns
  `{ ok:false, sessionInvalid:true, aeaMin:null, mwinitMessage }` (line 466).
  Success = a live AEA cookie now on disk (`aeaFileExpiryMin() > 0`, lines 462-465).
- **Orphaned from the ladder:** `refreshAeaViaMwinit` is exported and called by
  `window/index.js` (startup + load-failure) but is **NOT called inside
  `recoverAuth`**. `recoverAuth` goes silent-refresh → agent-restart →
  interactive mwinit and never uses the AEA-only re-mint rung. This is a gap: the
  cheapest "session valid, AEA lapsed" fix is missing from the central ladder.

### 2.7 `refreshAeaSilently()` + `AEA_SILENT_RETRIES` (lines 793-879)

- `AEA_SILENT_RETRIES = 3` (line 821). Loop (lines 824-872): per attempt →
  `injectCookies()` → `probeSession()` (silent OIDC handshake) → on landing,
  `injectCookies(undefined,{skipAea:true})` to preserve the freshly-minted live
  AEA → verify via `aeaSessionExpiryMin()` (live Electron store, not disk).
- Success only if `after !== null && after > 0` (lines 849-853). Short backoff
  `2000*attempt` ms between tries; **bails early if `_isOfflineNow()`** mid-retry
  (lines 866-869). Returns `{ ok, refreshed, aeaMin, attempts|why }`.
- `aeaSessionExpiryMin()` (lines 764-773): reads live AEA expiry from
  `electronSession.defaultSession.cookies.get({name:'amazon_enterprise_access'})`
  — the truth AAP uses, vs the stale disk file.

### 2.8 `aeaFileExpiryMin()` (lines 396-405)

Soonest `amazon_enterprise_access` expiry **from the disk file**, or `null`. Used
to detect "session valid but AEA missing" and to verify `--refresh-aea` landed.

### 2.9 `probeSession()` (lines 497-658)

- Hidden `BrowserWindow` loads `AAP_PROBE_URL` (`.../v2/page/bafc8b2a-...`, line 13).
- `isAAP(url)` parses the real **hostname** `/(^|\.)aap-na\.corp\.amazon\.com$/i`
  (line 523) — fixes the old substring bug where a Midway SSO `redirect_uri` query
  param matched. `isSSO` = SSO-pattern AND not AAP (line 524).
- Distinguishes a **handshake hop** (`isHandshakeHop`, lines 550-558: an SSO URL
  carrying `redirect_uri=...aap-na...`) from a **terminal login wall** via a
  2.5 s settle debounce (`scheduleSettleCheck`, lines 560-573). Lands on AAP →
  `true`; settles on SSO → `false`.
- `did-fail-load` with a code in `_NETWORK_ERR_CODES` (lines 34-50:
  `-106 INTERNET_DISCONNECTED`, `-105`, `-118`, `-21`, etc.) is logged as a
  connectivity error, **not** a session rejection (lines 588-600).

### 2.10 `pingRelayEndpoint()` (lines 662-720)

Same hostname-based AAP/SSO detection against `AAP_SERVICE_PROBE`
(`.../v2/service/00000000-...`, line 14; bypasses CloudFront cache). Timeout
`RELAY_PROBE_MS = 10 s`.

### 2.11 `ensureAuthenticated(mainWindow)` (lines 664-760)

The mwinit auto-spawn branch is **disabled** (`if (false /* DISABLED: boot
loops */)`, line 667). Flow: `checkMwinit` (log only) → `injectCookies` →
`probeSession` with up to 2 re-inject retries (lines 700-720) → offline guard →
`pingRelayEndpoint` with one re-inject retry. Throws `MIDWAY_SESSION_INVALID`,
`RELAY_SESSION_INVALID`, or `NETWORK_OFFLINE` (coded errors).

### 2.12 `recoverAuth(reason, opts)` — the central ladder (lines 1008-1088)

Rungs, stopping at the first that recovers:
1. **offline** (`_isOfflineNow()`) → return `rung:'offline'`, no prompt (1015-1018).
2. **VPN** (1021-1032): `checkVpnState()`; if `!connected && status!=='not-installed'`
   → `ensureVpn()` then `probeSession()`. Recovers at `rung:'vpn'` if probe passes.
3. **silent** (1035-1066): if `checkMwinit().ok`, `refreshAeaSilently()`; on
   failure while online, `restartAeaAgent()` then one more `refreshAeaSilently()`
   (rung `aea-agent`). If disk session expired, logs and falls through.
4. **mwinit** (1072-1086): gated by `opts.allowPrompt` (default true). `runMwinit()`
   → `injectCookies()`. Returns `rung:'mwinit'`.

**No `_authRecoveryInFlight` guard. No API smoke test. No retry/backoff/COOLDOWN.
No state machine. Does not call `refreshAeaViaMwinit`.**

### 2.13 `restartAeaAgent()` — AEA posture-agent self-heal (lines 940-985)

See §9.

### 2.14 `startOnlineReauthWatch()` + `_reauthInFlight` (lines 891-923)

See §3 / §6.

### 2.15 Exports (lines 1090-1104)

`checkMwinit, parseMidwayCookies, runMwinit, recoverAuth, restartAeaAgent,
injectCookies, probeSession, refreshAeaSilently, refreshAeaViaMwinit,
aeaFileExpiryMin, aeaSessionExpiryMin, ensureAuthenticated, pingRelayEndpoint,
startOnlineReauthWatch, COOKIE_FILE`.

---

## 3. ALL in-flight locks / guards related to auth

| Lock | File:line | Guards |
|---|---|---|
| `_mwinitInFlight` (promise) | `src/scrapers/auth.js:290` | The single interactive `mwinit` spawn; every caller awaits the same promise. |
| `_aeaRefreshInFlight` (promise) | `src/scrapers/auth.js:417` | `mwinit --refresh-aea` runs (`refreshAeaViaMwinit`). |
| `_reauthInFlight` (bool) | `src/scrapers/auth.js:891` | The reconnect watcher’s on-online re-verify (one at a time). |
| `_aeaAgentRestartInFlight` (bool) + `_lastAeaAgentRestartAt` | `src/scrapers/auth.js:940` | Posture-agent restart; also 2-min rate-limit. |
| `_midwayRenewalInFlight` (bool) | `src/app.js:293` | The 5-min heartbeat tick (skips if a renewal is mid-flight). |
| `_reauthInFlight` (bool, separate) | `src/window/index.js:268` | The `_loadFleetViaApiStartup` catch-handler’s hand-rolled ladder. |
| `_mwinitRunning` (bool) | `src/window/index.js` (SSO poller) | The auth-poll SSO-loop escalation. |
| `_ensuring` (bool) | `src/utils/vpn.js:99` | `ensureVpn()` overlapping attempts. |
| `_inFlight` (promise) + `_running` | `src/cluster/aea-keepalive.js:47,46` | The unattended `mwinit --refresh-aea` keep-alive ticks. |
| `_recoverInFlight` (bool) | `src/scheduler/index.js:270` | Scheduler *delivery* recovery (email/SP/DBR) — **not Midway auth**. |

**There is no single top-level `_authRecoveryInFlight`.** Recovery is only
serialized at the leaf (`runMwinit`, `refreshAeaViaMwinit`); two full ladders can
run concurrently.

---

## 4. Recovery ladder / orchestration (who calls what, in what order)

**Central ladder:** `recoverAuth` (§2.12).

**Callers of recovery / reactors to auth failure:**

- **`src/app.js` 5-min heartbeat** (`_midwayAutoRefresh`, lines 291-479):
  - Independently kicks `ensureVpn()` in the background (lines 319-326) — VPN
    keep-alive, not an auth gate.
  - Offline gate (lines 338-345): skips all auth work while offline.
  - `checkMwinit()`; pushes `auth:mwinit-status`. If `state.ok`, computes AEA via
    `aeaSessionExpiryMin()` (live) falling back to disk; **`aeaNeedsRefresh =
    (aeaMin === null) || (aeaMin < 45)`** → `refreshAeaSilently()`; else cheap
    `injectCookies()` keep-alive (lines 430-452).
  - `expiresInMin < 15` → `recoverAuth('heartbeat:session-expiring')` (459);
    `!state.ok` → `recoverAuth('heartbeat:session-expired')` (470). Both guarded
    by `_midwayRenewalInFlight`.
- **`src/scrapers/auth.js` reconnect watcher** (`startOnlineReauthWatch`, 891-923):
  on offline→online edge, waits 2.5 s, `refreshAeaSilently()`; if it fails while
  confirmed online → `recoverAuth('reconnect:reverify-failed')`. **This is the
  only thing that re-arms recovery after a failed pass — and only on a
  connectivity edge.**
- **`src/window/index.js` startup pre-flight** (`_midwayPreFlight`, ~949-1013):
  `checkMwinit`; if not ok → `runMwinit` (+ `mwinit -f` retry on probe fail). If
  ok but `aeaExpiresInMin === null || < 45` → `refreshAeaSilently()`, then
  escalate to `refreshAeaViaMwinit()` + `injectCookies(skipAea)` on failure.
  **Duplicate of the silent/AEA rungs, not routed through `recoverAuth`.**
- **`src/window/index.js` `_loadFleetViaApiStartup` catch** (~1145-1189): on
  `MIDWAY_SESSION_INVALID`/"session expired", runs a **hand-rolled ladder** behind
  its own `_reauthInFlight`: `refreshAeaSilently` → `refreshAeaViaMwinit` →
  (if `!checkMwinit().ok`) `runMwinit` → `injectCookies` → `probeSession` →
  `aap_api.dispose()` → retry load. **This is the primary duplication to retire.**
- **`src/window/index.js` auth-poll SSO loop** (~1490-1590): counts consecutive
  SSO URLs (offline-gated); at `_ssoCount >= 10` tries `refreshAeaSilently()`
  first, then **delegates to `recoverAuth('auth-poll:sso-loop')`** with a full
  explicit-sequence fallback if `recoverAuth` is absent.
- **`src/orcha/relay.js` `runMwinit()`** (688-692): delegates to
  `auth.runMwinit()` (no independent spawn).
- **`src/ipc/misc.js` `auth:run-mwinit`** (Settings button, ~356-384):
  `auth.runMwinit()` + `injectCookies()`. `auth:check-midway` (~388-407):
  `checkMwinit()`.
- **`src/ipc/ai.js:1050`** `orcha:mwinit` → `relay.runMwinit()`.
- **`src/cluster/aea-keepalive.js`** (opt-in, default OFF): timer that calls
  `mwinit --refresh-aea` when AEA < 45 min; judges success by the cookie file;
  surfaces "session expired — run `mwinit -o`" without spinning.

**Prompt decision:** the only place the interactive prompt is *not* allowed is
`recoverAuth`’s `opts.allowPrompt === false` (lines 1072-1075); otherwise rung 4
always prompts when online and silent repair is exhausted or the disk session is
expired.

---

## 5. VPN coupling (critical)

**VPN is already treated as optional, not a hard gate.** Exact touch points:

- **`src/utils/vpn.js`** — `checkVpnState()` (classifies `connected` /
  `disconnected` / `connecting` / `unknown`; `not-installed` ⇒ treated as
  `connected:true` so a missing client never gates anything, line 12). `ensureVpn`
  is non-blocking with its own `_ensuring` lock and never throws into auth.
- **`recoverAuth` rung 2** (`src/scrapers/auth.js:1021-1032`): only runs if
  `vpn && !vpn.connected && vpn.status !== 'not-installed'`. It calls
  `ensureVpn()` and then `probeSession()` — **success/failure of VPN never
  short-circuits the ladder**; it falls through to the silent-AEA rung regardless
  (the whole block is wrapped in `try/catch` that skips on any vpn error, 1031).
  ⚠️ **Ordering caveat vs the brief:** the brief wants RUNG 0 = "verify the real
  AAP target first, regardless of VPN." Today VPN reconnect (rung 2) runs *before*
  the silent-AEA/target re-probe (rung 3). It is not a *gate*, but it does front-
  run the target check and can attempt a VPN connect before proving the target is
  actually unreachable.
- **`src/app.js` heartbeat** (lines 319-326): independently fires `ensureVpn()`
  whenever the tunnel is down. Non-blocking, does not touch cookies or escalate to
  mwinit — but it is auth-adjacent background behavior to keep in mind.
- **`src/orcha/health.js` `_snapNetwork`** (lines 288-300): VPN state is **purely
  diagnostic** — "Online • VPN connected" (green) vs "Online • VPN not detected"
  (yellow). It never drives recovery.

**No place blocks AAP probing, cookie refresh, recovery, or mwinit *because* VPN
is disconnected.** `ensureVpn` failure never escalates to mwinit. The only
adjustment needed for the target architecture is **moving the real-target check
ahead of the VPN rung** (make VPN a late, optional assist — brief RUNG 5 — not
rung 2).

---

## 6. OFFLINE vs VPN — kept as separate states

**Yes, fully separated.** "Offline" = raw internet only, via
`src/orcha/offline.js` which wraps `electron.net.isOnline()` (line 50) on a 10 s
poll and emits `'online'`/`'offline'` transitions to subscribers (`onChange`,
lines 28-32). `auth.js` reads it through `_isOfflineNow()` (lines 23-26, defaults
to "online" if the module is unavailable).

VPN state comes from a **separate** module (`src/utils/vpn.js`,
`checkVpnState()`). Nowhere is "VPN disconnected" conflated with "offline":

- `runMwinit` offline gate (306), `refreshAeaViaMwinit` offline gate (420),
  heartbeat offline gate (338-345), auth-poll offline gate (~1505-1513),
  `probeSession`/`pingRelayEndpoint` network-error classification
  (`_NETWORK_ERR_CODES`), and `recoverAuth` rung 1 all key off `net.isOnline`,
  not VPN.
- The reconnect watcher (`startOnlineReauthWatch`) is driven by `offline.onChange`
  edges only.

`_reauthInFlight` in `auth.js` guards the reconnect watcher’s single re-verify.

---

## 7. AAP API smoke-test candidates (`src/scrapers/aap_api.js`)

Read-only GETs (all route through `_request` → in-page authenticated XHR):

| Function | Path | Line | Notes |
|---|---|---|---|
| **`getUserDetails()`** | `/api/v1/user/details` | 302 | **Code comment: "current user info. Also a cheap auth probe."** Best smoke-test: no args, small, authenticated. |
| `getAvmCodes()` | `/api/v1/avmCodes/` | 297 | Reference data, no args — also viable, slightly heavier. |
| `getAsset(aaid)` | `/api/v1/assets/{aaid}` | 277 | Needs an aaid. |
| `getLocationLatest(aaid)` | `/api/v1/locationHistories/latest/{aaid}` | 267 | Needs an aaid. |
| `searchAssets(req)` / `searchServices(req)` | `/api/v2/assets/search`, `/api/v1/serviceaggregates/search` | 251,241 | POST; require full default body; heavy. |

**Error surfacing in `_request` (lines 204-230):**
- **401 / 403** → `throw` `Error('AAP API <status> (session rejected)')` with
  **`code: 'MIDWAY_SESSION_INVALID'`** (lines 221-222). This is the canonical
  "session genuinely rejected" signal.
- **Other non-2xx** → `Error('AAP API <status>: <detail>')` with
  `code: 'AAP_API_ERROR', status` (line 224). A 500 lands here (not treated as
  auth failure).
- **Network error** → in-page XHR resolves `{ok:false, status:0, netErr:true}`
  (line 158) → surfaces as `AAP_API_ERROR` with `status:0`.
- **SSO redirect / page won’t auth** → surfaces earlier from `_ensureWindow`:
  provider rejects with `MIDWAY_SESSION_INVALID` (lines 135-141) or
  `AAP_API_LOAD_FAILED` (lines 142,155). `_isSSO` helper at line 47.

So a smoke test can cleanly distinguish: **401/403 (`MIDWAY_SESSION_INVALID`) =
re-auth needed; status 0 / `AAP_API_LOAD_FAILED` = network/offline; 5xx =
server-side, not auth.**

---

## 8. Cookie precedence — rules to preserve

1. **Skip-stale-disk-AEA:** `injectCookies(undefined, {skipAea:true})` skips
   `amazon_enterprise_access` from disk so a fresh live Electron AEA (minted by
   the OIDC handshake) is not overwritten by the stale disk token
   (`auth.js:238-239`; used in `refreshAeaSilently` step 3, line ~843, and
   `window/index.js` startup after `refreshAeaViaMwinit`).
2. **Truth = live Electron store, not disk:** AEA validity is verified via
   `aeaSessionExpiryMin()` (live `defaultSession` cookies), because the disk file
   keeps the old expired AEA after a silent handshake (`auth.js:764-773`).
3. **`__Host-` host-only injection:** `__Host-`-prefixed cookies are set with NO
   `domain` (scope derived from `url`), or Chromium rejects them — this is what
   keeps `__Host-session` from being dropped (`auth.js:253-256`).
4. **Session clock vs AEA clock are separate:** `expiresInMin` tracks only
   `__Host-session`/`session`; `aeaExpiresInMin` tracks only
   `amazon_enterprise_access` (§2.1/§2.3).

All four must survive the refactor.

---

## 9. AEA agent self-heal (`restartAeaAgent`, `src/scrapers/auth.js:940-985`)

- Windows-only (`process.platform !== 'win32'` → returns false, 943). Guards:
  `_aeaAgentRestartInFlight` (944) and a **2-min rate limit** via
  `_lastAeaAgentRestartAt` (946-949).
- Actions (best-effort, via `cmd.exe /c`): `taskkill /F /IM
  EnterpriseAccessConsoleApp.exe /T` (973), then `net stop itacsvc & net start
  itacsvc` (976), then a **fixed 6 s sleep** (979).
- **Readiness is NOT verified.** It returns `true` as soon as the two commands run
  plus the blind 6 s wait — it does **not** confirm the agent actually produces a
  valid posture JWT. The caller (`recoverAuth` rung `aea-agent`) then does one
  more `refreshAeaSilently()`, which is the only indirect check. The brief
  explicitly wants this changed to verify the agent is responsive (e.g. query the
  posture JWT / `get_aea_jwt`) rather than trusting `taskkill` return + sleep.

---

## 10. Tests (baseline under `tests/`)

Run with `vitest run`. Auth-relevant:

- **`tests/auth-recover-ladder.test.js`** — mocks `electron` (session/
  BrowserWindow/net) and asserts: `recoverAuth` is a function; **rung 1 OFFLINE
  defers without prompting** (`rung:'offline'`, `prompted:false`,
  `recovered:false`). A code comment explicitly notes the deeper rungs (VPN →
  silent → mwinit) are **not dependency-injected** and are only verified by
  live-log watching — a testability gap the refactor should close.
- **`tests/offline-classification-fallback.test.js`** — offline classification.
- Delivery/recovery tests unrelated to Midway: `scheduler-recovery.test.js`,
  `fas-idempotency-recovery.test.js`, `store-backup-recovery.test.js`,
  `slack-auth-status.test.js`, `fas-*authz*`, `ai-core-phase2-authority-entity`.

No tests cover `checkMwinit` session-vs-AEA parsing, `refreshAeaSilently`,
`refreshAeaViaMwinit` session-invalid detection, cookie precedence, or
`restartAeaAgent`. These are the high-value unit targets once the logic is made
injectable.

---

## 11. GAP ANALYSIS → target supervisor

Target: `src/auth/midway-health-supervisor.js`; explicit state machine
(UNKNOWN / HEALTHY / DEGRADED / RECOVERING / WAITING_FOR_USER / COOLDOWN /
OFFLINE / FAILED); one `_authRecoveryInFlight` lock; health = real AAP API smoke
test; bounded auto-retry with backoff; VPN never a gate; failure-classification
enum.

### WHAT EXISTS (reuse as building blocks)
- **Cookie truth:** `checkMwinit`, `parseMidwayCookies`, `aeaFileExpiryMin`,
  `aeaSessionExpiryMin` — correct and already fix the `user_name`/AEA-clock bugs.
  Reuse as the snapshot’s `diskSession` / `diskAea` / `electronSession` inputs.
- **Injection + precedence:** `injectCookies` (incl. `skipAea`, `__Host-` logic).
  Reuse verbatim.
- **Recovery primitives:** `refreshAeaSilently` (silent OIDC re-mint + retries),
  `refreshAeaViaMwinit` (AEA-only re-mint + session-invalid detection),
  `runMwinit` (deduped interactive), `restartAeaAgent`. Reuse as the ladder rungs.
- **Probes:** `probeSession`, `pingRelayEndpoint`. Keep as *diagnostic* evidence
  (`aapProbe`), but demote from "final authority."
- **Offline separation:** `src/orcha/offline.js` (`isOffline/onChange`) and
  `src/utils/vpn.js` (`checkVpnState/ensureVpn`) — reuse unchanged.
- **Error classification source:** `aap_api._request` already emits
  `MIDWAY_SESSION_INVALID` (401/403) vs `AAP_API_ERROR`+status vs status:0
  network — ready-made basis for the failure-classification enum.
- **A single ladder entry point:** `recoverAuth` — the supervisor can subsume it.
- **One baseline test** (`auth-recover-ladder.test.js`) proving the offline
  invariant.

### WHAT IS DUPLICATED (consolidate / retire)
- **`window/index.js` `_loadFleetViaApiStartup` catch handler** (its own
  `_reauthInFlight` + hand-rolled `silent → refresh-aea → mwinit` ladder, lines
  ~1145-1189) — **retire**, replace with a single `supervisor.recover()` call.
- **`window/index.js` `_midwayPreFlight`** startup AEA logic (~949-1013) —
  collapse into `supervisor.ensureHealthy()` on startup.
- **`window/index.js` auth-poll SSO loop** extra `refreshAeaSilently()` +
  explicit-sequence fallback (~1527-1569) — delegate fully to the supervisor.
- **Two separate `_reauthInFlight` flags** (`auth.js:891`, `window/index.js:268`)
  plus `_midwayRenewalInFlight` (`app.js:293`) and `_mwinitRunning` — replace the
  *recovery*-level ones with the single `_authRecoveryInFlight`. (Leaf locks
  `_mwinitInFlight` / `_aeaRefreshInFlight` stay as operation guards.)
- **`refreshAeaViaMwinit` is in callers but missing from `recoverAuth`** — fold
  the AEA-only rung into the one ladder so every caller gets it.

### WHAT MUST BE BUILT
- **State machine** with the 8 states + deterministic, auditable transitions.
  Nothing today models state; health is implicit in function return values.
- **`_authRecoveryInFlight`** top-level lock: callers `await` the single in-flight
  recovery; no second ladder starts.
- **Authenticated API smoke test** as the health authority: call
  `aap_api.getUserDetails()` (`/api/v1/user/details`) and interpret
  `MIDWAY_SESSION_INVALID` / network / 5xx per §7. Mark HEALTHY only after this
  passes (not after probe/mtime/process-restart/mwinit-completion alone).
- **Bounded auto-retry + backoff + COOLDOWN**: after a failed pass while online,
  schedule a retry with backoff and a `nextRetryAt`, instead of waiting for an
  external trigger. This is the core "don’t stay stuck after one failed cycle" fix.
- **Health snapshot** (the brief’s JSON shape): `state`, `internet`, `vpn`
  (`required:false`), `diskSession`, `diskAea`, `electronSession`, `aapProbe`,
  `aapApiSmokeTest`, `aeaAgent`, `lastRecovery`, `nextRetryAt`. Persist a **compact,
  secret-free** copy (never cookie values/tokens). `orcha/health.js:_snapAuth`
  can then read the supervisor state instead of raw `checkMwinit`.
- **Failure-classification enum** (e.g. `OFFLINE`, `VPN_DOWN`, `AEA_LAPSED`,
  `AEA_AGENT_STUCK`, `SESSION_EXPIRED`, `SERVER_ERROR`, `UNKNOWN`) derived from the
  smoke-test/probe/`_NETWORK_ERR_CODES` signals.
- **Ladder reorder** to brief order: RUNG 0 real-target smoke test → RUNG 1
  offline → RUNG 2 re-inject valid session → RUNG 3 silent AEA (+ `--refresh-aea`)
  → RUNG 4 agent self-heal **with real readiness verification** → RUNG 5 optional
  VPN assist (move it *after* the target check, not before) → RUNG 6 interactive
  mwinit → else COOLDOWN + scheduled retry.
- **Verified mwinit recovery** (brief §6): after `runMwinit`, require file
  rewritten (already done) **and** inject + flush + live Electron session cookie
  check **and** AAP API smoke test before returning `recovered:true`. Today
  `recoverAuth` rung 4 returns recovered after `runMwinit`+`injectCookies` with no
  post-verification.
- **`restartAeaAgent` readiness check**: replace the blind 6 s sleep + `taskkill`
  return with an actual posture-JWT/`get_aea_jwt` responsiveness probe (§9).
- **Dependency injection seams** so the ladder rungs are unit-testable without a
  real `BrowserWindow` (the documented gap in `auth-recover-ladder.test.js`).

### WHAT MUST BE PRESERVED
- Session validity keyed to `__Host-session`/`session` only; `user_name` never
  counts (§2.3).
- Separate session vs AEA expiry clocks (§2.1).
- Cookie precedence: `skipAea`, live-store-over-disk truth, `__Host-` host-only
  injection (§8).
- Offline ≠ VPN-off; every offline gate stays keyed to `net.isOnline`, not VPN
  (§6); VPN stays optional/diagnostic and never escalates to mwinit (§5).
- All leaf dedupe locks (`_mwinitInFlight`, `_aeaRefreshInFlight`) and
  `runMwinit`’s file-rewrite/mtime requirement (§2.5).
- `aea-keepalive.js` opt-in/default-OFF behavior and its "session expired → human
  must run mwinit -o" honesty.
- Network-error classification (`_NETWORK_ERR_CODES`) so a connectivity blip is
  never read as a rejected session.

---

## 12. Recommended function disposition (reuse vs retire)

- **Reuse unchanged:** `checkMwinit`, `parseMidwayCookies`, `injectCookies`,
  `aeaFileExpiryMin`, `aeaSessionExpiryMin`, `refreshAeaSilently`,
  `refreshAeaViaMwinit`, `runMwinit`, `probeSession`, `pingRelayEndpoint`,
  `offline.*`, `vpn.*`, `aap_api.getUserDetails`.
- **Wrap/retire into supervisor:** `recoverAuth` (becomes the supervisor’s
  `recover()` with the lock, state machine, smoke test, retry/COOLDOWN, reordered
  rungs), `startOnlineReauthWatch` (becomes a supervisor subscription that nudges
  the state machine, not an independent re-verify path).
- **Modify:** `restartAeaAgent` (add real readiness verification).
- **Retire (duplicated ladders):** the `_loadFleetViaApiStartup` catch handler and
  the bespoke AEA logic in `_midwayPreFlight` / the SSO-poller fallback in
  `window/index.js`; the separate `_reauthInFlight`/`_midwayRenewalInFlight`
  recovery flags — all route through the single supervisor + `_authRecoveryInFlight`.

(Content was rephrased for compliance where source comments were long; all
citations are file:line into the repo above.)

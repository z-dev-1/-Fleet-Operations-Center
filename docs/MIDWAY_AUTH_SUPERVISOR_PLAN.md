# Midway Auth Health Supervisor — Design & Plan

Status: proposed (grounded in the current code)
Branch: `feature/owa-triage-midway-fixes`

## The core bug this fixes (confirmed live)

A real failure captured this session:
- `heartbeat: ok=true expiresInMin=1196 aeaExpiresInMin=null` — the cookie-file
  parser said the Midway session was valid (~20h) and AEA missing.
- `mwinit --refresh-aea` → **"Not refreshing AEA cookie because Midway cookie
  file does not contain a valid Midway session."** — mwinit's OWN validator
  disagreed with our file parse.
- The in-app silent handshake then bounced off the SSO login wall 3× and gave
  up. One failed pass → stuck.

The lesson, and the spec's core invariant: **auth health is defined by a real
authenticated AAP request succeeding — never by VPN status, never by cookie
existence, never by `mwinit`/`--refresh-aea` completing, never by the file
parse.** The current code violates this in two places (below).

## What already exists and is good (PRESERVE — spec #28)

`src/scrapers/auth.js` is already well-built:
- `checkMwinit()` — **already** keys session validity on `__Host-session`/`session`
  (not `user_name`) and excludes `amazon_enterprise_access` from the expiry
  clock; reports `aeaExpiresInMin` separately. Keep as a DIAGNOSTIC input.
- `probeSession()` — hostname-based (not substring) AAP-landing probe that
  tolerates the OIDC handshake hop and judges by where navigation SETTLES
  (terminal SSO wall = fail, lands on AAP = ok). This is the browser-side
  real-target check. Keep.
- `recoverAuth(reason, {allowPrompt})` — the existing single ladder: offline →
  VPN(best-effort) → silent AEA → AEA-agent self-heal → mwinit. VPN is already
  NOT a hard gate (it only tries a non-blocking reconnect then re-probes;
  `ensureVpn` failure is swallowed). Keep the rungs; wrap + harden.
- `refreshAeaSilently()` (SSO re-inject handshake), `refreshAeaViaMwinit()`
  (now captures stdout + detects "no valid Midway session" → `sessionInvalid`),
  `restartAeaAgent()` (posture-agent self-heal), `injectCookies({skipAea})`
  (cookie precedence: don't overwrite fresher live AEA with stale disk AEA),
  `startOnlineReauthWatch()` (reconnect watcher). Keep all.
- `aap_api._request` throws `code:'MIDWAY_SESSION_INVALID'` on 401/403 and a
  distinct `AAP_API_ERROR` on other 4xx/5xx. Keep.

## The two real gaps (spec #6, #9)

1. **Final false-recovery (#6):** `recoverAuth` Rung 4 does
   `runMwinit() → injectCookies() → return recovered:true` with NO AAP
   verification. It claims success on mwinit completion. → Never claim HEALTHY
   without a real AAP verification.
2. **No persistent convergence (#9):** `recoverAuth` runs ONCE and returns.
   After a failed pass nothing re-enters the ladder until an external event.
   → Add bounded auto-retry with backoff until verified HEALTHY or truly stuck.

Plus missing scaffolding: explicit state machine (#3), one global recovery lock
(#4), a structured health snapshot (#7), an authenticated API smoke test (#16),
failure classification (#17), and the `ensureHealthy()` caller contract (#18/#19).

## Target: `src/auth/midway-health-supervisor.js`

A thin supervisor that OWNS orchestration and REUSES the proven primitives in
`auth.js` (it does not re-implement cookie injection / AEA refresh / mwinit /
agent repair). One authority; callers stop inventing their own recovery.

### Health = real target acceptance (#5, #16)
`verifyHealthy()` returns HEALTHY only when BOTH pass (API smoke is primary):
- **API smoke test (primary):** `aap_api.getUserDetails()` → `GET /api/v1/user/details`
  — read-only, lightweight, unit-independent. 200 = authenticated; a
  `MIDWAY_SESSION_INVALID` (401/403) = not authed; a 500 = server error (NOT an
  auth failure, #17). 
- **Browser probe (corroborating):** existing `probeSession()`.
Cookie file / mtime / mwinit completion are NEVER sufficient.

### State machine (#3)
`UNKNOWN → HEALTHY | DEGRADED | RECOVERING | WAITING_FOR_USER | COOLDOWN | OFFLINE | FAILED`,
deterministic + auditable; every transition logged with a reason + recorded in a
bounded history (#25).

### One global lock (#4)
`_authRecoveryInFlight` at the supervisor. `ensureHealthy()`: if a recovery is
running, await it; else start exactly one. Operation-specific locks
(`_mwinitInFlight`, `_aeaRefreshInFlight`) stay as inner guards.

### Recovery ladder (#8) — reuses auth.js, re-ordered per spec
- Rung 0 VERIFY real target (API smoke + probe) → HEALTHY regardless of VPN.
- Rung 1 OFFLINE (`_isOfflineNow`) → OFFLINE, no prompt, schedule recheck.
- Rung 2 RE-INJECT existing valid session (`injectCookies`) → verify.
- Rung 3 SILENT AEA refresh (`refreshAeaSilently` / `refreshAeaViaMwinit`;
  honor the new `sessionInvalid` signal → jump to Rung 6) → verify.
- Rung 4 AEA AGENT self-heal (`restartAeaAgent`, now verified-responsive) →
  retry silent → verify.
- Rung 5 OPTIONAL VPN assist — only if evidence suggests routing may help;
  `ensureVpn()` best-effort, never required, re-probe. Never a prerequisite (#1/#29).
- Rung 6 INTERACTIVE mwinit — only when the session genuinely expired OR all
  silent repair exhausted AND real AAP verification still fails. →
  WAITING_FOR_USER; on cookie-file rewrite, VERIFY against AAP; only then HEALTHY.

### Persistent convergence (#9)
On a failed pass → COOLDOWN with bounded backoff (30s → 1m → 2m → 5m → cap
10–15m, jitter), auto re-entering the ladder. Reset on HEALTHY. Never retry
while OFFLINE, WAITING_FOR_USER, or shutting down. A late mwinit (user finishes
after the caller timed out) is discovered on the next verify (#23).

### VPN decoupling (#1, #29) — NON-NEGOTIABLE
VPN is only `vpn: { connected, required:false }` in the snapshot and an OPTIONAL
Rung 5 hint. Never gates probing/refresh/recovery/mwinit. "VPN off + AAP works"
= HEALTHY, do nothing. "VPN off + AAP fails" = diagnose normally. Offline and
VPN-off remain separate states.

### Failure classification (#17)
Map errors to: NETWORK_OFFLINE / NETWORK_DNS / NETWORK_TIMEOUT / TARGET_UNREACHABLE
/ MIDWAY_SESSION_EXPIRED / AEA_MISSING / AEA_EXPIRED / AEA_AGENT_HUNG /
SSO_LOGIN_WALL / COOKIE_INJECTION_FAILED / AAP_AUTH_REJECTED / AAP_API_UNAUTHORIZED
/ AAP_SERVER_ERROR / UNKNOWN_AUTH_FAILURE. Recovery branches on class — e.g. an
AAP 500 is NOT an auth failure and never triggers mwinit.

### Caller contract (#18, #19)
`ensureHealthy({ reason, allowPrompt=true, forceVerify=false })` →
`{ ok, state, recovered, rung, prompted, verified, latencyMs, nextRetryAt? }`.
Callers (AAP readers/writers, heartbeat, data-source ladder, aea-keepalive)
delegate here instead of running their own recovery.

### Snapshot + history + UI (#7, #24, #25)
Structured snapshot (no secrets), bounded recovery history, and a health panel
(HEALTHY/DEGRADED/…, AAP verified, session/AEA remaining, VPN "not required",
last verified, next retry, Retry/Run-mwinit buttons).

## Implementation phases (each: tests green, committed separately)

- **A — Primitives & verification:** add `verifyHealthy()` (API smoke via
  `getUserDetails` + `probeSession`), failure classifier, health snapshot
  builder. Pure/injectable for tests. No behavior change yet.
- **B — Supervisor + state machine + one lock + `ensureHealthy()`** wrapping the
  existing `recoverAuth` rungs; fix #6 (verify before HEALTHY) and the `mwinit`
  rung to verify against AAP.
- **C — Persistent convergence:** bounded backoff auto-retry + integrate the
  reconnect watcher; WAITING_FOR_USER + late-mwinit discovery.
- **D — Caller migration:** route AAP/heartbeat/data-source/aea-keepalive
  through `ensureHealthy`; retire their duplicated recovery.
- **E — Health UI** panel + diagnostics.
- Tests throughout per spec #27 (offline/VPN/AEA/mwinit/convergence matrices).

## Open question for you
The spec is large (8 states, 7 rungs, convergence, classification, UI, ~30
tests). I'll build it in the phases above, committing each. **Do you want the
supervisor as a NEW `src/auth/midway-health-supervisor.js` that wraps auth.js
(lower risk, auth.js primitives stay), or folded INTO a refactored auth.js?**
I recommend the wrapper — it preserves every proven primitive and is far safer
for production auth.

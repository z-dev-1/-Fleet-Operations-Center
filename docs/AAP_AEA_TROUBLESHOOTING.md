# AAP / AEA Auth Troubleshooting Runbook

Practical guide for when the Fleet app shows **"AAP session expired (Midway/AEA)"**
or the fleet table won't load, even though `mwinit` on the command line works.

Last confirmed working: **2026-10-18** — app pulled 207 units across all 17
domiciles after the fix below.

---

## TL;DR — the usual cause and the 30-second fix

**Cause (confirmed 2026-10-18):** the Amazon Enterprise Access **posture agent**
(`EnterpriseAccessConsoleApp.exe`) gets into a bad state — typically **multiple
duplicate instances** — and times out when queried for the AEA posture JWT
(`AEA get_aea_jwt timed out after 2 seconds` / `AEA JSON is empty`). Without that
posture cookie, AAP rejects every request and bounces to the Midway SSO wall —
even though your `__Host-session`/`session` cookies are perfectly valid.

**The app now self-heals this automatically** (see "Automatic fix" below). If you
ever need to do it by hand:

```powershell
# 1. Kill the stuck/duplicate posture agents
Get-Process EnterpriseAccessConsoleApp -ErrorAction SilentlyContinue | Stop-Process -Force
# 2. Restart the host service (respawns ONE clean agent)
Restart-Service itacsvc -ErrorAction SilentlyContinue
# 3. Re-auth (FIDO2 / on-token PIN)
mwinit -f
# 4. Relaunch the Fleet app
```

If that still fails → **reboot the laptop** (clears the TPM/posture binding), then
`mwinit -f`, then launch. A reboot is the most reliable reset.

---

## How to tell if it's actually AEA (diagnosis)

The app logs a diagnostic line on its keep-alive tick (`src/app.js`, `[AEA-DIAG]`):

```
[AEA-DIAG] live session AEA(min)=<null|number> | disk AEA(min)=... | sessionOk=true
```

- **`live session AEA(min)=null`** → the Electron session has NO
  `amazon_enterprise_access` cookie. This is the posture-agent problem. Run the
  manual fix above (or let the app self-heal).
- **`live session AEA(min)=<a number>`** → AEA IS present; the problem is
  elsewhere (VPN, network, or a genuine session expiry — run `mwinit -f`).

Pull it from the log any time:

```powershell
Get-Content "$env:APPDATA\fleet-ops-app\logs\app.log" -Tail 200 | Select-String "AEA-DIAG"
```

### Deep diagnosis with mwinit's own verbose output

If you want to see the agent fail directly:

```powershell
mwinit -f -v 2>&1 | Select-String -Pattern "AEA|posture|device id|JWT"
```

- **Broken:** `AEA get_aea_jwt timed out after 2 seconds` / `AEA JSON is empty,
  no AEA JWT present` / `could not retrieve the device id`.
- **Healthy:** `AEA JSON response: '{"type":"GetJWT","Jwt":"...","Status":"Success"...}'`.

Check how many posture agents are running (more than 1 = the bug):

```powershell
Get-Process EnterpriseAccessConsoleApp -ErrorAction SilentlyContinue | Select-Object ProcessName, Id
```

---

## Automatic fix (built into the app)

`src/scrapers/auth.js` — the central recovery ladder (`recoverAuth`) now has an
**AEA-agent self-heal rung (3.5)**:

When AAP fails and the app finds **session valid + online + VPN up + silent AEA
refresh failing** (the exact signature of a stuck agent), it automatically:
1. `taskkill /F /IM EnterpriseAccessConsoleApp.exe /T` (kills all duplicates)
2. `net stop itacsvc & net start itacsvc` (respawns one clean agent — best-effort;
   if not elevated, the service auto-respawns the killed agent anyway)
3. waits ~6s for the fresh agent to attach to the TPM
4. retries the silent AEA refresh

Only if that STILL fails does it fall back to prompting an interactive `mwinit`.
Rate-limited to once per 2 minutes. Windows-only (no-op elsewhere — the DevSpace
doesn't have this agent). See `restartAeaAgent()` in `auth.js`.

---

## What is and isn't the app's fault

- **NOT the app / not a code change:** `mwinit`, the AEA posture agent, the
  cookie file, and the Midway auth stack are Amazon system components. The app
  can only *use* the posture cookie the device agent produces; it can't mint one.
- **The app's recovery ladder** (`recoverAuth`, cheapest → most intrusive):
  1. offline? → defer (dead network isn't a rejected session)
  2. VPN down? → reconnect, re-probe
  3. session valid but AEA lapsed? → silent re-mint (no tap)
  3.5. silent refresh failing? → **restart the stuck posture agent** (self-heal)
  4. last resort → prompt interactive `mwinit`

---

## Known-good signals (what "working" looks like)

- App log: `buildFleetDataset: 207 units (unavailable: NN, filter: [...all 17
  domiciles...])` and `API load: pushed 207 units`.
- `mwinit -f -v` shows `AEA JSON response: '{... "Status":"Success" ...}'`.
- Exactly **one** `EnterpriseAccessConsoleApp.exe` process.
- Cookie file has `__Host-session`, `session`, `tpm_metrics`, `user_name`
  (the short-lived `amzn_sso_rfp`/`amzn_sso_token` come and go — that's normal;
  `amazon_enterprise_access` is session-only and usually NOT in the file).

## Common triggers for the agent going bad

- A VPN disconnect/reconnect mid-session (posture attestation tied to the tunnel).
- Multiple app restarts spawning/leaving duplicate agents.
- Amazon-side Midway auth-stack changes (e.g. the CA→SKS migration announced in
  mwinit's banner on 2026-10-18).

If the duplicate-agent spawn recurs *constantly* even after reboot, that's an
ACME/Enterprise-Access agent issue for corp IT — but the app will auto-recover
each occurrence.

# mwinit Quick Reference — what works (laptop)

Keep this handy. These are the exact commands + known-good output confirmed
working on **2026-10-18** on the laptop (`C:\Program Files\itacsvc\mwinit.exe`,
version 2.5.10 Windows). Use it if Midway/AEA auth gets messed up again.

---

## The command that works

```powershell
mwinit -f
```

- `-f` / `--fido2` = authenticate with the security key's **on-token PIN**
  (FIDO2). This is the recommended path and is REQUIRED if your key's On-Token
  PIN is "Enforced". It will become mwinit's default in a future version.
- Plain `mwinit` (U2F) also works but the banner warns `-f` is preferred.
- `mwinit -o` (OTP) works too — used on the DevSpace (YubiKey OTP) where
  WebAuthn isn't available. On the **laptop use `-f`** (WebAuthn/Windows Hello).

**Do NOT use `--no-aea`** — that skips the posture cookie, which is the exact
thing AAP needs. AEA is attached by default now (the `--aea` flag was removed).

Steps when you run it: enter Midway PIN → tap/touch the security key → done.

---

## What a HEALTHY run looks like

```
Welcome, zilasant
...
Successfully authenticated using WebAuthN, session cookie saved in C:\Users\zilasant/.midway/cookie
Successfully signed SSH public key "...id_ecdsa.pub"...
Successfully saved session token to MCS Keys Process
```

And with `-v` (verbose), the AEA line should show **Success**:

```
AEA JSON response: '{"type":"GetJWT","Jwt":"eyJ...","Status":"Success","ResultCode":0}'
```

Known-good cookie file (`~/.midway/cookie`) names — check with:

```powershell
Get-Content "$env:USERPROFILE\.midway\cookie" | ForEach-Object { $l=$_; if($l -match '^#HttpOnly_'){$l=$l -replace '^#HttpOnly_',''} elseif($l -match '^#' -or -not $l.Trim()){return}; $f=$l -split "`t"; if($f.Count -ge 6){$f[5]} } | Sort-Object -Unique
```

Expect: `__Host-session`, `session`, `tpm_metrics`, `user_name`
(plus sometimes `amzn_sso_rfp`, `amzn_sso_token` — short-lived, come and go).
NOTE: `amazon_enterprise_access` (AEA) is usually NOT in the file — it's minted
live by the posture agent per request. Its absence from the file is normal.

---

## What a BROKEN run looks like (and the fix)

Verbose (`mwinit -f -v`) shows the posture agent failing:

```
AEA get_aea_jwt timed out after 2 seconds
AEA JSON is empty, no AEA JWT present.
Warning: mwinit could not retrieve the device id of this machine.
```

Root cause: the Enterprise Access posture agent
(`EnterpriseAccessConsoleApp.exe`) is stuck — usually **multiple duplicate
instances**. The session authenticates but no AEA posture cookie is produced,
so AAP rejects.

### Fix (the sequence that worked 2026-10-18)

```powershell
# 1. See how many posture agents are running (more than 1 = the bug)
Get-Process EnterpriseAccessConsoleApp -ErrorAction SilentlyContinue | Select-Object ProcessName, Id

# 2. Kill ALL of them
Get-Process EnterpriseAccessConsoleApp -ErrorAction SilentlyContinue | Stop-Process -Force

# 3. Restart the host service so ONE clean agent respawns
Restart-Service itacsvc -ErrorAction SilentlyContinue

# 4. Wait a few seconds, then re-auth
mwinit -f

# 5. Verify AEA now succeeds
mwinit -f -v 2>&1 | Select-String -Pattern "AEA|Status|JWT"
#    -> want: AEA JSON response ... "Status":"Success"

# 6. Relaunch the Fleet app
```

If the agent STILL won't produce AEA after that → **reboot the laptop** (clears
the TPM/posture binding the agent couldn't read), then `mwinit -f`, then launch.
A reboot is the most reliable reset.

---

## Useful mwinit flags (from `mwinit -h`)

| Flag | Use |
|------|-----|
| `-f`, `--fido2` | On-token PIN auth (preferred on the laptop) |
| `-o`, `--otp-auth` | OTP as 2nd factor (used on the DevSpace) |
| `-v`, `--verbose` | Detailed output — use this to SEE the AEA step |
| `-t`, `--troubleshoot` | Diagnostic/troubleshooting info |
| `-l`, `--list` | Show current CA-certified SSH keys + web cookies |
| `--refresh-aea` | Refresh ONLY the AEA cookie (no full re-auth) — only works if the agent is healthy |
| `--no-aea` | DON'T attach the posture cookie — **do not use** (breaks AAP) |
| `-d`, `--delete` | Delete Midway SSH keys, web cookies, session token (nuclear reset) |
| `--timeout <sec>` | Raise connection timeout on slow networks |

---

## Related

- Full AAP/AEA troubleshooting + the app's automatic self-heal:
  see `docs/AAP_AEA_TROUBLESHOOTING.md`.
- The app auto-runs the fix above (kill agents + restart service) via
  `restartAeaAgent()` in `src/scrapers/auth.js` (recovery ladder rung 3.5),
  so in most cases you won't need to do this by hand.

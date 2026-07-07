# Fleet Ops V-C — Stage 25 Completion Record

**Date:** 2026-06-30
**Commits:** `11dddf0` (S25-1) → `54b11ff` (S25-2) → `7ec7086` (S25-3) → `450553d` (S25-4)
            → `3cb4f09` (S25-5) → `a8badae` (S25-6) → `18c6c2a` (S25-7) → `790de24` (S25-8)
            → `fece35e` (S25-9) → `064969b` (S25-10) → `2b4d18d` (S25-11) → `48b3452` (S25-12)
            → `1122f8c` + `40c64e1` + `52c7ee6` + `84642ca` (S25-13)
**Sanity suite:** 914/914 (all S25 additions pass, checks distributed across existing check blocks)

---

## 1. What This Stage Was

Stage 25 was a **13-sub-stage vendor workflow hardening and enrichment** pass —
the longest stage in Version C. It fixed bugs uncovered in real-world testing
(S25-1 through S25-8), added Volvo ASIST offsite enrichment (S25-9 through S25-12),
and closed out the Setup Wizard (S25-13).

---

## 2. Sub-Stage Detail

### S25-1 — `altId` passthrough in `vendor:approve` (6 checks)
**Bug:** `altId` was not being forwarded through the preload bridge to the IPC
`vendor:approve` handler, causing the workflow to submit with a null altId.
**Fix:** `preload.js` + `bridge.js` updated to pass `altId` through the approve call.

### S25-2 — `vendor.openPortalUrl` (8 checks)
**Bug:** `window.vendor.openPortalUrl` was exposed in preload but had no bridge
backing — calling it did nothing.
**Fix:** Bridge + preload wired end-to-end; unit-detail and vendors view can now
open portal URLs in the system browser.

### S25-3 — Active workflow status bar (13 checks)
New `vendors.js` status bar: one pill per in-flight workflow, each showing unit ID
+ status label. Cancel button per pill calls `vendor.cancel(workflowId)`.
8-second `setInterval` reconcile poll keeps pills in sync with `state.vendor.active`.

### S25-4 — Persist workflow history across reloads (11 checks)
**Bug:** `state.vendor.history` was in-memory only — lost on app restart.
**Fix:** New `vendor_history.json` file in user data dir. Load/save IPC handlers
(`vendor:load-history` / `vendor:save-history`) added to `vendors/index.js`.
`vendor-bridge.js` rehydrates history on boot from IPC call.

### S25-5 — Vendor portal auth UI in Settings (22 checks)
New "Vendor Portals" section in `settings.js`:
- PACCAR and Volvo credential cards (username + password fields each)
- Status dots: 🟢 Saved / ⚪ Not saved
- Save button → encrypted store via `window.credentials.set`
- Clear button → `window.credentials.delete`
- Re-populated on every settings open (via `_checkVendorCred` in `_populate()`)
`credentials.js` IPC handler updated to support `paccar` + `volvo` namespaces.

### S25-6 — Premature review modal + mid-flight reconnect (8 checks)
**Bug 1:** `vendor:review-ready` arrived before `unit-detail.js` had finished
rendering the vendor section — modal opened on a blank panel.
**Fix:** `openVendorReview` deferred until `_wireVendorPanel` confirms DOM ready.

**Bug 2:** If the user closed and reopened the unit-detail panel while a workflow
was mid-flight, `_wireVendorPanel` would re-run and cancel the existing `_vendorUnsubs`
before the new listeners had subscribed, causing the in-flight workflow to become
invisible to the UI.
**Fix:** `_wireVendorPanel` checks for an active workflow via `state.vendor.active`
and reconnects to its event stream instead of discarding it.

### S25-7 — `relay-step.js` syntax errors (5 checks)
**Bug:** Two comma-before-return syntax patterns in `relay-step.js` —
the altId poll block and the WR title scrape block — were always throwing
`SyntaxError` silently (caught by the outer try/catch), meaning those steps
always failed without logging a meaningful error.
**Fix:** Comma-return patterns replaced with correct `return` statements.

### S25-8 — `addConversationNote` in `aap_create_wr.js` (8 checks)
**Bug:** `addConversationNote` was called in the WR creation flow but was
never implemented — it was a stub that returned immediately. The Relay WR note
(confirmation message posted back to the AAP WR thread) was silently skipped.
**Fix:** Full implementation: finds the WR conversation endpoint, POSTs the note
with the correct payload format.

### S25-9 — Volvo ASIST offsite enrichment (20 checks)
New enrichment chain for units at a Volvo Decisiv dealer:
```
Service Request (SR) → Decisiv Case → Fleet Estimate
```
New IPC handler `vendor:enrich-asist`. Orchestrated by `src/vendors/volvo/`.
Stores enrichment result in `state.asistEnrichment[unitId]`.

### S25-10 — Surface ASIST enrichment throughout the stack (20 checks)
Enrichment data from S25-9 propagated to:
- `mergeRows()` — ASIST data merged into fleet table rows
- `misc.js` — helper to format ASIST fields
- Notes persistence — ASIST fields included in daily-notes snapshot
- Vendors table — ASIST badge column in drill table (`asist-badge` CSS class)
- Unit-detail offsite panel — dedicated ASIST section with re-enrich button
- `fleet.css` — `.asist-badge`, `.asist-panel` rules

### S25-11 — Feed ASIST enrichment into daily-notes (17 checks)
`daily-notes.js` snapshot, diff, decision logic, AI prompt, and result display
all updated to include ASIST enrichment fields (shop name, case status, estimate
total, last update). Ensures the daily AI note reflects offsite repair status.

### S25-12 — Sub Vendor field (25 checks)
New `subVendor` field on each unit: the specific dealer name from Decisiv/ASIST
(preferred) or a geofence-based fallback if ASIST enrichment hasn't run.

- ASIST history strip in unit-detail now shows a dealer badge
- 24-hour staleness guard: ASIST re-enrich skipped if enrichment is < 24h old
- Email template updated to include a "Sub Vendor" line

### S25-13 — Setup Wizard (15 checks + bug fixes)
**New feature:** First-run Setup Wizard (`src/setup/`) — a modal step-through
that runs on first launch to capture:
1. Profile (user name / login)
2. Domiciles (codes)
3. Midway auth check
4. Orcha connection config
5. Confirm + complete

**Bugs fixed during S25-13 hardening:**
- `saveStep()` was not being called on each "Next" click — progress was lost
- Review step was rendering `[object Object]` for Profile, Domiciles, Midway,
  Orcha, and Confirm sections — fixed by `JSON.stringify` / field destructuring
- "Complete Setup" button was blocked by the `allowlist` check which excluded
  the confirm step — confirm added to `OPTIONAL_STEPS`, excluded from allowlist
- Literal newline in subVendor AI prompt template string — `node --check` clean

---

## 3. Sanity Check Distribution

S25 checks are distributed across the check blocks they touch rather than a
separate `S25-N:` block. Key counts per sub-stage as noted in commit messages:

| Sub | Checks added |
|---|---|
| S25-1 | 6 |
| S25-2 | 8 |
| S25-3 | 13 |
| S25-4 | 11 |
| S25-5 | 22 |
| S25-6 | 8 |
| S25-7 | 5 |
| S25-8 | 8 |
| S25-9 | 20 |
| S25-10 | 20 |
| S25-11 | 17 |
| S25-12 | 25 |
| S25-13 | 15 |
| **Total** | **178** |

Suite arc during S25: 845 → 914 (all clear, 1 persistent static-onclick warning).

---

## 4. Files Modified / Created

| File | Sub-stages |
|---|---|
| `preload.js` | S25-1, S25-2, S25-9 |
| `renderer/src/js/bridge.js` | S25-1, S25-2 |
| `src/ipc/credentials.js` | S25-5 |
| `src/ipc/index.js` | S25-4, S25-9 |
| `src/vendors/index.js` | S25-3, S25-4 |
| `src/vendors/base/relay-step.js` | S25-7 |
| `src/vendors/base/vendor-workflow.js` | S25-3 |
| `src/vendors/volvo/index.js` | S25-9 |
| `src/scrapers/aap_create_wr.js` | S25-8 |
| `renderer/src/js/vendor-bridge.js` | S25-3, S25-4 |
| `renderer/src/js/views/vendors.js` | S25-3, S25-10, S25-12 |
| `renderer/src/js/views/unit-detail.js` | S25-6, S25-10, S25-12 |
| `renderer/src/js/views/settings.js` | S25-5 |
| `renderer/src/js/views/daily-notes.js` | S25-11, S25-12 |
| `renderer/src/js/misc.js` | S25-10 |
| `renderer/src/css/fleet.css` | S25-10, S25-12 |
| `src/setup/` (new) | S25-13 |

---

*Completion record written 2026-06-30.*

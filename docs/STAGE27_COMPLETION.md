# Fleet Ops V-C — Stage 27 Completion Record

**Date:** 2026-06-30
**Baseline:** Stage 26 complete — tag `renderer-stage26-complete`, 956/956
**Branch:** `main`

---

## Sub-stage Completion Status

| Sub-stage | Status | Committed |
|---|---|---|
| S27-1 — CSS `vr-link--external` + vendor badge colors | ✅ Complete | Prior commit |
| S27-2 — `bridge.js` `getPortalUrl` re-export | ✅ Complete | Prior commit |
| S27-3 — Activity bar stub label + `vab__pill--stub` CSS | ✅ Complete | This session |
| S27-4 — `relay.js` carry-forward cleanup | ✅ Complete | This session |
| S27-5 — `setLifecycle.js` `appendFileSync` → logger | ✅ Complete | This session |
| S27-6 — Windows live test: AAP field verification | ✅ **PASSED** | This session |
| S27-7 — Supplier ID capture tooling | ⏭ Deferred to S28 | — |
| S27-8 — Email test mode IPC wiring | ⏭ Deferred to S28 | — |
| S27-9 — Settings: PACCAR/Volvo credential wiring | ⏭ Deferred to S28 | — |
| S27-10 — `orcha_learn` vendor suggestion pipeline | ⏭ Stretch / S28 | — |

---

## S27-6 Windows Live Test Results

**Tested:** 2026-06-30 ~11:04 PM ET
**Machine:** Windows (zilasant)
**Method:** Read `aap_cache.json` + `fleet_data.json` from running app data dir
**Midway:** Active — 7 valid cookies, 93 min remaining at test time

| Field | Result | Notes |
|---|---|---|
| `fuelType` | ✅ **159/159 populated** — `CNG` confirmed | 100% coverage |
| `domicileSite` | ✅ Populated — `ABE40` confirmed | Present on all rows |
| `engineManufacturer` | N/A — not stored at row level | Attribute-level field only; not required in fleet row schema |
| Last scrape timestamp | `2026-07-01T03:04:04.686Z` | Live, fresh data |

**Verdict:** AAP 2-phase fetch intercept is fully functional on Windows.
The Stage 26 Windows-only caveat on `fuelType` is **resolved and closed**.

---

## S27-3 Changes — Activity Bar Stub Label

**File:** `renderer/src/js/components/vendor-activity-bar.js`

- `STEP_LABELS['review-ready:stub']` changed from `'Awaiting review'` → `'Review (stub)'`
- `_pillHtml()` now adds `vab__pill--stub` CSS class when `p.step` ends with `:stub`
- Ops can now distinguish a stub-path workflow from a real review gate at a glance

**File:** `renderer/src/css/fleet.css`

- Added `.vab__pill--stub` rule: purple tint (`rgba(210,168,255,.08)`) matching stub badge color palette

---

## S27-4 Changes — relay.js Carry-forward Cleanup

**File:** `src/scrapers/relay.js`

- Added header comment confirming `appendFileSync` carry-forward was stale
- No code change needed — `relay.js` already uses `logger` throughout

---

## S27-5 Changes — setLifecycle.js Logger Migration

**File:** `src/scrapers/setLifecycle.js`

- Removed `const fs = require('fs'), path = require('path'), os = require('os')` (lines 84–85)
- Removed stale `logPath` pointing to `fleet-status-app` (wrong app name, old path)
- Removed `fs.appendFileSync(logPath, ...)` (line 95)
- `log('Automation result:', ...)` via `logger` is the sole output path now
- Net: -6 lines, no functional change to automation behavior

---

## What Was Already Done (S27-1, S27-2)

S27-1 and S27-2 were committed in a prior session:
- `vr-link--external` CSS (color, italic, `↗` icon, hover) — confirmed at line 1923
- Vendor badge colors for `amerit`, `cummins`, `ta`, `velociti`, `fleetnet`, `goodyear` — confirmed at line 1907
- `bridge.js` re-export: `export { vendor, getPortalUrl } from './vendor-bridge.js'` — confirmed at line 231

---

## Open Items Deferred to Stage 28

### S27-7 — Supplier IDs (33/34 blank)
Requires live `createRepair` calls against each vendor to capture `supplierId` UUIDs.
Needs real units at Amerit / Cummins / TA / Velociti / FleetNet / Goodyear vendors.

### S27-8 — Email Test Mode IPC
`window.email?.getTestMode?.()` / `setTestMode?.()` round-trip not yet tested.
Wiring exists in ipc/email.js — needs live toggle verification.

### S27-9 — PACCAR/Volvo Credential Save/Load
UI renders correctly (S25-5). Save → encrypted store → load back not yet verified live.
4 sanity checks needed for IPC round-trip shape.

### S27-10 — orcha_learn Vendor Pipeline (Stretch)
`orcha:suggest-vendor` never called from renderer.
`vendor.suggestVendor(unit)` → wr-modal pre-select wiring is a Stage 28 stretch goal.

---

## Files Changed This Session

```
src/scrapers/setLifecycle.js       S27-5: removed appendFileSync + stale logPath
src/scrapers/relay.js              S27-4: header comment confirming logger migration
renderer/src/js/components/
  vendor-activity-bar.js           S27-3: stub label + vab__pill--stub class
renderer/src/css/fleet.css         S27-3: .vab__pill--stub CSS rule
docs/STAGE27_COMPLETION.md         this file
```

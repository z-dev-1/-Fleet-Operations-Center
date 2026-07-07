# Fleet Ops V-C — Stage 26 Completion Record

**Date:** 2026-06-30
**Commits:** `102c800` (S26 core) → `4730cdc` (vendor URL map) → `1fee837` (portal fallback)
**Sanity suite:** 956/956 (42 new S26 checks; 1 pre-existing static onclick warning, non-blocking)
**Baseline:** Stage 25 complete — `46f8141`, tag `renderer-stage25-complete`, 914/914

---

## Overview

Stage 26 addressed three independent problem areas:

| Sub-stage | Problem | Deliverable |
|---|---|---|
| S26-A | `fuelType`, `engineManufacturerName`, `domicileSite` always blank | AAP 2-phase intercept + `withRetry` |
| S26-B | Topbar + gear modal missing from renderer | `init.js`, `domicile-modal.js` wired in |
| S26-C | Vendor URL map had 13 dead TODO entries + no portal fallback in modal | `VENDOR_PORTAL_URLS`, IPC chain, async modal fallback |

---

## S26-A — AAP fuelType Fix (2-phase intercept)

### Root cause
`AAP_COL_KEY` / `AAP_COL_VALUE` localStorage constants were defined in `aap.js` but never
injected before the page loaded — dead code. AAP rendered its default 6-column view which
omits `fuelType`, `engineManufacturerName`, and `domicileSite`. Even when injected post-load,
React had already rendered and `window.__AAP_ASSETS__` was never populated.

### Fix

**Phase 1 — dom-ready (before React mounts)**
- Inject `AAP_COL_KEY` / `AAP_COL_VALUE` into `localStorage` immediately
- Simultaneously inject `fetch` + `XHR` interceptor that captures
  `window.__AAP_ASSETS__` from the first `/api/v2/assets/search` response

**Phase 2 — did-finish-load (after React renders)**
- Poll `window.__AAP_ASSETS__` at 50ms × 60 (3s window)
- **Hit:** map raw API items from `r.asset.attributesText` directly — no DOM scraping
- **Miss:** fall back to `pollAndScrape` (existing DOM path, unchanged)

**`AAP_SCAN_URL`** hardcoded with page UUID `bafc8b2a-3be6-4a52-a86f-7cb2de7b5400` and
`fields=[domicileSite, fuelType, engineManufacturerName, bodyType]` baked into query params.
`buildScanURL(domiciles)` appends `&search=<lc+joined>` when domiciles are configured.

**Row mapper** (`r.asset.attributesText` key-value bag):

| Field | Source path |
|---|---|
| `fuelType` | `attr.fuelType \| a.fuelType` |
| `bodyType` | `attr.bodyType \| a.bodyType \| a.assetType` |
| `domicileSite` | `attr.domicileSite \| attr.domicile \| a.domicileSite` |
| `engineManufacturer` | `attr.engineManufacturerName \| attr.engineManufacturer` |
| `dueDate` | built from `r.maintenanceScheduleStatuses[]` |
| `openUnplanned / Planned` | counts from `r.payload.*WorkRequestIds[]` |

**`withRetry` wrapper**
- 3 attempts, 5s base backoff (doubles per retry)
- Fresh `BrowserWindow` per attempt — destroyed on error/timeout
- Master timeout bumped 180s → 240s

Same pattern applied to `geofence_scraper.js` (3 attempts, 8s backoff; `AUTH_REQUIRED` bypasses retry).

### Data flow (post-fix)
```
AAP BrowserWindow
  dom-ready
    -> inject localStorage col config (AAP_COL_KEY/VALUE)
    -> inject fetch/XHR interceptor -> window.__AAP_ASSETS__
  did-finish-load
    -> poll __AAP_ASSETS__ (50ms x 60)
    -> hit:  attributesText -> { fuelType, bodyType, domicileSite, engineManufacturer, dueDate }
    -> miss: pollAndScrape (DOM fallback)
  -> scrapeAAP withRetry (3 attempts)
  -> _mapAAPRows -> normalized row
  -> fleet:data IPC (partial=aap)
  -> fleet-bridge.js mergeRows -> { fuelType, bodyType, aapId, assetUrl }
  -> table: Body Type + Fuel columns rendered
```

---

## S26-B — Renderer Topbar + Gear Modal

**`renderer/src/js/init.js`** (v2A.1) — new file
- Sync status bar (`fo-sync-bar` / `fo-sync-fill`) with progress fill
- Sync indicator pill (`fo-sync-ind`) with state classes (syncing / ok / error)
- Midway auth badge (`fo-auth-badge`) reflecting `auth:mwinit-status`
- `_orchaBus` event wiring: `fleet:status`, `fleet:data`, `fleet:error`,
  `auth:mwinit-status`, `ui:unit-select`, `ui:unit-deselect`
- `window._foInit` public API

**`renderer/src/js/domicile-modal.js`** (v2B.2) — new file
- Gear modal with 3 tabs: **Domicile** / **Operators** / **SharePoint**
- Domicile tab: textarea + Save & Sync + Reset + email test mode toggle
- Operators tab: per-operator recipient config with per-domicile overrides
- SharePoint tab: push target configuration
- Bridges to `window.settings` / `window.email` / `window.sp` IPC; `localStorage` fallback

Both files wired into `renderer/src/index.html` as script tags at end of body.

**`run_aap_scrape.js`** — standalone Electron test harness
- Runs `scrapeAAP` in isolation (no UI required)
- Writes `aap_headers.json` + `aap_rows_sample.json` to `~/Downloads/`
- Used to verify `fuelType` / `engineManufacturer` / `domicileSite` field population

---

## S26-C — Vendor URL Map + Portal Fallback

### VENDOR_IDS expansion (`src/scrapers/aap_create_wr.js`)

| Before | After |
|---|---|
| 15 entries, 14 blank TODOs | **34 entries** |
| Keys mismatched relay.js scrape values | Keys match raw cell text from `relay.js:383` |
| No alias coverage | Full alias set: raw scrape + Decisiv workflow + legacy keys |

`supplierIds` remain empty for all vendors except Cox — they require capture from live
`createRepair` API responses. Each entry is annotated with its source and capture instructions.

### VENDOR_PORTAL_URLS (new, 21 entries)

Informational portal URL map for non-Decisiv vendors:

| Vendor | URL |
|---|---|
| Amerit | `ameritfs.com` |
| Cummins | `cumminscare.com` |
| TA | `ta-petro.com/fleet/fleet-services` |
| Velociti | `velociti.com` |
| FleetNet | `fleetnet.com` |
| Goodyear | `commercialtire.goodyear.com` |
| Freightliner | `dtnaparts.com` |
| Kenworth | `kenworth.com/owners` |
| Peterbilt | `peterbilt.com/owners` |
| Mack | `macktrucks.com` |
| International/Navistar | `internationaltrucks.com/dealers` |
| RENTAL / KOONER / PCSR / CEI / RTS | empty (no public portal) |

PACCAR + Volvo portals remain in `src/vendors/index.js PORTAL_URLS` (automated Decisiv flows).

### IPC chain: `vendor:portal-urls`

```
renderer  getPortalUrl('Amerit')
  └─> vendor-bridge.js getPortalUrl()      cached after first call (_portalUrlCache)
      └─> window.vendor.getPortalUrls()    preload.js
          └─> ipcRenderer.invoke('vendor:portal-urls')
              └─> src/ipc/scrapers.js handler
                  └─> VENDOR_PORTAL_URLS   aap_create_wr.js
```

### vendor-review-modal portal fallback (async `open()`)

`open()` is now async. Before building HTML it resolves a portal URL fallback
for vendors that have no automated Decisiv workflow:

**Three portal section variants:**

| Condition | Section rendered |
|---|---|
| `payload.portalUrl` present (Decisiv) | "Open portal window ↗" — reopens `BrowserWindow` |
| fallback URL resolved (non-Decisiv) | "Open [Vendor] portal ↗" — opens in system browser |
| neither | Portal section omitted |

**unit-detail.js** async wiring:
- `_showApproveCancel` → `async function`
- `openVendorReview(...)` → `await openVendorReview(...)`
- `bus.on('vendor:review-ready', ...)` → `async (p) =>` + `await _showApproveCancel(...)`

---

## Files Changed (full stage)

### Main process

| File | Change |
|---|---|
| `src/scrapers/aap.js` | Full rewrite `_scrapeAAPOnce`; `AAP_SCAN_URL` hardcoded; `buildScanURL`; `withRetry`; 2-phase intercept |
| `src/scrapers/aap_create_wr.js` | `VENDOR_IDS` 15→34 entries; `VENDOR_PORTAL_URLS` (new, 21 entries); `module.exports` updated |
| `src/scrapers/geofence_scraper.js` | `_scrapeGeofencesOnce` extracted; `withRetry` (3 attempts, 8s backoff) |
| `src/ipc/scrapers.js` | `GEOFENCE_IPC_TIMEOUT` 90s→200s; `Promise.race` removed; `vendor:portal-urls` handler (new) |
| `src/ipc/misc.js` | `fuelType` added to enrichment row shape |
| `src/window/index.js` | `_assetUrl` passthrough in `_mapAAPRows` |

### Renderer

| File | Change |
|---|---|
| `renderer/src/js/fleet-bridge.js` | `mergeRows` maps `fuelType`/`bodyType`/`assetUrl`/`aapId`; table adds Body Type + Fuel columns; toast suppressed during partial syncs |
| `renderer/src/js/dev-mock.js` | Rewrite: partial-sync simulation (AAP→Uptake→Relay batches); `signalReady` triggers `run()` |
| `renderer/src/js/init.js` *(new)* | v2A.1 — sync status bar, auth badge, bus wiring, `window._foInit` |
| `renderer/src/js/domicile-modal.js` *(new)* | v2B.2 — gear modal: Domicile/Operators/SharePoint tabs |
| `renderer/src/js/vendor-bridge.js` | `getPortalUrl(vendorName)` exported; `_portalUrlCache` session cache |
| `renderer/src/js/views/vendor-review-modal.js` | `open()` async; `_buildHTML` 3-variant portal section; import from `vendor-bridge.js` |
| `renderer/src/js/views/unit-detail.js` | `_showApproveCancel` async; `await openVendorReview`; `bus.on` handler async |
| `renderer/src/index.html` | `init.js` + `domicile-modal.js` script tags wired in |

### Other

| File | Change |
|---|---|
| `preload.js` | `window.vendor.getPortalUrls()` exposed |
| `vite.config.js` | `hmr.overlay: false`, `allowedHosts: true` |
| `run_aap_scrape.js` *(new)* | Standalone Electron test harness for AAP scraper |
| `tests/sanity_check.py` | +42 S26 checks (VID1-15, VPU1-8, IPC1-2, PL1-2, VB1-3, RM1-8, UD1-4); S23-RM1 updated to accept async export |

---

## Sanity Suite

**956/956 pass** — 42 new S26 checks added.
1 pre-existing warning: static `tbody` row `onclick` — non-blocking.

---

## Pending (live test — Windows only)

- [ ] Run `node run_aap_scrape.js` on Windows
- [ ] Verify `~/Downloads/aap_headers.json` contains `fuelType`, `engineManufacturer`, `domicileSite`
- [ ] Verify `~/Downloads/aap_rows_sample.json[0].fuelType` is non-empty string
- [ ] Capture `supplierId` for Amerit from next live `createRepair` response

---

## Known Gaps (carry-forward)

| Item | Notes |
|---|---|
| `VENDOR_IDS` supplier UUIDs | 33 of 34 entries blank — require capture from live WR API responses |
| `vendor-activity-bar.js` stub label | `review-ready:stub` step label needs real workflow step mapping |
| `relay.js` Linux `appendFileSync` crash | Fix in `relay_patched.js` on local Windows machine — not yet committed |
| `vr-link--external` CSS | Class applied but no dedicated style rule yet — inherits `vr-link` |

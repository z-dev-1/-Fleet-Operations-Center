# Phase 5: Monolith Split Plan

## Status: Reference files extracted, wiring deferred to live-test session

## Why deferred:
- All 4 monoliths use shared closures (local variables referenced across functions)
- Splitting requires converting closures to explicit parameter passing
- Each split needs live testing to catch broken references
- Risk of data loss / app crash if done without incremental verification

## Ready-to-wire extracts:

### src/scrapers/relay/ (4 files)
- `scrape-garage-list.js` — scrapes AAP garage page list
- `resolve-service-u-u-i-d.js` — looks up Relay service UUID for a unit
- `scrape-unit-page.js` — scrapes individual unit detail from Relay
- `scrape-relay.js` — orchestrates full Relay scrape

**Blocker:** All share `page` (Playwright), cookies, config, and helper functions from parent scope.
**Solution:** Create a `RelayContext` class that holds shared state, pass to each function.

### renderer/src/js/views/settings/ (4 files)
- `sp.js` — SharePoint workbook configuration
- `asana.js` — Asana integration wiring
- `notifications.js` — Notification preferences
- `accounts.js` — Account management

**Blocker:** All reference `_drawer`, `settingsBridge`, `bus` from parent scope.
**Solution:** Pass `{ drawer, bridge, bus }` context object to each.

### renderer/src/js/views/unit-detail/ (2 files)
- `repair-pane.js` — Repair status, timeline, vendor workflow
- `intel-pane.js` — AI insights, risk dial, uptake screenshot

**Blocker:** 56 functions share `_esc`, `_riskBadge`, state variables.
**Solution:** Extract shared utils to `unit-detail-utils.js`, import in each pane.

### src/window/index.js (not extracted)
**Blocker:** 7 BrowserWindows share mainWindow reference, tray, lifecycle state.
**Solution:** Window registry pattern — each window type in own file, registry manages lifecycle.

## Next steps:
1. Pick ONE file (settings.js recommended — lowest risk)
2. Extract shared deps into settings-utils.js
3. Convert one tab function at a time
4. Test after each conversion
5. Repeat for other monoliths

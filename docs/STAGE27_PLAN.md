# Fleet Ops V-C — Stage 27 Planning

**Date:** 2026-06-30
**Baseline:** Stage 26 complete — `cd5bdcf`, tag `renderer-stage26-complete`, 956/956
**Branch:** `main`

---

## Current State Summary

| Area | Status |
|---|---|
| Sanity suite | 956/956 ✅ |
| AAP 2-phase intercept | ✅ committed — pending Windows live test |
| Vendor URL map | ✅ 34 entries — 33 supplierIds still blank (need live capture) |
| Portal fallback in review modal | ✅ async open() + 3-variant portal section |
| `vr-link--external` CSS | ⚠ class applied, no rule — inherits `vr-link` |
| Vendor activity bar stub label | ⚠ `review-ready:stub` → "Awaiting review" (functional, not ideal) |
| `relay.js` Linux crash | ✅ already cleaned up — `appendFileSync` not present in relay.js (false carry-forward) |
| Setup wizard | ✅ S25-13 complete — works, tested |
| `bridge.js` `getPortalUrl` re-export | ⚠ not re-exported from bridge.js — only direct import from vendor-bridge |

---

## Proposed Stage 27 Focus: Polish + Production Hardening

Stage 26 closed the last major feature gap (fuelType + portal fallback).
Stage 27 should be a **tightening pass** — no new subsystems, just hardening the
existing stack for real daily use.

---

## Sub-stages

### S27-1 — CSS: `vr-link--external` + vr-badge unknown colors

**Effort:** XS (< 30 min)
**Files:** `renderer/src/css/fleet.css`

What to add:
```css
/* S27-1: external portal link — distinguish from Decisiv window-reopen link */
.vr-link--external::after { content: ' ↗'; font-size: 9px; }
.vr-link--external { color: var(--txt2); font-style: italic; }
.vr-link--external:hover { color: var(--acc2); text-decoration: underline; }

/* vendor badge for non-Decisiv vendors (currently inherits --unknown gray) */
.vr-badge--amerit   { background: rgba(255,166,87,.1); color: var(--org);  border-color: rgba(255,166,87,.25); }
.vr-badge--cummins  { background: rgba(126,231,135,.1); color: var(--grn); border-color: rgba(126,231,135,.25); }
.vr-badge--ta       { background: rgba(210,168,255,.1); color: var(--pur); border-color: rgba(210,168,255,.25); }
```

Also: `_vendorMeta()` in vendor-review-modal already returns `cls: 'unknown'` for
non-Decisiv vendors — add a lowercase key lookup so `amerit` → `vr-badge--amerit`.

---

### S27-2 — `bridge.js` re-export of `getPortalUrl`

**Effort:** XS
**Files:** `renderer/src/js/bridge.js`

`vendor-review-modal.js` imports directly from `vendor-bridge.js` (correct).
But other views that may need `getPortalUrl` in future will look in `bridge.js`.
Add:

```js
export { vendor, getPortalUrl } from './vendor-bridge.js';
```

---

### S27-3 — Vendor activity bar: real step label mapping

**Effort:** S
**Files:** `renderer/src/js/components/vendor-activity-bar.js`

Current stub:
```js
'review-ready:stub': 'Awaiting review',
```

Problem: the `_stubbed` flag on `vendor:review-ready` payloads indicates the
orchestrator fell back to a stub path (S23-3 pre-stub). The label is "Awaiting review"
— same as the real path — so ops can't tell if a workflow is genuinely at the review
gate or stuck in a stub.

Fix:
- `STEP_LABELS['review-ready:stub']` → `'Review (stub)'` with distinct pill styling
- Add `vab__pill--stub` CSS class when `p.step === 'review-ready:stub'`
- Pill background: `rgba(210,168,255,.12)` (purple tint, same as stub badge in modal)

---

### S27-4 — `relay.js` carry-forward cleanup

**Effort:** S
**Files:** `src/scrapers/relay.js`, `docs/STAGE26_COMPLETION.md` (update known gaps)

Audit confirmed: no `appendFileSync` crash in relay.js — already migrated to
`logger`. The `relay_patched.js` reference in carry-forwards was stale.

Action:
- Add comment at top of `relay.js` confirming the logger migration
- Remove the stale carry-forward from the known gaps list
- Verify `src/scrapers/setLifecycle.js` `appendFileSync` at line 95 is safe
  (it's a debug log write, not a crash path — but should be migrated to logger)

---

### S27-5 — `setLifecycle.js` appendFileSync → logger

**Effort:** S
**Files:** `src/scrapers/setLifecycle.js`

```js
// Line 95 — replace:
fs.appendFileSync(logPath, '[SetLifecycle] Result: ' + JSON.stringify(result) + '\n');
// With:
logger.info('[SetLifecycle] Result:', result);
```

Also audit the `logPath` variable — confirm it's correctly resolved or remove
the `fs` require from setLifecycle.js if no longer needed.

---

### S27-6 — Windows live test gate: AAP fuelType verification

**Effort:** M (requires Windows machine)
**Files:** `run_aap_scrape.js`, `docs/STAGE27_COMPLETION.md`

Steps:
1. Run `node run_aap_scrape.js` on Windows
2. Check `~/Downloads/aap_headers.json` for `fuelType`, `engineManufacturer`, `domicileSite`
3. Check `~/Downloads/aap_rows_sample.json[0].fuelType` is non-empty
4. If any field missing: inspect `__AAP_ASSETS__` intercept logic, adjust field paths
5. Add 3–5 new S27 sanity checks reflecting confirmed field names
6. If all pass: remove the Windows-only caveat from STAGE26_COMPLETION.md

**This is the highest-priority real-world verification before Stage 28.**

---

### S27-7 — Supplier ID capture tooling

**Effort:** M
**Files:** `src/scrapers/aap_create_wr.js`, `run_aap_scrape.js` or new `run_capture_supplier_ids.js`

33 of 34 `VENDOR_IDS` entries are blank. Each requires a live `createRepair` call
to capture the `supplierId` UUID from the response.

Build a capture helper:
- A small test harness `run_capture_supplier_ids.js` that:
  1. Reads `~/Downloads/aap_rows_sample.json` (output of run_aap_scrape.js)
  2. Groups units by vendor
  3. For each vendor with a blank supplierId, prints: "Found unit X for vendor Y — run WR?"
  4. If run interactively: calls `createWorkRequest` with a dry-run flag
     (no actual WR submission — just enough to get the supplierId from the
     pre-submission validation response, or from the network log)
- Alternatively: log supplierId from any real `createRepair` response in `aap_create_wr.js`
  and write it to a capture file for manual backfill

---

### S27-8 — Email test mode persistence fix

**Effort:** S
**Files:** `renderer/src/js/domicile-modal.js`

Current: email test mode toggle state is read from `localStorage.getItem('fleetTestMode')`
on tab render, but the `window.applyGlobalTestMode` call may not reach the email
bridge if it isn't loaded yet.

Fix:
- On modal open, call `window.email?.getTestMode?.()` to get authoritative state
  (IPC-sourced, not just localStorage)
- On toggle, call `window.email?.setTestMode?.(on)` + localStorage as fallback
- Confirm `ipc/email.js` has `email:get-test-mode` and `email:set-test-mode` handlers

---

### S27-9 — Settings panel: vendor credential save/load wiring

**Effort:** M
**Files:** `renderer/src/js/views/settings.js`, `src/ipc/settings.js` or `src/ipc/scrapers.js`

S25-5 added the PACCAR/Volvo credential card UI in Settings. The fields render
but the save/load wiring needs a live test pass:
- Verify `vnd-paccar-user` / `vnd-paccar-pass` save to encrypted store
- Verify `vnd-volvo-user` / `vnd-volvo-pass` save correctly
- Verify status dots update on credential presence
- Add 4 sanity checks confirming the IPC round-trip shape

---

### S27-10 — `orcha_learn.js` vendor/component suggestion pipeline

**Effort:** L (stretch goal)
**Files:** `src/scrapers/orcha_learn.js`, `src/ipc/orcha.js`

`orcha_learn.js` header says:
> 1. Improve future suggestions (vendor, component, status)

The learning pipeline captures WR outcomes for AI suggestion tuning. Audit:
- What data is being written to the learn store?
- Is `orcha:suggest-vendor` IPC actually called from the renderer?
- If not: wire `vendor.suggestVendor(unit)` into the investigation pre-flight
  to pre-select the vendor dropdown in `wr-modal.js`

---

## Priority Order

| Priority | Sub-stage | Effort | Blocks |
|---|---|---|---|
| 1 | S27-6 | M | Everything downstream of fuelType |
| 2 | S27-1 | XS | Visual polish for S26-C |
| 3 | S27-2 | XS | Future view compatibility |
| 4 | S27-3 | S | Activity bar stub clarity |
| 5 | S27-4 | S | Carry-forward cleanup |
| 6 | S27-5 | S | setLifecycle appendFileSync |
| 7 | S27-7 | M | supplierIds — needs real WRs |
| 8 | S27-8 | S | Email test mode reliability |
| 9 | S27-9 | M | Settings credential wiring |
| 10 | S27-10 | L | AI learning pipeline (stretch) |

---

## Recommended Stage 27 Scope

**Must-have (to declare S27 complete):**

- S27-1 CSS polish (XS — do it first, immediate payoff)
- S27-2 bridge re-export (XS)
- S27-3 activity bar stub label (S)
- S27-4 relay.js carry-forward cleanup (S)
- S27-5 setLifecycle logger migration (S)
- S27-6 Windows live test + field verification (M — gating)

**Nice-to-have (if time allows):**

- S27-7 supplier ID capture tooling
- S27-8 email test mode IPC wiring
- S27-9 settings credential wiring

**Stretch (Stage 28 candidate):**

- S27-10 orcha_learn vendor suggestion pipeline

---

## Target Commit Shape

```
S27-1/2: css vr-link--external + vendor badge colors; bridge.js getPortalUrl re-export
S27-3/4/5: activity bar stub label; relay.js carry-forward; setLifecycle logger
S27-6: Windows live test confirmed -- fuelType/engineManufacturer/domicileSite populated
S27-7: supplier ID capture tooling (run_capture_supplier_ids.js)
docs: Stage 27 completion record
[tag] renderer-stage27-complete
```

Target suite: **~975/975** (adding ~19 new S27 checks)

---

## Open Questions Before Starting

1. **Windows test access** — can you run `node run_aap_scrape.js` before S27-1 starts?
   If yes, S27-6 can be first and inform whether the AAP field paths need adjustment.

2. **Supplier ID capture strategy** — do you have a unit currently at an Amerit/Cummins/TA
   vendor that we could use for a real `createRepair` test to capture the supplierId?

3. **S27-9 credential wiring** — did the PACCAR/Volvo credential fields in Settings
   save correctly in any live test, or has this never been tested end-to-end?

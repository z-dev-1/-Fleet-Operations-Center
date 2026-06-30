# Fleet Ops V-C — Stage 23 Completion Record

**Date:** 2026-06-30
**Commits:** `11e07f7` (implementation) + `c9ef1b9` (50 S23 sanity checks)
**Sanity suite:** 50 S23 checks pass within 914/914

---

## 1. What This Stage Was

Stage 23 was the **Dealer WO Engine** — the largest single-stage feature build
in Version C. It introduced an end-to-end automated workflow for creating Dealer
Work Orders via vendor portals (PACCAR Connect / Volvo Decisiv), with a human
review gate before submission.

Six new source files + one new view module, all wired together via a structured
IPC bus (`vendor:*` events).

---

## 2. Architecture

```
fleet.js (context menu)
  └── bus.emit('ui:dealer-wo-request')
        └── unit-detail.js (_tryDealerWO)
              ├── vendors/investigation.js  → eligible? + routing decision
              ├── vendor-review-modal.js    → human approve / cancel
              └── vendors/index.js (IPC)
                    ├── PACCARWorkflow      → scrapes PACCAR Connect
                    └── VolvoWorkflow       → scrapes Volvo Decisiv
                          └── vendor:* events → vendor-bridge.js → bus → unit-detail panel
```

---

## 3. New Files

### `src/vendors/investigation.js`
Eligibility engine. Given a unit, returns `{ eligible, blocking[], warnings[] }`.

**Six assessment points checked:**
1. `unit_data` — has required fields
2. `vendor` — has a routable vendor URL (`ROUTABLE_STATES`)
3. `lifecycle` — unit is in an active/offsite lifecycle state
4. `offsite_match` — `DECISIV_PACCAR_PATTERN` or `DECISIV_VOLVO_PATTERN` detects portal type
5. `relay_wo` — not already an open Relay WO in flight
6. `mileage` — odometer reading present

### `src/vendors/paccar/index.js` — `PACCARWorkflow`
Scrapes PACCAR Connect in a hidden `BrowserWindow`. Phases:
- Login via stored credentials
- Navigate to WO create form
- Populate from unit context
- Pause at `vendor:review-ready` for human gate
- Submit on `vendor:approve`; abort on `vendor:cancel`

### `src/vendors/volvo/index.js` — `VolvoWorkflow`
Same pattern as PACCAR but targets Volvo Decisiv. Uses the `SR → Case → Fleet Estimate`
chain (fully built out in later stages S25-9/12).

Both orchestrators:
- Emit `vendor:progress` events throughout
- Await `approveSignal` promise (resolve = approve, reject = cancel)
- Emit `vendor:complete` or `vendor:error` on finish

### `src/vendors/index.js` — IPC router (`registerVendorIPC`)
- `MAX_CONCURRENT_WORKFLOWS` cap prevents parallel vendor sessions
- `vendor:approve` resolves the `approveSignal` promise by workflow ID
- `vendor:cancel` rejects it
- All `vendor:start-*` calls use `Promise.race(workflow, timeoutAfter(N))`

### `renderer/src/js/vendor-bridge.js`
Renderer-side bridge. Consumes the `window.vendor` preload surface and re-emits
events onto the renderer bus:
- `onProgress` / `onReviewReady` / `onComplete` / `onError` → `bus.emit`
- `_pushHistory(outcome)` stores last 10 outcomes per unit (`HISTORY_MAX = 10`)
- `lastComplete` stored in `state.vendor.lastComplete`

### `renderer/src/js/views/vendor-review-modal.js`
Human-gate modal. Shown when `vendor:review-ready` fires.
- Shows WO summary: unit ID, vendor, portal type, detected duplicates
- `isDuplicate` warning banner (`vr-dup-banner`) if a matching open WO exists
- **Approve** → calls `vendor.approve(workflowId, altId)` → workflow resumes
- **Cancel** → calls `vendor.cancel(workflowId)` → workflow aborts

### `renderer/src/js/components/context-menu.js`
Reusable right-click context menu component.
- Auto-closes on Escape, scroll, outside click
- Flips position near viewport edges (`innerWidth` / `innerHeight` guards)
- `fleet.js` wires `contextmenu` event → emits `ui:dealer-wo-request`

---

## 4. Unit Detail Changes (`unit-detail.js`)

### Vendor panel (`_wireVendorPanel`)
New `dp-vendor-section` in the panel HTML. Wires all `vendor:*` bus listeners.

**Bus leak fix:** Listeners stored in `_vendorUnsubs[]` array.
`_teardownVendorBus()` unsubscribes all on panel re-entry and on `close()`.
This prevented a memory leak where every panel open accumulated a new set of
permanent bus listeners.

### Race guard (`_tryDealerWO`)
`ui:dealer-wo-request` may fire before the panel is fully open (context menu click
on fleet table row). `_tryDealerWO` retries via `requestAnimationFrame` up to 12
frames, storing the pending request in `_pendingDealerWO`.

---

## 5. CSS additions (`fleet.css`)

| Rule | Purpose |
|---|---|
| `.dp-vendor-section` | Vendor panel section wrapper in unit-detail |
| `.vr-modal-overlay` | Full-screen overlay for the review modal |
| `.ctx-menu` | Right-click context menu positioning + shadow |

---

## 6. Sanity Checks (S23) — 50 checks

| Group | Coverage |
|---|---|
| S23-P1–P6 | Preload `window.vendor` surface (6 IPC channels) |
| S23-VB1–VB7 | `vendor-bridge.js` (LF-only, init, vendor object, 4 push listeners, history, bus.emit) |
| S23-I1–I6 | `vendors/index.js` IPC router (registerVendorIPC, concurrent cap, approve/cancel, race+timeout) |
| S23-V1–V5 | `investigation.js` (investigate fn, ROUTABLE_STATES, 6 assessments, return shape, PACCAR+Volvo patterns) |
| S23-OR1–OR4 | Orchestrators (PACCAR + Volvo exports, review-ready emit, approveSignal await) |
| S23-UD1–UD7 | `unit-detail.js` vendor panel (section, wiring fn, unsubs array, teardown, teardown count, push, close) |
| S23-RG1–RG3 | Race guard (_pendingDealerWO, rAF 12-frame retry, bus listener) |
| S23-RM1–RM5 | Review modal (open/close exports, isDuplicate banner, approve call, unit-detail import) |
| S23-CM1–CM4 | Context menu (showContextMenu export, 3 auto-close triggers, edge-flip, fleet.js wiring) |
| S23-CSS1–CSS3 | CSS rules (vendor section, modal overlay, context menu) |

All 50 pass. Suite at S23-checks commit: **804/804**.

---

*Completion record written 2026-06-30.*

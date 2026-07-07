# Fleet Ops V-C — Stage 14 Completion Record

**Date:** 2026-06-29
**Commits:** `da0e705` → `eac31eb` (base); later additions via S25-10/12/13
**Tag:** `renderer-stage14-complete`
**Sanity suite:** 845/845 (30 unique S14 checks + 40 S25 sub-vendor/ASIST checks covering vendors.js additions — zero regressions)

---

## 1. What Was Done

Stage 14 delivered the Vendor Management view (`vendors.js`, 396 lines).
Two base commits, then three later S25-series commits extended the drill table:

| Commit | Description |
|---|---|
| `da0e705` | Step 1 — vendor management view (list + drill, search, metrics, unit links) |
| `eac31eb` | Step 2 — CSS vendor management (strip, table, drill, risk badges, links) |
| `064969b` | S25-10 — ASIST enrichment surfaced in drill table (asistLabel, asistSource badge, offsiteShopEventUrl) |
| `48b3452` | S25-12 — Sub Vendor field (dealer from Decisiv/ASIST, geofence fallback) |
| `40c64e1` | S25-13 — Sub Vendor pill badge column in drill table |

---

## 2. vendors.js — Feature Detail

### Architecture
Pure client-side, two-panel layout. No new IPC.
All vendor data comes from `row.vendor` (relay-merged field) on each fleet row.
Reactive via `fleet:data` and `ui:view-change` bus events.

### LIST view
| Element | Details |
|---|---|
| Summary strip | Vendor count / Units at vendors / High-risk at vendors (3 KPI cards) |
| Vendor table | Name / Units / Unavail / High risk / Avg risk / Total WO cost / Open WOs |
| Search | Live-filters vendor name; resets on view entry from outside |
| Click row | → DRILL view for that vendor |

`_buildVendorMap(rows)` is the core computation:
- groups rows by `row.vendor`
- accumulates `totalCost` (via `_costNum()` → strips `$,`), `unavail`, `highRisk`, `riskSum`, `openWOs`

### DRILL view
| Column | Source field |
|---|---|
| ID | `r.equipmentId` — clickable, emits `navigate:unit` |
| Operator | `r.operator` |
| Site | `r.domicileSite` |
| Lifecycle | `r.lifecycleState` (color-classed: lc--unavailable / lc--available) |
| Reason | `r.lifecycleReason` |
| Risk | `r.riskScore` (risk badge HIGH/MED/LOW) |
| WO # | `r.vendorWorkOrderId` |
| Cause | `r.cause` (truncated to 50 chars with title tooltip) |
| Cost | `r.totalCost` |
| SF Case | `r.salesforceCaseUrl` → anchor link |
| Offsite | `r.savedOffsiteUrl \|\| r.offsiteShopEventUrl` with ASIST label + `[Est]`/`[Case]` badge |
| Sub Vendor | `r.subVendor \|\| r.dealerName` → pill badge |

### Navigation
- List → Drill: click vendor row
- Drill → List: `vm-drill-back-list` button
- Either → Fleet: `vm-back-fleet` / `vm-drill-back-fleet` emit `ui:view-change { to: 'fleet' }`
- Unit ID → fleet drawer: `navigate:unit` + 50ms delay for view transition

### Enter-view reset
When `from !== 'vendors'`, the view resets `_view = 'list'`, clears search input, and calls `_showPanel('list')`.
This ensures navigating back from fleet always returns to the top-level vendor list.

---

## 3. Sanity Checks (S14) — 30 unique checks

| Range | Coverage |
|---|---|
| S14-1 to S14-6 | Module structure + two-panel layout + showPanel |
| S14-7 to S14-14 | List KPIs, vendor table columns, drill summary + table, SF/offsite links |
| S14-15 to S14-23 | Unit links → navigate:unit, back buttons, search, reactivity, enter-reset, helpers |
| S14-24 to S14-30 | CSS: vm-panel, vm-strip/vm-kpi, vm-vendor-row, risk badge variants, vm-table--drill, vm-link, vm-search-input |

All 30 pass. Duplicate block in `sanity_check.py` is inert (same conditions, same result).

**Additional coverage via S25 series (vendors.js additions):**
- S25-10: ASIST label/URL preferred over raw offsiteShopEventUrl; `[Est]`/`[Case]` source badge
- S25-12: `subVendor` + `dealerName` fields present; `vm-sub-vendor-pill` CSS
- S25-13: Sub Vendor column in drill table; `vm-tbl--subvendor` class; `vm-sub-vendor-none` fallback

---

## 4. CSS coverage

All `vm-` prefixed rules present in `fleet.css`:

```
vm-body             vm-cell--accent      vm-cell--cost        vm-cell--danger
vm-cell--warn       vm-drill-scroll      vm-empty             vm-header
vm-header__actions  vm-header__left      vm-kpi               vm-kpi--cost
vm-kpi--risk        vm-kpi--warn         vm-kpi__lbl          vm-kpi__val
vm-link             vm-panel             vm-risk-badge        vm-risk-badge--risk-{high,med,low}
vm-search-input     vm-strip             vm-sub-vendor-none   vm-sub-vendor-pill
vm-subtitle         vm-table             vm-table--drill      vm-tbl--cause
vm-tbl--mono        vm-tbl--r            vm-tbl--reason       vm-tbl--subvendor
vm-title            vm-unit-id           vm-unit-link         vm-vendor-name
vm-vendor-row
```

---

## 5. App.js + Toolbar wiring

- `app.js` imports `initVendors`, calls on boot, routes `vendorsView` in `ui:view-change`
- `toolbar.js`: `tb-vendors` button emits `ui:view-change { to: 'vendors' }`

---

## 6. Sanity Arc

| Stage | Scope | Checks |
|---|---|---|
| 13 | Analytics / KPI dashboard | 845 |
| **14** | **Vendor management** ← just closed | **845** |
| 15 | Schedulers view | next |
| 16 | Document vault | — |
| 17 | Partner portal | — |
| 18 | Full test suite | — |

---

*Completion record written 2026-06-29.*
*Next: Stage 15 — Schedulers view.*

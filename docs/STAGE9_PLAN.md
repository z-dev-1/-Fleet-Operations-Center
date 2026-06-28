# Fleet Ops V-C · Stage 9 — Renderer Foundation: Fleet Table + Unit Detail

**Date:** 2026-06-28  
**Baseline:** Stage 8 complete — 524/524 sanity checks, tag `scraper-resilience-stage8-complete`  
**Scope:** `renderer/src/js/views/fleet.js`, `renderer/src/js/views/unit-detail.js`, `renderer/src/css/fleet.css`

---

## 1. Where We Are

Stages 1–8 have produced a solid backend (IPC hardened, scrapers resilient, auth hardened, adaptive timing). The renderer is functional but thin:

| File | Lines | Gap |
|---|---|---|
| `views/fleet.js` | 162 | Table renders but: no color-coded lifecycle rows, no relay/notes data columns, no sort, no Uptake risk badge, no empty-state, no loading state wired |
| `views/unit-detail.js` | 154 | Panel renders basic fields + notes + 3 stub buttons; WR creation says "not yet wired", no relay WOs, no Uptake insights, no lifecycle change, no AI note preview |
| `views/settings.js` | 148 | Domiciles + mwinit + Orcha config; missing Slack, email, AAP credentials, Asana, notifications |
| `renderer/src/css/fleet.css` | 260 | Minimal scaffold; missing table row colors, detail panel sections, badge styles, status indicators, responsive guards |

The V2 app (`FleetStatus_v5.0.html`, 648KB) has all of these — they just need to be ported systematically into the V-C module tree without bringing in the V2 monolith structure.

**Stage 9 focuses on the two highest-value views: fleet table and unit detail panel.** These are the primary daily-use surfaces. Settings gaps are deferred to Stage 10.

---

## 2. Scope — Stage 9

**Three steps. Three files changed.**

---

### Step 1 — Fleet Table: Visual polish + data completeness

**File:** `renderer/src/js/views/fleet.js`

#### 2.1.1 Lifecycle row coloring

V2 uses color-coded rows for at-a-glance status. V-C's `_lifecycleClass()` already generates the right CSS class names (`lc--available`, `lc--unavailable`, `lc--decommissioned`, `lc--maintenance`) but the fleet.css has no rule for them. Step 1 adds the CSS (Step 3), and this step ensures the class is applied to the `<tr>` element (not just the cell), so the entire row carries the color.

**Current:** class applied to td only via `cell.className = _lifecycleClass(row.lifecycleState)`  
**After:** class applied to `<tr data-lc="${_lifecycleClass(row.lifecycleState)}">` so CSS can target `tr[data-lc="lc--unavailable"] td`

#### 2.1.2 Relay column

Currently the fleet table has no relay/vendor data. The bridge already exports `relay` with `getCache()`. Add a `relayVendor` column that reads from the relay cache on render:

```js
{ key: 'relayVendor', label: 'Vendor / WO',  width: '160px' }
```

Relay data is loaded once on `state:fleet` and merged into rows client-side via a `_relayMap` local variable. The relay cache returns `{ units: { [equipmentId]: { vendor, woStatus, serviceUUID } } }`.

**Merge logic:**
```js
// On state:fleet arrival, load relay cache once
relay.getCache().then((cache) => {
  _relayMap = cache && cache.units ? cache.units : {};
  _render();
}).catch(() => { _relayMap = {}; _render(); });
```

Each row's `relayVendor` cell: `(relayMap[row.equipmentId] || {}).vendor || '—'`

#### 2.1.3 Uptake risk badge

Add a `riskScore` column showing the Uptake risk tier as a colored badge:

```js
{ key: 'riskScore', label: 'Risk',  width: '70px' }
```

Uptake data comes from the same state push as fleet data. If `row.riskScore` is set (merged by sync), render a badge `<span class="badge badge--risk-N">NN</span>` where risk tier N is derived from score (0–39 = low/green, 40–69 = medium/amber, 70–100 = high/red).

If no Uptake data yet: empty cell (no badge). No placeholder text.

#### 2.1.4 Loading state

When `sync.inProgress` is true, the table should show a spinner overlay or a pulsing "Syncing..." row rather than stale data. Wire `state:sync` → toggle `#fleet-table-wrap.syncing` class. CSS handles the visual (Step 3).

#### 2.1.5 Empty state

When rows is empty (first launch, no cache): show a centered empty-state panel:
```html
<div class="fleet-empty">
  <p>No fleet data yet.</p>
  <button id="fleet-sync-now" class="detail-panel__btn">Sync Now</button>
</div>
```
The `Sync Now` button calls `fleetBridge.forceSync()`.

#### 2.1.6 Column sort

Click a column header → sort ascending by that column; click again → descending. A `▲`/`▼` indicator in the header.

State: `_sortKey = null`, `_sortDir = 'asc'`. Sort applied after filter/search in `_applyFilters()` (which should be renamed `_applyFiltersAndSort()` to be accurate, but the function change is the key thing — no external API change).

Sort is client-side only. No IPC calls.

---

### Step 2 — Unit Detail: Relay WOs + Uptake insights + lifecycle action + Create WR stub

**File:** `renderer/src/js/views/unit-detail.js`

#### 2.2.1 Relay work orders section

Add a `Relay Work Orders` section below the unit fields table. On panel open, call `relay.getUnitCache(unit.equipmentId)` (already in bridge) to get cached WO data:

```html
<div class="detail-panel__section">
  <h3>Relay Work Orders</h3>
  <div id="dp-relay-wos" class="dp-relay-list"></div>
</div>
```

Each WO rendered as a compact card:
```html
<div class="dp-relay-card">
  <span class="dp-relay-card__vendor">Speedy's Fleet Service</span>
  <span class="dp-relay-card__status badge badge--wo-open">Open</span>
  <span class="dp-relay-card__desc">Brake inspection</span>
  <span class="dp-relay-card__age">12 days</span>
</div>
```

If no relay data: `<p class="dp-empty">No open work orders in Relay.</p>`

#### 2.2.2 Uptake insights section

Add an `Uptake Insights` section. Call `files.getLatestScreenshot()` for the thumbnail, and surface `unit.riskScore` + `unit.insights` (array from Uptake sync).

```html
<div class="detail-panel__section">
  <h3>Uptake Insights  <span id="dp-risk-badge"></span></h3>
  <ul id="dp-insights-list" class="dp-insights-list"></ul>
</div>
```

Each insight: `<li class="dp-insight"><span class="dp-insight__type">[type]</span> [summary]</li>`

If `unit.riskScore` is set, render a badge in the heading.  
If no insights: `<p class="dp-empty">No active Uptake insights.</p>`

#### 2.2.3 Lifecycle change action

Replace the stub "Create WR" toast with a real lifecycle-change trigger. The panel already has `aap.setLifecycle` in bridge. Add a `Change Lifecycle` button that opens a small inline form:

```html
<div id="dp-lc-form" class="dp-lc-form" style="display:none">
  <select id="dp-lc-state">
    <option value="Available">Available</option>
    <option value="Unavailable">Unavailable</option>
  </select>
  <input id="dp-lc-reason" type="text" placeholder="Reason..." />
  <button id="dp-lc-confirm" class="detail-panel__btn">Confirm</button>
  <button id="dp-lc-cancel"  class="detail-panel__btn detail-panel__btn--secondary">Cancel</button>
</div>
```

On confirm: call `aap.setLifecycle(unit.equipmentId, unit.assetUrl, state, reason)` → toast success/error. The lifecycle form replaces the quick-actions button area while open.

#### 2.2.4 AI note preview

The AI `suggest` button currently shows raw JSON. Wire it properly:
- Show a loading spinner while `ai.suggest(unit)` is in flight
- On success: render the suggestion text (string) in a styled card with a "Copy" button
- On error: show the error message without "Error: " prefix (already done via `e.message`)
- Add an "Ask Orcha..." free-text input next to the AI Suggest button → calls `ai.ask(prompt)` with unit context prepended

#### 2.2.5 Create WR button

Remove the "not yet wired" toast. Replace with a call to `aap.autofill(unit.assetUrl, payload)` where `payload` is a minimal WR object pre-filled from unit data (manufacturer → vendor lookup, equipmentId, domicileSite). This opens the AAP autofill flow exactly as V2 does. The full WR modal (with vendor selection, PM banners, etc.) is Stage 11 scope — this is the "get into AAP" button, not the full modal.

---

### Step 3 — CSS: Row colors, badges, panel sections, responsive guards

**File:** `renderer/src/css/fleet.css`

This is the largest change in lines, smallest in risk. All CSS is additive — no existing rules are modified.

#### 2.3.1 Lifecycle row colors

```css
/* Row-level lifecycle coloring via data attribute on <tr> */
tr[data-lc="lc--unavailable"] td   { background: rgba(220, 38, 38, 0.08); }
tr[data-lc="lc--available"] td     { background: rgba(34, 197, 94, 0.06); }
tr[data-lc="lc--decommissioned"] td{ background: rgba(107, 114, 128, 0.10); }
tr[data-lc="lc--maintenance"] td   { background: rgba(251, 191, 36, 0.10); }
```

#### 2.3.2 Badges

```css
.badge { display: inline-block; padding: 2px 7px; border-radius: 10px; font-size: 11px; font-weight: 600; }
.badge--risk-low    { background: #d1fae5; color: #065f46; }
.badge--risk-medium { background: #fef3c7; color: #92400e; }
.badge--risk-high   { background: #fee2e2; color: #991b1b; }
.badge--wo-open     { background: #dbeafe; color: #1e40af; }
.badge--wo-closed   { background: #f3f4f6; color: #6b7280; }
```

#### 2.3.3 Syncing overlay

```css
.fleet-table-wrap.syncing::after {
  content: '';
  position: absolute; inset: 0;
  background: rgba(22, 27, 34, 0.55);
  display: flex; align-items: center; justify-content: center;
  z-index: 10;
}
/* pulsing "Syncing..." bar at top of table */
.fleet-table-wrap.syncing::before {
  content: 'Syncing...';
  /* ... accent bar styling ... */
}
```

#### 2.3.4 Detail panel sections

```css
.detail-panel__section  { padding: 16px 0; border-bottom: 1px solid #2d333b; }
.dp-relay-list          { display: flex; flex-direction: column; gap: 6px; }
.dp-relay-card          { background: #1c2128; border-radius: 6px; padding: 8px 12px; ... }
.dp-insights-list       { padding-left: 18px; }
.dp-insight             { margin: 4px 0; font-size: 13px; }
.dp-lc-form             { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.detail-panel__ai-result{ background: #1c2128; border-radius: 6px; padding: 12px; margin-top: 8px; }
.dp-empty               { color: #6b7280; font-style: italic; font-size: 13px; }
```

#### 2.3.5 Sort indicators

```css
.fleet-table th.sort-asc::after  { content: ' ▲'; font-size: 10px; }
.fleet-table th.sort-desc::after { content: ' ▼'; font-size: 10px; }
th.sortable { cursor: pointer; user-select: none; }
th.sortable:hover { background: #2d333b; }
```

#### 2.3.6 Empty state

```css
.fleet-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 200px; gap: 12px; color: #8b949e; }
```

---

## 3. What Stage 9 Does NOT Cover

| Item | Reason / Stage |
|---|---|
| Full WR creation modal (vendor select, PM banners, Uptake screenshots) | Stage 11 |
| Settings view gaps (Slack, email SMTP, AAP credentials, Asana) | Stage 10 |
| Email composer view | Stage 12 |
| Analytics / KPI dashboard | Stage 13 |
| Vendor management view | Stage 14 |
| Partner portal view | Stage 15 |
| Document vault view | Stage 16 |
| Schedulers (auto-email, auto-SP-push) | Stage 17 |
| Full CSS port from V2 (82KB → V-C equivalents) | Ongoing, parallel with each stage |
| Tests | Stage 18 |

---

## 4. Sanity Checks — Stage 9

**Projected: +18 new checks → 542/542 in main suite**

### Step 1 — fleet.js

| ID | Check | File |
|---|---|---|
| S9-1a | `data-lc` attribute applied to `<tr>` element | `fleet.js` |
| S9-1b | `_relayMap` variable present | `fleet.js` |
| S9-1c | `relay.getCache()` called on fleet data arrival | `fleet.js` |
| S9-1d | `relayVendor` column in COLS array | `fleet.js` |
| S9-1e | `riskScore` column in COLS array | `fleet.js` |
| S9-1f | `fleet-table-wrap.syncing` toggle on sync state | `fleet.js` |
| S9-1g | Fleet empty-state element present | `fleet.js` |
| S9-1h | Column sort click handler present | `fleet.js` |

### Step 2 — unit-detail.js

| ID | Check | File |
|---|---|---|
| S9-2a | `dp-relay-wos` section present | `unit-detail.js` |
| S9-2b | `dp-insights-list` section present | `unit-detail.js` |
| S9-2c | Lifecycle change form present (`dp-lc-form`) | `unit-detail.js` |
| S9-2d | `aap.setLifecycle` called on confirm | `unit-detail.js` |
| S9-2e | AI suggest shows spinner while in-flight | `unit-detail.js` |
| S9-2f | "not yet wired" toast removed | `unit-detail.js` |
| S9-2g | `aap.autofill` called from Create WR | `unit-detail.js` |

### Step 3 — fleet.css

| ID | Check | File |
|---|---|---|
| S9-3a | `tr[data-lc="lc--unavailable"]` rule present | `fleet.css` |
| S9-3b | `.badge--risk-high` rule present | `fleet.css` |
| S9-3c | `.fleet-empty` rule present | `fleet.css` |

---

## 5. Files Changed

| File | Changes |
|---|---|
| `renderer/src/js/views/fleet.js` | relay/risk columns, row coloring, sort, loading/empty states |
| `renderer/src/js/views/unit-detail.js` | relay WOs, Uptake insights, lifecycle form, AI wired, Create WR |
| `renderer/src/css/fleet.css` | row colors, badges, syncing overlay, panel sections, sort indicators |

No backend files change. No IPC changes. All work is renderer-only.

---

## 6. Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| Relay cache returns null/unexpected shape | Low | All relay/Uptake reads guarded with `.catch(() => {})` + empty-data fallback paths |
| CSS specificity conflicts with existing rules | Low | New rules use distinct selectors (data attributes, new class names) — no overwrites |
| `aap.autofill` call fails if unit has no `assetUrl` | Low | Guard: `if (!unit.assetUrl) { toast.show('warn', ...); return; }` same as existing AAP open button |
| Sort on large (400+ row) fleets causes jank | Very low | Client-side array sort is synchronous and completes in <1ms for 400 objects on any modern JS runtime |
| Lifecycle form open while panel animates | Very low | Form starts `display:none`; triggered only by button click after panel is fully rendered |

---

## 7. Commit Plan

| Commit | Description |
|---|---|
| Step 1 | `feat(renderer): Stage 9 Step 1 -- fleet table relay/risk columns, row colors, sort, empty/loading states` |
| Step 2 | `feat(renderer): Stage 9 Step 2 -- unit detail relay WOs, Uptake insights, lifecycle form, Create WR` |
| Step 3 | `feat(renderer): Stage 9 Step 3 -- CSS fleet table row colors, badges, syncing overlay, panel sections` |
| Tag | `renderer-stage9-complete` |

---

*Document written 2026-06-28. Predecessor: STAGE8_COMPLETION.md.*  
*Stage 9 opens the renderer build arc. Stages 9–17 will close the V2 feature gap.*

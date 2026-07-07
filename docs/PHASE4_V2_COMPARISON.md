# Phase 4 — Version 2 vs Version C Comparison

**Date:** 2026-07-01
**V2 Location:** `C:\Users\zilasant\zila-fleet-app` (1.7MB monolith panel.js)
**V-C Location:** `C:\Users\zilasant\fleet-version-c` (modular, 80+ files)

---

## Architecture Comparison

| Aspect | Version 2 | Version C | Verdict |
|--------|-----------|-----------|---------|
| **Structure** | Single 1.7MB `panel.js` monolith + `renderer.js` | 80+ modular ES/CJS files | **V-C far superior** |
| **UI Framework** | Inline HTML strings in JS, manual DOM | Modular views + components, bus event system | **V-C far superior** |
| **State Management** | Global `InventoryModule.rows`, `RelayModule.data` | Centralized `state.js` + bus events | **V-C far superior** |
| **Data Store** | `GM_getValue/GM_setValue` + localStorage + `better-sqlite3` | Atomic JSON store with registry + encrypted creds | **V-C far superior** |
| **Auth** | Edge cookie bridge (SQLite DB read) + client cert | Midway auth + session management + auto-login engine | **V-C far superior** |
| **Scraping** | Hidden BrowserWindow fetch + userscript WS bridge | 27 dedicated scrapers with Playwright | **V-C far superior** |
| **IPC** | Minimal (4-5 channels) | 50+ validated IPC handlers with safety wrappers | **V-C far superior** |
| **AI** | None | Full Bedrock-powered Orcha engine (deep scan, priority, learning) | **V-C far superior** |
| **Testing** | None | `tests/sanity_check.py` (117KB) | **V-C better** |
| **Security** | No input validation, raw file paths | Context isolation, input validation, path containment | **V-C far superior** |

---

## Module-by-Module Feature Comparison

### InventoryModule (V2) → Fleet View (V-C)

| Feature | V2 | V-C | Status |
|---------|----|----|--------|
| Fleet table with sortable columns | ✅ | ✅ | Parity |
| Lifecycle state color rows | ✅ | ✅ | Parity |
| Risk score column | ✅ | ✅ | Parity |
| Filter by operator | ✅ | ✅ | Parity |
| Filter by domicile | ✅ | ✅ | Parity |
| Filter by lifecycle state | ✅ | ✅ | Parity |
| Search | ✅ | ✅ | Parity |
| PM due dates (B/X/DOT/Quarterly) | ✅ | ✅ | Parity |
| Body type breakdown | ✅ | ✅ | Parity |
| Pinning units to top | ✅ | ✅ | Parity |
| Heatmap mode | ✅ | ❌ | **V2 has, V-C missing** |
| Breach forecast overlay | ✅ | ❌ | **V2 has, V-C missing** |
| Bulk relay status change | ✅ | ❌ | **V2 has, V-C missing** |
| Select-all checkboxes | ✅ | ❌ | **V2 has, V-C missing** |
| Export CSV | ✅ | ❌ | **V2 has, V-C missing** |
| Import JSON | ✅ | ❌ | **V2 has, V-C missing** |
| Average fleet age KPI | ✅ | ❌ | **V2 has, V-C missing** |
| Geofence column | ❌ | ✅ (S28) | **V-C added** |
| Progressive live updates | ❌ | ✅ | **V-C superior** |
| Priority drawer (left panel) | ❌ | ✅ | **V-C superior** |

### RelayModule (V2) → Relay Scraper + Cache (V-C)

| Feature | V2 | V-C | Status |
|---------|----|----|--------|
| Live relay page scanning | ✅ (in-page) | ✅ (BrowserWindow) | Parity |
| Work order detail extraction | ✅ | ✅ | Parity |
| Vendor identification | ✅ | ✅ | Parity |
| Duration calculation | ✅ | ✅ | Parity |
| Alternative ID (AMZ-) extraction | ✅ | ✅ | Parity |
| Issue detail parsing | ✅ | ✅ | Parity |
| WO tabs (Unplanned/Planned/All) | ✅ | ✅ | Parity |
| Relay status pill editing (inline) | ✅ | ❌ | **V2 has, V-C missing** |
| Auto-scan on page navigation | ✅ | ✅ | Parity |
| Cache persistence | ✅ (GM_setValue) | ✅ (relay_cache.json) | Parity |
| Parallel batch scraping | ❌ | ✅ | **V-C superior** |
| Progressive batch updates to UI | ❌ | ✅ | **V-C superior** |

### RcaReadyModule (V2) → No Direct Equivalent (V-C)

| Feature | V2 | V-C | Status |
|---------|----|----|--------|
| RCA-Ready queue (units needing root cause) | ✅ | ❌ | **V2 has, V-C missing** |
| Transition detection (avail→unavail) | ✅ | ✅ (retention.js, S28) | V-C now tracks |
| Primary component code selection | ✅ | ⚡ (deep-scan extracts) | Partial parity |
| Technician failure code | ✅ | ❌ | **V2 has, V-C missing** |
| Primary cause code | ✅ | ❌ | **V2 has, V-C missing** |
| Work accomplished code | ✅ | ❌ | **V2 has, V-C missing** |
| Maintenance code | ✅ | ❌ | **V2 has, V-C missing** |
| Controllable / Non-controllable | ✅ | ❌ | **V2 has, V-C missing** |
| Auto-infer codes from relay data | ✅ | ❌ | **V2 has, V-C missing** |

### ReportEmailModule (V2) → Email Engine (V-C)

| Feature | V2 | V-C | Status |
|---------|----|----|--------|
| Build email HTML from fleet data | ✅ | ✅ | Parity |
| Open OWA compose + paste | ✅ | ✅ | Parity |
| Per-operator recipients | ✅ | ✅ | Parity |
| Subject line builder | ✅ | ✅ | Parity |
| Email note injection | ✅ | ✅ | Parity |
| PNG screenshot attachment | ✅ | ❌ | **V2 has, V-C missing** |
| Auto-scheduled emails | ❌ | ✅ | **V-C superior** |
| Missed-slot catch-up | ❌ | ✅ | **V-C superior** |
| Test mode | ❌ | ✅ (S27) | **V-C superior** |
| SMTP fallback | ❌ | ✅ | **V-C superior** |

### ReportExportModule (V2) → No Direct Equivalent (V-C)

| Feature | V2 | V-C | Status |
|---------|----|----|--------|
| Export to PNG (canvas render) | ✅ | ❌ | **V2 has, V-C missing** |
| Export to Excel | ✅ | ❌ | **V2 has, V-C missing** |
| Export to HTML | ✅ | ❌ | **V2 has, V-C missing** |
| Per-operator/domicile export scope | ✅ | ❌ | **V2 has, V-C missing** |
| Canvas-drawn fleet table for email | ✅ | ❌ | **V2 has, V-C missing** |

### NotesLinksModule (V2) → Notes & Links (V-C)

| Feature | V2 | V-C | Status |
|---------|----|----|--------|
| Site credential storage | ✅ | ✅ | Parity |
| Copy username/password | ✅ | ✅ | Parity |
| Add/edit/delete sites | ✅ | ✅ | Parity |
| Autofill flag | ✅ | ✅ | Parity |
| Search | ✅ | ✅ | Parity |
| Encrypted storage | ❌ | ✅ (safeStorage) | **V-C superior** |

### DocVaultModule (V2) → No Equivalent (V-C)

| Feature | V2 | V-C | Status |
|---------|----|----|--------|
| Document capture (screenshots) | ✅ | ❌ | **V2 has, V-C missing** |
| Per-unit document storage | ✅ | ❌ | **V2 has, V-C missing** |
| Document viewer | ✅ | ❌ | **V2 has, V-C missing** |
| Dashboard stats from stored docs | ✅ | ❌ | **V2 has, V-C missing** |

### VendorBookModule (V2) → Vendors View (V-C)

| Feature | V2 | V-C | Status |
|---------|----|----|--------|
| Vendor dashboard per domicile | ✅ | ✅ | Parity |
| Vendor drill-down (units at vendor) | ✅ | ✅ | Parity |
| Vendor cost tracking | ✅ | ✅ | Parity |
| Vendor search/filter | ✅ | ✅ | Parity |
| Dealer WO workflow (PACCAR/Volvo) | ❌ | ✅ | **V-C superior** |
| Vendor AI suggestion | ❌ | ✅ (S28) | **V-C superior** |
| Vendor activity bar | ❌ | ✅ | **V-C superior** |

### AnalyticsModule (V2) → Analytics View (V-C)

| Feature | V2 | V-C | Status |
|---------|----|----|--------|
| Analytics dashboard | ✅ | ✅ | Parity |
| Lifecycle breakdown | ✅ | ✅ | Parity |
| By-operator summary | ✅ | ✅ | Parity |
| Risk distribution | ✅ | ✅ | Parity |
| PM due date tracking | ✅ | ✅ | Parity |
| Change log (prev vs current) | ✅ | ❌ | **V2 has, V-C missing** |
| Snapshot comparison | ✅ | ✅ (retention now) | Parity |

### Fleet Maintenance Command Center (V2) → Scheduler View (V-C)

| Feature | V2 | V-C | Status |
|---------|----|----|--------|
| Auto-scan scheduling | ✅ | ✅ | Parity |
| Email scheduling | ✅ | ✅ | Parity |
| Interval configuration | ✅ | ✅ | Parity |
| Domicile configuration | ✅ | ✅ | Parity |
| Operator configuration | ✅ | ✅ | Parity |
| SP push scheduling | ❌ | ✅ | **V-C superior** |
| Visual slot timeline | ❌ | ✅ | **V-C superior** |
| Run log | ❌ | ✅ | **V-C superior** |
| Missed-slot catch-up | ❌ | ✅ | **V-C superior** |

### ZilaAlertEngine (V2) → Orcha Deep Scan + Priority (V-C)

| Feature | V2 | V-C | Status |
|---------|----|----|--------|
| Alert on state changes | ✅ | ✅ (bubble notifications) | Parity |
| Priority scoring | ❌ | ✅ | **V-C superior** |
| AI analysis per unit | ❌ | ✅ | **V-C superior** |
| On-demand deep scan | ❌ | ✅ (S28) | **V-C superior** |
| Vendor suggestion AI | ❌ | ✅ (S28) | **V-C superior** |
| Learning from corrections | ❌ | ✅ (S28) | **V-C superior** |

---

## Features V2 Has That V-C Is MISSING

| # | Feature | V2 Module | Impact | Effort to Restore |
|---|---------|-----------|--------|-------------------|
| 1 | **RCA-Ready Queue** — units needing root cause analysis with code selection UI | RcaReadyModule | HIGH | 3-4 hrs |
| 2 | **Export to PNG/Excel/HTML** — full fleet report export in multiple formats | ReportExportModule | HIGH | 2-3 hrs |
| 3 | **Doc Vault** — per-unit document/screenshot capture & storage | DocVaultModule | MEDIUM | 3-4 hrs |
| 4 | **Heatmap Mode** — risk-colored row backgrounds toggle | InventoryModule | LOW | 30 min |
| 5 | **Breach Forecast** — SLA breach risk overlay on units | InventoryModule | LOW | 1 hr |
| 6 | **Bulk Relay Change** — multi-select + bulk status update | InventoryModule | MEDIUM | 1-2 hrs |
| 7 | **Export CSV** — one-click CSV download | ReportExportModule | LOW | 30 min |
| 8 | **Select-all Checkboxes** — bulk unit selection | InventoryModule | LOW | 30 min |
| 9 | **RCA Code Auto-Inference** — AI-like code detection from relay text | RcaReadyModule | MEDIUM | 2-3 hrs |
| 10 | **PNG Email Attachment** — canvas-rendered table as email body image | ReportEmailModule | MEDIUM | 2 hrs |
| 11 | **Analytics Change Log** — diff between scan snapshots | AnalyticsModule | LOW | 1 hr |
| 12 | **Average Fleet Age KPI** — calculated from model year | InventoryModule | LOW | 20 min |
| 13 | **Inline Relay Edit** — click tag to change relay status in-table | RelayModule | LOW | 1 hr |
| 14 | **Import JSON** — paste external fleet data | InventoryModule | LOW | 30 min |

---

## Features V-C Has That V2 DOES NOT

| # | Feature | Impact |
|---|---------|--------|
| 1 | **AI Deep Scan** — Bedrock-powered unit analysis | HIGH |
| 2 | **Vendor Workflow Engine** — automated PACCAR/Volvo portal interaction | HIGH |
| 3 | **Priority Scoring** — action/watch/track ranking | HIGH |
| 4 | **Auto-login for 11 vendor sites** | HIGH |
| 5 | **SharePoint Auto-Push** | HIGH |
| 6 | **Setup Wizard** — first-launch onboarding | MEDIUM |
| 7 | **Orcha Chat (FAB)** — conversational AI assistant | MEDIUM |
| 8 | **Daily Notes AI Generation** | MEDIUM |
| 9 | **Scheduler with Visual Timeline** | MEDIUM |
| 10 | **Bubble Notification Window** — HUD when minimized | MEDIUM |
| 11 | **Progressive Sync** — data appears as it arrives | MEDIUM |
| 12 | **Retention History** — 30-day state tracking (S28) | MEDIUM |
| 13 | **Vendor AI Suggestion + Learning Loop** (S28) | MEDIUM |
| 14 | **Encrypted Credential Store** | MEDIUM |
| 15 | **Geofence Column** (S28) | LOW |
| 16 | **Uptake Integration** (risk scores + insights) | HIGH |
| 17 | **Asana Integration** (backend wired) | LOW (no UI yet) |
| 18 | **Security Hardening** — IPC validation, path containment | HIGH |

---

## Verdict

**Version C exceeds Version 2 in:**
- Architecture (modular vs monolith)
- Security (validated IPC vs raw access)
- Automation (Playwright scrapers vs userscript bridge)
- AI Intelligence (Bedrock-powered vs none)
- Vendor workflow (full portal automation vs manual)
- Scheduling (SP + email + catch-up vs basic interval)
- Data pipeline (progressive sync vs batch-only)

**Version 2 still has advantages in:**
- RCA-Ready workflow (code selection + auto-inference)
- Export formats (PNG/Excel/HTML/CSV)
- Doc Vault (per-unit screenshots)
- Bulk operations (select-all + bulk relay change)
- Heatmap & breach forecast overlays

---

## Restoration Priority (Stage 29+)

| Priority | Feature | Effort | Why |
|----------|---------|--------|-----|
| 1 | Export CSV/Excel | 1 hr | Operators need data export daily |
| 2 | RCA-Ready Queue | 3-4 hrs | Core V2 workflow, heavily used |
| 3 | Heatmap Mode | 30 min | Quick win, high visual impact |
| 4 | Bulk Relay Change | 1-2 hrs | Multi-unit operations are common |
| 5 | Doc Vault | 3-4 hrs | Evidence capture for compliance |
| 6 | PNG Email Attachment | 2 hrs | Restores V2 email quality |
| 7 | Breach Forecast | 1 hr | SLA management |
| 8 | Analytics Change Log | 1 hr | Trend visibility |
| 9 | RCA Code Auto-Inference | 2-3 hrs | Intelligence feature |
| 10 | Average Fleet Age | 20 min | Quick KPI add |

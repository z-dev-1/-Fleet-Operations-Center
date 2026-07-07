# Phase 7 — Operational Intelligence Roadmap

**Date:** 2026-07-01
**Objective:** Transform Orcha from a reactive AI assistant into a proactive operational intelligence engine that monitors, detects, recommends, prepares, and learns — while never automatically changing production behavior without approval.

---

## Current State (Post-S28)

| Capability | Status | Location |
|-----------|--------|----------|
| AI Deep Scan (analyze unavailable units) | ✅ Working | `src/orcha/deep-scan.js` |
| Priority Scoring (action/watch/track) | ✅ Fixed S28 | `src/orcha/priority.js` |
| Learning from corrections | ✅ Wired S28 | `src/orcha/learn.js` |
| Vendor suggestion (rule-based) | ✅ Wired S28 | `src/orcha/learn.js:suggestVendor()` |
| Daily Notes generation | ✅ Working | `src/scrapers/daily_notes.js` |
| Email auto-compose | ✅ Wired S28 | `src/app.js` scheduler → renderer |
| SP auto-push | ✅ Working | `src/app.js` scheduler |
| Retention history | ✅ Wired S28 | `src/orcha/retention.js` |
| Orchestrator (intent engine) | 💤 Exists, dormant | `src/orcha/orchestrator.js` |
| Guardian (safety checks) | 💤 Exists, dormant | `src/orcha/guardian.js` |
| Context (workflow state) | ⚡ Exists, not persisted | `src/orcha/context.js` |

---

## Architecture: The Orcha Intelligence Loop

```
┌─────────────────────────────────────────────────────────────────────┐
│                    ORCHA INTELLIGENCE ENGINE                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐     │
│  │ MONITOR  │───▶│ DETECT   │───▶│ RECOMMEND│───▶│ PREPARE  │     │
│  │          │    │          │    │          │    │          │     │
│  │ Every    │    │ Missing  │    │ Next     │    │ WOs      │     │
│  │ unit,    │    │ data,    │    │ actions, │    │ Notes    │     │
│  │ every    │    │ stale    │    │ vendor,  │    │ Emails   │     │
│  │ sync     │    │ info,    │    │ priority │    │ SP data  │     │
│  │          │    │ anomaly  │    │          │    │          │     │
│  └──────────┘    └──────────┘    └──────────┘    └──────────┘     │
│       │                                               │             │
│       │          ┌──────────┐    ┌──────────┐         │             │
│       └─────────▶│ TRACK    │◀───│ LEARN    │◀────────┘             │
│                  │          │    │          │                       │
│                  │ Progress │    │ Patterns │                       │
│                  │ SLA      │    │ Outcomes │                       │
│                  │ Blocker  │    │ Correct  │                       │
│                  └──────────┘    └──────────┘                       │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  APPROVAL GATE: Nothing changes production data without user confirm│
└─────────────────────────────────────────────────────────────────────┘
```

---

## Roadmap: 7 Modules

### Module 1: Unit Monitor (always watching)
**Purpose:** Score the "health" of every unit's data completeness and freshness.

| Task | Description | Effort |
|------|-------------|--------|
| 1.1 | Create `src/orcha/monitor.js` — runs after every sync | 1 hr |
| 1.2 | Data Completeness Score per unit: has vendor? has duration? has notes? has relay data? has uptake? has PM dates? | 1 hr |
| 1.3 | Staleness detection: relay data > 24h old? notes > 7d old? no AI analysis in 3 days? | 30 min |
| 1.4 | Push `orcha:monitor-results` to renderer with per-unit health scores | 30 min |
| 1.5 | Show health indicators in fleet table (dot color: green/yellow/red per data completeness) | 1 hr |

**Output:** Every unit has a real-time "intelligence health" score visible at a glance.

---

### Module 2: Anomaly & Gap Detection
**Purpose:** Automatically identify what's wrong or missing before the operator notices.

| Task | Description | Effort |
|------|-------------|--------|
| 2.1 | Detect units unavailable > SLA target with no vendor assigned | 30 min |
| 2.2 | Detect units with relay status "Pending" for > 48h (stuck) | 30 min |
| 2.3 | Detect units where duration jumped by > 2 days since last sync (clock slip) | 30 min |
| 2.4 | Detect units with risk score > 70 but no open WR (risk without action) | 30 min |
| 2.5 | Detect units where lifecycle reason changed but no notes exist (unexplained change) | 30 min |
| 2.6 | Detect missing PM dates (overdue B/X/DOT) | 30 min |
| 2.7 | Aggregate anomalies into `orcha:alerts` bus event | 30 min |
| 2.8 | Create Alert Panel UI component (collapsible, sorted by severity) | 1.5 hr |

**Output:** Proactive alerts surface before the operator discovers problems manually.

---

### Module 3: Action Recommendation Engine
**Purpose:** For every unit needing attention, recommend the specific next step.

| Task | Description | Effort |
|------|-------------|--------|
| 3.1 | Rule engine: map (state × data gaps × duration × vendor) → recommended action | 2 hr |
| 3.2 | Action types: `ASSIGN_VENDOR`, `ESCALATE`, `CREATE_WR`, `FOLLOW_UP`, `UPDATE_NOTES`, `CLOSE_OUT`, `SCHEDULE_PM` | 1 hr |
| 3.3 | Confidence scoring (how sure is the recommendation) | 30 min |
| 3.4 | Display recommendations in Priority Drawer as actionable cards | 1.5 hr |
| 3.5 | One-click execution: "Accept" triggers orchestrator intent | 1 hr |
| 3.6 | "Dismiss" or "Defer 24h" to snooze recommendations | 30 min |

**Output:** Orcha tells you what to do next for each priority unit, and you can execute with one click.

---

### Module 4: Automated Preparation (Draft Mode)
**Purpose:** Pre-build work products that the operator reviews and approves.

| Task | Description | Effort |
|------|-------------|--------|
| 4.1 | Auto-draft Daily Notes for all unavailable units (surface deep-scan as drafts) | 1 hr |
| 4.2 | Auto-draft email body per operator/slot (pre-compose, user clicks Send) | 1 hr |
| 4.3 | Auto-draft SharePoint row data (pre-stage, user clicks Push) | 1 hr |
| 4.4 | Auto-draft WR payload for units needing work requests (vendor, urgency, description pre-filled) | 2 hr |
| 4.5 | "Draft Inbox" UI — shows all auto-prepared items awaiting approval | 2 hr |
| 4.6 | Bulk approve: select multiple drafts and execute all | 1 hr |

**Output:** Orcha does 80% of the work; operator reviews and clicks Approve.

---

### Module 5: Workflow Progress Tracking
**Purpose:** Track every unit's journey from unavailable → repaired → active, across all systems.

| Task | Description | Effort |
|------|-------------|--------|
| 5.1 | Define workflow stages: `DETECTED → ASSIGNED → DIAGNOSED → QUOTED → APPROVED → PARTS → REPAIR → QC → PICKUP → ACTIVE` | 30 min |
| 5.2 | Auto-detect stage from relay status + lifecycle reason mapping | 1 hr |
| 5.3 | Track stage transitions with timestamps (extends retention.js) | 1 hr |
| 5.4 | Calculate time-in-stage for each unit | 30 min |
| 5.5 | SLA progress bar per unit (days elapsed / target days) | 1 hr |
| 5.6 | "Stuck" detection: unit in same stage > expected duration | 30 min |
| 5.7 | Workflow Gantt/timeline view for selected unit (in detail panel) | 2 hr |
| 5.8 | Cross-vendor performance tracking (avg time per stage per vendor) | 1 hr |

**Output:** Know exactly where every unit is in its repair journey, and where it's stuck.

---

### Module 6: Pattern Learning & Prediction
**Purpose:** Learn from historical data to predict outcomes and improve recommendations.

| Task | Description | Effort |
|------|-------------|--------|
| 6.1 | Track outcome of every recommendation (accepted? dismissed? what happened after?) | 1 hr |
| 6.2 | Vendor performance scoring: avg repair time, SLA compliance rate, cost per repair | 2 hr |
| 6.3 | Pattern: "Units at Vendor X for Component Y take N days on average" | 1 hr |
| 6.4 | Pattern: "This time of year, PM backlogs increase" (seasonal) | 1 hr |
| 6.5 | Feed learned patterns back into recommendation confidence scores | 1 hr |
| 6.6 | Monthly intelligence report: trends, improvements, degradations | 2 hr |
| 6.7 | Expose patterns to AI prompts (inject as context into deep-scan) | 1 hr |

**Output:** Orcha gets smarter over time. Predictions improve. Operator trusts recommendations more.

---

### Module 7: Failure Detection & System Health
**Purpose:** Detect when the system itself is degraded or external dependencies are failing.

| Task | Description | Effort |
|------|-------------|--------|
| 7.1 | Track scraper success rates (AAP, Relay, Uptake failures per cycle) | 30 min |
| 7.2 | Detect Midway expiry approaching (< 30 min) and alert | 30 min |
| 7.3 | Detect SP push failures (consecutive fails) and alert | 30 min |
| 7.4 | Detect email send failures | 30 min |
| 7.5 | System health dashboard (all integrations green/yellow/red) | 1.5 hr |
| 7.6 | Auto-recovery: if Midway expired, prompt mwinit before next sync | 30 min |
| 7.7 | Detect AI timeout rate increasing (Orcha WS degraded) | 30 min |

**Output:** Know when Fleet Ops itself needs attention, before workflows silently fail.

---

## Implementation Priority

### Sprint 1 — Immediate (highest operational value)
| Module | Task | Total Effort |
|--------|------|-------------|
| 1 | Unit Monitor (completeness + staleness) | 4 hrs |
| 2 | Anomaly Detection (top 5 rules) | 3 hrs |
| 3 | Action Recommendations (rule engine + UI) | 5.5 hrs |
| **Sprint 1 Total** | | **12.5 hrs** |

### Sprint 2 — Next (workflow visibility)
| Module | Task | Total Effort |
|--------|------|-------------|
| 5 | Workflow Progress (stage tracking + timeline) | 7.5 hrs |
| 4 | Draft Inbox (auto-prepare + approve flow) | 8 hrs |
| **Sprint 2 Total** | | **15.5 hrs** |

### Sprint 3 — Intelligence maturity
| Module | Task | Total Effort |
|--------|------|-------------|
| 6 | Pattern Learning (vendor perf + predictions) | 9 hrs |
| 7 | System Health (monitoring + auto-recovery) | 4.5 hrs |
| **Sprint 3 Total** | | **13.5 hrs** |

### Total Roadmap: ~41.5 hours across 3 sprints

---

## Approval Gate Architecture

**CRITICAL PRINCIPLE:** Orcha NEVER executes without approval.

```
Orcha detects issue → Recommends action → PREPARES draft
                                              ↓
                                    User sees draft in UI
                                              ↓
                              ┌── [Accept] → Orchestrator.execute()
                              ├── [Edit]   → Modify then accept
                              ├── [Defer]  → Snooze 24h
                              └── [Dismiss]→ Record as correction (learning)
```

Actions that REQUIRE approval:
- Creating Work Requests
- Sending emails
- Pushing to SharePoint
- Changing lifecycle state
- Starting vendor workflows
- Assigning vendors

Actions that DON'T need approval (informational):
- Generating notes/summaries
- Scoring priority
- Detecting anomalies
- Tracking progress
- Computing recommendations

---

## Integration with Existing Orchestrator

The dormant `orchestrator.js` has the perfect architecture for this:

```javascript
// Current orchestrator flow (already coded, just unused):
validate(intent) → enrich(context) → plan(steps) → execute(plan) → verify(result)
```

**Activation plan:**
1. Wire Monitor → Detection → Recommendation into orchestrator as intent sources
2. Orchestrator validates intent through Guardian (safety checks)
3. Guardian blocks if: missing required data, duplicate operation, cooldown period
4. If approved by user → Orchestrator executes
5. Result verification confirms success
6. Learning engine records outcome

---

## Success Metrics

| Metric | Current | Target (30 days) |
|--------|---------|------------------|
| % of unavailable units with AI notes | ~70% (27/38) | 95% |
| Avg time to detect anomaly | Manual (operator notices) | < 7 min (auto per sync) |
| Actions recommended per day | 0 | 10-20 |
| Draft approval rate | N/A | > 60% accepted |
| Vendor suggestion accuracy | Unknown (no baseline) | > 70% match |
| Priority scoring coverage | 0% (was broken until S28) | 100% of unavailable units |
| SLA breach prediction accuracy | N/A | > 80% correct |
| System health uptime visibility | None | 100% of integrations monitored |

---

## File Structure (Proposed)

```
src/orcha/
├── index.js              (registry — exists)
├── deep-scan.js          (AI analysis — exists)
├── priority.js           (scoring — exists, fixed)
├── learn.js              (corrections + vendor rules — exists)
├── retention.js          (history — exists, wired)
├── orchestrator.js       (intent engine — exists, to activate)
├── guardian.js           (safety — exists, to wire)
├── context.js            (state — exists)
├── relay.js              (AI transport — exists)
├── auto-login.js         (vendor auth — exists)
├── playwright_bridge.js  (browser automation — exists)
│
├── monitor.js            ← NEW: data completeness + staleness scoring
├── anomaly.js            ← NEW: gap detection + alert generation
├── recommend.js          ← NEW: action recommendation engine
├── prepare.js            ← NEW: auto-draft builder (notes, email, SP, WR)
├── tracker.js            ← NEW: workflow stage tracking + time-in-stage
├── patterns.js           ← NEW: historical pattern learning + predictions
└── health.js             ← NEW: system integration health monitoring
```

---

## Relationship to Other Phases

| Phase | Feeds Into Module 7 How |
|-------|------------------------|
| Phase 2 (Inventory) | Identified the dormant orchestrator/guardian/learning — now we activate them |
| Phase 3 (Wiring) | S28 connected retention, learning, suggestions — the foundation for intelligence |
| Phase 4 (V2 Comparison) | V2's RCA auto-inference maps to Module 3 recommendations |
| Phase 5 (Stabilization) | Clean architecture enables modular intelligence additions |
| Phase 6 (Validation) | Priority fix + sync verification proves the data pipeline is reliable |

---

## Next Step

Begin Sprint 1, Module 1: Create `src/orcha/monitor.js` that runs after every sync completion and scores each unit's data completeness. Wire results to the Priority Drawer so the operator sees which units need attention first — and why.

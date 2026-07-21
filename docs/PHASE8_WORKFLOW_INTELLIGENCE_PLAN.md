# Phase 8 — Workflow Intelligence: Architecture & Rollout Plan

**Date:** 2026-07-19
**Baseline:** Stage 28 complete (`main` @ `21a3c18`)
**Status:** DESIGN — not yet implemented
**Author:** Orcha AI (design pass, per Z. Santiago request)

---

## 0. Positioning — this is NOT a new brain, it's a new sense + a new limb

Fleet Ops already has a working "Orcha Intelligence Loop" (see `docs/PHASE7_OPERATIONAL_INTELLIGENCE.md`):
`MONITOR → DETECT → RECOMMEND → PREPARE → TRACK → LEARN`, gated by an `APPROVAL GATE` before anything touches
production data. That loop is entirely **data-driven** — it watches *fleet state* (rows, statuses, durations) and
reasons about *units*.

Workflow Intelligence is a different axis: it watches **what Z. Santiago personally does** — the click-by-click,
app-by-app sequence of actions a human takes — and learns to reproduce that sequence. It is the missing "senses"
(action capture) and "limb" (cross-app execution) bolted onto the *existing* brain, not a replacement for it.

Concretely, several pieces this spec asks for **already exist** and should be reused, not rebuilt:

| Capability requested | Already exists as | Reuse plan |
|---|---|---|
| Confidence-scored suggestions | `src/orcha/recommend.js` (`ACTION`, `ACTION_META`, confidence math) | Extend with a new `SUGGEST_WORKFLOW` action type |
| Approval gate before execution | `src/orcha/guardian.js` (`check()`, `checkPlaywrightAction()`) | Every workflow step passes through Guardian; low-confidence steps forced to `WARN`/manual-approve |
| Multi-step execution pipeline (validate→enrich→plan→execute→verify) | `src/orcha/orchestrator.js` | Add `INTENT_TYPES.RUN_WORKFLOW`; plan() expands recorded steps into orchestrator steps |
| Cross-app / browser automation primitives | `src/orcha/playwright_bridge.js` (`click`, `fill`, `select`, `type`, `navigate`, `waitFor`) — already Guardian-gated | Execution engine for recorded external-app steps |
| DOM action capture precedent | `src/window/wr_capture.js` (pushState/click-diff interception), `src/scrapers/aap_adaptive_agent.js` (DOM snapshot + step loop) | Generalize into a reusable capture script |
| Pattern learning from history | `src/orcha/patterns.js` (vendor/stage/load stats), `src/orcha/learn.js` (correction learning) | New sibling module for *action-sequence* mining — different shape of data, same module family |
| Workflow progress visualization | `renderer/src/js/components/workflow-timeline.js` | Fork/extend for execution-step timeline (this one is repair-stage timeline, needs a sibling, not a rewrite) |
| Allowed external hosts | `POPUP_ALLOWED_HOSTS` in `src/ipc/orcha.js` | Same allowlist governs which sites Workflow Intelligence may record/replay on |
| Atomic JSON persistence | `src/store/index.js` (`load/save/update`, REGISTRY pattern) | New registry entries; migrate to SQLite per §4 |

**Design principle carried forward from Phase 7:** *nothing executes against a real system without passing through
Guardian, and nothing is fully autonomous without an explicit approval step for anything below a confidence
threshold.* This is non-negotiable for Phase 4 (Intelligent Automation) given it will be driving Relay, AAP,
Outlook, Slack, and SharePoint with real credentials.

---

## 1. Architecture Overview

```
┌───────────────────────────────────────────────────────────────────────────┐
│                     WORKFLOW INTELLIGENCE ENGINE (new)                     │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌───────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐         │
│  │  RECORD   │──▶│   MINE     │──▶│  SUGGEST   │──▶│  EXECUTE   │         │
│  │ (Phase 1) │   │ (Phase 2)  │   │ (Phase 3)  │   │ (Phase 4)  │         │
│  │           │   │            │   │            │   │            │         │
│  │ In-app    │   │ Sequence   │   │ Match live │   │ Orchestrator│        │
│  │ event tap │   │ clustering │   │ context to │   │ + Guardian │         │
│  │ + external│   │ over saved │   │ known      │   │ + Playwright│        │
│  │ DOM       │   │ recordings │   │ workflows, │   │ bridge for │         │
│  │ capture   │   │            │   │ per-step   │   │ each step  │         │
│  │           │   │            │   │ confidence │   │            │         │
│  └─────┬─────┘   └─────┬──────┘   └─────┬──────┘   └─────┬──────┘         │
│        │                │                │                │              │
│        ▼                ▼                ▼                ▼              │
│  workflowRecordings  workflowPatterns  Draft Inbox     execution log      │
│  (store/SQLite)      (store)           card (approve/  (store) + Guardian │
│                                         edit/dismiss)   history           │
│                                                                             │
│                         ┌────────────┐                                    │
│                         │  OPTIMIZE  │  (Phase 5, reads execution log     │
│                         │            │   + workflowPatterns, feeds back   │
│                         │            │   suggestions into MINE)           │
│                         └────────────┘                                    │
├───────────────────────────────────────────────────────────────────────────┤
│  APPROVAL GATE (Guardian): every EXECUTE step ≥ existing rule set,        │
│  PLUS per-step confidence gate — below threshold = forced manual approve  │
└───────────────────────────────────────────────────────────────────────────┘
                │                                              ▲
                ▼                                              │
     existing Orcha Intelligence Loop (Phase 7)  ───────────────┘
     (MONITOR/DETECT feed trigger-context into MINE/SUGGEST)
```

---

## 2. Data Model (new — extends `src/types.js`)

```js
/**
 * @typedef {Object} WorkflowStep
 * @property {string} id
 * @property {'app_open'|'click'|'type'|'select'|'wait'|'search'|'create_wr'|
 *             'update_notes'|'send_email'|'send_slack'|'copy'|'paste'|'navigate'|
 *             'condition'|'loop'|'delay'} type
 * @property {string} app            - 'relay' | 'paccar' | 'asist' | 'outlook' | 'slack' | 'sharepoint' | 'internal'
 * @property {string} [selector]     - DOM selector (external-app steps) or component id (in-app steps)
 * @property {string} [value]        - text typed / option selected (redacted if field is password-type)
 * @property {number} [delayMs]
 * @property {Object} [condition]    - { field, op, value } — Phase 1 editor support, evaluated at Phase 4 runtime
 * @property {Object} [loop]         - { overVariable, maxIterations }
 * @property {string[]} [variables]  - names of variables this step reads/writes
 * @property {string} [screenshotRef] - optional captured thumbnail for editor context
 */

/**
 * @typedef {Object} WorkflowRecording
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {string[]} tags
 * @property {string} category         - e.g. "Repair Intake", "Vendor Comms", "Reporting"
 * @property {boolean} favorite
 * @property {WorkflowStep[]} steps
 * @property {Object} [triggerContext]  - { issueKeyword, make, component, lifecycleReason, ... }
 *                                        captured at record time — the "situation" that preceded this workflow
 * @property {Object} variables         - { name: defaultValue }
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string} source            - 'recorded' | 'imported' | 'ai_generated'
 * @property {Object} stats              - { timesExecuted, timesSuggested, timesAccepted, avgDurationMs, successRate }
 */

/**
 * @typedef {Object} WorkflowExecution
 * @property {string} id
 * @property {string} workflowId
 * @property {string} status           - 'pending_approval'|'running'|'paused'|'completed'|'failed'|'stopped'
 * @property {Array<{stepId, status, confidence, startedAt, endedAt, error}>} stepLog
 * @property {string} startedAt
 * @property {string} [endedAt]
 * @property {string} triggerUnitId     - unit this execution was suggested/run for, if any
 */
```

**Storage decision:** register new keys in `src/store/index.js` REGISTRY (`workflowRecordings`, `workflowPatterns`,
`workflowExecutionLog`) for Phase 1 ship speed — consistent with every other module in the app. **Recommend
triggering the SQLite migration that `src/store/sqlite.js` already scaffolds** starting with this module
specifically, because Phase 2/3 need to *query* across hundreds of recordings and steps (filter by app, tag,
trigger context, success rate) — something JSON-load-then-filter-in-memory will not scale to gracefully once the
library grows past a few hundred workflows. This does not block Phase 1 shipping on JSON store first.

---

## 3. Phase 1 — Automation Recorder

**Purpose:** Capture action sequences from both in-app UI and external systems opened via the app's existing
popup-window mechanism.

### 3.1 Two capture surfaces (this is the core technical decision)

**A. In-app actions (renderer)** — new `renderer/src/js/workflow-recorder.js`:
- Taps the existing central event bus (`bus.js`) the same way `workflow-timeline.js` already does — every view in
  this app already emits/listens on `bus` (`ui:unit-select`, `orcha:tracker`, etc.), so recording in-app actions is
  mostly "subscribe to bus events already flowing" plus a `document`-level capture-phase listener for raw
  click/input/change events not already on the bus, tagged with the nearest `data-*` component identifier.
- No new IPC needed for this surface — it's pure renderer-side buffering, flushed to main via a new
  `wi:save-recording` IPC call when the user stops recording.

**B. External-app actions (Relay Garage, PACCAR, ASIST, Outlook/OWA, Slack, SharePoint)** — new
`src/window/action_capture.js`, generalizing the *exact* pattern already proven in `src/window/wr_capture.js` and
`src/scrapers/aap_adaptive_agent.js`:
- These sites are opened today via `open-popup` IPC (`src/ipc/orcha.js`), which already validates against
  `POPUP_ALLOWED_HOSTS` and runs `attemptAutoLogin`. Workflow recording reuses this exact window — no new window
  type.
- On `did-finish-load`, inject a capture script via `webContents.executeJavaScript` (same technique
  `aap_autofill_engine.js` already uses) that:
  - Intercepts `history.pushState`/`replaceState` (proven in `wr_capture.js`'s WR-URL capture) for navigation steps.
  - Adds capture-phase `click`/`change`/`input` listeners, recording a resilient selector (prefer `id` →
    `data-testid` → stable ARIA attrs → nth-of-type fallback — mirrors the multi-strategy selector fallback already
    used in `aap_autofill_engine.js` for the "eye button"/column-config button).
  - **Redacts** any `input[type=password]` or field matching existing `src/security/credentials.js` naming
    conventions before the value ever leaves the page context.
- Events post back to the main process via a dedicated preload channel (`wi:action-captured`), buffered into the
  active `WorkflowRecording` draft.

### 3.2 Tasks

| Task | Description | Effort |
|---|---|---|
| 1.1 | `workflowRecordings` + `workflowExecutionLog` store registry entries | 30 min |
| 1.2 | `src/ipc/workflow-intel.js` — CRUD handlers (`wi:start-recording`, `wi:stop-recording`, `wi:save-recording`, `wi:list`, `wi:get`, `wi:update`, `wi:delete`, `wi:import`, `wi:export`), registered in `src/ipc/index.js` | 2 hr |
| 1.3 | `renderer/src/js/workflow-recorder.js` — in-app bus tap + DOM listener, start/stop/pause API | 3 hr |
| 1.4 | `src/window/action_capture.js` — generalized external-site capture script + injection hook off `open-popup` | 4 hr |
| 1.5 | Redaction rules (password fields, credential-store keys never captured) | 1 hr |
| 1.6 | Recorder HUD — small floating control (red dot + timer + pause/stop) docked near the existing Orcha FAB (`orcha-fab.js`) | 2 hr |
| 1.7 | Workflow Editor UI — step list with reorder (drag), delete, add-delay, add-condition, add-loop, variable binding | 6 hr |
| 1.8 | Import/export (`.json` workflow bundle, matches app's existing JSON-everywhere convention) | 1 hr |
| 1.9 | Workflow Library view — search, category filter, tags, favorites (reuse list-view pattern from `vendors.js`/`notes-links.js`) | 3 hr |

**Output:** Z can hit "Record", perform a real task across Relay + email + Slack, hit "Stop", and get back an
editable, saved, reusable `WorkflowRecording` — Phase 1's literal example from the spec.

---

## 4. Phase 2 — AI Learning Engine (Pattern Mining)

**Purpose:** Continuously mine saved recordings for *repeated sequences tied to a repeated trigger context* — e.g.
"Engine Misfire + Amerit asset → [Create Relay WO, Send partner email, Notify Slack, Update notes]" every time.

This is a new sibling to `patterns.js` (which mines *outcome statistics*, not *action sequences*) — same module
family (`src/orcha/`), different algorithm shape.

| Task | Description | Effort |
|---|---|---|
| 2.1 | `src/orcha/workflow-learn.js` — sequence similarity scoring (start simple: normalized step-type + app sequence match, Levenshtein-style edit distance on the step-type list; defer full ML clustering to a later iteration) | 4 hr |
| 2.2 | Trigger-context extractor — pulls `{issueKeyword, make, component, lifecycleReason, domicile}` from the unit/context active at recording time (reuses `context.js`'s existing unit shape) | 2 hr |
| 2.3 | Frequency/consistency threshold (config default: 3+ occurrences of the same sequence under a matching trigger context, mirroring the app's own existing "3-unit minimum" convention from Daily Call trends) | 1 hr |
| 2.4 | Persist mined patterns to `workflowPatterns` store, keyed by trigger-context signature → best-matching `WorkflowRecording` id(s) | 1 hr |
| 2.5 | Hook into existing sync cycle (same place `patterns.js`'s `runPatternLearning` is already called) so mining runs passively, not on a separate schedule | 30 min |

**Output:** After a handful of repetitions, the system has a persisted, queryable answer to "what do I usually do
when X happens" — without the user tagging anything manually.

---

## 5. Phase 3 — Smart Suggestions

**Purpose:** When live context matches a mined pattern, proactively surface it with the exact per-action confidence
UX described in the request.

This reuses the **Draft Inbox** pattern the app already ships (`renderer/src/js/components/draft-inbox.js`,
built for Phase 7 Module 4's "auto-prepared items awaiting approval") rather than inventing a new UI paradigm —
a suggested workflow is just a new kind of draft card.

| Task | Description | Effort |
|---|---|---|
| 3.1 | `src/orcha/recommend.js` — add `SUGGEST_WORKFLOW` action type + `ACTION_META` entry, confidence = blend of (pattern consistency score from 2.3) × (trigger-context match closeness) | 2 hr |
| 3.2 | Per-step confidence breakdown — each step in the suggested workflow gets its own score, not just the whole workflow (matches the spec's example table exactly: `Create Relay WO — 99%`, `Send Vendor Email — 65% (Requires Approval)`) | 2 hr |
| 3.3 | Suggestion card UI in Draft Inbox — "I've seen this situation before" copy, step list with confidence bars, Approve All / Approve Selected / Dismiss / Edit-before-run | 3 hr |
| 3.4 | Snooze/dismiss feedback loop — dismissals decrement pattern confidence (mirrors `patterns.js`'s existing `recOutcomes: {suggested, accepted, dismissed}` tracking, already defined but unused — this finally wires it) | 1 hr |

**Output:** The exact suggestion UX from the spec, built on infrastructure that already half-exists.

---

## 6. Phase 4 — Intelligent Automation (Execution)

**Purpose:** On approval, run the full step sequence — in-app steps via existing IPC handlers, external-app steps
via the Playwright bridge — with per-step Guardian gating.

This is the highest-risk phase (real actions against Relay/AAP/Outlook/Slack/SharePoint) and should ship **after**
Phases 1–3 have run long enough to prove pattern quality on read-only suggestions first.

| Task | Description | Effort |
|---|---|---|
| 4.1 | `orchestrator.js` — register `INTENT_TYPES.RUN_WORKFLOW`; `plan()` expands `WorkflowStep[]` into orchestrator plan steps, tagging each with its app (`internal` → direct IPC call, external → Playwright bridge command) | 3 hr |
| 4.2 | Per-step Guardian gate — **any step below the configurable confidence threshold (default 80%) is forced into `pending_approval` status and blocks the run until the user clicks Approve for that specific step**, exactly matching the spec's "Requires Approval" example | 2 hr |
| 4.3 | External-step execution via `src/orcha/playwright_bridge.js` (`navigate/click/fill/select/type/waitFor` — all already Guardian-gated + already restricted to the allowed-domain list) | 3 hr |
| 4.4 | In-app step execution — dispatches to existing handlers (`create_wr` → existing WR IPC path, `send_email` → existing `emailBridge`, `notify_slack` → existing `src/ipc/slack.js`, `update_notes` → existing `notes:add-timeline`) — **Workflow Intelligence should call the same functions the manual UI already calls, never a parallel code path** | 4 hr |
| 4.5 | Execution Monitor UI — live step-by-step progress (fork of `workflow-timeline.js`'s visual style), pause/resume/stop controls, per-step retry-on-error with backoff (reuse `src/utils/retry.js`, already exists) | 4 hr |
| 4.6 | Execution log persistence to `workflowExecutionLog`, surfaced in a "Workflow History" tab | 2 hr |
| 4.7 | Rollback/undo affordance where the underlying action supports it (e.g., notes edits — most external actions like "sent email" cannot be undone, so the UI must clearly distinguish reversible vs. irreversible steps before execution, not after) | 2 hr |

**Output:** Approved workflows run end-to-end, with the same safety rails (Guardian, allowlist, no direct
credential exposure) already governing every other Orcha-driven action in the app today.

---

## 7. Phase 5 — Workflow Optimization

**Purpose:** Compare recorded variants of "the same" workflow over time and suggest a better one.

| Task | Description | Effort |
|---|---|---|
| 5.1 | Extend `workflow-learn.js` to cluster near-duplicate workflows (same trigger context, different step count/order) | 2 hr |
| 5.2 | Efficiency scoring — step count, wall-clock duration (from `WorkflowExecution.stepLog` timestamps), failure rate per variant | 1 hr |
| 5.3 | "This workflow could be 3 steps shorter" insight card, same visual language as `patterns.js`'s existing `insights[]` array consumed elsewhere in the app | 2 hr |
| 5.4 | One-click "adopt the faster variant as default" | 1 hr |

**Output:** The library gets faster over time instead of just larger.

---

## 8. Security & Guardrails (non-negotiable, carried from existing architecture)

1. **No new execution path bypasses Guardian.** Every external-app step goes through `playwright_bridge.js`
   (already Guardian-gated); every in-app step calls the *existing* handler functions, which already enforce their
   own validation.
2. **Confidence-gated approval is mandatory**, not optional — this is the mechanism that makes autonomous execution
   safe enough to ship. Default threshold configurable in Settings, same pattern as existing scheduler config in
   `src/ipc/settings.js`.
3. **Credential redaction at capture time**, not at storage time — password-type fields and anything matching
   `src/security/credentials.js` key patterns are never written into a `WorkflowRecording` in the first place.
4. **Recording/execution restricted to `POPUP_ALLOWED_HOSTS`** — same allowlist already enforced in
   `src/ipc/orcha.js`'s `open-popup` handler. No new domains without deliberately extending that list.
5. **Irreversible steps (send email, send Slack, submit WR) are visually flagged distinctly** in both the
   suggestion card and the execution monitor, before the user approves — never after.
6. **Everything logged** to `workflowExecutionLog`, same durability pattern (atomic tmp→rename writes) as every
   other store in the app.

---

## 9. UI/UX Plan

- New top-level nav tab: **"Workflow Intelligence"** (added to `toolbar.js`, matching existing tab convention).
- Sub-views (single view with internal tab strip, matching `settings.js`'s existing sub-tab pattern):
  - **Library** — search, category filter, tags, favorites (list pattern reused from `vendors.js`/`notes-links.js`).
  - **Editor** — visual step list (reorder/delete/delay/condition/loop/variables). A full drag-and-drop flowchart
    canvas is the most novel UI piece requested; recommend a **vanilla JS/SVG step-list-with-branch-lines**
    component consistent with this app's zero-framework, no-heavy-dependency convention (matches
    `workflow-timeline.js`'s existing SVG/CSS timeline approach) rather than pulling in a new charting/flowchart
    library — keeps bundle size and Offline Compatibility intact.
  - **Execution Monitor** — live run view, pause/resume/stop, step log (fork of `workflow-timeline.js`).
  - **History** — past executions, filterable, exportable.
- **Recorder HUD** — small persistent control near the Orcha FAB (`orcha-fab.js`), consistent with that
  component's existing floating-UI convention.
- Suggestion delivery — **Draft Inbox** (existing component), not a new modal system.

---

## 10. Suggested Rollout Order

Given the safety profile, ship in this order rather than strictly phase-by-phase:

1. **Phase 1 full** (Recorder + Editor + Library) — zero execution risk, immediately useful as a manual workflow
   reference/checklist tool even before any AI layer exists.
2. **Phase 2 + Phase 3, suggestion-only** (no auto-execution yet) — proves pattern-mining quality against real
   usage data with zero production risk; user still does every step manually, just gets reminded/guided.
3. **Phase 4, in-app steps only first** (notes updates, internal state — nothing external-facing) — proves the
   orchestrator/Guardian wiring for `RUN_WORKFLOW` on the lowest-risk actions.
4. **Phase 4, external-app steps** (Relay/AAP/Slack/email/SharePoint automation) — highest risk, ship last, behind
   a per-user opt-in setting.
5. **Phase 5** — pure value-add once enough execution history exists to compare variants.

---

## 11. Open Questions for Z. Santiago

1. **Confidence threshold default** — spec example uses 80% as the implicit approval line (65% required approval,
   92%+ did not). Confirm 80% as the initial default, adjustable in Settings.
2. **First external app to wire for capture** — recommend starting with **Relay Garage** (already has the most
   automation precedent in this codebase — WR capture, adaptive agent) before ASIST/PACCAR/Outlook/Slack/SharePoint.
   Confirm priority order.
3. **SQLite migration timing** — start Workflow Intelligence directly on `better-sqlite3` (already scaffolded in
   `src/store/sqlite.js`, just needs `npm install better-sqlite3` + `initDB()` call), or ship Phase 1 on the
   existing JSON store first and migrate once the library grows? Recommend JSON-first for speed, SQLite once
   Phase 2 mining needs real querying.
4. **Irreversible-action policy** — should "Send Vendor Email" and "Send Slack Message" steps *always* require
   manual approval regardless of confidence score (treat them as a special always-gated category), or only gate
   below the 80% threshold as with everything else? Recommend always-gated for anything that leaves the app
   (email/Slack/WR submission) at least through the end of Phase 4's initial rollout.

---

## 12. File Manifest Summary

**New files:**
- `src/orcha/workflow-learn.js`
- `src/window/action_capture.js`
- `src/ipc/workflow-intel.js`
- `renderer/src/js/workflow-recorder.js`
- `renderer/src/js/views/workflow-intelligence.js` (+ `workflow-intelligence/` subfolder: `library.js`, `editor.js`, `execution-monitor.js`, `history.js` — mirrors existing `unit-detail/` subfolder split pattern)
- `renderer/src/js/components/workflow-recorder-hud.js`

**Modified files:**
- `src/store/index.js` — REGISTRY additions
- `src/orcha/index.js` — export `workflowLearn`
- `src/orcha/orchestrator.js` — `INTENT_TYPES.RUN_WORKFLOW` + handler
- `src/orcha/recommend.js` — `SUGGEST_WORKFLOW` action type
- `src/orcha/guardian.js` — confidence-threshold rule
- `src/ipc/orcha.js` — hook action-capture injection into `open-popup`
- `src/ipc/index.js` — register `workflow-intel.js`
- `preload.js` — new `window.workflowIntel` namespace
- `renderer/src/js/components/toolbar.js` — new nav tab
- `renderer/src/js/components/draft-inbox.js` — workflow-suggestion card type
- `renderer/src/js/components/orcha-fab.js` — dock recorder HUD trigger
- `src/types.js` — `WorkflowStep`/`WorkflowRecording`/`WorkflowExecution` typedefs

---

*End of Phase 8 design document. No code has been written yet — this is the plan for review before implementation
begins, consistent with this project's existing STAGE/PHASE-plan-before-build convention.*

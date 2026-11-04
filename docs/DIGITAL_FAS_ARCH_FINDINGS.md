# Digital Fleet Asset Specialist — Slack Architecture Findings

**Scope:** Read-only investigation of the current Slack + AI architecture in
`C:\Users\zilasant\Desktop\Z Santiago\fleet-version-c`, to plan unifying all
Slack reasoning under a single Digital Fleet Asset Specialist (Digital FAS)
agent. No code was modified.

> Note on method: all files were read with PowerShell `Get-Content` /
> `Select-String` against the Desktop repo (the sandboxed read tools point at a
> stale mirror and were NOT used for content). Line numbers below are from the
> Desktop copy at the time of investigation.

---

## SUMMARY ANSWER (read this first)

The modern **Digital FAS** stack (`src/orcha/fas/*` + `src/ai/core.js`) already
exists, is well-built, and is **already wired into live inbound** for both DMs
and channels — but it is **gated behind a mode switch** (`fas/config`:
`disabled | shadow | approval | autonomous`, default **shadow/disabled**). In
shadow/disabled mode the **legacy persona brains still own every reply**; FAS
only runs and records a comparison. So today, in a default install:

| Surface | Who actually replies today (default shadow/disabled) | Who replies when FAS `approval`/`autonomous` |
|---|---|---|
| (a) 1:1 DM | **Legacy** `slack_dm_autoreply.js` + `slack-dm-persona.js` | **FAS** runner (legacy silent) |
| (b) self-DM | Legacy DM path (self-reply marker guards loop) | FAS (source `self_dm`) |
| (c) group DM | Legacy DM path (group-aware prompt) | FAS (`isGroup:true`) |
| (d) partner / Slack-Connect channel | **Legacy** `slack_channel_watch.js` + `slack-partner-persona.js` | **FAS** runner (legacy silent) |
| (e) watched channel | Legacy channel-watch path | FAS runner |

Both legacy engines call the **same seam** `_aiInbound()` →
`aiCore.handleInbound()` → `fas/runner.handleInbound()` → `fas/agent.runAgent()`.
So the "one brain" plumbing is **already present**; what is missing is the
target architecture's **front door and policy layer**:

- **No single Slack Gateway** (`src/slack/gateway.js` does **not** exist). Two
  independent pollers (`slack_dm_autoreply.js`, `slack_channel_watch.js`) remain
  the entry points; normalization is duplicated across both.
- **No deterministic permission-policy module** (`fas/permission-policy.js`
  does **not** exist). Authorization is enforced imperatively inside
  `fas/executor.js` + `fas/sender-profiles.js`, **per-sender only**.
- **No audience resolver.** Permission is resolved for the *sender*, never for
  the *visible audience* of a group DM / channel. The word "audience" appears
  only as a knowledge-retrieval hint, not as an access control.
- **No channel-role registry** (information-feed vs conversational). No module
  classifies a channel as a data feed.
- **The FAS decision contract has no relevance/placement enum.** It emits
  `answer | research_more | act | clarify | escalate` only. There is **no**
  `DO_NOT_REPLY / ACKNOWLEDGE_ONLY / REPLY_IF_NEEDED / ESCALATE_WITHOUT_PUBLIC_REPLY`
  and **no** `replyPlacement` (`dm | thread | top_level | none`) semantic field.
  "Should I reply?" and thread-vs-top-level are still decided by **legacy
  heuristics in transport code**.
- **Legacy transport still contains independent fleet action logic** — notably
  `_detectFlipRequest()` / `_maybeAutoFlip()` in `slack_dm_autoreply.js`, which
  calls lifecycle automation directly, bypassing the FAS executor/permission
  gate when FAS is not primary.

Everything else the target calls for — multimodal evidence (vision/PDF/text),
link allowlist research, per-unit + original-requester authorization, exactly-
once inbound claims, API-first verified mutation, decision/audit logging — is
**already implemented** in `fas/*` and is strong.

---

## 1. INBOUND FLOW

### Entry points / pollers
There are **two** independent pollers, each with its own re-entrancy lock,
watermarks and batching. Both are started/gated from `src/ipc/slack.js`.

- **`src/scrapers/slack_dm_autoreply.js`** (~105 KB) — DM / group-DM / self-DM
  engine. Public poll: `pollDMAutoReplyOnce(log)` (L919).
- **`src/scrapers/slack_channel_watch.js`** (~68 KB) — partner / watched-channel
  engine. Public poll: `pollChannelsOnce()` (referenced around L438–459).
- **`src/scrapers/slack_inbound_support.js`** (~13 KB) — shared helpers (contact
  discovery, send-block registry, manual-reply detection, lifecycle records).
- **`src/scrapers/slack_send.js`** (~35 KB) — the single authenticated Slack Web
  API transport (read/send/open/search/download).
- **`src/scrapers/slack_decision_trace.js`** (~3 KB) — appends decision-trace
  lines (`trace(e)`, L44; `module.exports = { trace }`, L65).
- **`src/ipc/slack.js`** (~31 KB) — IPC + the dual-instance **leader gate**
  (`_mayPollSlack()`, used at L347 & L393 to skip polling on a standby).

### Polling trigger & leader gate
`ipc/slack.js` schedules the pollers and refuses to poll when this instance is
not the production leader: `if (!_mayPollSlack()) return { skipped: 'standby —
not the production leader' };` (L347, L393). `_mayPollSlack()` consults
`require('../cluster')` (L31) and defaults to `true` when cluster is absent
(legacy single-host).

### Normalization
Messages are mapped in `slack_send.js` `_mapMsg(m, channelId)` (L292) and read
via `readMessages()` (L317), `readThreadReplies()` (L356), `listOpenDMs()`
(L507). **Each poller then builds its own ad-hoc normalized object inline** when
it calls `_aiInbound({...})` — e.g. the DM path assembles
`{ engine:'dm', slackId, senderName, channelName, channelId, threadTs, ts, text,
isGroup, conversation, attachments, files, isSelf }`
(`slack_dm_autoreply.js` ~L1150–1162). The channel path builds an analogous
object (`slack_channel_watch.js` ~L1083). **There is no shared normalizer** — this
is the duplication the target "one Gateway" is meant to remove.

### Dedupe / watermark / exactly-once
- **Watermark (per thread/DM):** `_saveThreadLastSeen()` / `_saveThreadSeen()`
  (`slack_dm_autoreply.js` L130) persist `{name,lastSeenTs,isGroup}` to store
  `slackDMThreadReplyCount` / thread config. First-ever poll only *baselines*
  (no reply to backlog) — documented header L24.
- **Thread-reply baseline restore:** `_threadReplyCount` is restored from store
  at startup (L99) — fixes spurious re-replies after restart.
- **Durable exactly-once claim (spec v2):** `src/orcha/fas/inbound-claim.js`.
  Acquired BEFORE either engine processes a message:
  `_inboundClaim.acquire({ channelId, ts, threadTs, owner:'digital-fas' })`
  (`slack_dm_autoreply.js` ~L1145). State machine via
  `markDelivered` / `markOwnedQueued` / `markFailed` / `transferToLegacy` /
  `release` (L1146 block onward). This is the authoritative single-owner
  guarantee so FAS + legacy can never both reply, and retries/restarts can't
  duplicate. Keyed `channel|ts|threadTs`.
- **In-memory dedupe:** reply-log (`slackDMReplies`) + watermark still dedupe if
  the claim module is unavailable (header L76).

### Rapid-message batching
`_batchRapidMessages(msgs)` (`slack_dm_autoreply.js` L244) collapses consecutive
messages from the **same sender** within `BATCH_WINDOW_S = 60` (L242) into one
consolidated entry, using the LAST message ts as the watermark (L281). Caps:
`MAX_MESSAGES_PER_POLL = 5` (L84), `MAX_DMS_PER_POLL = 200` (L89),
`MAX_LOG_ENTRIES = 500` (L85).

### Manual-reply detection / loop prevention
- **Operator already replied:** `inbound.manualReplyByOperator(messages,
  { myUserId, incomingTs, threadTs })` (`slack_dm_autoreply.js` L1124). If the
  operator (Z) replied in the Slack app after this message, the engine skips.
- **Own-message loop prevention:** replies carry `SELF_REPLY_MARKER`
  (exported from `slack_send.js`); `_isOwnMarkedReply(m)` (L1076) and userId !=
  own userId filter out the bot's own messages. Self-DM uses `_selfDmIds` +
  the marker (sendToChannel wrapper L940).
- **AITeammate loop prevention:** the internal ASK_INTERNAL agent's DM channel
  `_AITEAMMATE_CHANNEL` (L81, default `D0BTCKCQKA9`, overridable from
  `orcha/ask-internal`) is never auto-replied to (early return L979, L1004).

### Rate-limit / backoff
- **AI backoff:** `_backoffMs(attempts)` = `min(30000 * 2^attempts, 15m)`
  (L114); per-message retry state `_retryState(id)` (L113);
  `MAX_AI_RETRIES` escalates to the review queue after exhaustion (~L1360-1390).
- **Slack replies rate-limit skip:** `_rlUntil` epoch gate (L92) skips
  `conversations.replies` calls while rate-limited.
- **Re-entrancy lock:** `_pollLock` (L91) — mirrors channel-watch's lock that a
  header comment says prevents a real duplicate-reply incident from overlapping
  polls.

---

## 2. REASONING PATHS (legacy vs modern; which runs today)

### LEGACY (independent "brains")
- `src/orcha/slack-dm-persona.js` — exports `PERSONA_SYSTEM_PROMPT`,
  `COVERING_PREFACE` (consumed at `slack_dm_autoreply.js` L38, used L795).
- `src/orcha/slack-partner-persona.js` — exports `PERSONA_SYSTEM_PROMPT`
  (consumed at `slack_channel_watch.js` L32).
- AI reasoning inside the pollers: `_classifyAndDraft()`
  (`slack_dm_autoreply.js` L709) and the channel classifier emitting
  `{inScope, reply, category, title}` (`slack_channel_watch.js` L313, L371).

### MODERN (Digital FAS)
- `src/orcha/fas/runner.js` — **unified live runner**; `handleInbound(input,
  deps)` (L~100). Modes documented in the header (L~10-30).
- `src/orcha/fas/agent.js` — the **research→decide loop**; `runAgent(input)`
  (entry ~L404-429). Builds evidence, runs the bounded loop, review-and-refine
  pass (`_reviewAndRefine`, L~175), returns the structured decision.
- `src/ai/core.js` — **thin orchestration facade** `run(request)` (L~90) and
  `handleInbound(...)`. It does NOT re-implement reasoning; it normalizes a
  surface onto the FAS agent input, validates via `ai/schemas.js`, records an
  `ai/trace.js` trace, and returns a standardized result. Header is explicit:
  "AiCore is a THIN ORCHESTRATION FACADE over the already-production Digital
  FAS layer … It does NOT re-implement intent detection, tool calling,
  evidence, permissions, idempotency, verification, or cluster claims."
- Supporting modules all present under `fas/`: `executor.js`,
  `action-registry.js`, `tool-registry.js`, `evidence.js`, `inbound-claim.js`,
  `injection-guard.js`, `attachment-research.js`, `link-research.js`,
  `sender-profiles.js`, `compliance.js`, `coverage.js`, `scheduler.js`,
  `slack-search.js`, `roster-lookup.js`, `case-store.js`, `context-budget.js`,
  `playbook.js`, `shadow.js`, `arg-schema.js`, `config.js`.

### The seam (identical in both pollers)
```
_aiInbound(input, deps)                          // transport
  → aiCore.handleInbound(input, deps)            // src/ai/core.js (if present)
    → fas/runner.handleInbound(input, deps)      // else direct fallback
      → fas/agent.runAgent(agentInput)           // the actual brain
```
`slack_dm_autoreply.js` L62-69 and `slack_channel_watch.js` L37-44 define this
seam identically, each falling back to the runner directly if `ai/core` is
unavailable, then to `{ letLegacyReply:true }` if neither loads.

### Which path runs — governed by mode
`fas/config.get()` yields `mode`. The pollers read it:
`slack_dm_autoreply.js` L1199 / L1622; `slack_channel_watch.js` L1074.
- `disabled` → runner returns `{ letLegacyReply:true }` immediately
  (`runner.js` handleInbound early return). Legacy brain replies.
- `shadow` → FAS runs, records an audit comparison (`fasAuditLog`,
  `_divergence()` runner.js L~70), returns `{ letLegacyReply:true }`. **Legacy
  still replies.** This is the default-ish dormant state.
- `approval` → FAS primary; proposed reply + actions **queued**; legacy silent
  (`{ letLegacyReply:false }`).
- `autonomous` → FAS primary; routine/confident/verified answers auto-sent,
  else queued; legacy silent. Auto-send floor `AUTO_SEND_MIN_CONFIDENCE = 0.75`
  (`runner.js` L~56), blocked by approval-level actions, missing/conflicting
  facts, or **stale evidence**.

So **FAS is wired to live inbound but dormant** unless the operator selects
`approval`/`autonomous`. When primary, the pollers run the FAS gate BEFORE any
legacy classify/flip/WR (execution-order gate, `slack_dm_autoreply.js`
~L1197-1340; `slack_channel_watch.js` L1075-1148).

### ai/core ↔ fas/agent ↔ fas/runner
`ai/core.run()` calls `fas/agent.runAgent()` directly (core.js L~137) and
validates the result (`schemas.validateOrRepair`, core.js L~160). `ai/core`'s
`handleInbound()` path delegates to `fas/runner.handleInbound()` so inbound
Slack keeps the runner's mode routing. `ai/core` never sends Slack or mutates —
it only proposes (header, core.js L~15-20). The runner owns mode routing +
queueing; the agent owns the research/decision; core is the standardizing
facade + trace.

---

## 3. DECISION / REPLY LOGIC

### "Should I reply?" today
- **DMs:** effectively "always answer" — legacy header (`slack_dm_autoreply.js`
  L10-13) states it ALWAYS sends a reply (real answer or holding reply). The
  only suppressors are: operator already replied (`manualReplyByOperator`),
  own/AITeammate loop guards, AI `_skip`/`_fallback` holds, and send-blocks.
  There is no semantic relevance decision for DMs.
- **Channels:** `slack_channel_watch.js` uses an AI **in-scope** classifier
  returning `{"inScope":true|false,"reply":...,"category":"alert|action|workflow"|null,"title":...}`
  (L313, parsed L371). "Addressed to me?" for non-@mentions is a persona-prompt
  judgment (`slack-partner-persona.js` prompt text ~L231) — not a structured
  enum.

### Reply-placement (thread vs top-level) today
No semantic placement decision exists. Placement is implicit in transport:
channel replies thread off the parent ts the watermark walked; DM replies go to
the DM. There is **no** `replyPlacement` field and **no** code that decides
"start a thread from a top-level message" vs "post top-level."

### Audience / permission-before-exposure today
**None at the audience level.** Authorization resolves the *sender* only (see §4).
The only "audience" awareness is a group-DM prompt note telling the model the
reply is visible to everyone (`_classifyAndDraft` groupBlock,
`slack_dm_autoreply.js` L722-726) and a knowledge-retrieval audience hint
(`agent.js` L257; `slack_channel_watch.js` L297
`knowledgeAudience: allowRoster ? 'internal' : 'external'`). Neither restricts
data by what the *visible audience* is cleared to see.

### Channel-role classification (information-feed vs conversational)
**Does not exist.** No registry, no classifier. (Searched
`channelRole|information.?feed|data.?feed` — no hits in the Slack/FAS modules.)

### Decision enums / reason codes that DO exist
- **FAS decision contract** (`agent.js` L68-71, mirrored in `ai/schemas.js`
  L22 `DECISION_TYPES`):
  `answer | research_more | act | clarify | escalate`.
  Fields: `{decision, confidence, reason, research[], actions[], reply,
  followUp}`. Terminal decisions must carry a non-empty `reply`
  (`schemas.js` L75). **No DO_NOT_REPLY / ACKNOWLEDGE_ONLY / REPLY_IF_NEEDED /
  ESCALATE_WITHOUT_PUBLIC_REPLY. No replyPlacement.**
- **Legacy channel classifier enum:** `inScope` boolean + `category` ∈
  `alert | action | workflow` (`slack_channel_watch.js` L313).
- **Inbound lifecycle reason codes** (`slack_inbound_support.js` L222 `REASON`):
  `MANUAL_REPLY='operator-already-replied'`,
  `SEND_FAILED_RETRY='send-failed-retry-scheduled'`,
  `QUEUED_REVIEW='queued-for-manual-review'`,
  `LEGACY_FALLBACK='ai-failed-legacy-fallback'`,
  `SENT='reply-sent'`. Stages: `detected | discovered | resolved | ai-requested
  | ai-ok | ai-failed | sent | skipped | blocked | queued | retry | watermark`
  (L255).
- **Runner outcomes:** `disabled | shadow | queued | manual-review | auto-sent |
  auto-send-failed | error-failsafe | ai-failed-shadow` (runner.js handleInbound).

---

## 4. CONTACT BOOK & IDENTITY / PERMISSIONS

### Contact Book — `src/services/contact-book.js` (the single source of truth)
Enumerations (L40-41):
`LIFECYCLE_PERMS = ['not_allowed','may_request','trusted_autonomous']`,
`CREATE_WR_PERMS = ['not_allowed','may_request','trusted_autonomous']`.
Schema fields (from `sanitize()` L156-174 + merge logic):
`id`, `slackId`, `identityType` (∈ `VALID_IDENTITY`, invalid → `unknown`,
L158), `role`, `org`, `email`, `operators[]` (uppercased, L168),
`domiciles[]` (uppercased, L169), `allowedDataCategories[]`,
`permittedRequestTypes[]`, `lifecyclePermission` (default `not_allowed`, L159),
`createWrPermission` (default `not_allowed`, L160), `coverMe` (forced false for
vendors, L167), `enabled` (bool, L173). Wildcard scope token `'*'` = all
operators/domiciles (L43).
**Vendor hard-lock:** `identityType === 'vendor'` forces
`lifecyclePermission = createWrPermission = 'not_allowed'` and `coverMe = false`
(L164-167) — a mechanic may ask, an operator acts.
**Upsert/dedupe:** by `id`, then case-insensitive `slackId` (L226-243), vendors
dedupe by name+company (L233). A `slackId` collision with a different contact is
rejected (L241-243). Emits `contact-book:updated` (`_emitUpdated`, L199).

### FAS profile resolution — `src/orcha/fas/sender-profiles.js`
`resolveSender(slackId, name)` resolves a contact into a scoped profile.
`_fromContact(c)` (L~100) reads the explicit FAS fields if present, else applies
a type preset. Data categories (L19) and request types (L20) are defined there
too. Identity inference `_inferType(c)` (L77) is deliberately conservative: an
untriaged `type:'slack'` DM sender stays **`unknown`**, only an Amazon org/email
infers `internal`, declared vendor → `vendor`, explicit scope → `carrier`.
Default scope `_defaultScopeFor` (L68): internal/unknown → `['*']`;
carrier/vendor → `[]` (empty external scope = NO data). Note: `unknown`
intentionally gets ALL data categories + ALL request types + ALL scope but
**never** lifecycle/create-WR (both default `not_allowed`) — see
`_limitedDefaults` L27-49 and preset note L52-62. Helpers used by the executor:
`canRequest(profile, type)`, `scopeUnitForSender(profile, row)`.

### Slack profile enrichment / freshness
- Enrichment is **name-level**, not a rich `users.info` profile sync into the
  FAS permission model. `slack_send.js` `resolveUserName(userId)` (L390) and
  `_resolveDmSenderName()` (L423) resolve display names (cached). Contact
  auto-discovery happens via `slack_inbound_support.discoverOneSender()` (L82)
  → `contactBook.discoverFromDM()`. Enterprise Grid blocks bulk directory calls
  (`slack_send.js` L132-144 `searchDirectory`), so there is no workspace-wide
  `users.list` enrichment.
- **Freshness/TTL:** permissions have no TTL (they're operator-set, authoritative
  until changed). The TTL/freshness machinery that exists is for **fleet
  evidence** (`fas/evidence.js` stale facts, source-freshness) and the
  **send-block recheck** (`slack_inbound_support.js` `SEND_BLOCK_RECHECK_MS =
  30min`, L37), not for identity.

### Where authorization is enforced (imperative, per-sender)
`src/orcha/fas/executor.js`:
- `_authorizeUnitAction(name, args, profile, action)` (L112): checks
  `profiles.canRequest(profile, action.requires)` (L122), rejects actions
  requiring "internal/operator approval" (L128), and enforces **per-unit scope**
  for external senders via `profiles.scopeUnitForSender(profile, row)` (L147).
- **Original-requester authorization (Part 5)** (L155+): execution is checked
  against the IMMUTABLE requester snapshot, NOT the approving operator's
  authority — `runner.js` `_buildRequesterSnapshot(input)` (L~40) captures
  `lifecyclePermission`, `createWrPermission`, scope, request types at inbound
  time. Tests confirm an operator's Approve cannot widen a requester's rights
  (`tests/fas-requester-authorization.test.js`).
- **Power-unit scope gate:** `executor.js` L~92-102 rejects non-power-units
  (`power-unit:not-in-scope`) for MOVE_UNIT/SUBMIT_WORK_REQUEST.

### Deterministic permission-policy module?
**Does NOT exist.** No `src/orcha/fas/permission-policy.js` (dir listing
confirms only `action-registry.js` + `tool-registry.js` match
`policy|permission`). Authorization is spread imperatively across
`executor.js`, `sender-profiles.js`, and `contact-book.js`. The target's
"deterministic permission policy" layer is a **new module** to extract.

---

## 5. ATTACHMENTS / FILES / IMAGES / URLS

### `src/orcha/fas/attachment-research.js` — shared files
Downloads via `slack_send.downloadFileBuffer` (authenticated), then extracts by
type (header L10-23):
- text / csv / json / md / log / html → decode (`_isTextual` L~55, `_isHtml`
  L~70, `_htmlToText` L~78).
- png / jpg / gif / webp → **Bedrock vision** (`bedrock.readFileWithVision`,
  `image` block).
- pdf / docx / xlsx → **Bedrock document** (`document` block).
Then runs the injection guard (UNTRUSTED), caps `MAX_TEXT = 6000`,
`MAX_FILES = 3`. Extracts unit ids from content (`_extractUnits` L~44) and feeds
them back through the same per-unit research (GET_UNIT re-validates/authorizes).
Returns `{ evidence, units, refused }`.

### `src/orcha/fas/link-research.js` — URLs
Parse+normalize → check host against the **fasConfig approved-domain allowlist**
→ open ONLY https allowlisted hosts via the app's authenticated Electron session
→ extract text, cap `MAX_TEXT = 6000`, `FETCH_TIMEOUT_MS = 20000`, treat as
UNTRUSTED (injection guard). Refuses http/file:/data:/loopback/private-IP/non-
allowlisted (header L13-20). **AAP deep-links** (`AAP_SERVICE_RE` / `AAP_ASSET_RE`,
L35-36) are resolved via the **AAP JSON API** (`aap_api.getService/getAsset` +
`aap_api_mapper.toFleetRow`) to avoid the SPA render race — returns real
lifecycle/vendor/WR/conversation data.

### Injection guard
`src/orcha/fas/injection-guard.js` — `wrapUntrusted(label, text)` fences
untrusted content; used in `agent.js` (`_attachmentsBlock` L~85, review prompt),
and in both research modules.

### What is MISSING vs target (confirmed)
The target modules **do not exist** (dir listing of `src/orcha/fas`):
`document-intelligence`, `image-intelligence`, `url-intelligence`,
`evidence-normalizer`, `attachment-resolver`. Current coverage is functionally
close (vision + document + text + allowlisted-URL + AAP-API), but it is **not
factored into the dedicated normalizer/resolver modules** the target names, and
there is no generalized "should this source trigger more in-app research"
planner beyond the unit-id extraction already in `attachment-research.js`.

---

## 6. ACTIONS

### `src/orcha/fas/action-registry.js` — actions + verify
Each action declares `level` (`'low'` auto-runnable when authorized+whitelisted,
or `'approval'`), optional `requires` (request-type), `idempotencyKey(args)`,
`run()`, and `verify(args, ctx, runResult)` that confirms via the SOURCE system
(header L3-14). Implemented:
- **Low (auto, still verified):** `ADD_TIMELINE_NOTE` (write + read-back verify,
  L34-56), a reminder action (L62-76), a case-persist action (L82-102).
- **Approval + API-first + verified:**
  - `MOVE_UNIT` (lifecycle change, L112): API-first via the lifecycle API, falls
    back to browser automation (L146-148); `verify()` requires an **AAP
    read-back** confirming the new state, else DEFERS to `verifying` (never
    claims success on a bare ok — L156-199).
  - `SUBMIT_WORK_REQUEST` (L205): `requires:'create_wr'`, via
    `aap_create_wr`, with `verify()` (L217).
- **Read tools (never mutate)** live in `tool-registry.js` `TOOL_NAMES`
  (L535-553): `GET_UNIT, GET_REPAIR_TIMELINE, GET_OPEN_WORK_ORDERS,
  GET_PM_STATUS, GET_INSPECTION_STATUS, GET_UPTAKE_INSIGHTS,
  GET_RELAY_GARAGE_UNIT, GET_RELAY_WORK_ORDERS, GET_RELAY_WORK_ORDER_DETAILS,
  GET_RELAY_REPAIR_TIMELINE, GET_OFFSITE_EVENT, GET_OFFSITE_EVENT_TIMELINE,
  GET_SITE_SUMMARY, GET_OPERATOR_SUMMARY, GET_VENDOR_CONTACT,
  GET_SENDER_PROFILE, GET_COVERAGE, GET_COMPLIANCE_REQUIREMENT`.

`src/orcha/fas/executor.js` runs `run()` then `verify()` and only reports
success if verify confirms (header L14-20); modes: `shadow` (no execute),
`approval` (queue), `autonomous` (low-risk + authorized + whitelisted →
execute+verify now).

### Duplicate action logic in Slack transport — YES (to retire)
`src/scrapers/slack_dm_autoreply.js` independently detects and executes fleet
mutations, bypassing the FAS executor/permission gate when FAS is not primary:
- `_detectFlipRequest(messageText, historyMsgs)` (L337) — detects "flip/activate/
  put back/release [unit]", with last-unit-from-history fallback.
- `_maybeAutoFlip(unitToken, tagPrefix, senderId, senderName)` (L566) — flips
  Unavailable→Active directly, using the same automation as
  `src/scrapers/setLifecycle.js` (header L288-301), with its own guardrails
  `FLIP_BLOCK_REASONS` (L301) and `_flipBlockLabel` (L304).
- `_detectWRRequest()` (L456) / `_maybeDraftWR()` (L520) / `_buildWRDraft()`
  (L493) — independent Create-WR drafting.
- `_verifyUnitFresh()` (L385) — its own verify-before-claiming.
These are **independent intelligence + duplicate action selection** living in
transport. In `approval`/`autonomous` the execution-order gate (L1197+) runs FAS
first and skips them; but they remain the live path in `disabled`/`shadow` and
are exactly what the target says to retire. The channel engine similarly reaches
into `processOrchaAction`/`confirmSend` (`slack_channel_watch.js` L554) and PM-
alert reply automation (L611, L809).

---

## 7. SAFETY / INFRA

### Cluster leader / fencing gating of Slack sending
- **Polling gate (primary, active today):** `ipc/slack.js` `_mayPollSlack()`
  (uses `require('../cluster')`, L31) — a standby instance **skips polling**
  entirely (L347, L393 `skipped: 'standby — not the production leader'`). This
  is the main dual-instance "don't double-reply" control.
- **Service-layer side-effect gate (defined, the intended chokepoint):**
  `src/cluster/mode-gate.js` — `assertCanSideEffect(kind)` (L110, throws typed
  error) / `canSideEffect(kind)` (L81). Capability sets by mode (L42):
  `ACTIVE` permits `slack-send, fleet-mutate, email-send, sp-push, browser,
  schedule-fire`; `STANDBY` permits none. Exposed via `src/cluster/index.js`
  `assertCanSideEffect` (L537), plus `mayRunProduction()` (L544) /
  `mayLivePull()` (L562). **Caveat:** a grep of the whole `src` tree shows the
  `'slack-send'` / `'fleet-mutate'` kinds are **declared in the gate but not yet
  called at the `slack_send.js`/executor send sites** — today's enforcement is
  predominantly the polling-level leader gate + `mayRunProduction()`, with the
  per-kind `assertCanSideEffect` chokepoint available but not universally wired.
  (Only `cluster/*` and docs reference the kinds; `browser_provider.js` L27 is a
  comment.) Worth confirming/strengthening during the rewire.

### Send-block / rate-limit enforcement
- **Temporary send-block registry:** `slack_inbound_support.js` — store
  `slackSendBlocks` (L34) `{ [channelId]: {reason, blockedAt, recheckAt} }`,
  `isSendBlocked(channelId)` (L135), recheck TTL `SEND_BLOCK_RECHECK_MS = 30min`
  (L37). A `restricted_action` marks a conversation temporarily blocked rather
  than permanently.
- **Rate-limit / backoff:** `slack_dm_autoreply.js` `_rlUntil` (L92) skips
  replies-API calls while rate-limited; AI backoff `_backoffMs` (L114).
  `slack_send.js` is the single transport (`slackWebApi` L70) — individual read
  helpers swallow one-off failures so one DM/channel failing doesn't block the
  rest (L577 comment).

### Decision / action / reply logs
- `slack_decision_trace.js` — `trace(e)` (L44) appends per-decision trace lines.
- `fas/case-store.js` — `fasCases` store (L17); `upsert/getCase/findRelated`
  (L45-64), follow-up scheduling (`dueFollowUps` L99). Authoritative case
  memory/promises.
- `ai/trace.js` — standardized AiCore trace (`start(meta)` L45, store `CAP`-
  capped, L33-34).
- Runner **audit log:** `fasAuditLog` store, `_appendAudit` (runner.js L~66),
  `AUDIT_CAP = 500`.
- Legacy **reply log / review queue:** `slackDMReplies` store via
  `_appendReplyLog` (`slack_dm_autoreply.js` L146), `getDMReviewQueue` (L153),
  `getDMReplyLog` (L159).

---

## 8. TESTS (existing coverage)

~70 relevant specs under `tests/`. Highlights:

**AI Core:** `ai-core-phase-a`, `ai-core-phase-c-inbound` (handleInbound native
runner shape; derives `channel` / `self_dm` sources), `ai-core-phase-d-autoflip`,
`phase-e`, `phase-f-router`, `phase-g-memory`, `phase1-tools-loop`,
`phase2-authority-exec`, `phase3-session-budget`, `phase4-surface-migration`,
`phase5-actions-err`, `phase6-memory-perf`, `phase7-safety-heal`.

**FAS runner / agent:** `fas-runner-modes` (DISABLED legacy-replies, SHADOW
records+queues-nothing, APPROVAL queues, AUTONOMOUS auto-sends confident /
queues low-confidence+clarify / safe-defaults SEND_SLACK), `fas-research-loop`,
`fas-shadow`, `fas-primary-engine-gaps` (unsupported-asset routing, DOT evidence
gating, exactly-once restart).

**Authorization / identity:** `fas-requester-authorization` (operator Approve
cannot bypass requester perms; not_allowed/may_request/trusted_autonomous;
out-of-scope blocked), `fas-unit-authz`, `fas-identity-model`,
`fas-profile-validation`, `fas-contactbook-migration`, `contact-book-service`,
`fas-contacts-ipc`, `fas-power-unit-gate`.

**Evidence / actions / verify:** `fas-evidence-scoping`, `fas-evidence-fixes`,
`fas-source-freshness`, `fas-idempotency-verify`, `fas-idempotency-recovery`,
`fas-deferred-verify-resume`, `fas-lifecycle-reconcile`,
`fas-integration-transaction`, `fas-autonomous-delivery-safety`, `fas-arg-schema`,
`fas-inspection-status`, `fas-compliance`, `fas-coverage(+-compliance-tools)`,
`fas-relay-tools`, `fas-slack-search(+-production)`, `fas-ask-internal-sideeffect`,
`fas-auto-actions-config`, `fas-reply-approval`, `fas-inbound-claim`,
`fas-followup-scheduler`, `fas-case-scheduler`, `fas-promise-dueat`,
`fas-last-outcome`, `fas-stage-9/a/b/c/d/e`, `fas-thread-count-restore`.

**Slack transport / inbound:** `slack-inbound-pipeline` (decoupled contact
discovery; first-DM reply vs old-backlog baseline; group-DM backlog; duplicate
poll doesn't double-reply), `slack-inbound-support`, `slack-dm-polling`,
`slack-group-dm` (mpims listing + joined display name), `slack-history-context`,
`slack-thread-continuation`, `slack-justme-queue`, `slack-directory-search`,
`slack-auth-status`.

**Gaps in test coverage (no existing specs for the target behaviors):** no
tests for a relevance decision (`DO_NOT_REPLY/ACKNOWLEDGE_ONLY/...`), no
reply-placement (thread vs top-level vs none) tests, no **audience**-permission
tests, no channel-role classification tests, no single-gateway normalization
tests. These are the golden tests to add.

---

## GAP ANALYSIS (target → exists / missing / rewire)

Legend: **EXISTS** (keep), **MISSING** (build), **REWIRE** (present but must be
re-pointed), **RETIRE** (independent intelligence to remove), **KEEP-INFRA**
(transport/reliability to preserve).

| Target capability | Status | Where / Notes |
|---|---|---|
| Single Slack **Inbound Gateway** (`src/slack/gateway.js`) with one normalized event shape | **MISSING** | No gateway. Normalization is duplicated inline in `slack_dm_autoreply.js` (~L1150) and `slack_channel_watch.js` (~L1083). Build one gateway both pollers feed. |
| AI Core as the single entry (`aiCore.handleInbound`) | **EXISTS / REWIRE** | `src/ai/core.js` already the façade; both pollers already call it via `_aiInbound`. Rewire the new gateway to call it exclusively. |
| Digital FAS = sole reasoning brain | **EXISTS (dormant) / REWIRE** | `fas/agent.js` + `fas/runner.js` run live but only own replies in `approval`/`autonomous`. Make FAS primary and remove the legacy fallback-as-default. |
| Human-like **relevance decision** (REPLY/DO_NOT_REPLY/ACKNOWLEDGE_ONLY/REPLY_IF_NEEDED/ESCALATE_WITHOUT_PUBLIC_REPLY) | **MISSING** | `agent.js` contract is `answer/research_more/act/clarify/escalate` only (L68). Extend the decision schema (`agent.js` + `ai/schemas.js` L22) with a `shouldReply`/`reasonCode` relevance layer; replace legacy "always reply" (DM header L10) and the channel `inScope` boolean (`slack_channel_watch.js` L313). |
| Structured communication decision object (`shouldReply/reason/reasonCode/replyPlacement/audienceSensitivity/intent/entities/needsResearch/needsAction/confidence`) | **PARTIAL / MISSING** | `confidence/reason/actions/followUp` exist; `shouldReply/reasonCode/replyPlacement/audienceSensitivity/intent/entities` do not. Add to the contract. |
| **Reply placement** (dm/thread/top_level/none) as a semantic decision | **MISSING** | No placement field or logic anywhere. Build it into the FAS decision + a transport applier. |
| **Audience resolver** + effective-audience permission before exposure | **MISSING** | Only sender is resolved. Build an audience resolver (group-DM members / channel membership via `slack_send` members calls) feeding a conservative effective-permission. |
| **Deterministic permission policy** module | **MISSING** | No `permission-policy.js`. Authorization is imperative in `executor.js` (`_authorizeUnitAction` L112, requester snapshot L155) + `sender-profiles.js`. Extract a deterministic policy that takes {sender, audience, action/category, unit scope} → allow/deny, reused by agent (pre-exposure) and executor (pre-mutation). |
| **Channel-role registry** (information-feed vs conversational) | **MISSING** | No classifier/registry. Build one; feed the relevance decision (feeds default to DO_NOT_REPLY/observe). |
| Contact Book as single identity/permission source | **EXISTS (keep)** | `services/contact-book.js` — 3-state perms (L40-41), vendor lock (L164), scope, enabled, coverMe. Mature. |
| 3-state perms `not_allowed/may_request/trusted_autonomous` | **EXISTS (keep)** | `contact-book.js` L40-41; enforced `executor.js` + `runner.js` requester snapshot. |
| Identity enrichment (`users.info`) when needed | **PARTIAL** | Name-level resolution (`slack_send.resolveUserName` L390); Enterprise Grid blocks bulk directory. Add on-demand `users.info` profile enrichment into the Contact Book if needed; no identity TTL today. |
| Multimodal evidence (image/pdf/url/text) | **EXISTS (keep) / rename** | `fas/attachment-research.js` (vision+doc+text) + `fas/link-research.js` (allowlist+AAP-API). Target's `document/image/url-intelligence`, `evidence-normalizer`, `attachment-resolver` modules **do not exist** — the capability does; refactor/rename if the target structure is required. |
| Injection guard on untrusted content | **EXISTS (keep)** | `fas/injection-guard.js` `wrapUntrusted`; applied in agent + both research modules. |
| Multi-step evidence/tool research loop | **EXISTS (keep)** | `fas/agent.js` bounded loop + `tool-registry.js` (18 GET_* read tools) + `fas/evidence.js`. |
| API-first verified mutation | **EXISTS (keep)** | `action-registry.js` MOVE_UNIT (API→verify read-back→defer, L112-199), SUBMIT_WORK_REQUEST (L205); `executor.js` run→verify. |
| Exactly-once inbound claim / dedupe / watermark | **EXISTS (keep-infra)** | `fas/inbound-claim.js` + `_saveThreadSeen` + reply-log. Move ownership to the gateway. |
| Rapid-message batching, backoff, rate-limit, send-block, manual-reply + loop prevention | **EXISTS (keep-infra)** | `_batchRapidMessages`, `_backoffMs`, `_rlUntil`, `slack_inbound_support` send-blocks/manual-reply, AITeammate/self-marker guards. Extract into the shared transport layer. |
| Slack polling / DM discovery / channel + group-DM monitoring / thread continuation / first-poll baseline | **EXISTS (keep-infra)** | `slack_send` (listOpenDMs/getChannels/readThreadReplies) + poller watermarks. Keep as transport under the gateway. |
| Cluster leader/fencing gating of sends | **EXISTS (partial) / strengthen** | Polling gate `_mayPollSlack()` (`ipc/slack.js` L347/393) active; `cluster/mode-gate.js` `assertCanSideEffect('slack-send'/'fleet-mutate')` defined (L42/L110) but not wired at the send/mutate call sites — wire it during the rewire. |
| Decision/action/reply/audit logs | **EXISTS (keep)** | `slack_decision_trace`, `fas/case-store` (`fasCases`), `ai/trace`, `fasAuditLog`, `slackDMReplies`. |
| **Legacy DM persona brain** | **RETIRE** | `src/orcha/slack-dm-persona.js` + `_classifyAndDraft` (`slack_dm_autoreply.js` L709) — independent reasoning. |
| **Legacy partner persona brain** | **RETIRE** | `src/orcha/slack-partner-persona.js` + channel `inScope` classifier (`slack_channel_watch.js` L313). |
| **Legacy flip / WR action logic in transport** | **RETIRE** | `_detectFlipRequest` (L337), `_maybeAutoFlip` (L566, calls `setLifecycle` directly), `_detectWRRequest`/`_maybeDraftWR` (L456/L520). Replace with FAS executor MOVE_UNIT / SUBMIT_WORK_REQUEST. |
| Legacy `inScope`/out-of-scope AI decision | **RETIRE** | `slack_channel_watch.js` L313/L371 — subsumed by the FAS relevance decision. |

### Retire vs Keep — one-line rule
- **Independent intelligence (RETIRE):** the two persona prompts, the DM
  "always-reply" draft path, the channel `inScope` classifier, and the in-
  transport flip/WR detection+execution.
- **Transport / reliability infra (KEEP, fold under the Gateway):** polling, DM/
  channel/group-DM discovery, thread continuation, watermarks, first-poll
  baseline, inbound-claim exactly-once, batching, backoff, rate-limit, send-
  block registry, manual-reply detection, self/AITeammate loop guards,
  attachment/link extraction, history retrieval, all the persisted logs, and
  the `slack_send.js` Web API wrapper.

### Recommended build order (not implemented here)
1. `src/slack/gateway.js` — one normalized event + ownership of inbound-claim/
   watermark/batching/loop-guards; both pollers (reduced to pure transport) feed
   it; it calls `aiCore.handleInbound` only.
2. Extend the FAS decision contract (`agent.js` + `ai/schemas.js`) with the
   **relevance** enum + **replyPlacement** + `reasonCode/intent/entities/
   audienceSensitivity`; add the placement applier in transport.
3. `src/orcha/fas/permission-policy.js` — deterministic policy consumed by both
   agent (pre-exposure) and executor (pre-mutation).
4. `src/orcha/fas/audience-resolver.js` + channel-role registry feeding the
   relevance + policy layers.
5. Delete/neuter the legacy persona brains and in-transport flip/WR logic once
   FAS is primary; keep the extracted transport/reliability infra.
6. Wire `cluster/mode-gate.assertCanSideEffect('slack-send'/'fleet-mutate')` at
   the actual send/mutate sites.
7. Add golden tests for relevance, placement, audience permission, channel-role,
   and gateway normalization (none exist yet).

# Digital FAS — Single Slack Reasoning Agent: Unification Plan

Status: proposed (grounded in the current code as of this session)
Branch: `feature/owa-triage-midway-fixes`

## 1. Where the code actually is today

This is **not** a greenfield build. A large part of the target architecture is
already implemented and migration is roughly at **Phase C** of the spec.

### Already built (keep, do not re-implement)

| Spec area | Existing implementation |
|---|---|
| Unified AI entry point (spec #1, #28) | `src/ai/core.js` — thin facade: `run()` + `handleInbound()` delegate to the FAS runner, add tracing, never mutate. |
| Digital FAS brain (research → decide) | `src/orcha/fas/agent.js` — bounded research loop, review/refine pass, injection-fenced untrusted content, scoped evidence, KB + coverage, structured decision `{decision,confidence,reason,actions,reply,followUp}`. |
| Unified runner + mode gating (#5,#12,#17,#20,#24,#25) | `src/orcha/fas/runner.js` — `handleInbound` with `disabled`/`shadow`/`approval`/`autonomous`; `letLegacyReply` arbitration; verify-before-send transactions; immutable requester permission snapshot; manual-review on AI failure; case memory with promises/follow-ups; atomic claim against double-approval. |
| Identity + 3-state permissions (#8–#16) | `src/orcha/fas/sender-profiles.js` + `src/services/contact-book.js` — identity types (internal/carrier/vendor/unknown), `lifecyclePermission`/`createWrPermission` ∈ {not_allowed, may_request, trusted_autonomous}, vendor hard-locks, scope, Contact Book migration. |
| Verified action execution (#19,#20) | `src/orcha/fas/executor.js`, `action-registry.js`, `tool-registry.js` — API-first mutations with source read-back verification; `executeVerified`; low/approval action levels; `approvedAutomaticActions` sanitized so a mutating action can never be auto. |
| Attachments / images / PDFs / URLs (#29–#57, functional) | `src/orcha/fas/attachment-research.js` (text/CSV/JSON/HTML direct decode; PNG/JPG/PDF/DOCX/XLSX via `bedrock.readFileWithVision`; injection-guarded; unit-id extraction → per-unit research) and `src/orcha/fas/link-research.js` (URL resolution incl. AAP deep-links). |
| Injection defense (#39,#44) | `src/orcha/fas/injection-guard.js` — `wrapUntrusted`, `neutralize`, `detectInjection`, applied to message/evidence/attachment/link content. |
| Exactly-once inbound (#2 infra) | `src/orcha/fas/inbound-claim.js` + legacy watermarks/dedupe in the two engines. |
| Slack transport/reliability (#2 infra) | `src/scrapers/slack_send.js`, `slack_inbound_support.js`, `slack_decision_trace.js`, polling/dedupe/batching/backoff/manual-reply/own-message/AITeammate-loop in `slack_dm_autoreply.js` + `slack_channel_watch.js`. |
| Tracing/observability (#66) | `src/ai/trace.js`, `fasAuditLog`, `case-store.js`, `slack_decision_trace.js`. |
| Tests | ~55 FAS/Slack/contact test files already cover identity, authz, modes, shadow, idempotency, inbound claim, polling, group DM, thread continuation, attachments-in-evidence, injection. |

### Current control flow (verified in code)

Both legacy engines already route inbound **through** the FAS layer first:

```
slack_dm_autoreply.js / slack_channel_watch.js
  → _runFas(input)  →  aiCore.handleInbound(input, deps)
                          → orcha/fas/runner.handleInbound
                              → mode gate
                                 • disabled/shadow → { letLegacyReply:true }  → legacy composes the reply
                                 • approval        → queue; legacy silent
                                 • autonomous      → auto-send confident/verified; else queue; legacy silent
```

So today: **FAS is primary when enabled (`approval`/`autonomous`); legacy is the
shadow/fallback brain AND still owns transport.** Default config is
`enabled:false` → `disabled` → legacy brain still answers on a fresh install.

### Not built yet (the real work)

| Spec area | Gap |
|---|---|
| Single Slack Gateway (#3) | No `src/slack/gateway.js`. Normalization is duplicated inside the two legacy engines. |
| Human-like relevance + reply-placement (#4,#5,#6) | The agent decides `answer/clarify/escalate` but has **no** explicit `shouldReply`, `replyPlacement` (dm/thread/top_level/none), `audienceSensitivity`, or machine reason-codes (#67). Channel/group "should I even speak?" judgment is thin. |
| Audience resolver (#7) | No `src/slack/audience-resolver.js`. Permission is checked for the **sender** only, not the **visible audience** of a group DM / Slack Connect channel. |
| Profile enrichment / identity resolver (#8,#9) | No `users.info` enrichment pipeline, no TTL-based refresh, no `src/slack/profile-enrichment.js` / `identity-resolver.js` / `contact-sync.js`. Classification is manual/heuristic in `sender-profiles`. |
| Deterministic permission policy module (#10–#16) | Policy logic is embedded in `sender-profiles.js`; no standalone `src/orcha/fas/permission-policy.js` with confidence tiers (≥0.95 / 0.75–0.949 / <0.75). |
| Channel registry / information-feed (#45–#50,#60,#61) | No channel-role classification, no silent-ingest path, no `channelRegistry` store. |
| Structured multimodal intelligence (#32–#36,#56,#62) | Attachment reading exists but there is no typed invoice/estimate extraction, damage-photo classification (side/area/severity+confidence), per-fact confidence, or evidence cache. Target modules `document-intelligence`/`image-intelligence`/`url-intelligence`/`evidence-normalizer`/`attachment-resolver` don't exist. |
| Retire legacy reasoning (#2, Phase 10) | Legacy persona brains (`slack-dm-persona.js`, `slack-partner-persona.js`, and the AI reasoning inside the two engines) are still live as the fallback. Cannot be removed until FAS proves parity at the default mode. |

## 2. Target end state (unchanged from your spec)

```
Slack Web API
  → src/slack/gateway.js            (ONE normalized inbound entry)
  → audience + contact resolution   (audience-resolver + contact-book)
  → identity enrichment when needed (profile-enrichment / identity-resolver, TTL-gated)
  → deterministic permission policy (permission-policy, confidence-tiered)
  → ai/core.handleInbound → orcha/fas/agent  (the ONE brain)
  → multi-step evidence/tool research (evidence + *-intelligence)
  → structured communication/action decision (shouldReply, replyPlacement, audienceSensitivity, reasonCode)
  → orcha/fas/executor  (API-first mutation + verification)
  → Slack response via slack_send  (exactly one send path) — or silence
```

Legacy files become **transport/reliability infrastructure only**; their
independent AI reasoning is deleted after parity is proven.

## 3. Implementation sequence (incremental, reliability-preserving)

Each phase ships behind the existing mode gate, keeps the full test suite green,
and is committed separately. No reliability infra is deleted until its
replacement has equivalent tests (spec Phase 10 / invariants).

- **P1 — Decision contract upgrade (highest value, lowest risk). ✅ DONE.**
  Extended the FAS decision contract + agent prompt with `shouldReply`,
  `replyPlacement` (`dm|thread|top_level|none`), `audienceSensitivity`
  (`internal|internal_external_mixed|external_partner|unknown`), and a machine
  `reasonCode` (spec #67 set). Added `_normalizeCommunication` (surface-aware
  defaults + consistency: silent reason codes / `shouldReply:false` /
  `placement:none` all collapse to silence; DM→dm, group→thread by default).
  Schema validator treats the fields as OPTIONAL + enum-checked when present
  (backward compatible). Runner now has a SILENCE GATE: when FAS is primary
  (approval/autonomous) and chooses silence, it sends nothing AND suppresses the
  legacy reply (`outcome:'no-reply'`, `letLegacyReply:false`); shadow still lets
  legacy own the cycle (field recorded for eval). Reply placement maps to the
  effective `threadTs` (thread continues/starts a thread; top_level forces no
  thread; dm keeps DM thread), applied on autonomous auto-send and on the queued
  approval item. Both legacy engines got an explicit `no-reply` branch
  (claim marked delivered-as-silence; watermark advances; no retry).
  Files: `orcha/fas/agent.js`, `ai/schemas.js`, `ai/core.js`,
  `orcha/fas/runner.js`, `scrapers/slack_dm_autoreply.js`,
  `scrapers/slack_channel_watch.js`, `tests/fas-communication-decision.test.js`
  (18 golden tests). Full suite: 1105 passing (the one failure is the
  pre-existing flaky `laneScore` full-load test; passes in isolation).

- **P2 — Audience resolver (#7). ✅ DONE.** `src/slack/audience-resolver.js`
  (pure, deterministic, no Slack calls / no mutation): resolves the VISIBLE
  audience for a conversation and the most-conservative effective scope.
  `resolveAudience({surface, sender, participants, isSlackConnect})` →
  `{audienceSensitivity (internal|internal_external_mixed|external_partner|unknown),
  effectiveOperators/Domiciles (intersection; '*' is identity), effectiveDataCategories,
  withholdInternalOnly, externalPresent, conservative, ...}`. 1:1 DM / self-DM →
  audience is the sender. Multi-party without a known participant list, or any
  Slack Connect channel → CONSERVATIVE (assume a hidden external viewer; withhold
  internal-only). Scope is the INTERSECTION across known participants (most
  restrictive wins). `applyAudienceCeiling` strips internal-only facts
  (operator/site summaries, Uptake) from sender-scoped evidence; it can only
  remove. Wired into `agent.runAgent`: resolves audience, applies the ceiling to
  evidence after `buildEvidence`, adds a VISIBLE AUDIENCE prompt block (defense
  in depth), and sets `decision.audienceSensitivity` AUTHORITATIVELY from code so
  the model can never under-report it (verified: model says "internal" + carrier
  present → code forces "internal_external_mixed"). AiCore result surfaces it.
  Files: `src/slack/audience-resolver.js` (new), `orcha/fas/agent.js`,
  `tests/fas-audience-resolver.test.js` (13 tests). Full suite: 1119 passing.

- **P3 — Channel registry + information-feed ingest (#45–#50,#60,#61,#64). ✅ DONE.**
  `src/slack/channel-registry.js` (new) + `slackChannelRegistry` store. Modes:
  CONVERSATIONAL / OPERATIONAL / INFORMATION_FEED / ALERT_FEED / VENDOR_FEED /
  SYSTEM_FEED / MIXED, each with a reply policy + source-authority tier
  (UNVERIFIED → SYSTEM_GENERATED). Name classifier SUGGESTS a mode (marked
  `source:'inferred'`); only an operator confirmation sets a trusted level, and
  an AI/auto upsert can never raise trust above the classifier (spec #14/#60/#65).
  Slack Connect downgrades source authority to PARTNER_CHANNEL. Wired into the
  agent: for a feed channel the message did NOT directly mention FAS, the
  decision is forced to silence (`reasonCode:INFORMATION_FEED_INGEST_ONLY`) AFTER
  research, and `_ingestFeedObservations` persists a CONCISE claim into
  `ai/memory` (ai_inferred, weighted by the channel's trust level, TTL-capable)
  + a compact `state:'CLAIM'` note on the unit case — NEVER flipping canonical
  state (spec #47/#50). A direct mention bypasses ingest-only and gets a normal
  reply. The channel surface now also passes `isGroup`+`mentioned` to the runner
  (also completing the Phase 2 group-audience wiring for channels). CHANNEL ROLE
  prompt block added (defense in depth). Files: `src/slack/channel-registry.js`
  (new), `orcha/fas/agent.js`, `orcha/fas/runner.js`,
  `scrapers/slack_channel_watch.js`, `store/index.js`,
  `tests/fas-channel-registry.test.js` (14 tests). Full suite: 1133 passing.

- **P4 — Deterministic permission policy module (#10–#16). ✅ DONE.**
  `src/orcha/fas/permission-policy.js` (new, pure + deterministic). Separates
  the three concerns: Slack enrichment ("who they appear to be") → AI
  classification ("what the evidence suggests") → THIS engine ("what a VERIFIED
  category is ALLOWED to do"). `evaluate(classification, {trustedActors})` maps a
  classification `{identityType, confidence, evidence, scope}` to a SAFE profile +
  a confidence-tier disposition: ≥0.95 AUTO_APPLY, 0.75–0.949 SUGGEST (effective
  stays conservative/unknown, proposal saved for review), <0.75 DEFAULT (unknown,
  never widened). HARD INVARIANTS enforced in code: classification NEVER produces
  `trusted_autonomous` (tops out at may_request); trusted autonomy only via an
  explicit operator `trustedActors` map (`canGrantTrusted` = operator /
  operator_trusted_map only); vendor is hard-locked not_allowed. Defense in
  depth: `sanitizeContactPermissionWrite` wired into `services/contact-book.js`
  `sanitize()` — any NON-operator write (`opts.operator===false`: discovery /
  Phase-5 contact-sync / automation) that tries to set trusted_autonomous is
  downgraded to may_request before it can persist; operator UI edits are
  unaffected (default operator=true). Files: `src/orcha/fas/permission-policy.js`
  (new), `services/contact-book.js`, `tests/fas-permission-policy.test.js`
  (15 tests). Full suite: 1147 passing (lone failure = pre-existing flaky
  laneScore; passes in isolation).

- **P5 — Profile enrichment + identity resolver + contact-sync (#8,#9,#11,#15,#16). ✅ DONE.**
  `slack_send.fetchUserProfile` (new) — full `users.info` profile (email, domain,
  title, tz, admin/owner/bot/guest flags, deactivated, custom fields), provenance
  stamped, invents nothing. `src/slack/profile-enrichment.js`: separates identity
  enrichment from authorization (authz stays every-message + local; enrichment is
  TTL-gated ~24h) — `shouldEnrich` fires on first-contact / stale / missing-
  critical-field / force / high-risk; otherwise skips (no Slack call).
  `src/slack/identity-resolver.js`: classifies an enriched profile into
  `{identityType, confidence, evidence}` from verified email domain / known
  SCAC-vendor domain maps / org / title — a prior operator-confirmed identity
  outranks inference (conf 1.0); bot/deactivated/guest downgrade confidence;
  assigns NO permissions. `src/slack/contact-sync.js`: orchestrates enrich →
  classify → policy.evaluate → Contact Book `upsert({operator:false})`. SAFE
  metadata always applied; identity+permissions applied only at AUTO_APPLY
  (≥0.95); SUGGEST stores a proposal and keeps effective conservative; DEFAULT
  changes nothing but metadata. trusted_autonomous is NEVER written (Phase 4 gate
  on the automated path downgrades it — verified). Every identity change logged
  with provenance (`slackIdentityChangeLog`). Wired into discovery
  (`slack_inbound_support.discoverOneSender`) as a fire-and-forget, TTL-gated
  enrichment that never blocks discovery or the reply path. New stores:
  `slackIdentityMappings`, `slackIdentityChangeLog`. Files: `slack_send.js`,
  `src/slack/profile-enrichment.js` (new), `src/slack/identity-resolver.js` (new),
  `src/slack/contact-sync.js` (new), `scrapers/slack_inbound_support.js`,
  `store/index.js`, `tests/fas-contact-sync.test.js` (16 tests). Full suite:
  1164 passing.

- **P6 — Structured multimodal intelligence (#32–#37,#51–#57,#62). ✅ DONE.**
  Layered a STRUCTURED extraction step on top of the existing vision reader
  (`bedrock.readFileWithVision`, which accepts `opts.prompt`) and the existing
  attachment download — no duplicate fetch/model call. New modules in `src/ai/`:
  - `document-intelligence.js`: typed doc extraction — classifies documentType
    (repair_estimate / invoice / dot_inspection / pm_inspection / work_order /
    vendor_report / recall / quote / towing_invoice / accident / policy_sop /
    other) and extracts fields (unit, VIN, vendor, dates, invoice/WO #, mileage,
    amount, repair items, inspection result/defects, pass/fail) each with its own
    confidence; harvests unit/VIN identifiers for per-unit research (#51/#52).
  - `image-intelligence.js`: classifies image type (vehicle_damage /
    dashboard_warning / component / tire / inspection_form / app_screenshot /
    text_screenshot / document_photo / unrelated / uncertain); for damage photos
    extracts side/area/observations/severity + confidence (#34); reads visible
    text from screenshots (#36/#37); `consolidateDamage` merges multiple photos
    (#35). CRITICAL: never a safety certification — safety-claim language is
    stripped defensively (#34).
  - `evidence-cache.js`: dedup cache keyed by fileId+size / content-hash / URL,
    stores only the compact extraction (never raw bytes), TTL-gated (files long,
    URLs short) (#56/#62).
  Wired into `orcha/fas/attachment-research.js`: `readAttachment` now returns the
  already-downloaded buffer + precise kind, and `researchAttachments` routes
  binary files to image/document intelligence, adding a structured
  `imageAnalysis`/`documentAnalysis` evidence fact alongside the base
  transcription and merging extracted unit ids. (URL intelligence #38–#44 was
  already covered by `link-research.js`: extractUrls/classify/fetchApproved +
  AAP deep-link API resolution.) Files: `src/ai/document-intelligence.js` (new),
  `src/ai/image-intelligence.js` (new), `src/ai/evidence-cache.js` (new),
  `orcha/fas/attachment-research.js`, `store/index.js`,
  `tests/fas-multimodal-intel.test.js` (12 tests). Full suite: 1176 passing.

- **P7 — Single Slack Gateway (#3). ✅ DONE.** `src/slack/gateway.js` (new, pure,
  deterministic, never throws): ONE normalizer for every inbound surface.
  `normalizeInbound(raw)` → canonical `{source, surface (dm/self_dm/dm_thread/
  group_dm/channel/slack_connect), channelId, channelName, messageTs, threadTs,
  senderSlackId, senderName, text, files, mentions, isMentioned, isThreadReply,
  isSelf, isGroup, isSlackConnect, participants}`; `toRunnerInput` maps it to the
  FAS runner's native shape; `buildRunnerInput` is the one-shot both engines use.
  Both `slack_dm_autoreply.js` (4 call sites) and `slack_channel_watch.js` (2
  call sites) now build the runner input THROUGH the gateway, with the prior
  inline object kept as a fallback if the gateway fails to load — so the change
  is non-breaking (a golden parity test asserts the gateway output matches the
  legacy inline shape field-for-field). SCOPE kept narrow on purpose: the
  gateway owns NORMALIZATION only; polling/dedupe/watermark/claim/rate-limit/
  batch/send stay in the engines (untouched). Files: `src/slack/gateway.js`
  (new), `scrapers/slack_dm_autoreply.js`, `scrapers/slack_channel_watch.js`,
  `tests/fas-gateway.test.js` (11 tests). Full suite: 1186 passing (lone failure
  = pre-existing flaky laneScore; passes in isolation).

- **P8 — Retire legacy reasoning (#2, Phase 10).** Once FAS is the default and
  parity is proven in shadow audit, delete the persona brains and the in-engine
  AI reply generation; keep polling/dedupe/batching/backoff/send. Flip default
  config to FAS-primary.

## 4. Non-negotiable invariants carried through every phase

Digital FAS is the ONE brain · AI Core is the entry point · Contact Book +
deterministic policy are the only authorization source · AI never self-grants
or auto-expands high-risk trust · audience checked before exposure · silence is
a valid decision · placement is semantic · API-first + verified mutations ·
"no verified readback = no done" · preserve exactly-once, manual-reply
detection, rate-limit/backoff, cluster leader/fencing · files/URLs are evidence
not authorization · info feeds consumed silently · Slack never overrides
authoritative APIs · visual damage analysis is never a safety certification.

## 5. Open questions for the operator (need answers before P1 commit)

1. **Target default mode.** The end state flips default to FAS-primary. Do you
   want the default to be `approval` (FAS drafts, you approve) or `autonomous`
   (FAS auto-sends confident, verified, low-risk answers)? This governs when
   legacy can be retired.
2. **Enablement scope.** Enable FAS everywhere at once, or DM/self-DM first,
   then partner channels, then watched channels?
3. **Reply-placement defaults** when the model is uncertain: prefer thread
   (quieter) or top-level (visible)? I propose thread-by-default for channels.
4. **Information-feed channels.** Can you name the known data-feed channels
   (e.g. vendor-updates, repair-feed) so P3 seeds the registry instead of
   relying on inference?

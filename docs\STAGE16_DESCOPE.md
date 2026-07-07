# Fleet Ops V-C — Stage 16 Descope Record

**Date:** 2026-06-29
**Status:** DESCOPED — feature never built
**Original plan:** Document vault view (per `STAGE9_PLAN.md` line 260)

---

## 1. Why It Was Descoped

Stage 16 ("Document vault view") was defined in `STAGE9_PLAN.md` at the time of
Stage 9 planning. By the time Stages 13–15 were being developed, the feature had
no active design, no mockup, no referenced IPC surface, and no field in `state.js`
to back it.

The stages that followed 12 were renumbered organically during development:

| Original plan | Actual stage built | Actual number |
|---|---|---|
| Stage 13 | Analytics / KPI dashboard | Stage 13 ✅ |
| Stage 14 | Vendor management | Stage 14 ✅ |
| Stage 15 | Partner portal | (never built — also descoped) |
| Stage 16 | **Document vault** | **Stage 16 — DESCOPED** |
| Stage 17 | Schedulers | Built as **Stage 15** ✅ |
| Stage 18 | (wiring) | S16–S19 checks cover app.js/toolbar wiring |
| Stage 20 | Daily Notes | Built, wired, active |

The existing `S16-*` checks in `sanity_check.py` do **not** cover a document vault —
they cover app.js wiring for analytics (a retroactive labeling from commit `6c78da4`
"Stages 16–18 — wire analytics, vendors, email-composer into app.js").

---

## 2. What a Document Vault Would Have Been

Per context from `STAGE9_PLAN.md` and related planning notes:

> A read-only view of documents associated with fleet units — WR attachments,
> Salesforce case PDFs, AAP screenshots, and operator-submitted files. Browsable
> by unit ID, filterable by type and date.

**Why it stalled:**
- AAP and Salesforce don't expose a clean attachments API at the scraper layer
- Screenshots are saved locally (`files.getLatestScreenshot`) but not indexed
- No `state.js` slice was ever defined for document metadata
- The WR Modal already handles screenshot attachment at submission time

---

## 3. Is It Needed?

**No — at current scope.** The use cases it would serve are covered:

| Doc vault use case | Current coverage |
|---|---|
| Screenshot attach to WR | WR Modal (`wr-modal.js`) handles at submission |
| SF case link access | Unit detail drawer + vendors drill table have `salesforceCaseUrl` links |
| ASIST shop event links | Vendors drill table `offsiteShopEventUrl` + ASIST enrichment (S25-10) |
| WR history | Unit detail drawer shows timeline + open WRs |

---

## 4. Decision

**Descoped.** Not deferred — there is no planned implementation date.
If document storage becomes a requirement (e.g., persistent attachment vault,
offline PDF archive), it should be scoped as a new stage with:
- A `state.js` `documents` slice
- A `files.listDocuments()` IPC handler
- An indexer that runs post-sync

---

## 5. Stage Numbering Going Forward

| Stage | Feature | Status |
|---|---|---|
| 13 | Analytics | ✅ Closed |
| 14 | Vendor management | ✅ Closed |
| 15 | Schedulers | ✅ Closed |
| 16 | Document vault | ✅ Descoped (this doc) |
| 17–19 | App wiring + toolbar (S16–S19 checks) | ✅ All pass |
| 20 | Daily Notes | Active — closing next |

---

*Descope record written 2026-06-29.*
*Next: Stage 20 — Daily Notes view.*

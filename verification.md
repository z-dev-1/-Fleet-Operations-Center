# Verification: condensed TIMELINE digest in the SOS/EOS email

Branch `feat/email-timeline-digest`, base `feature/zoom-meetings` (`12a01de`). Run date 2026-11-19.

Changed files: `src/scrapers/emailBuilder.js`, `tests/fixtures/eos-report-fixtures.js` (additive `u322283` fixture), `tests/email-timeline-digest.test.js` (new), `scripts/build-eos-samples.js` (4th sample), `docs/_built_eos_{auvte,mixed,fld260703}.html` (regenerated), `docs/_built_eos_322283.html` (new), this file.

Not changed: `src/scrapers/owa-mailer.js`, `src/scheduler/*`, `src/scrapers/email_template.html`, `src/orcha/*` (engine and redaction), `renderer/**` (in-app unit-detail drawer timeline), `src/scrapers/relay.js`.

## Engine reuse

- `buildEmail` stays synchronous. It never calls `buildDigest` / `refreshTimelineDigests`, so the send path does not wait on AI and never writes `notesStore`. Digest regeneration still happens on sync, deep-scan and timeline rebuild, as before.
- The email reuses these sync helpers from `src/orcha/timeline-digest.js`:
  - `splitLatest` handles parsing, drops gap lines and the hidden "requested … update … vendor" fillers, strips `[em:]` markers, sorts chronologically and picks the latest entry.
  - `IMPORTANT_CLASSES` and `vendorClassRe` rank sentences when an entry is condensed.
  - `DIGEST_VERSION` is used in the freshness check.
- From `src/orcha/timeline-text.js` it reuses `LINE_RE` and `cleanTimelineMeta`. The latter drops `Next:` tails and CONFLICT / PM-overdue / status-field clauses.
- The cached grounded AI lines in `unit.timelineDigest` (or `notesStore[id].timelineDigest` / `fleetData` row) are read-only. A digest line dated exactly D replaces the deterministic one-liner for trail date D. That only happens when the digest is fresh for the timeline being rendered: `v === DIGEST_VERSION`, `method` is `ai` or `ai+backfill`, and `splitLatest(rawTimeline).latest === latestEntry` with the same `historyCount`. AI lines still go through the strip pipeline and the one-line cap.
  - Tested: a fresh digest is used with its ids stripped; a stale digest (`latestEntry:'x'`) or a `fallback` digest is ignored; the digest object is not mutated.
- Redaction reuses `redactForEmail` from `src/orcha/redact_sharing.js` for `$` amounts, personal names, `per <Name> email` attributions, phones and emails. No new summarizer or redaction module was written.

## Strip rules (render time, local copy only)

The email-only rules below are private helpers in emailBuilder.js. They run after `redactForEmail`.

- `_stripHedges` removes these:
  - `(…)` asides containing "sources disagree/differ/conflict", "disputed", "dealer name" or "unclear"
  - `[F8]`-style citation tags
  - `(per … email/call/text …)` attributions
  - "dealer name disputed" text
  - a leading `Vendor:` / `Dealer:` / `Internal:` / `Note:` label
- `_stripEmailIds` removes these:
  - labelled ids such as `ASIST|SF|Salesforce|DTNA|Decisiv|RO|WO|WR|SR` plus `case/service request/ticket/ref/work order/order` plus 5 or more digits, with an optional `(MM/DD)` tail
  - `ref <alnum>` and tow refs
  - `amz-…` refs
  - bare runs of 5 or more digits

  A parenthetical that is left with only dates or filler words after stripping is dropped. Label words on their own are kept, for example "ASIST case created."
- Sentence-level noise is dropped:
  - return-tow restriction sentences (the user said this is not needed in the email)
  - lowercase AI fragments shorter than 4 words, such as "up set for 11/18." and "final estimate."
  - sentences left with only filler words after ids are removed, such as "Additional created." and "created."
- `_tidy` removes empty `()` and `(tow ref )`, a dangling preposition or `and` before punctuation, `: and .`, and doubled punctuation.
- What is kept: vendor/dealer names, dates, status, parts, estimate version + scope, and root cause.
- Fixed abbreviations apply to trail lines only: `Estimate Vn` becomes `Est Vn`, `approved. Scope:` becomes `approved:`, `approved. Added scope:` becomes `approved; added:`, and `quality control` becomes `QC`.

## Same-day merge

History entries are grouped by date key in first-seen order. A range such as `11/07 - 11/09` is its own key, rendered `11/07–11/09`. Each entry is cleaned and split into sentences. A sentence is dropped as a duplicate when at least 60% of its content tokens (lowercase words of 3+ characters, minus a short stopword list) already appear in a kept sentence for that date. Distinct sentences are kept. Each date then gets one line (`_oneLine`):

1. The highest-signal sentence comes first. The score is the number of engine `IMPORTANT_CLASSES` hits (excluding caseRef), +1 for a vendor/dealer hit, and +2 for an estimate version or root cause.
2. More sentences are added in score order while the line stays within 160 characters. They are rendered in source order.
3. A top sentence over the cap first loses its non-vendor, non-version asides. If it is still too long, it is clipped at a word boundary with `…`.

For example, the three 11/16 entries become one line and keep the PM-B / driver alert speaker fact.

The cap is 160 rather than the plan's 150. At 150, the 11/04 line drops the root-cause sentence, which (f) requires.

## Latest on top

The newest entry, `splitLatest().latest`, renders in full above the trail in a highlighted `LATEST <M/D>` block (`#fff4d9` fill, `#eccd86` border, bold text). It is cleaned and stripped but not condensed. Other entries on the same date remain a trail row for that date.

## Dealer resolution

- The canonical dealer is the first non-empty of `dealerName`, `subVendor` (only when it is not the geofence), and `vendor`. These are the same record fields the RELAY GARAGE uses.
- Label variants share the canonical name's first word of 4+ letters (for example `Bergey`, matching `Bergeys` and `Bergey's`) plus up to 4 capitalized words. They are replaced with the canonical name: "Bergeys Truck Centers Pennsauken" becomes "Bergey's Truck Centers - Pennsauken".
- The "(sources disagree … MV Contract Maintenance …)" hedge is removed without replacement wording.
- Generic OEM/vendor leads (Volvo, Kenworth, Freightliner, …) are not collapsed, because two Kenworth shops can be really different vendors.
- A different vendor named in prose, such as "transmission specialist", is left as written.

## Every date vs. "~16 one-liners"

The approved example says "~16 one-liners". The rule "every date is kept" wins, so the fixture gives one row per distinct source date: 21 trail rows (11/18 included, for the ETR line) plus LATEST 11/18. A date whose entries are entirely noise after stripping (only an id plus "created", or only the return-tow restriction) would have no row. In the fixture, every date has content.

## OWA-safe markup

- The markup uses only nested `role="presentation"` tables, `<font>`, `bgcolor` plus inline solid 6-hex `background-color`, and inline styles.
- There are no `<div>`, `<style>`, flex, gradients or rgba.
- The only class attributes are the test hooks `eos-tl-latest` and `eos-tl-date`, following the existing `eos-meta` precedent.
- The outer TIMELINE `<td>` and its `TIMELINE` label are unchanged.
- An undated timeline renders as before (redacted lines joined with `<br>`, now with ids stripped). An empty timeline renders `—`.
- RELAY GARAGE "Last update" still uses the old per-line redaction, unchanged.

## Assertions (tests/email-timeline-digest.test.js)

| Brief | Test |
|---|---|
| (a) every date in the trail, chronological | `(a) every source date is in the trail, chronological, once` gives 21 dates in order, plus `LATEST 11/18` |
| (b) single short line each | `(b) each trail entry is a single short line`: no `<br>`, at most 160 characters |
| (c) same-day merge | `(c) same-day duplicates merge to one line and keep distinct facts` checks 10/14, 10/15, 10/20 and 11/16 |
| (d) LATEST block above the trail, in full | `(d) LATEST block sits above the trail and shows the newest entry in full` |
| (e) no $ / name / case / ASIST / SF / WR id / amz ref | `(e) …` checks for no `$`, no run of 5+ digits, no `amz-`, no label+digit, no "return tow", and none of the fixture names. The meta line still shows `00034097` and `amz-kzcqubb6kx3dcf` |
| (f) vendor, dates, estimate + scope, root cause kept | `(f) …`: Volvo, Bergey's Truck Centers - Pennsauken, Est V2/V3/V4 approved, batteries, hood, root cause, transmission specialist, Tow arranged |
| (g) one canonical dealer, no hedge | `(g) …`: no disput/disagree/MV Contract Maintenance/Pennsauk(?!en)/Bergeys. 11/10 starts with the canonical name |
| (h) in-app drawer timeline unchanged | `(h) …`: `git diff --name-only 12a01de -- renderer src/orcha src/scheduler src/scrapers/owa-mailer.js src/scrapers/relay.js` is empty (committed and working tree). `redactForSharing` gives the same output before and after a render |
| (i) stored data not mutated | `(i) …`: units and notesStore are JSON-identical after the build. The stored timeline still has `$4,210.30`, `Christy Adriaansen` and `21268757`. The store's `notesStore` stays `{}` |
| engine reuse | `cached grounded digest reuse` (3 tests) |

## Commands and results

| Command | Result |
|---|---|
| `node --check src/scrapers/emailBuilder.js` | exit 0 |
| `node --check tests/fixtures/eos-report-fixtures.js` | exit 0 |
| `node --check scripts/build-eos-samples.js` | exit 0 |
| `npx vitest run tests/email-timeline-digest.test.js tests/email-eos-fixes.test.js tests/email-builder-redesign.test.js tests/email-api-sos-eos-untouched.test.js tests/scheduler-no-duplicate-send.test.js tests/owa-mailer.test.js tests/redact-sharing.test.js tests/timeline-digest.test.js tests/timeline-content-fixes.test.js` | All pass except FR-7.1, which is a pre-existing base failure: `src/dev/dev-zoom-probe.js` differs from `4c0e1f4`. The AC-18 SOS/EOS guard (scheduler + owa-mailer untouched) passes. The scheduler-no-duplicate-send tests hit 5s timeouts once under the parallel load; rerun alone, they pass 16/16 together with email-timeline-digest |
| `npx vitest run tests/email-timeline-digest.test.js tests/scheduler-no-duplicate-send.test.js` | 2 files, 16 tests passed |
| `npm run build:renderer` | exit 0 (vite built in 11.4s) |
| `node scripts/build-eos-samples.js` | 4 lines written: `_built_eos_auvte.html 42916`, `_built_eos_mixed.html 50562`, `_built_eos_fld260703.html 26312`, `_built_eos_322283.html 25610` |
| `git diff docs/_built_eos_mixed.html docs/_built_eos_auvte.html` | Only the TIMELINE cell changed, plus the clock-driven datetime, greeting and since-last lines. Hero, KPIs, body-type, RELAY GARAGE, PM/DOT, Uptake and New Delivery are byte-identical |
| `git diff feature/zoom-meetings -- src/scrapers/owa-mailer.js` | empty |
| `git diff feature/zoom-meetings -- src/scheduler` | empty |
| `git diff --stat feature/zoom-meetings -- renderer src/orcha src/scrapers/email_template.html src/scrapers/relay.js` | empty (in-app drawer timeline renderer, engine, redaction and template unchanged) |
| `npx vitest run` (full, output in `$env:TEMP\etl_vitest.txt`) | 575 files: 564 passed, 7 failed, 4 skipped. 7568 tests passed, 7 failed |
| `npx vitest run tests/email-api-ipc.test.js tests/email-intel-lock.test.js tests/fas-stage-9.test.js tests/telemetry-sampler.test.js` | 4 files, 33 tests passed |

The 7 full-suite failures fall into two groups:

- Pre-existing base failures, not fixed: FR-7.1 (email-api-sos-eos-untouched, src/dev), R8.3 (email-intel-restart) and AC25 (wo-extract-perf timing).
- Load flakes: email-api-ipc R4-M1, email-intel-lock R8.2, fas-stage-9 and telemetry-sampler. None of them touch emailBuilder, and they pass when rerun alone (row above).

## 322283 timeline cell: before / after

Before (current build): each stored line is redacted and joined with `<br>`. Ids, the hedge, return-tow text and duplicates are all still present:

```
09/16 - Work order created with Volvo (ASIST) for Uptake-flagged exhaust catalyst efficiency concern and elevated fault code activity. Tow coordination initiated with FAS.
09/18 - Tow arranged (amz-kzcqubb6kx3dcf). Unit transported to initial dealer location; initial dealer confirmed not certified for CNG work. Unit subsequently rerouted.
...
10/14 - Additional ASIST service request 1000784 created. Salesforce case 00034097 created. Return tow restriction active: DO NOT set up FLEETNET return tow without FAS/AFP confirmation.
10/14 - Unit at CNG-capable shop (new location). Two ASIST cases opened: 1000278 (10/12) and 1000784 (10/14). B added to repair order. Pending shop acceptance of new cases and diagnostic start. 27+ days down with no diagnostic start to date. Next: Chase new CNG-capable shop via ASIST cases 1000278 and 1000784 to confirm case acceptance, technician assignment, and diagnostic scheduling for exhaust catalyst/O2 sensor fault and PM-B service.
10/15 - Unit checked in at dealer (ASIST case 21365790) for CEL with catalyst faults. Diagnostics initiated.
10/15 - Unit 322283 is at a CNG-capable Bergey's location with two new ASIST cases open (1000278 created 10/12, 1000784 created 10/14) and PM-B added to the repair order. ...
10/20 - Dealer submitted estimate V1  for internal review. Pending approval.
10/20 - Estimate V1 rejected. Core charge present (Rule 68 conflict); body damage scope requires photo review ...
10/21 - Estimate V2 approved. Scope: four batteries replaced (all failed load test), B service and spark plugs (ISX12N CNG), accelerator pedal replacement (dead spot on PTT), hood replacement and paint (prior body damage repair failing). ARC confirmed. ISX12N CNG task force tag applied.
...
11/10 - Christy Adriaansen - Bergeys Truck Centers Pennsauken (Service Advisor) confirmed transmission repairs and other approved mechanical repairs still in progress; follow-up scheduled.
...
11/16 - Dealer (sources disagree on dealer name: Pennsauken per ASIST 10/15 entry vs. MV Contract Maintenance per Decisiv 11/6 entry [F8]) confirmed transmission repairs complete. B service and new driver alert speaker fault being finalized. Body repairs and final quality control inspection to follow. up set for 11/18.
11/16 - Phone contact with service department confirmed technician completing repairs and uploading signed PM-B form.
11/16 Vendor: Vendor finishing PM-B service and new driver-side driver alert speaker fault (per Bergeys Truck Centers Pennsauk email 11/16) [em:90b10be8]
11/18 - ETR request submitted via ASIST; no ETR provided by dealer.
11/18 - Road test failed for new CEL fault. Dealer confirmed diagnosis of new fault underway. Body repairs and final QC not yet completed. No ETR provided. 64 days down.
```

Note that before this change, the `11/10` name header was not stripped. Email-strict redaction only strips a name header at the start of the text, and the old code passed the whole dated line.

After (rendered from `docs/_built_eos_322283.html`):

```
LATEST 11/18  Road test failed for new CEL fault. Dealer confirmed diagnosis of new fault underway. Body repairs and final QC not yet completed. No ETR provided. 64 days down.
09/16       Work order created with Volvo (ASIST) for Uptake-flagged exhaust catalyst efficiency concern and elevated fault code activity.
09/18       Tow arranged. Unit transported to initial dealer location; initial dealer confirmed not certified for CNG work. Unit subsequently rerouted.
09/22       Unit relocated to alternate shop. Work order not yet created at new vendor location; diagnostic start blocked.
09/30       Confirmed unit on-site at new location; however, work order had not been created, blocking diagnostic start. Internal escalation submitted to open ASIST case.
10/06       Internal escalation submitted requesting work order be opened and diagnostics scheduled. 20 days down with no diagnostic start at that point.
10/12       ASIST case created. B service added to repair order. Pending shop acceptance.
10/14       Unit at CNG-capable shop (new location). Two ASIST cases opened. B added to repair order. Pending shop acceptance of new cases and diagnostic start.
10/15       Diagnostics initiated. Unit is at a CNG-capable Bergey's Truck Centers - Pennsauken location with two new ASIST cases open and PM-B added to the repair order.
10/17       Per update 10/16, unit confirmed in shop undergoing diagnostics. Case in Triage status. No findings, estimate, or ETR provided yet.
10/20       Dealer submitted Est V1 for internal review. Pending approval. Est V1 rejected.
10/21       Est V2 approved: four batteries replaced, B service and spark plugs, accelerator pedal replacement, hood replacement and paint. ARC confirmed.
10/26       Follow-up submitted to dealer for repair status update. No new findings provided.
10/28       Est V3 approved; added: transmission diagnostics and R/I/R authorization (non-final, teardown pending). B, catalyst/O2, and hood scope carried from V2.
11/03       Dealer confirmed unit dispatched to transmission specialist for further diagnostics.
11/04       Est V4 approved; added: MTM and air dryer parts authorized (labor V5 pending). MTM water contamination via air dryer failure confirmed as root cause pattern.
11/07–11/09 Internal follow-ups submitted requesting update on water intrusion findings and transmission repair status. Pending dealer response.
11/10       Bergey's Truck Centers - Pennsauken confirmed transmission repairs and other approved mechanical repairs still in progress; follow-up scheduled.
11/11       Dealer reiterated transmission repairs in progress; committed to providing update as soon as available. No ETR provided.
11/13       ETR requested from dealer; no response received.
11/16       Dealer confirmed transmission repairs complete. B service and new driver alert speaker fault being finalized. Body repairs and final QC inspection to follow.
11/18       ETR request submitted via ASIST; no ETR provided by dealer.
```

Rendered HTML of the LATEST block and the first trail row:

```html
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:3px 0 5px 0;"><tr><td class="eos-tl-latest" bgcolor="#fff4d9" style="background-color:#fff4d9;border:1px solid #eccd86;border-radius:4px;padding:5px 7px;"><font color="#92500a" face="Arial,sans-serif" style="font-size:9px;letter-spacing:0.06em"><b>LATEST 11/18</b></font><br><font color="#1f2937" face="Arial,sans-serif" style="font-size:11px;line-height:1.45"><b>Road test failed for new CEL fault. Dealer confirmed diagnosis of new fault underway. Body repairs and final QC not yet completed. No ETR provided. 64 days down.</b></font></td></tr></table>
<tr><td class="eos-tl-date" valign="top" width="44" style="width:44px;padding:1px 6px 1px 0;white-space:nowrap;"><font color="#1a56db" face="Arial,sans-serif" style="font-size:10px"><b>09/16</b></font></td><td valign="top" style="padding:1px 0;"><font color="#374151" face="Arial,sans-serif" style="font-size:10px;line-height:1.4">Work order created with Volvo (ASIST) for Uptake-flagged exhaust catalyst efficiency concern and elevated fault code activity.</font></td></tr>
```

## Manual Test-mode email check (for the user; the agent did not restart the app)

1. In the app, use the existing Test toggle to send a Test-mode SOS or EOS email.
2. On a long-timeline down unit (for example 322283), confirm all of the following:
   - A highlighted `LATEST <M/D>` block shows the newest entry in full.
   - The dated trail below it is oldest first, with one short line per date and same-day entries merged.
   - There are no `$` amounts, personal names, case/ASIST/SF/WR ids or amz refs.
   - Vendor, dates, estimate version + scope and root cause are present.
   - No "disputed" / "sources disagree" text appears.
   - The rest of the email (hero, KPIs, RELAY GARAGE, PM/DOT, Uptake, New Delivery, since-last) looks as before.
3. Open the unit-detail drawer in the app and confirm its timeline looks exactly as it did before this change.
4. Optional: open `docs/_built_eos_322283.html` in a browser for a preview.

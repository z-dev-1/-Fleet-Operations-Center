# Fleet Ops V-C — Stage 15 Completion Record

**Date:** 2026-06-29
**Commits:** `ca379b9` (base) + `92d8a5c` (wiring) + `fix/s15-minsuntil` (this session)
**Tag:** `renderer-stage15-complete`
**Sanity suite:** 882/882 (37 S15 checks — zero regressions)

---

## 1. What Was Done

Stage 15 delivered the Schedulers view (`schedulers.js`, 426 lines).

| Commit | Description |
|---|---|
| `ca379b9` | Stage 15 — Schedulers view (SP push + auto-email status, countdown, timeline, run log) |
| `92d8a5c` | S19 — Wire schedulers view into app.js router + 8 sanity checks |
| `fix/s15-minsuntil` | Bug fix — `_minsUntil()` line 78: `now.getH/urs()` → `now.getHours()` |

---

## 2. schedulers.js — Feature Detail

### Architecture
Self-contained view with **inline CSS injection** (`_injectCss()` + `_CSS` constant).
No external CSS file entries needed — all `sched-*` rules live in the JS module.
Uses a 1-second `setInterval` tick (`_startTick` / `_stopTick`) that runs only while
the view is visible. No new IPC — reuses `window.sp.push()` and `window.fleet.requestSync()`.

### Slot schedule constants
```js
SP_SLOTS    = [07:30, 15:30]   // weekdays
EMAIL_SLOTS = [08:00, 15:15]   // weekdays
ALL_SLOTS   = merged + sorted by minute-of-day
```

### Sections

| Section | Key elements |
|---|---|
| **Header** | Live clock (`sched-clock`), weekday/weekend badge (`sched-weekday-badge`) |
| **Next-slot banner** | `sched-next-slot` + `sched-next-countdown` — updates every second via tick |
| **SP Push card** | Last run / Next slot / Status meta; progress bar (`sched-sp-bar`); Manual trigger |
| **Auto Email card** | Last run / Next slot / Status meta; info note (no manual trigger by design) |
| **Today's timeline** | One row per slot — `past`/`soon`/`upcoming`/`weekend` state badges |
| **Run log** | `localStorage` ring buffer, 20 entries max, `LOG_KEY = 'vc_scheduler_log'` |

### Bus event routing (`fleet:status`)
Incoming status messages are classified by regex:
- `/email|auto-email/i` → updates email card + pushes `email` log entry
- `/sp push|sp:/i` → pushes `sp` log entry
- else → pushes `sync` log entry

### SP progress tracking (`sp:progress`)
- Sets `_spRunning = true`, adds `.running` class to card (glowing border)
- Increments progress bar +8% per message, caps at 80% until done
- On `/complete|done|success|error|fail/i`: fills bar to 100%, hides after 2s, clears flag

---

## 3. Bug Fixed This Session

**`_minsUntil()` — line 78 — silent runtime NaN**

```js
// BEFORE (broken — parses cleanly, evaluates to NaN at runtime)
let diff = (h * 60 + m) - (now.getH/urs() * 60 + now.getMinutes());

// AFTER (correct)
let diff = (h * 60 + m) - (now.getHours() * 60 + now.getMinutes());
```

`now.getH` = `undefined`. `undefined / urs()` would throw `ReferenceError: urs is not defined`
at runtime, silently swallowed by the tick interval. Effect: countdown banner, next-slot
fields in both cards, and all timeline slot state badges showed `—` (no value).

`node --check` passes before and after — JS division parses as valid syntax (`getH` property
access, divided by `urs()` call). Bug was invisible to static analysis.

**S15-7** encodes this fix as a regression guard:
```python
chk('S15-7: _minsUntil uses getHours() not getH/urs()',
    'getH/urs()' not in _sc15 and 'getHours()' in _sc15)
```

---

## 4. Sanity Checks (S15) — 37 checks

| Range | Coverage |
|---|---|
| S15-1 to S15-6 | Module structure, view id/class, slot constants |
| S15-7 | Bug fix regression guard (`getH/urs` → `getHours`) |
| S15-8 to S15-19 | All 6 sections: clock, weekday badge, countdown, SP card, email card, timeline, run log |
| S15-20 to S15-24 | Actions: SP trigger, sync, clear log, back button, SP disabled-while-running |
| S15-25 to S15-28 | Bus listeners: sp:progress, fleet:status (email/sp/sync routing), fleet:data, ui:view-change + tick |
| S15-29 to S15-33 | CSS self-injection: _injectCss, sched-card, badge variants, progress-bar animation, slot variants |
| S15-34 to S15-37 | app.js import + routing; toolbar button + emit |

All 37 pass. Zero regressions against prior 845 checks (suite: 845 → 882).

---

## 5. CSS Architecture Note

Unlike Stages 13–14 which add rules to `fleet.css`, Stage 15 uses **runtime CSS injection**.
`_injectCss()` creates a `<style>` tag and appends it to `document.head` on first `init()` call.
`_cssInjected` flag prevents duplicate injection.

This means `fleet.css` has zero `sched-*` entries — all styles are bundled in the JS module.
Trade-off: styles don't benefit from browser CSS caching between page loads, but the view is
self-contained and requires no coordination with the CSS file.

---

## 6. Sanity Arc

| Stage | Scope | Checks |
|---|---|---|
| 13 | Analytics / KPI dashboard | 845 |
| 14 | Vendor management | 845 |
| **15** | **Schedulers view** ← just closed | **882** |
| 16 | Document vault | next |
| 17 | Partner portal | — |
| 18 | Full test suite | — |

---

*Completion record written 2026-06-29.*
*Next: Stage 16 — Document vault.*

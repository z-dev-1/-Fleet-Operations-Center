# Fleet Ops V-C — Stage 19 Completion Record

**Date:** 2026-06-29
**Commits:** `92d8a5c`
**Tag:** `renderer-stage19-complete`
**Sanity suite:** all S19 checks pass within 914/914

---

## 1. What This Stage Was

Stage 19 is the **app.js + toolbar wiring pass for the Schedulers view** —
connecting the already-built `schedulers.js` into the app router and toolbar,
completing the end-to-end feature delivery for Stage 15.

Wiring was committed separately from the view itself (`ca379b9`) because the
schedulers view landed before the multi-view wiring pass (`6c78da4`) had
established the wiring pattern for new views.

---

## 2. What Was Wired

### `app.js` changes (commit `92d8a5c`)

```js
import { init as initSchedulers } from './views/schedulers.js';   // added
// ...
initSchedulers(viewsMount);                                         // boot call
// ...
const schedulersView = document.getElementById('view-schedulers'); // element ref
// ...
if (schedulersView) schedulersView.style.display = to === 'schedulers' ? 'flex' : 'none';
```

### `toolbar.js` changes (commit `92d8a5c`)

```html
<button id="tb-schedulers" class="toolbar__btn" title="Schedulers">...</button>
```

```js
document.getElementById('tb-schedulers').addEventListener('click', () => {
  bus.emit('ui:view-change', { from: 'fleet', to: 'schedulers' });
});
```

---

## 3. Sanity Checks (S19) — 8 checks

| Check | Assertion |
|---|---|
| S19-1 | `app.js` imports `initSchedulers` + `schedulers.js` path |
| S19-2 | `app.js` calls `initSchedulers(viewsMount)` |
| S19-3 | `app.js` grabs `view-schedulers` element |
| S19-4 | `app.js` routes schedulers in `ui:view-change` (`schedulersView.style.display`) |
| S19-5 | `schedulers.js` exports `init()` |
| S19-6 | `schedulers.js` handles `ui:view-change` |
| S19-T1 | Toolbar has `tb-schedulers` button |
| S19-T2 | Toolbar emits `view-change` to `schedulers` |

All 8 pass. Added in commit `92d8a5c` (sanity total at that point: 739).

---

## 4. Relationship to Stage 15

Stage 15 built and fully verified `schedulers.js` as a standalone module (37 checks,
including the `_minsUntil` bug fix). Stage 19 is the integration step that makes
it reachable from the running app via the toolbar. Together they close the schedulers
feature end-to-end.

---

## 5. Wiring Pattern Summary (S16–S19)

All four wiring stages follow the same four-step pattern in `app.js`:

```
1. import { init as initXxx }  from './views/xxx.js'
2. initXxx(viewsMount)                                  ← in DOMContentLoaded
3. const xxxView = document.getElementById('view-xxx') ← element ref
4. xxxView.style.display = to === 'xxx' ? 'flex':'none' ← in ui:view-change handler
```

And one toolbar step:
```
5. <button id="tb-xxx"> + addEventListener → bus.emit('ui:view-change', { to: 'xxx' })
```

This pattern is consistent across analytics (S16), vendors (S17),
email-composer (S18), and schedulers (S19).

---

*Completion record written 2026-06-29.*

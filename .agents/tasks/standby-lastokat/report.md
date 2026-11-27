# Standby lastOkAt fix — report

Branch `fix/standby-lastokat` (worktree `.worktrees/standby-lastokat`), based on `feature/zoom-meetings` @ ad2316b. Not merged, not pushed.

## What changed
`src/cluster/standby-daemon.js`, `_tickFleet()`, right after `store.save('fleetData', out)`:

```js
// Same last-good-build record the primary loaders keep; an empty build is not a good one.
if (rows.length) { try { require('../health/fleet-freshness').recordBuildOk({ count: rows.length }); } catch (_) {} }
```

Before this change, a standby instance saved fleetData but never set `fleet-freshness.lastOkAt`. Consumers (DBR data-as-of, Autopilot) then fell back to the sync stamp, which background enrichers can re-stamp.

## How it matches the primary paths
- It uses the same call form as `src/ipc/aap-api.js:346` and `:410`: a lazy `require('../health/fleet-freshness').recordBuildOk({ count: rows.length })` wrapped in `try/catch`, placed after the save. `src/window/index.js:1244` makes the same call through its `_fleetFreshness` reference.
- The count is the merged row count that was actually saved (`rows.length`, which equals `out.count`).
- A failed build throws before the save, lands in the existing `catch`, and never reaches the call.
- An empty build (0 rows) does not record. This follows the brief. The window loader's guard also refuses to save or record an empty build over good data. `aap-api.js` has no empty guard.
- No timestamp is passed, so `recordBuildOk` stamps `lastOkAt` itself.

Not changed (pre-existing, outside scope): the standby still saves an empty build over a good saved fleet, because it has no `isEmptyBuildOverGood` guard. The fix only stops that build from counting as a good one. Adding the guard would change the build/save behavior, which the brief ruled out.

No changes to `fleet-freshness.js`, autopilot, dbr, scheduler, asana, or the fleetData shape.

## Tests
New file: `tests/standby-daemon-freshness.test.js` (4 tests). It uses the `require.cache` fake for `cluster/index` from `loader-facts.test.js`, a `vi.spyOn` stub for `aap_api.buildFleetDataset`, and `vi.spyOn(ff, 'recordBuildOk')`. It checks:
- a successful build calls `recordBuildOk({ count: 3 })` once;
- an empty build does not call it;
- a failed build does not call it;
- against the real module, `lastOkAt` is set and `lastOkCount` is 3.

Results:
- New test: 4/4. Together with `loader-facts`, `cluster-stage14`, `fleet-freshness`, and `autopilot-no-write`: 83/83.
- `tests/autopilot-no-write.test.js`: 37/37 (unchanged).
- Full suite baseline on unmodified ad2316b: 21 files / 28 tests failed.
- Full suite after the change: 26 files / 34 tests failed. The 19 files that failed only in this run were rerun together: 17 passed. The other two, `email-api-reconcile` and `email-api-scan`, are on the known-flake list and pass alone (13/13, 9/9). One of the 19 was `loader-facts`, which loads standby-daemon. It failed with a Windows `EPERM` rename in `store.save` under load, and it passes alone and in the batch.
- No new failures that can be traced to this change.

## Commit
See `git log -1 fix/standby-lastokat`.

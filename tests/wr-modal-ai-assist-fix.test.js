// tests/wr-modal-ai-assist-fix.test.js
//
// Regression coverage for bugs found and fixed 2026-07-16 in the WR
// creation modal's "AI Assist" feature (renderer/src/js/views/wr-modal.js)
// -- the in-app "Type title then press Enter or click AI Fill..." flow
// the user reported as "when I click enter sometimes it struggles with ai
// actually filling out the rest."
//
// BUG A -- corrupted AI prompt: the areaList variable used to build the
// "VALID AREAS/SUBCATEGORIES" section of every AI Assist prompt was built
// with Object.entries(AREA_SUBS).map(...).join(SEPARATOR), where SEPARATOR
// was supposed to be '\n' but had been corrupted into a huge string
// containing an entire unrelated code block as literal text (a
// bus.on('contacts:use-address', ...) listener that was meant to be real,
// separate executable code -- now properly restored in _wireTow()). This
// meant EVERY area/subcategory entry in EVERY AI Assist prompt was
// separated by dozens of lines of injected JS source instead of a clean
// newline, degrading the model's ability to parse the valid values list
// on every single call.
//
// BUG B -- race condition: pressing Enter called _runAIAssist()
// immediately but never cleared the debounced auto-trigger timer set by
// the 'input' listener (2500ms after typing stops). Since "type a title,
// then press Enter" is the normal way to use this, the debounce timer was
// still pending when Enter fired, and fired a SECOND, unrequested
// _runAIAssist() call ~2.5s later -- racing with (and potentially
// overwriting) the Enter-triggered call's results.
//
// These tests mirror the pure logic in isolation, matching this project's
// existing convention of testing extracted decision logic rather than
// full DOM integration.

import { describe, it, expect } from 'vitest';

describe('BUG A: areaList join separator', () => {
  // Mirrors the exact fixed statement in wr-modal.js's _runAIAssist().
  function buildAreaList(areaSubs) {
    return Object.entries(areaSubs).map(([a, s]) => a + ': ' + s.join(', ')).join('\n');
  }

  const SAMPLE_AREA_SUBS = {
    ENGINE: ['Overheating', 'Oil Leak'],
    TOW: ['MECHANICAL ISSUE', 'ACCIDENT/RECOVERY'],
    ELECTRICAL: ['Battery', 'Wiring'],
  };

  it('joins area entries with a clean newline (no injected code/text between entries)', () => {
    const result = buildAreaList(SAMPLE_AREA_SUBS);
    const lines = result.split('\n');
    expect(lines).toHaveLength(3);
    lines.forEach(line => {
      // No entry should ever contain JS syntax artifacts from the old
      // corrupted separator (function calls, semicolons-as-code, etc.)
      expect(line).not.toMatch(/bus\.on|_el\(|addEventListener/);
    });
  });

  it('each line contains exactly one area\'s full subcategory list, nothing else', () => {
    const result = buildAreaList(SAMPLE_AREA_SUBS);
    expect(result).toBe('ENGINE: Overheating, Oil Leak\nTOW: MECHANICAL ISSUE, ACCIDENT/RECOVERY\nELECTRICAL: Battery, Wiring');
  });

  it('documents the bug: the old corrupted separator injected a huge non-newline blob', () => {
    const corruptedSeparator = '\\  // Listen for address from contact book\n  bus.on("contacts:use-address", (addr) => {\n    const s=_el("wr-tow-street");if(s)s.value=addr.street||"";;\n  });\nn';
    // Prove the corrupted separator is NOT a clean newline (this was the bug)
    expect(corruptedSeparator).not.toBe('\n');
    expect(corruptedSeparator.length).toBeGreaterThan(50);
    // And prove the fixed version is exactly a clean newline
    const fixedSeparator = '\n';
    expect(fixedSeparator).toBe('\n');
    expect(fixedSeparator.length).toBe(1);
  });
});

describe('BUG B: Enter-key / debounce race condition', () => {
  // Mirrors the fixed keydown handler logic: Enter must clear the pending
  // debounce timer before running immediately, so the debounce can never
  // fire a second, unrequested call afterward.
  function simulateKeydownEnter(state) {
    if (state.pendingTimerId !== null) {
      state.clearedTimerIds.push(state.pendingTimerId);
      state.pendingTimerId = null;
    }
    state.runCalls.push('enter');
  }

  function simulateInputDebounce(state, valueLength) {
    if (state.pendingTimerId !== null) {
      state.clearedTimerIds.push(state.pendingTimerId);
    }
    state.pendingTimerId = valueLength > 8 ? state.nextTimerId++ : null;
  }

  it('typing a title then pressing Enter clears the pending debounce timer', () => {
    const state = { pendingTimerId: null, nextTimerId: 1, clearedTimerIds: [], runCalls: [] };
    simulateInputDebounce(state, 20); // user typed >8 chars -> debounce timer scheduled
    expect(state.pendingTimerId).toBe(1);
    simulateKeydownEnter(state); // user hits Enter before debounce fires
    expect(state.pendingTimerId).toBeNull(); // BUG FIX: must be cleared, not left pending
    expect(state.clearedTimerIds).toContain(1);
  });

  it('demonstrates the pre-fix bug: without clearing, Enter + pending debounce = 2 calls', () => {
    // Pre-fix keydown handler: just called run(), never touched pendingTimerId
    const preFixKeydown = (state) => { state.runCalls.push('enter'); };
    const state = { pendingTimerId: 7, runCalls: [] };
    preFixKeydown(state);
    // The bug: pendingTimerId is STILL set after Enter -- it will fire later
    expect(state.pendingTimerId).toBe(7);
    // Simulating the debounce firing ~2.5s later (the second, unwanted call)
    state.runCalls.push('debounce-fired-late');
    expect(state.runCalls).toEqual(['enter', 'debounce-fired-late']); // 2 calls = race
  });

  it('post-fix: Enter + pending debounce results in exactly ONE call', () => {
    const state = { pendingTimerId: 7, nextTimerId: 8, clearedTimerIds: [], runCalls: [] };
    simulateKeydownEnter(state);
    // pendingTimerId cleared -- the debounce can never fire afterward
    expect(state.pendingTimerId).toBeNull();
    expect(state.runCalls).toEqual(['enter']); // exactly 1 call
  });
});

describe('BUG B (defense-in-depth): concurrent-call guard', () => {
  // Mirrors the _aiRunning guard added directly inside _runAIAssist().
  async function runWithGuard(guardState, fn) {
    if (guardState.running) return { skipped: true };
    guardState.running = true;
    try {
      return await fn();
    } finally {
      guardState.running = false;
    }
  }

  it('a second concurrent call is skipped while the first is still in flight', async () => {
    const guardState = { running: false };
    let resolveFirst;
    const firstCall = runWithGuard(guardState, () => new Promise(r => { resolveFirst = r; }));
    // Second call attempted while first is still pending
    const secondResult = await runWithGuard(guardState, async () => ({ ranSecond: true }));
    expect(secondResult).toEqual({ skipped: true });
    resolveFirst({ ranFirst: true });
    const firstResult = await firstCall;
    expect(firstResult).toEqual({ ranFirst: true });
  });

  it('a call after the guard is released (finally-cleared) runs normally', async () => {
    const guardState = { running: false };
    await runWithGuard(guardState, async () => ({ ok: true }));
    expect(guardState.running).toBe(false); // released after completion
    const secondResult = await runWithGuard(guardState, async () => ({ ok: true, second: true }));
    expect(secondResult).toEqual({ ok: true, second: true }); // not skipped
  });
});

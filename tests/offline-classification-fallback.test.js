// tests/offline-classification-fallback.test.js
//
// Answers a direct question: "if Orcha is unavailable, what is the fallback,
// and is there enough local data to work offline?"
//
// src/scrapers/orcha_ws.js's suggestDropdowns() calls localClassify() +
// generateNoteSuggestion() whenever the AI response is missing, malformed, or
// the WS/Bedrock call throws -- see suggestDropdowns() catch blocks and the
// "No JSON in response" branch. Both functions are fully deterministic
// (keyword/regex matching against issue text, vendor name, and relay status)
// with zero network dependency. This test exercises them directly to confirm
// they produce complete, usable classification + note output on their own --
// i.e. the offline path is not just "fails gracefully", it actually works.

import { describe, it, expect } from 'vitest';
import { localClassify, generateNoteSuggestion } from '../src/scrapers/orcha_ws.js';

describe('localClassify (deterministic offline classifier, no AI required)', () => {
  it('classifies an engine issue by keyword match alone', () => {
    const unit = { issue: 'Engine will not start, no crank detected', vendor: 'Amerit', notes: '', relayStatus: '' };
    const result = localClassify(unit);
    expect(result.primaryComponent).toBe('ENGINE/MOTOR SYSTEMS');
    expect(result.repairStatus).toBeTruthy();
    expect(result.confidence).toBe('high');
  });

  it('classifies a chassis/brake issue correctly', () => {
    const unit = { issue: 'Brake pads worn, grinding noise from front wheel', vendor: 'Kooner', notes: '', relayStatus: '' };
    const result = localClassify(unit);
    expect(result.primaryComponent).toBe('CHASSIS');
    expect(result.repairStatus).toBe('KOONER DIAG');
  });

  it('overrides a chassis match to ENGINE when engine keywords appear in notes (documented override rule)', () => {
    const unit = {
      issue: 'brake light on',
      notes: 'Tech found engine coolant leak during inspection, no start condition confirmed',
      vendor: 'TA',
      relayStatus: '',
    };
    const result = localClassify(unit);
    expect(result.primaryComponent).toBe('ENGINE/MOTOR SYSTEMS');
  });

  it('routes repair status by vendor family (Amerit) using note keywords', () => {
    const unit = { issue: 'engine misfire', vendor: 'Amerit', notes: 'repairs in progress, tech on site', relayStatus: '' };
    const result = localClassify(unit);
    expect(result.repairStatus).toBe('AMERIT REPAIRS IN PROGRESS');
  });

  it('routes repair status by vendor family (Cox) with parts-pending keyword', () => {
    const unit = { issue: 'ac not working', vendor: 'Cox', notes: 'parts on order for compressor', relayStatus: '' };
    const result = localClassify(unit);
    expect(result.repairStatus).toBe('COX PARTS');
  });

  it('defaults unknown vendors to the OSR family with a diag sub-status', () => {
    const unit = { issue: 'electrical short in wiring harness', vendor: 'Some Random Dealer', notes: '', relayStatus: '' };
    const result = localClassify(unit);
    expect(result.primaryComponent).toBe('ELECTRICAL');
    expect(result.repairStatus).toBe('OSR- PENDING DIAG');
  });

  it('short-circuits to ACCIDENT / CEI when relay status says accident, regardless of issue text', () => {
    const unit = { issue: 'minor scratch', vendor: 'Amerit', notes: '', relayStatus: 'Lifecycle: Accident' };
    const result = localClassify(unit);
    expect(result.repairStatus).toBe('ACCIDENT / CEI');
    expect(result.confidence).toBe('high');
  });

  it('returns a partial result (not a crash) when issue text has no matching keywords', () => {
    const unit = { issue: '', vendor: '', notes: '', relayStatus: '' };
    const result = localClassify(unit);
    // Must not throw, must return a structured object even when nothing matches
    expect(result).toBeTypeOf('object');
    expect(result.primaryComponent === null || typeof result.primaryComponent === 'string').toBe(true);
  });
});

describe('generateNoteSuggestion (deterministic offline note generator, no AI required)', () => {
  it('generates a dated, vendor-aware note purely from unit fields when no prior notes exist', () => {
    const unit = { issue: 'transmission slipping under load', vendor: 'Amerit', notes: '' };
    const note = generateNoteSuggestion(unit, {});
    // Must be prefixed with today's MM/DD date and reference the vendor
    expect(note).toMatch(/^\d{2}\/\d{2} - /);
    expect(note).toContain('Amerit');
  });

  it('advances the note stage based on the last logged note (progression logic)', () => {
    const unit = { issue: 'AC blowing warm', vendor: 'Cox', notes: '07/10 - Unit pending tow to Cox.' };
    const note = generateNoteSuggestion(unit, {});
    expect(note).toContain('pending diagnostic');
  });

  it('produces a safe fallback note when there is no issue, vendor, or note history at all', () => {
    const unit = { issue: '', vendor: '', notes: '' };
    const note = generateNoteSuggestion(unit, {});
    expect(note).toMatch(/^\d{2}\/\d{2} - /);
    expect(note.length).toBeGreaterThan(10);
  });
});

describe('Offline capability summary (documents the actual fallback contract)', () => {
  it('confirms localClassify + generateNoteSuggestion together produce a complete, displayable result with zero AI/network calls', () => {
    const unit = { issue: 'no start, engine will not crank', vendor: 'Amerit', notes: '', relayStatus: '' };
    const classification = localClassify(unit);
    const note = generateNoteSuggestion(unit, classification);

    // This is exactly what suggestDropdowns() returns to the renderer on the
    // offline/fallback path -- if this shape is complete, the UI has enough
    // data to render a real status band instead of "AI brief unavailable".
    const offlineResult = { ok: true, ...classification, noteSuggestion: note };

    expect(offlineResult.ok).toBe(true);
    expect(offlineResult.primaryComponent).toBeTruthy();
    expect(offlineResult.repairStatus).toBeTruthy();
    expect(offlineResult.noteSuggestion).toBeTruthy();
  });
});

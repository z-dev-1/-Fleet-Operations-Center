// Settings → AI Config → Active AI: pure helpers + a tiny fake-document test
// (no jsdom in this repo). See renderer/src/js/views/ai-pref-logic.js.
import { describe, it, expect } from 'vitest';
import {
  AI_PREF_MODES, AKI_MODES, modeIncludesAki, prefHint, activeAiChipsHtml,
  akiUntrustedHtml, akiSettingsHtml, applyChipStyles, readAkiForm,
  mergeAiSettings, allowUntrustedAfterPick,
} from '../renderer/src/js/views/ai-pref-logic.js';

const ORDER = ['auto', 'orcha', 'claude', 'balanced', 'balanced3', 'aki', 'aki-orcha', 'aki-claude'];

function fakeDoc() {
  const els = {};
  ORDER.forEach((v) => { els['ai-chip-' + v] = { style: {} }; });
  return { els, getElementById: (id) => els[id] || null };
}

describe('Active AI chips', () => {
  it('has 8 modes in order with chip ids and labels', () => {
    expect(AI_PREF_MODES.map((m) => m.value)).toEqual(ORDER);
    AI_PREF_MODES.forEach((m) => expect(m.id).toBe('ai-chip-' + m.value));
    expect(AI_PREF_MODES.map((m) => m.label)).toEqual([
      'Auto (fallback chain)', 'Orcha only', 'Claude Code only', 'Balanced (Orcha + Claude)',
      'Balanced (all 3)', 'Aki only', 'Dual: Aki + Orcha', 'Dual: Aki + Claude',
    ]);
  });

  it('renders 8 labels with radio inputs in order, legacy labels verbatim', () => {
    const html = activeAiChipsHtml();
    const ids = [...html.matchAll(/<label [^>]*id="(ai-chip-[^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(ORDER.map((v) => 'ai-chip-' + v));
    const vals = [...html.matchAll(/<input type="radio" name="ai-pref" value="([^"]+)"/g)].map((m) => m[1]);
    expect(vals).toEqual(ORDER);
    expect(html).toContain('value="auto" style="accent-color:#58a6ff"> Auto (fallback chain)');
    expect(html).toContain('value="orcha" style="accent-color:#22c55e"> Orcha only');
    expect(html).toContain('value="claude" style="accent-color:#818cf8"> Claude Code only');
    expect(html).toContain('value="balanced" style="accent-color:#f0a800"> Balanced (Orcha + Claude)');
    expect(html).toContain('value="balanced3" style="accent-color:#f0a800"> Balanced (all 3)');
    expect(html).toContain('value="aki" style="accent-color:#f472b6"> Aki only');
  });

  it('legacy hints are unchanged and every mode has a hint', () => {
    expect(prefHint('auto')).toBe('Auto: tries Orcha first, falls back to Claude Code if quota is exceeded.');
    expect(prefHint('orcha')).toBe('Orcha only: no Claude fallback. AI is unavailable if Orcha quota runs out.');
    expect(prefHint('claude')).toBe('Claude Code only: skips Orcha, uses Cecelia shared Bedrock via claude -p.');
    expect(prefHint('balanced')).toBe('Balanced: runs Orcha + Claude as two lanes — when one is busy the next request uses the other, so work goes faster. If one is down, everything uses the other automatically.');
    ORDER.forEach((v) => expect(prefHint(v).length).toBeGreaterThan(10));
    expect(prefHint('nope')).toBe('');
  });

  it('applyChipStyles highlights only the picked chip (fake document)', () => {
    ORDER.forEach((pick) => {
      const doc = fakeDoc();
      applyChipStyles(doc, pick);
      ORDER.forEach((v) => {
        const s = doc.els['ai-chip-' + v].style;
        if (v === pick) {
          expect(s.borderColor).toBe('var(--acc)');
          expect(s.background).toBe('rgba(88,166,255,.08)');
        } else {
          expect(s.borderColor).toBe('var(--bdr)');
          expect(s.background).toBe('');
        }
      });
    });
  });

  it('applyChipStyles tolerates missing chips', () => {
    expect(() => applyChipStyles({ getElementById: () => null }, 'aki')).not.toThrow();
  });
});

describe('Aki untrusted checkbox + subsection', () => {
  it('renders the labeled checkbox', () => {
    const html = akiUntrustedHtml();
    expect(html).toContain('<input type="checkbox" id="ai-aki-untrusted">');
    expect(html).toContain('for="ai-aki-untrusted"');
    expect(html).toContain('Allow emails, attachments and links to go to Aki');
    expect(html).toContain('Used only when an Aki mode is selected.');
  });

  it('renders the Aki subsection fields', () => {
    const html = akiSettingsHtml();
    expect(html).toContain('🦊 Aki');
    expect(html).toContain('id="ai-aki-enabled"');
    expect(html).toContain('Aki lane enabled');
    expect(html).toMatch(/id="ai-aki-profile" placeholder="\(Aki default\)"/);
    expect(html).toMatch(/id="ai-aki-model" placeholder="\(Aki default\)"/);
    expect([...html.matchAll(/<option value="(\d)">/g)].map((m) => m[1])).toEqual(['1', '2', '3', '4']);
    expect(html).toContain('id="ai-aki-timeout" type="number"');
  });

  it('modeIncludesAki / AKI_MODES', () => {
    expect([...AKI_MODES]).toEqual(['balanced3', 'aki', 'aki-orcha', 'aki-claude']);
    expect(ORDER.filter(modeIncludesAki)).toEqual(['balanced3', 'aki', 'aki-orcha', 'aki-claude']);
  });

  it('allowUntrustedAfterPick truth table', () => {
    ORDER.forEach((v) => {
      const aki = AKI_MODES.includes(v);
      expect(allowUntrustedAfterPick(false, v)).toBe(aki);
      expect(allowUntrustedAfterPick(true, v)).toBe(true);
    });
  });
});

describe('Aki settings persistence', () => {
  const DEFAULTS = { enabled: true, allowUntrusted: false, profile: '', model: '', concurrency: 2, timeoutSec: 120 };

  it('readAkiForm defaults', () => {
    expect(readAkiForm({})).toEqual(DEFAULTS);
    expect(readAkiForm(null)).toEqual(DEFAULTS);
    expect(readAkiForm({ ai: { gateway: {} } })).toEqual(DEFAULTS);
  });

  it('readAkiForm reads and clamps', () => {
    expect(readAkiForm({ ai: { aki: {
      enabled: false, allowUntrusted: true, profile: 'fleet-specialist', model: 'claude-sonnet', concurrency: 4, timeoutMs: 300000,
    } } })).toEqual({ enabled: false, allowUntrusted: true, profile: 'fleet-specialist', model: 'claude-sonnet', concurrency: 4, timeoutSec: 300 });
    expect(readAkiForm({ ai: { aki: {
      allowUntrusted: 'yes', profile: '-x', model: 'a b', concurrency: 9, timeoutMs: 1000,
    } } })).toEqual(DEFAULTS);
    expect(readAkiForm({ ai: { aki: { concurrency: 0, timeoutMs: 9999999 } } })).toEqual(DEFAULTS);
  });

  it('mergeAiSettings keeps other ai keys and writes ai.aki', () => {
    const all = { other: 1, ai: { gateway: { dedupe: true }, dbrLookup: true } };
    const form = { enabled: true, allowUntrusted: true, profile: 'p1', model: 'm1', concurrency: 3, timeoutSec: 90 };
    const ai = mergeAiSettings(all, form);
    expect(ai.gateway).toEqual({ dedupe: true });
    expect(ai.dbrLookup).toBe(true);
    expect(ai.aki).toEqual({ enabled: true, allowUntrusted: true, profile: 'p1', model: 'm1', concurrency: 3, timeoutMs: 90000 });
    expect(all.ai.aki).toBeUndefined(); // input not mutated
    expect(readAkiForm({ ...all, ai })).toEqual(form); // round trip
  });

  it('mergeAiSettings sanitizes raw form values', () => {
    const ai = mergeAiSettings({}, { enabled: false, allowUntrusted: 1, profile: ' a b ', model: '', concurrency: NaN, timeoutSec: NaN });
    expect(ai.aki).toEqual({ enabled: false, allowUntrusted: false, profile: '', model: '', concurrency: 2, timeoutMs: 120000 });
  });
});

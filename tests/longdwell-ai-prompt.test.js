// tests/longdwell-ai-prompt.test.js — the 7-bullet summary contract sits in the
// head of the Long Dwell AI Fill prompt, ahead of the ~27k-char FAS KB, so it
// survives the Aki lane's ~32k head-keep truncation on Windows.
import { describe, it, expect } from 'vitest';
import { _buildAIFillPrompt } from '../renderer/src/js/longdwell-ai.js';
import { LD_SUMMARY_LABELS } from '../renderer/src/js/longdwell-summary-format.js';
import { LD_GOLD_EXAMPLE_1, LD_GOLD_EXAMPLE_2 } from './helpers/aki-style-replies.js';

describe('_buildAIFillPrompt summary contract', () => {
  const prompt = _buildAIFillPrompt({ equipmentId: 'B13014' }, 60);
  const headEnd = prompt.indexOf('You are Orcha');

  it('states all 7 labels in order before the KB / role text', () => {
    expect(headEnd).toBeGreaterThan(0);
    expect(headEnd).toBeLessThan(1500);
    const head = prompt.slice(0, headEnd);
    let at = -1;
    for (const label of LD_SUMMARY_LABELS) {
      const i = head.indexOf(label + ':', at + 1);
      expect(i, label).toBeGreaterThan(at);
      at = i;
    }
    expect(head).toContain('EXACTLY 7 lines');
    expect(head).toContain('\\u2022 ');
  });

  it('keeps the full spec and both gold examples', () => {
    expect(prompt).toContain('3. summary --');
    expect(prompt).toContain('EXAMPLE 1:');
    expect(prompt).toContain('EXAMPLE 2:');
    for (const line of [...LD_GOLD_EXAMPLE_1.split('\n'), ...LD_GOLD_EXAMPLE_2.split('\n')]) {
      expect(prompt).toContain(line.replace('\u2022', '\\u2022'));
    }
  });
});

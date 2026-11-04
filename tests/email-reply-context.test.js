import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'email-reply-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const actions = require('../src/scrapers/email_actions');

beforeEach(() => { store.save('canonicalState', { units: {} }); });

describe('email_actions — reply uses grounded canonical context (spec §23)', () => {
  it('folds the unit canonical state into the reply context block', () => {
    store.save('canonicalState', { units: {
      '322472': {
        situation: 'Awaiting turbo parts, ETA 10/23',
        repairPhase: 'awaiting_parts',
        waitingOnFine: 'parts',
        nextStep: 'Await parts arrival',
        lastMeaningfulUpdate: { text: 'Turbo parts on order, ETA 10/23', at: '2026-10-19T00:00:00Z' },
      },
    } });
    const email = { id: 'm1', from: 'partner@x.com', subject: 'What is the ETC on 322472?', unitRefs: [{ unit: '322472' }] };
    const block = actions._replyContextBlock(email);
    expect(block).toContain('Unit 322472');
    expect(block).toContain('awaiting_parts');
    expect(block).toContain('ETA 10/23');
    // The full reply prompt embeds it and instructs grounded answering.
    const prompt = actions._buildReplyPrompt(email, '');
    expect(prompt).toContain('GROUNDED FLEET CONTEXT');
    expect(prompt).toContain('322472');
    expect(prompt).toMatch(/do not invent|do NOT fabricate|under review/i);
  });

  it('no canonical record -> no context block (reply still works, generic)', () => {
    const email = { id: 'm2', from: 'x@y.com', subject: 'hello', unitRefs: [{ unit: '999999' }] };
    expect(actions._replyContextBlock(email)).toBe('');
    const prompt = actions._buildReplyPrompt(email, '');
    expect(prompt).not.toContain('GROUNDED FLEET CONTEXT');
  });

  it('no unit refs -> no context block', () => {
    expect(actions._replyContextBlock({ id: 'm3', subject: 'generic' })).toBe('');
  });
});

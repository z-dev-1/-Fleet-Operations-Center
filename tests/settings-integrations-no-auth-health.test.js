// tests/settings-integrations-no-auth-health.test.js
// The Midway / AAP Auth Health section moved out of Settings -> Integrations
// (it now opens from the bottom status bar auth pill). The Integrations pane
// must still render and its section accordion must still work.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { createMiniDocument } from './fixtures/mini-dom.js';

let doc, settings;

beforeAll(async () => {
  if (typeof globalThis.window === 'undefined') globalThis.window = { app: { platform: 'win32' } };
  doc = createMiniDocument();
  globalThis.document = doc;
  settings = await import('../renderer/src/js/views/settings.js');
  const wrap = doc.createElement('div');
  wrap.innerHTML = settings._forTests.html();
  doc.body.appendChild(wrap);
});
afterAll(() => { delete globalThis.document; });

describe('Settings -> Integrations without Auth Health', () => {
  it('renders the Integrations pane with sections but no auth-health section or ids', () => {
    const pane = doc.getElementById('sd-pane-integrations');
    expect(pane).toBeTruthy();
    const sections = pane.children.filter((c) => c.classList.contains('sd-section'));
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(doc.getElementById('sect-auth-health')).toBeNull();
    for (const id of ['auth-health-state', 'auth-health-grid', 'auth-health-history', 'auth-health-refresh', 'auth-health-retry', 'auth-health-mwinit']) {
      expect(doc.getElementById(id)).toBeNull();
    }
    expect(pane.textContent).not.toContain('Midway / AAP Auth Health');
  });

  it('the accordion collapses every section and opens one at a time', () => {
    settings._forTests.wireSectionAccordion('sd-pane-integrations');
    const pane = doc.getElementById('sd-pane-integrations');
    const sections = pane.children.filter((c) => c.classList.contains('sd-section'));
    for (const s of sections) {
      expect(s.classList.contains('collapsed')).toBe(true);
      expect(s.querySelector('.sd-section-title .sd-chevron')).toBeTruthy();
    }
    const [a, b] = sections;
    a.querySelector('.sd-section-title').click();
    expect(a.classList.contains('collapsed')).toBe(false);
    b.querySelector('.sd-section-title').click();
    expect(a.classList.contains('collapsed')).toBe(true);
    expect(b.classList.contains('collapsed')).toBe(false);
    b.querySelector('.sd-section-title').click();
    expect(b.classList.contains('collapsed')).toBe(true);
  });

  it('settings.js no longer wires or renders auth health itself', () => {
    const src = fs.readFileSync(new URL('../renderer/src/js/views/settings.js', import.meta.url), 'utf8');
    expect(src).not.toMatch(/_wireAuthHealth|_loadAuthHealth|_renderAuthHealth|healthRunMwinit|sect-auth-health"/);
  });
});

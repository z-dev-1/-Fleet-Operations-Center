// tests/awareness-no-direct-sends.test.js
// Static guards for the context-aware assistant (design §D16.8, AC14).
// Main-process checks plus the renderer escaping checks (AC27).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('no direct Slack sends from proactive sources (AC14)', () => {
  for (const rel of ['src/orcha/deep-scan.js', 'src/orcha/proactive-alerts.js']) {
    it(rel + ' has no sendToChannel( call and no ch.mode === \'justme\'', () => {
      const code = stripComments(read(rel));
      expect(code).not.toMatch(/\bsendToChannel\s*\(/);
      expect(code).not.toContain("ch.mode === 'justme'");
    });
  }
});

describe('decisivReadyGate unchanged', () => {
  // sha1 of the function source (LF line endings) at base commit dd3a550.
  const BASE_SHA1 = '0a31ea3c74dd4f33f649ca5bc905c9effe20c89b';
  it('function body matches the dd3a550 snapshot', () => {
    const s = read('src/scrapers/ready_pickup_notify.js');
    const i = s.indexOf('function decisivReadyGate(');
    expect(i).toBeGreaterThanOrEqual(0);
    const j = s.indexOf('\n}\n', i);
    const fn = s.slice(i, j + 2);
    expect(crypto.createHash('sha1').update(fn).digest('hex')).toBe(BASE_SHA1);
  });
});

// ── Renderer half (§D16.8, AC27): note text is escaped before it hits innerHTML.
// Returns the text of the {...} block that starts at the first '{' after `from`.
function braceBlock(src, from) {
  const open = src.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(open, k + 1); }
  }
  return '';
}

describe('renderer escapes proactive note text (AC27)', () => {
  it('bridge.js onNotes( handler emits ui:notif-push with body: _esc( and never a raw .text body', () => {
    const s = read('renderer/src/js/bridge.js');
    const i = s.indexOf('window.assistant.onNotes(');
    expect(i).toBeGreaterThanOrEqual(0);
    const block = braceBlock(s, i);
    expect(block).toContain("'ui:notif-push'");
    expect(block).toMatch(/body:\s*_esc\(/);
    const bodies = block.match(/body:\s*[^\n]*/g) || [];
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect(b).toMatch(/^body:\s*_esc\(/);
    expect(block).not.toMatch(/body:\s*[A-Za-z_$][\w$.]*\.text\b/);
  });

  it('orcha-fab.js _refreshNotes interpolates n.text / n.title / n.unit only through _escapeHtml(', () => {
    const s = read('renderer/src/js/components/orcha-fab.js');
    const i = s.indexOf('function _refreshNotes(');
    expect(i).toBeGreaterThanOrEqual(0);
    const body = braceBlock(s, i);
    for (const f of ['text', 'title', 'unit']) {
      const re = new RegExp('\\bn\\.' + f + '\\b', 'g');
      let m; let count = 0;
      while ((m = re.exec(body)) !== null) {
        count++;
        expect(body.slice(Math.max(0, m.index - '_escapeHtml('.length), m.index)).toBe('_escapeHtml(');
      }
      expect(count).toBeGreaterThan(0);
    }
  });
});

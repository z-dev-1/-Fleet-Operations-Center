// Email-only condensed TIMELINE digest in the SOS/EOS down-unit card
// (src/scrapers/emailBuilder.js). Fixture: tests/fixtures/eos-report-fixtures.js
// u322283 (the user's 322283 timeline). Assertions (a)-(i) of the brief.
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eos-tl-digest-'));
require('../src/config/paths').setDataDir(tmpDir);
const store = require('../src/store');
const { buildEmail, _timelineDigestModel } = require('../src/scrapers/emailBuilder');
const TD = require('../src/orcha/timeline-digest');
const { redactForSharing } = require('../src/orcha/redact_sharing');
const fx = require('./fixtures/eos-report-fixtures');
const F = fx.u322283;

function build(f, units, notesStore) {
  return buildEmail({
    operator: f.operator, domicile: f.domicile, slot: f.slot, units: units || f.units, testMode: false,
    relayCache: f.relayCache, notesStore: notesStore || f.notesStore, emailNote: '',
  });
}
function card(html, id) {
  const i = html.indexOf('<b>' + id + '</b>');
  const end = html.indexOf('&#9660; DOWN', html.indexOf('TIMELINE', i));
  return html.slice(i, end > -1 ? end : html.indexOf('UPTAKE INSIGHTS'));
}
const decode = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
function tlCell(html) {
  const c = card(html, '322283');
  const s = c.indexOf('TIMELINE');
  return c.slice(s, c.indexOf('\n</td>\n</tr></table>', s));
}
// [{date, html}] trail rows in render order.
function rows(tl) {
  const out = [];
  const re = /<td class="eos-tl-date"[^>]*>([\s\S]*?)<\/td><td valign="top" style="padding:1px 0;">([\s\S]*?)<\/td><\/tr>/g;
  let m;
  while ((m = re.exec(tl))) out.push({ date: decode(m[1]), html: m[2], text: decode(m[2]) });
  return out;
}

let html; let tl; let text;
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 19, 17, 0));
});
afterAll(() => { vi.useRealTimers(); });
beforeEach(() => {
  store.save('emailLastSnapshot', {});
  store.save('fleetData', { rows: [] });
  html = build(F);
  tl = tlCell(html);
  text = decode(tl);
});

describe('322283 email timeline digest', () => {
  it('(a) every source date is in the trail, chronological, once', () => {
    expect(rows(tl).map((r) => r.date)).toEqual(['09/16', '09/18', '09/22', '09/30', '10/06', '10/12', '10/14', '10/15', '10/17',
      '10/20', '10/21', '10/26', '10/28', '11/03', '11/04', '11/07\u201311/09', '11/10', '11/11', '11/13', '11/16', '11/18']);
    expect(text).toContain('LATEST 11/18');
  });

  it('(b) each trail entry is a single short line', () => {
    for (const r of rows(tl)) {
      expect(r.html, r.date).not.toContain('<br>');
      expect(r.text.length, r.date).toBeLessThanOrEqual(160);
      expect(r.text.length, r.date).toBeGreaterThan(0);
    }
  });

  it('(c) same-day duplicates merge to one line and keep distinct facts', () => {
    const rs = rows(tl);
    for (const d of ['10/14', '10/15', '10/20', '11/16']) expect(rs.filter((r) => r.date === d).length, d).toBe(1);
    const r16 = rs.find((r) => r.date === '11/16').text;
    expect(r16).toContain('transmission repairs complete');
    expect(r16).toContain('driver alert speaker');
    expect(r16).toMatch(/PM-B|B service/);
    expect(rs.find((r) => r.date === '10/20').text).toMatch(/Est V1 rejected/);
  });

  it('(d) LATEST block sits above the trail and shows the newest entry in full', () => {
    const li = tl.indexOf('eos-tl-latest');
    expect(li).toBeGreaterThan(-1);
    expect(li).toBeLessThan(tl.indexOf('eos-tl-date'));
    const latest = decode(tl.slice(li, tl.indexOf('</table>', li)));
    expect(latest).toContain('LATEST 11/18');
    for (const s of ['Road test failed for new CEL fault', 'Dealer confirmed diagnosis of new fault underway',
      'Body repairs and final QC not yet completed', 'No ETR provided', '64 days down']) expect(latest).toContain(s);
  });

  it('(e) no $, personal name, case / ASIST / SF / WR id or amz ref in the timeline cell', () => {
    expect(text).not.toMatch(/\$/);
    expect(text).not.toMatch(/\b\d{5,}\b/);
    expect(text).not.toMatch(/amz-/i);
    expect(text).not.toMatch(/\b(?:ASIST|SF|Salesforce|WR|SR)\s*(?:case\s*|service request\s*)?#?\s*\d/i);
    expect(text).not.toMatch(/return tow/i);
    for (const n of F.names) expect(text, n).not.toContain(n);
    // The ids still render in their own column (meta line).
    const meta = card(html, '322283');
    expect(meta.slice(0, meta.indexOf('RELAY GARAGE'))).toContain('00034097');
    expect(meta.slice(0, meta.indexOf('RELAY GARAGE'))).toContain('amz-kzcqubb6kx3dcf');
  });

  it('(f) vendor/dealer, dates, estimate version + scope and root cause are kept', () => {
    for (const s of ['Volvo', "Bergey's Truck Centers - Pennsauken", 'Est V2 approved', 'batteries', 'hood', 'Est V3 approved',
      'Est V4 approved', 'root cause', 'transmission specialist', 'Tow arranged']) expect(text, s).toContain(s);
  });

  it('(g) dealer-name variants resolve to the canonical dealer with no hedge', () => {
    expect(text).not.toMatch(/disput|disagree|MV Contract Maintenance|Pennsauk(?!en)|Bergeys/i);
    expect(rows(tl).find((r) => r.date === '11/10').text).toMatch(/^Bergey's Truck Centers - Pennsauken confirmed transmission repairs/);
  });

  it('(h) in-app drawer timeline, engine, redaction, scheduler and send path are unchanged', () => {
    const git = (...a) => { try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) { return null; } };
    if (git('cat-file', '-e', '12a01de^{commit}') === null) return;   // git / base unavailable: skip
    // relay-actions.js is excluded: the later auto-draft-on-select change edits it on purpose.
    // The Pending Estimates upgrade edits the files below on purpose (Vendor WO chips, overlay);
    // none of their changed lines may touch the timeline. The Inbox Triage free-write reply edits the
    // email triage overlay on purpose (same rule). DTNA Phase A edits these on purpose
    // (status pill, Pull DTNA, bulk tool); same rule. DTNA Phase B adds the dealer-visible approval
    // title and the Post to DTNA compose modal on purpose; same rule. DTNA Phase C adds the Change Stage
    // control on purpose; same rule.
    // Aperia v1 adds the aperia-* renderer files (pill, panel, unit tires, issues and bulk modals) on
    // purpose; same rule. DTNA Phase D edits the deep-scan DTNA offsite block on purpose
    // (session-gated live read, case number, cache join); same rule. Phase E (background DTNA / Aperia
    // sign-in) trims the auto-login engine's log lines (no URL query, no page text) and fixes its
    // listener cleanup on purpose; same rule.
    const upgraded = ['src/orcha/deep-scan.js', 'src/orcha/auto-login.js', 'renderer/src/js/components/relay-write-approval.js', 'renderer/src/js/views/dtna-actions.js',
      'renderer/src/js/views/dtna-stage-actions.js',
      'renderer/src/css/fleet.css', 'renderer/src/js/views/id-links.js',
      'renderer/src/js/views/pending-estimates-logic.js', 'renderer/src/js/views/pending-estimates-panel.js',
      'renderer/src/js/views/unit-detail.js', 'renderer/src/js/components/email-triage-overlay.js',
      'renderer/src/js/views/fleet.js', 'renderer/src/js/components/status-bar.js',
      'renderer/src/js/components/status-bar-logic.js', 'renderer/src/js/components/dtna-panel.js',
      'renderer/src/js/views/dtna-bulk-modal.js',
      'renderer/src/js/components/aperia-panel.js', 'renderer/src/js/components/aperia-pill-logic.js',
      'renderer/src/js/views/aperia-bulk-modal.js', 'renderer/src/js/views/aperia-issues-modal.js',
      'renderer/src/js/views/aperia-tires.js', 'src/orcha/canonical_runner.js', 'src/orcha/canonical_state.js',
      // DTNA Chatter + Files: the unit AI context gains the extracted estimate-PDF lines (no timeline change).
      'src/orcha/ai-context.js',
      // Fleet Autopilot V1 adds the low-priority 'autopilot' relay source, the opts.isolated pass-through in
      // reason.js askOpts, the Autopilot dashboard view files and its two app.js init lines on purpose; same rule.
      'src/orcha/relay.js', 'src/orcha/reason.js', 'renderer/src/js/app.js', 'renderer/src/js/views/autopilot.js',
      'renderer/src/js/views/autopilot-logic.js', 'renderer/src/js/views/autopilot-api.js'];
    const paths = ['renderer', 'src/orcha', 'src/scheduler', 'src/scrapers/owa-mailer.js', 'src/scrapers/relay.js',
      ':(exclude)renderer/src/js/views/relay-actions.js', ...upgraded.map((p) => ':(exclude)' + p)];
    expect(git('diff', '--name-only', '12a01de', '--', ...paths).trim()).toBe('');
    expect(git('diff', '--name-only', '--', ...paths).trim()).toBe('');
    // Fleet Autopilot V2 shows read-only timeline proposals in its dashboard ("Proposal — not published to
    // the unit timeline"); those view lines may say "timeline" but must never reach a timeline write.
    const AP_VIEWS = ['renderer/src/js/views/autopilot.js', 'renderer/src/js/views/autopilot-logic.js', 'renderer/src/js/views/autopilot-api.js'];
    const changed = (git('diff', '-U0', '12a01de', '--', ...upgraded.filter((p) => !AP_VIEWS.includes(p))) || '').split('\n')
      .filter((l) => /^[+-](?![+-])/.test(l) && /timeline/i.test(l));
    expect(changed).toEqual([]);
    const apChanged = (git('diff', '-U0', '12a01de', '--', ...AP_VIEWS) || '').split('\n')
      .filter((l) => /^[+-](?![+-])/.test(l) && /timeline/i.test(l));
    for (const l of apChanged) expect(l, l).not.toMatch(/applyUnitTimelineUpdate|writeTimeline|setTimeline|notesStore|\.save\(|\.update\(|ipcRenderer|invoke\(/);
    const sample = '11/10 - Christy Adriaansen - Kenworth Northeast Group (Service Advisor) confirmed, estimate $1,200.00 (ASIST case 21268757)';
    const before = redactForSharing(sample);
    build(F);
    expect(redactForSharing(sample)).toBe(before);
  }, 120_000);

  it('(i) stored timeline data is not mutated', () => {
    const units = F.units;
    const notesStore = JSON.parse(JSON.stringify(F.notesStore));
    const before = JSON.stringify({ units, notesStore });
    build(F, units, notesStore);
    expect(JSON.stringify({ units, notesStore })).toBe(before);
    expect(notesStore['322283'].timeline).toBe(fx.U322283_TIMELINE);
    for (const s of ['$4,210.30', 'Christy Adriaansen', '21268757']) expect(notesStore['322283'].timeline).toContain(s);
    expect(store.load('notesStore', {})).toEqual({});
  });
});

describe('cached grounded digest reuse', () => {
  const now = new Date(2026, 10, 19, 17, 0);
  const sp = TD.splitLatest(fx.U322283_TIMELINE, now);
  const aiLine = '10/21 - Est V2 approved: 4 batteries, PM-B + plugs, accelerator pedal, hood + paint (ASIST case 21365790).';
  const digest = { v: TD.DIGEST_VERSION, method: 'ai', latestEntry: sp.latest, historyCount: sp.history.length, lines: [aiLine] };
  const unit = F.units[0];
  const row = (m) => m.trail.find((r) => r.date === '10/21').text;

  it('a fresh AI digest line replaces that date\'s one-liner (ids still stripped)', () => {
    expect(row(_timelineDigestModel(unit, fx.U322283_TIMELINE, digest, now)))
      .toBe('Est V2 approved: 4 batteries, PM-B + plugs, accelerator pedal, hood + paint.');
  });
  it('a stale or fallback digest is ignored', () => {
    const det = row(_timelineDigestModel(unit, fx.U322283_TIMELINE, null, now));
    expect(det).toMatch(/^Est V2 approved: four batteries replaced/);
    expect(row(_timelineDigestModel(unit, fx.U322283_TIMELINE, { ...digest, latestEntry: 'x' }, now))).toBe(det);
    expect(row(_timelineDigestModel(unit, fx.U322283_TIMELINE, { ...digest, method: 'fallback' }, now))).toBe(det);
  });
  it('does not mutate the digest', () => {
    const d = JSON.parse(JSON.stringify(digest));
    _timelineDigestModel(unit, fx.U322283_TIMELINE, d, now);
    expect(d).toEqual(digest);
  });
});

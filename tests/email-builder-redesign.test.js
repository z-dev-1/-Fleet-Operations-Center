// SOS/EOS report redesign (v3): OWA-safety + content guards for buildEmail().
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eos-redesign-'));
require('../src/config/paths').setDataDir(tmpDir);
const store = require('../src/store');
const { buildEmail } = require('../src/scrapers/emailBuilder');
const { buildSubjectSuffix } = require('../src/scrapers/email-summary');
const fx = require('./fixtures/eos-report-fixtures');

function build(f, extra) {
  return buildEmail({
    operator: f.operator, domicile: f.domicile, slot: f.slot, units: f.units, testMode: false,
    relayCache: f.relayCache, notesStore: f.notesStore, emailNote: 'Yard <closes> early', ...(extra || {}),
  });
}
// The <td ...> opening tag and its content up to the matching card cell end, for a label.
function tdOpenFor(html, label) {
  const i = html.indexOf(label);
  const j = html.lastIndexOf('<td', i);
  return html.slice(j, html.indexOf('>', j) + 1);
}

beforeEach(() => { store.save('emailLastSnapshot', {}); });

describe('OWA safety', () => {
  for (const name of ['auvte', 'mixed']) {
    it(name + ': no style element, div, gradients, images, alpha colors, or CSS layout', () => {
      const html = build(fx[name]);
      for (const bad of ['<style', '<div', 'linear-gradient', 'background-image', 'rgba(', 'box-shadow', 'display:flex', 'display:grid', 'float:', 'position:', '{{']) {
        expect(html, bad).not.toContain(bad);
      }
      const fills = html.match(/(?:background-color:|bgcolor=")[^;"]*/g) || [];
      expect(fills.length).toBeGreaterThan(20);
      for (const f of fills) expect(f).toMatch(/#[0-9a-fA-F]{6}$/);
    });
    it(name + ': light hero and footer, no dark shell', () => {
      const html = build(fx[name]);
      expect(html).toContain('<td bgcolor="#f5f8fc"');
      expect(html).toMatch(/<td bgcolor="#f4f6f9"[^>]*>\s*<font[^>]*>[^<]*Do not reply to this email/);
      expect(html).not.toContain('#0b1830');
      expect(html).not.toContain('#132840');
      expect(html).toMatch(/<body style="[^"]*background-color:#e9edf3/);
    });
  }
});

describe('Relay Garage', () => {
  it('cell has a fixed width and word-wrap, issue text is not clipped', () => {
    const html = build(fx.auvte);
    const td = tdOpenFor(html, 'RELAY GARAGE');
    expect(td).toContain('width="410"');
    expect(td).toContain('word-wrap:break-word');
    expect(html).toContain('END-OF-ISSUE-MARKER');
  });
  it('timeline shown, private savedNotes never sent', () => {
    const html = build(fx.auvte);
    expect(html).toContain('Towed to COX, diagnosed CEL');
    expect(html).not.toContain('PRIVATE-SCRATCH-DO-NOT-SEND');
  });
  it('Alt ID / Offsite / Case links keep their hrefs', () => {
    const html = build(fx.auvte);
    expect(html).toContain('href="https://service.example.com/alt/amz-8w2u-0001"');
    expect(html).toContain('href="https://relay.example.com/ose/55120"');
    expect(html).toContain('href="https://sf.example.com/case/00482213"');
    expect(html).toContain('00490001');
  });
});

describe('PM & DOT chips', () => {
  it('overdue chips use calendar days, due-soon within 60d only', () => {
    const html = build(fx.auvte);
    expect(html).toContain('B12195 &#183; PM-B 14d over');
    expect(html).toContain('B12201 &#183; DOT 3d over');
    expect(html).toContain('B12210 &#183; Quarterly Lift 2d over');
    expect(html).toContain('B12222 &#183; PM-X overdue');
    const d20 = fx.fmtDate(20).replace(/, \d{4}$/, '');
    expect(html).toContain('B12310 &#183; DOT ' + d20);
    expect(html).not.toContain('B12312 &#183;');
  });
  it('Quarterly Lift only when box trucks are present', () => {
    expect(build(fx.mixed)).toContain('Quarterly Lift');
    const noBox = { ...fx.mixed, units: fx.mixed.units.filter(u => !/box/i.test(u.bodyType || '')) };
    expect(build(noBox)).not.toContain('Quarterly');
  });
});

describe('Change since last report', () => {
  it('renders chips and ids with a baseline; subject suffix unchanged', () => {
    fx.seedBaseline(store, fx.auvte);
    const html = build(fx.auvte);
    expect(html).toContain('SINCE LAST REPORT (PM / EOS');
    expect(html).toContain('2 newly down');
    expect(html).toContain('1 back in service');
    expect(html).toContain('New: B12230, B12240');
    expect(html).toContain('Returned: B12400');
    expect(buildEmail._lastSubjectSuffix).toBe(buildSubjectSuffix(buildEmail._lastChangeMeta));
    expect(buildEmail._lastSubjectSuffix).toContain('2 New');
  });
  it('is omitted without a baseline', () => {
    const html = build(fx.auvte);
    expect(html).not.toContain('SINCE LAST REPORT');
    expect(buildEmail._lastSubjectSuffix).toBe(' | 7 Unavail');
  });
});

describe('Uptake insights', () => {
  it('links to fleet.uptake.com/asset/<uuid> only when a uuid exists', () => {
    const html = build(fx.auvte);
    expect(html).toContain('href="https://fleet.uptake.com/asset/' + fx.UUID + '"');
    expect(html).toContain('View in Uptake');
    expect((html.match(/fleet\.uptake\.com\/asset\//g) || []).length).toBe(1);
    const card64 = html.slice(html.indexOf('B12301'), html.indexOf('</table>', html.indexOf('Status: Opened')));
    expect(card64).not.toContain('fleet.uptake.com');
  });
  it('explicit assetUuid field is honored', () => {
    const f = { ...fx.auvte, units: fx.auvte.units.map(u => (u.id === 'B12301' ? { ...u, assetUuid: fx.UUID2 } : u)) };
    expect(build(f)).toContain('fleet.uptake.com/asset/' + fx.UUID2);
  });
});

describe('New delivery', () => {
  it('renders ORDERED units, omitted when none', () => {
    const html = build(fx.auvte);
    expect(html).toContain('NEW DELIVERY');
    expect(html).toContain('ORDERED &#183; Pending Delivery');
    expect(html).toContain('New Delivery Box Truck Inspection');
    const none = { ...fx.auvte, units: fx.auvte.units.filter(u => u.atsState !== 'Ordered') };
    expect(build(none)).not.toContain('NEW DELIVERY');
  });
});

describe('Slot, hero, data', () => {
  it('AM is SOS / Start of Shift, PM is EOS / End of Shift', () => {
    const am = build(fx.mixed);
    expect(am).toContain('SOS REPORT');
    expect(am).toContain('Start of Shift Report');
    expect(am).toContain('#e0eeff');
    const pm = build(fx.auvte);
    expect(pm).toContain('EOS REPORT');
    expect(pm).toContain('End of Shift Report');
    expect(pm).toContain('#fff4d9');
  });
  it('test mode puts TEST in the accent bar', () => {
    expect(build(fx.auvte, { testMode: true })).toMatch(/bgcolor="#b84500"[^>]*>\s*<font[^>]*>TEST<\/font>/);
  });
  it('AUVTE hero numbers and a single body-type card', () => {
    const html = build(fx.auvte);
    expect(html).toContain('<b>7</b>');
    expect(html).toContain('&nbsp;/ 29');
    expect(html).toContain('<b>76</b>');
    expect(html).toContain('22 of 29');
    expect((html.match(/ &#183; AUVTE<\/b>/g) || []).length).toBe(1);
  });
  it('mixed hero lists each body type and filters other operators', () => {
    const html = build(fx.mixed);
    expect(html).toContain('Day Cab 4<br>Sleeper 3<br>Box Truck 2');
    expect(html).toContain('9 down (4 Day Cab &#183; 3 Sleeper &#183; 2 Box Truck)');
    expect(html).not.toContain('AUVTE-LEAK');
  });
  it('note bar is escaped', () => {
    expect(build(fx.auvte)).toContain('NOTE: Yard &lt;closes&gt; early');
  });
});

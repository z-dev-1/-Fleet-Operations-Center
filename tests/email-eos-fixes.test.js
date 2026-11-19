// SOS/EOS report follow-up fixes: meta-line layout, Relay Garage for every
// down unit with data, PM/DOT chips from the raw AAP due fields, and
// render-time redaction of dollar amounts + personal names.
// Fixture: tests/fixtures/eos-report-fixtures.js (fld = FLD260703 shape).
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eos-fixes-'));
require('../src/config/paths').setDataDir(tmpDir);
const store = require('../src/store');
const { buildEmail } = require('../src/scrapers/emailBuilder');
const fx = require('./fixtures/eos-report-fixtures');

function build(f, units, notesStore) {
  return buildEmail({
    operator: f.operator, domicile: f.domicile, slot: f.slot, units: units || f.units, testMode: false,
    relayCache: f.relayCache, notesStore: notesStore || f.notesStore, emailNote: '',
  });
}
// The status card for one unit: from its id to the next card's spine/end.
function card(html, id) {
  const i = html.indexOf('<b>' + id + '</b>');
  const end = html.indexOf('&#9660; DOWN', html.indexOf('TIMELINE', i));
  return html.slice(i, end > -1 ? end : html.indexOf('UPTAKE INSIGHTS'));
}
function garage(c) { return c.slice(c.indexOf('RELAY GARAGE'), c.indexOf('TIMELINE')); }
function label(offset) { return fx.fmtDate(offset).replace(/, \d{4}$/, ''); }
// Independent calendar-day difference (local midnights) for a raw "Mon DD, YYYY".
function daysPast(raw) {
  const d = new Date(raw); d.setHours(0, 0, 0, 0);
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((t - d) / 86400000);
}

beforeEach(() => {
  store.save('emailLastSnapshot', {});
  store.save('fleetData', { rows: fx.fld.fleetRows() });
});

describe('(a) status/case meta line', () => {
  it('sits in its own full-width, word-wrapping row above the Relay Garage / Timeline row', () => {
    const c = card(build(fx.fld), 'FLD260703');
    const s = c.indexOf('Appointment scheduled');
    const tdStart = c.lastIndexOf('<td', s);
    const td = c.slice(tdStart, c.indexOf('>', tdStart) + 1);
    expect(td).toContain('colspan="2"');
    expect(td).toContain('width="100%"');
    expect(td).toContain('word-wrap:break-word');
    expect(td).toContain('word-break:break-word');
    const tdEnd = c.indexOf('</td></tr></table>', s);
    const metaCell = c.slice(s, tdEnd);
    for (const href of ['https://aap.example.com/v2/service/0918f605', 'https://dtna.example.com/case/500gx000003O1', 'https://sf.example.com/case/00036143']) {
      expect(metaCell).toContain('href="' + href + '"');
    }
    expect(metaCell).toContain('amz-vvfnvm6rhep2et');
    expect(metaCell).not.toContain('RELAY GARAGE');
    // The Relay Garage / Timeline row is a separate table after the meta row closes.
    const rg = c.indexOf('RELAY GARAGE');
    expect(tdEnd).toBeGreaterThan(-1);
    expect(rg).toBeGreaterThan(tdEnd);
    expect(c.slice(tdEnd, rg)).toContain('<table');
    // Header cell (unit id / where) no longer carries the meta line.
    const header62 = c.slice(0, c.indexOf('width="38%"'));
    expect(header62.length).toBeGreaterThan(0);
    expect(header62).not.toContain('Appointment scheduled');
  });
});

describe('(b) Relay Garage', () => {
  it('non-offsite down unit with data shows vendor, issue summary and last update', () => {
    const g = garage(card(build(fx.fld), 'FLD260703'));
    expect(g).toContain('<b>Freightliner (DAIMLER)</b>');
    expect(g).toContain('Parking/door sensor malfunctioning and generating false alerts');
    expect(g).toContain('Last update:');
    expect(g).toContain('Kenworth Northeast Group confirmed diagnosis');
    expect(g).toContain('Down: 1d 12h 38m');
    expect(g).toContain('\uD83D\uDCCD ABE40');
    expect(g).not.toContain('\u2014');
  });
  it('vendor + issue without a timeline still renders; no data at all renders "—"', () => {
    const html = build(fx.fld);
    const g10 = garage(card(html, 'FLD300010'));
    expect(g10).toContain('<b>COX</b>');
    expect(g10).toContain('Mirror bracket cracked');
    expect(g10).not.toContain('Last update:');
    const g11 = garage(card(html, 'FLD300011'));
    expect(g11).toContain('\u2014');
    expect(g11).not.toContain('Down:');
  });
});

describe('(c) PM & DOT chips match the raw due dates', () => {
  it('overdue days from raw dates, due-soon within 60 days, store rows used when units lack raw fields', () => {
    const html = build(fx.fld);
    expect(daysPast(fx.fmtDate(-9))).toBe(9);
    expect(html).toContain('FLD300001 &#183; PM-B ' + daysPast(fx.fmtDate(-9)) + 'd over');
    expect(html).toContain('FLD300003 &#183; DOT 4d over');
    expect(html).toContain('FLD300003 &#183; PM-X overdue');
    expect(html).toContain('FLD300002 &#183; DOT ' + label(25));
    expect(html).toContain('FLD300004 &#183; PM-B ' + label(30));
    expect(html).toContain('FLD300005 &#183; PM-X ' + label(60));
    expect(html).not.toContain('FLD300005 &#183; DOT');
    expect(html).not.toContain('FLD260703 &#183;');
    expect(html).toContain('3 overdue, 3 due soon');
  });
});

describe('(d)/(e) render-time redaction', () => {
  it('no dollar amount anywhere in the HTML', () => {
    const html = build(fx.fld);
    expect(html).not.toMatch(/\$\s?\d/);
    expect(html).not.toContain('$');
  });
  it('personal names removed, vendor/company names kept', () => {
    const html = build(fx.fld);
    for (const n of fx.fld.names) expect(html, n).not.toContain(n);
    for (const org of ['Freightliner (DAIMLER)', 'DTNA', 'Berman Truck Group (Leesport, PA)', 'Kenworth Northeast Group', 'COX', '00036143', 'amz-vvfnvm6rhep2et']) {
      expect(html, org).toContain(org);
    }
  });
});

describe('redactForEmail on live-data shapes', () => {
  const { redactForEmail, redactForSharing } = require('../src/orcha/redact_sharing');
  it('keeps hyphenated words, reference numbers and shop names; strips names and $', () => {
    const keep = [
      'ETC pending. Follow-up pending.',
      'No confirmation that PM-B was added. PM-B due.',
      'Order #3010287243, ordered 11/12.',
      "11/12 - Complaint logged to Bergey's Truck Centers - Pennsauken (Volvo) via portal.",
      'New work order created. Requested Amerit send a tech.',
      'Two TA locations declined.',
    ];
    for (const s of keep) expect(redactForEmail(s), s).toBe(s);
    expect(redactForEmail('Estimate total $8,735.97 (per Uptime Center email 10/29)')).toBe('Estimate total (per Uptime Center email 10/29)');
    expect(redactForEmail('Approved (per Z Santiago email 11/16)')).toBe('Approved (per email 11/16)');
    expect(redactForEmail('Pending (per Santiago, Z email 10/27)')).toBe('Pending (per email 10/27)');
    expect(redactForEmail('EST \\$2,340.00 and $2.5K threshold')).not.toContain('$');
  });
  it('redactForSharing behavior is unchanged', () => {
    expect(redactForSharing('Christy Adriaansen - Kenworth Northeast Group (Service Advisor)')).toBe('Kenworth Northeast Group (Service Advisor)');
  });
});

describe('(f) stored data is not mutated', () => {
  it('notes store and units still contain the $ amounts and names after rendering', () => {
    const units = fx.fld.units;
    const notesStore = JSON.parse(JSON.stringify(fx.fld.notesStore));
    const before = JSON.stringify({ units, notesStore });
    build(fx.fld, units, notesStore);
    expect(JSON.stringify({ units, notesStore })).toBe(before);
    expect(notesStore.FLD260703.timeline).toBe(fx.FLD_TIMELINE);
    expect(notesStore.FLD260703.timeline).toContain('$1,284.50');
    expect(notesStore.FLD260703.timeline).toContain('Tiberius Blackshear');
    expect(notesStore.FLD260703.issueSummary).toContain('$640.00');
    expect(units.find(u => u.id === 'FLD300010').issue).toContain('Jane Doe');
  });
});

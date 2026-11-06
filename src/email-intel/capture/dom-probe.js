'use strict';
/**
 * email-intel/capture/dom-probe.js — read-only DOM probe for the live checks (design 9, audit 15).
 *
 *   domProbe({ n, folder, _electron, _warm, _sleep, now }) -> { ok, authBlocked, probeId, rows, messages, tz, selectors }
 *   consumeTzProbe(probeId, now) -> { ok:true } | { ok:false, code }
 *
 * Opens up to `n` (1..5) messages in the hidden window and returns what the collectors found, with
 * every value truncated and every address masked to `a***@domain`. It evaluates reads only (the
 * same row-open click the reader uses) and returns NO message body text. The P-TZ comparison checks
 * the explicit instant OWA exposes (a datetime attribute with an offset) against the wall-clock text
 * shown next to it interpreted in the machine zone; `tz.match === true` is the only way
 * `emailIntel:set-tz-verified` can set mailboxTzVerified (F-27).
 */
const crypto = require('crypto');
const C = require('../constants');
const { maskAddress } = require('../redact');
const { openSession } = require('./owa_capture');
const ps = require('./page-scripts');
const { parseSnapshot } = require('./parse-snapshot');
const { parseReceived } = require('./received-time');

const PROBE_TTL_MS = 10 * 60_000;
const TZ_TOLERANCE_MS = 2 * 60_000;
let _last = null;   // { probeId, at, match }

const trunc = (s, n) => String(s == null ? '' : s).slice(0, n);

function _tzCompare(snapshot, now) {
  const pairs = [];
  for (const b of Array.isArray(snapshot && snapshot.blocks) ? snapshot.blocks : []) {
    const tc = Array.isArray(b.timeCandidates) ? b.timeCandidates : [];
    for (const t of tc) {
      const exact = parseReceived(t.datetime, { now });
      if (!exact.iso || !exact.zoneExplicit) continue;
      const wallRaw = t.title || t.aria || t.text;
      const wall = parseReceived(wallRaw, { now });
      if (!wall.iso || wall.precision === 'day' || wall.quality === 'inferred-today') continue;
      pairs.push(Math.abs(Date.parse(exact.iso) - Date.parse(wall.iso)));
    }
  }
  if (!pairs.length) return { compared: 0, match: null };
  return { compared: pairs.length, match: pairs.every((d) => d <= TZ_TOLERANCE_MS), maxDiffMinutes: Math.round(Math.max(...pairs) / 60_000) };
}

async function domProbe(opts) {
  opts = opts || {};
  const n = Math.max(1, Math.min(5, Math.trunc(Number(opts.n)) || 1));
  const folder = opts.folder || 'Inbox';
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const out = { ok: false, authBlocked: false, probeId: null, rows: [], messages: [], tz: { compared: 0, match: null }, selectors: {} };

  const driver = async (ctx) => {
    const sel = await ctx.selectFolder(folder);
    if (sel === 'not-found') { out.error = 'folder-not-found'; return; }
    if (!(await ctx.waitFor(ps.ROW_SELECTOR, 30, 1000))) { out.error = 'no-rows'; return; }
    await ctx.sleep(1200);
    const j = await ctx.execJson(ps.buildRowCollector({ max: 20, scrollPages: 0 }));
    const rows = j && Array.isArray(j.rows) ? j.rows : [];
    out.selectors = { rowCount: rows.length, withConvId: rows.filter((r) => r.convId).length, withAttach: rows.filter((r) => r.hasAttach).length };
    out.rows = rows.slice(0, 5).map((r) => ({ index: r.index, hasConvId: !!r.convId, hasAttach: !!r.hasAttach, unread: !!r.unread, timeToken: trunc(r.timeTokenRaw, 40), ariaLen: String(r.aria || '').length }));
    let tz = { compared: 0, match: null }; let maxDiff = 0; let all = true; let compared = 0;
    for (const row of rows.slice(0, n)) {
      if (!ctx.alive() || ctx.stopped()) break;
      const o = await ctx.execJson(ps.buildOpenRowScript({ convId: row.convId, ariaKey: row.aria }));
      if (!o || o.status !== 'opened') { out.messages.push({ index: row.index, opened: false }); continue; }
      await ctx.sleep(C.OPEN_WAIT_MS);
      const snap = await ctx.execJson(ps.buildPaneCollector({ maxBlocks: C.MAX_PANE_BLOCKS, rawCap: 2000 }));
      const parsed = parseSnapshot(snap, row, now, { folder });
      const t = _tzCompare(snap, now);
      if (t.compared) { compared += t.compared; all = all && t.match; maxDiff = Math.max(maxDiff, t.maxDiffMinutes || 0); }
      out.messages.push({
        index: row.index, opened: true, blocks: Array.isArray(snap && snap.blocks) ? snap.blocks.length : 0, paneFallback: !!(snap && snap.paneFallback),
        buttons: (snap && snap.buttons || []).slice(0, 6).map((b) => trunc(b, 30)),
        captures: parsed.captures.map((c) => ({
          bodyStatus: c.bodyStatus, textLen: c.textLen, fromQuality: c.from && c.from.quality, from: c.from && c.from.address ? maskAddress(c.from.address) : null,
          toCount: c.toCount, ccCount: c.ccCount, recipientsKnown: c.recipientsKnown,
          to: (c.to || []).slice(0, 3).map((r) => (r.address ? maskAddress(r.address) : '[name]')),
          receivedAtQuality: c.receivedAtQuality, receivedAtRaw: trunc(c.receivedAtRaw, 40), itemIdPresent: !!c.itemId, convIdPresent: c.convIdSource === 'owa',
          attachments: (c.attachments || []).slice(0, 5).map((a) => ({ ext: a.ext || '', named: !!a.name, sizeBytes: a.sizeBytes })),
        })),
      });
    }
    tz = compared ? { compared, match: all, maxDiffMinutes: maxDiff } : { compared: 0, match: null };
    out.tz = tz;
  };

  const session = await openSession(Object.assign({}, opts, { timeoutMs: opts.timeoutMs || 120_000 }), driver);
  const st = session.settled;
  out.authBlocked = !!st.authBlocked;
  out.ok = !st.authBlocked && !out.error && out.rows.length > 0;
  if (out.ok) {
    out.probeId = 'pr_' + crypto.randomBytes(8).toString('hex');
    _last = { probeId: out.probeId, at: now, match: out.tz.match === true };
  }
  return out;
}

/** consumeTzProbe(probeId, now): valid only for the latest probe, under 10 minutes old, with tz.match === true. */
function consumeTzProbe(probeId, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  if (!_last || _last.probeId !== probeId) return { ok: false, code: 'PROBE_UNKNOWN' };
  if (t - _last.at > PROBE_TTL_MS) return { ok: false, code: 'PROBE_EXPIRED' };
  if (_last.match !== true) return { ok: false, code: 'TZ_MISMATCH' };
  _last = null;
  return { ok: true };
}

function _setLastForTests(v) { _last = v; }

module.exports = { domProbe, consumeTzProbe, PROBE_TTL_MS, _setLastForTests };

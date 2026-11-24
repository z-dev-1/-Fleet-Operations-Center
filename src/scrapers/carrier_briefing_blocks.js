'use strict';
/**
 * carrier_briefing_blocks.js — pure Block Kit renderer for the Daily Carrier
 * Briefing. No store / AI / Slack I/O: it turns pre-gathered, PRE-REDACTED
 * facts (carrier_briefing.gatherOperatorFacts) into the approved layout.
 *
 * Audience is external carrier partners, posted with a xoxc- USER token:
 *  - static layout only (no interactive components); the only URL ever
 *    emitted is ctx.contactUrl on the optional "Questions? Message Z" button;
 *  - unit IDs are plain bold text (no Relay/AAP deep-links);
 *  - <= 50 blocks, <= 40k JSON chars, every mrkdwn text <= 3000 chars.
 *
 * Input contract:
 *  facts: { operator, totalUnits, downCount,
 *           down: [{ unit, daysDown, vendor, issue, estimateLabel, etcIso,
 *                    etcState, nextStep, severity:'red'|'yellow'|'white',
 *                    needsAction, actionText }],
 *           pmDue: [{ unit, items: [{ type, label, dueIso, dueLabel, days }] }],
 *           domiciles: [{ code, location }],
 *           tireActions?: [{ unit, actionText, id? }] }  (approved, carrier-redacted Aperia
 *             underinflation items; listed first under "Needs your action" only when
 *             non-empty; renderedTireActions(facts, ctx) returns the ones that fit)
 *  ctx:   { todayIso, dateLabel, updatedLabel, ownerTag, tip, contactUrl,
 *           testPreviewChannelId, includeDown, includeDomiciles }
 */

const MAX_BLOCKS = 50;
const MAX_JSON_CHARS = 40000;
const MAX_UNIT_ROWS = 30;
const MAX_TEXT = 2900;            // per mrkdwn text (Slack hard cap is 3000)
const PM_TYPES = ['PM_B', 'DOT', 'PM_X', 'QUARTERLY_LIFT'];
const PM_WINDOW_DAYS = 60;
const PM_LABELS = { PM_B: 'PM-B', DOT: 'DOT', PM_X: 'PM-X', QUARTERLY_LIFT: 'Quarterly Lift' };
const DOTS = { red: '🔴', yellow: '🟡', white: '⚪' };
const SEV_RANK = { red: 0, yellow: 1, white: 2 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Slack mrkdwn control characters in free text.
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}
function fmtShortDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const mo = Number(m[2]) - 1;
  return mo >= 0 && mo < 12 ? MONTHS[mo] + ' ' + Number(m[3]) : '';
}
function severityDot(sev) { return DOTS[sev] || DOTS.white; }

const mrkSection = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const divider = () => ({ type: 'divider' });
const context = (texts) => ({ type: 'context', elements: texts.map((t) => ({ type: 'mrkdwn', text: t })) });

// Join `items` with `sep` after `prefix`, stopping before `max` chars and
// naming how many were left out ("and N others").
function joinWithin(prefix, items, sep, max) { return _fit(prefix, items, sep, max).text; }
// Same as joinWithin, plus `shown` = how many leading items made it in.
function _fit(prefix, items, sep, max) {
  let out = prefix;
  for (let i = 0; i < items.length; i++) {
    const piece = (i ? sep : '') + items[i];
    const after = items.length - i - 1;
    const reserve = after ? (sep + 'and ' + after + ' others').length : 0;
    if ((out + piece).length + reserve > max) return { text: out + (i ? sep : '') + 'and ' + (items.length - i) + ' others', shown: i };
    out += piece;
  }
  return { text: out, shown: items.length };
}

// "Needs your action" lines. Approved Aperia tire items go FIRST so the
// 2900-char cap truncates down-unit lines before them.
function _actionLines(facts, action) {
  const tires = Array.isArray(facts.tireActions) ? facts.tireActions : [];
  const tireLines = tires.map((t) => '• *' + esc(t.unit) + '* — 🛞 ' + esc(clip(t.actionText, 300)));
  const downLines = action.map((d) => '• ' + _shortRef(d) + (d.actionText ? ' — ' + esc(clip(d.actionText, 160)) : ''));
  return { tires, lines: tireLines.concat(downLines) };
}

// The facts.tireActions entries that buildBriefingBlocks(facts, ctx) actually
// renders: [] when includeDown is off, and only the lines before any
// "and N others" truncation. Callers mark only these as sent.
function renderedTireActions(facts, ctx) {
  facts = facts || {};
  ctx = ctx || {};
  if (ctx.includeDown === false) return [];
  const action = _sortDown(Array.isArray(facts.down) ? facts.down : []).filter((d) => d.needsAction);
  const { tires, lines } = _actionLines(facts, action);
  if (!tires.length) return [];
  const { shown } = _fit('⚠️ *Needs your action*\n', lines, '\n', MAX_TEXT);
  return tires.slice(0, Math.min(shown, tires.length));
}

function _sortDown(down) {
  return down.slice().sort((a, b) =>
    (SEV_RANK[a.severity] ?? 2) - (SEV_RANK[b.severity] ?? 2)
    || (Number(b.daysDown) || 0) - (Number(a.daysDown) || 0)
    || String(a.unit).localeCompare(String(b.unit)));
}

function _daysPart(d) { return Number.isFinite(d.daysDown) ? d.daysDown + 'd' : ''; }

function _etcPart(d, todayIso) {
  if (d.etcIso) {
    const lbl = fmtShortDate(d.etcIso);
    if (todayIso && d.etcIso < todayIso) return '*ETC missed (' + lbl + ')*';
    if (todayIso && d.etcIso === todayIso) return '*ETC today (' + lbl + ')*';
    return '*ETC ' + lbl + '*';
  }
  if (d.etcState === 'today') return '*ETC today*';
  return '*No ETC*';
}

function _unitSection(d, todayIso) {
  const l1 = [severityDot(d.severity) + ' *' + esc(d.unit) + '*', _daysPart(d), esc(d.vendor || '')].filter(Boolean).join(' · ');
  const l2 = [esc(d.issue || ''), esc(d.estimateLabel || '')].filter(Boolean).join(' · ') || '_No update on file_';
  const l3 = _etcPart(d, todayIso) + (d.nextStep ? ' · next: ' + esc(d.nextStep) : '');
  return mrkSection(clip(l1, 600) + '\n' + clip(l2, 600) + '\n' + clip(l3, 600));
}

function _shortRef(d) {
  const meta = [_daysPart(d), esc(d.vendor || '')].filter(Boolean).join(', ');
  return '*' + esc(d.unit) + '*' + (meta ? ' (' + meta + ')' : '');
}

// pmBuckets(pmDue, todayIso?) -> { red:[{unit,items,min}], yellow:[], white:[] }
// Only PM-B / DOT / PM-X / Quarterly Lift, overdue or due within 60 days.
function pmBuckets(pmDue) {
  const out = { red: [], yellow: [], white: [] };
  for (const u of Array.isArray(pmDue) ? pmDue : []) {
    if (!u || !u.unit) continue;
    const items = (Array.isArray(u.items) ? u.items : [])
      .filter((it) => it && PM_TYPES.includes(it.type) && Number.isFinite(it.days) && it.days <= PM_WINDOW_DAYS)
      .sort((a, b) => a.days - b.days);
    if (!items.length) continue;
    const min = items[0].days;
    const key = min < 0 ? 'red' : (min <= 30 ? 'yellow' : 'white');
    out[key].push({ unit: u.unit, items, min });
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.min - b.min || String(a.unit).localeCompare(String(b.unit)));
  return out;
}

function _pmItemText(it) {
  const label = PM_LABELS[it.type] || it.type;
  const when = it.dueLabel || fmtShortDate(it.dueIso);
  if (it.days < 0) return it.type === 'DOT' ? label + ' expired ' + when : label + ' overdue ' + (-it.days) + 'd';
  return label + ' due ' + when + ' (' + (it.days === 0 ? 'today' : it.days + 'd') + ')';
}

const PM_GROUPS = [
  ['red', '🔴 *Overdue / expired*'],
  ['yellow', '🟡 *Due in ≤30 days*'],
  ['white', '⚪ *Due in 31–60 days*'],
];

function _pmSections(pmDue) {
  const b = pmBuckets(pmDue);
  const groups = PM_GROUPS.filter(([k]) => b[k].length).map(([k, title]) => ({
    title, lines: b[k].map((u) => '• *' + esc(u.unit) + '* — ' + u.items.map(_pmItemText).join(' · ')),
  }));
  const count = b.red.length + b.yellow.length + b.white.length;
  if (!groups.length) return { blocks: [mrkSection('_Nothing overdue or due in the next 60 days._')], count };
  const whole = groups.map((g) => g.title + '\n' + g.lines.join('\n')).join('\n\n');
  if (whole.length <= MAX_TEXT) return { blocks: [mrkSection(whole)], count };
  return { blocks: groups.map((g) => mrkSection(joinWithin(g.title + '\n', g.lines, '\n', MAX_TEXT))), count };
}

function _stats(facts, todayIso) {
  const total = Number(facts.totalUnits) || 0;
  const down = Array.isArray(facts.down) ? facts.down : [];
  const downN = Number.isFinite(facts.downCount) ? facts.downCount : down.length;
  const uptime = total ? Math.round(((total - downN) / total) * 100) : 100;
  const etcToday = down.filter((d) => (todayIso && d.etcIso === todayIso) || (!d.etcIso && d.etcState === 'today')).length;
  const noEtc = down.filter((d) => !d.etcIso && d.etcState !== 'today').length;
  return { total, downN, uptime, etcToday, noEtc };
}

function buildBriefingBlocks(facts, ctx) {
  facts = facts || {};
  ctx = ctx || {};
  const todayIso = ctx.todayIso || '';
  const includeDown = ctx.includeDown !== false;
  const s = _stats(facts, todayIso);

  // ── Top: header, (test marker), context, one-line stats ──
  const top = [{ type: 'header', text: { type: 'plain_text', text: clip('🚛 Daily Fleet Briefing — ' + (facts.operator || ''), 150), emoji: true } }];
  if (ctx.testPreviewChannelId) top.push(context(['🧪 *TEST preview* — this would post to <#' + ctx.testPreviewChannelId + '>']));
  const ctxParts = [];
  if (ctx.dateLabel) ctxParts.push(esc(ctx.dateLabel));
  if (ctx.includeDomiciles !== false && Array.isArray(facts.domiciles) && facts.domiciles.length) {
    ctxParts.push(esc(facts.domiciles.map((d) => (d.location ? d.code + ' (' + d.location + ')' : d.code)).join(', ')));
  }
  if (ctx.updatedLabel) ctxParts.push('updated ' + esc(ctx.updatedLabel));
  const ctxEls = [];
  if (ctx.ownerTag) ctxEls.push(ctx.ownerTag);
  if (ctxParts.length) ctxEls.push(clip(ctxParts.join(' · '), MAX_TEXT));
  if (ctxEls.length) top.push(context(ctxEls));
  top.push(mrkSection('*Uptime* ' + s.uptime + '%   |   *Down* ' + s.downN + '/' + s.total +
    '   |   *ETC today* ' + s.etcToday + '   |   *No ETC* ' + s.noEtc));

  // ── Down units + needs-your-action ──
  const all = _sortDown(Array.isArray(facts.down) ? facts.down : []);
  const listed = all.filter((d) => !d.needsAction);
  const action = all.filter((d) => d.needsAction);
  let actionBlock = null;
  if (includeDown) {
    const { lines } = _actionLines(facts, action);
    actionBlock = mrkSection(lines.length
      ? joinWithin('⚠️ *Needs your action*\n', lines, '\n', MAX_TEXT)
      : '⚠️ *Needs your action*\n_Nothing needs your action today._');
  }

  // ── PM / DOT ──
  const pm = _pmSections(facts.pmDue);
  const pmHeader = mrkSection('*🔧 PM / DOT — schedule needed* _(PM-B · DOT · PM-X · Quarterly Lift — overdue, expired, or due ≤60 days)_');

  // ── Footer ──
  const footer = [];
  if (ctx.tip) footer.push(context(['💡 ' + esc(clip(ctx.tip, 300))]));
  if (ctx.contactUrl) {
    footer.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Questions? Message Z', emoji: true }, url: ctx.contactUrl }] });
  }

  const assemble = (shown) => {
    const blocks = top.slice();
    blocks.push(divider());
    if (includeDown) {
      blocks.push(mrkSection(listed.length ? '*Units down (' + listed.length + ')*'
        : (action.length ? '*Units down (0)*\n_The down units are under Needs your action below._' : '*Units down (0)*\n✅ All units running.')));
      listed.slice(0, shown).forEach((d) => blocks.push(_unitSection(d, todayIso)));
      const rest = listed.slice(shown);
      if (rest.length) {
        blocks.push(context([joinWithin('➕ ' + rest.length + ' more down units: ', rest.map(_shortRef), ' · ', MAX_TEXT)]));
      }
      blocks.push(divider());
      blocks.push(actionBlock);
      blocks.push(divider());
    }
    blocks.push(pmHeader);
    pm.blocks.forEach((b) => blocks.push(b));
    footer.forEach((b) => blocks.push(b));
    return blocks;
  };

  // Show every unit when it fits; otherwise cap rows and name the rest.
  let shown = listed.length;
  let blocks = assemble(shown);
  if (shown > MAX_UNIT_ROWS || blocks.length > MAX_BLOCKS) {
    // assemble(0) already carries the overflow context line.
    shown = Math.max(0, Math.min(MAX_UNIT_ROWS, MAX_BLOCKS - assemble(0).length));
    blocks = assemble(shown);
  }
  while (shown > 0 && (blocks.length > MAX_BLOCKS || JSON.stringify(blocks).length > MAX_JSON_CHARS)) blocks = assemble(--shown);
  return blocks;
}

// Concise plain-text fallback (notification / accessibility text). Counts and
// unit IDs only — nothing that needs redaction beyond what facts already are.
function buildBriefingText(facts, ctx) {
  facts = facts || {};
  ctx = ctx || {};
  const s = _stats(facts, ctx.todayIso || '');
  const action = (Array.isArray(facts.down) ? facts.down : []).filter((d) => d.needsAction).length
    + (Array.isArray(facts.tireActions) ? facts.tireActions.length : 0);
  const b = pmBuckets(facts.pmDue);
  const pmN = b.red.length + b.yellow.length + b.white.length;
  let t = (ctx.ownerTag ? ctx.ownerTag + ' ' : '') + '🚛 Daily Fleet Briefing — ' + (facts.operator || '') +
    (ctx.dateLabel ? ' · ' + ctx.dateLabel : '') +
    ' — Uptime ' + s.uptime + '% · Down ' + s.downN + '/' + s.total + ' · ETC today ' + s.etcToday + ' · No ETC ' + s.noEtc;
  if (ctx.includeDown !== false && action) t += ' · ' + action + ' need' + (action === 1 ? 's' : '') + ' your action';
  if (pmN) t += ' · ' + pmN + ' PM/DOT to schedule';
  if (ctx.testPreviewChannelId) t = 'TEST preview: ' + t;
  return t;
}

module.exports = {
  buildBriefingBlocks,
  buildBriefingText,
  renderedTireActions,
  MAX_BLOCKS,
  MAX_UNIT_ROWS,
  PM_TYPES,
  PM_WINDOW_DAYS,
  __test__: { severityDot, pmBuckets, fmtShortDate, joinWithin },
};

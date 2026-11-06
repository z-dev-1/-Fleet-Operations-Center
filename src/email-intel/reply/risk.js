'use strict';
/**
 * email-intel/reply/risk.js — risky-phrase scan of a reply draft (design 6.2 step 4).
 *
 *   scanRisk(text) -> [{ code, label }]   codes: approval | go-ahead | purchase-order | amount | date-promise
 *
 * The warnings are shown in the confirmation (in-app summary and native dialog); they never block a send:
 * the user decides. Pure: the matched text is never returned or logged, only the code and a fixed label.
 */
const RULES = Object.freeze([
  ['approval', 'mentions approving or authorizing', /\b(approve[sd]?|approving|approval|authori[sz]e[sd]?|authori[sz]ing|authori[sz]ation)\b/i],
  ['go-ahead', 'tells someone to go ahead', /\bgo[\s-]+ahead\b/i],
  ['purchase-order', 'mentions a purchase order', /\b(purchase\s+order|P\.?O\.?)(\b|\s*#)/],
  ['amount', 'mentions a dollar amount', /(\$\s?\d[\d,]*(\.\d+)?|\b\d[\d,]*(\.\d+)?\s?(usd|dollars)\b)/i],
  ['date-promise', 'promises a date or time', /\b(will|we'll|i'll|should)\b[^.!?\n]{0,40}\b(by|on|before|no later than)\s+(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\b(by|before|no later than)\s+(today|tomorrow|tonight|eod|end of (the )?(day|week)|\d{1,2}\/\d{1,2})\b/i],
]);

function scanRisk(text) {
  const t = String(text == null ? '' : text);
  const out = [];
  for (const [code, label, re] of RULES) if (re.test(t)) out.push({ code, label });
  return out;
}

module.exports = { scanRisk, RISK_CODES: RULES.map((r) => r[0]) };

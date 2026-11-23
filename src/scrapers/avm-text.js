'use strict';
/**
 * AVM code -> the text AAP stores on a WR's suggestedItems.
 *
 * The WR modal submits AAP AVM codes (e.g. ELECTRICAL_SYSTEM). AAP stores
 * whatever string it is sent, so we send the display text like the AAP wizard
 * does: the AVM tree's displayName when known, else underscores -> spaces.
 * Tire positions (L2/L3 under a Tires L1) stay as codes, matching the wizard.
 * Pure module: no requires.
 */

const MAX_TYPES = 5;
const _trees = new Map(); // type -> Map(code -> displayName)

function rememberTree(type, tree) {
  if (!tree) return;
  const map = new Map();
  const add = (list) => (Array.isArray(list) ? list : []).forEach((n) => {
    if (n && n.code != null && n.displayName != null) map.set(String(n.code), String(n.displayName));
  });
  add(tree.l1);
  Object.values(tree.l2ByParent || {}).forEach(add);
  Object.values(tree.l3ByParent || {}).forEach(add);
  const key = String(type || '');
  _trees.delete(key);
  _trees.set(key, map);
  while (_trees.size > MAX_TYPES) _trees.delete(_trees.keys().next().value);
}

function _display(code) {
  const types = Array.from(_trees.values()).reverse();
  for (const m of types) {
    if (m.has(code)) {
      const d = m.get(code).trim();
      if (d && d !== code) return d;
    }
  }
  return null;
}

function levelText(value, { level1, isSub } = {}) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (isSub && /tire/i.test(String(level1 ?? ''))) return s;
  const d = _display(s);
  if (d) return d;
  return s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function suggestedItemsFrom(areaPairs) {
  return (areaPairs || [])
    .filter((p) => p && (p.area || p.subcategory))
    .map((p) => ({
      level1: levelText(p.area),
      level2: levelText(p.subcategory, { level1: p.area, isSub: true }),
      level3: levelText(p.subSubcategory, { level1: p.area, isSub: true }),
    }));
}

function _resetForTests() { _trees.clear(); }

module.exports = { rememberTree, levelText, suggestedItemsFrom, _resetForTests };

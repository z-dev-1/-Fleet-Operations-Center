// tests/wr-tow-title-direction.test.js
//
// Regression coverage for the backwards TOW title bug: the user types
// "Unit needs to be towed back from dealer to home site" and the WR title
// came out "TOW 39582 to M&K Truck Centers - Scranton" when it should be
// "TOW 39582 from M&K Truck Centers - Scranton to AVP40". Root cause was a
// hardcoded "TOW <unit> to <dealer>" template in _buildTabSnapshots that
// ignored the AI-parsed towDirection.
//
// Per this project's convention (see wr-modal-ai-assist-fix.test.js), the
// pure title logic is MIRRORED here rather than importing the renderer
// module. This mirror must stay in sync with _buildTowTitle in
// renderer/src/js/views/wr-modal.js.
import { describe, it, expect } from 'vitest';

function _buildTowTitle(unit, plan, dealerName) {
  const eq = (unit && (unit.equipmentId || unit.id)) || '';
  const dir = (plan && plan.towDirection) || 'to-dealer';
  const homeYard = (plan && plan.towDestName) || (unit && (unit.domicileSite || unit.site)) || '';
  const pickup = (plan && plan.towPickupName) || dealerName || '';
  const dest = (plan && plan.towDestName) || '';
  let title;
  if (dir === 'return-to-yard') {
    const from = pickup || dealerName || 'dealer';
    const to = homeYard || 'home yard';
    title = 'TOW ' + eq + ' from ' + from + ' to ' + to;
  } else if (dir === 'yard-to-yard') {
    const from = pickup || 'yard';
    const to = dest || homeYard || 'yard';
    title = 'TOW ' + eq + ' from ' + from + ' to ' + to;
  } else {
    title = 'TOW ' + eq + ' to ' + (dealerName || dest || 'dealer');
  }
  return title.replace(/\s{2,}/g, ' ').trim().slice(0, 90);
}

describe('_buildTowTitle direction', () => {
  const unit = { equipmentId: '39582', site: 'AVP40' };

  it('return-from-dealer reads "from <dealer> to <home yard>" (the reported bug)', () => {
    const plan = {
      towDirection: 'return-to-yard',
      towPickupName: 'M&K Truck Centers - Scranton',
      towDestName: 'AVP40',
    };
    expect(_buildTowTitle(unit, plan, 'M&K Truck Centers - Scranton'))
      .toBe('TOW 39582 from M&K Truck Centers - Scranton to AVP40');
  });

  it('return-from-dealer falls back to the unit domicile when destination name missing', () => {
    const plan = { towDirection: 'return-to-yard', towPickupName: 'M&K Truck Centers - Scranton', towDestName: '' };
    expect(_buildTowTitle(unit, plan, 'M&K Truck Centers - Scranton'))
      .toBe('TOW 39582 from M&K Truck Centers - Scranton to AVP40');
  });

  it('to-dealer reads "to <dealer>"', () => {
    const plan = { towDirection: 'to-dealer', towPickupName: 'AVP40', towDestName: 'Gabrielli Bloomsbury' };
    expect(_buildTowTitle(unit, plan, 'Gabrielli Bloomsbury'))
      .toBe('TOW 39582 to Gabrielli Bloomsbury');
  });

  it('yard-to-yard reads "from <origin> to <destination>"', () => {
    const plan = { towDirection: 'yard-to-yard', towPickupName: 'ABE40', towDestName: 'PHL40' };
    expect(_buildTowTitle(unit, plan, '')).toBe('TOW 39582 from ABE40 to PHL40');
  });

  it('defaults to to-dealer when direction is unset', () => {
    expect(_buildTowTitle(unit, { towDirection: '' }, 'M&K Truck Centers'))
      .toBe('TOW 39582 to M&K Truck Centers');
  });

  it('caps at 90 characters', () => {
    const longDealer = 'A'.repeat(120);
    expect(_buildTowTitle(unit, { towDirection: 'to-dealer' }, longDealer).length).toBeLessThanOrEqual(90);
  });
});

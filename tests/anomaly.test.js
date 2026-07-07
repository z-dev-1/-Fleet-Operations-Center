import { describe, it, expect } from 'vitest';

// Test anomaly detection logic (isolated from module)
function detectNoVendor(row) {
  if (!(row.lifecycleState || '').toLowerCase().includes('unavail')) return null;
  const vendor = (row.vendor || '').trim();
  if (vendor && vendor !== '--') return null;
  return { severity: 'critical', unit: row.equipmentId, type: 'no_vendor' };
}

function detectETCPassed(row) {
  if (!(row.lifecycleState || '').toLowerCase().includes('unavail')) return null;
  const etc = row.etc || '';
  if (!etc) return null;
  const etcDate = new Date(etc);
  if (isNaN(etcDate.getTime())) return null;
  if (etcDate > new Date()) return null;
  return { severity: 'warning', unit: row.equipmentId, type: 'etc_passed' };
}

describe('Anomaly Detection', () => {
  it('should flag unavailable unit with no vendor', () => {
    const row = { equipmentId: 'B62148', lifecycleState: 'Unavailable', vendor: '' };
    const alert = detectNoVendor(row);
    expect(alert).not.toBeNull();
    expect(alert.severity).toBe('critical');
    expect(alert.unit).toBe('B62148');
  });

  it('should NOT flag available unit with no vendor', () => {
    const row = { equipmentId: 'B62148', lifecycleState: 'Available', vendor: '' };
    const alert = detectNoVendor(row);
    expect(alert).toBeNull();
  });

  it('should NOT flag unavailable unit WITH vendor', () => {
    const row = { equipmentId: '322472', lifecycleState: 'Unavailable', vendor: 'Amerit' };
    const alert = detectNoVendor(row);
    expect(alert).toBeNull();
  });

  it('should flag ETC passed', () => {
    const row = { equipmentId: '39309', lifecycleState: 'Unavailable', etc: '2026-07-01' };
    const alert = detectETCPassed(row);
    expect(alert).not.toBeNull();
    expect(alert.type).toBe('etc_passed');
  });

  it('should NOT flag ETC in the future', () => {
    const row = { equipmentId: '39309', lifecycleState: 'Unavailable', etc: '2027-01-01' };
    const alert = detectETCPassed(row);
    expect(alert).toBeNull();
  });
});

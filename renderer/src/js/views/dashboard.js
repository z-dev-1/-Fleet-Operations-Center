/**
 * dashboard.js — Fleet Operations Dashboard View
 *
 * Single-screen overview with:
 *   - KPI cards (total, unavail, available, high-risk, avg days down)
 *   - Units by status (pie/donut chart)
 *   - Risk distribution (bar chart)
 *   - Vendor workload (horizontal bar chart)
 *   - Recent activity feed
 *
 * All charts rendered with inline SVG — no external chart library needed.
 */

import bus   from '../bus.js';
import state from '../state.js';

let _container = null;
let _mounted   = false;

export function init(container) {
  const el = document.createElement('div');
  el.id = 'view-dashboard';
  el.className = 'view view--dashboard';
  el.style.cssText = 'display:flex;flex-direction:column;flex:1;overflow-y:auto;padding:16px 20px;gap:16px;';
  container.appendChild(el);
  _container = el;
  _mounted = true;

  // Render on fleet data updates
  bus.on('state:fleet', () => _render());

  // Initial render from current state
  setTimeout(() => _render(), 500);
}

function _render() {
  if (!_container || !_mounted) return;
  const fleet = state.slice('fleet');
  const rows  = fleet.rows || [];

  if (!rows.length) {
    _container.innerHTML = '<div style="text-align:center;color:var(--mut);padding:40px;font-size:12px;">Waiting for fleet data...</div>';
    return;
  }

  const unavail   = rows.filter(r => (r.lifecycleState || '').toLowerCase().includes('unavail'));
  const avail     = rows.filter(r => !(r.lifecycleState || '').toLowerCase().includes('unavail'));
  const offsite   = unavail.filter(r => (r.lifecycleReason || '').toLowerCase().includes('offsite'));
  const highRisk  = rows.filter(r => (r.riskScore || 0) >= 70);
  const medRisk   = rows.filter(r => (r.riskScore || 0) >= 40 && (r.riskScore || 0) < 70);
  const lowRisk   = rows.filter(r => (r.riskScore || 0) > 0 && (r.riskScore || 0) < 40);
  const noRisk    = rows.filter(r => !(r.riskScore || 0));

  // Avg days down
  const avgDays = unavail.length
    ? (unavail.reduce((sum, u) => sum + _parseDays(u.workDuration || u.duration), 0) / unavail.length).toFixed(1)
    : '0';

  // Vendor workload
  const vendorMap = {};
  unavail.forEach(u => {
    const v = u.vendor || 'Unassigned';
    vendorMap[v] = (vendorMap[v] || 0) + 1;
  });
  const vendorSorted = Object.entries(vendorMap).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const maxVendor = vendorSorted.length ? vendorSorted[0][1] : 1;

  // Body type breakdown
  const bodyMap = {};
  rows.forEach(r => { const bt = r.bodyType || r.assetType || 'Unknown'; bodyMap[bt] = (bodyMap[bt] || 0) + 1; });

  const syncedStr = fleet.syncedAt
    ? new Date(fleet.syncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : 'never';

  let html = '';

  // ── Header ──────────────────────────────────────────────────────────────
  html += '<div style="display:flex;align-items:center;justify-content:space-between;">';
  html += '<div style="font-size:16px;font-weight:800;color:var(--txt);">Fleet Dashboard</div>';
  html += '<div style="font-size:10px;color:var(--mut);">Last sync: ' + syncedStr + (fleet.stale ? ' (stale)' : '') + '</div>';
  html += '</div>';

  // ── KPI Strip ──────────────────────────────────────────────────────────
  html += '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;">';
  html += _kpi('Total Units', rows.length, 'var(--acc)', '📊');
  html += _kpi('Unavailable', unavail.length, 'var(--red)', '🔴');
  html += _kpi('Available', avail.length, 'var(--grn)', '✅');
  html += _kpi('High Risk', highRisk.length, 'var(--org)', '⚠️');
  html += _kpi('Avg Days Down', avgDays, 'var(--ylw)', '⏱️');
  html += '</div>';

  // ── Charts Row ──────────────────────────────────────────────────────────
  html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">';

  // Status donut
  html += '<div style="background:var(--card);border:1px solid var(--bdr);border-radius:10px;padding:14px;">';
  html += '<div style="font-size:10px;font-weight:700;color:var(--mut);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">Units by Status</div>';
  html += _donutChart([
    { label: 'Available', value: avail.length, color: '#7ee787' },
    { label: 'Offsite', value: offsite.length, color: '#ff7b72' },
    { label: 'Other Unavail', value: unavail.length - offsite.length, color: '#ffa657' },
  ]);
  html += '</div>';

  // Risk distribution
  html += '<div style="background:var(--card);border:1px solid var(--bdr);border-radius:10px;padding:14px;">';
  html += '<div style="font-size:10px;font-weight:700;color:var(--mut);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">Risk Distribution</div>';
  html += _barChart([
    { label: 'High (70+)', value: highRisk.length, color: '#ff7b72' },
    { label: 'Medium (40-69)', value: medRisk.length, color: '#ffa657' },
    { label: 'Low (1-39)', value: lowRisk.length, color: '#7ee787' },
    { label: 'No Score', value: noRisk.length, color: '#484f58' },
  ]);
  html += '</div>';

  // Vendor workload
  html += '<div style="background:var(--card);border:1px solid var(--bdr);border-radius:10px;padding:14px;">';
  html += '<div style="font-size:10px;font-weight:700;color:var(--mut);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">Vendor Workload</div>';
  html += '<div style="display:flex;flex-direction:column;gap:6px;">';
  vendorSorted.forEach(([vendor, count]) => {
    const pct = Math.round((count / maxVendor) * 100);
    html += '<div style="display:flex;align-items:center;gap:8px;">';
    html += '<div style="width:80px;font-size:9px;color:var(--txt2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + _esc(vendor) + '">' + _esc(vendor) + '</div>';
    html += '<div style="flex:1;height:6px;background:var(--el);border-radius:3px;overflow:hidden;"><div style="width:' + pct + '%;height:100%;background:var(--acc);border-radius:3px;"></div></div>';
    html += '<div style="width:20px;font-size:10px;font-weight:700;color:var(--txt);text-align:right;">' + count + '</div>';
    html += '</div>';
  });
  if (!vendorSorted.length) html += '<div style="font-size:10px;color:var(--mut);">No unavailable units</div>';
  html += '</div></div>';

  html += '</div>'; // end charts row

  // ── Bottom Row: Longest Down + Recent Changes ──────────────────────────
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">';

  // Longest down units
  html += '<div style="background:var(--card);border:1px solid var(--bdr);border-radius:10px;padding:14px;">';
  html += '<div style="font-size:10px;font-weight:700;color:var(--mut);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">Longest Down</div>';
  const longestDown = unavail
    .map(u => ({ id: u.equipmentId, vendor: u.vendor || '?', days: _parseDays(u.workDuration || u.duration) }))
    .sort((a, b) => b.days - a.days)
    .slice(0, 8);
  longestDown.forEach(u => {
    const dColor = u.days >= 7 ? 'var(--red)' : u.days >= 4 ? 'var(--org)' : 'var(--txt2)';
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;">';
    html += '<span style="font-family:var(--mono);font-size:11px;font-weight:700;color:var(--acc2);width:70px;">' + u.id + '</span>';
    html += '<span style="font-size:10px;color:var(--txt2);flex:1;">' + _esc(u.vendor) + '</span>';
    html += '<span style="font-size:11px;font-weight:700;color:' + dColor + ';">' + u.days + 'd</span>';
    html += '</div>';
  });
  if (!longestDown.length) html += '<div style="font-size:10px;color:var(--mut);">All units available</div>';
  html += '</div>';

  // Site breakdown
  html += '<div style="background:var(--card);border:1px solid var(--bdr);border-radius:10px;padding:14px;">';
  html += '<div style="font-size:10px;font-weight:700;color:var(--mut);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">By Domicile</div>';
  const siteMap = {};
  unavail.forEach(u => { const s = u.domicileSite || u.operator || 'Unknown'; siteMap[s] = (siteMap[s] || 0) + 1; });
  const siteSorted = Object.entries(siteMap).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxSite = siteSorted.length ? siteSorted[0][1] : 1;
  siteSorted.forEach(([site, count]) => {
    const pct = Math.round((count / maxSite) * 100);
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">';
    html += '<div style="width:60px;font-size:9px;font-weight:700;color:var(--txt2);">' + _esc(site) + '</div>';
    html += '<div style="flex:1;height:6px;background:var(--el);border-radius:3px;overflow:hidden;"><div style="width:' + pct + '%;height:100%;background:var(--pur);border-radius:3px;"></div></div>';
    html += '<div style="width:20px;font-size:10px;font-weight:700;color:var(--txt);text-align:right;">' + count + '</div>';
    html += '</div>';
  });
  html += '</div>';

  html += '</div>'; // end bottom row

  _container.innerHTML = html;
}

// ── Chart helpers ─────────────────────────────────────────────────────────────

function _donutChart(segments) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  if (!total) return '<div style="text-align:center;color:var(--mut);font-size:10px;padding:20px;">No data</div>';

  const size = 100;
  const cx = size / 2, cy = size / 2, r = 35;
  let html = '<svg viewBox="0 0 ' + size + ' ' + size + '" style="width:100%;max-width:140px;margin:0 auto;display:block;">';

  let startAngle = -90;
  segments.forEach(seg => {
    if (!seg.value) return;
    const angle = (seg.value / total) * 360;
    const endAngle = startAngle + angle;
    const largeArc = angle > 180 ? 1 : 0;
    const x1 = cx + r * Math.cos((startAngle * Math.PI) / 180);
    const y1 = cy + r * Math.sin((startAngle * Math.PI) / 180);
    const x2 = cx + r * Math.cos((endAngle * Math.PI) / 180);
    const y2 = cy + r * Math.sin((endAngle * Math.PI) / 180);
    html += '<path d="M ' + cx + ' ' + cy + ' L ' + x1 + ' ' + y1 + ' A ' + r + ' ' + r + ' 0 ' + largeArc + ' 1 ' + x2 + ' ' + y2 + ' Z" fill="' + seg.color + '" opacity="0.85"/>';
    startAngle = endAngle;
  });

  // Center hole
  html += '<circle cx="' + cx + '" cy="' + cy + '" r="20" fill="var(--card)"/>';
  html += '<text x="' + cx + '" y="' + (cy + 4) + '" text-anchor="middle" fill="var(--txt)" font-size="12" font-weight="800">' + total + '</text>';
  html += '</svg>';

  // Legend
  html += '<div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:8px;">';
  segments.forEach(seg => {
    if (!seg.value) return;
    html += '<div style="display:flex;align-items:center;gap:4px;font-size:9px;color:var(--txt2);">';
    html += '<span style="width:8px;height:8px;border-radius:50%;background:' + seg.color + ';flex-shrink:0;"></span>';
    html += seg.label + ' (' + seg.value + ')';
    html += '</div>';
  });
  html += '</div>';

  return html;
}

function _barChart(items) {
  const max = Math.max(...items.map(i => i.value), 1);
  let html = '<div style="display:flex;flex-direction:column;gap:8px;">';
  items.forEach(item => {
    const pct = Math.round((item.value / max) * 100);
    html += '<div>';
    html += '<div style="display:flex;justify-content:space-between;margin-bottom:3px;"><span style="font-size:9px;color:var(--txt2);">' + item.label + '</span><span style="font-size:10px;font-weight:700;color:var(--txt);">' + item.value + '</span></div>';
    html += '<div style="height:8px;background:var(--el);border-radius:4px;overflow:hidden;"><div style="width:' + pct + '%;height:100%;background:' + item.color + ';border-radius:4px;transition:width .3s;"></div></div>';
    html += '</div>';
  });
  html += '</div>';
  return html;
}

function _kpi(label, value, color, icon) {
  return '<div style="background:var(--card);border:1px solid var(--bdr);border-radius:10px;padding:12px 14px;display:flex;align-items:center;gap:10px;">' +
    '<div style="font-size:18px;">' + icon + '</div>' +
    '<div><div style="font-size:18px;font-weight:800;color:' + color + ';">' + value + '</div>' +
    '<div style="font-size:9px;color:var(--mut);margin-top:2px;">' + label + '</div></div></div>';
}

function _parseDays(duration) {
  if (!duration) return 0;
  const s = String(duration).toLowerCase();
  let days = 0;
  const dm = s.match(/(\d+)\s*d/);
  if (dm) days += parseInt(dm[1], 10);
  const hm = s.match(/(\d+)\s*h/);
  if (hm) days += parseInt(hm[1], 10) / 24;
  if (!dm && !hm) { const n = parseFloat(s); if (n > 0) days = n; }
  return Math.round(days * 10) / 10;
}

function _esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

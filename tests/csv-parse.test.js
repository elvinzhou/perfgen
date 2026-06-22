import { describe, it, expect } from 'vitest';
import { jsFallback, isSteadyWindow } from '../public/js/wasm-bridge.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCSV({
  rows = 200,
  altP = 8000, oat = -0.85, ias = 140, tas = 162, altD = 8010,
  gndSpd = 140, pitch = 1.5, roll = 0.5,
  map = 22.5, rpm = 2400, ff = 12.0, pwr = 65,
  fq1 = 25, fq2 = 25,
  cht = [360, 365, 370, 375, 368, 362],
  egt = [1380, 1390, 1400, 1410, 1385, 1395],
  prefix = '',   // extra rows before the header (e.g. metadata line)
} = {}) {
  const cols = ['Lcl Date','Lcl Time','AltP','OAT','IAS','TAS','AltD','GndSpd',
                'Pitch','Roll','E1 MAP','E1 RPM','E1 FFlow','E1 %Pwr','FQty1','FQty2',
                'E1 CHT1','E1 CHT2','E1 CHT3','E1 CHT4','E1 CHT5','E1 CHT6',
                'E1 EGT1','E1 EGT2','E1 EGT3','E1 EGT4','E1 EGT5','E1 EGT6'];
  const header = cols.join(',');
  const dataRows = Array.from({ length: rows }, (_, i) => {
    const hh = String(Math.floor(i / 3600)).padStart(2, '0');
    const mm = String(Math.floor(i / 60) % 60).padStart(2, '0');
    const ss = String(i % 60).padStart(2, '0');
    return [
      '2026-01-01', `${hh}:${mm}:${ss}`,
      altP, oat, ias, tas, altD, gndSpd, pitch, roll, map, rpm, ff, pwr, fq1, fq2,
      ...cht, ...egt,
    ].join(',');
  });
  return [prefix, header, ...dataRows].filter(Boolean).join('\n');
}

// ── isSteadyWindow ────────────────────────────────────────────────────────────

function makeWindow(n, overrides = {}) {
  return Array.from({ length: n }, () => ({
    pres_alt: 8000, ias: 140, rpm: 2400, map_inhg: 22.5, roll: 0.5, ...overrides,
  }));
}

describe('isSteadyWindow', () => {
  it('returns false for windows shorter than 180 records', () => {
    expect(isSteadyWindow(makeWindow(179))).toBe(false);
  });
  it('returns true for a stable 180-record window', () => {
    expect(isSteadyWindow(makeWindow(180))).toBe(true);
  });
  it('fails when altitude range exceeds 100 ft', () => {
    const win = makeWindow(180);
    win[0].pres_alt = 8000; win[1].pres_alt = 8101; // 101 ft range
    expect(isSteadyWindow(win)).toBe(false);
  });
  it('passes at exactly the altitude limit (100 ft range)', () => {
    const win = makeWindow(180);
    win[0].pres_alt = 8000; win[1].pres_alt = 8100;
    expect(isSteadyWindow(win)).toBe(true);
  });
  it('fails when IAS range exceeds 4 kts', () => {
    const win = makeWindow(180);
    win[0].ias = 140; win[1].ias = 144.1;
    expect(isSteadyWindow(win)).toBe(false);
  });
  it('fails when roll exceeds 3°', () => {
    const win = makeWindow(180, { roll: 3.1 });
    expect(isSteadyWindow(win)).toBe(false);
  });
  it('passes when roll is exactly 3°', () => {
    const win = makeWindow(180, { roll: 3.0 });
    expect(isSteadyWindow(win)).toBe(true);
  });
  it('fails when RPM range exceeds 40', () => {
    const win = makeWindow(180);
    win[0].rpm = 2400; win[1].rpm = 2441;
    expect(isSteadyWindow(win)).toBe(false);
  });
  it('fails when MAP range exceeds 0.4 InHg', () => {
    const win = makeWindow(180);
    win[0].map_inhg = 22.5; win[1].map_inhg = 22.91;
    expect(isSteadyWindow(win)).toBe(false);
  });
});

// ── jsFallback CSV processing ─────────────────────────────────────────────────

describe('jsFallback — error handling', () => {
  it('returns error for empty input', () => {
    const r = jsFallback('', 0);
    expect(r.error).toBeTruthy();
  });
  it('returns error when header row is missing', () => {
    const r = jsFallback('no,header\n1,2,3', 0);
    expect(r.error).toMatch(/header/i);
  });
  it('returns error when required columns are absent', () => {
    const r = jsFallback('Lcl Date,Lcl Time,AltP\n2026-01-01,00:00:00,8000', 0);
    expect(r.error).toMatch(/column/i);
  });
  it('returns error when there are fewer than 180 in-flight records', () => {
    const csv = makeCSV({ rows: 100 });
    const r = jsFallback(csv, 0);
    expect(r.error).toBeTruthy();
    expect(r.steady_state_blocks).toHaveLength(0);
  });
});

describe('jsFallback — ground data filtering', () => {
  it('skips rows with IAS < 50 kts', () => {
    // 100 on-ground rows + 200 in-flight rows — only in-flight should count
    const groundRow = '2026-01-01,00:00:00,0,15,30,0,100,0,0,0,29.9,1000,0.5,5,25,25,0,0,0,0,0,0,0,0,0,0,0,0';
    const header = 'Lcl Date,Lcl Time,AltP,OAT,IAS,TAS,AltD,GndSpd,Pitch,Roll,E1 MAP,E1 RPM,E1 FFlow,E1 %Pwr,FQty1,FQty2,E1 CHT1,E1 CHT2,E1 CHT3,E1 CHT4,E1 CHT5,E1 CHT6,E1 EGT1,E1 EGT2,E1 EGT3,E1 EGT4,E1 EGT5,E1 EGT6';
    const flightCSV = makeCSV({ rows: 200 });
    const combined = header + '\n' + Array(100).fill(groundRow).join('\n') + '\n' + flightCSV.split('\n').slice(1).join('\n');
    const r = jsFallback(combined, 0);
    expect(r.skipped_records).toBeGreaterThan(0);
  });
});

describe('jsFallback — steady-state extraction', () => {
  it('finds one block in a fully stable log', () => {
    const csv = makeCSV({ rows: 250 });
    const r = jsFallback(csv, 0);
    expect(r.error).toBeNull();
    expect(r.steady_state_blocks).toHaveLength(1);
  });

  it('uses G3X pre-computed TAS when present', () => {
    const csv = makeCSV({ rows: 250, ias: 140, tas: 999 }); // TAS column = 999
    const r = jsFallback(csv, 0);
    expect(r.steady_state_blocks[0].tas).toBeCloseTo(999, 0);
  });

  it('uses G3X pre-computed density altitude when present', () => {
    const csv = makeCSV({ rows: 250, altD: 7777 });
    const r = jsFallback(csv, 0);
    expect(r.steady_state_blocks[0].density_altitude).toBeCloseTo(7777, 0);
  });

  it('computes specific range as gndSpd / fuelFlow', () => {
    const csv = makeCSV({ rows: 250, gndSpd: 150, ff: 10 });
    const r = jsFallback(csv, 0);
    expect(r.steady_state_blocks[0].specific_range).toBeCloseTo(15.0, 1);
  });

  it('extracts CHT max, avg, and spread', () => {
    const cht = [350, 360, 370, 380, 340, 345];
    const csv = makeCSV({ rows: 250, cht });
    const r = jsFallback(csv, 0);
    const b = r.steady_state_blocks[0];
    expect(b.cht_max).toBeCloseTo(380, 0);
    expect(b.cht_spread).toBeCloseTo(380 - 340, 0);
  });

  it('handles a metadata preamble line before the header', () => {
    const csv = makeCSV({ rows: 250, prefix: '#airframe_info,aircraft_ident="N662EZ"' });
    const r = jsFallback(csv, 0);
    expect(r.error).toBeNull();
    expect(r.steady_state_blocks).toHaveLength(1);
  });

  it('produces no blocks when flight is too short to be steady', () => {
    // 179 rows total — can never complete a 180-row window
    const csv = makeCSV({ rows: 179 });
    const r = jsFallback(csv, 0);
    expect(r.steady_state_blocks).toHaveLength(0);
  });
});

describe('jsFallback — flight time range', () => {
  it('reports first and last in-flight record timestamps', () => {
    const csv = makeCSV({ rows: 250 });   // 00:00:00 → 00:04:09
    const r = jsFallback(csv, 0);
    expect(r.start_time).toBe('2026-01-01 00:00:00');
    expect(r.end_time).toBe('2026-01-01 00:04:09');
  });
});

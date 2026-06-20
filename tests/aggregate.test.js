import { describe, it, expect } from 'vitest';
import { computeAggregate } from '../public/js/aggregate.js';

function makeRecord(da, pwr, overrides = {}) {
  return {
    densityAltitude: da,
    powerSetting: pwr,
    tas: 155,
    fuelFlowGph: 12.0,
    specificRange: 12.9,
    mapInhg: 22.5,
    rpm: 2400,
    chtMax: 375,
    chtAvg: 360,
    chtSpread: 30,
    egtSpread: 80,
    ...overrides,
  };
}

describe('computeAggregate', () => {
  it('returns empty object for no records', () => {
    expect(computeAggregate([])).toEqual({});
  });

  it('passes a single record through unchanged', () => {
    const rec = makeRecord(8000, 65);
    const agg = computeAggregate([rec]);
    const cell = agg['8000_65'];
    expect(cell).toBeDefined();
    expect(cell.count).toBe(1);
    expect(cell.tas).toBe(155);
    expect(cell.fuelFlow).toBe(12.0);
    expect(cell.chtMax).toBe(375);
  });

  it('averages multiple records in the same bucket', () => {
    const records = [
      makeRecord(8000, 65, { tas: 150, fuelFlowGph: 11.5, chtMax: 360 }),
      makeRecord(8000, 65, { tas: 160, fuelFlowGph: 12.5, chtMax: 380 }),
    ];
    const agg = computeAggregate(records);
    const cell = agg['8000_65'];
    expect(cell.count).toBe(2);
    expect(cell.tas).toBeCloseTo(155, 1);
    expect(cell.fuelFlow).toBeCloseTo(12.0, 2);
    expect(cell.chtMax).toBe(370);
  });

  it('keeps buckets separate', () => {
    const records = [
      makeRecord(8000, 65, { tas: 155 }),
      makeRecord(10000, 65, { tas: 162 }),
      makeRecord(8000, 75, { tas: 168 }),
    ];
    const agg = computeAggregate(records);
    expect(Object.keys(agg)).toHaveLength(3);
    expect(agg['8000_65'].tas).toBe(155);
    expect(agg['10000_65'].tas).toBe(162);
    expect(agg['8000_75'].tas).toBe(168);
  });

  it('averages specific range only over valid (>0) values', () => {
    const records = [
      makeRecord(8000, 65, { specificRange: 13.0 }),
      makeRecord(8000, 65, { specificRange: null }),   // missing — should not drag average to 0
      makeRecord(8000, 65, { specificRange: 12.0 }),
    ];
    const agg = computeAggregate(records);
    expect(agg['8000_65'].specificRange).toBeCloseTo(12.5, 1);
  });

  it('returns null for chtMax when no valid CHT values exist', () => {
    const records = [makeRecord(8000, 65, { chtMax: 0, chtAvg: 0, chtSpread: 0 })];
    const agg = computeAggregate(records);
    expect(agg['8000_65'].chtMax).toBeNull();
  });

  it('handles WOT power setting as a key', () => {
    const rec = makeRecord(8000, 'WOT', { tas: 185 });
    const agg = computeAggregate([rec]);
    expect(agg['8000_WOT']).toBeDefined();
    expect(agg['8000_WOT'].tas).toBe(185);
  });
});

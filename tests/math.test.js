import { describe, it, expect } from 'vitest';
import { isaTemp, densityAltitude, tasFromIas, ambientPressure, specificRange } from '../public/js/math.js';

describe('isaTemp', () => {
  it('is 15°C at sea level', () => {
    expect(isaTemp(0)).toBeCloseTo(15, 3);
  });
  it('is -4.812°C at 10,000 ft', () => {
    expect(isaTemp(10_000)).toBeCloseTo(-4.812, 2);
  });
  it('decreases with altitude', () => {
    expect(isaTemp(5_000)).toBeLessThan(isaTemp(0));
  });
});

describe('densityAltitude', () => {
  it('equals pressure altitude on a standard day', () => {
    const pa = 8_000;
    expect(densityAltitude(pa, isaTemp(pa))).toBeCloseTo(pa, 0);
  });
  it('exceeds pressure altitude on a hot day', () => {
    const pa = 8_000;
    expect(densityAltitude(pa, isaTemp(pa) + 20)).toBeGreaterThan(pa);
  });
  it('is below pressure altitude on a cold day', () => {
    const pa = 8_000;
    expect(densityAltitude(pa, isaTemp(pa) - 20)).toBeLessThan(pa);
  });
  it('applies the design formula: Hd = Hp + 118.8*(OAT - ISA)', () => {
    const hp = 6_000, oat = 10;
    const expected = hp + 118.8 * (oat - isaTemp(hp));
    expect(densityAltitude(hp, oat)).toBeCloseTo(expected, 5);
  });
});

describe('tasFromIas', () => {
  it('equals IAS at sea level on a standard day', () => {
    expect(tasFromIas(100, 0, 15)).toBeCloseTo(100, 1);
  });
  it('exceeds IAS at altitude', () => {
    expect(tasFromIas(100, 8_000, isaTemp(8_000))).toBeGreaterThan(100);
  });
  it('increases with altitude for the same IAS', () => {
    const low  = tasFromIas(140, 4_000, isaTemp(4_000));
    const high = tasFromIas(140, 8_000, isaTemp(8_000));
    expect(high).toBeGreaterThan(low);
  });
});

describe('ambientPressure', () => {
  it('is 29.92 InHg at sea level', () => {
    expect(ambientPressure(0)).toBeCloseTo(29.92, 2);
  });
  it('decreases with altitude', () => {
    expect(ambientPressure(8_000)).toBeLessThan(ambientPressure(0));
  });
});

describe('specificRange', () => {
  it('is groundSpeed / fuelFlow', () => {
    expect(specificRange(140, 12)).toBeCloseTo(140 / 12, 4);
  });
  it('returns null when fuel flow is zero', () => {
    expect(specificRange(140, 0)).toBeNull();
  });
  it('returns null when fuel flow is below threshold', () => {
    expect(specificRange(140, 0.05)).toBeNull();
  });
});

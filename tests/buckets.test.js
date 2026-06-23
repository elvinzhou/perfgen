import { describe, it, expect } from 'vitest';
import { getDaBucket, getPowerBucket, DA_BUCKETS, DA_TOL, PWR_TOL } from '../public/js/buckets.js';

describe('getDaBucket', () => {
  it('returns the bucket for an exact match', () => {
    for (const b of DA_BUCKETS) expect(getDaBucket(b)).toBe(b);
  });
  it('returns the bucket at the tolerance boundary (±500 ft)', () => {
    expect(getDaBucket(8_000 + DA_TOL)).toBe(8_000);
    expect(getDaBucket(8_000 - DA_TOL)).toBe(8_000);
  });
  it('returns null one foot outside tolerance', () => {
    // 7499 is 501 ft from 8000 and 1499 ft from 6000
    expect(getDaBucket(7_499)).toBeNull();
    expect(getDaBucket(8_501)).toBeNull();
  });
  it('returns null below the lowest bucket', () => {
    expect(getDaBucket(1_000)).toBeNull();
    expect(getDaBucket(0)).toBeNull();
  });
  it('returns null above the highest bucket', () => {
    expect(getDaBucket(15_000)).toBeNull();
    expect(getDaBucket(14_501)).toBeNull();
  });
  it('snaps to the nearest bucket when equidistant ambiguity is resolved by order', () => {
    // 3000 is exactly 1000 ft from 2000 and 4000 — outside ±500 for both → null
    expect(getDaBucket(3_000)).toBeNull();
  });
});

describe('getPowerBucket', () => {
  it('returns the correct bucket at exact power settings', () => {
    expect(getPowerBucket(55)).toBe(55);
    expect(getPowerBucket(65)).toBe(65);
    expect(getPowerBucket(75)).toBe(75);
  });
  it('snaps within ±2% tolerance', () => {
    expect(getPowerBucket(53)).toBe(55);
    expect(getPowerBucket(57)).toBe(55);
    expect(getPowerBucket(63)).toBe(65);
    expect(getPowerBucket(67)).toBe(65);
    expect(getPowerBucket(73)).toBe(75);
    expect(getPowerBucket(77)).toBe(75); // top of the 75% band, not yet WOT
  });
  it('returns null in the gaps between buckets', () => {
    expect(getPowerBucket(59)).toBeNull();  // gap between 55 and 65
    expect(getPowerBucket(70)).toBeNull();  // gap between 65 and 75
    expect(getPowerBucket(50)).toBeNull();
  });
  it('treats anything above the 75% band as WOT', () => {
    expect(getPowerBucket(78)).toBe('WOT');
    expect(getPowerBucket(85)).toBe('WOT');
    expect(getPowerBucket(100)).toBe('WOT');
  });
  it('returns null for missing or NaN power', () => {
    expect(getPowerBucket(NaN)).toBeNull();
    expect(getPowerBucket(null)).toBeNull();
    expect(getPowerBucket(undefined)).toBeNull();
  });
});

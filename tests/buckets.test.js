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
    expect(getPowerBucket(55, 15, 29)).toBe(55);
    expect(getPowerBucket(65, 15, 29)).toBe(65);
    expect(getPowerBucket(75, 15, 29)).toBe(75);
  });
  it('snaps within ±2% tolerance', () => {
    expect(getPowerBucket(53, 15, 29)).toBe(55);
    expect(getPowerBucket(57, 15, 29)).toBe(55);
    expect(getPowerBucket(63, 15, 29)).toBe(65);
    expect(getPowerBucket(67, 15, 29)).toBe(65);
  });
  it('returns null outside tolerance and not WOT', () => {
    expect(getPowerBucket(59, 15, 29)).toBeNull();  // 2% gap between 55 and 65
    expect(getPowerBucket(50, 15, 29)).toBeNull();
  });
  it('returns WOT when MAP is within 0.3 InHg of ambient', () => {
    expect(getPowerBucket(80, 29.7, 29.92)).toBe('WOT');  // 29.7 >= 29.92-0.3=29.62
    expect(getPowerBucket(75, 29.65, 29.92)).toBe('WOT'); // 29.65 >= 29.62
  });
  it('does not return WOT when MAP is clearly below ambient', () => {
    expect(getPowerBucket(75, 25.0, 29.92)).toBe(75);
    expect(getPowerBucket(75, 29.5, 29.92)).toBe(75); // 29.5 < 29.62
  });
  it('prefers WOT over power percentage check', () => {
    // Even if power% = 65, if MAP is at ambient it should be WOT
    expect(getPowerBucket(65, 29.7, 29.92)).toBe('WOT');
  });
});

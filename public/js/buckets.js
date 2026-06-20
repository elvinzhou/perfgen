// Bucketing constants and logic — no imports.

// Design spec: 2,000 ft through 14,000 ft in 2,000 ft increments, tolerance ±500 ft
export const DA_BUCKETS = [2000, 4000, 6000, 8000, 10000, 12000, 14000];
export const DA_TOL = 500;

// Design spec: 55%, 65%, 75%, WOT, tolerance ±2%
export const PWR_BUCKETS = [55, 65, 75, 'WOT'];
export const PWR_TOL = 2;

export function getDaBucket(densityAltFt) {
  for (const bucket of DA_BUCKETS) {
    if (Math.abs(densityAltFt - bucket) <= DA_TOL) return bucket;
  }
  return null;
}

// WOT when MAP is within 0.3 InHg of ambient (throttle fully open for that altitude)
export function getPowerBucket(powerPercent, mapInhg, ambientPressureInhg) {
  if (ambientPressureInhg != null && mapInhg >= ambientPressureInhg - 0.3) return 'WOT';
  for (const pwr of [55, 65, 75]) {
    if (Math.abs(powerPercent - pwr) <= PWR_TOL) return pwr;
  }
  return null;
}

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

// Power is bucketed on the G3X's own computed percent power (E1 %Pwr) — the
// number the pilot actually flies to. WOT is treated as the top band: anything
// above the 75% bucket, since at a given altitude full throttle is simply the
// highest attainable power. (No MAP-vs-ambient guess, which broke on boosted
// engines and mis-detected full throttle on normally-aspirated ones.)
export function getPowerBucket(powerPercent) {
  if (powerPercent == null || isNaN(powerPercent)) return null;
  if (powerPercent > 75 + PWR_TOL) return 'WOT';
  for (const pwr of [55, 65, 75]) {
    if (Math.abs(powerPercent - pwr) <= PWR_TOL) return pwr;
  }
  return null;
}

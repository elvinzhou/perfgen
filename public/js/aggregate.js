// Aggregate computation over raw performance records — no imports.
// Accepts an array of records (from Dexie or anywhere) and returns a map
// keyed by `${densityAltitude}_${powerSetting}` with averaged metrics.

function round1(v) { return Math.round(v * 10) / 10; }
function round2(v) { return Math.round(v * 100) / 100; }
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function validNums(arr) { return arr.filter(v => v != null && !isNaN(v) && v > 0); }

export function computeAggregate(rows) {
  // Group rows by DA × power bucket
  const buckets = {};
  for (const r of rows) {
    const key = `${r.densityAltitude}_${r.powerSetting}`;
    if (!buckets[key]) {
      buckets[key] = {
        densityAltitude: r.densityAltitude,
        powerSetting: r.powerSetting,
        samples: [],
      };
    }
    buckets[key].samples.push(r);
  }

  const aggregate = {};
  for (const [key, bucket] of Object.entries(buckets)) {
    const s = bucket.samples;
    const n = s.length;
    const avg = (fn) => mean(s.map(fn).filter(v => v != null && !isNaN(v)));

    aggregate[key] = {
      densityAltitude: bucket.densityAltitude,
      powerSetting: bucket.powerSetting,
      count: n,
      // Averages across all steady-state blocks from all flights
      tas:           round1(avg(r => r.tas)),
      specificRange: (() => { const v = round1(mean(validNums(s.map(r => r.specificRange)))); return v > 0 ? v : null; })(),
      fuelFlow:      round2(avg(r => r.fuelFlowGph)),
      mapInhg:       round2(avg(r => r.mapInhg)),
      rpm:           Math.round(avg(r => r.rpm)),
      // CHT: average of the per-flight max/avg/spread values
      chtMax:    (() => { const v = Math.round(mean(validNums(s.map(r => r.chtMax)))); return v > 0 ? v : null; })(),
      chtAvg:    (() => { const v = round1(mean(validNums(s.map(r => r.chtAvg)))); return v > 0 ? v : null; })(),
      chtSpread: (() => { const v = Math.round(mean(validNums(s.map(r => r.chtSpread)))); return v > 0 ? v : null; })(),
      egtSpread: (() => { const v = Math.round(mean(validNums(s.map(r => r.egtSpread)))); return v > 0 ? v : null; })(),
    };
  }

  return aggregate;
}

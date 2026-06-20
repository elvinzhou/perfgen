import Dexie from 'https://cdn.jsdelivr.net/npm/dexie@4/+esm';
import { exportDB, importInto } from 'https://cdn.jsdelivr.net/npm/dexie-export-import@4/+esm';

class FlightProfilerDB extends Dexie {
  constructor() {
    super('FlightProfilerDB');
    this.version(1).stores({
      aircraft: '++id, tailNumber, model',
      flights: 'id, aircraftId, date, status',
      // Each row is one steady-state block from one flight — never overwritten.
      // Aggregate queries average across all rows per (aircraftId, da, pwr) bucket.
      performanceMatrix: '++id, aircraftId, flightId, densityAltitude, powerSetting',
    });
  }
}

export const db = new FlightProfilerDB();

// ── Aircraft ──────────────────────────────────────────────────────────────────

export async function saveAircraft(aircraft) {
  if (aircraft.id) {
    await db.aircraft.update(aircraft.id, aircraft);
    return aircraft.id;
  }
  return db.aircraft.add(aircraft);
}

export async function getAircraft(id) {
  return db.aircraft.get(id);
}

export async function listAircraft() {
  return db.aircraft.toArray();
}

export async function deleteAircraft(id) {
  await db.aircraft.delete(id);
  await db.flights.where('aircraftId').equals(id).delete();
  await db.performanceMatrix.where('aircraftId').equals(id).delete();
}

// ── Flights ───────────────────────────────────────────────────────────────────

export async function saveFlight(flight) {
  return db.flights.put(flight);
}

export async function listFlights(aircraftId) {
  return db.flights.where('aircraftId').equals(aircraftId).reverse().sortBy('date');
}

export async function deleteFlight(flightId) {
  await db.flights.delete(flightId);
  await db.performanceMatrix.where('flightId').equals(flightId).delete();
}

// ── Performance Matrix ────────────────────────────────────────────────────────

// Append new steady-state blocks; never overwrites existing data.
export async function addPerformanceRecords(records) {
  return db.performanceMatrix.bulkAdd(records);
}

// Returns a map: key → { tas, specificRange, fuelFlow, chtMax, chtAvg, chtSpread,
//                        egtSpread, count, samples: [...raw] }
// where key = `${densityAltitude}_${powerSetting}`
export async function getAggregateMatrix(aircraftId) {
  const rows = await db.performanceMatrix.where('aircraftId').equals(aircraftId).toArray();

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
    const avg = (fn) => s.reduce((sum, r) => sum + (fn(r) || 0), 0) / n;

    // CHT max per sample → average of those maxima across flights
    const chtMaxes = s.map(r => r.chtMax).filter(v => v > 0);
    const chtAvgs  = s.map(r => r.chtAvg).filter(v => v > 0);
    const chtSpreads = s.map(r => r.chtSpread).filter(v => v > 0);
    const egtSpreads = s.map(r => r.egtSpread).filter(v => v > 0);
    const srs = s.map(r => r.specificRange).filter(v => v > 0);

    aggregate[key] = {
      densityAltitude: bucket.densityAltitude,
      powerSetting: bucket.powerSetting,
      count: n,
      tas: round1(avg(r => r.tas)),
      specificRange: srs.length ? round1(srs.reduce((a, b) => a + b, 0) / srs.length) : null,
      fuelFlow: round2(avg(r => r.fuelFlowGph)),
      chtMax: chtMaxes.length ? Math.round(chtMaxes.reduce((a, b) => a + b, 0) / chtMaxes.length) : null,
      chtAvg: chtAvgs.length ? round1(chtAvgs.reduce((a, b) => a + b, 0) / chtAvgs.length) : null,
      chtSpread: chtSpreads.length ? Math.round(chtSpreads.reduce((a, b) => a + b, 0) / chtSpreads.length) : null,
      egtSpread: egtSpreads.length ? Math.round(egtSpreads.reduce((a, b) => a + b, 0) / egtSpreads.length) : null,
      mapInhg: round2(avg(r => r.mapInhg)),
      rpm: Math.round(avg(r => r.rpm)),
    };
  }

  return aggregate;
}

function round1(v) { return Math.round(v * 10) / 10; }
function round2(v) { return Math.round(v * 100) / 100; }

// ── Backup / Restore ──────────────────────────────────────────────────────────

export async function exportDatabase() {
  const blob = await exportDB(db, { prettyJson: true });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `perfgen-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function importDatabase(file) {
  await db.delete();
  await db.open();
  await importInto(db, file, { clearTablesBeforeImport: true });
}

// ── Bucketing constants ───────────────────────────────────────────────────────

export const DA_BUCKETS   = [2000, 4000, 6000, 8000, 10000, 12000, 14000];
export const DA_TOL       = 500;
export const PWR_BUCKETS  = [55, 65, 75, 'WOT'];
export const PWR_TOL      = 2;

export function getDaBucket(densityAltitude) {
  for (const b of DA_BUCKETS) {
    if (Math.abs(densityAltitude - b) <= DA_TOL) return b;
  }
  return null;
}

export function getPowerBucket(powerPercent, mapInhg, ambientPressureInhg) {
  if (ambientPressureInhg && mapInhg >= ambientPressureInhg - 0.3) return 'WOT';
  for (const pwr of [55, 65, 75]) {
    if (Math.abs(powerPercent - pwr) <= PWR_TOL) return pwr;
  }
  return null;
}

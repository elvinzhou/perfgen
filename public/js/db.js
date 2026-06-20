// Dexie.js IndexedDB wrapper
import Dexie from 'https://cdn.jsdelivr.net/npm/dexie@4/+esm';
import { exportDB, importInto } from 'https://cdn.jsdelivr.net/npm/dexie-export-import@4/+esm';

class FlightProfilerDB extends Dexie {
  constructor() {
    super('FlightProfilerDB');
    this.version(1).stores({
      aircraft: '++id, tailNumber, model',
      flights: 'id, aircraftId, date, status',
      performanceMatrix: '++id, aircraftId, densityAltitude, powerSetting',
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
  return db.flights.where('aircraftId').equals(aircraftId).toArray();
}

export async function deleteFlight(id) {
  await db.flights.delete(id);
}

// ── Performance Matrix ────────────────────────────────────────────────────────

export async function upsertPerformanceRecords(records) {
  return db.performanceMatrix.bulkPut(records);
}

export async function getMatrixForAircraft(aircraftId) {
  return db.performanceMatrix.where('aircraftId').equals(aircraftId).toArray();
}

export async function deleteMatrixForFlight(flightId) {
  return db.performanceMatrix.where('flightId').equals(flightId).delete();
}

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

// DA bucket boundaries
export const DA_BUCKETS = [2000, 4000, 6000, 8000, 10000, 12000, 14000];
export const DA_TOL = 500;
export const PWR_BUCKETS = [55, 65, 75, 'WOT'];
export const PWR_TOL = 2; // ±2%

export function getDaBucket(densityAltitude) {
  for (const bucket of DA_BUCKETS) {
    if (Math.abs(densityAltitude - bucket) <= DA_TOL) return bucket;
  }
  return null;
}

export function getPowerBucket(powerPercent, mapInhg, ambientPressureInhg) {
  // Check WOT: MAP within 0.3 InHg of ambient
  if (ambientPressureInhg && mapInhg >= ambientPressureInhg - 0.3) return 'WOT';
  for (const pwr of [55, 65, 75]) {
    if (Math.abs(powerPercent - pwr) <= PWR_TOL) return pwr;
  }
  return null;
}

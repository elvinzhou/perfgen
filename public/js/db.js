import Dexie from 'https://esm.sh/dexie@4';
import { exportDB, importInto } from 'https://esm.sh/dexie-export-import@4';
import { computeAggregate } from './aggregate.js';
export { getDaBucket, getPowerBucket, DA_BUCKETS, DA_TOL, PWR_BUCKETS, PWR_TOL } from './buckets.js';

class FlightProfilerDB extends Dexie {
  constructor() {
    super('FlightProfilerDB');
    this.version(1).stores({
      aircraft: '++id, tailNumber, model',
      flights: 'id, aircraftId, date, status',
      // Append-only — one row per steady-state block per flight
      performanceMatrix: '++id, aircraftId, flightId, densityAltitude, powerSetting',
    });
  }
}

export const db = new FlightProfilerDB();

// ── Aircraft ──────────────────────────────────────────────────────────────────

export async function saveAircraft(aircraft) {
  if (aircraft.id) { await db.aircraft.update(aircraft.id, aircraft); return aircraft.id; }
  return db.aircraft.add(aircraft);
}

export async function getAircraft(id) { return db.aircraft.get(id); }
export async function listAircraft() { return db.aircraft.toArray(); }

export async function deleteAircraft(id) {
  await db.aircraft.delete(id);
  await db.flights.where('aircraftId').equals(id).delete();
  await db.performanceMatrix.where('aircraftId').equals(id).delete();
}

// ── Flights ───────────────────────────────────────────────────────────────────

export async function saveFlight(flight) { return db.flights.put(flight); }
export async function listFlights(aircraftId) {
  return db.flights.where('aircraftId').equals(aircraftId).reverse().sortBy('date');
}

// Fingerprints of flights already ingested for an aircraft, for de-duplication.
export async function getFlightFingerprints(aircraftId) {
  const flights = await db.flights.where('aircraftId').equals(aircraftId).toArray();
  return new Set(flights.map(f => f.contentHash).filter(Boolean));
}
export async function deleteFlight(flightId) {
  await db.flights.delete(flightId);
  await db.performanceMatrix.where('flightId').equals(flightId).delete();
}

// ── Performance Matrix ────────────────────────────────────────────────────────

export async function addPerformanceRecords(records) {
  return db.performanceMatrix.bulkAdd(records);
}

export async function getAggregateMatrix(aircraftId) {
  const rows = await db.performanceMatrix.where('aircraftId').equals(aircraftId).toArray();
  return computeAggregate(rows);
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

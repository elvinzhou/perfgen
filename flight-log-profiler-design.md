# System Architecture & Specification: Flight Log Performance Profiler

## 1. System Overview
This document outlines the architecture and implementation specifications for a web-based Flight Log Performance Profiler. The system ingests Garmin G3X flight log data (`.csv`), identifies steady-state cruise phases, normalizes performance data to standard atmospheric conditions, maps it to a discrete performance matrix, and generates flight test cards for missing data points.

The architecture minimizes server-side processing and storage costs by utilizing client-side storage and Edge computation.

## 2. Technical Stack
* **Frontend / UI:** HTML/JS with Tailwind CSS, hosted on Cloudflare Pages.
* **API Routing:** Cloudflare Workers (TypeScript).
* **Computation Engine:** Rust compiled to WebAssembly (Wasm) for high-performance parsing and data normalization.
* **Local Storage Layer:** IndexedDB managed via Dexie.js.

## 3. Storage Architecture (IndexedDB / Dexie.js)
The database schema must reside locally in the user's browser, eliminating server-side storage costs. The schema uses a flexible array structure for engine parameters to natively support future expansion to multi-engine aircraft without breaking schema migrations.

### 3.1 Dexie.js Schema
```typescript
import Dexie from 'dexie';

class FlightProfilerDB extends Dexie {
  aircraft!: Dexie.Table<Aircraft, number>;
  flights!: Dexie.Table<Flight, string>;
  performanceMatrix!: Dexie.Table<PerformanceRecord, number>;

  constructor() {
    super('FlightProfilerDB');
    this.version(1).stores({
      aircraft: '++id, tailNumber, model',
      flights: 'id, aircraftId, date, status',
      performanceMatrix: '++id, aircraftId, densityAltitude, powerSetting'
    });
  }
}
```

### 3.2 Extensible Telemetry Interface
```typescript
interface EngineData {
  engineIndex: number;
  rpm: number;
  map: number;
  fuelFlowGph: number;
  cht: number[]; 
  egt: number[];
}

interface PerformanceRecord {
  id?: number;
  aircraftId: number;
  timestamp: string;
  densityAltitude: number;
  tas: number;
  weightLbs: number;
  engines: EngineData[]; 
}
```

### 3.3 Backup & Migration
Implement `dexie-export-import` to allow users to generate a downloadable `.json` backup file. This enables cross-device migration and protects against browser cache clears.

## 4. Data Processing Pipeline

### 4.1 Ingestion & Sanitization
The system parses standard Garmin G3X CSV headers. Required parameters:
* `E1 MAP` (InHg), `E1 RPM`
* `OAT` (°C), `BaroAlt` (Ft), `IAS` (Kts)
* `Fflow GPH` (Gallons per Hour)
* `GndSpd` (Kts), `Pitch`, `Roll` (Degrees)

### 4.2 Steady-State Extraction Engine (Rust/Wasm)
The Wasm module processes the 1Hz dataset using a 180-second sliding window to isolate stabilized cruise. A data block is discarded if parameters exceed the following tolerances within any 180-second window:

| Parameter | Tolerance |
| :--- | :--- |
| `BaroAlt` | ±50 ft |
| `IAS` | ±2 kts |
| `E1 RPM` | ±20 RPM |
| `E1 MAP` | ±0.2 InHg |
| `Roll` | ±3 degrees |

### 4.3 Normalization
For extracted steady-state blocks, the engine calculates normalized values:
1.  **Pressure Altitude (Hp):** Derived from `BaroAlt` (29.92 InHg reference).
2.  **Density Altitude (Hd):**
    * $Hd = Hp + 118.8 * (OAT - ISA_{temp})$
    * $ISA_{temp} = 15 - 0.0019812 * Hp$
3.  **True Airspeed (TAS):** Computed from IAS, Hp, and OAT.

## 5. Performance Matrix & Gap Analysis

### 5.1 Target Grid
The application evaluates performance across a discrete grid for the selected aircraft profile.
* **Density Altitude Buckets:** 2,000 ft through 14,000 ft in 2,000 ft increments. (Tolerance: ±500 ft).
* **Power Setting Buckets:** 55%, 65%, 75%, WOT (Wide Open Throttle). (Tolerance: ±2%).

### 5.2 Test Card Generation
The system executes a gap analysis against the target grid. Empty grid blocks are compiled into printable flight test cards.

#### Example Output Format
```text
FLIGHT TEST CARD: N662EZ PROFILE COMPLETION
=========================================
Target: 8,000 ft Density Alt
-----------------------------------------
[ ] Point 1: 55% Power (~20.5 InHg / 2300 RPM)
    Action: Stabilize for 3 minutes.
[ ] Point 2: 65% Power (~22.5 InHg / 2400 RPM)
    Action: Stabilize for 3 minutes.
[ ] Point 3: 75% Power (~24.5 InHg / 2450 RPM)
    Action: Stabilize for 3 minutes.
```

## 6. Implementation Milestones

1.  **Frontend & Storage Setup:** Initialize Cloudflare Pages project. Implement Tailwind UI and Dexie.js database schema. Implement the `dexie-export-import` backup utility.
2.  **Wasm Engine Build:** Develop the Rust module to parse CSV inputs and execute the 180-second rolling window steady-state algorithm. Compile to Wasm and expose to the frontend.
3.  **Normalization Logic:** Implement density altitude and TAS math formulas within the Wasm engine.
4.  **Matrix Integration:** Pipe Wasm outputs into the Dexie.js `performanceMatrix` table. Build the UI grid component to visualize populated vs. missing data blocks.
5.  **Gap Analysis UI:** Implement the script to query empty Dexie records and format them into the printable Test Card view.

import {
  db, saveAircraft, getAircraft, listAircraft, deleteAircraft,
  saveFlight, listFlights, deleteFlight,
  upsertPerformanceRecords, getMatrixForAircraft,
  exportDatabase, importDatabase,
  DA_BUCKETS, DA_TOL, PWR_BUCKETS, PWR_TOL,
  getDaBucket, getPowerBucket,
} from './db.js';
import { processCSV, loadWasm } from './wasm-bridge.js';

// ── State ─────────────────────────────────────────────────────────────────────
let currentAircraftId = null;
let matrixData = {};  // { "da_pwr": PerformanceRecord }

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadWasm().catch(() => {});
  await renderAircraftList();
  bindEvents();
});

function bindEvents() {
  document.getElementById('btn-new-aircraft').addEventListener('click', () => showModal('modal-aircraft'));
  document.getElementById('form-aircraft').addEventListener('submit', onSaveAircraft);
  document.getElementById('btn-cancel-aircraft').addEventListener('click', () => hideModal('modal-aircraft'));

  document.getElementById('btn-upload-csv').addEventListener('click', () => {
    document.getElementById('input-csv').click();
  });
  document.getElementById('input-csv').addEventListener('change', onCSVSelected);

  document.getElementById('btn-export').addEventListener('click', exportDatabase);
  document.getElementById('btn-import').addEventListener('click', () => document.getElementById('input-import').click());
  document.getElementById('input-import').addEventListener('change', onImport);

  document.getElementById('btn-print-card').addEventListener('click', onPrintTestCard);
}

// ── Aircraft Management ────────────────────────────────────────────────────────

async function renderAircraftList() {
  const aircraft = await listAircraft();
  const select = document.getElementById('select-aircraft');
  const empty = document.getElementById('no-aircraft');
  const matrixSection = document.getElementById('matrix-section');

  select.innerHTML = '<option value="">-- Select Aircraft --</option>';
  aircraft.forEach(a => {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = `${a.tailNumber} — ${a.model}`;
    select.appendChild(opt);
  });

  if (aircraft.length === 0) {
    empty.classList.remove('hidden');
    matrixSection.classList.add('hidden');
  } else {
    empty.classList.add('hidden');
  }

  select.addEventListener('change', async () => {
    currentAircraftId = select.value ? parseInt(select.value) : null;
    if (currentAircraftId) {
      await loadMatrix();
      matrixSection.classList.remove('hidden');
    } else {
      matrixSection.classList.add('hidden');
    }
  });
}

async function onSaveAircraft(e) {
  e.preventDefault();
  const form = e.target;
  const aircraft = {
    tailNumber: form['tail-number'].value.trim().toUpperCase(),
    model: form['model'].value.trim(),
    maxHp: parseFloat(form['max-hp'].value) || 0,
    notes: form['notes'].value.trim(),
    createdAt: new Date().toISOString(),
  };
  const id = form.dataset.editId ? parseInt(form.dataset.editId) : undefined;
  if (id) aircraft.id = id;
  await saveAircraft(aircraft);
  form.reset();
  delete form.dataset.editId;
  hideModal('modal-aircraft');
  await renderAircraftList();
  showToast(`Aircraft ${aircraft.tailNumber} saved.`);
}

// ── CSV Upload & Processing ───────────────────────────────────────────────────

async function onCSVSelected(e) {
  const file = e.target.files[0];
  if (!file || !currentAircraftId) return;
  e.target.value = '';

  const aircraft = await getAircraft(currentAircraftId);
  showToast('Processing CSV… this may take a moment.');

  const text = await file.text();
  const result = await processCSV(text, aircraft.maxHp || 0);

  if (result.error) {
    showToast(`Error: ${result.error}`, 'error');
    return;
  }

  if (result.steady_state_blocks.length === 0) {
    showToast('No steady-state cruise phases found in this log.', 'warn');
    return;
  }

  // Map blocks to performance records and bucket them
  const flight = {
    id: `flight-${Date.now()}`,
    aircraftId: currentAircraftId,
    date: new Date().toISOString().slice(0, 10),
    filename: file.name,
    totalRecords: result.total_records,
    skippedRecords: result.skipped_records,
    steadyBlocks: result.steady_state_blocks.length,
    status: 'processed',
    processedAt: new Date().toISOString(),
  };
  await saveFlight(flight);

  const perfRecords = [];
  for (const block of result.steady_state_blocks) {
    const daBucket = getDaBucket(block.density_altitude);
    const ambientP = 29.92 * Math.pow(1 - 6.8755856e-6 * block.pressure_altitude, 5.2558797);
    const pwrBucket = getPowerBucket(block.power_percent, block.map_inhg, ambientP);
    if (!daBucket || !pwrBucket) continue;

    perfRecords.push({
      aircraftId: currentAircraftId,
      flightId: flight.id,
      timestamp: block.timestamp,
      densityAltitude: daBucket,
      powerSetting: pwrBucket,
      tas: block.tas,
      ias: block.ias,
      mapInhg: block.map_inhg,
      rpm: block.rpm,
      fuelFlowGph: block.fuel_flow_gph,
      oat: block.oat,
      weightLbs: 0,
      engines: [{
        engineIndex: 0,
        rpm: block.rpm,
        map: block.map_inhg,
        fuelFlowGph: block.fuel_flow_gph,
        cht: [],
        egt: [],
      }],
    });
  }

  if (perfRecords.length > 0) {
    await upsertPerformanceRecords(perfRecords);
  }

  showToast(`Processed: ${result.steady_state_blocks.length} steady-state blocks → ${perfRecords.length} matrix points added.`);
  await loadMatrix();
}

// ── Performance Matrix ────────────────────────────────────────────────────────

async function loadMatrix() {
  if (!currentAircraftId) return;
  const records = await getMatrixForAircraft(currentAircraftId);
  matrixData = {};
  for (const r of records) {
    const key = `${r.densityAltitude}_${r.powerSetting}`;
    if (!matrixData[key] || r.timestamp > matrixData[key].timestamp) {
      matrixData[key] = r;
    }
  }
  renderMatrix();
}

function renderMatrix() {
  const grid = document.getElementById('performance-grid');
  grid.innerHTML = '';

  // Header row
  const headerRow = document.createElement('div');
  headerRow.className = 'contents';
  const corner = document.createElement('div');
  corner.className = 'sticky left-0 bg-gray-800 text-gray-400 text-xs font-bold p-2 border-b border-r border-gray-700 flex items-end';
  corner.textContent = 'DA (ft) / Power';
  headerRow.appendChild(corner);
  for (const pwr of PWR_BUCKETS) {
    const th = document.createElement('div');
    th.className = 'bg-gray-800 text-gray-300 text-xs font-bold p-2 border-b border-gray-700 text-center';
    th.textContent = pwr === 'WOT' ? 'WOT' : `${pwr}%`;
    headerRow.appendChild(th);
  }
  grid.appendChild(headerRow);

  // Data rows
  for (const da of [...DA_BUCKETS].reverse()) {
    const row = document.createElement('div');
    row.className = 'contents';

    const rowLabel = document.createElement('div');
    rowLabel.className = 'sticky left-0 bg-gray-800 text-gray-300 text-xs font-semibold p-2 border-r border-gray-700 flex items-center';
    rowLabel.textContent = `${da.toLocaleString()} ft`;
    row.appendChild(rowLabel);

    for (const pwr of PWR_BUCKETS) {
      const key = `${da}_${pwr}`;
      const rec = matrixData[key];
      const cell = document.createElement('div');
      cell.className = 'border border-gray-700 p-2 text-center text-xs cursor-pointer transition-colors min-w-[100px]';

      if (rec) {
        cell.classList.add('bg-green-900', 'hover:bg-green-800');
        cell.innerHTML = `
          <div class="font-bold text-green-300">${rec.tas} kts</div>
          <div class="text-gray-400">${rec.mapInhg} InHg / ${rec.rpm} RPM</div>
          <div class="text-gray-500">${rec.fuelFlowGph} GPH</div>
        `;
        cell.title = `TAS: ${rec.tas} kts | OAT: ${rec.oat}°C | FF: ${rec.fuelFlowGph} GPH\n${rec.timestamp}`;
        cell.addEventListener('click', () => showRecordDetail(rec));
      } else {
        cell.classList.add('bg-gray-900', 'hover:bg-gray-700');
        cell.innerHTML = '<span class="text-gray-600">—</span>';
      }
      row.appendChild(cell);
    }
    grid.appendChild(row);
  }

  updateMatrixStats();
}

function updateMatrixStats() {
  const total = DA_BUCKETS.length * PWR_BUCKETS.length;
  const filled = Object.keys(matrixData).length;
  const missing = total - filled;
  document.getElementById('stat-filled').textContent = filled;
  document.getElementById('stat-missing').textContent = missing;
  document.getElementById('stat-total').textContent = total;
  document.getElementById('btn-print-card').disabled = missing === 0;
}

function showRecordDetail(rec) {
  const dlg = document.getElementById('modal-detail');
  document.getElementById('detail-content').innerHTML = `
    <table class="w-full text-sm text-left border-collapse">
      <tbody>
        ${[
          ['Timestamp', rec.timestamp],
          ['Density Altitude Bucket', `${rec.densityAltitude.toLocaleString()} ft`],
          ['Power Setting', rec.powerSetting === 'WOT' ? 'WOT' : `${rec.powerSetting}%`],
          ['TAS', `${rec.tas} kts`],
          ['IAS', `${rec.ias} kts`],
          ['MAP', `${rec.mapInhg} InHg`],
          ['RPM', rec.rpm],
          ['Fuel Flow', `${rec.fuelFlowGph} GPH`],
          ['OAT', `${rec.oat} °C`],
        ].map(([k,v]) => `<tr class="border-b border-gray-700">
          <td class="py-1 pr-4 text-gray-400 font-medium">${k}</td>
          <td class="py-1 text-gray-100">${v}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  `;
  showModal('modal-detail');
}

document.addEventListener('click', e => {
  if (e.target.id === 'btn-close-detail') hideModal('modal-detail');
});

// ── Test Card Generation ──────────────────────────────────────────────────────

async function onPrintTestCard() {
  const aircraft = await getAircraft(currentAircraftId);
  const missing = [];

  for (const da of DA_BUCKETS) {
    const missingPwr = PWR_BUCKETS.filter(pwr => !matrixData[`${da}_${pwr}`]);
    if (missingPwr.length > 0) {
      missing.push({ da, pwrs: missingPwr });
    }
  }

  if (missing.length === 0) {
    showToast('Matrix is complete — no test card needed!');
    return;
  }

  const lines = [
    `FLIGHT TEST CARD: ${aircraft.tailNumber} PROFILE COMPLETION`,
    '='.repeat(50),
    `Aircraft: ${aircraft.model}`,
    `Generated: ${new Date().toLocaleDateString()}`,
    '',
  ];

  for (const { da, pwrs } of missing) {
    lines.push(`Target: ${da.toLocaleString()} ft Density Altitude`);
    lines.push('-'.repeat(42));
    pwrs.forEach((pwr, i) => {
      const { mapHint, rpmHint } = getPowerHint(pwr, da);
      const label = pwr === 'WOT' ? 'WOT (full throttle)' : `${pwr}% Power`;
      lines.push(`[ ] Point ${i+1}: ${label}${mapHint ? ` (~${mapHint} / ${rpmHint})` : ''}`);
      lines.push(`    Action: Stabilize for 3 minutes. Record on Garmin G3X.`);
    });
    lines.push('');
  }

  const card = lines.join('\n');
  document.getElementById('test-card-content').textContent = card;
  showModal('modal-test-card');
}

function getPowerHint(pwr, da) {
  // Rough MAP hints for normally-aspirated engines at altitude
  // These are illustrative — actual values depend on the aircraft POH
  const ambientApprox = 29.92 * Math.pow(1 - 6.8755856e-6 * da, 5.2558797);
  if (pwr === 'WOT') {
    return { mapHint: `${ambientApprox.toFixed(1)} InHg`, rpmHint: 'Full RPM' };
  }
  const targetMap = (pwr / 100) * ambientApprox * 1.15; // rough estimate
  return { mapHint: `${Math.min(targetMap, ambientApprox).toFixed(1)} InHg`, rpmHint: `~${2200 + (pwr - 55) * 10} RPM` };
}

document.addEventListener('click', e => {
  if (e.target.id === 'btn-close-card') hideModal('modal-test-card');
  if (e.target.id === 'btn-print') window.print();
  if (e.target.id === 'btn-download-card') downloadCard();
});

function downloadCard() {
  const text = document.getElementById('test-card-content').textContent;
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'flight-test-card.txt';
  a.click();
}

// ── Import ────────────────────────────────────────────────────────────────────

async function onImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  if (!confirm('Import will overwrite existing data. Continue?')) return;
  try {
    await importDatabase(file);
    showToast('Database restored from backup.');
    await renderAircraftList();
  } catch (err) {
    showToast(`Import failed: ${err.message}`, 'error');
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function showModal(id) {
  document.getElementById(id).classList.remove('hidden');
  document.getElementById(id).classList.add('flex');
}

function hideModal(id) {
  document.getElementById(id).classList.add('hidden');
  document.getElementById(id).classList.remove('flex');
}

let toastTimer;
function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  const bg = type === 'error' ? 'bg-red-800' : type === 'warn' ? 'bg-yellow-800' : 'bg-blue-800';
  toast.className = `fixed bottom-6 right-6 text-white text-sm px-4 py-3 rounded-lg shadow-lg z-50 max-w-sm ${bg}`;
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 5000);
}

export { renderAircraftList };

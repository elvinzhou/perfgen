import {
  db, saveAircraft, getAircraft, listAircraft, deleteAircraft,
  saveFlight, listFlights, deleteFlight, getFlightDedupeInfo,
  addPerformanceRecords, getAggregateMatrix,
  exportDatabase, importDatabase,
} from './db.js';
import { DA_BUCKETS, PWR_BUCKETS, getDaBucket, getPowerBucket } from './buckets.js';
import { processCSV, loadWasm } from './wasm-bridge.js';
import { fingerprintCsv, parseG3xTimestamp, timeRangesOverlap } from './dedupe.js';

// ── State ─────────────────────────────────────────────────────────────────────
let currentAircraftId = null;
let aggregateMatrix = {};   // key → aggregate cell data
let activeTab = 'tas';      // 'tas' | 'range' | 'fuel' | 'cht'

const TABS = [
  { id: 'tas',   label: 'TAS',            unit: 'kts',     color: 'green'  },
  { id: 'range', label: 'Specific Range', unit: 'nm/gal',  color: 'blue'   },
  { id: 'fuel',  label: 'Fuel Burn',      unit: 'GPH',     color: 'purple' },
  { id: 'cht',   label: 'Max CHT',        unit: '°F',      color: 'red'    },
];

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadWasm().catch(() => {});
  renderTabs();
  await renderAircraftList();
  bindEvents();
});

// ── Tabs ──────────────────────────────────────────────────────────────────────
function renderTabs() {
  const container = document.getElementById('chart-tabs');
  container.innerHTML = '';
  for (const tab of TABS) {
    const btn = document.createElement('button');
    btn.dataset.tab = tab.id;
    btn.className = [
      'px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors whitespace-nowrap',
      tab.id === activeTab
        ? 'border-blue-400 text-blue-300 bg-gray-800'
        : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-800/50',
    ].join(' ');
    btn.textContent = `${tab.label} (${tab.unit})`;
    btn.addEventListener('click', () => { activeTab = tab.id; renderTabs(); renderMatrix(); });
    container.appendChild(btn);
  }
}

// ── Events ────────────────────────────────────────────────────────────────────
function bindEvents() {
  document.getElementById('btn-new-aircraft').addEventListener('click', () => showModal('modal-aircraft'));
  document.getElementById('form-aircraft').addEventListener('submit', onSaveAircraft);
  document.getElementById('btn-cancel-aircraft').addEventListener('click', () => hideModal('modal-aircraft'));

  const dropzone = document.getElementById('dropzone');
  dropzone.addEventListener('click', () => document.getElementById('input-csv').click());
  document.getElementById('input-csv').addEventListener('change', onCSVSelected);

  // Drag & drop onto the upload zone
  const setDragActive = on => {
    dropzone.classList.toggle('border-green-500', on);
    dropzone.classList.toggle('bg-gray-800/50', on);
  };
  ['dragenter', 'dragover'].forEach(ev =>
    dropzone.addEventListener(ev, e => { e.preventDefault(); setDragActive(true); }));
  ['dragleave', 'dragend'].forEach(ev =>
    dropzone.addEventListener(ev, e => { e.preventDefault(); setDragActive(false); }));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer?.files?.length) processFiles(e.dataTransfer.files);
  });

  // Prevent the browser from navigating away if a file is dropped off-target
  ['dragover', 'drop'].forEach(ev =>
    window.addEventListener(ev, e => { if (e.target !== dropzone) e.preventDefault(); }));

  document.getElementById('btn-export').addEventListener('click', exportDatabase);
  document.getElementById('btn-import').addEventListener('click', () =>
    document.getElementById('input-import').click());
  document.getElementById('input-import').addEventListener('change', onImport);

  document.getElementById('btn-print-card').addEventListener('click', onPrintTestCard);

  document.addEventListener('click', e => {
    if (e.target.id === 'btn-close-detail') hideModal('modal-detail');
    if (e.target.id === 'btn-close-card') hideModal('modal-test-card');
    if (e.target.id === 'btn-print') window.print();
    if (e.target.id === 'btn-download-card') downloadCard();
  });
}

// ── Aircraft ──────────────────────────────────────────────────────────────────
async function renderAircraftList() {
  const aircraft = await listAircraft();
  const select = document.getElementById('select-aircraft');
  select.innerHTML = '<option value="">-- Select Aircraft --</option>';
  aircraft.forEach(a => {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = `${a.tailNumber} — ${a.model}`;
    select.appendChild(opt);
  });
  document.getElementById('no-aircraft').classList.toggle('hidden', aircraft.length > 0);

  select.addEventListener('change', async () => {
    currentAircraftId = select.value ? parseInt(select.value) : null;
    document.getElementById('matrix-section').classList.toggle('hidden', !currentAircraftId);
    document.getElementById('welcome-state').classList.toggle('hidden', !!currentAircraftId);
    if (currentAircraftId) await loadMatrix();
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
  if (form.dataset.editId) aircraft.id = parseInt(form.dataset.editId);
  await saveAircraft(aircraft);
  form.reset();
  delete form.dataset.editId;
  hideModal('modal-aircraft');
  await renderAircraftList();
  showToast(`Aircraft ${aircraft.tailNumber} saved.`);
}

// ── CSV Upload ────────────────────────────────────────────────────────────────
function onCSVSelected(e) {
  // Snapshot the File refs BEFORE resetting the input: `value = ''` clears the
  // live FileList, which would otherwise leave processFiles with nothing.
  const files = Array.from(e.target.files);
  e.target.value = '';   // reset so re-selecting the same file fires change again
  processFiles(files);
}

function makeFlightId() {
  return crypto.randomUUID
    ? `flight-${crypto.randomUUID()}`
    : `flight-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Map a result's steady-state blocks to performance records for one flight.
// Returns { records, outOfGrid } where outOfGrid counts blocks whose
// DA/power fell outside the target grid (and so don't affect the matrix).
function buildPerfRecords(result, flightId) {
  const records = [];
  let outOfGrid = 0;
  for (const block of result.steady_state_blocks) {
    const daBucket = getDaBucket(block.density_altitude);
    const ambientP = 29.92 * Math.pow(1 - 6.8755856e-6 * block.pres_alt, 5.2558797);
    const pwrBucket = getPowerBucket(block.power_percent, block.map_inhg, ambientP);
    if (!daBucket || !pwrBucket) { outOfGrid++; continue; }

    records.push({
      aircraftId: currentAircraftId,
      flightId,
      timestamp: block.timestamp,
      densityAltitude: daBucket,
      powerSetting: pwrBucket,
      tas: block.tas,
      ias: block.ias,
      mapInhg: block.map_inhg,
      rpm: block.rpm,
      fuelFlowGph: block.fuel_flow_gph,
      specificRange: block.specific_range,
      oat: block.oat,
      chtMax: block.cht_max,
      chtAvg: block.cht_avg,
      chtSpread: block.cht_spread,
      egtSpread: block.egt_spread,
      cht: block.cht,
      egt: block.egt,
      engines: [{
        engineIndex: 0,
        rpm: block.rpm,
        map: block.map_inhg,
        fuelFlowGph: block.fuel_flow_gph,
        cht: block.cht,
        egt: block.egt,
      }],
    });
  }
  return { records, outOfGrid };
}

async function processFiles(fileList) {
  if (!currentAircraftId) { showToast('Select an aircraft first.', 'warn'); return; }

  const files = Array.from(fileList || []).filter(f => /\.csv$/i.test(f.name));
  if (!files.length) { showToast('No CSV files to upload.', 'warn'); return; }

  const aircraft = await getAircraft(currentAircraftId);
  // Dedupe state, seeded from the DB and grown as we ingest this batch, so a
  // duplicate flight is never counted twice in the averaged matrix. We catch
  // two forms: an identical file (content fingerprint) and the same flight
  // recorded on a second G3X/SD card (overlapping time range).
  const index = await getFlightDedupeInfo(currentAircraftId);
  const seenHashes = new Set(index.map(f => f.contentHash).filter(Boolean));

  showToast(`Processing ${files.length} file${files.length === 1 ? '' : 's'}…`);

  let addedPoints = 0, newFlights = 0, duplicates = 0, outOfGrid = 0, noSteady = 0;
  const errors = [];

  for (const file of files) {
    let text;
    try { text = await file.text(); }
    catch { errors.push(`${file.name}: unreadable`); continue; }

    const fingerprint = fingerprintCsv(text);
    if (seenHashes.has(fingerprint)) { duplicates++; continue; }
    seenHashes.add(fingerprint);

    const result = await processCSV(text, aircraft.maxHp || 0);
    if (result.error) { errors.push(`${file.name}: ${result.error}`); continue; }
    if (!result.steady_state_blocks.length) { noSteady++; continue; }

    // Same flight from a different recorder: bytes differ, but the time range
    // overlaps an already-ingested flight. Skip it.
    const startMs = parseG3xTimestamp(result.start_time);
    const endMs   = parseG3xTimestamp(result.end_time);
    if (index.some(f => timeRangesOverlap(startMs, endMs, f.startMs, f.endMs))) {
      duplicates++; continue;
    }

    const flight = {
      id: makeFlightId(),
      aircraftId: currentAircraftId,
      date: new Date().toISOString().slice(0, 10),
      filename: file.name,
      contentHash: fingerprint,
      startTime: result.start_time ?? null,
      endTime: result.end_time ?? null,
      startMs,
      endMs,
      totalRecords: result.total_records,
      skippedRecords: result.skipped_records,
      steadyBlocks: result.steady_state_blocks.length,
      status: 'processed',
      processedAt: new Date().toISOString(),
    };

    const { records, outOfGrid: og } = buildPerfRecords(result, flight.id);
    outOfGrid += og;

    await saveFlight(flight);
    if (records.length) await addPerformanceRecords(records);
    index.push({ contentHash: fingerprint, startMs, endMs });
    addedPoints += records.length;
    newFlights++;
  }

  await loadMatrix();
  showToast(uploadSummary({ addedPoints, newFlights, duplicates, outOfGrid, noSteady, errors }),
            errors.length ? 'warn' : 'info');
}

// Build a clear, non-misleading completion message. The matrix only changes
// when data points are added, so duplicates and out-of-grid blocks are called
// out explicitly rather than hidden behind an ambiguous "added 0 points".
function uploadSummary({ addedPoints, newFlights, duplicates, outOfGrid, noSteady, errors }) {
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const parts = [];

  if (newFlights) {
    parts.push(`Added ${plural(addedPoints, 'data point')} from ${plural(newFlights, 'flight')}`);
  } else {
    parts.push('No new data points added');
  }
  if (duplicates) parts.push(`skipped ${plural(duplicates, 'duplicate')} (already uploaded — matrix unchanged)`);
  if (outOfGrid)  parts.push(`${plural(outOfGrid, 'block')} outside the DA/power grid`);
  if (noSteady)   parts.push(`${plural(noSteady, 'file')} had no steady cruise`);
  if (errors.length) parts.push(errors.length <= 2 ? errors.join('; ') : `${plural(errors.length, 'file')} failed`);

  return parts.join(' · ');
}

// ── Aggregate Matrix ──────────────────────────────────────────────────────────
async function loadMatrix() {
  if (!currentAircraftId) return;
  aggregateMatrix = await getAggregateMatrix(currentAircraftId);
  renderMatrix();
}

function getCellValue(cell) {
  if (!cell) return null;
  switch (activeTab) {
    case 'tas':   return cell.tas   != null ? { primary: `${cell.tas} kts`,    sub: `${cell.mapInhg}" / ${cell.rpm} RPM` } : null;
    case 'range': return cell.specificRange != null ? { primary: `${cell.specificRange} nm/gal`, sub: `${cell.fuelFlow} GPH` } : null;
    case 'fuel':  return cell.fuelFlow != null ? { primary: `${cell.fuelFlow} GPH`, sub: `${cell.tas} kts TAS` } : null;
    case 'cht':   return cell.chtMax != null ? { primary: `${cell.chtMax}°F`, sub: cell.chtSpread ? `±${Math.round(cell.chtSpread/2)}° spread` : '' } : null;
  }
  return null;
}

function chtColor(chtMax) {
  if (!chtMax) return 'green';
  if (chtMax >= 420) return 'red';
  if (chtMax >= 390) return 'yellow';
  return 'green';
}

function renderMatrix() {
  const grid = document.getElementById('performance-grid');
  grid.innerHTML = '';

  // Header row
  const makeDiv = (cls, content = '') => {
    const d = document.createElement('div');
    d.className = cls;
    d.innerHTML = content;
    return d;
  };

  grid.appendChild(makeDiv(
    'sticky left-0 bg-gray-800 text-gray-400 text-xs font-bold p-2 border-b border-r border-gray-700 flex items-end',
    'DA / Power'
  ));
  for (const pwr of PWR_BUCKETS) {
    grid.appendChild(makeDiv(
      'bg-gray-800 text-gray-300 text-xs font-bold p-2 border-b border-gray-700 text-center',
      pwr === 'WOT' ? 'WOT' : `${pwr}%`
    ));
  }

  // Data rows (highest DA at top)
  for (const da of [...DA_BUCKETS].reverse()) {
    grid.appendChild(makeDiv(
      'sticky left-0 bg-gray-800 text-gray-300 text-xs font-semibold p-2 border-r border-gray-700 flex items-center',
      `${da.toLocaleString()} ft`
    ));

    for (const pwr of PWR_BUCKETS) {
      const key = `${da}_${pwr}`;
      const cell = aggregateMatrix[key];
      const val = getCellValue(cell);
      const div = document.createElement('div');
      div.className = 'border border-gray-700 p-2 text-center text-xs cursor-pointer transition-colors min-w-[110px]';

      if (val) {
        const col = activeTab === 'cht' ? chtColor(cell.chtMax) : 'green';
        const colorMap = {
          green:  ['bg-green-900',  'hover:bg-green-800',  'text-green-300'],
          blue:   ['bg-blue-900',   'hover:bg-blue-800',   'text-blue-300'],
          purple: ['bg-purple-900', 'hover:bg-purple-800', 'text-purple-300'],
          red:    ['bg-red-900',    'hover:bg-red-800',    'text-red-300'],
          yellow: ['bg-yellow-900', 'hover:bg-yellow-800', 'text-yellow-300'],
        };
        const [bg, hbg, text] = colorMap[col];
        div.classList.add(bg, hbg);
        div.innerHTML = `
          <div class="font-bold ${text}">${val.primary}</div>
          ${val.sub ? `<div class="text-gray-400 mt-0.5">${val.sub}</div>` : ''}
          <div class="text-gray-600 mt-1">N=${cell.count}</div>
        `;
        div.addEventListener('click', () => showCellDetail(cell));
      } else {
        div.classList.add('bg-gray-900', 'hover:bg-gray-700');
        div.innerHTML = '<span class="text-gray-600">—</span>';
      }
      grid.appendChild(div);
    }
  }

  updateStats();
}

function updateStats() {
  const total = DA_BUCKETS.length * PWR_BUCKETS.length;
  const filled = Object.keys(aggregateMatrix).length;
  document.getElementById('stat-filled').textContent = filled;
  document.getElementById('stat-missing').textContent = total - filled;
  document.getElementById('stat-total').textContent = total;
  document.getElementById('btn-print-card').disabled = filled === total;

  // Sample count summary
  const totalSamples = Object.values(aggregateMatrix).reduce((s, c) => s + c.count, 0);
  document.getElementById('stat-samples').textContent = totalSamples;
}

function showCellDetail(cell) {
  const fmt = (v, unit) => v != null && !isNaN(v) ? `${v} ${unit}` : '—';
  document.getElementById('detail-content').innerHTML = `
    <table class="w-full text-sm text-left">
      <tbody class="divide-y divide-gray-700">
        ${[
          ['Density Altitude', `${cell.densityAltitude.toLocaleString()} ft`],
          ['Power Setting', cell.powerSetting === 'WOT' ? 'WOT' : `${cell.powerSetting}%`],
          ['Flights averaged (N)', cell.count],
          ['TAS', fmt(cell.tas, 'kts')],
          ['Specific Range', fmt(cell.specificRange, 'nm/gal')],
          ['Fuel Flow', fmt(cell.fuelFlow, 'GPH')],
          ['MAP', fmt(cell.mapInhg, 'InHg')],
          ['RPM', fmt(cell.rpm, '')],
          ['Max CHT (avg)', fmt(cell.chtMax, '°F')],
          ['CHT Spread (avg)', fmt(cell.chtSpread, '°F')],
          ['EGT Spread (avg)', fmt(cell.egtSpread, '°F')],
        ].map(([k,v]) => `<tr><td class="py-1.5 pr-4 text-gray-400 font-medium">${k}</td>
                              <td class="py-1.5 text-gray-100">${v}</td></tr>`).join('')}
      </tbody>
    </table>`;
  showModal('modal-detail');
}

// ── Test Card ─────────────────────────────────────────────────────────────────
async function onPrintTestCard() {
  const aircraft = await getAircraft(currentAircraftId);
  const missing = DA_BUCKETS
    .map(da => ({ da, pwrs: PWR_BUCKETS.filter(pwr => !aggregateMatrix[`${da}_${pwr}`]) }))
    .filter(({ pwrs }) => pwrs.length > 0);

  if (!missing.length) { showToast('Matrix complete — no test card needed!'); return; }

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
      lines.push(`[ ] Point ${i + 1}: ${label}${mapHint ? ` (~${mapHint} / ${rpmHint})` : ''}`);
      lines.push(`    Action: Stabilize for 3 minutes. Record on Garmin G3X.`);
    });
    lines.push('');
  }

  document.getElementById('test-card-content').textContent = lines.join('\n');
  showModal('modal-test-card');
}

function getPowerHint(pwr, da) {
  const ap = 29.92 * Math.pow(1 - 6.8755856e-6 * da, 5.2558797);
  if (pwr === 'WOT') return { mapHint: `${ap.toFixed(1)} InHg`, rpmHint: 'Full RPM' };
  const mapEst = Math.min((pwr / 100) * ap * 1.15, ap).toFixed(1);
  return { mapHint: `${mapEst} InHg`, rpmHint: `~${2200 + (pwr - 55) * 10} RPM` };
}

function downloadCard() {
  const blob = new Blob([document.getElementById('test-card-content').textContent], { type: 'text/plain' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'flight-test-card.txt' });
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
  const el = document.getElementById(id);
  el.classList.remove('hidden');
  el.classList.add('flex');
}
function hideModal(id) {
  const el = document.getElementById(id);
  el.classList.add('hidden');
  el.classList.remove('flex');
}

let toastTimer;
function showToast(msg, type = 'info') {
  const bg = { error: 'bg-red-800', warn: 'bg-yellow-800', info: 'bg-blue-800' }[type];
  const el = document.getElementById('toast');
  el.className = `fixed bottom-6 right-6 text-white text-sm px-4 py-3 rounded-lg shadow-lg z-50 max-w-sm ${bg}`;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 5000);
}

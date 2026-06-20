// Lazy-loads the Wasm module and exposes process_csv
let wasmModule = null;

export async function loadWasm() {
  if (wasmModule) return wasmModule;
  try {
    const mod = await import('/wasm/wasm_engine.js');
    await mod.default();       // init() — loads the .wasm bytes
    wasmModule = mod;
    return mod;
  } catch (e) {
    console.warn('Wasm module not available, falling back to JS engine:', e.message);
    return null;
  }
}

export async function processCSV(csvText, maxHp = 0) {
  const wasm = await loadWasm();
  if (wasm) {
    return wasm.process_csv(csvText, maxHp);
  }
  // JS fallback (development mode without compiled Wasm)
  return jsFallbackProcessCSV(csvText, maxHp);
}

// ── Pure-JS fallback (mirrors Rust logic) ─────────────────────────────────────

const WINDOW = 180;
const ALT_RANGE = 100, IAS_RANGE = 4, RPM_RANGE = 40, MAP_RANGE = 0.4, ROLL_MAX = 3;

function pAlt(baroAlt) { return baroAlt; }
function isaTemp(hp) { return 15 - 0.0019812 * hp; }
function densityAlt(hp, oat) { return hp + 118.8 * (oat - isaTemp(hp)); }
function tasFromIas(ias, hp, oat) {
  const t = oat + 273.15, tSL = 288.15;
  const pRatio = Math.pow(1 - 6.8755856e-6 * hp, 5.2558797);
  const sigma = pRatio * (tSL / t);
  return ias / Math.sqrt(sigma);
}
function ambientP(hp) { return 29.92 * Math.pow(1 - 6.8755856e-6 * hp, 5.2558797); }

function range(arr) {
  let min = Infinity, max = -Infinity;
  for (const v of arr) { if (v < min) min = v; if (v > max) max = v; }
  return max - min;
}

function isSteady(window) {
  if (window.length < WINDOW) return false;
  return range(window.map(r => r.baro_alt)) <= ALT_RANGE
    && range(window.map(r => r.ias)) <= IAS_RANGE
    && range(window.map(r => r.rpm)) <= RPM_RANGE
    && range(window.map(r => r.map_inhg)) <= MAP_RANGE
    && window.every(r => Math.abs(r.roll) <= ROLL_MAX);
}

function avg(records) {
  const n = records.length;
  const s = records.reduce((a, r) => ({
    baro_alt: a.baro_alt + r.baro_alt,
    oat: a.oat + r.oat,
    ias: a.ias + r.ias,
    gnd_spd: a.gnd_spd + r.gnd_spd,
    pitch: a.pitch + r.pitch,
    roll: a.roll + r.roll,
    map_inhg: a.map_inhg + r.map_inhg,
    rpm: a.rpm + r.rpm,
    fuel_flow_gph: a.fuel_flow_gph + r.fuel_flow_gph,
    pwr_pct: a.pwr_pct + r.pwr_pct,
  }), { baro_alt:0,oat:0,ias:0,gnd_spd:0,pitch:0,roll:0,map_inhg:0,rpm:0,fuel_flow_gph:0,pwr_pct:0 });
  return {
    timestamp: records[Math.floor(n/2)].timestamp,
    baro_alt: s.baro_alt/n, oat: s.oat/n, ias: s.ias/n, gnd_spd: s.gnd_spd/n,
    pitch: s.pitch/n, roll: s.roll/n, map_inhg: s.map_inhg/n,
    rpm: s.rpm/n, fuel_flow_gph: s.fuel_flow_gph/n, pwr_pct: s.pwr_pct/n,
  };
}

function buildResult(rec, maxHp) {
  const hp = rec.baro_alt;
  const hd = densityAlt(hp, rec.oat);
  const tas = tasFromIas(rec.ias, hp, rec.oat);
  const ap = ambientP(hp);
  const pwr = rec.pwr_pct > 0 ? rec.pwr_pct : Math.min((rec.map_inhg / ap) * 100, 100);
  return {
    timestamp: rec.timestamp,
    baro_alt: Math.round(rec.baro_alt*10)/10,
    oat: Math.round(rec.oat*10)/10,
    ias: Math.round(rec.ias*10)/10,
    gnd_spd: Math.round(rec.gnd_spd*10)/10,
    pitch: Math.round(rec.pitch*10)/10,
    roll: Math.round(rec.roll*10)/10,
    map_inhg: Math.round(rec.map_inhg*100)/100,
    rpm: Math.round(rec.rpm),
    fuel_flow_gph: Math.round(rec.fuel_flow_gph*100)/100,
    pressure_altitude: Math.round(hp),
    density_altitude: Math.round(hd),
    tas: Math.round(tas*10)/10,
    power_percent: Math.round(pwr*10)/10,
  };
}

function jsFallbackProcessCSV(csvText, maxHp) {
  const lines = csvText.split('\n');
  if (!lines.length) return { steady_state_blocks: [], total_records: 0, skipped_records: 0, error: 'Empty file' };

  // Find header row
  let headerIdx = -1, headers = [];
  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].split(',').map(s => s.trim());
    if (cols.some(c => ['Lcl Date','UTCDate','Date','Lcl_Date'].includes(c))) {
      headerIdx = i; headers = cols; break;
    }
  }
  if (headerIdx < 0) return { steady_state_blocks:[], total_records:0, skipped_records:0, error: "Cannot find header row" };

  const fc = (candidates) => {
    for (const c of candidates) {
      const i = headers.indexOf(c); if (i >= 0) return i;
    }
    return -1;
  };

  const dateCol = fc(['Lcl Date','UTCDate','Date','Lcl_Date']);
  const timeCol = fc(['Lcl Time','UTCTime','Time','Lcl_Time']);
  const altCol = fc(['AltB','BaroAlt','AltMSL']);
  const oatCol = fc(['OAT']);
  const iasCol = fc(['IAS']);
  const gndCol = fc(['GndSpd']);
  const pitchCol = fc(['Pitch']);
  const rollCol = fc(['Roll']);
  const mapCol = fc(['E1 MAP','MAP']);
  const rpmCol = fc(['E1 RPM','RPM']);
  const ffCol = fc(['E1 FFlow','Fflow GPH','FFlow','E1 Fflow']);
  const pwrCol = fc(['E1 %Pwr','%Pwr','E1 Pwr']);

  if ([altCol,oatCol,iasCol,gndCol,pitchCol,rollCol,mapCol,rpmCol,ffCol].includes(-1))
    return { steady_state_blocks:[], total_records:0, skipped_records:0, error: 'Missing required columns' };

  const g = (cols, i) => i >= 0 ? parseFloat(cols[i]) : NaN;

  const records = []; let skipped = 0;
  for (const line of lines.slice(headerIdx + 1)) {
    if (!line.trim()) continue;
    const cols = line.split(',').map(s => s.trim());
    const alt = g(cols, altCol), oat = g(cols, oatCol), ias = g(cols, iasCol);
    const map = g(cols, mapCol), rpm = g(cols, rpmCol);
    if (isNaN(alt)||isNaN(oat)||isNaN(ias)||ias<50||isNaN(map)||isNaN(rpm)||rpm<500) { skipped++; continue; }
    const ts = (dateCol>=0&&timeCol>=0) ? `${cols[dateCol]} ${cols[timeCol]}` : '';
    records.push({ timestamp:ts, baro_alt:alt, oat, ias, gnd_spd:g(cols,gndCol),
      pitch:g(cols,pitchCol), roll:g(cols,rollCol), map_inhg:map, rpm,
      fuel_flow_gph:g(cols,ffCol), pwr_pct: pwrCol>=0 ? g(cols,pwrCol) : 0 });
  }

  if (records.length < WINDOW)
    return { steady_state_blocks:[], total_records:records.length, skipped_records:skipped,
             error:`Insufficient records: ${records.length}` };

  const blocks = []; let inSteady = false, blockStart = 0;
  for (let i = WINDOW; i <= records.length; i++) {
    const win = records.slice(i - WINDOW, i);
    const steady = isSteady(win);
    if (steady && !inSteady) { inSteady = true; blockStart = i - WINDOW; }
    else if (!steady && inSteady) {
      inSteady = false;
      blocks.push(buildResult(avg(records.slice(blockStart, i-1)), maxHp));
    }
  }
  if (inSteady) blocks.push(buildResult(avg(records.slice(blockStart)), maxHp));

  return { steady_state_blocks: blocks, total_records: records.length, skipped_records: skipped, error: null };
}

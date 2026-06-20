import { isaTemp, densityAltitude, tasFromIas, ambientPressure, specificRange } from './math.js';

let wasmModule = null;

export async function loadWasm() {
  if (wasmModule) return wasmModule;
  try {
    const mod = await import('/wasm/wasm_engine.js');
    await mod.default();
    wasmModule = mod;
    return mod;
  } catch (e) {
    console.warn('Wasm unavailable, using JS fallback:', e.message);
    return null;
  }
}

export async function processCSV(csvText, maxHp = 0) {
  const wasm = await loadWasm();
  if (wasm) return wasm.process_csv(csvText, maxHp);
  return jsFallback(csvText, maxHp);
}

// ── Steady-state tolerances (mirror Rust constants exactly) ───────────────────
const WINDOW   = 180;
const ALT_RANGE = 100;   // ±50 ft → max range 100 ft
const IAS_RANGE = 4;     // ±2 kts
const RPM_RANGE = 40;    // ±20 RPM
const MAP_RANGE = 0.4;   // ±0.2 InHg
const ROLL_MAX  = 3.0;   // absolute degrees

function valRange(arr) { return Math.max(...arr) - Math.min(...arr); }

export function isSteadyWindow(window) {
  if (window.length < WINDOW) return false;
  return valRange(window.map(r => r.pres_alt)) <= ALT_RANGE
    && valRange(window.map(r => r.ias))      <= IAS_RANGE
    && valRange(window.map(r => r.rpm))      <= RPM_RANGE
    && valRange(window.map(r => r.map_inhg)) <= MAP_RANGE
    && window.every(r => Math.abs(r.roll)    <= ROLL_MAX);
}

function avgBlock(recs) {
  const n = recs.length;
  const s = (fn) => recs.reduce((a, r) => a + (fn(r) || 0), 0) / n;
  const chtLen = Math.max(...recs.map(r => r.cht.length), 0);
  const egtLen = Math.max(...recs.map(r => r.egt.length), 0);
  const avgArr = (fn, len) => Array.from({ length: len }, (_, i) => {
    const vals = recs.map(r => fn(r)[i]).filter(v => v != null && !isNaN(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
  });
  const tasVals = recs.map(r => r.tas).filter(v => v != null && !isNaN(v));
  const daVals  = recs.map(r => r.da).filter(v => v != null && !isNaN(v));
  return {
    timestamp: recs[Math.floor(n / 2)].timestamp,
    pres_alt: s(r => r.pres_alt), ias: s(r => r.ias),
    tas:  tasVals.length ? tasVals.reduce((a, b) => a + b, 0) / tasVals.length : NaN,
    oat:  s(r => r.oat),
    da:   daVals.length  ? daVals.reduce((a, b) => a + b, 0)  / daVals.length  : NaN,
    gnd_spd: s(r => r.gnd_spd), pitch: s(r => r.pitch), roll: s(r => r.roll),
    map_inhg: s(r => r.map_inhg), rpm: s(r => r.rpm),
    fuel_flow_gph: s(r => r.fuel_flow_gph), pwr_pct: s(r => r.pwr_pct),
    fqty_total: s(r => r.fqty_total),
    cht: avgArr(r => r.cht, chtLen),
    egt: avgArr(r => r.egt, egtLen),
  };
}

function buildResult(rec) {
  const pa  = rec.pres_alt;
  const da  = !isNaN(rec.da)  ? rec.da  : densityAltitude(pa, rec.oat);
  const tas = !isNaN(rec.tas) ? rec.tas : tasFromIas(rec.ias, pa, rec.oat);
  const ap  = ambientPressure(pa);
  const pwr = rec.pwr_pct > 0 ? rec.pwr_pct : Math.min((rec.map_inhg / ap) * 100, 100);
  const sr  = specificRange(rec.gnd_spd, rec.fuel_flow_gph);

  const validCht = rec.cht.filter(v => !isNaN(v) && v > 0);
  const chtMax    = validCht.length ? Math.max(...validCht) : NaN;
  const chtMin    = validCht.length ? Math.min(...validCht) : NaN;
  const chtAvg    = validCht.length ? validCht.reduce((a, b) => a + b, 0) / validCht.length : NaN;
  const validEgt  = rec.egt.filter(v => !isNaN(v) && v > 0);
  const egtSpread = validEgt.length > 1 ? Math.max(...validEgt) - Math.min(...validEgt) : NaN;

  const r1 = v => Math.round(v * 10) / 10;
  return {
    timestamp: rec.timestamp,
    pres_alt: Math.round(pa), density_altitude: Math.round(da),
    oat: r1(rec.oat), ias: r1(rec.ias), tas: r1(tas), gnd_spd: r1(rec.gnd_spd),
    pitch: r1(rec.pitch), roll: r1(rec.roll),
    map_inhg: Math.round(rec.map_inhg * 100) / 100,
    rpm: Math.round(rec.rpm),
    fuel_flow_gph: Math.round(rec.fuel_flow_gph * 100) / 100,
    power_percent: r1(pwr),
    specific_range: sr != null ? r1(sr) : NaN,
    cht: rec.cht.map(v => isNaN(v) ? 0 : Math.round(v)),
    cht_max: isNaN(chtMax) ? NaN : Math.round(chtMax),
    cht_avg: r1(chtAvg),
    cht_spread: (isNaN(chtMax) || isNaN(chtMin)) ? NaN : Math.round(chtMax - chtMin),
    egt: rec.egt.map(v => isNaN(v) ? 0 : Math.round(v)),
    egt_spread: isNaN(egtSpread) ? NaN : Math.round(egtSpread),
    fqty_total: r1(rec.fqty_total),
  };
}

// ── CSV parser (pure JS) ──────────────────────────────────────────────────────

export function jsFallback(csvText, _maxHp) {
  const lines = csvText.split('\n');
  let headerIdx = -1, headers = [];
  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].split(',').map(s => s.trim());
    if (cols.some(c => ['Lcl Date','UTCDate','Date','Lcl_Date'].includes(c))) {
      headerIdx = i; headers = cols; break;
    }
  }
  if (headerIdx < 0)
    return { steady_state_blocks:[], total_records:0, skipped_records:0, error:'Cannot find header row' };

  const fc = (...cands) => { for (const c of cands) { const i = headers.indexOf(c); if (i >= 0) return i; } return -1; };
  const g  = (cols, i) => i >= 0 ? parseFloat(cols[i]) : NaN;

  const dateCol  = fc('Lcl Date','UTCDate','Date');
  const timeCol  = fc('Lcl Time','UTCTime','Time');
  const altPCol  = fc('AltP','AltB','BaroAlt','AltMSL','AltInd');
  const daCol    = fc('AltD');
  const tasCol   = fc('TAS');
  const oatCol   = fc('OAT');
  const iasCol   = fc('IAS');
  const gndCol   = fc('GndSpd');
  const pitchCol = fc('Pitch');
  const rollCol  = fc('Roll');
  const mapCol   = fc('E1 MAP','MAP');
  const rpmCol   = fc('E1 RPM','RPM');
  const ffCol    = fc('E1 FFlow','Fflow GPH','FFlow','E1 Fflow');
  const pwrCol   = fc('E1 %Pwr','%Pwr');
  const fq1Col   = fc('FQty1'); const fq2Col = fc('FQty2');
  const chtCols  = [1,2,3,4,5,6].map(i => fc(`E1 CHT${i}`,`CHT${i}`));
  const egtCols  = [1,2,3,4,5,6].map(i => fc(`E1 EGT${i}`,`EGT${i}`));

  if ([altPCol,oatCol,iasCol,gndCol,pitchCol,rollCol,mapCol,rpmCol,ffCol].includes(-1))
    return { steady_state_blocks:[], total_records:0, skipped_records:0, error:'Missing required columns' };

  const records = []; let skipped = 0;
  for (const line of lines.slice(headerIdx + 1)) {
    if (!line.trim()) continue;
    const cols = line.split(',').map(s => s.trim());
    const pa = g(cols,altPCol), oat = g(cols,oatCol), ias = g(cols,iasCol);
    const map = g(cols,mapCol), rpm = g(cols,rpmCol);
    if (isNaN(pa)||isNaN(oat)||isNaN(ias)||ias<50||isNaN(map)||isNaN(rpm)||rpm<500) { skipped++; continue; }
    const ts = (dateCol>=0&&timeCol>=0) ? `${cols[dateCol]} ${cols[timeCol]}` : '';
    records.push({
      timestamp:ts, pres_alt:pa, ias, tas:g(cols,tasCol), oat, da:g(cols,daCol),
      gnd_spd:g(cols,gndCol), pitch:g(cols,pitchCol), roll:g(cols,rollCol),
      map_inhg:map, rpm, fuel_flow_gph:g(cols,ffCol),
      pwr_pct:g(cols,pwrCol)||0, fqty_total:(g(cols,fq1Col)||0)+(g(cols,fq2Col)||0),
      cht:chtCols.map(i => g(cols,i)),
      egt:egtCols.map(i => g(cols,i)),
    });
  }

  if (records.length < WINDOW)
    return { steady_state_blocks:[], total_records:records.length, skipped_records:skipped,
             error:`Insufficient in-flight records: ${records.length} (need at least ${WINDOW})` };

  const blocks = []; let inSteady=false, bStart=0;
  for (let i = WINDOW; i <= records.length; i++) {
    const win = records.slice(i-WINDOW, i);
    const steady = isSteadyWindow(win);
    if (steady && !inSteady)       { inSteady=true; bStart=i-WINDOW; }
    else if (!steady && inSteady)  { inSteady=false; blocks.push(buildResult(avgBlock(records.slice(bStart,i-1)))); }
  }
  if (inSteady) blocks.push(buildResult(avgBlock(records.slice(bStart))));

  return { steady_state_blocks:blocks, total_records:records.length, skipped_records:skipped, error:null };
}

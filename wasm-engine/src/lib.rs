use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

const WINDOW_SECONDS: usize = 180;
const ALT_RANGE: f64 = 100.0;
const IAS_RANGE: f64 = 4.0;
const RPM_RANGE: f64 = 40.0;
const MAP_RANGE: f64 = 0.4;
const ROLL_MAX: f64 = 3.0;

#[derive(Debug, Clone)]
struct G3xRecord {
    timestamp: String,
    pres_alt: f64,   // AltP — pressure altitude (ft)
    ias: f64,
    tas: f64,        // G3X pre-computed TAS (kts); NaN if absent
    oat: f64,
    da: f64,         // AltD — G3X pre-computed density altitude; NaN if absent
    gnd_spd: f64,
    pitch: f64,
    roll: f64,
    map_inhg: f64,
    rpm: f64,
    fuel_flow_gph: f64,
    pwr_pct: f64,
    cht: Vec<f64>,   // CHT1-6 (°F)
    egt: Vec<f64>,   // EGT1-6 (°F)
    fqty_total: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SteadyStateResult {
    pub timestamp: String,
    pub pres_alt: f64,
    pub density_altitude: f64,
    pub oat: f64,
    pub ias: f64,
    pub tas: f64,
    pub gnd_spd: f64,
    pub pitch: f64,
    pub roll: f64,
    pub map_inhg: f64,
    pub rpm: f64,
    pub fuel_flow_gph: f64,
    pub power_percent: f64,
    pub specific_range: f64,  // nm/gal = gnd_spd / fuel_flow_gph
    pub cht: Vec<f64>,
    pub cht_max: f64,
    pub cht_avg: f64,
    pub cht_spread: f64,
    pub egt: Vec<f64>,
    pub egt_spread: f64,
    pub fqty_total: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProcessingResult {
    pub steady_state_blocks: Vec<SteadyStateResult>,
    pub total_records: usize,
    pub skipped_records: usize,
    pub error: Option<String>,
}

// ── Atmospheric math (fallbacks when G3X pre-computed values are absent) ──────

fn isa_temp(pres_alt: f64) -> f64 {
    15.0 - 0.0019812 * pres_alt
}

fn density_altitude_from_pa(pres_alt: f64, oat: f64) -> f64 {
    pres_alt + 118.8 * (oat - isa_temp(pres_alt))
}

fn tas_from_ias(ias: f64, pres_alt: f64, oat: f64) -> f64 {
    let t = oat + 273.15;
    let t_sl = 288.15_f64;
    let p_ratio = (1.0 - 6.8755856e-6 * pres_alt).powf(5.2558797);
    let sigma = p_ratio * (t_sl / t);
    ias / sigma.sqrt()
}

fn ambient_pressure_inhg(pres_alt: f64) -> f64 {
    29.92 * (1.0 - 6.8755856e-6 * pres_alt).powf(5.2558797)
}

// ── Steady-state detection ────────────────────────────────────────────────────

fn check_range(values: &[f64], max_range: f64) -> bool {
    let min = values.iter().cloned().fold(f64::INFINITY, f64::min);
    let max = values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    (max - min) <= max_range
}

fn is_steady_state(window: &[G3xRecord]) -> bool {
    if window.len() < WINDOW_SECONDS {
        return false;
    }
    check_range(&window.iter().map(|r| r.pres_alt).collect::<Vec<_>>(), ALT_RANGE)
        && check_range(&window.iter().map(|r| r.ias).collect::<Vec<_>>(), IAS_RANGE)
        && check_range(&window.iter().map(|r| r.rpm).collect::<Vec<_>>(), RPM_RANGE)
        && check_range(&window.iter().map(|r| r.map_inhg).collect::<Vec<_>>(), MAP_RANGE)
        && window.iter().all(|r| r.roll.abs() <= ROLL_MAX)
}

// ── Averaging a confirmed steady-state block ──────────────────────────────────

fn average_block(records: &[G3xRecord]) -> G3xRecord {
    let n = records.len() as f64;
    let cht_len = records.iter().map(|r| r.cht.len()).max().unwrap_or(0);
    let egt_len = records.iter().map(|r| r.egt.len()).max().unwrap_or(0);

    let mut cht_sum = vec![0.0_f64; cht_len];
    let mut cht_count = vec![0.0_f64; cht_len];
    let mut egt_sum = vec![0.0_f64; egt_len];
    let mut egt_count = vec![0.0_f64; egt_len];

    let mut s_pres_alt = 0.0_f64;
    let mut s_ias = 0.0_f64;
    let mut s_tas = 0.0_f64;
    let mut s_oat = 0.0_f64;
    let mut s_da = 0.0_f64;
    let mut s_gnd_spd = 0.0_f64;
    let mut s_pitch = 0.0_f64;
    let mut s_roll = 0.0_f64;
    let mut s_map = 0.0_f64;
    let mut s_rpm = 0.0_f64;
    let mut s_ff = 0.0_f64;
    let mut s_pwr = 0.0_f64;
    let mut s_fqty = 0.0_f64;

    for r in records {
        s_pres_alt += r.pres_alt;
        s_ias += r.ias;
        s_tas += if r.tas.is_nan() { 0.0 } else { r.tas };
        s_oat += r.oat;
        s_da += if r.da.is_nan() { 0.0 } else { r.da };
        s_gnd_spd += r.gnd_spd;
        s_pitch += r.pitch;
        s_roll += r.roll;
        s_map += r.map_inhg;
        s_rpm += r.rpm;
        s_ff += r.fuel_flow_gph;
        s_pwr += r.pwr_pct;
        s_fqty += r.fqty_total;
        for (i, &v) in r.cht.iter().enumerate() {
            if !v.is_nan() && i < cht_len {
                cht_sum[i] += v;
                cht_count[i] += 1.0;
            }
        }
        for (i, &v) in r.egt.iter().enumerate() {
            if !v.is_nan() && i < egt_len {
                egt_sum[i] += v;
                egt_count[i] += 1.0;
            }
        }
    }

    let tas_has_data = records.iter().any(|r| !r.tas.is_nan());
    let da_has_data = records.iter().any(|r| !r.da.is_nan());

    G3xRecord {
        timestamp: records[records.len() / 2].timestamp.clone(),
        pres_alt: s_pres_alt / n,
        ias: s_ias / n,
        tas: if tas_has_data { s_tas / n } else { f64::NAN },
        oat: s_oat / n,
        da: if da_has_data { s_da / n } else { f64::NAN },
        gnd_spd: s_gnd_spd / n,
        pitch: s_pitch / n,
        roll: s_roll / n,
        map_inhg: s_map / n,
        rpm: s_rpm / n,
        fuel_flow_gph: s_ff / n,
        pwr_pct: s_pwr / n,
        fqty_total: s_fqty / n,
        cht: cht_sum.iter().zip(cht_count.iter())
            .map(|(s, c)| if *c > 0.0 { s / c } else { f64::NAN })
            .collect(),
        egt: egt_sum.iter().zip(egt_count.iter())
            .map(|(s, c)| if *c > 0.0 { s / c } else { f64::NAN })
            .collect(),
    }
}

// ── Build normalized result from an averaged block ────────────────────────────

fn build_result(rec: &G3xRecord) -> SteadyStateResult {
    let pa = rec.pres_alt;

    // Prefer G3X pre-computed values; fall back to our formulas
    let da = if !rec.da.is_nan() { rec.da } else { density_altitude_from_pa(pa, rec.oat) };
    let tas = if !rec.tas.is_nan() { rec.tas } else { tas_from_ias(rec.ias, pa, rec.oat) };
    let ambient_p = ambient_pressure_inhg(pa);

    let pwr = if rec.pwr_pct > 0.0 {
        rec.pwr_pct
    } else {
        (rec.map_inhg / ambient_p * 100.0).min(100.0)
    };

    let specific_range = if rec.fuel_flow_gph > 0.1 {
        rec.gnd_spd / rec.fuel_flow_gph
    } else {
        f64::NAN
    };

    let valid_cht: Vec<f64> = rec.cht.iter().cloned().filter(|v| !v.is_nan() && *v > 0.0).collect();
    let cht_max = valid_cht.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let cht_min = valid_cht.iter().cloned().fold(f64::INFINITY, f64::min);
    let cht_avg = if !valid_cht.is_empty() { valid_cht.iter().sum::<f64>() / valid_cht.len() as f64 } else { f64::NAN };
    let cht_spread = if valid_cht.len() > 1 { cht_max - cht_min } else { f64::NAN };

    let valid_egt: Vec<f64> = rec.egt.iter().cloned().filter(|v| !v.is_nan() && *v > 0.0).collect();
    let egt_max = valid_egt.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let egt_min = valid_egt.iter().cloned().fold(f64::INFINITY, f64::min);
    let egt_spread = if valid_egt.len() > 1 { egt_max - egt_min } else { f64::NAN };

    let r1 = |v: f64| (v * 10.0).round() / 10.0;
    let r0 = |v: f64| v.round();

    SteadyStateResult {
        timestamp: rec.timestamp.clone(),
        pres_alt: r0(pa),
        density_altitude: r0(da),
        oat: r1(rec.oat),
        ias: r1(rec.ias),
        tas: r1(tas),
        gnd_spd: r1(rec.gnd_spd),
        pitch: r1(rec.pitch),
        roll: r1(rec.roll),
        map_inhg: (rec.map_inhg * 100.0).round() / 100.0,
        rpm: r0(rec.rpm),
        fuel_flow_gph: (rec.fuel_flow_gph * 100.0).round() / 100.0,
        power_percent: r1(pwr),
        specific_range: if specific_range.is_nan() { f64::NAN } else { r1(specific_range) },
        cht: rec.cht.iter().map(|v| if v.is_nan() { 0.0 } else { r0(*v) }).collect(),
        cht_max: if cht_max.is_infinite() { f64::NAN } else { r0(cht_max) },
        cht_avg: r1(cht_avg),
        cht_spread: if cht_spread.is_nan() { f64::NAN } else { r0(cht_spread) },
        egt: rec.egt.iter().map(|v| if v.is_nan() { 0.0 } else { r0(*v) }).collect(),
        egt_spread: if egt_spread.is_nan() { f64::NAN } else { r0(egt_spread) },
        fqty_total: r1(rec.fqty_total),
    }
}

// ── CSV column helpers ────────────────────────────────────────────────────────

fn find_col(headers: &[String], candidates: &[&str]) -> Option<usize> {
    for c in candidates {
        if let Some(i) = headers.iter().position(|h| h == c) {
            return Some(i);
        }
    }
    None
}

fn get_f64(cols: &[&str], idx: usize) -> f64 {
    cols.get(idx)
        .map(|s| s.trim().parse::<f64>().unwrap_or(f64::NAN))
        .unwrap_or(f64::NAN)
}

// ── Public entry point ────────────────────────────────────────────────────────

#[wasm_bindgen]
pub fn process_csv(csv_data: &str, _max_hp: f64) -> JsValue {
    let mut result = ProcessingResult {
        steady_state_blocks: Vec::new(),
        total_records: 0,
        skipped_records: 0,
        error: None,
    };

    let lines: Vec<&str> = csv_data.lines().collect();
    if lines.is_empty() {
        result.error = Some("Empty CSV file".to_string());
        return serde_wasm_bindgen::to_value(&result).unwrap();
    }

    // Find the short-name header row (contains "Lcl Date" or similar)
    let mut header_idx = None;
    let mut headers: Vec<String> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let cols: Vec<&str> = line.split(',').collect();
        if cols.iter().any(|c| {
            let t = c.trim();
            t == "Lcl Date" || t == "UTCDate" || t == "Date" || t == "Lcl_Date"
        }) {
            header_idx = Some(i);
            headers = cols.iter().map(|c| c.trim().to_string()).collect();
            break;
        }
    }

    let header_idx = match header_idx {
        Some(i) => i,
        None => {
            result.error = Some("Cannot find header row (expected 'Lcl Date' column)".to_string());
            return serde_wasm_bindgen::to_value(&result).unwrap();
        }
    };

    // Column resolution — prefer G3X pre-computed values
    let date_col = find_col(&headers, &["Lcl Date", "UTCDate", "Date", "Lcl_Date"]);
    let time_col = find_col(&headers, &["Lcl Time", "UTCTime", "Time", "Lcl_Time"]);

    // AltP = pressure altitude (G3X short name); fall back to others
    let pres_alt_col = find_col(&headers, &["AltP", "AltB", "BaroAlt", "AltMSL", "AltInd"]);
    // AltD = density altitude pre-computed by G3X (optional)
    let da_col = find_col(&headers, &["AltD"]);
    // TAS pre-computed by G3X (optional)
    let tas_col = find_col(&headers, &["TAS"]);

    let oat_col = find_col(&headers, &["OAT"]);
    let ias_col = find_col(&headers, &["IAS"]);
    let gnd_spd_col = find_col(&headers, &["GndSpd"]);
    let pitch_col = find_col(&headers, &["Pitch"]);
    let roll_col = find_col(&headers, &["Roll"]);
    let map_col = find_col(&headers, &["E1 MAP", "MAP"]);
    let rpm_col = find_col(&headers, &["E1 RPM", "RPM"]);
    let fflow_col = find_col(&headers, &["E1 FFlow", "Fflow GPH", "FFlow", "E1 Fflow"]);
    let pwr_col = find_col(&headers, &["E1 %Pwr", "%Pwr", "E1 Pwr"]);
    let fqty1_col = find_col(&headers, &["FQty1", "FuelQtyL"]);
    let fqty2_col = find_col(&headers, &["FQty2", "FuelQtyR"]);

    // CHT and EGT — up to 6 cylinders
    let cht_cols: Vec<usize> = (1..=6)
        .filter_map(|i| find_col(&headers, &[&format!("E1 CHT{}", i), &format!("CHT{}", i)]))
        .collect();
    let egt_cols: Vec<usize> = (1..=6)
        .filter_map(|i| find_col(&headers, &[&format!("E1 EGT{}", i), &format!("EGT{}", i)]))
        .collect();

    // Validate required columns
    let required: &[(&str, &Option<usize>)] = &[
        ("AltP/pressure altitude", &pres_alt_col),
        ("OAT", &oat_col),
        ("IAS", &ias_col),
        ("GndSpd", &gnd_spd_col),
        ("Pitch", &pitch_col),
        ("Roll", &roll_col),
        ("E1 MAP", &map_col),
        ("E1 RPM", &rpm_col),
        ("E1 FFlow", &fflow_col),
    ];
    for (name, col) in required {
        if col.is_none() {
            result.error = Some(format!("Missing required column: {}", name));
            return serde_wasm_bindgen::to_value(&result).unwrap();
        }
    }

    let pres_alt_col = pres_alt_col.unwrap();
    let oat_col = oat_col.unwrap();
    let ias_col = ias_col.unwrap();
    let gnd_spd_col = gnd_spd_col.unwrap();
    let pitch_col = pitch_col.unwrap();
    let roll_col = roll_col.unwrap();
    let map_col = map_col.unwrap();
    let rpm_col = rpm_col.unwrap();
    let fflow_col = fflow_col.unwrap();

    // Parse data rows
    let mut records: Vec<G3xRecord> = Vec::new();
    let mut skipped = 0usize;

    for line in &lines[header_idx + 1..] {
        if line.trim().is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split(',').collect();

        let pres_alt = get_f64(&cols, pres_alt_col);
        let oat = get_f64(&cols, oat_col);
        let ias = get_f64(&cols, ias_col);
        let map_inhg = get_f64(&cols, map_col);
        let rpm = get_f64(&cols, rpm_col);

        if pres_alt.is_nan() || oat.is_nan() || ias.is_nan() || ias < 50.0
            || map_inhg.is_nan() || rpm.is_nan() || rpm < 500.0
        {
            skipped += 1;
            continue;
        }

        let timestamp = match (date_col, time_col) {
            (Some(dc), Some(tc)) => format!(
                "{} {}",
                cols.get(dc).unwrap_or(&"").trim(),
                cols.get(tc).unwrap_or(&"").trim()
            ),
            _ => String::new(),
        };

        let fqty1 = fqty1_col.map(|i| get_f64(&cols, i)).unwrap_or(0.0);
        let fqty2 = fqty2_col.map(|i| get_f64(&cols, i)).unwrap_or(0.0);

        records.push(G3xRecord {
            timestamp,
            pres_alt,
            ias,
            tas: tas_col.map(|i| get_f64(&cols, i)).unwrap_or(f64::NAN),
            oat,
            da: da_col.map(|i| get_f64(&cols, i)).unwrap_or(f64::NAN),
            gnd_spd: get_f64(&cols, gnd_spd_col),
            pitch: get_f64(&cols, pitch_col),
            roll: get_f64(&cols, roll_col),
            map_inhg,
            rpm,
            fuel_flow_gph: get_f64(&cols, fflow_col),
            pwr_pct: pwr_col.map(|i| get_f64(&cols, i)).unwrap_or(f64::NAN),
            fqty_total: fqty1 + fqty2,
            cht: cht_cols.iter().map(|&i| get_f64(&cols, i)).collect(),
            egt: egt_cols.iter().map(|&i| get_f64(&cols, i)).collect(),
        });
    }

    result.total_records = records.len();
    result.skipped_records = skipped;

    if records.len() < WINDOW_SECONDS {
        result.error = Some(format!(
            "Insufficient in-flight records: {} (need at least {})",
            records.len(),
            WINDOW_SECONDS
        ));
        return serde_wasm_bindgen::to_value(&result).unwrap();
    }

    // Sliding window steady-state detection
    let mut in_steady = false;
    let mut block_start = 0usize;

    for i in WINDOW_SECONDS..=records.len() {
        let window = &records[i - WINDOW_SECONDS..i];
        let steady = is_steady_state(window);

        if steady && !in_steady {
            in_steady = true;
            block_start = i - WINDOW_SECONDS;
        } else if !steady && in_steady {
            in_steady = false;
            let block = &records[block_start..i - 1];
            result.steady_state_blocks.push(build_result(&average_block(block)));
        }
    }

    if in_steady {
        let block = &records[block_start..];
        result.steady_state_blocks.push(build_result(&average_block(block)));
    }

    serde_wasm_bindgen::to_value(&result).unwrap()
}

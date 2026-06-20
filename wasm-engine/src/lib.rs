use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

// Steady-state tolerances (180-second sliding window)
const WINDOW_SECONDS: usize = 180;
const ALT_TOL: f64 = 100.0;  // ±50 ft => range of 100 ft
const IAS_TOL: f64 = 4.0;    // ±2 kts => range of 4 kts
const RPM_TOL: f64 = 40.0;   // ±20 RPM => range of 40 RPM
const MAP_TOL: f64 = 0.4;    // ±0.2 InHg => range of 0.4
const ROLL_MAX: f64 = 3.0;   // absolute value max

#[derive(Debug, Clone, Serialize, Deserialize)]
struct G3xRecord {
    timestamp: String,
    baro_alt: f64,
    oat: f64,
    ias: f64,
    gnd_spd: f64,
    pitch: f64,
    roll: f64,
    map_inhg: f64,
    rpm: f64,
    fuel_flow_gph: f64,
    pwr_pct: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SteadyStateResult {
    pub timestamp: String,
    pub baro_alt: f64,
    pub oat: f64,
    pub ias: f64,
    pub gnd_spd: f64,
    pub pitch: f64,
    pub roll: f64,
    pub map_inhg: f64,
    pub rpm: f64,
    pub fuel_flow_gph: f64,
    pub pressure_altitude: f64,
    pub density_altitude: f64,
    pub tas: f64,
    pub power_percent: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProcessingResult {
    pub steady_state_blocks: Vec<SteadyStateResult>,
    pub total_records: usize,
    pub skipped_records: usize,
    pub error: Option<String>,
}

fn isa_temp(pressure_alt: f64) -> f64 {
    15.0 - 0.0019812 * pressure_alt
}

fn density_altitude(pressure_alt: f64, oat: f64) -> f64 {
    pressure_alt + 118.8 * (oat - isa_temp(pressure_alt))
}

fn tas_from_ias(ias: f64, pressure_alt: f64, oat: f64) -> f64 {
    // sigma = (P/P_SL) * (T_SL/T)
    let t = oat + 273.15;
    let t_sl = 288.15_f64;
    let p_ratio = (1.0 - 6.8755856e-6 * pressure_alt).powf(5.2558797);
    let sigma = p_ratio * (t_sl / t);
    ias / sigma.sqrt()
}

fn ambient_pressure_inhg(pressure_alt: f64) -> f64 {
    // P = 29.92 * (1 - 6.8755856e-6 * Hp)^5.2558797
    29.92 * (1.0 - 6.8755856e-6 * pressure_alt).powf(5.2558797)
}

fn check_range(values: &[f64], max_range: f64) -> bool {
    let min = values.iter().cloned().fold(f64::INFINITY, f64::min);
    let max = values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    (max - min) <= max_range
}

fn is_steady_state(window: &[G3xRecord]) -> bool {
    if window.len() < WINDOW_SECONDS {
        return false;
    }
    let alts: Vec<f64> = window.iter().map(|r| r.baro_alt).collect();
    let iass: Vec<f64> = window.iter().map(|r| r.ias).collect();
    let rpms: Vec<f64> = window.iter().map(|r| r.rpm).collect();
    let maps: Vec<f64> = window.iter().map(|r| r.map_inhg).collect();

    check_range(&alts, ALT_TOL)
        && check_range(&iass, IAS_TOL)
        && check_range(&rpms, RPM_TOL)
        && check_range(&maps, MAP_TOL)
        && window.iter().all(|r| r.roll.abs() <= ROLL_MAX)
}

fn average_record(records: &[G3xRecord]) -> G3xRecord {
    let n = records.len() as f64;
    let sum = records.iter().fold(
        (0.0_f64, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0),
        |acc, r| {
            (
                acc.0 + r.baro_alt,
                acc.1 + r.oat,
                acc.2 + r.ias,
                acc.3 + r.gnd_spd,
                acc.4 + r.pitch,
                acc.5 + r.roll,
                acc.6 + r.map_inhg,
                acc.7 + r.rpm,
                acc.8 + r.fuel_flow_gph,
                acc.9 + r.pwr_pct,
            )
        },
    );
    G3xRecord {
        timestamp: records[records.len() / 2].timestamp.clone(),
        baro_alt: sum.0 / n,
        oat: sum.1 / n,
        ias: sum.2 / n,
        gnd_spd: sum.3 / n,
        pitch: sum.4 / n,
        roll: sum.5 / n,
        map_inhg: sum.6 / n,
        rpm: sum.7 / n,
        fuel_flow_gph: sum.8 / n,
        pwr_pct: sum.9 / n,
    }
}

fn build_result(rec: &G3xRecord, max_hp_kw: f64) -> SteadyStateResult {
    let hp = rec.baro_alt;
    let hd = density_altitude(hp, rec.oat);
    let tas = tas_from_ias(rec.ias, hp, rec.oat);
    let ambient_p = ambient_pressure_inhg(hp);

    // Use logged %Pwr if available; otherwise derive from MAP ratio to ambient
    let power_percent = if rec.pwr_pct > 0.0 {
        rec.pwr_pct
    } else if max_hp_kw > 0.0 {
        // Approximate WOT % from MAP vs ambient: only valid for normally aspirated
        (rec.map_inhg / ambient_p * 100.0).min(100.0)
    } else {
        (rec.map_inhg / ambient_p * 100.0).min(100.0)
    };

    SteadyStateResult {
        timestamp: rec.timestamp.clone(),
        baro_alt: (rec.baro_alt * 10.0).round() / 10.0,
        oat: (rec.oat * 10.0).round() / 10.0,
        ias: (rec.ias * 10.0).round() / 10.0,
        gnd_spd: (rec.gnd_spd * 10.0).round() / 10.0,
        pitch: (rec.pitch * 10.0).round() / 10.0,
        roll: (rec.roll * 10.0).round() / 10.0,
        map_inhg: (rec.map_inhg * 100.0).round() / 100.0,
        rpm: rec.rpm.round(),
        fuel_flow_gph: (rec.fuel_flow_gph * 100.0).round() / 100.0,
        pressure_altitude: (hp).round(),
        density_altitude: (hd).round(),
        tas: (tas * 10.0).round() / 10.0,
        power_percent: (power_percent * 10.0).round() / 10.0,
    }
}

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

#[wasm_bindgen]
pub fn process_csv(csv_data: &str, max_hp: f64) -> JsValue {
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

    // Locate header row — first row containing a date/time field
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

    let date_col = find_col(&headers, &["Lcl Date", "UTCDate", "Date", "Lcl_Date"]);
    let time_col = find_col(&headers, &["Lcl Time", "UTCTime", "Time", "Lcl_Time"]);
    let baro_alt_col = find_col(&headers, &["AltB", "BaroAlt", "AltMSL"]);
    let oat_col = find_col(&headers, &["OAT"]);
    let ias_col = find_col(&headers, &["IAS"]);
    let gnd_spd_col = find_col(&headers, &["GndSpd"]);
    let pitch_col = find_col(&headers, &["Pitch"]);
    let roll_col = find_col(&headers, &["Roll"]);
    let map_col = find_col(&headers, &["E1 MAP", "MAP"]);
    let rpm_col = find_col(&headers, &["E1 RPM", "RPM"]);
    let fflow_col = find_col(&headers, &["E1 FFlow", "Fflow GPH", "FFlow", "E1 Fflow"]);
    let pwr_col = find_col(&headers, &["E1 %Pwr", "%Pwr", "E1 Pwr"]);

    // Validate required columns
    let required: &[(&str, &Option<usize>)] = &[
        ("AltB/BaroAlt", &baro_alt_col),
        ("OAT", &oat_col),
        ("IAS", &ias_col),
        ("GndSpd", &gnd_spd_col),
        ("Pitch", &pitch_col),
        ("Roll", &roll_col),
        ("E1 MAP", &map_col),
        ("E1 RPM", &rpm_col),
        ("E1 FFlow/Fflow GPH", &fflow_col),
    ];
    for (name, col) in required {
        if col.is_none() {
            result.error = Some(format!("Missing required column: {}", name));
            return serde_wasm_bindgen::to_value(&result).unwrap();
        }
    }

    let baro_alt_col = baro_alt_col.unwrap();
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
        if cols.len() <= baro_alt_col {
            skipped += 1;
            continue;
        }

        let baro_alt = get_f64(&cols, baro_alt_col);
        let oat = get_f64(&cols, oat_col);
        let ias = get_f64(&cols, ias_col);
        let map_inhg = get_f64(&cols, map_col);
        let rpm = get_f64(&cols, rpm_col);

        // Skip rows with missing critical values or clearly on ground (IAS < 50 kts)
        if baro_alt.is_nan() || oat.is_nan() || ias.is_nan() || ias < 50.0
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

        records.push(G3xRecord {
            timestamp,
            baro_alt,
            oat,
            ias,
            gnd_spd: get_f64(&cols, gnd_spd_col),
            pitch: get_f64(&cols, pitch_col),
            roll: get_f64(&cols, roll_col),
            map_inhg,
            rpm,
            fuel_flow_gph: get_f64(&cols, fflow_col),
            pwr_pct: pwr_col.map(|i| get_f64(&cols, i)).unwrap_or(f64::NAN),
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
            // Average the entire steady block
            let block = &records[block_start..i - 1];
            let rep = average_record(block);
            result.steady_state_blocks.push(build_result(&rep, max_hp));
        }
    }

    // Capture block that reaches end of data
    if in_steady {
        let block = &records[block_start..];
        let rep = average_record(block);
        result.steady_state_blocks.push(build_result(&rep, max_hp));
    }

    serde_wasm_bindgen::to_value(&result).unwrap()
}

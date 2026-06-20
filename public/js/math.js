// Pure atmospheric math — no imports, works in browser and Node.js alike.

export const ISA_LAPSE_RATE = 0.0019812; // °C/ft

export function isaTemp(pressureAltFt) {
  return 15 - ISA_LAPSE_RATE * pressureAltFt;
}

// Design spec: Hd = Hp + 118.8 * (OAT - ISA_temp)
export function densityAltitude(pressureAltFt, oatC) {
  return pressureAltFt + 118.8 * (oatC - isaTemp(pressureAltFt));
}

// TAS from IAS using air density ratio sigma = (P/P_SL) * (T_SL/T)
export function tasFromIas(iasKts, pressureAltFt, oatC) {
  const t = oatC + 273.15;
  const tSL = 288.15;
  const pRatio = Math.pow(1 - 6.8755856e-6 * pressureAltFt, 5.2558797);
  const sigma = pRatio * (tSL / t);
  return iasKts / Math.sqrt(sigma);
}

// Standard atmospheric pressure at a given pressure altitude (InHg)
export function ambientPressure(pressureAltFt) {
  return 29.92 * Math.pow(1 - 6.8755856e-6 * pressureAltFt, 5.2558797);
}

// nm/gal — uses ground speed so wind is accounted for
export function specificRange(groundSpeedKts, fuelFlowGph) {
  if (!fuelFlowGph || fuelFlowGph < 0.1) return null;
  return groundSpeedKts / fuelFlowGph;
}

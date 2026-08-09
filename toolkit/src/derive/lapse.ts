/* Lapse rate between two points of a sounding. Negative means temperature
   falls with height. Profiles publish no lapse fields; this is the one
   home for that arithmetic. */

export interface TemperatureSample {
  heightM: number;
  temperatureC: number;
}

const METRES_PER_1000_FT = 304.8;

/** Lapse rate in degC per km between two samples; null for a zero-thickness layer. */
export function lapseRateCPerKm(
  lower: TemperatureSample,
  upper: TemperatureSample,
): number | null {
  const thicknessM = upper.heightM - lower.heightM;
  if (thicknessM === 0) return null;
  return ((upper.temperatureC - lower.temperatureC) / thicknessM) * 1000;
}

/**
 * Lapse rate in degC per 1000 ft — the unit of the stability-class table.
 * Per-level arithmetic: (dT / dz) * 304.8.
 */
export function lapseRateCPer1000Ft(
  lower: TemperatureSample,
  upper: TemperatureSample,
): number | null {
  const perKm = lapseRateCPerKm(lower, upper);
  return perKm === null ? null : perKm * (METRES_PER_1000_FT / 1000);
}

/**
 * Surface-to-first-level lapse (degC per 1000 ft): the 2 m temperature at
 * model elevation against the first retained level. Null when the first
 * level does not sit above model elevation.
 */
export function surfaceLapseCPer1000Ft(
  surfaceTemperatureC: number,
  modelElevationM: number,
  firstLevel: TemperatureSample,
): number | null {
  if (firstLevel.heightM <= modelElevationM) return null;
  return lapseRateCPer1000Ft(
    { heightM: modelElevationM, temperatureC: surfaceTemperatureC },
    firstLevel,
  );
}

/** Surface-to-first-level lapse in degC per km; same guard as the 1000 ft variant. */
export function surfaceLapseCPerKm(
  surfaceTemperatureC: number,
  modelElevationM: number,
  firstLevel: TemperatureSample,
): number | null {
  if (firstLevel.heightM <= modelElevationM) return null;
  return lapseRateCPerKm(
    { heightM: modelElevationM, temperatureC: surfaceTemperatureC },
    firstLevel,
  );
}

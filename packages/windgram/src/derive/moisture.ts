/* Moisture conversions over the Magnus form of saturation vapour pressure,
   with the Alduchov & Eskridge (1996) coefficients (a = 17.625,
   b = 243.04 degC) — accurate to well under 0.1 degC over -40..+50 degC. The
   saturation-pressure scale factor cancels in every ratio, so only the
   exponent matters here. */

const MAGNUS_A = 17.625;
const MAGNUS_B_C = 243.04;

function magnusGamma(temperatureC: number): number {
  return (MAGNUS_A * temperatureC) / (MAGNUS_B_C + temperatureC);
}

/**
 * Relative humidity (%) from temperature and dew point:
 * RH = 100 * e_s(Td) / e_s(T). Clamped to at most 100 so data noise with
 * Td slightly above T cannot report supersaturation.
 */
export function relativeHumidityPercent(temperatureC: number, dewPointC: number): number {
  return Math.min(100, 100 * Math.exp(magnusGamma(dewPointC) - magnusGamma(temperatureC)));
}

/**
 * Dew point (degC) from temperature and relative humidity, inverting the
 * Magnus form. RH above 100 is clamped to 100 (returning exactly the
 * temperature); RH of zero or below has no dew point and returns NaN.
 */
export function dewPointC(temperatureC: number, relativeHumidityPercent: number): number {
  if (!(relativeHumidityPercent > 0)) return Number.NaN;
  const gamma =
    Math.log(Math.min(100, relativeHumidityPercent) / 100) + magnusGamma(temperatureC);
  return (MAGNUS_B_C * gamma) / (MAGNUS_A - gamma);
}

/** Dew-point depression (degC): T minus Td. Negative means supersaturated data. */
export function dewPointDepressionC(temperatureC: number, dewPointC: number): number {
  return temperatureC - dewPointC;
}

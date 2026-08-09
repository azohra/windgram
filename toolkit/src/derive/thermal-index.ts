import type { TemperatureSample } from "./lapse.js";

/**
 * Dry adiabatic lapse in degC per metre — the same constant the pipeline
 * uses to lift the surface parcel for boundary-layer top.
 */
export const DRY_ADIABATIC_LAPSE_C_PER_M = 0.0098;

/**
 * Thermal index (TI) at one level: the environment temperature minus a
 * surface parcel lifted dry-adiabatically from model elevation,
 *
 *   TI = T_level − (T_surface − 0.0098 × (z_level − z_surface))
 *
 * RASP sign convention: negative TI means the parcel is still warmer than
 * the environment at that height (thermals reach it); TI crossing zero is
 * where dry thermals stop.
 */
export function thermalIndexC(args: {
  surfaceTemperatureC: number;
  surfaceElevationM: number;
  level: TemperatureSample;
}): number {
  const parcelC =
    args.surfaceTemperatureC -
    DRY_ADIABATIC_LAPSE_C_PER_M * (args.level.heightM - args.surfaceElevationM);
  return args.level.temperatureC - parcelC;
}

/** TI per level for a whole profile hour, in the levels' published order. */
export function thermalIndexProfile(
  surfaceTemperatureC: number,
  surfaceElevationM: number,
  levels: readonly TemperatureSample[],
): Array<{ heightM: number; thermalIndexC: number }> {
  return levels.map((level) => ({
    heightM: level.heightM,
    thermalIndexC: thermalIndexC({ surfaceTemperatureC, surfaceElevationM, level }),
  }));
}

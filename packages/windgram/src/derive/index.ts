/* derive/ — pure functions of published state. Everything here needs only
   the profile JSON; anything needing raw model fields or cross-run authority
   (W*, BL top, cloud base, usable-lift top) lives in the pipeline and is
   never recomputed here (the one-home rule). The one deliberate re-run is
   usableLiftTopM: the pipeline's published value stays authoritative at the
   default 1.0 m/s sink rate (tests assert exact parity), and the same
   derivation exposed here — over published inputs only — lets a renderer
   answer other sink rates without republishing anything.

   Every function takes plain numbers. To run one against an ensemble
   profile, select the median first with p50. */

export { p50 } from "./ensemble.js";
export { dewPointC, dewPointDepressionC, relativeHumidityPercent } from "./moisture.js";
export {
  componentsToWind,
  msToKmh,
  normalizeDegrees,
  windToComponents,
  type WindComponents,
} from "./wind.js";
export {
  lapseRateCPer1000Ft,
  lapseRateCPerKm,
  surfaceLapseCPer1000Ft,
  surfaceLapseCPerKm,
  type TemperatureSample,
} from "./lapse.js";
export {
  stabilityClass,
  WINDGRAM_STABILITY_CLASSES,
  type StabilityClassName,
} from "./stability.js";
export {
  DRY_ADIABATIC_LAPSE_C_PER_M,
  thermalIndexC,
  thermalIndexProfile,
} from "./thermal-index.js";
export {
  buoyancyShearRatio,
  surfaceToBoundaryLayerShearMs,
  vectorShearMs,
  type WindSample,
} from "./shear.js";
export { usableLiftTopM, type UsableLiftInputs } from "./usable-lift.js";
export {
  groupByLocalDay,
  localDateKey,
  localHourOfDay,
  windgramDisplayHours,
  type DayWindowOptions,
} from "./day-window.js";
export { smooth121 } from "./smoothing.js";

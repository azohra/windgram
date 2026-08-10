/* derive/ — pure functions of published state. Everything here needs only
   the profile JSON. The pipeline publishes the authoritative W*, boundary-
   layer top, cloud base, and default usable-lift top. usableLiftTopM projects
   the published inputs at another sink rate without changing that document;
   its 1.0 m/s result matches the published value.

   Every derivation takes plain numbers; to run one against an ensemble
   profile, select the median first with p50. The document-shaped helpers
   (day windowing, projectProfile, alignByValidAt) subtract and join whole
   documents without touching the values inside — quantities out, never
   claims (statements with evidence live in windgram/analyze). */

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
export {
  projectProfile,
  type ProjectProfileOptions,
  type ProjectedWindgramHour,
  type ProjectedWindgramProfile,
} from "./project.js";
export { alignByValidAt, type AlignedHours } from "./align.js";
export {
  cosSolarZenith,
  isSmokeAwareProfile,
  SMOKE_MASS_EXTINCTION_M2_PER_G,
  SMOKE_TRANSMITTANCE_K_MIDDAY,
  SMOKE_TRANSMITTANCE_K_VERTICAL,
  smokeAdjustedThermalVelocityMs,
  smokeAotFromColumn,
  smokeHoursByValidAt,
  smokeTransmittance,
} from "./smoke.js";

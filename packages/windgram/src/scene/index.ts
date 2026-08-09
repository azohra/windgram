/* scene/ — the headless renderer core: (profile, options) -> typed scene
   graph. Pure data out, no DOM; the svg/ serializer and app-side interactive
   layers both consume it, so tooltips and pixels can never disagree. */

export { buildScene, M_TO_FT } from "./scene.js";
export {
  buildKeySpec,
  type KeySpec,
  type KeySpecOptions,
  type KeySeriesEntry,
  type KeyStabilityClass,
  type KeyStabilityGroup,
} from "./key.js";

// msToKmh moved to windgram/derive in 0.3.0; its deprecated re-export here
// departed in 0.4.0 as the 0.3.x JSDoc promised.
export { cursorReading, xForHour, yForAltitude, altitudeForY, hourIndexForX } from "./hit-test.js";
export {
  interpolateVertical,
  sampledFieldPaths,
  type FieldBanding,
  type FieldNode,
} from "./field.js";
export { BARB_GLYPH_RADIUS, windBarbParts, windBarbPaths, type WindBarbParts } from "./barbs.js";
export { curvedPath, pointPath, bandPath, short, type PlotPoint } from "./path.js";
export {
  DEFAULT_CAPE_CLASSES,
  DEFAULT_OVERLAYS,
  type AltitudeTick,
  type BarbPlacement,
  type CapeClassThresholds,
  type CursorReading,
  type FieldLayer,
  type GustMark,
  type HourSampling,
  type HourTick,
  type MetricStrip,
  type OverlayName,
  type PressureAltitudeTick,
  type SceneGraph,
  type SceneLabel,
  type SceneMarker,
  type SceneOptions,
  type SceneScales,
  type SeriesElement,
  type MarkerTrainStride,
  type StripCell,
  type StripRow,
  type SurfaceTemperatureMark,
} from "./types.js";

/* scene/ — the headless renderer core: (profile, options) -> typed scene
   graph. Pure data out, no DOM; the svg/ serializer and app-side interactive
   layers both consume it, so tooltips and pixels can never disagree. */

export { buildScene, M_TO_FT } from "./scene.js";

import { msToKmh as deriveMsToKmh } from "../derive/wind.js";
/**
 * @deprecated Moved to `windgram/derive` in 0.3.0 — it is a pure unit
 * conversion, not scene geometry. This re-export keeps existing imports
 * working through 0.3.x and departs in 0.4; import from `windgram/derive`.
 */
export const msToKmh: typeof deriveMsToKmh = deriveMsToKmh;
export { cursorReading, xForHour, yForAltitude, altitudeForY, hourIndexForX } from "./hit-test.js";
export { interpolateVertical, sampledFieldPaths, type FieldNode } from "./field.js";
export { windBarbParts, windBarbPaths, type WindBarbParts } from "./barbs.js";
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
  type StripCell,
  type StripRow,
} from "./types.js";

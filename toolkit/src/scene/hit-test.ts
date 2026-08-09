import { componentsToWind } from "../derive/wind.js";
import { stabilityClass } from "../derive/stability.js";
import { interpolateVertical } from "./field.js";
import type { BarbPlacement, CursorReading, SceneGraph } from "./types.js";

/* Value-at-cursor hit-testing: the whole point over a PNG RASP is that an
   hour can be READ, not just eyeballed. App tooltips call these against the
   same scene the SVG was drawn from, so they show exactly the plotted
   numbers. */

/**
 * The mount's bounding rect, in client pixels — structurally what
 * `getBoundingClientRect()` returns, kept structural because the scene
 * layer owns no DOM types.
 */
export interface MountRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Client-pixel position -> scene coordinates, against the rect the scene
 * is mounted in. The x and y factors scale independently, so the mapping
 * stays correct however the rendered element was sized (`widthPx` fits,
 * CSS scaling, non-uniform stretch alike). Null when the rect has no area
 * — a hidden tab's rect measures 0×0, and there is no position in it.
 */
export function clientPointToScene(
  scene: SceneGraph,
  rect: MountRect,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (rect.width === 0 || rect.height === 0) return null;
  return {
    x: ((clientX - rect.left) / rect.width) * scene.width,
    y: ((clientY - rect.top) / rect.height) * scene.height,
  };
}

/** Column-centre x for an hour index. */
export function xForHour(scene: SceneGraph, index: number): number {
  return scene.scales.plotLeft + index * scene.scales.columnWidth + scene.scales.columnWidth / 2;
}

export function yForAltitude(scene: SceneGraph, altitudeM: number): number {
  const { plotTop, plotHeight, floorM, topM } = scene.scales;
  return plotTop + plotHeight * (1 - (altitudeM - floorM) / (topM - floorM));
}

export function altitudeForY(scene: SceneGraph, y: number): number {
  const { plotTop, plotHeight, floorM, topM } = scene.scales;
  return topM - ((y - plotTop) / plotHeight) * (topM - floorM);
}

/**
 * Nearest hour column for a plot x; null outside the plot. With
 * `{ clamp: true }` an x beyond the plot resolves to the nearest edge
 * column instead — the strips-and-margins-still-select behaviour — and
 * only an empty scene returns null.
 */
export function hourIndexForX(
  scene: SceneGraph,
  x: number,
  options: { clamp?: boolean } = {},
): number | null {
  const { plotLeft, plotWidth, columnWidth, hourCount } = scene.scales;
  if (hourCount === 0) return null;
  if (!options.clamp && (x < plotLeft || x > plotLeft + plotWidth)) return null;
  return Math.min(hourCount - 1, Math.max(0, Math.floor((x - plotLeft) / columnWidth)));
}

/**
 * The rendered hour index whose `validAt` names the same instant; null
 * when the scene renders no such hour. Instants compare as timestamps,
 * not strings, so `"...T18:00:00Z"` and `"...T18:00:00+00:00"` agree.
 *
 * This is the pin-carry primitive: a selection keyed by `validAt`
 * survives a rebuild that renumbers the hour window (another day, a
 * shorter-horizon model), where an index-keyed selection silently moves
 * to a different hour. Carry a pin by storing its `validAt` and asking
 * the NEW scene for the index — a null answer means the pinned hour is
 * not in the new window, and the consumer decides what that means.
 */
export function hourIndexForValidAt(scene: SceneGraph, validAt: string | Date): number | null {
  const ms = validAt instanceof Date ? validAt.getTime() : Date.parse(validAt);
  if (Number.isNaN(ms)) return null;
  const index = scene.hourValidAts.findIndex((candidate) => Date.parse(candidate) === ms);
  return index === -1 ? null : index;
}

/**
 * Fractional x for an instant — sub-hour positioning for time cursors and
 * solar ticks, where `xForHour` only knows column centres. Piecewise
 * linear between adjacent hour centres; beyond the first or last centre
 * the end segment's rate extends across the edge half-column, never past
 * the plot frame. Instants outside the frame return null by default;
 * `{ clamp: true }` pins them to the frame edge instead (a shading band
 * from "before the window" honestly starts at the plot's edge). Null for
 * an empty scene or an unparseable instant; a single-hour scene has no
 * time scale, so only its own instant (its column centre) resolves.
 */
export function xForTime(
  scene: SceneGraph,
  validAt: string | Date,
  options: { clamp?: boolean } = {},
): number | null {
  const { plotLeft, plotWidth, hourCount } = scene.scales;
  const ms = validAt instanceof Date ? validAt.getTime() : Date.parse(validAt);
  if (Number.isNaN(ms) || hourCount === 0) return null;
  const times = scene.hourValidAts.map((candidate) => Date.parse(candidate));
  if (hourCount === 1) {
    return ms === times[0] || options.clamp ? xForHour(scene, 0) : null;
  }
  /* The segment the instant falls in; the end segments extrapolate. */
  const found = times.findIndex((time) => time >= ms);
  const upper = Math.min(hourCount - 1, Math.max(1, found === -1 ? hourCount - 1 : found));
  const lower = upper - 1;
  const fraction = (ms - times[lower]) / (times[upper] - times[lower]);
  const x =
    xForHour(scene, lower) + fraction * (xForHour(scene, upper) - xForHour(scene, lower));
  if (options.clamp) return Math.min(plotLeft + plotWidth, Math.max(plotLeft, x));
  return x < plotLeft || x > plotLeft + plotWidth ? null : x;
}

/**
 * The barbs actually drawn in one hour's column — surface first, then
 * levels bottom-up, exactly as rendered: the barb stride and the min-gap
 * thinning have already been applied, so an hour the stride skipped (or a
 * scene with the wind overlay off) is empty. This is the discrete ladder
 * an inspector snaps to; `cursorReading` interpolates the continuous
 * column instead, and the two answer different questions.
 */
export function drawnBarbsForHour(
  scene: SceneGraph,
  hourIndex: number,
): ReadonlyArray<BarbPlacement> {
  return scene.barbs.filter((barb) => barb.hourIndex === hourIndex);
}

/**
 * The drawn barb nearest a scene y within one hour's column — the
 * "nearest drawn wind level" a pointer or keyboard selection lands on.
 * Ties keep the lower barb (the surface wins over a level at equal
 * distance). Null when the hour drew no barbs. Resolve the hour first
 * (`hourIndexForX` with clamp for pointer work), then snap:
 * `nearestDrawnBarb(scene, hour, point.y)`.
 */
export function nearestDrawnBarb(
  scene: SceneGraph,
  hourIndex: number,
  y: number,
): BarbPlacement | null {
  let nearest: BarbPlacement | null = null;
  for (const barb of scene.barbs) {
    if (barb.hourIndex !== hourIndex) continue;
    if (nearest === null || Math.abs(barb.y - y) < Math.abs(nearest.y - y)) nearest = barb;
  }
  return nearest;
}

/**
 * Interpolated column values under a cursor position (scene px). Null when
 * the cursor is outside the plot; individual quantities are null where the
 * column has no data at that altitude (e.g. above the top level, or a model
 * without levels at all).
 */
export function cursorReading(scene: SceneGraph, x: number, y: number): CursorReading | null {
  const { plotTop, plotHeight } = scene.scales;
  const hourIndex = hourIndexForX(scene, x);
  if (hourIndex === null || y < plotTop || y > plotTop + plotHeight) return null;
  const sampling = scene.sampling[hourIndex];
  const altitudeM = altitudeForY(scene, y);

  const temperatureC = interpolateVertical(sampling.temperatureC, altitudeM);
  const dewPointC = interpolateVertical(sampling.dewPointC, altitudeM);
  const lapse = interpolateVertical(sampling.lapseCPer1000Ft, altitudeM);
  const uMs = interpolateVertical(sampling.windU, altitudeM);
  const vMs = interpolateVertical(sampling.windV, altitudeM);
  const wind = uMs === null || vMs === null ? null : componentsToWind(uMs, vMs);

  return {
    hourIndex,
    validAt: sampling.validAt,
    altitudeM,
    temperatureC,
    dewPointC,
    dewPointDepressionC:
      temperatureC === null || dewPointC === null ? null : temperatureC - dewPointC,
    relativeHumidityPercent: interpolateVertical(sampling.relativeHumidityPercent, altitudeM),
    lapseCPer1000Ft: lapse,
    stabilityClassName: lapse === null ? null : stabilityClass(lapse),
    thermalIndexC: interpolateVertical(sampling.thermalIndexC, altitudeM),
    windSpeedMs: wind === null ? null : wind.speedMs,
    windDirectionDeg: wind === null ? null : wind.directionDeg,
    verticalVelocityPaS: interpolateVertical(sampling.verticalVelocityPaS, altitudeM),
  };
}

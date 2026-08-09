import { componentsToWind } from "../derive/wind.js";
import { stabilityClass } from "../derive/stability.js";
import { interpolateVertical } from "./field.js";
import type { CursorReading, SceneGraph } from "./types.js";

/* Value-at-cursor hit-testing: the whole point over a PNG RASP is that an
   hour can be READ, not just eyeballed. App tooltips call these against the
   same scene the SVG was drawn from, so they show exactly the plotted
   numbers. */

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

/** Nearest hour column for a plot x; null outside the plot. */
export function hourIndexForX(scene: SceneGraph, x: number): number | null {
  const { plotLeft, plotWidth, columnWidth, hourCount } = scene.scales;
  if (hourCount === 0 || x < plotLeft || x > plotLeft + plotWidth) return null;
  return Math.min(hourCount - 1, Math.max(0, Math.floor((x - plotLeft) / columnWidth)));
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

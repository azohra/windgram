import { isEnsembleValue, type Scalar, type WindgramHour, type WindgramProfile } from "../contract/index.js";
import { p50 } from "../derive/ensemble.js";
import { localDateKey } from "../derive/day-window.js";
import type { SceneOptions } from "./types.js";

/* Resolution: profile hours (Scalar positions, ensemble or plain) down to
   the plain-number hours the scene builder draws, plus the hour-windowing
   that decides which of them render. Everything here is selection — no
   geometry, no thresholds. */

export interface ResolvedLevel {
  pressureHpa: number;
  heightM: number;
  temperatureC: number;
  dewPointC: number;
  windSpeedMs: number;
  windDirectionDeg: number;
  verticalVelocityPaS: number | null;
  cloudFractionPercent: number | null;
}

export interface ResolvedHour {
  validAt: string;
  surface: {
    pressurePa: number;
    temperatureC: number;
    dewPointC: number;
    windSpeedMs: number;
    windDirectionDeg: number;
    cloudCoverPercent: number;
    precipitationMmHr: number;
    // Science-wave fields: null where the model does not publish them.
    windGustMs: number | null;
    capeJkg: number | null;
    cinJkg: number | null;
    pblHeightM: number | null;
    lowCloudPercent: number | null;
    midCloudPercent: number | null;
    highCloudPercent: number | null;
  };
  levels: ResolvedLevel[];
  derived: {
    boundaryLayerTopM: number | null;
    thermalVelocityMs: number;
    cloudBaseM: number;
    usableLiftTopM: number | null;
  };
  bands: {
    pressurePa: Band;
    precipitationMmHr: Band;
    cloudCoverPercent: Band;
    capeJkg: Band;
    pblHeightM: Band;
    thermalVelocityMs: Band;
    boundaryLayerTopM: Band;
    cloudBaseM: Band;
    usableLiftTopM: Band;
  };
}

export type Band = { p25: number; p75: number } | null;

export function bandOf(value: Scalar | null | undefined): Band {
  if (value == null || !isEnsembleValue(value)) return null;
  // A full-dropout position has no envelope: percentiles of zero members.
  if (value.p25 === null || value.p75 === null) return null;
  return { p25: value.p25, p75: value.p75 };
}

/* Null when the hour has no renderable state: full ensemble dropout on a
   core surface or derived position means zero members produced the value —
   nothing honest to draw. Levels are filtered the same way individually
   (a level whose core fields lost every member is no level). The
   already-nullable positions (usableLiftTopM, boundaryLayerTopM, the
   optional science fields) flow through as null instead. */
export function resolveHour(hour: WindgramHour): ResolvedHour | null {
  const levels: ResolvedLevel[] = [];
  for (const level of hour.levels) {
    const pressureHpa = p50(level.pressureHpa);
    const heightM = p50(level.heightM);
    const temperatureC = p50(level.temperatureC);
    const dewPointC = p50(level.dewPointC);
    const windSpeedMs = p50(level.windSpeedMs);
    const windDirectionDeg = p50(level.windDirectionDeg);
    if (
      pressureHpa === null ||
      heightM === null ||
      temperatureC === null ||
      dewPointC === null ||
      windSpeedMs === null ||
      windDirectionDeg === null
    ) {
      continue;
    }
    levels.push({
      pressureHpa,
      heightM,
      temperatureC,
      dewPointC,
      windSpeedMs,
      windDirectionDeg,
      verticalVelocityPaS: p50(level.verticalVelocityPaS),
      cloudFractionPercent: p50(level.cloudFractionPercent),
    });
  }
  levels.sort((left, right) => left.heightM - right.heightM);

  const pressurePa = p50(hour.surface.pressurePa);
  const temperatureC = p50(hour.surface.temperatureC);
  const dewPointC = p50(hour.surface.dewPointC);
  const windSpeedMs = p50(hour.surface.windSpeedMs);
  const windDirectionDeg = p50(hour.surface.windDirectionDeg);
  const cloudCoverPercent = p50(hour.surface.cloudCoverPercent);
  const precipitationMmHr = p50(hour.surface.precipitationMmHr);
  const thermalVelocityMs = p50(hour.derived.thermalVelocityMs);
  const cloudBaseM = p50(hour.derived.cloudBaseM);
  if (
    pressurePa === null ||
    temperatureC === null ||
    dewPointC === null ||
    windSpeedMs === null ||
    windDirectionDeg === null ||
    cloudCoverPercent === null ||
    precipitationMmHr === null ||
    thermalVelocityMs === null ||
    cloudBaseM === null
  ) {
    return null;
  }

  return {
    validAt: hour.validAt,
    surface: {
      pressurePa,
      temperatureC,
      dewPointC,
      windSpeedMs,
      windDirectionDeg,
      cloudCoverPercent,
      precipitationMmHr,
      windGustMs: p50(hour.surface.windGustMs),
      capeJkg: p50(hour.surface.capeJkg),
      cinJkg: p50(hour.surface.cinJkg),
      pblHeightM: p50(hour.surface.pblHeightM),
      lowCloudPercent: p50(hour.surface.lowCloudPercent),
      midCloudPercent: p50(hour.surface.midCloudPercent),
      highCloudPercent: p50(hour.surface.highCloudPercent),
    },
    levels,
    derived: {
      boundaryLayerTopM: p50(hour.derived.boundaryLayerTopM),
      thermalVelocityMs,
      cloudBaseM,
      usableLiftTopM: p50(hour.derived.usableLiftTopM),
    },
    bands: {
      pressurePa: bandOf(hour.surface.pressurePa),
      precipitationMmHr: bandOf(hour.surface.precipitationMmHr),
      cloudCoverPercent: bandOf(hour.surface.cloudCoverPercent),
      capeJkg: bandOf(hour.surface.capeJkg),
      pblHeightM: bandOf(hour.surface.pblHeightM),
      thermalVelocityMs: bandOf(hour.derived.thermalVelocityMs),
      boundaryLayerTopM: bandOf(hour.derived.boundaryLayerTopM),
      cloudBaseM: bandOf(hour.derived.cloudBaseM),
      usableLiftTopM: bandOf(hour.derived.usableLiftTopM),
    },
  };
}

/* Windowing options map to indices here, once, so everything downstream of
   buildScene sees exactly what hourIndices consumers see. Precedence
   (documented on SceneOptions): hourIndices is the most explicit form and
   wins; then hours (either shape); absent both, every hour renders. */
export function resolveHourIndices(
  profile: WindgramProfile,
  options: SceneOptions,
): readonly number[] | undefined {
  if (options.hourIndices) return options.hourIndices;
  const hours = options.hours;
  if (hours === undefined) return undefined;
  if (isHourArray(hours)) {
    // Matched by validAt (unique per profile), so pre-windowed hour objects
    // — a groupByLocalDay group, windgramDisplayHours output — select
    // without index bookkeeping. Hours not in the profile are ignored.
    const indexByValidAt = new Map(profile.hours.map((hour, index) => [hour.validAt, index]));
    return hours
      .map((hour) => indexByValidAt.get(hour.validAt))
      .filter((index): index is number => index !== undefined);
  }
  return profile.hours
    .map((hour, index) => index)
    .filter(
      (index) => localDateKey(profile.hours[index].validAt, hours.timeZone) === hours.dateKey,
    );
}

function isHourArray(
  hours: ReadonlyArray<{ validAt: string }> | { timeZone: string; dateKey: string },
): hours is ReadonlyArray<{ validAt: string }> {
  return Array.isArray(hours);
}

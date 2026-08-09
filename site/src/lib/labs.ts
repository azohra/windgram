import { isEnsembleValue, type WindgramProfile } from "windgram/contract";
import {
  componentsToWind,
  p50,
  usableLiftTopM,
  vectorShearMs,
} from "windgram/derive";
import { buildScene, interpolateVertical, type SceneGraph } from "windgram/scene";
import { renderSvg } from "windgram/svg";
import { onlyOverlays } from "./example-windgram";

/* One home for each laboratory's scene recipe, derivation plumbing, and
   readout formatting. An Astro frontmatter/client-script pair cannot share
   module state, but both sides import this module, so the server-rendered
   first frame and every client rebuild come from the same functions. The
   science stays in the windgram package: this module only selects medians
   with p50 and maps package derivations over profile hours. */

/** The scenario data a lab embeds inline for its client script. */
export interface LabScenarioSource {
  profile: WindgramProfile;
  timeZone: string;
}

/** "HH:MM UTC" from a profile hour's validAt. */
export const utcHourLabel = (validAt: string): string => `${validAt.slice(11, 16)} UTC`;

export const formatHeightM = (value: number | null): string =>
  value === null ? "none" : `${Math.round(value)} m`;

export const formatThermalMs = (value: number | null): string =>
  value === null ? "none" : `${value.toFixed(2)} m/s`;

/* Usable-lift laboratory — windgram/derive owns usableLiftTopM; this wrapper
   owns the profile plumbing (median selection, per-hour mapping). */

const USABLE_LIFT_OVERLAYS = onlyOverlays(
  "boundaryLayerTop",
  "cloudBase",
  "usableLiftTop",
  "launch",
  "selectedHour",
);

function usableLiftTops(
  profile: WindgramProfile,
  sinkRateMs: number,
): Array<number | null> {
  return profile.hours.map((hour) => {
    const boundaryLayerTopM = p50(hour.derived.boundaryLayerTopM);
    const thermalVelocityMs = p50(hour.derived.thermalVelocityMs);
    const cloudBaseM = p50(hour.derived.cloudBaseM);
    const levelHeights = hour.levels.map((level) => p50(level.heightM));
    const heights = levelHeights.filter((height): height is number => height !== null);
    if (
      boundaryLayerTopM === null ||
      thermalVelocityMs === null ||
      cloudBaseM === null ||
      heights.length !== levelHeights.length
    ) return null;
    return usableLiftTopM({
      modelElevationM: profile.site.modelElevationM,
      boundaryLayerTopM,
      thermalVelocityMs,
      cloudBaseM,
      levels: heights.map((heightM) => ({ heightM })),
    }, sinkRateMs);
  });
}

export function usableLiftSummary(
  profile: WindgramProfile,
  sinkRateMs: number,
): { derivedCount: number; hourCount: number; peakM: number | null } {
  const values = usableLiftTops(profile, sinkRateMs);
  const available = values.filter((value): value is number => value !== null);
  return {
    derivedCount: available.length,
    hourCount: values.length,
    peakM: available.length === 0 ? null : Math.max(...available),
  };
}

export function renderUsableLiftChart(
  source: LabScenarioSource,
  sinkRateMs: number,
): { scene: SceneGraph; svg: string } {
  const scene = buildScene(source.profile, {
    timeZone: source.timeZone,
    overlays: USABLE_LIFT_OVERLAYS,
    sinkRateMs,
    smooth: false,
    columnWidthPx: 74,
    plotHeightPx: 330,
  });
  return { scene, svg: renderSvg(scene, { idPrefix: "usable-lift-lab" }) };
}

/* Ensemble-spread laboratory. */

const ENSEMBLE_SPREAD_OVERLAYS = onlyOverlays(
  "boundaryLayerTop",
  "cloudBase",
  "usableLiftTop",
  "selectedHour",
);

export function ensembleSpreadSummary(
  profile: WindgramProfile,
): { maxIqrM: number | null; ceiledMembers: number; members: number } {
  const usable = profile.hours
    .map((hour) => hour.derived.usableLiftTopM)
    .filter((value) =>
      value !== null &&
      isEnsembleValue(value) &&
      value.p25 !== null &&
      value.p75 !== null
    );
  const maxIqrM = usable.length === 0
    ? null
    : Math.max(...usable.map((value) => value.p75 - value.p25));
  const ceiledMembers = Math.max(0, ...profile.hours.map((hour) => {
    const value = hour.derived.boundaryLayerTopM;
    return value !== null && isEnsembleValue(value) ? (value.ceiledMembers ?? 0) : 0;
  }));
  return { maxIqrM, ceiledMembers, members: profile.run.members ?? 1 };
}

export function renderEnsembleSpreadChart(
  source: LabScenarioSource,
  key: string,
): { scene: SceneGraph; svg: string } {
  const scene = buildScene(source.profile, {
    timeZone: source.timeZone,
    overlays: ENSEMBLE_SPREAD_OVERLAYS,
    smooth: false,
    columnWidthPx: 74,
    plotHeightPx: 350,
  });
  return { scene, svg: renderSvg(scene, { idPrefix: `ensemble-spread-lab-${key}` }) };
}

/* Parcel laboratory. */

const PARCEL_OVERLAYS = onlyOverlays(
  "stability",
  "thermalIndex",
  "boundaryLayerTop",
  "launch",
  "selectedHour",
);

export function renderParcelChart(
  source: LabScenarioSource,
  key: string,
  hourCount: number,
): { scene: SceneGraph; svg: string } {
  const scene = buildScene(source.profile, {
    timeZone: source.timeZone,
    hourIndices: source.profile.hours.slice(0, hourCount).map((_, index) => index),
    overlays: PARCEL_OVERLAYS,
    smooth: false,
    columnWidthPx: 74,
    plotHeightPx: 330,
  });
  return { scene, svg: renderSvg(scene, { idPrefix: `parcel-lab-${key}` }) };
}

/* Wind-shear laboratory. */

const WIND_SHEAR_OVERLAYS = onlyOverlays(
  "wind",
  "windShear",
  "usableLiftTop",
  "launch",
  "selectedHour",
);

export const windLabel = (
  wind: { speedMs: number; directionDeg: number } | null,
): string =>
  wind ? `${wind.speedMs.toFixed(1)} m/s from ${Math.round(wind.directionDeg)}°` : "not available";

function readWind(scene: SceneGraph, altitudeM: number) {
  const sampling = scene.sampling[0];
  const uMs = interpolateVertical(sampling.windU, altitudeM);
  const vMs = interpolateVertical(sampling.windV, altitudeM);
  return uMs === null || vMs === null ? null : componentsToWind(uMs, vMs);
}

export interface WindShearFrame {
  scene: SceneGraph;
  svg: string;
  launchWind: { speedMs: number; directionDeg: number } | null;
  usableWind: { speedMs: number; directionDeg: number } | null;
  shearMs: number | null;
}

export function windShearFrame(
  source: LabScenarioSource,
  hourIndex: number,
): WindShearFrame {
  const profile = source.profile;
  const hour = profile.hours[hourIndex];
  const scene = buildScene(profile, {
    timeZone: source.timeZone,
    hourIndices: [hourIndex],
    overlays: WIND_SHEAR_OVERLAYS,
    smooth: false,
    widthPx: 400,
    plotHeightPx: 390,
  });
  const launchAltitudeM = profile.site.altitudeM ?? profile.site.modelElevationM;
  const usableAltitudeM = p50(hour.derived.usableLiftTopM);
  const launchWind = readWind(scene, launchAltitudeM);
  const usableWind = usableAltitudeM === null ? null : readWind(scene, usableAltitudeM);
  const shearMs = launchWind && usableWind ? vectorShearMs(
    { windSpeedMs: launchWind.speedMs, windDirectionDeg: launchWind.directionDeg },
    { windSpeedMs: usableWind.speedMs, windDirectionDeg: usableWind.directionDeg },
  ) : null;
  return {
    scene,
    svg: renderSvg(scene, { idPrefix: "wind-shear-lab" }),
    launchWind,
    usableWind,
    shearMs,
  };
}

/* Timing-comparison laboratory — its scenes render once in frontmatter; only
   the hour-lens readouts rebuild client-side. */

export const TIMING_OVERLAYS = onlyOverlays(
  "thermalStrength",
  "boundaryLayerTop",
  "usableLiftTop",
  "launch",
  "selectedHour",
);

export function timingHourValues(
  profile: WindgramProfile,
  index: number,
): { thermalVelocityMs: number | null; boundaryLayerTopM: number | null; usableLiftTopM: number | null } {
  const hour = profile.hours[index];
  return {
    thermalVelocityMs: p50(hour.derived.thermalVelocityMs),
    boundaryLayerTopM: p50(hour.derived.boundaryLayerTopM),
    usableLiftTopM: p50(hour.derived.usableLiftTopM),
  };
}

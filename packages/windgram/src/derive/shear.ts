import { windToComponents, type WindComponents } from "./wind.js";

export interface WindSample {
  windSpeedMs: number;
  windDirectionDeg: number;
}

/**
 * Vector wind shear (m/s) between two samples: the magnitude of the
 * component-wise wind difference, |V_upper − V_lower|. Identical winds shear
 * zero; equal speeds from opposite directions shear twice the speed.
 */
export function vectorShearMs(lower: WindSample, upper: WindSample): number {
  const a = windToComponents(lower.windSpeedMs, lower.windDirectionDeg);
  const b = windToComponents(upper.windSpeedMs, upper.windDirectionDeg);
  return Math.hypot(b.uMs - a.uMs, b.vMs - a.vMs);
}

/**
 * Surface-to-boundary-layer-top vector shear (m/s) for one profile hour: the
 * 10 m wind against the wind interpolated (component-wise, linearly in
 * height) at the published boundaryLayerTopM.
 *
 * - null when the hour has no boundary layer (boundaryLayerTopM null) or the
 *   model publishes no levels (no wind aloft to shear against);
 * - a BL top above the highest level uses the highest level's wind (column
 *   ceiling semantics — the published top is itself capped there);
 * - a BL top at or below model elevation shears the surface against itself: 0.
 */
export function surfaceToBoundaryLayerShearMs(args: {
  surfaceWind: WindSample;
  modelElevationM: number;
  boundaryLayerTopM: number | null;
  levels: ReadonlyArray<WindSample & { heightM: number }>;
}): number | null {
  if (args.boundaryLayerTopM === null || args.levels.length === 0) return null;

  const surface = windToComponents(args.surfaceWind.windSpeedMs, args.surfaceWind.windDirectionDeg);
  const nodes: Array<{ heightM: number; components: WindComponents }> = [
    { heightM: args.modelElevationM, components: surface },
    ...[...args.levels]
      .sort((left, right) => left.heightM - right.heightM)
      .map((level) => ({
        heightM: level.heightM,
        components: windToComponents(level.windSpeedMs, level.windDirectionDeg),
      })),
  ];

  const top = interpolateComponents(nodes, args.boundaryLayerTopM);
  return Math.hypot(top.uMs - surface.uMs, top.vMs - surface.vMs);
}

/**
 * Buoyancy/shear ratio, dimensionless:
 *
 *   B/S = thermalVelocityMs ÷ surfaceToBoundaryLayerShearMs
 *
 * i.e. the pipeline's Deardorff w* divided by the magnitude of the vector
 * wind difference between the 10 m wind and the wind at boundary-layer top
 * (both m/s) — the same construction canadarasp plots, so pilots can compare
 * numbers directly. Low values mean shear tears thermals apart; high values
 * mean buoyancy dominates. With zero shear the ratio is unbounded and
 * returns Infinity, except 0/0 (no thermals, no shear) which has no defined
 * ratio and returns null.
 */
export function buoyancyShearRatio(
  thermalVelocityMs: number,
  boundaryLayerShearMs: number,
): number | null {
  if (boundaryLayerShearMs === 0) {
    return thermalVelocityMs === 0 ? null : Number.POSITIVE_INFINITY;
  }
  return thermalVelocityMs / boundaryLayerShearMs;
}

function interpolateComponents(
  nodes: Array<{ heightM: number; components: WindComponents }>,
  heightM: number,
): WindComponents {
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (heightM <= first.heightM) return first.components;
  if (heightM >= last.heightM) return last.components;

  for (let index = 0; index < nodes.length - 1; index += 1) {
    const lower = nodes[index];
    const upper = nodes[index + 1];
    if (heightM > upper.heightM) continue;
    const fraction = (heightM - lower.heightM) / Math.max(0.001, upper.heightM - lower.heightM);
    return {
      uMs: lower.components.uMs + (upper.components.uMs - lower.components.uMs) * fraction,
      vMs: lower.components.vMs + (upper.components.vMs - lower.components.vMs) * fraction,
    };
  }
  return last.components;
}

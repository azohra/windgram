/* Wind conversions between the published form (speed + meteorological
   direction, i.e. where the wind blows FROM) and zonal/meridional components
   (u eastward, v northward) for shear and averaging math. */

const DEGREES_TO_RADIANS = Math.PI / 180;

export interface WindComponents {
  /** Zonal component, m/s, positive eastward. */
  uMs: number;
  /** Meridional component, m/s, positive northward. */
  vMs: number;
}

export function normalizeDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/** Components from speed and meteorological direction (from-direction). */
export function windToComponents(speedMs: number, directionDeg: number): WindComponents {
  const radians = directionDeg * DEGREES_TO_RADIANS;
  return {
    uMs: -speedMs * Math.sin(radians),
    vMs: -speedMs * Math.cos(radians),
  };
}

/**
 * Speed and meteorological direction from components. Calm air (both
 * components zero) has no direction; it is reported as 0 by convention.
 */
export function componentsToWind(uMs: number, vMs: number): {
  speedMs: number;
  directionDeg: number;
} {
  const speedMs = Math.hypot(uMs, vMs);
  if (speedMs === 0) return { speedMs: 0, directionDeg: 0 };
  return {
    speedMs,
    directionDeg: normalizeDegrees(Math.atan2(-uMs, -vMs) / DEGREES_TO_RADIANS),
  };
}

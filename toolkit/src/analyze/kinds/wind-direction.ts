/* windDirection — the kind's type and its extractor, one module. */

import type { WindgramHour } from "../../contract/index.js";
import { p50 } from "../../derive/ensemble.js";
import { componentsToWind, windToComponents } from "../../derive/wind.js";
import type { ThermalWindowFinding } from "./thermal-window.js";
import { round2, type CitedInstant, type Context, type LocalDayKey } from "./shared.js";

/**
 * Surface-flow evolution across one thermalWindow: direction and speed at
 * the window's start, peak-lift hour, and end, the net circular veer
 * between the endpoints, and the vector-mean surface and climb-band
 * directions. The statement S3 (2026-08-10) hand-verified live: SE
 * drainage rotating monotonically to SW upvalley across a red-mountain
 * window (115° at 09:00 → 216° at peak lift → 242° at the end, net veer
 * +127°), established by peak-lift.
 *
 * DETERMINISTIC DOCUMENTS ONLY — a hard gate, not a caveat: ensemble
 * documents publish per-position PERCENTILES of raw degrees, and a p50 of
 * {350°, 10°, …} is not a circular statistic — nothing in the contract
 * lets analyze recover member vectors, so ensembles emit nothing here.
 *
 * All direction arithmetic is vector math over derive/wind.js components
 * (`windToComponents`/`componentsToWind`); raw degrees are never averaged,
 * here or anywhere. The calm convention (0° at zero speed) never surfaces
 * as a direction — the floor nulls it first: any sample or vector mean
 * whose speed sits under `directionFloorMs` states its speed and a null
 * direction. The default floor (1.0 m/s) is deliberately conservative;
 * S3 measured the jitter cliff at 0.5 m/s (consecutive-hour direction
 * medians 20° → 7°, p90 113° → 37° across that boundary), so a caller
 * lowering the floor to 0.5 knows exactly what they buy.
 *
 * `netVeerDeg` is the START→END CIRCULAR DISPLACEMENT, never accumulated
 * hour-to-hour rotation — S3 measured 206° of pure jitter accumulation on
 * one light-wind 3-hourly day — and is therefore blind to a full 360°
 * loop by construction: a flow that boxes the compass and returns reads
 * as zero. The per-hour series stays in evidence for readers who need the
 * path, not just the displacement.
 */
export interface WindDirectionFinding {
  kind: "windDirection";
  day: LocalDayKey;
  window: { start: CitedInstant; end: CitedInstant };
  surface: {
    /** Direction null under the floor (or unpublished); speed always. */
    start: { directionDeg: number | null; speedMs: number };
    peakLift: { directionDeg: number | null; speedMs: number; at: CitedInstant };
    end: { directionDeg: number | null; speedMs: number };
  };
  /** Circular start→end veer, positive clockwise; null when either
   * endpoint's direction is suppressed. NEVER cumulative rotation, and
   * blind to a full 360° loop (see the kind JSDoc). */
  netVeerDeg: number | null;
  surfaceVectorMean: { directionDeg: number | null; speedMs: number };
  /** Vector mean over every in-band level sample (launch to lift top)
   * across the window's hours; null when the column offers none. */
  bandVectorMean: {
    directionDeg: number | null;
    speedMs: number;
    samples: number;
  } | null;
  thresholds: { directionFloorMs: number };
  /** The raw published surface series over the window hours that publish
   * both speed and direction — the path behind the net displacement. */
  evidence: { hours: string[]; surfaceDirectionDeg: number[]; surfaceSpeedMs: number[] };
}

/** Signed smallest-angle rotation from one bearing to another, (-180, 180]. */
function signedVeerDeg(fromDeg: number, toDeg: number): number {
  let delta = (toDeg - fromDeg) % 360;
  if (delta > 180) delta -= 360;
  if (delta <= -180) delta += 360;
  return delta;
}

export function findWindDirection(
  context: Context,
  windows: ThermalWindowFinding[],
): WindDirectionFinding[] {
  // The hard gate: published ensemble direction percentiles are not
  // circular statistics (see the kind JSDoc).
  if (!context.deterministic) return [];
  const { profile, launchReferenceM, thresholds } = context;
  const { directionFloorMs } = thresholds.windDirection;
  const hourByValidAt = new Map(profile.hours.map((hour) => [hour.validAt, hour]));

  const surfaceAt = (hour: WindgramHour): { speedMs: number; directionDeg: number | null } | null => {
    const speedMs = p50(hour.surface.windSpeedMs);
    if (speedMs === null) return null;
    return { speedMs, directionDeg: p50(hour.surface.windDirectionDeg) };
  };
  const sampleOf = (raw: { speedMs: number; directionDeg: number | null }) => ({
    directionDeg:
      raw.directionDeg !== null && raw.speedMs >= directionFloorMs
        ? Math.round(raw.directionDeg)
        : null,
    speedMs: round2(raw.speedMs),
  });

  const findings: WindDirectionFinding[] = [];
  for (const window of windows) {
    const hours = window.evidence.hours.map((validAt) => hourByValidAt.get(validAt)!);
    const start = surfaceAt(hours[0]);
    const end = surfaceAt(hours[hours.length - 1]);
    const peak = surfaceAt(hourByValidAt.get(window.peakLiftTopAt.validAt)!);
    if (start === null || end === null || peak === null) continue;

    // Surface vector mean and the evidence series, over the hours that
    // publish both — vector components only, never raw-degree arithmetic.
    let uSum = 0;
    let vSum = 0;
    const evidence: WindDirectionFinding["evidence"] = {
      hours: [],
      surfaceDirectionDeg: [],
      surfaceSpeedMs: [],
    };
    for (const hour of hours) {
      const raw = surfaceAt(hour);
      if (raw === null || raw.directionDeg === null) continue;
      const { uMs, vMs } = windToComponents(raw.speedMs, raw.directionDeg);
      uSum += uMs;
      vSum += vMs;
      evidence.hours.push(hour.validAt);
      evidence.surfaceDirectionDeg.push(Math.round(raw.directionDeg));
      evidence.surfaceSpeedMs.push(round2(raw.speedMs));
    }
    if (evidence.hours.length === 0) continue; // no direction published anywhere: nothing to state
    const surfaceMean = componentsToWind(uSum / evidence.hours.length, vSum / evidence.hours.length);

    // Climb-band vector mean: every in-band level sample across the window.
    let bandU = 0;
    let bandV = 0;
    let bandSamples = 0;
    for (const hour of hours) {
      const top = p50(hour.derived.usableLiftTopM);
      if (top === null) continue;
      for (const level of hour.levels) {
        const heightM = p50(level.heightM);
        const speedMs = p50(level.windSpeedMs);
        const directionDeg = p50(level.windDirectionDeg);
        if (heightM === null || speedMs === null || directionDeg === null) continue;
        if (heightM < launchReferenceM || heightM > top) continue;
        const { uMs, vMs } = windToComponents(speedMs, directionDeg);
        bandU += uMs;
        bandV += vMs;
        bandSamples += 1;
      }
    }
    const bandMean = bandSamples > 0 ? componentsToWind(bandU / bandSamples, bandV / bandSamples) : null;

    const startSample = sampleOf(start);
    const endSample = sampleOf(end);
    findings.push({
      kind: "windDirection",
      day: window.day,
      window: { start: window.start, end: window.end },
      surface: {
        start: startSample,
        peakLift: { ...sampleOf(peak), at: window.peakLiftTopAt },
        end: endSample,
      },
      netVeerDeg:
        startSample.directionDeg !== null && endSample.directionDeg !== null
          ? Math.round(signedVeerDeg(start.directionDeg!, end.directionDeg!))
          : null,
      surfaceVectorMean: {
        directionDeg:
          surfaceMean.speedMs >= directionFloorMs ? Math.round(surfaceMean.directionDeg) : null,
        speedMs: round2(surfaceMean.speedMs),
      },
      bandVectorMean:
        bandMean === null
          ? null
          : {
              directionDeg:
                bandMean.speedMs >= directionFloorMs ? Math.round(bandMean.directionDeg) : null,
              speedMs: round2(bandMean.speedMs),
              samples: bandSamples,
            },
      thresholds: { directionFloorMs },
      evidence,
    });
  }
  return findings;
}

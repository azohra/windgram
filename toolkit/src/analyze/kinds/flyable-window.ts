/* flyableWindow — the kind's type and its extractor, one module. */

import { isEnsembleValue, type Scalar, type WindgramHour } from "../../contract/index.js";
import { localDateKey } from "../../derive/day-window.js";
import { p50 } from "../../derive/ensemble.js";
import { round1, round2, type CitedInstant, type Context, type LocalDayKey } from "./shared.js";

/**
 * Consecutive hours whose published usable-lift top stands at least
 * `depthMinM` above launch while W* is at least `wstarMinMs` — a
 * COMPRESSION ANCHOR that deliberately restates the published derived
 * series (see the module charter in index.ts). The default thresholds are
 * the spike's, whose 3×3 sensitivity sweep (W* 0.7/0.9/1.1 × depth
 * 150/300/500 m) measured low sensitivity on real profiles; both are
 * embedded and caller-movable, because "flyable" beyond this arithmetic is
 * pilot, wing, and site judgment that belongs downstream. Launch reference
 * is the caller's `AnalyzeOptions.launch.elevationM` — documents are
 * launch-agnostic — falling back to modelElevationM when no launch is
 * supplied (and then `peakLiftTopAboveLaunchM` is null rather than a
 * number relative to the wrong ground).
 */
export interface FlyableWindowFinding {
  kind: "flyableWindow";
  day: LocalDayKey;
  start: CitedInstant;
  end: CitedInstant;
  durationHours: number;
  peakLiftTopM: number;
  peakLiftTopAt: CitedInstant;
  /** Launch-relative peak; null when no launch was supplied. */
  peakLiftTopAboveLaunchM: number | null;
  peakThermalVelocityMs: number;
  /**
   * True when the window's first/last hour is the document's own first/
   * last hour: the edge is the data's horizon, not necessarily the
   * window's. A clipped start reads as "open since at least \<start\>", a
   * clipped end as "still open at \<end\>" — timing comparisons must not
   * count a clipped edge as a forecast of opening or decay.
   */
  clippedAtStart: boolean;
  clippedAtEnd: boolean;
  thresholds: { wstarMinMs: number; depthMinM: number };
  evidence: {
    hours: string[];
    usableLiftTopM: number[];
    thermalVelocityMs: number[];
    /** p10-p90 lift-top band per cited hour; ensemble documents only. */
    liftTopBandP10P90?: Array<[number, number] | null>;
  };
}

function band(value: Scalar | null | undefined): [number, number] | null {
  if (value !== null && value !== undefined && isEnsembleValue(value)) {
    // Full dropout has no envelope: percentiles of zero members are null.
    if (value.p10 === null || value.p90 === null) return null;
    return [value.p10, value.p90];
  }
  return null;
}

export function findFlyableWindows(context: Context): FlyableWindowFinding[] {
  const { profile, launchReferenceM, thresholds, stepHours } = context;
  const { wstarMinMs, depthMinM } = thresholds.flyableWindow;
  const launchKnown = context.launchElevationM !== null;
  const ensemble = !context.deterministic;

  const flyable = (hour: WindgramHour): boolean => {
    const top = p50(hour.derived.usableLiftTopM);
    const wstar = p50(hour.derived.thermalVelocityMs);
    return (
      top !== null && wstar !== null && wstar >= wstarMinMs && top - launchReferenceM >= depthMinM
    );
  };

  const findings: FlyableWindowFinding[] = [];
  let index = 0;
  while (index < profile.hours.length) {
    if (!flyable(profile.hours[index])) {
      index += 1;
      continue;
    }
    let last = index;
    while (last + 1 < profile.hours.length && flyable(profile.hours[last + 1])) last += 1;

    const hours = profile.hours.slice(index, last + 1);
    const tops = hours.map((hour) => p50(hour.derived.usableLiftTopM)!);
    const wstars = hours.map((hour) => p50(hour.derived.thermalVelocityMs)!);
    const peakIndex = tops.indexOf(Math.max(...tops));
    const peakHour = hours[peakIndex];
    const peakTop = tops[peakIndex];

    const finding: FlyableWindowFinding = {
      kind: "flyableWindow",
      day: localDateKey(hours[0].validAt, context.timeZone),
      start: context.cite(hours[0].validAt),
      end: context.cite(hours[hours.length - 1].validAt),
      // A window abutting the document's own hour range is clipped by the
      // horizon: the edge is a data boundary, not an opening or a decay.
      clippedAtStart: hours[0].validAt === profile.hours[0].validAt,
      clippedAtEnd:
        hours[hours.length - 1].validAt === profile.hours[profile.hours.length - 1].validAt,
      durationHours: hours.length * stepHours,
      peakLiftTopM: round1(peakTop),
      peakLiftTopAt: context.cite(peakHour.validAt),
      peakLiftTopAboveLaunchM: launchKnown ? round1(peakTop - launchReferenceM) : null,
      peakThermalVelocityMs: round2(Math.max(...wstars)),
      thresholds: { wstarMinMs, depthMinM },
      evidence: {
        hours: hours.map((hour) => hour.validAt),
        usableLiftTopM: tops.map(round1),
        thermalVelocityMs: wstars.map(round2),
      },
    };
    if (ensemble) {
      finding.evidence.liftTopBandP10P90 = hours.map((hour) => {
        const range = band(hour.derived.usableLiftTopM);
        return range === null ? null : [round1(range[0]), round1(range[1])];
      });
    }
    findings.push(finding);
    index = last + 1;
  }
  return findings;
}

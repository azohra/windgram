/* thermalWindow — the kind's type and its extractor, one module. */

import { isEnsembleValue, type Scalar, type WindgramHour } from "../../contract/index.js";
import { localDateKey } from "../../derive/day-window.js";
import { p50 } from "../../derive/ensemble.js";
import {
  leadHoursTo,
  round1,
  round2,
  type CitedInstant,
  type Context,
  type LocalDayKey,
} from "./shared.js";

/**
 * Consecutive hours whose published usable-lift top stands at least
 * `depthMinM` above launch while W* is at least `wstarMinMs` — a
 * COMPRESSION ANCHOR that deliberately restates the published derived
 * series (see the module charter in index.ts). The default thresholds are
 * the spike's, whose 3×3 sensitivity sweep (W* 0.7/0.9/1.1 × depth
 * 150/300/500 m) measured low sensitivity on real profiles; both are
 * embedded and caller-movable, because "flyable" beyond this arithmetic is
 * pilot, wing, and site judgment that belongs downstream.
 *
 * RENAMED from `flyableWindow` at vocabulary v4: the kind string is the one
 * token every consumer switches on and every headline inherits, and
 * "flyable" was the one judgment word the discipline could not reduce to
 * stated arithmetic — the test reads two thermal quantities (W*, usable-lift
 * depth) against stated floors and is blind to wind, rain, and
 * overdevelopment. `thermalWindow` says what the arithmetic tests; the
 * flyability call stays downstream where the JSDoc always said it lived.
 *
 * GAP TOLERANCE (v4, ratified): a single sub-threshold step used to split
 * a day into two windows and change roster shapes downstream. Adjacent
 * passing runs now merge when the failing steps between them cover at
 * most `maxGapHours` (default 0 — exactly the pre-v4 segmentation) AND
 * every bridged step publishes both series (bridging a data hole would
 * manufacture continuity over a gap the model never forecast). Bridged
 * hours join the cited evidence arrays, so the dip stays visible and the
 * peaks remain maxima over exactly the hours the window covers.
 *
 * Launch reference
 * is the caller's `AnalyzeOptions.launch.elevationM` — documents are
 * launch-agnostic — falling back to modelElevationM when no launch is
 * supplied (and then `peakLiftTopAboveLaunchM` is null rather than a
 * number relative to the wrong ground).
 */
export interface ThermalWindowFinding {
  kind: "thermalWindow";
  day: LocalDayKey;
  /**
   * Forecast lead: hours from `run.referenceTime` to the day's peak-lift
   * hour (`peakLiftTopAt`) — the claim's central instant, chosen over the
   * window's start because the peak is the hour the headline states and
   * the same anchor convention extends to day-keyed statements that have
   * no start (computed by the shared `leadHoursTo`, one home). S1
   * (2026-08-10) made the number mandatory: a day-10 window and a day-1
   * window are epistemically different objects wearing identical
   * vocabulary, and only this field says which one the reader holds.
   */
  leadHours: number;
  start: CitedInstant;
  end: CitedInstant;
  durationHours: number;
  /**
   * The WIDEST covered step among the window's cited hours — the
   * quantization bound on this window's timing and duration (a 2-sample
   * window at 3 h cadence reads `durationHours` 6 when the truth is
   * anywhere from 4 to 9; the caveat used to live in a different finding,
   * and locality won here for the same reason it won clipped-edge flags
   * in v3). At constant cadence this is the document cadence; on a
   * mixed-cadence document the maximum gap is the honest single number —
   * the same choice the stepCadence caveat makes.
   */
  stepHours: number;
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
  thresholds: { wstarMinMs: number; depthMinM: number; maxGapHours: number };
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

export function findThermalWindows(context: Context): ThermalWindowFinding[] {
  const { profile, launchReferenceM, thresholds, steps } = context;
  const { wstarMinMs, depthMinM, maxGapHours } = thresholds.thermalWindow;
  const launchKnown = context.launchElevationM !== null;
  const ensemble = !context.deterministic;

  const clearsFloors = (hour: WindgramHour): boolean => {
    const top = p50(hour.derived.usableLiftTopM);
    const wstar = p50(hour.derived.thermalVelocityMs);
    return (
      top !== null && wstar !== null && wstar >= wstarMinMs && top - launchReferenceM >= depthMinM
    );
  };
  const publishesBoth = (hour: WindgramHour): boolean =>
    p50(hour.derived.usableLiftTopM) !== null && p50(hour.derived.thermalVelocityMs) !== null;

  // Maximal runs of floor-clearing hours…
  const runs: Array<{ first: number; last: number }> = [];
  let index = 0;
  while (index < profile.hours.length) {
    if (!clearsFloors(profile.hours[index])) {
      index += 1;
      continue;
    }
    let last = index;
    while (last + 1 < profile.hours.length && clearsFloors(profile.hours[last + 1])) last += 1;
    runs.push({ first: index, last });
    index = last + 1;
  }

  // …merged across sub-threshold dips no wider than maxGapHours (see the
  // kind's JSDoc): the failing steps between two runs must cover at most
  // maxGapHours AND each publish both series — a real forecast dip, never
  // a data hole. Default 0 merges nothing (any step covers >= 1 h).
  const windows: Array<{ first: number; last: number }> = [];
  for (const run of runs) {
    const previous = windows[windows.length - 1];
    if (previous) {
      const gapHours = steps.after
        .slice(previous.last + 1, run.first)
        .reduce((sum, span) => sum + span, 0);
      const bridgeable = profile.hours.slice(previous.last + 1, run.first).every(publishesBoth);
      if (gapHours <= maxGapHours && bridgeable) {
        previous.last = run.last;
        continue;
      }
    }
    windows.push({ ...run });
  }

  const findings: ThermalWindowFinding[] = [];
  for (const { first, last } of windows) {
    const hours = profile.hours.slice(first, last + 1);
    const tops = hours.map((hour) => p50(hour.derived.usableLiftTopM)!);
    const wstars = hours.map((hour) => p50(hour.derived.thermalVelocityMs)!);
    const peakIndex = tops.indexOf(Math.max(...tops));
    const peakHour = hours[peakIndex];
    const peakTop = tops[peakIndex];

    const finding: ThermalWindowFinding = {
      kind: "thermalWindow",
      day: localDateKey(hours[0].validAt, context.timeZone),
      leadHours: leadHoursTo(profile.run.referenceTime, peakHour.validAt),
      start: context.cite(hours[0].validAt),
      end: context.cite(hours[hours.length - 1].validAt),
      // A window abutting the document's own hour range is clipped by the
      // horizon: the edge is a data boundary, not an opening or a decay.
      clippedAtStart: hours[0].validAt === profile.hours[0].validAt,
      clippedAtEnd:
        hours[hours.length - 1].validAt === profile.hours[profile.hours.length - 1].validAt,
      // Covered span at the document's ACTUAL cadence (see HourSteps in
      // shared.ts): each cited step covers the hours to the next published
      // sample. At constant cadence this is samples × stepHours exactly;
      // on a mixed-cadence document (live GEPS: 3 h then 6 h) the far
      // horizon's wider steps count at their real width instead of the
      // leading pair's.
      durationHours: steps.after.slice(first, last + 1).reduce((sum, span) => sum + span, 0),
      // The widest covered step among the cited hours — the quantization
      // bound its JSDoc states (max, not leading, on mixed cadence).
      stepHours: Math.max(...steps.after.slice(first, last + 1)),
      peakLiftTopM: round1(peakTop),
      peakLiftTopAt: context.cite(peakHour.validAt),
      peakLiftTopAboveLaunchM: launchKnown ? round1(peakTop - launchReferenceM) : null,
      peakThermalVelocityMs: round2(Math.max(...wstars)),
      thresholds: { wstarMinMs, depthMinM, maxGapHours },
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
  }
  return findings;
}

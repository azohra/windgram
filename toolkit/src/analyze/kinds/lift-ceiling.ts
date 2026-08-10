/* liftCeiling — the kind's type and its extractor, one module. */

import { p50 } from "../../derive/ensemble.js";
import type { ThermalWindowFinding } from "./thermal-window.js";
import { round1, type CitedInstant, type Context, type LocalDayKey } from "./shared.js";

/**
 * Within each thermal window: is the top of the climb set by cloud base or
 * by updraft decay? The cause is an arithmetic relation — `cloudCapped`
 * when the published cloud base sits within `cloudCapMarginM` of (or
 * below) the lift top, else `sinkLimited` — segmented into runs. Like
 * thermalWindow, a compression anchor restating published series.
 *
 * SEGMENT EVIDENCE (v4, Tier 0 fix): each segment cites its PEAK published
 * lift top and the hour it fired, with cloud base and BL top sampled at
 * that same hour so the cause relation stays checkable against co-timed
 * values. Before v4 the evidence froze the segment's FIRST hour — a live
 * 7-hour sinkLimited segment cited top 1973 while the window's peak was
 * 3440, so the cited evidence did not represent the claim.
 *
 * `flips` was REMOVED at v4: it restated `segments.length - 1` and
 * compressed nothing (ratified removal, notes/design-analyze-compare-v4
 * item 7).
 */
export interface LiftCeilingFinding {
  kind: "liftCeiling";
  day: LocalDayKey;
  segments: Array<{
    cause: "cloudCapped" | "sinkLimited";
    start: CitedInstant;
    end: CitedInstant;
    hoursN: number;
    /** The segment's peak lift top, with the other series sampled at the
     * SAME cited hour — one co-timed row the cause can be re-derived from. */
    evidence: {
      peakUsableLiftTopM: number;
      peakUsableLiftTopAt: CitedInstant;
      /** Published cloud base at the peak-lift hour. */
      cloudBaseM: number;
      /** Published BL top at the peak-lift hour; null when unpublished. */
      boundaryLayerTopM: number | null;
    };
  }>;
  thresholds: { cloudCapMarginM: number };
}

export function findLiftCeilings(
  context: Context,
  windows: ThermalWindowFinding[],
): LiftCeilingFinding[] {
  const { profile, thresholds } = context;
  const margin = thresholds.liftCeiling.cloudCapMarginM;
  const hoursByValidAt = new Map(profile.hours.map((hour) => [hour.validAt, hour]));

  const findings: LiftCeilingFinding[] = [];
  for (const window of windows) {
    type Segment = LiftCeilingFinding["segments"][number];
    const segments: Array<Segment & { peakTop: number }> = [];
    for (const validAt of window.evidence.hours) {
      const hour = hoursByValidAt.get(validAt)!;
      const top = p50(hour.derived.usableLiftTopM);
      const cloudBase = p50(hour.derived.cloudBaseM);
      if (top === null || cloudBase === null) continue;
      const cause: "cloudCapped" | "sinkLimited" =
        cloudBase <= top + margin ? "cloudCapped" : "sinkLimited";
      const boundaryLayerTop = p50(hour.derived.boundaryLayerTopM);
      const evidence: Segment["evidence"] = {
        peakUsableLiftTopM: round1(top),
        peakUsableLiftTopAt: context.cite(validAt),
        cloudBaseM: round1(cloudBase),
        boundaryLayerTopM: boundaryLayerTop === null ? null : round1(boundaryLayerTop),
      };
      const previous = segments[segments.length - 1];
      if (previous && previous.cause === cause) {
        previous.end = context.cite(validAt);
        previous.hoursN += 1;
        // The segment's evidence follows its peak, not its first hour.
        if (top > previous.peakTop) {
          previous.peakTop = top;
          previous.evidence = evidence;
        }
      } else {
        segments.push({
          cause,
          start: context.cite(validAt),
          end: context.cite(validAt),
          hoursN: 1,
          evidence,
          peakTop: top,
        });
      }
    }
    if (segments.length > 0) {
      findings.push({
        kind: "liftCeiling",
        day: window.day,
        segments: segments.map(({ peakTop: _peakTop, ...segment }) => segment),
        thresholds: { cloudCapMarginM: margin },
      });
    }
  }
  return findings;
}

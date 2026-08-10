/* liftCeiling — the kind's type and its extractor, one module. */

import { p50 } from "../../derive/ensemble.js";
import type { FlyableWindowFinding } from "./flyable-window.js";
import { round1, type CitedInstant, type Context, type LocalDayKey } from "./shared.js";

/**
 * Within each flyable window: is the top of the climb set by cloud base or
 * by updraft decay? The cause is an arithmetic relation — `cloudCapped`
 * when the published cloud base sits within `cloudCapMarginM` of (or
 * below) the lift top, else `sinkLimited` — segmented into runs with the
 * flip count stated. Like flyableWindow, a compression anchor restating
 * published series.
 */
export interface LiftCeilingFinding {
  kind: "liftCeiling";
  day: LocalDayKey;
  segments: Array<{
    cause: "cloudCapped" | "sinkLimited";
    start: CitedInstant;
    end: CitedInstant;
    hoursN: number;
    evidence: {
      usableLiftTopM: number;
      cloudBaseM: number;
      boundaryLayerTopM: number | null;
    };
  }>;
  flips: number;
  thresholds: { cloudCapMarginM: number };
}

export function findLiftCeilings(
  context: Context,
  windows: FlyableWindowFinding[],
): LiftCeilingFinding[] {
  const { profile, thresholds } = context;
  const margin = thresholds.liftCeiling.cloudCapMarginM;
  const hoursByValidAt = new Map(profile.hours.map((hour) => [hour.validAt, hour]));

  const findings: LiftCeilingFinding[] = [];
  for (const window of windows) {
    const segments: LiftCeilingFinding["segments"] = [];
    for (const validAt of window.evidence.hours) {
      const hour = hoursByValidAt.get(validAt)!;
      const top = p50(hour.derived.usableLiftTopM);
      const cloudBase = p50(hour.derived.cloudBaseM);
      if (top === null || cloudBase === null) continue;
      const cause: "cloudCapped" | "sinkLimited" =
        cloudBase <= top + margin ? "cloudCapped" : "sinkLimited";
      const previous = segments[segments.length - 1];
      if (previous && previous.cause === cause) {
        previous.end = context.cite(validAt);
        previous.hoursN += 1;
      } else {
        const boundaryLayerTop = p50(hour.derived.boundaryLayerTopM);
        segments.push({
          cause,
          start: context.cite(validAt),
          end: context.cite(validAt),
          hoursN: 1,
          evidence: {
            usableLiftTopM: round1(top),
            cloudBaseM: round1(cloudBase),
            boundaryLayerTopM: boundaryLayerTop === null ? null : round1(boundaryLayerTop),
          },
        });
      }
    }
    if (segments.length > 0) {
      findings.push({
        kind: "liftCeiling",
        day: window.day,
        segments,
        flips: segments.length - 1,
        thresholds: { cloudCapMarginM: margin },
      });
    }
  }
  return findings;
}

/* quietDay — the kind's type and its extractor, one module. */

import type { WindgramHour } from "../../contract/index.js";
import { localDateKey, localHourOfDay } from "../../derive/day-window.js";
import { p50 } from "../../derive/ensemble.js";
import type { ThermalWindowFinding } from "./thermal-window.js";
import { round1, round2, type CitedInstant, type Context, type LocalDayKey } from "./shared.js";

/**
 * A local day that produced NO thermal window — the negative stated with
 * its evidence instead of by absence, so a consumer's headline can say WHY
 * ("peak W* 0.4 m/s, below the 0.9 floor") rather than only "no window".
 * Emitted once per local day that has forecast hours and no thermalWindow
 * finding; a day with a window emits nothing here (the window IS the
 * statement). `failed` names the floors the day's best hours missed —
 * including the honest edge case `"coincidence"`, where each threshold is
 * met at SOME hour but never both in the same hour.
 */
export interface QuietDayFinding {
  kind: "quietDay";
  day: LocalDayKey;
  /** The day's best W*; null when no hour published the series. */
  peakThermalVelocityMs: number | null;
  peakThermalVelocityAt: CitedInstant | null;
  /**
   * The day's best usable-lift depth above the launch reference
   * (AnalyzeOptions.launch.elevationM, or modelElevationM when no launch
   * is supplied — the same arithmetic the window test runs); null when
   * unpublished.
   */
  peakLiftDepthM: number | null;
  peakLiftDepthAt: CitedInstant | null;
  failed: Array<"wstar" | "depth" | "coincidence">;
  /**
   * The hours the claim is built from. `truncated` is the arithmetic
   * verdict that the document's own hour range clips this local day (its
   * covered span misses the day's start or end at the local cadence of
   * the day's own edge hours — cadence can widen mid-horizon):
   * a quiet call built from a sliver of a day — a short-horizon run
   * ending before the thermals start — is a data boundary, not a
   * forecast. A truncated quiet day must not vote in cross-model
   * comparisons; it exists so "no window" and "day not fully forecast"
   * stay distinguishable statements.
   */
  coverage: {
    hours: number;
    first: CitedInstant;
    last: CitedInstant;
    truncated: boolean;
  };
  thresholds: { wstarMinMs: number; depthMinM: number };
}

/* The negative statement: local days that produced no thermal window,
   carrying the numbers that failed. Days covered by any window hour are
   excluded via the windows' own evidence (a window that crosses midnight
   covers both its days). */
export function findQuietDays(
  context: Context,
  windows: ThermalWindowFinding[],
): QuietDayFinding[] {
  const { profile, launchReferenceM, thresholds } = context;
  const { wstarMinMs, depthMinM } = thresholds.thermalWindow;
  const windowDays = new Set(
    windows.flatMap((window) =>
      window.evidence.hours.map((validAt) => localDateKey(validAt, context.timeZone)),
    ),
  );
  const byDay = new Map<string, WindgramHour[]>();
  for (const hour of profile.hours) {
    const day = localDateKey(hour.validAt, context.timeZone);
    const group = byDay.get(day) ?? [];
    group.push(hour);
    byDay.set(day, group);
  }

  const findings: QuietDayFinding[] = [];
  for (const [day, hours] of byDay) {
    if (windowDays.has(day)) continue;
    /* Coverage: a continuous profile covers a full local day exactly when
       its first covered hour falls inside the day's first step and its
       last inside the day's last step — judged at the LOCAL cadence of
       those hours (steps.before at the day's first sample, steps.after at
       its last), never a document-wide constant: live GEPS switches 3 h →
       6 h mid-horizon, and reading the leading cadence misread its far
       6-hourly days as truncated (S1, 2026-08-10). Anything else means
       the document's own horizon clips the day. */
    const { steps } = context;
    const firstIdx = steps.indexOf.get(hours[0].validAt)!;
    const lastIdx = steps.indexOf.get(hours[hours.length - 1].validAt)!;
    const firstLocalH = localHourOfDay(hours[0].validAt, context.timeZone);
    const lastLocalH = localHourOfDay(hours[hours.length - 1].validAt, context.timeZone);
    const truncated = !(firstLocalH < steps.before[firstIdx] && lastLocalH >= 24 - steps.after[lastIdx]);
    let peakWstar: number | null = null;
    let peakWstarAt: string | null = null;
    let peakDepth: number | null = null;
    let peakDepthAt: string | null = null;
    for (const hour of hours) {
      const wstar = p50(hour.derived.thermalVelocityMs);
      const top = p50(hour.derived.usableLiftTopM);
      const depth = top === null ? null : top - launchReferenceM;
      if (wstar !== null && (peakWstar === null || wstar > peakWstar)) {
        peakWstar = wstar;
        peakWstarAt = hour.validAt;
      }
      if (depth !== null && (peakDepth === null || depth > peakDepth)) {
        peakDepth = depth;
        peakDepthAt = hour.validAt;
      }
    }
    const failed: QuietDayFinding["failed"] = [];
    if (peakWstar === null || peakWstar < wstarMinMs) failed.push("wstar");
    if (peakDepth === null || peakDepth < depthMinM) failed.push("depth");
    // Each floor met at SOME hour, never both in the same hour — a real
    // (if rare) shape: morning depth under a dying W*, or the reverse.
    if (failed.length === 0) failed.push("coincidence");
    findings.push({
      kind: "quietDay",
      day,
      peakThermalVelocityMs: peakWstar === null ? null : round2(peakWstar),
      peakThermalVelocityAt: peakWstarAt === null ? null : context.cite(peakWstarAt),
      peakLiftDepthM: peakDepth === null ? null : round1(peakDepth),
      peakLiftDepthAt: peakDepthAt === null ? null : context.cite(peakDepthAt),
      failed,
      coverage: {
        // Covered span at the actual cadence (HourSteps convention) — at
        // constant cadence exactly samples × stepHours, as before v4.
        hours: steps.after.slice(firstIdx, lastIdx + 1).reduce((sum, span) => sum + span, 0),
        first: context.cite(hours[0].validAt),
        last: context.cite(hours[hours.length - 1].validAt),
        truncated,
      },
      thresholds: { wstarMinMs, depthMinM },
    });
  }
  return findings;
}

/* windExceedance — the kind's type and its extractor, one module. */

import type { WindgramHour } from "../../contract/index.js";
import { p50 } from "../../derive/ensemble.js";
import type { ThermalWindowFinding } from "./thermal-window.js";
import { climbBandMaxWind } from "./wind-summary.js";
import { round2, type CitedInstant, type Context, type LocalDayKey } from "./shared.js";

/**
 * Maximal runs of thermalWindow hours whose surface wind, gust, or
 * climb-band wind stands at or above a CALLER-supplied ceiling
 * (`AnalyzeOptions.windCeilings`) — the thermalWindow construction pointed
 * at wind. THE PACKAGE NEVER OWNS A CEILING: no defaults exist anywhere,
 * and a quantity without its ceiling emits nothing. "Too windy" is pilot,
 * wing, and site judgment; this kind only states where the caller's own
 * number is met, with the number echoed verbatim in `thresholdMs` so the
 * statement stays true under any caller value. (S3 2026-08-10 trial
 * constants — surface 8, gust 12 hourMax / 9.5 instant, band 10 m/s —
 * were used to MEASURE the construction and deliberately do not ship.)
 *
 * GUST SEMANTICS DISCIPLINE: gust ceilings are per class
 * (`gust.hourMaxMs` / `gust.instantMs`), and gust runs are extracted only
 * when the document declares its gust semantics AND the caller supplied
 * that class's ceiling — a caller giving only `instantMs` gets NOTHING
 * from an hourMax document (and an untagged document yields no gust runs
 * at all), never a silently misread threshold. S3 measured the class gap
 * at a factor ~1.8-2.8 at matched light mountain means — LARGER than the
 * ~20-30 % the contract JSDoc notes for systematically stronger winds —
 * so hourMax and instant exceedances must never be compared either.
 *
 * Caveats the shape confesses: run counts are threshold-sensitive (S3
 * measured 16/35/5 runs across ±20 % of the trial ceilings — which is why
 * the threshold lives inside the finding); run `hours` are covered spans
 * quantized by the document's cadence, with `stepHours` (the widest
 * covered step among the day's scope hours — the same convention as
 * thermalWindow's echo) as the stated bound; the scope is the day's
 * thermalWindow hours, so a day without a window emits nothing whatever
 * the wind, and absence on a window day means no scope hour met the
 * ceiling. The band is windSummary's climb band (launch to lift top,
 * padded by its `bandMarginM`) — one construction, read at p50 on
 * ensembles. On the S3 corpus zero runs fired from calm hours: an
 * absolute ceiling cannot reproduce the gust-factor false positive the
 * 2026-08-08 spike killed.
 */
export interface WindExceedanceFinding {
  kind: "windExceedance";
  day: LocalDayKey;
  quantity: "surfaceWind" | "gust" | "bandWind";
  /** The caller's ceiling, echoed verbatim — the value actually applied. */
  thresholdMs: number;
  /** The document's semantics.gust echo; present iff quantity is "gust". */
  gustSemantics?: "hourMax" | "instant";
  /** The widest covered step among the day's scope hours — the
   * quantization bound on every run length below. */
  stepHours: number;
  runs: Array<{
    start: CitedInstant;
    end: CitedInstant;
    /** Covered span of the run's cited hours at the actual cadence. */
    hours: number;
    peakMs: number;
    peakAt: CitedInstant;
  }>;
  /** The per-hour series over exactly the day's thermalWindow hours (null
   * where the hour publishes no value for the quantity). */
  evidence: { hours: string[]; valueMs: (number | null)[] };
}

export function findWindExceedance(
  context: Context,
  windows: ThermalWindowFinding[],
): WindExceedanceFinding[] {
  const ceilings = context.windCeilings;
  if (!ceilings) return [];
  const { profile, launchReferenceM, steps } = context;
  const { bandMarginM } = context.thresholds.windSummary;

  /* The scope, per day: the union of the same-day thermalWindows' cited
     hours, keyed by the window's day — the same convention duringWindow
     uses on windSummary. */
  const hourByValidAt = new Map(profile.hours.map((hour) => [hour.validAt, hour]));
  const windowHoursByDay = new Map<string, string[]>();
  for (const window of windows) {
    const bucket = windowHoursByDay.get(window.day) ?? [];
    bucket.push(...window.evidence.hours);
    windowHoursByDay.set(window.day, bucket);
  }

  /* One entry per quantity the caller supplied a ceiling for. Gust joins
     only when the document declares its semantics AND the caller supplied
     that class's ceiling (see the kind JSDoc — never misread a threshold
     across semantics classes). */
  const gustSemantics = profile.semantics?.gust;
  const gustCeilingMs =
    gustSemantics === "hourMax"
      ? ceilings.gust?.hourMaxMs
      : gustSemantics === "instant"
        ? ceilings.gust?.instantMs
        : undefined;
  const quantities: Array<{
    quantity: WindExceedanceFinding["quantity"];
    thresholdMs: number;
    gustSemantics?: "hourMax" | "instant";
    valueOf: (hour: WindgramHour) => number | null;
  }> = [];
  if (ceilings.surfaceMs !== undefined) {
    quantities.push({
      quantity: "surfaceWind",
      thresholdMs: ceilings.surfaceMs,
      valueOf: (hour) => p50(hour.surface.windSpeedMs),
    });
  }
  if (gustSemantics !== undefined && gustCeilingMs !== undefined) {
    quantities.push({
      quantity: "gust",
      thresholdMs: gustCeilingMs,
      gustSemantics,
      valueOf: (hour) => p50(hour.surface.windGustMs),
    });
  }
  if (ceilings.bandMs !== undefined) {
    quantities.push({
      quantity: "bandWind",
      thresholdMs: ceilings.bandMs,
      valueOf: (hour) => climbBandMaxWind(hour, launchReferenceM, bandMarginM)?.windMs ?? null,
    });
  }
  if (quantities.length === 0) return [];

  const findings: WindExceedanceFinding[] = [];
  for (const [day, windowHours] of windowHoursByDay) {
    const indices = windowHours.map((validAt) => steps.indexOf.get(validAt)!);
    for (const entry of quantities) {
      const values = windowHours.map((validAt) => entry.valueOf(hourByValidAt.get(validAt)!));

      /* Maximal runs of consecutive scope hours at/above the ceiling.
         Consecutive means adjacent PUBLISHED samples: the gap between two
         same-day windows is out of scope and always breaks a run. */
      const runs: WindExceedanceFinding["runs"] = [];
      let index = 0;
      while (index < windowHours.length) {
        const value = values[index];
        if (value === null || value < entry.thresholdMs) {
          index += 1;
          continue;
        }
        let last = index;
        while (
          last + 1 < windowHours.length &&
          indices[last + 1] === indices[last] + 1 &&
          values[last + 1] !== null &&
          values[last + 1]! >= entry.thresholdMs
        ) {
          last += 1;
        }
        let peakIndex = index;
        let coveredHours = 0;
        for (let i = index; i <= last; i += 1) {
          coveredHours += steps.after[indices[i]];
          if (values[i]! > values[peakIndex]!) peakIndex = i;
        }
        runs.push({
          start: context.cite(windowHours[index]),
          end: context.cite(windowHours[last]),
          hours: coveredHours,
          peakMs: round2(values[peakIndex]!),
          peakAt: context.cite(windowHours[peakIndex]),
        });
        index = last + 1;
      }
      if (runs.length === 0) continue;

      findings.push({
        kind: "windExceedance",
        day,
        quantity: entry.quantity,
        thresholdMs: entry.thresholdMs,
        ...(entry.gustSemantics ? { gustSemantics: entry.gustSemantics } : {}),
        stepHours: Math.max(...indices.map((i) => steps.after[i])),
        runs,
        evidence: {
          hours: [...windowHours],
          valueMs: values.map((value) => (value === null ? null : round2(value))),
        },
      });
    }
  }
  return findings;
}

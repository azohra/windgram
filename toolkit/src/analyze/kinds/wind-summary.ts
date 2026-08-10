/* windSummary — the kind's type and its extractor, one module. */

import type { WindgramHour } from "../../contract/index.js";
import { localDateKey } from "../../derive/day-window.js";
import { p50 } from "../../derive/ensemble.js";
import type { ThermalWindowFinding } from "./thermal-window.js";
import { round1, round2, type CitedInstant, type Context, type LocalDayKey } from "./shared.js";

/**
 * Wind magnitudes and timing per local day: the strongest surface gust (and
 * which gust semantics the document declares for it), and the strongest
 * wind at any level inside the climb band — launch to lift top, padded by
 * `bandMarginM` — with its altitude and persistence (consecutive hours
 * around the peak whose band maximum stays within
 * `persistenceFractionOfMax` of it).
 *
 * TWO SCOPES, TWO QUESTIONS (v4, S3 2026-08-10). The whole-day maxima scan
 * every published hour of the local day; on the spike corpus that number
 * cited an hour OUTSIDE the day's thermal window in 29.9 % of gust rows
 * (clustering at 20:00/23:00/08:00 local — nocturnal drainage and fronts
 * arriving after the window closes), and the hand-verified
 * briefing-changer read "gusts to 7.23 at 02:00" about a day whose window
 * hours gust 2.23. The `duringWindow` block answers the consumer's
 * question — the wind while anyone is airborne — over exactly the same-day
 * thermalWindow's cited hours; the whole-day numbers stay, because the
 * front after the window closes is real information. The two blocks now
 * say which question each answers.
 *
 * `duringWindow` scope caveats: absent on quiet days (quietDay carries
 * those); when the window is clipped (`clippedAtStart`/`clippedAtEnd` on
 * the same-day thermalWindow) the scope is a data boundary, not a forecast
 * of calm outside it; the scope's edges are quantized like the window's —
 * the same-day thermalWindow's `stepHours` echo is the bound (a 3-hourly
 * window edge scopes coarsely).
 *
 * DELIBERATELY NO hazard or barrier verdicts. The 2026-08-08 evidence spike
 * ran gust-hazard and wind-aloft-barrier extractors over four sites × five
 * models and the verdicts did not survive: the gust-factor branch flagged
 * noise (a "hazardous" 6.5 m/s gust over a 1.6 m/s mean), the barrier
 * verdicts restated magnitudes already visible in the rows, and "hazard"
 * from a data package is a safety judgment that is pilot-, wing-, and
 * site-dependent — downstream's call, made from the magnitudes this finding
 * states.
 */
export interface WindSummaryFinding {
  kind: "windSummary";
  day: LocalDayKey;
  maxGust?: {
    gustMs: number;
    meanWindMs: number | null;
    at: CitedInstant;
    /** The document's own semantics.gust echo — hourMax reads higher than
     * instant systematically (the contract notes ~20-30 %; S3 measured the
     * within-model factor at ~1.8-2.8 at matched light mountain means —
     * either way, never pool the classes). */
    semantics?: "hourMax" | "instant";
  };
  maxWindInBand?: {
    windMs: number;
    directionDeg: number | null;
    /** Null when the winning level's pressure position has no median (full
     * ensemble dropout). Before v4 this was `?? NaN` under a `number` type
     * — NaN serializes to null in JSON, so the shipped documents already
     * said null while the type lied. */
    pressureHpa: number | null;
    heightM: number;
    at: CitedInstant;
    persistenceHours: number;
  };
  /**
   * Window-scoped wind — present only when the day has at least one
   * thermalWindow; `windowHours` (the union of the same-day windows' cited
   * hours) is the scope for every number in the block. The per-hour band
   * maxima the whole-day scan already computes stop being discarded here:
   * `evidence.bandMaxWindMs` and `evidence.windGustMs` carry the series
   * over exactly the scope hours (null where the hour publishes no gust /
   * no band). See the kind JSDoc for the S3 evidence and scope caveats.
   */
  duringWindow?: {
    windowHours: string[];
    maxGust?: {
      gustMs: number;
      meanWindMs: number | null;
      at: CitedInstant;
      /** Same echo as the whole-day maxGust. */
      semantics?: "hourMax" | "instant";
    };
    maxWindInBand?: {
      windMs: number;
      directionDeg: number | null;
      heightM: number;
      at: CitedInstant;
    };
    evidence: {
      hours: string[];
      windGustMs: (number | null)[];
      bandMaxWindMs: (number | null)[];
    };
  };
  thresholds: { bandMarginM: number; persistenceFractionOfMax: number };
}

/**
 * The strongest wind at any level inside the climb band — launch to lift
 * top, padded by `bandMarginM` — for one hour; null when the hour has no
 * published lift top or no level in the band. ONE construction: windSummary
 * (whole-day and duringWindow) and windExceedance's bandWind quantity all
 * read the band through here.
 */
export function climbBandMaxWind(
  hour: WindgramHour,
  launchReferenceM: number,
  bandMarginM: number,
): { windMs: number; directionDeg: number | null; heightM: number; pressureHpa: number | null } | null {
  const top = p50(hour.derived.usableLiftTopM);
  if (top === null) return null;
  let best: ReturnType<typeof climbBandMaxWind> = null;
  for (const level of hour.levels) {
    const heightM = p50(level.heightM);
    const windMs = p50(level.windSpeedMs);
    if (heightM === null || windMs === null) continue;
    if (heightM < launchReferenceM - bandMarginM || heightM > top + bandMarginM) continue;
    if (best === null || windMs > best.windMs) {
      best = {
        windMs,
        directionDeg: p50(level.windDirectionDeg),
        heightM,
        pressureHpa: p50(level.pressureHpa),
      };
    }
  }
  return best;
}

export function findWindSummaries(
  context: Context,
  windows: ThermalWindowFinding[],
): WindSummaryFinding[] {
  const { profile, thresholds, launchReferenceM } = context;
  const { bandMarginM, persistenceFractionOfMax } = thresholds.windSummary;

  const byDay = new Map<string, WindgramHour[]>();
  for (const hour of profile.hours) {
    const day = localDateKey(hour.validAt, context.timeZone);
    const bucket = byDay.get(day) ?? [];
    bucket.push(hour);
    byDay.set(day, bucket);
  }

  const bandMax = (hour: WindgramHour) => climbBandMaxWind(hour, launchReferenceM, bandMarginM);

  /* The duringWindow scope: the union of the same-day thermalWindows' cited
     hours, keyed by the WINDOW's day (its start day — a midnight-spanning
     window keeps its hours together rather than splitting the scope). */
  const hourByValidAt = new Map(profile.hours.map((hour) => [hour.validAt, hour]));
  const windowHoursByDay = new Map<string, string[]>();
  for (const window of windows) {
    const bucket = windowHoursByDay.get(window.day) ?? [];
    bucket.push(...window.evidence.hours);
    windowHoursByDay.set(window.day, bucket);
  }

  const findings: WindSummaryFinding[] = [];
  for (const [day, hours] of byDay) {
    const finding: WindSummaryFinding = {
      kind: "windSummary",
      day,
      thresholds: { bandMarginM, persistenceFractionOfMax },
    };

    let gustAt: WindgramHour | null = null;
    let gust = -Infinity;
    for (const hour of hours) {
      const value = p50(hour.surface.windGustMs);
      if (value !== null && value > gust) {
        gust = value;
        gustAt = hour;
      }
    }
    if (gustAt !== null) {
      const mean = p50(gustAt.surface.windSpeedMs);
      finding.maxGust = {
        gustMs: round2(gust),
        meanWindMs: mean === null ? null : round2(mean),
        at: context.cite(gustAt.validAt),
        ...(profile.semantics?.gust ? { semantics: profile.semantics.gust } : {}),
      };
    }

    const bandMaxima = hours.map((hour) => ({ hour, max: bandMax(hour) }));
    const withBand = bandMaxima.filter(
      (entry): entry is { hour: WindgramHour; max: NonNullable<ReturnType<typeof bandMax>> } =>
        entry.max !== null,
    );
    if (withBand.length > 0) {
      const peakEntry = withBand.reduce((best, entry) =>
        entry.max.windMs > best.max.windMs ? entry : best,
      );
      const peakIndex = bandMaxima.findIndex((entry) => entry === peakEntry);
      const floor = peakEntry.max.windMs * persistenceFractionOfMax;
      let runFirst = peakIndex;
      let runLast = peakIndex;
      for (let i = peakIndex - 1; i >= 0 && (bandMaxima[i].max?.windMs ?? -1) >= floor; i -= 1) {
        runFirst = i;
      }
      for (
        let i = peakIndex + 1;
        i < bandMaxima.length && (bandMaxima[i].max?.windMs ?? -1) >= floor;
        i += 1
      ) {
        runLast = i;
      }
      // Covered span of the persistence run at the actual cadence
      // (HourSteps convention) — at constant cadence exactly
      // samples × stepHours, as before v4.
      const { steps } = context;
      let persistenceHours = 0;
      for (let i = runFirst; i <= runLast; i += 1) {
        persistenceHours += steps.after[steps.indexOf.get(bandMaxima[i].hour.validAt)!];
      }
      finding.maxWindInBand = {
        windMs: round2(peakEntry.max.windMs),
        directionDeg:
          peakEntry.max.directionDeg === null ? null : Math.round(peakEntry.max.directionDeg),
        heightM: round1(peakEntry.max.heightM),
        pressureHpa: peakEntry.max.pressureHpa,
        at: context.cite(peakEntry.hour.validAt),
        persistenceHours,
      };
    }

    const windowHours = windowHoursByDay.get(day);
    if (windowHours) {
      const scoped = windowHours.map((validAt) => {
        const hour = hourByValidAt.get(validAt)!;
        return { hour, gust: p50(hour.surface.windGustMs), band: bandMax(hour) };
      });

      const duringWindow: NonNullable<WindSummaryFinding["duringWindow"]> = {
        windowHours: [...windowHours],
        evidence: {
          hours: [...windowHours],
          windGustMs: scoped.map((entry) => (entry.gust === null ? null : round2(entry.gust))),
          bandMaxWindMs: scoped.map((entry) =>
            entry.band === null ? null : round2(entry.band.windMs),
          ),
        },
      };

      const gustPeak = scoped.reduce(
        (best: (typeof scoped)[number] | null, entry) =>
          entry.gust !== null && (best === null || entry.gust > best.gust!) ? entry : best,
        null,
      );
      if (gustPeak !== null) {
        const mean = p50(gustPeak.hour.surface.windSpeedMs);
        duringWindow.maxGust = {
          gustMs: round2(gustPeak.gust!),
          meanWindMs: mean === null ? null : round2(mean),
          at: context.cite(gustPeak.hour.validAt),
          ...(profile.semantics?.gust ? { semantics: profile.semantics.gust } : {}),
        };
      }

      const bandPeak = scoped.reduce(
        (best: (typeof scoped)[number] | null, entry) =>
          entry.band !== null && (best === null || entry.band.windMs > best.band!.windMs)
            ? entry
            : best,
        null,
      );
      if (bandPeak !== null) {
        duringWindow.maxWindInBand = {
          windMs: round2(bandPeak.band!.windMs),
          directionDeg:
            bandPeak.band!.directionDeg === null ? null : Math.round(bandPeak.band!.directionDeg),
          heightM: round1(bandPeak.band!.heightM),
          at: context.cite(bandPeak.hour.validAt),
        };
      }

      finding.duringWindow = duringWindow;
    }

    if (finding.maxGust || finding.maxWindInBand || finding.duringWindow) findings.push(finding);
  }
  return findings;
}

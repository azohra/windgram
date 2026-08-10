/* windSummary — the kind's type and its extractor, one module. */

import type { WindgramHour } from "../../contract/index.js";
import { localDateKey } from "../../derive/day-window.js";
import { p50 } from "../../derive/ensemble.js";
import { round1, round2, type CitedInstant, type Context, type LocalDayKey } from "./shared.js";

/**
 * Wind magnitudes and timing per local day: the strongest surface gust (and
 * which gust semantics the document declares for it), and the strongest
 * wind at any level inside the climb band — launch to lift top, padded by
 * `bandMarginM` — with its altitude and persistence (consecutive hours
 * around the peak whose band maximum stays within
 * `persistenceFractionOfMax` of it).
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
    /** The document's own semantics.gust echo — hourMax reads ~20-30 %
     * higher than instant, systematically. */
    semantics?: "hourMax" | "instant";
  };
  maxWindInBand?: {
    windMs: number;
    directionDeg: number | null;
    heightM: number;
    pressureHpa: number;
    at: CitedInstant;
    persistenceHours: number;
  };
  thresholds: { bandMarginM: number; persistenceFractionOfMax: number };
}

export function findWindSummaries(context: Context): WindSummaryFinding[] {
  const { profile, thresholds, launchReferenceM } = context;
  const { bandMarginM, persistenceFractionOfMax } = thresholds.windSummary;

  const byDay = new Map<string, WindgramHour[]>();
  for (const hour of profile.hours) {
    const day = localDateKey(hour.validAt, context.timeZone);
    const bucket = byDay.get(day) ?? [];
    bucket.push(hour);
    byDay.set(day, bucket);
  }

  const bandMax = (
    hour: WindgramHour,
  ): { windMs: number; directionDeg: number | null; heightM: number; pressureHpa: number } | null => {
    const top = p50(hour.derived.usableLiftTopM);
    if (top === null) return null;
    let best: ReturnType<typeof bandMax> = null;
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
          pressureHpa: p50(level.pressureHpa) ?? Number.NaN,
        };
      }
    }
    return best;
  };

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
      let persistence = 1;
      for (let i = peakIndex - 1; i >= 0 && (bandMaxima[i].max?.windMs ?? -1) >= floor; i -= 1) {
        persistence += 1;
      }
      for (
        let i = peakIndex + 1;
        i < bandMaxima.length && (bandMaxima[i].max?.windMs ?? -1) >= floor;
        i += 1
      ) {
        persistence += 1;
      }
      finding.maxWindInBand = {
        windMs: round2(peakEntry.max.windMs),
        directionDeg:
          peakEntry.max.directionDeg === null ? null : Math.round(peakEntry.max.directionDeg),
        heightM: round1(peakEntry.max.heightM),
        pressureHpa: peakEntry.max.pressureHpa,
        at: context.cite(peakEntry.hour.validAt),
        persistenceHours: persistence * context.stepHours,
      };
    }

    if (finding.maxGust || finding.maxWindInBand) findings.push(finding);
  }
  return findings;
}

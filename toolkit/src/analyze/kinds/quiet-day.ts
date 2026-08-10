/* quietDay — the kind's type and its extractor, one module. */

import type { WindgramHour } from "../../contract/index.js";
import { localDateKey, localHourOfDay } from "../../derive/day-window.js";
import { p50 } from "../../derive/ensemble.js";
import type { ThermalWindowFinding } from "./thermal-window.js";
import {
  leadHoursTo,
  round1,
  round2,
  type CitedInstant,
  type Context,
  type LocalDayKey,
} from "./shared.js";

/**
 * A local day that produced NO thermal window — the negative stated with
 * its evidence instead of by absence, so a consumer's headline can say WHY
 * ("peak W* 0.4 m/s, below the 0.9 floor") rather than only "no window".
 * Emitted once per local day that has forecast hours and no thermalWindow
 * finding; a day with a window emits nothing here (the window IS the
 * statement). `failed` names the floors the day's best hours missed —
 * including the honest edge case `"coincidence"`, where each threshold is
 * met at SOME hour but never both in the same hour.
 *
 * THE CONTEXT BLOCK (v4, S4-ratified): the day's arithmetic why ("W* under
 * the floor") gains the upstream atmospheric WHY beside it — precipitation,
 * cloud cover, gust, sensible heat flux, all restatements of the document's
 * own series. S4 measured 17/17 full live quiet days carrying one (all
 * overcast, 13 also wet; flux collapse visible beside its cause). NO CAUSAL
 * VERDICT is drawn anywhere: the numbers co-occur with the quiet
 * arithmetic and the reader draws the line. Caveats the shape encodes:
 * - `cloudCoverAtPeakWstarPercent` ALONE misleads (live: 12 % at the
 *   peak-W* hour vs 85 % day mean — the peak fired in a morning clearing),
 *   so the daytime aggregate rides beside it; both are TOTAL-COLUMN cloud
 *   (an overcast cirrus deck and stratus read the same number).
 * - `maxGust` is present only where the model publishes gusts (GEPS/REPS
 *   publish none) — absent means "not published", never calm.
 * - An EMPTY context (no precipitation block, low cloud, no gust story)
 *   reads honestly: no atmospheric suppressor is stated — the flux was
 *   simply weak.
 * - On a `truncated` day the context describes the covered sliver only.
 */
export interface QuietDayFinding {
  kind: "quietDay";
  day: LocalDayKey;
  /**
   * Forecast lead: hours from `run.referenceTime` to the day's peak-W*
   * hour — the claim's headline instant, the same peak-anchor convention
   * thermalWindow documents (shared `leadHoursTo`, one home). Falls back
   * to the peak-depth hour, then the day's first covered hour, when the
   * series are unpublished.
   */
  leadHours: number;
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
   * The upstream atmospheric restatements beside the quiet arithmetic —
   * see the kind's JSDoc for what each member may and may not say.
   */
  context: {
    /**
     * Present when some covered hour's published rate exceeds `minMmHr`
     * (capTiming's embedded `precipMinMmHr` — the vocabulary's one precip
     * floor). Peak rates and threshold timings are only comparable within
     * one (semantics, step) class: a windowMean peak is a floor on the
     * instantaneous peak, and onset under windowMean reads late by up to
     * one step (S4 measured ×1.1–2.2 peak damping and 1–3 h onset slip at
     * 3 h means) — hence the `semantics` and `stepHours` echoes.
     */
    precipitation?: {
      peakMmHr: number;
      peakAt: CitedInstant;
      /** First covered hour whose rate exceeds the floor. */
      firstWetAt: CitedInstant;
      /** Covered-span hours (HourSteps convention) of the wet samples. */
      wetHours: number;
      /** The floor the block is read against — thresholds.capTiming.precipMinMmHr. */
      minMmHr: number;
      /** The document's semantics.precipitation echo, when declared. */
      semantics?: "instantRate" | "windowMeanRate";
      /** Widest step among the day's covered samples — windowMeanRate
       * means "accumulation over the step window ending at validAt", a
       * different quantity at 1 h, 3 h, and 6 h. */
      stepHours: number;
    };
    /** Total cloud cover at the peak-W* hour; null when no W* hour exists
     * or the hour publishes no cloud cover. Never read alone — see the
     * daytime aggregate beside it. */
    cloudCoverAtPeakWstarPercent: number | null;
    /** Mean total cloud cover over the day's covered samples falling in
     * local 10:00–16:00 inclusive — the daytime aggregate S4's live
     * divergence forced (12 % at peak-W* vs 85 % day mean); null when no
     * such sample publishes the series. */
    daytimeCloudCoverPercent: number | null;
    /** The day's strongest published gust; absent where the model
     * publishes none — never zero, never calm. */
    maxGust?: {
      gustMs: number;
      at: CitedInstant;
      /** The document's semantics.gust echo — hourMax reads ~20-30 %
       * higher than instant, systematically. */
      semantics?: "hourMax" | "instant";
    };
    /** The day's peak published surface sensible heat flux — the quiet
     * arithmetic's upstream driver; absent where unpublished. */
    peakSensibleHeatFluxWm2?: { valueWm2: number; at: CitedInstant };
  };
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

/**
 * The coverage block quietDay and convectiveDay share: covered span and
 * the horizon-truncation verdict over one local day's chronological
 * document hours. A continuous profile covers a full local day exactly
 * when its first covered hour falls inside the day's first step and its
 * last inside the day's last step — judged at the LOCAL cadence of those
 * hours (steps.before at the day's first sample, steps.after at its
 * last), never a document-wide constant: live GEPS switches 3 h → 6 h
 * mid-horizon, and reading the leading cadence misread its far 6-hourly
 * days as truncated (S1, 2026-08-10). Anything else means the document's
 * own horizon clips the day.
 */
export function dayCoverage(
  context: Context,
  hours: WindgramHour[],
): QuietDayFinding["coverage"] {
  const { steps } = context;
  const firstIdx = steps.indexOf.get(hours[0].validAt)!;
  const lastIdx = steps.indexOf.get(hours[hours.length - 1].validAt)!;
  const firstLocalH = localHourOfDay(hours[0].validAt, context.timeZone);
  const lastLocalH = localHourOfDay(hours[hours.length - 1].validAt, context.timeZone);
  const truncated = !(firstLocalH < steps.before[firstIdx] && lastLocalH >= 24 - steps.after[lastIdx]);
  return {
    // Covered span at the actual cadence (HourSteps convention) — at
    // constant cadence exactly samples × stepHours, as before v4.
    hours: steps.after.slice(firstIdx, lastIdx + 1).reduce((sum, span) => sum + span, 0),
    first: context.cite(hours[0].validAt),
    last: context.cite(hours[hours.length - 1].validAt),
    truncated,
  };
}

/* The negative statement: local days that produced no thermal window,
   carrying the numbers that failed. Days covered by any window hour are
   excluded via the windows' own evidence (a window that crosses midnight
   covers both its days). */
export function findQuietDays(
  context: Context,
  windows: ThermalWindowFinding[],
): QuietDayFinding[] {
  const { profile, launchReferenceM, thresholds, steps } = context;
  const { wstarMinMs, depthMinM } = thresholds.thermalWindow;
  const precipMinMmHr = thresholds.capTiming.precipMinMmHr;
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

    /* ---- the atmospheric context: restatements only, no causal verdict */
    const context_: QuietDayFinding["context"] = {
      cloudCoverAtPeakWstarPercent: null,
      daytimeCloudCoverPercent: null,
    };
    if (peakWstarAt !== null) {
      const peakHour = hours.find((hour) => hour.validAt === peakWstarAt)!;
      const cover = p50(peakHour.surface.cloudCoverPercent);
      context_.cloudCoverAtPeakWstarPercent = cover === null ? null : round1(cover);
    }
    const daytimeCover = hours
      .filter((hour) => {
        const localH = localHourOfDay(hour.validAt, context.timeZone);
        return localH >= 10 && localH <= 16;
      })
      .map((hour) => p50(hour.surface.cloudCoverPercent))
      .filter((cover): cover is number => cover !== null);
    if (daytimeCover.length > 0) {
      context_.daytimeCloudCoverPercent = round1(
        daytimeCover.reduce((sum, cover) => sum + cover, 0) / daytimeCover.length,
      );
    }
    const wet = hours
      .map((hour) => ({ hour, rate: p50(hour.surface.precipitationMmHr) }))
      .filter((entry): entry is { hour: WindgramHour; rate: number } =>
        entry.rate !== null && entry.rate > precipMinMmHr,
      );
    if (wet.length > 0) {
      const peak = wet.reduce((best, entry) => (entry.rate > best.rate ? entry : best));
      context_.precipitation = {
        peakMmHr: round2(peak.rate),
        peakAt: context.cite(peak.hour.validAt),
        firstWetAt: context.cite(wet[0].hour.validAt),
        wetHours: wet.reduce(
          (sum, entry) => sum + steps.after[steps.indexOf.get(entry.hour.validAt)!],
          0,
        ),
        minMmHr: precipMinMmHr,
        ...(profile.semantics?.precipitation
          ? { semantics: profile.semantics.precipitation }
          : {}),
        stepHours: Math.max(
          ...hours.map((hour) => steps.before[steps.indexOf.get(hour.validAt)!]),
        ),
      };
    }
    let gustAt: WindgramHour | null = null;
    let gust = -Infinity;
    let fluxAt: WindgramHour | null = null;
    let flux = -Infinity;
    for (const hour of hours) {
      const gustValue = p50(hour.surface.windGustMs);
      if (gustValue !== null && gustValue > gust) {
        gust = gustValue;
        gustAt = hour;
      }
      const fluxValue = p50(hour.surface.sensibleHeatFluxWm2);
      if (fluxValue !== null && fluxValue > flux) {
        flux = fluxValue;
        fluxAt = hour;
      }
    }
    if (gustAt !== null) {
      context_.maxGust = {
        gustMs: round2(gust),
        at: context.cite(gustAt.validAt),
        ...(profile.semantics?.gust ? { semantics: profile.semantics.gust } : {}),
      };
    }
    if (fluxAt !== null) {
      context_.peakSensibleHeatFluxWm2 = {
        valueWm2: round1(flux),
        at: context.cite(fluxAt.validAt),
      };
    }

    findings.push({
      kind: "quietDay",
      day,
      leadHours: leadHoursTo(
        profile.run.referenceTime,
        peakWstarAt ?? peakDepthAt ?? hours[0].validAt,
      ),
      peakThermalVelocityMs: peakWstar === null ? null : round2(peakWstar),
      peakThermalVelocityAt: peakWstarAt === null ? null : context.cite(peakWstarAt),
      peakLiftDepthM: peakDepth === null ? null : round1(peakDepth),
      peakLiftDepthAt: peakDepthAt === null ? null : context.cite(peakDepthAt),
      failed,
      context: context_,
      coverage: dayCoverage(context, hours),
      thresholds: { wstarMinMs, depthMinM },
    });
  }
  return findings;
}

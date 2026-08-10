/* convectiveDay — the kind's type and its extractor, one module. */

import { localDateKey } from "../../derive/day-window.js";
import { p50 } from "../../derive/ensemble.js";
import type { ThermalWindowFinding } from "./thermal-window.js";
import { dayCoverage } from "./quiet-day.js";
import { round2, type CitedInstant, type Context, type LocalDayKey } from "./shared.js";

/**
 * The convective story a CIN-less model CAN tell: CAPE magnitude and
 * timing plus precipitation timing per local day — verdict-free
 * restatements. NEW at v4 (S4-ratified): capTiming's CIN gate silenced the
 * flagship HRDPS family entirely (it publishes CAPE with no CIN), so a
 * washout day read "peak w* 0.2" and never said what the instability was
 * doing. Emitted only where the document publishes CAPE and NO CIN
 * anywhere, on deterministic days sampled hourly — exactly the family S4
 * measured (16 full HRDPS site-days; the RDPS cross-check found no case
 * where this statement contradicts the full CIN story).
 *
 * WHAT THE KIND MUST NOT SAY, encoded in the shape:
 * - `capIsJudgeable: false` — the model publishes no CIN, and per the
 *   contract's own cinJkg JSDoc, absence must NEVER be read as "no cap".
 *   Nothing here invites the reader to infer "uncapped".
 * - CAPE magnitudes are model-specific: S4 measured ~4.7× same-site,
 *   same-day spread (HRDPS 224 vs RDPS 1051 J/kg), and HRRR sits
 *   edge-of-domain at the BC sites (CAPE ≤ 190 vs HRDPS/RDPS 400–1500).
 *   Never compare peakCapeJkg across documents.
 * - `coverage` is mandatory (quietDay's block verbatim): live HRDPS
 *   horizon slivers carry NOCTURNAL elevated CAPE with day peaks cited at
 *   01:00–05:00 — real published values, horizon artifacts as soaring
 *   statements unless the truncation is confessed. On a truncated day the
 *   peak is a peak OF THE COVERED HOURS only, and the finding must not
 *   vote in cross-model comparisons.
 * - A zero precipitation series is a FORECAST of dryness, not absence
 *   (the field is always published for these models):
 *   `noPrecipAboveThreshold` states the honest positive. Exactly one of
 *   `precipStartsAt` / `noPrecipAboveThreshold` is present.
 * - `precipSemantics` + `stepHours` echo beside the `precipMinMmHr`
 *   comparison (Tier 0 #6 as S4 extended it): rates are only comparable
 *   within one (semantics, step) class.
 */
export interface ConvectiveDayFinding {
  kind: "convectiveDay";
  day: LocalDayKey;
  peakCapeJkg: number;
  /** Null when the day's published CAPE is zero throughout. */
  peakCapeAt: CitedInstant | null;
  /** Always false — the kind exists only where the model publishes no
   * CIN; it cannot say whether the instability is capped. */
  capIsJudgeable: false;
  capNotJudgeableReason: "modelPublishesNoCin";
  /** First covered hour precipitation exceeds thresholds.precipMinMmHr. */
  precipStartsAt?: CitedInstant;
  peakPrecipMmHr?: number;
  /** The honest positive: every covered hour's published rate sits at or
   * under the floor — a 0.00 series is a forecast, not absence. */
  noPrecipAboveThreshold?: true;
  /** The document's semantics.precipitation echo, when declared. */
  precipSemantics?: "instantRate" | "windowMeanRate";
  /** Widest gap between the day's cited rows, hours (1 on these hourly
   * documents — stated so the echo survives any future gate change). */
  stepHours: number;
  /** The same-day thermalWindow's end — the "instability outlives the
   * window" read (live: flagpole peak CAPE at 18:00 vs window end 16:00).
   * Present when that finding exists for this day. */
  thermalWindowEndsAt?: CitedInstant;
  /** quietDay's coverage block verbatim — see that kind's JSDoc; a
   * truncated day's statement reads "of the covered hours" and must not
   * vote in comparisons. */
  coverage: {
    hours: number;
    first: CitedInstant;
    last: CitedInstant;
    truncated: boolean;
  };
  thresholds: { precipMinMmHr: number };
  evidence: {
    hours: string[];
    capeJkg: number[];
    /** Aligned with hours; null where the hour publishes no rate. */
    precipitationMmHr: Array<number | null>;
  };
}

export function findConvectiveDays(
  context: Context,
  windows: ThermalWindowFinding[],
): ConvectiveDayFinding[] {
  const { profile, thresholds } = context;
  // The gate (see the kind's JSDoc): deterministic documents that publish
  // CAPE somewhere and CIN nowhere — the CIN-capable models carry the full
  // cap story through capTiming instead, and ensembles stay silent (p50
  // CAPE under member dropout was not what S4 measured).
  if (!context.deterministic) return [];
  const publishesCape = profile.hours.some((hour) => hour.surface.capeJkg !== undefined);
  const publishesCin = profile.hours.some((hour) => hour.surface.cinJkg !== undefined);
  if (!publishesCape || publishesCin) return [];

  const rows = profile.hours
    .map((hour) => ({ hour, cape: p50(hour.surface.capeJkg) }))
    .filter((row): row is typeof row & { cape: number } => row.cape !== null);

  const { precipMinMmHr } = thresholds.convectiveDay;
  const byDay = new Map<string, typeof rows>();
  for (const row of rows) {
    const day = localDateKey(row.hour.validAt, context.timeZone);
    const bucket = byDay.get(day) ?? [];
    bucket.push(row);
    byDay.set(day, bucket);
  }
  const windowEndByDay = new Map(windows.map((window) => [window.day, window.end]));

  const findings: ConvectiveDayFinding[] = [];
  for (const [day, dayRows] of byDay) {
    // Hourly sampling AT THIS DAY, as capTiming's instant gate: at least
    // two rows, every adjacent pair one hour apart — the family the S4
    // evidence covers. Truncated slivers pass (they are hourly) and carry
    // their confession in coverage.truncated.
    const hourly =
      dayRows.length >= 2 &&
      dayRows.every(
        (row, i) =>
          i === 0 ||
          Date.parse(row.hour.validAt) - Date.parse(dayRows[i - 1].hour.validAt) === 3_600_000,
      );
    if (!hourly) continue;

    const peak = dayRows.reduce((best, row) => (row.cape > best.cape ? row : best));
    const rates = dayRows.map((row) => p50(row.hour.surface.precipitationMmHr));
    const wet = dayRows
      .map((row, i) => ({ row, rate: rates[i] }))
      .filter((entry): entry is { row: (typeof dayRows)[number]; rate: number } =>
        entry.rate !== null && entry.rate > precipMinMmHr,
      );

    const finding: ConvectiveDayFinding = {
      kind: "convectiveDay",
      day,
      peakCapeJkg: Math.round(peak.cape),
      peakCapeAt: peak.cape > 0 ? context.cite(peak.hour.validAt) : null,
      capIsJudgeable: false,
      capNotJudgeableReason: "modelPublishesNoCin",
      ...(profile.semantics?.precipitation
        ? { precipSemantics: profile.semantics.precipitation }
        : {}),
      stepHours: 1,
      ...(windowEndByDay.has(day) ? { thermalWindowEndsAt: windowEndByDay.get(day)! } : {}),
      coverage: dayCoverage(context, dayRows.map((row) => row.hour)),
      thresholds: { precipMinMmHr },
      evidence: {
        hours: dayRows.map((row) => row.hour.validAt),
        capeJkg: dayRows.map((row) => Math.round(row.cape)),
        // Contract 2-dp for mm/h (pipeline publish table).
        precipitationMmHr: rates.map((rate) => (rate === null ? null : round2(rate))),
      },
    };
    if (wet.length > 0) {
      finding.precipStartsAt = context.cite(wet[0].row.hour.validAt);
      finding.peakPrecipMmHr = round2(Math.max(...wet.map((entry) => entry.rate)));
    } else if (rates.some((rate) => rate !== null)) {
      // The always-published series never crossed the floor: a forecast
      // of dryness, stated positively.
      finding.noPrecipAboveThreshold = true;
    }
    findings.push(finding);
  }
  return findings;
}

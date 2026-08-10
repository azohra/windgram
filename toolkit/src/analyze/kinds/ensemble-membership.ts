/* ensembleMembership — the kind's type and its extractor, one module. */

import { isEnsembleValue, type Scalar, type WindgramHour } from "../../contract/index.js";
import { localDateKey, localHourOfDay } from "../../derive/day-window.js";
import {
  leadHoursTo,
  round1,
  round2,
  type CitedInstant,
  type Context,
  type LocalDayKey,
} from "./shared.js";

/**
 * The membership honesty layer for ensemble documents. `membership` is the
 * per-quantity member-count profile — the "0-of-21 p50" landmine the spike
 * surfaced on GEPS CAPE, where percentile blocks over an hour can be
 * computed from far fewer than the run's declared members (nulls are
 * excluded, not ranked at zero). `bands` states the p10-p90 band-width
 * magnitude for the derived series; `dayBands` is the per-local-day width
 * series at each day's peak-p50-w* hour. No confidence verdicts: the band
 * is member spread, not a confidence interval, and this module does not
 * use the word.
 *
 * REMOVED at vocabulary v4 (ratified; S1, 2026-08-10, measured both
 * failure modes live on ONE document):
 * - `bands.trend` ("widening/steady") — a first-vs-last comparison whose
 *   verdict was a diurnal confound in BOTH directions: live GEPS read
 *   usableLiftTopM "widening" because its first hours were night (band
 *   width 0) and thermalVelocityMs "steady" because its LAST hour was
 *   night (width 0 zeroed the comparison). The verdict measured where the
 *   horizon ends, not spread growth; its `wideningRatio` threshold left
 *   the vocabulary with it. `dayBands` is the honest replacement: the
 *   series itself, no monotonicity verdict of any kind (S1 measured w*
 *   spread peaking at day 3-4 then NARROWING — a real, non-monotone shape
 *   any trend token would flatten into a lie).
 * - `maxRelativeSpread` / `maxSpreadAt` — width/p50 explodes as p50→0, so
 *   the live value pointed at the least consequential hour. The evidence
 *   arrays keep the truth.
 */
export interface EnsembleMembershipFinding {
  kind: "ensembleMembership";
  /** run.members where declared; otherwise the max per-position count seen. */
  declaredMembers: number;
  membership: Array<{
    quantity: string;
    minMembers: number;
    hoursBelowFull: number;
    ofHours: number;
    evidence: { examples: Array<{ validAt: string; members: number }> };
  }>;
  bands: Array<{
    series: "usableLiftTopM" | "thermalVelocityMs";
    hoursWithSignal: number;
    medianBandWidth: number;
    evidence: { hours: string[]; p50: number[]; bandWidth: number[] };
  }>;
  /**
   * The per-local-day band-width series (S1 Q5): both derived series'
   * p10-p90 width read at each day's peak-p50-w* hour — the hour the day's
   * thermal statement leans on, so day-over-day spread is compared at like
   * instants instead of across the diurnal cycle. A width is null when
   * that hour's band is unpublished (dropout at the peak hour). NO trend
   * verdict rides this series — see the removal note above; the honest
   * product is the series itself.
   */
  dayBands: Array<{
    day: LocalDayKey;
    /** The day's peak-p50-w* hour — where both widths are read. */
    peakHour: CitedInstant;
    /** Hours from run.referenceTime to the peak hour (shared leadHoursTo —
     * the same day-keyed anchor convention as thermalWindow's peak). */
    leadHours: number;
    wstarBandWidthMs: number | null;
    liftTopBandWidthM: number | null;
    /**
     * The document's own hour range clips this local day (quietDay's
     * coverage arithmetic, judged at the day's own edge cadence): a stub
     * day's width is a horizon artifact — S1's live last day peaked at
     * 05:00 local with w* 0.00 — and must not read as a day the series
     * states.
     */
    truncated: boolean;
  }>;
}

export function findEnsembleMembership(context: Context): EnsembleMembershipFinding[] {
  const { profile, steps } = context;
  if (context.deterministic) return [];

  // Per-quantity member-count profile over the surface and derived blocks.
  let observedMax = 0;
  const perQuantity = new Map<string, Array<{ validAt: string; members: number }>>();
  const record = (quantity: string, validAt: string, value: Scalar | null | undefined) => {
    if (value === null || value === undefined || !isEnsembleValue(value)) return;
    observedMax = Math.max(observedMax, value.members);
    const rows = perQuantity.get(quantity) ?? [];
    rows.push({ validAt, members: value.members });
    perQuantity.set(quantity, rows);
  };
  for (const hour of profile.hours) {
    for (const [key, value] of Object.entries(hour.surface)) record(key, hour.validAt, value);
    for (const [key, value] of Object.entries(hour.derived)) record(key, hour.validAt, value);
  }
  const declaredMembers = profile.run.members ?? observedMax;

  const membership: EnsembleMembershipFinding["membership"] = [];
  for (const [quantity, rows] of perQuantity) {
    const below = rows.filter((row) => row.members < declaredMembers);
    if (below.length === 0) continue;
    membership.push({
      quantity,
      minMembers: Math.min(...below.map((row) => row.members)),
      hoursBelowFull: below.length,
      ofHours: rows.length,
      evidence: { examples: below.slice(0, 4) },
    });
  }

  // Band-width magnitude on the derived series — evidence arrays, no
  // trend verdict (removed at v4; see the kind's JSDoc).
  const bands: EnsembleMembershipFinding["bands"] = [];
  for (const series of ["usableLiftTopM", "thermalVelocityMs"] as const) {
    // Contract precision per series: metres at 1, m/s at 2.
    const roundSeries = series === "thermalVelocityMs" ? round2 : round1;
    const rows: Array<{ validAt: string; p50: number; width: number }> = [];
    for (const hour of profile.hours) {
      const value = hour.derived[series];
      if (value === null || !isEnsembleValue(value)) continue;
      // Full dropout carries no band; the membership counts above already
      // state the zero, which is the finding's job for that hour.
      if (value.p10 === null || value.p90 === null || value.p50 === null) continue;
      rows.push({ validAt: hour.validAt, p50: value.p50, width: value.p90 - value.p10 });
    }
    if (rows.length === 0) continue;
    const widths = rows.map((row) => row.width).sort((a, b) => a - b);
    bands.push({
      series,
      hoursWithSignal: rows.length,
      medianBandWidth: roundSeries(widths[Math.floor(widths.length / 2)]),
      evidence: {
        hours: rows.map((row) => row.validAt),
        p50: rows.map((row) => roundSeries(row.p50)),
        bandWidth: rows.map((row) => roundSeries(row.width)),
      },
    });
  }

  // The per-day width series at each day's peak-p50-w* hour (S1 Q5).
  const byDay = new Map<string, WindgramHour[]>();
  for (const hour of profile.hours) {
    const day = localDateKey(hour.validAt, context.timeZone);
    const group = byDay.get(day) ?? [];
    group.push(hour);
    byDay.set(day, group);
  }
  const width = (value: Scalar | null | undefined): number | null => {
    if (value === null || value === undefined || !isEnsembleValue(value)) return null;
    if (value.p10 === null || value.p90 === null) return null;
    return value.p90 - value.p10;
  };
  const dayBands: EnsembleMembershipFinding["dayBands"] = [];
  for (const [day, hours] of byDay) {
    // The day's peak-p50-w* hour; a day with no published w* median has
    // no comparison instant and states no row.
    let peak: WindgramHour | null = null;
    let peakWstar: number | null = null;
    for (const hour of hours) {
      const value = hour.derived.thermalVelocityMs;
      if (value === null || value === undefined || !isEnsembleValue(value)) continue;
      if (value.p50 === null) continue;
      if (peakWstar === null || value.p50 > peakWstar) {
        peakWstar = value.p50;
        peak = hour;
      }
    }
    if (peak === null) continue;
    // quietDay's coverage arithmetic, judged at the day's own edge
    // cadence (per-gap; live GEPS switches 3 h → 6 h mid-horizon).
    const firstIdx = steps.indexOf.get(hours[0].validAt)!;
    const lastIdx = steps.indexOf.get(hours[hours.length - 1].validAt)!;
    const firstLocalH = localHourOfDay(hours[0].validAt, context.timeZone);
    const lastLocalH = localHourOfDay(hours[hours.length - 1].validAt, context.timeZone);
    const truncated = !(
      firstLocalH < steps.before[firstIdx] && lastLocalH >= 24 - steps.after[lastIdx]
    );
    const wstarWidth = width(peak.derived.thermalVelocityMs);
    const liftTopWidth = width(peak.derived.usableLiftTopM);
    dayBands.push({
      day,
      peakHour: context.cite(peak.validAt),
      leadHours: leadHoursTo(profile.run.referenceTime, peak.validAt),
      wstarBandWidthMs: wstarWidth === null ? null : round2(wstarWidth),
      liftTopBandWidthM: liftTopWidth === null ? null : round1(liftTopWidth),
      truncated,
    });
  }

  if (membership.length === 0 && bands.length === 0 && dayBands.length === 0) return [];
  return [{ kind: "ensembleMembership", declaredMembers, membership, bands, dayBands }];
}

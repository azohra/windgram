/* capTiming — the kind's type and its extractor, one module. */

import { localDateKey } from "../../derive/day-window.js";
import { p50 } from "../../derive/ensemble.js";
import type { ThermalWindowFinding } from "./thermal-window.js";
import { round1, type CitedInstant, type Context, type LocalDayKey } from "./shared.js";

/**
 * The overdevelopment-timing story per local day: CAPE build vs CIN erosion
 * vs the thermal window's close. GATED to hourly deterministic documents
 * that publish CIN: the spike found ensemble-median CIN bimodal (a p50 over
 * members half of whom have broken the cap says neither thing), and
 * 3-hourly cadence makes "when the cap breaks" interpolation rather than
 * forecast — so ensembles and multi-hour steps emit nothing here.
 * Verdicts are arithmetic relations over the embedded thresholds:
 * `noInstability` (peak CAPE under `instabilityMinCapeJkg`), `capBreaks`
 * (some hour has |CIN| < `brokenCapMaxAbsCinJkg` while CAPE >
 * `brokenCapMinCapeJkg`), `cappedAllDay` (instability without such an hour).
 */
export interface CapTimingFinding {
  kind: "capTiming";
  day: LocalDayKey;
  verdict: "capBreaks" | "cappedAllDay" | "noInstability";
  peakCapeJkg: number;
  peakCapeAt: CitedInstant | null;
  capBreaksAt?: CitedInstant;
  capeAtBreakJkg?: number;
  /** First hour precipitation exceeds thresholds.precipMinMmHr — the
   * overdevelopment confirmation, when the model forecasts one. */
  precipStartsAt?: CitedInstant;
  peakPrecipMmHr?: number;
  /** The same-day thermalWindow's end — the timing anchor the cap story is
   * read against. Present when that finding exists for this day. */
  thermalWindowEndsAt?: CitedInstant;
  thresholds: {
    instabilityMinCapeJkg: number;
    brokenCapMaxAbsCinJkg: number;
    brokenCapMinCapeJkg: number;
    precipMinMmHr: number;
  };
  evidence: { hours: string[]; capeJkg: number[]; cinJkg: number[] };
}

export function findCapTiming(
  context: Context,
  windows: ThermalWindowFinding[],
): CapTimingFinding[] {
  const { profile, thresholds, stepHours } = context;
  // The gate (see the kind's JSDoc): hourly deterministic with CIN only.
  if (!context.deterministic || stepHours !== 1) return [];
  const rows = profile.hours
    .map((hour) => ({
      hour,
      cape: p50(hour.surface.capeJkg),
      cin: p50(hour.surface.cinJkg),
    }))
    .filter((row): row is typeof row & { cape: number; cin: number } =>
      row.cape !== null && row.cin !== null,
    );
  if (rows.length === 0) return [];

  const limits = thresholds.capTiming;
  const byDay = new Map<string, typeof rows>();
  for (const row of rows) {
    const day = localDateKey(row.hour.validAt, context.timeZone);
    const bucket = byDay.get(day) ?? [];
    bucket.push(row);
    byDay.set(day, bucket);
  }
  const windowEndByDay = new Map(windows.map((window) => [window.day, window.end]));

  const findings: CapTimingFinding[] = [];
  for (const [day, dayRows] of byDay) {
    const peak = dayRows.reduce((best, row) => (row.cape > best.cape ? row : best));
    const evidence = {
      hours: dayRows.map((row) => row.hour.validAt),
      capeJkg: dayRows.map((row) => Math.round(row.cape)),
      cinJkg: dayRows.map((row) => Math.round(row.cin)),
    };
    const shared = {
      thresholds: { ...limits },
      evidence,
      ...(windowEndByDay.has(day) ? { thermalWindowEndsAt: windowEndByDay.get(day)! } : {}),
    };

    if (peak.cape < limits.instabilityMinCapeJkg) {
      findings.push({
        kind: "capTiming",
        day,
        verdict: "noInstability",
        peakCapeJkg: Math.round(peak.cape),
        peakCapeAt: peak.cape > 0 ? context.cite(peak.hour.validAt) : null,
        ...shared,
      });
      continue;
    }

    const broken = dayRows.find(
      (row) => Math.abs(row.cin) < limits.brokenCapMaxAbsCinJkg && row.cape > limits.brokenCapMinCapeJkg,
    );
    const finding: CapTimingFinding = {
      kind: "capTiming",
      day,
      verdict: broken ? "capBreaks" : "cappedAllDay",
      peakCapeJkg: Math.round(peak.cape),
      peakCapeAt: context.cite(peak.hour.validAt),
      ...shared,
    };
    if (broken) {
      finding.capBreaksAt = context.cite(broken.hour.validAt);
      finding.capeAtBreakJkg = Math.round(broken.cape);
    }
    const wet = dayRows
      .map((row) => ({ row, rate: p50(row.hour.surface.precipitationMmHr) }))
      .filter((entry): entry is { row: (typeof dayRows)[number]; rate: number } =>
        entry.rate !== null && entry.rate > limits.precipMinMmHr,
      );
    if (wet.length > 0) {
      finding.precipStartsAt = context.cite(wet[0].row.hour.validAt);
      finding.peakPrecipMmHr = round1(Math.max(...wet.map((entry) => entry.rate)));
    }
    findings.push(finding);
  }
  return findings;
}

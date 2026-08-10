/* capTiming — the kind's type and its extractor, one module. */

import { localDateKey } from "../../derive/day-window.js";
import { p50 } from "../../derive/ensemble.js";
import type { ThermalWindowFinding } from "./thermal-window.js";
import { round1, type CitedInstant, type Context, type LocalDayKey } from "./shared.js";

/**
 * The overdevelopment-timing story per local day: CAPE build vs CIN erosion
 * vs the thermal window's close. GATED to deterministic documents that
 * publish CIN, on days sampled hourly: the spike found ensemble-median CIN
 * bimodal (a p50 over members half of whom have broken the cap says
 * neither thing), and multi-hour cadence makes "when the cap breaks"
 * interpolation rather than forecast — so ensembles emit nothing here, and
 * the hourly test runs per DAY (cadence widens mid-horizon on live
 * documents; a day whose CAPE/CIN rows are not adjacent hourly samples is
 * silent, including single-sample days).
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
  const { profile, thresholds } = context;
  // The gate (see the kind's JSDoc): hourly deterministic with CIN only.
  // Deterministic is a document fact; hourly is judged PER DAY below —
  // cadence is not a document-wide constant (live GDPS widens 3 h → 6 h
  // mid-horizon; S4 measured its far-horizon steps at 11:00 → 17:00 →
  // 23:00), so a leading-pair read would admit far coarse days on a
  // document that merely starts hourly.
  if (!context.deterministic) return [];
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
    // Instant verdicts need hourly sampling AT THIS DAY: every adjacent
    // pair of the day's CAPE/CIN rows exactly one hour apart, and at
    // least two rows (a single sample cannot carry a day's cap story).
    // Days sampled coarser say nothing here — "when the cap breaks" at
    // multi-hour spacing is interpolation, not forecast.
    const hourly =
      dayRows.length >= 2 &&
      dayRows.every(
        (row, i) =>
          i === 0 ||
          Date.parse(row.hour.validAt) - Date.parse(dayRows[i - 1].hour.validAt) === 3_600_000,
      );
    if (!hourly) continue;
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

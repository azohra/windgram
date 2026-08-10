/* capTiming — the kind's type and its extractor, one module. */

import { localDateKey } from "../../derive/day-window.js";
import { p50 } from "../../derive/ensemble.js";
import type { ThermalWindowFinding } from "./thermal-window.js";
import { round2, type CitedInstant, type Context, type LocalDayKey } from "./shared.js";

/**
 * The overdevelopment-timing story per local day: CAPE build vs CIN erosion
 * vs the thermal window's close. GATED to deterministic documents that
 * publish CIN: the spike found ensemble-median CIN bimodal (a p50 over
 * members half of whom have broken the cap says neither thing), so
 * ensembles emit nothing here — that gate is untouched at v4.
 *
 * CADENCE (v4, S4-ratified): the day's own sampling decides the verdict
 * semantics, stated in `cadence`.
 * - `"hourly"` days (every adjacent CAPE/CIN row exactly one hour apart)
 *   carry INSTANT verdicts: `capBreaksAt` cites the broken hour.
 * - `"multiHour"` days carry INTERVAL verdicts: `capBreaksBetween` cites
 *   the two adjacent PUBLISHED steps the break falls between — both
 *   endpoints are CitedInstants from the evidence, never `stepHours`
 *   arithmetic (live GDPS widens 3 h → 6 h mid-document). S4's audit,
 *   subsampling hourly CIN-capable models to 3 h against their own hourly
 *   truth: interval containment 16/16, zero phantom breaks. The endpoints
 *   are document steps, not forecasts of the break hour; the break may
 *   not persist (evening re-capping is common — the evidence arrays show
 *   it). A day whose FIRST covered step is already broken states
 *   `capAlreadyOpenAt` instead of an interval — "cap already open at
 *   first covered step" (5 live GDPS site-days), a day edge, not a break
 *   timing. Before v4 multi-hour days were silent; this extends coverage
 *   to the 3-hourly CIN-capable models (GFS/GDPS — the only CIN story on
 *   days 3+), it does not replace the instant verdicts.
 *
 * Verdicts are arithmetic relations over the embedded thresholds:
 * - `noInstability` — peak CAPE under `instabilityMinCapeJkg`.
 * - `capBreaks` — some row has |CIN| < `brokenCapMaxAbsCinJkg` while
 *   CAPE > `brokenCapMinCapeJkg`.
 * - `openButWeak` (NEW at v4, ratified 4b) — no such row, and EVERY row's
 *   |CIN| sits under `brokenCapMaxAbsCinJkg`: the cap sat physically open
 *   all day while CAPE never cleared the break floor. Before v4 this read
 *   `cappedAllDay` — live twice on RDPS (CIN ≈ 0 all day, CAPE 124–208
 *   under the 200 floor) the verdict called an open cap "capped".
 * - `cappedAllDay` — instability without a broken row, and some row's cap
 *   actually holds (|CIN| ≥ the threshold). At `"multiHour"` cadence this
 *   means "no PUBLISHED step was broken": S4 measured a 12.5 % phantom-cap
 *   rate (3 of 24 subsampled days where the hourly truth broke between or
 *   before the published steps) — read a multi-hour cappedAllDay as a
 *   claim about the published steps only, never about the hours between.
 *
 * ECHOES (v4, Tier 0 #6 as S4 extended it): `precipSemantics` restates the
 * document's `semantics.precipitation` beside the `precipMinMmHr`
 * comparison (instantRate and windowMeanRate are different quantities),
 * and `stepHours` states the widest gap between the day's cited rows —
 * windowMean rates are step-dependent (S4 measured peaks dropping
 * ×1.1–2.2 and onset slipping 1–3 h at 3 h means), and interval widths
 * quantize to it.
 */
export interface CapTimingFinding {
  kind: "capTiming";
  day: LocalDayKey;
  /** Which verdict semantics apply — see the kind's JSDoc: "hourly" days
   * carry instant verdicts, "multiHour" days carry interval verdicts over
   * the published steps only. */
  cadence: "hourly" | "multiHour";
  verdict: "capBreaks" | "cappedAllDay" | "openButWeak" | "noInstability";
  peakCapeJkg: number;
  peakCapeAt: CitedInstant | null;
  /** Hourly days only: the first broken hour. */
  capBreaksAt?: CitedInstant;
  /** Multi-hour days only: the cap breaks somewhere between these two
   * adjacent cited steps (open at `by`, still capped at `after`). */
  capBreaksBetween?: { after: CitedInstant; by: CitedInstant };
  /** Multi-hour days only: the day's first covered step is already broken
   * — a day edge, not a break timing; no interval exists to cite. */
  capAlreadyOpenAt?: CitedInstant;
  capeAtBreakJkg?: number;
  /** First hour precipitation exceeds thresholds.precipMinMmHr — the
   * overdevelopment confirmation, when the model forecasts one. */
  precipStartsAt?: CitedInstant;
  peakPrecipMmHr?: number;
  /** The document's semantics.precipitation echo, when declared — the
   * precipMinMmHr comparison reads differently under instantRate and
   * windowMeanRate. */
  precipSemantics?: "instantRate" | "windowMeanRate";
  /** Widest gap between the day's cited CAPE/CIN rows, hours — the
   * quantization bound on every timing this finding states. */
  stepHours: number;
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
  // The gate (see the kind's JSDoc): deterministic documents with CIN.
  // Cadence is judged PER DAY below — not a document-wide constant (live
  // GDPS widens 3 h → 6 h mid-horizon) — and selects instant vs interval
  // verdict semantics rather than silencing the day.
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
    // A single sample cannot carry a day's cap story at either cadence.
    if (dayRows.length < 2) continue;
    // Gaps between the day's cited rows, hours — read from the rows'
    // own timestamps (never a document constant): they set the cadence
    // branch and the stepHours quantization echo.
    const gaps = dayRows
      .slice(1)
      .map((row, i) =>
        Math.round((Date.parse(row.hour.validAt) - Date.parse(dayRows[i].hour.validAt)) / 3_600_000),
      );
    const cadence: CapTimingFinding["cadence"] = gaps.every((gap) => gap === 1)
      ? "hourly"
      : "multiHour";
    const peak = dayRows.reduce((best, row) => (row.cape > best.cape ? row : best));
    const evidence = {
      hours: dayRows.map((row) => row.hour.validAt),
      capeJkg: dayRows.map((row) => Math.round(row.cape)),
      cinJkg: dayRows.map((row) => Math.round(row.cin)),
    };
    const shared = {
      cadence,
      stepHours: Math.max(...gaps),
      ...(profile.semantics?.precipitation
        ? { precipSemantics: profile.semantics.precipitation }
        : {}),
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

    const brokenIndex = dayRows.findIndex(
      (row) => Math.abs(row.cin) < limits.brokenCapMaxAbsCinJkg && row.cape > limits.brokenCapMinCapeJkg,
    );
    // The third leg (v4, ratified 4b): with no broken row, an all-day-open
    // cap (every |CIN| under the threshold) is a different atmosphere from
    // a cap that holds — CAPE merely never cleared the break floor.
    const capNeverHolds = dayRows.every(
      (row) => Math.abs(row.cin) < limits.brokenCapMaxAbsCinJkg,
    );
    const finding: CapTimingFinding = {
      kind: "capTiming",
      day,
      verdict: brokenIndex >= 0 ? "capBreaks" : capNeverHolds ? "openButWeak" : "cappedAllDay",
      peakCapeJkg: Math.round(peak.cape),
      peakCapeAt: context.cite(peak.hour.validAt),
      ...shared,
    };
    if (brokenIndex >= 0) {
      const broken = dayRows[brokenIndex];
      if (cadence === "hourly") {
        finding.capBreaksAt = context.cite(broken.hour.validAt);
      } else if (brokenIndex === 0) {
        // Day edge: nothing published before the broken step — "cap
        // already open at first covered step", not an interval.
        finding.capAlreadyOpenAt = context.cite(broken.hour.validAt);
      } else {
        finding.capBreaksBetween = {
          after: context.cite(dayRows[brokenIndex - 1].hour.validAt),
          by: context.cite(broken.hour.validAt),
        };
      }
      finding.capeAtBreakJkg = Math.round(broken.cape);
    }
    const wet = dayRows
      .map((row) => ({ row, rate: p50(row.hour.surface.precipitationMmHr) }))
      .filter((entry): entry is { row: (typeof dayRows)[number]; rate: number } =>
        entry.rate !== null && entry.rate > limits.precipMinMmHr,
      );
    if (wet.length > 0) {
      finding.precipStartsAt = context.cite(wet[0].row.hour.validAt);
      // Contract 2-dp for mm/h (pipeline publish table) — round1 could
      // print a peak indistinguishable from the threshold it exceeds.
      finding.peakPrecipMmHr = round2(Math.max(...wet.map((entry) => entry.rate)));
    }
    findings.push(finding);
  }
  return findings;
}

/* ensembleMembership — the kind's type and its extractor, one module. */

import { isEnsembleValue, type Scalar } from "../../contract/index.js";
import { round1, round2, type CitedInstant, type Context } from "./shared.js";

/**
 * The membership honesty layer for ensemble documents. `membership` is the
 * per-quantity member-count profile — the "0-of-21 p50" landmine the spike
 * surfaced on GEPS CAPE, where percentile blocks over an hour can be
 * computed from far fewer than the run's declared members (nulls are
 * excluded, not ranked at zero). `bands` states the p10-p90 band-width
 * magnitude and its trend across the horizon for the derived series. No
 * confidence verdicts: the band is member spread, not a confidence
 * interval, and this module does not use the word.
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
    maxRelativeSpread: number | null;
    maxSpreadAt: CitedInstant | null;
    /** Arithmetic trend: widening when the last band width exceeds the
     * first by `thresholds.wideningRatio`, else steady. */
    trend: "widening" | "steady";
    thresholds: { wideningRatio: number };
    evidence: { hours: string[]; p50: number[]; bandWidth: number[] };
  }>;
}

export function findEnsembleMembership(context: Context): EnsembleMembershipFinding[] {
  const { profile, thresholds } = context;
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

  // Band-width magnitude and trend on the derived series.
  const bands: EnsembleMembershipFinding["bands"] = [];
  for (const series of ["usableLiftTopM", "thermalVelocityMs"] as const) {
    // Contract precision per series: metres at 1, m/s at 2. The relative
    // spread is a ratio, not a magnitude — it stays at one decimal.
    const roundSeries = series === "thermalVelocityMs" ? round2 : round1;
    const rows: Array<{ validAt: string; p50: number; width: number; relative: number | null }> =
      [];
    for (const hour of profile.hours) {
      const value = hour.derived[series];
      if (value === null || !isEnsembleValue(value)) continue;
      // Full dropout carries no band; the membership counts above already
      // state the zero, which is the finding's job for that hour.
      if (value.p10 === null || value.p90 === null || value.p50 === null) continue;
      const width = value.p90 - value.p10;
      rows.push({
        validAt: hour.validAt,
        p50: value.p50,
        width,
        relative: value.p50 !== 0 ? width / value.p50 : null,
      });
    }
    if (rows.length === 0) continue;
    const widths = rows.map((row) => row.width).sort((a, b) => a - b);
    const withRelative = rows.filter(
      (row): row is typeof row & { relative: number } => row.relative !== null,
    );
    const worst =
      withRelative.length > 0
        ? withRelative.reduce((best, row) => (row.relative > best.relative ? row : best))
        : null;
    const ratio = thresholds.ensembleMembership.wideningRatio;
    bands.push({
      series,
      hoursWithSignal: rows.length,
      medianBandWidth: roundSeries(widths[Math.floor(widths.length / 2)]),
      maxRelativeSpread: worst === null ? null : round1(worst.relative),
      maxSpreadAt: worst === null ? null : context.cite(worst.validAt),
      trend:
        rows.length > 3 && rows[rows.length - 1].width > ratio * rows[0].width
          ? "widening"
          : "steady",
      thresholds: { wideningRatio: ratio },
      evidence: {
        hours: rows.map((row) => row.validAt),
        p50: rows.map((row) => roundSeries(row.p50)),
        bandWidth: rows.map((row) => roundSeries(row.width)),
      },
    });
  }

  if (membership.length === 0 && bands.length === 0) return [];
  return [{ kind: "ensembleMembership", declaredMembers, membership, bands }];
}

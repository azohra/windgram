/* percentileCrossing — the kind's type and its extractor, one module. */

import { isEnsembleValue, type Scalar, type WindgramHour } from "../../contract/index.js";
import { localDateKey } from "../../derive/day-window.js";
import { leadHoursTo, type Context, type LocalDayKey } from "./shared.js";

/** The five percentile tokens ensemble documents publish per position. */
export type PercentileToken = "p10" | "p25" | "p50" | "p75" | "p90";

const PERCENTILES: readonly PercentileToken[] = ["p10", "p25", "p50", "p75", "p90"];

/**
 * Where the ensemble's band disagrees with its median: thermalWindow's
 * EXACT test (`q(w*) >= wstarMinMs AND q(usableLiftTopM) − launchRef >=
 * depthMinM`, nulls fail — the same resolved `thermalWindow` floors,
 * deliberately not a separate threshold entry) run at each published
 * percentile per local day, emitted for ENSEMBLE documents only and ONLY
 * on days where at least one percentile's day verdict differs from p50's.
 * The crossing IS the statement — a day where every percentile agrees
 * with the median emits nothing, on either side. Both directions ride the
 * one shape: "p75/p90 clears where p50 does not" (the upside day the
 * median suppresses) and "p10 already clears" reads off
 * `minimalPassingPercentile` where p50 passes too (the robust mirror).
 *
 * S1's measured caveats (notes/spike-v4/S1-percentiles.md, 2026-08-10 —
 * each is a live failure mode, not a hypothetical):
 *
 * 1. Percentiles are per-hour, per-quantity MARGINALS. A passing
 *    percentile is a statement about two published marginals, never a
 *    member's forecast and never a trajectory: no windows, no durations,
 *    no "p90 window" phrasing — the shape cites passing instants only,
 *    because instants are citable without implying continuity (the
 *    members composing p90 at 11:00 need not be the members composing it
 *    at 17:00).
 * 2. The joint test at percentile q pairs the two quantities' q-th
 *    marginals. On live documents the two sub-tests bind at DIFFERENT
 *    percentile levels on 57% of passing hours (30% differ by >= 2
 *    levels), so the "same members" reading is wrong more often than
 *    right: phrase only as "the pXX w* and the pXX lift-top each clear
 *    their floors". The construction is meaningful only under near-1
 *    per-member rank correlation of w* and lift top, which the published
 *    document (percentile blocks only, no member vectors) cannot verify —
 *    an assumption, stated as one.
 * 3. Percentiles are computed over CONTRIBUTING members; live upside days
 *    carried cited hours with as few as 11 of 21 (a "p75" over 12 members
 *    is a different object than over 21). `membersMin` /
 *    `ceiledMembersMax` compress the per-cited-hour echo; the spike's
 *    documents read ceiledMembers 0 throughout, which is why the echo,
 *    not the spike, is the guarantee.
 * 4. Cadence is not constant within a document (live GEPS runs 3-hourly
 *    then 6-hourly): `passingSteps` counts STEPS, not hours, and
 *    `stepHours` is the widest covered step among the day's CITED hours,
 *    read per-gap from the document's actual spacing, never a
 *    document-wide constant.
 * 5. The p50-quiet/band-window state concentrates at long lead (S1: 22 of
 *    22 upside days at >= 72 h, 20 of 22 at >= 8 days; REPS's 72 h
 *    horizon produced zero) — the far-horizon median damps toward
 *    climatology while the upper quartile keeps convective days alive.
 *    `leadHours` says which regime the reader holds; never present this
 *    as near-term hidden upside.
 * 6. On terrain-benched members the statement reads through the SAME
 *    terrain bias as p50 (live: p50 depth −52 m while p90 cleared by
 *    +1072 m at red-mountain): benching semantics must consider the p90
 *    max (terrainMismatch carries it as evidence), and this statement
 *    stays benched wherever p50 statements are benched.
 */
export interface PercentileCrossingFinding {
  kind: "percentileCrossing";
  day: LocalDayKey;
  /**
   * Forecast lead: hours from `run.referenceTime` to the day's peak-lift
   * hour AT the minimal passing percentile (among that percentile's own
   * passing hours) — the claim's central instant, the same anchor
   * convention as thermalWindow's peak-lift hour, computed by the shared
   * `leadHoursTo`. Mandatory per caveat 5.
   */
  leadHours: number;
  /**
   * The lowest percentile whose day verdict passes — the headline token
   * (passing is monotone in q on fully-published hours, so the pass set
   * reads off this one token). Null when no percentile passes; under the
   * emission rule (crossings only) an emitted finding always carries a
   * token, and never "p10" (a day robust at p10 has no crossing to state).
   */
  minimalPassingPercentile: PercentileToken | null;
  /** The same test's evidence at EVERY published percentile, p50 included
   * (its zeros are load-bearing on upside days). */
  perPercentile: Record<
    PercentileToken,
    {
      /** Passing STEPS, not hours — see caveat 4. */
      passingSteps: number;
      /** The cited passing instants (document validAt) — instants only,
       * never start/end pairs (caveat 1). */
      hours: string[];
      /** Fewest contributing members across the cited hours' two
       * quantities; null when nothing passes (caveat 3). */
      membersMin: number | null;
      /** Most ceiling-capped members across the cited hours, where the
       * pipeline records censoring; null when nothing passes or no cited
       * hour carries the count (caveat 3). */
      ceiledMembersMax: number | null;
    }
  >;
  /** The widest covered step among the day's cited hours, per-gap from
   * the actual spacing (caveat 4) — thermalWindow's quantization echo. */
  stepHours: number;
  /** The resolved thermalWindow floors this day was tested against —
   * one test, one threshold home. */
  thresholds: { wstarMinMs: number; depthMinM: number };
}

export function findPercentileCrossings(context: Context): PercentileCrossingFinding[] {
  // Deterministic documents publish no percentiles: nothing to cross.
  if (context.deterministic) return [];
  const { profile, launchReferenceM, steps } = context;
  const { wstarMinMs, depthMinM } = context.thresholds.thermalWindow;

  // The q-th marginal of a published position. A plain number in an
  // ensemble document is a degenerate band (every percentile reads the
  // value), which can never disagree with p50 — so it never manufactures
  // a crossing.
  const at = (value: Scalar | null | undefined, q: PercentileToken): number | null => {
    if (value === null || value === undefined) return null;
    return isEnsembleValue(value) ? value[q] : value;
  };
  // thermalWindow's exact test at percentile q; nulls fail.
  const passes = (hour: WindgramHour, q: PercentileToken): boolean => {
    const wstar = at(hour.derived.thermalVelocityMs, q);
    const top = at(hour.derived.usableLiftTopM, q);
    return (
      wstar !== null && top !== null && wstar >= wstarMinMs && top - launchReferenceM >= depthMinM
    );
  };

  const byDay = new Map<string, WindgramHour[]>();
  for (const hour of profile.hours) {
    const day = localDateKey(hour.validAt, context.timeZone);
    const group = byDay.get(day) ?? [];
    group.push(hour);
    byDay.set(day, group);
  }

  const findings: PercentileCrossingFinding[] = [];
  for (const [day, hours] of byDay) {
    const passing = new Map<PercentileToken, WindgramHour[]>(
      PERCENTILES.map((q) => [q, hours.filter((hour) => passes(hour, q))]),
    );
    const verdict = (q: PercentileToken): boolean => passing.get(q)!.length > 0;
    // The crossing IS the statement: a day where every percentile agrees
    // with the median — all quiet, or robust down to p10 — emits nothing.
    if (PERCENTILES.every((q) => verdict(q) === verdict("p50"))) continue;
    // A crossing implies some percentile passes (all-fail agrees with a
    // failing p50), so the minimal token exists on every emitted finding.
    const minimal = PERCENTILES.find((q) => verdict(q))!;

    const cited = new Set<string>();
    const perPercentile = {} as PercentileCrossingFinding["perPercentile"];
    for (const q of PERCENTILES) {
      const rows = passing.get(q)!;
      let membersMin: number | null = null;
      let ceiledMembersMax: number | null = null;
      for (const hour of rows) {
        cited.add(hour.validAt);
        for (const value of [hour.derived.thermalVelocityMs, hour.derived.usableLiftTopM]) {
          if (value === null || value === undefined || !isEnsembleValue(value)) continue;
          membersMin = membersMin === null ? value.members : Math.min(membersMin, value.members);
          if (value.ceiledMembers !== undefined) {
            ceiledMembersMax =
              ceiledMembersMax === null
                ? value.ceiledMembers
                : Math.max(ceiledMembersMax, value.ceiledMembers);
          }
        }
      }
      perPercentile[q] = {
        passingSteps: rows.length,
        hours: rows.map((hour) => hour.validAt),
        membersMin,
        ceiledMembersMax,
      };
    }

    // The anchor: the peak-lift hour at the minimal passing percentile —
    // passing hours publish both quantities, so the marginal is non-null.
    const anchorRows = passing.get(minimal)!;
    let anchor = anchorRows[0];
    let anchorTop = at(anchor.derived.usableLiftTopM, minimal)!;
    for (const hour of anchorRows) {
      const top = at(hour.derived.usableLiftTopM, minimal)!;
      if (top > anchorTop) {
        anchor = hour;
        anchorTop = top;
      }
    }

    findings.push({
      kind: "percentileCrossing",
      day,
      leadHours: leadHoursTo(profile.run.referenceTime, anchor.validAt),
      minimalPassingPercentile: minimal,
      perPercentile,
      // Widest covered step among the cited hours (HourSteps convention).
      stepHours: Math.max(
        ...[...cited].map((validAt) => steps.after[steps.indexOf.get(validAt)!]),
      ),
      thresholds: { wstarMinMs, depthMinM },
    });
  }
  return findings;
}

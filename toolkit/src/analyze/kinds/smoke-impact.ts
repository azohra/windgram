/* smokeImpact — the kind's type and its extractor, one module. */

import type { SmokeDocument } from "../../contract/index.js";
import { localDateKey } from "../../derive/day-window.js";
import { p50 } from "../../derive/ensemble.js";
import { isSmokeAwareProfile, smokeHoursByValidAt } from "../../derive/smoke.js";
import type { ThermalWindowFinding } from "./thermal-window.js";
import { round1, type CitedInstant, type Context, type LocalDayKey } from "./shared.js";

/**
 * The smoke story per local day — REPUBLISHED NUMBERS ONLY, from the
 * profile's own `hours[].smoke` blocks (source `"profile"`, HRRR) or from
 * a same-site SmokeDocument the caller joins by validAt
 * (`AnalyzeOptions.smoke`, source `"joined"`, RAQDPS). S2 (2026-08-10,
 * live Aug 10–11 heavy-smoke event, GOES-18-verified) earned the kind its
 * place: HRRR published 130–154 µg/m³ surface smoke and AOT 0.9–1.8
 * INSIDE real windows at all four sites while the analysis said nothing,
 * not even a caveat.
 *
 * DELIBERATELY ABSENT — the derated-window verdict and any wstarAdjusted
 * series DIED in S2, twice and independently: (1) input validity — the
 * only live passive smoke source's column (RAQDPS smokePlumeColumnMgm2)
 * measured ~15× below HRRR's column and ~20× below the GOES-implied
 * column on a verified heavy-smoke day; (2) materiality — even feeding
 * satellite-magnitude AOT through the derive/ chain, 1 of 284 raw window
 * hours flipped (the midday derate at AOT 1.4 is 5–8 % of w*). The
 * derive/ chain stays exported for consumers who want the labeled
 * alternate view; this vocabulary does not state it. Revisit only with a
 * validated AOT source AND a measured flip rate distinguishable from zero.
 *
 * Day-peak AND during-window maxima both ship because S2 measured them as
 * materially different facts (erie 08-11: day AOT 1.383 at midnight local
 * vs 0.917 in-window; the same day's SURFACE peak was in-window) —
 * per-window alone would drop the health/visibility peaks outside
 * windows, per-day alone would cite nighttime AOT peaks irrelevant to the
 * lift story.
 *
 * CAVEATS THE NUMBERS SHIP UNDER (S2's five, all measured or cited):
 * 1. Mass extinction is ±30–50 % (Reid 2005 aging spread) — cube-root
 *    damping means ~10–15 % on any w*-flavored use of these optics; the
 *    derive/ chain reproduced HRRR's own internal optics to 5 % over 192
 *    live hours, so the constants are not the weak link.
 * 2. BL shallowing under smoke is NOT modeled anywhere downstream of
 *    these numbers — any smoke-adjusted view a consumer derives is a
 *    partial correction and still optimistic.
 * 3. Two reference times, always: a joined smoke day prints its own run's
 *    referenceTime (`smokeRun`) beside the analysis envelope's — RAQDPS
 *    publishes 00Z/12Z only, so 6 h gaps are routine (measured) and ~18 h
 *    possible, and GOES-measured AOT drifted 1.9 → 1.6 in 5 h.
 * 4. The `semantics` echo's hard gate — never derate a
 *    `"radiativelyCoupled"` profile (its published w* already feels this
 *    smoke) — rests on the documentary citation (Dowell et al. 2022 §2d,
 *    in the contract), NOT on a measurable live w* gap: measured
 *    inter-model w* spread (≥1 m/s) swamps the expected smoke depression
 *    (~0.15 m/s).
 * 5. RAQDPS `smokePlumeColumnMgm2` is QUARANTINED from any derived
 *    optics: the provider declares an entire-atmosphere column, the
 *    measured content is a ~50–250 m near-surface slab — the contract's
 *    smokePlumeColumnMgm2 note is that fact's one home (2026-08-10
 *    measurements, upstream-report status, and the re-arbitration
 *    trigger). The joined finding republishes the column as the
 *    document's fact and carries NO aot until that note lifts the
 *    quarantine; the RAQDPS surface field does NOT share the problem.
 *
 * Threshold-free by construction: magnitudes and timing only, no verdict.
 * AQI banding is jurisdictional and belongs downstream.
 */
export type SmokeImpactFinding = SmokeImpactProfileFinding | SmokeImpactJoinedFinding;

interface SmokeImpactBase {
  kind: "smokeImpact";
  day: LocalDayKey;
  /**
   * The contract's `semantics.smoke` echo — load-bearing, not provenance
   * trivia: `"radiativelyCoupled"` means the model's own radiation is
   * attenuated by this smoke, so the analysis's lift numbers ALREADY feel
   * it (a downstream derate would double-count — caveat 4 above);
   * `"passive"` means the lift numbers are smoke-blind and this finding
   * is the only place the analysis speaks to smoke. A profile carrying
   * smoke blocks without the tag reads `"passive"` — derive/'s own
   * absence convention (`isSmokeAwareProfile`).
   */
  semantics: "radiativelyCoupled" | "passive";
  /** Day-peak near-surface smoke, µg/m³ — the visibility/health number. */
  peakSurfaceUgm3: number;
  peakSurfaceAt: CitedInstant;
}

/** The profile's own smoke blocks (HRRR): surface concentration plus the
 * model's own published column AOT — the sun-dimming number. */
export interface SmokeImpactProfileFinding extends SmokeImpactBase {
  source: "profile";
  /** Day-peak published aerosol optical thickness (dimensionless). */
  peakAot: number;
  peakAotAt: CitedInstant;
  /**
   * Maxima over the smoke hours inside the day's thermalWindow(s) — the
   * lift-story numbers, materially different from the day peaks (S2 Q6).
   * Null when the day has no thermalWindow, or when no smoke-carrying
   * hour lands on a window hour.
   */
  duringWindow: { maxSurfaceUgm3: number; maxAot: number } | null;
  evidence: { hours: string[]; surfaceUgm3: number[]; aot: number[] };
}

/** A joined smoke document (RAQDPS) beside a smoke-blind profile: the
 * wildfire-attributed surface concentration plus the published column
 * mass — and deliberately NO aot (caveat 5: the column is quarantined
 * from derived optics until the pipeline validates it). */
export interface SmokeImpactJoinedFinding extends SmokeImpactBase {
  source: "joined";
  /** A joined day is passive by construction: the smoke rides beside a
   * profile whose radiation never saw it. */
  semantics: "passive";
  /** Day-peak wildfire-smoke column mass, mg/m² — the document's own
   * published fact, republished as-is (see caveat 5 for what it is NOT). */
  peakColumnMgm2: number;
  peakColumnAt: CitedInstant;
  /**
   * The smoke document's own run, beside the envelope's — both reference
   * times, always (caveat 3): a stale smoke run must not silently caption
   * a fresh wind run.
   */
  smokeRun: { model: string; referenceTime: string };
  /**
   * The horizon confession: of the profile hours on this local day, how
   * many the smoke document covered (an exact validAt match with both
   * series readable). S2 Q4 measured every join miss as horizon — zero
   * cadence misses — so a low count means the smoke document's 72 h span
   * ran out, and the day's numbers read over `joinedHours`, not the day.
   */
  coverage: { joinedHours: number; profileHours: number };
  /** As the profile variant's, with the column standing in for aot. */
  duringWindow: { maxSurfaceUgm3: number; maxColumnMgm2: number } | null;
  evidence: { hours: string[]; surfaceUgm3: number[]; columnMgm2: number[] };
}

/** Three decimals — the contract's precision for aot (the pipeline's
 * publish table; µg/m³ and mg/m² families publish at one, which the
 * shared round1 covers). Local: no other kind states an optical thickness. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** One smoke hour: the surface concentration plus the source's second
 * number (profile: aot; joined: columnMgm2). */
interface SmokeRow {
  validAt: string;
  surfaceUgm3: number;
  companion: number;
}

export function findSmokeImpact(
  context: Context,
  windows: ThermalWindowFinding[],
  smoke: SmokeDocument | null,
): SmokeImpactFinding[] {
  const { profile } = context;

  // The day's window hours — thermalWindow's own convention: a window (and
  // any hour it carries past local midnight) anchors to its start day, the
  // same anchoring capTiming reads its window end through.
  const windowHoursByDay = new Map<LocalDayKey, Set<string>>();
  for (const window of windows) {
    const set = windowHoursByDay.get(window.day) ?? new Set<string>();
    for (const hour of window.evidence.hours) set.add(hour);
    windowHoursByDay.set(window.day, set);
  }

  // The profile's own smoke blocks win: they are the model's own run, and
  // joining another model's smoke beside them would state the same sky
  // twice. The join serves exactly the smoke-blind profiles.
  const profileRows: SmokeRow[] = [];
  for (const hour of profile.hours) {
    if (!hour.smoke) continue;
    const surfaceUgm3 = p50(hour.smoke.surfaceUgm3);
    const companion = p50(hour.smoke.aot);
    if (surfaceUgm3 === null || companion === null) continue;
    profileRows.push({ validAt: hour.validAt, surfaceUgm3, companion });
  }
  if (profileRows.length > 0) {
    const semantics = isSmokeAwareProfile(profile) ? "radiativelyCoupled" : "passive";
    const findings: SmokeImpactProfileFinding[] = [];
    for (const [day, rows] of groupByDay(profileRows, context)) {
      const window = duringWindowOf(rows, windowHoursByDay.get(day));
      const aotPeak = companionPeakOf(rows);
      findings.push({
        kind: "smokeImpact",
        source: "profile",
        day,
        semantics,
        ...surfacePeakOf(rows, context),
        peakAot: round3(aotPeak.companion),
        peakAotAt: context.cite(aotPeak.validAt),
        duringWindow: window && {
          maxSurfaceUgm3: window.maxSurfaceUgm3,
          maxAot: round3(window.maxCompanion),
        },
        evidence: {
          hours: rows.map((row) => row.validAt),
          surfaceUgm3: rows.map((row) => round1(row.surfaceUgm3)),
          aot: rows.map((row) => round3(row.companion)),
        },
      });
    }
    return findings;
  }

  if (!smoke) return [];
  const smokeByValidAt = smokeHoursByValidAt(smoke);
  const joinedRows: SmokeRow[] = [];
  for (const hour of profile.hours) {
    const match = smokeByValidAt.get(hour.validAt);
    if (!match) continue;
    const surfaceUgm3 = p50(match.smokePlumeSurfaceUgm3);
    const companion = p50(match.smokePlumeColumnMgm2);
    if (surfaceUgm3 === null || companion === null) continue;
    joinedRows.push({ validAt: hour.validAt, surfaceUgm3, companion });
  }
  if (joinedRows.length === 0) return [];

  const profileHoursByDay = new Map<LocalDayKey, number>();
  for (const hour of profile.hours) {
    const day = localDateKey(hour.validAt, context.timeZone);
    profileHoursByDay.set(day, (profileHoursByDay.get(day) ?? 0) + 1);
  }

  const findings: SmokeImpactJoinedFinding[] = [];
  for (const [day, rows] of groupByDay(joinedRows, context)) {
    const window = duringWindowOf(rows, windowHoursByDay.get(day));
    const columnPeak = companionPeakOf(rows);
    findings.push({
      kind: "smokeImpact",
      source: "joined",
      day,
      semantics: "passive",
      ...surfacePeakOf(rows, context),
      peakColumnMgm2: round1(columnPeak.companion),
      peakColumnAt: context.cite(columnPeak.validAt),
      smokeRun: { model: smoke.model, referenceTime: smoke.run.referenceTime },
      coverage: { joinedHours: rows.length, profileHours: profileHoursByDay.get(day) ?? 0 },
      duringWindow: window && {
        maxSurfaceUgm3: window.maxSurfaceUgm3,
        maxColumnMgm2: round1(window.maxCompanion),
      },
      evidence: {
        hours: rows.map((row) => row.validAt),
        surfaceUgm3: rows.map((row) => round1(row.surfaceUgm3)),
        columnMgm2: rows.map((row) => round1(row.companion)),
      },
    });
  }
  return findings;
}

/* ----------------------------------------------------------------- helpers */

function groupByDay(rows: SmokeRow[], context: Context): Map<LocalDayKey, SmokeRow[]> {
  const byDay = new Map<LocalDayKey, SmokeRow[]>();
  for (const row of rows) {
    const day = localDateKey(row.validAt, context.timeZone);
    const bucket = byDay.get(day) ?? [];
    bucket.push(row);
    byDay.set(day, bucket);
  }
  return byDay;
}

/** Day-peak surface concentration with its cited instant (first hour wins
 * a tie — the earliest instant the peak is published at). */
function surfacePeakOf(
  rows: SmokeRow[],
  context: Context,
): { peakSurfaceUgm3: number; peakSurfaceAt: CitedInstant } {
  const peak = rows.reduce((best, row) => (row.surfaceUgm3 > best.surfaceUgm3 ? row : best));
  return { peakSurfaceUgm3: round1(peak.surfaceUgm3), peakSurfaceAt: context.cite(peak.validAt) };
}

function companionPeakOf(rows: SmokeRow[]): SmokeRow {
  return rows.reduce((best, row) => (row.companion > best.companion ? row : best));
}

/** Raw during-window maxima over the day's smoke rows that land on the
 * day's window hours; null when there is no window or no such row. */
function duringWindowOf(
  rows: SmokeRow[],
  windowHours: Set<string> | undefined,
): { maxSurfaceUgm3: number; maxCompanion: number } | null {
  if (!windowHours) return null;
  const inWindow = rows.filter((row) => windowHours.has(row.validAt));
  if (inWindow.length === 0) return null;
  return {
    maxSurfaceUgm3: round1(Math.max(...inWindow.map((row) => row.surfaceUgm3))),
    maxCompanion: Math.max(...inWindow.map((row) => row.companion)),
  };
}

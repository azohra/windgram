/* The versioned vocabulary: every statement analyze/ can make, as types —
   the contract surface consumers switch on. Each kind's type and extractor
   live together in kinds/<kind>.ts; this file is the barrel that names the
   kind set, the union, the thresholds, the options, and the envelope. The
   module charter (why statements are their own subpath, the discipline
   every kind obeys) lives in index.ts.

   ADDING A KIND touches exactly one line in each marked block below (the
   type import, the type re-export, the union member, the thresholds
   interface/default entries where the kind uses thresholds) plus one
   extractor line in findings.ts — keep each on its own line so parallel
   kind work merges without conflict. */

import type { CapTimingFinding } from "./kinds/cap-timing.js";
import type { ConvectiveDayFinding } from "./kinds/convective-day.js";
import type { DataCaveatsFinding } from "./kinds/data-caveats.js";
import type { EnsembleMembershipFinding } from "./kinds/ensemble-membership.js";
import type { ThermalWindowFinding } from "./kinds/thermal-window.js";
import type { LiftCeilingFinding } from "./kinds/lift-ceiling.js";
import type { QuietDayFinding } from "./kinds/quiet-day.js";
import type { TerrainMismatchFinding } from "./kinds/terrain-mismatch.js";
import type { WindSummaryFinding } from "./kinds/wind-summary.js";

/**
 * The finding-kind set this module can emit. Versioned like models.json
 * capabilities: consumers switch on `kind`, so adding, renaming, or removing
 * a kind is a contract event — bump this, and document the evidence that
 * justified the change (see the module charter in index.ts).
 */
export const ANALYZE_VOCABULARY_VERSION = 4;
/* v2 (2026-08-08): adds `quietDay` — production consumer evidence: a day
   with no flyable window was expressible only by absence, so headlines
   could say "no window" but never why. The negative now carries the
   numbers that failed, per the statements-with-evidence charter.
   v3 (2026-08-09): horizon truncation named on both sides — the findings
   spike over nine live documents showed a model whose run ends mid-day
   voting "quiet" on pre-thermic hours alone, and window end-times
   spreading 7 h purely because short-horizon runs clip their last
   window. quietDay carries `coverage` with a `truncated` verdict (a
   truncated quiet day is a data boundary, not a forecast, and must not
   vote in comparisons); flyableWindow carries `clippedAtStart` /
   `clippedAtEnd` so a clipped edge reads as ≥/≤, not as timing.
   v4 (2026-08-10): ONE vocabulary event, gated by the four 2026-08-10
   evidence spikes (notes/spike-v4: S1-percentiles, S2-smoke, S3-wind,
   S4-convective) and ratified in notes/design-analyze-compare-v4.md.
   The rename: `flyableWindow` becomes `thermalWindow` — the kind string
   was the one judgment word the discipline could not reduce; the
   arithmetic tests thermals, not flyability (its JSDoc records the
   argument). Contract-shaped defect fixes ride the bump: spacing-derived
   statements read the actual per-gap cadence, never a document constant
   (S1 caught live GEPS switching 3 h → 6 h mid-horizon and misreading
   durations, truncation verdicts, and the cap-timing gate); thermalWindow
   carries its own `stepHours` quantization echo, a caller-movable
   `maxGapHours` segmentation tolerance (default 0 = v3 behaviour), and
   `leadHours` (S1: all 22 p50-quiet/band-window days sat at lead ≥ 72 h —
   the finding must say how far out it reads). The kinds the spikes
   earned land in this same event: percentile-crossing statements (S1,
   amended shape — hours-passing counts, never per-percentile windows),
   smoke magnitudes with the joined-document caveat fix (S2 — the derate
   verdict DIED and is deliberately absent), the wind family (S3 —
   window-scoped wind, caller-thresholded exceedance, deterministic-only
   direction evolution, analyze-only band shear), convective un-gating
   with quiet-day atmospheric context and the cappedAllDay verdict split
   (S4), and the removals: `bands.trend` and `maxRelativeSpread` (diurnal
   confounds measured live in both directions), `liftCeiling.flips`. */

/* ------------------------------------------------------------- vocabulary */

/* Shared cited-evidence types (defined beside the extraction context in
   kinds/shared.ts; part of the public vocabulary surface). */
export type { CitedInstant, LocalDayKey } from "./kinds/shared.js";

/* Per-kind types — one line per kind. */
export type { CapTimingFinding } from "./kinds/cap-timing.js";
export type { ConvectiveDayFinding } from "./kinds/convective-day.js";
export type { DataCaveat, DataCaveatsFinding } from "./kinds/data-caveats.js";
export type { EnsembleMembershipFinding } from "./kinds/ensemble-membership.js";
export type { ThermalWindowFinding } from "./kinds/thermal-window.js";
export type { LiftCeilingFinding } from "./kinds/lift-ceiling.js";
export type { QuietDayFinding } from "./kinds/quiet-day.js";
export type { TerrainMismatchFinding } from "./kinds/terrain-mismatch.js";
export type { WindSummaryFinding } from "./kinds/wind-summary.js";

/* The union — one member line per kind. */
export type WindgramFinding =
  | TerrainMismatchFinding
  | DataCaveatsFinding
  | EnsembleMembershipFinding
  | CapTimingFinding
  | ConvectiveDayFinding
  | ThermalWindowFinding
  | QuietDayFinding
  | LiftCeilingFinding
  | WindSummaryFinding;

export type FindingKind = WindgramFinding["kind"];

/* -------------------------------------------------------------- thresholds */

/* One entry line per threshold-using kind. */
export interface AnalyzeThresholds {
  thermalWindow: { wstarMinMs: number; depthMinM: number; maxGapHours: number };
  liftCeiling: { cloudCapMarginM: number };
  capTiming: {
    instabilityMinCapeJkg: number;
    brokenCapMaxAbsCinJkg: number;
    brokenCapMinCapeJkg: number;
    precipMinMmHr: number;
  };
  convectiveDay: { precipMinMmHr: number };
  terrainMismatch: { minAbsDeltaM: number };
  windSummary: { bandMarginM: number; persistenceFractionOfMax: number };
  ensembleMembership: { wideningRatio: number };
}

/**
 * The spike's constants, embedded in every finding they shaped. The
 * thermalWindow pair carried a measured sensitivity sweep (see its JSDoc);
 * the rest are the values the spike's outputs were audited under. All are
 * caller-movable per call — they are conventions, not physics.
 */
export const DEFAULT_ANALYZE_THRESHOLDS: AnalyzeThresholds = {
  thermalWindow: { wstarMinMs: 0.9, depthMinM: 300, maxGapHours: 0 },
  liftCeiling: { cloudCapMarginM: 50 },
  capTiming: {
    instabilityMinCapeJkg: 100,
    brokenCapMaxAbsCinJkg: 25,
    brokenCapMinCapeJkg: 200,
    precipMinMmHr: 0.2,
  },
  convectiveDay: { precipMinMmHr: 0.2 },
  terrainMismatch: { minAbsDeltaM: 250 },
  windSummary: { bandMarginM: 200, persistenceFractionOfMax: 0.8 },
  ensembleMembership: { wideningRatio: 1.5 },
};

/**
 * Per-kind threshold overrides: each kind's block merges over its default,
 * so a caller may move one number (say, `thermalWindow.maxGapHours`)
 * without restating the rest — the embedded `thresholds` echo on every
 * finding confesses the resolved values either way.
 */
export type AnalyzeThresholdOverrides = {
  [K in keyof AnalyzeThresholds]?: Partial<AnalyzeThresholds[K]>;
};

export interface AnalyzeOptions {
  /**
   * IANA timezone for every local field. Defaults to the document's own
   * `site.timeZone`; when neither exists the analysis reads in UTC and says
   * so with a `timesAreUtc` caveat.
   */
  timeZone?: string;
  /**
   * The launch the analysis reads launch-relative statements against — an
   * ANALYSIS INPUT, exactly like the scene's `SceneOptions.launch`:
   * documents are launch-agnostic, so the caller names the launch
   * (`elevationM`, metres MSL — typically site-context.json's `elevation`
   * pick). Absent, launch-relative arithmetic falls back to the model's own
   * ground (`site.modelElevationM`), `peakLiftTopAboveLaunchM` is null, and
   * `terrainMismatch` — a launch-vs-model-ground statement — is never
   * emitted.
   */
  launch?: { elevationM: number } | null;
  /** Per-kind threshold overrides, merged over the defaults per kind. */
  thresholds?: AnalyzeThresholdOverrides;
}

/* ---------------------------------------------------------------- envelope */

export interface WindgramAnalysis {
  vocabularyVersion: typeof ANALYZE_VOCABULARY_VERSION;
  model: string;
  /**
   * The document's sample identity plus the launch the analysis ran
   * against: `launchAltitudeM` echoes the caller's `AnalyzeOptions.launch`
   * (documents carry no launch), null when none was supplied.
   */
  site: { id: string; launchAltitudeM: number | null; modelElevationM: number };
  run: { referenceTime: string };
  /** The timezone every local field below reads in. */
  timeZone: string;
  timeZoneSource: "document" | "override" | "utcFallback";
  /**
   * The document's LEADING cadence (its first two hours' gap) — a display
   * fact, not a document-wide constant: live documents widen mid-horizon
   * (GEPS publishes 3-hourly then 6-hourly), so spacing-derived arithmetic
   * inside findings reads the actual per-gap spacing, and a mixed-cadence
   * document carries a `stepCadence` caveat naming its widest step.
   */
  stepHours: number;
  hours: number;
  findings: WindgramFinding[];
}

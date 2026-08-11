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

import type { SmokeDocument } from "../contract/index.js";
import type { AnalysisExtension } from "./frame.js";
import type { LocalDayKey } from "./kinds/shared.js";
import type { BandShearFinding } from "./kinds/band-shear.js";
import type { CapTimingFinding } from "./kinds/cap-timing.js";
import type { ConvectiveDayFinding } from "./kinds/convective-day.js";
import type { DataCaveatsFinding } from "./kinds/data-caveats.js";
import type { EnsembleMembershipFinding } from "./kinds/ensemble-membership.js";
import type { ThermalWindowFinding } from "./kinds/thermal-window.js";
import type { LiftCeilingFinding } from "./kinds/lift-ceiling.js";
import type { PercentileCrossingFinding } from "./kinds/percentile-crossing.js";
import type { QuietDayFinding } from "./kinds/quiet-day.js";
import type { SmokeImpactFinding } from "./kinds/smoke-impact.js";
import type { TerrainMismatchFinding } from "./kinds/terrain-mismatch.js";
import type { WindDirectionFinding } from "./kinds/wind-direction.js";
import type { WindExceedanceFinding } from "./kinds/wind-exceedance.js";
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
   confounds measured live in both directions), `liftCeiling.flips`.
   0.22.0 rides UNDER v4 — NO vocabulary event (no kind added, renamed,
   or removed); the Tier 2 architecture release
   (notes/design-architecture.md) is the proof case that envelope
   self-description can grow under the tolerant-reader convention
   without a contract event. The additions: the extraction frame goes
   public (`AnalysisFrame`, its own ANALYSIS_FRAME_VERSION;
   `AnalyzeOptions.extensions` runs caller extractors over it AFTER the
   built-in findings, their statements landing in the envelope's named
   `extensions` entries, never in `findings`); the envelope
   self-describes for compareAnalyses (`thresholds`, `deterministic`,
   `coveredDays` — required fields, so only hand-built envelope values
   gain keys to fill); and `vocabularyVersion` widens from the literal
   to `number` under the tolerant-reader convention (the charter) — the
   release's one type-level break, zero wire change. */

/* ------------------------------------------------------------- vocabulary */

/* Shared cited-evidence types (defined beside the extraction context in
   kinds/shared.ts; part of the public vocabulary surface). */
export type { CitedInstant, LocalDayKey } from "./kinds/shared.js";

/* Per-kind types — one line per kind. */
export type { BandShearFinding } from "./kinds/band-shear.js";
export type { CapTimingFinding } from "./kinds/cap-timing.js";
export type { ConvectiveDayFinding } from "./kinds/convective-day.js";
export type { DataCaveat, DataCaveatsFinding } from "./kinds/data-caveats.js";
export type { EnsembleMembershipFinding } from "./kinds/ensemble-membership.js";
export type { ThermalWindowFinding } from "./kinds/thermal-window.js";
export type { LiftCeilingFinding } from "./kinds/lift-ceiling.js";
export type { PercentileCrossingFinding, PercentileToken } from "./kinds/percentile-crossing.js";
export type { QuietDayFinding } from "./kinds/quiet-day.js";
export type { SmokeImpactFinding, SmokeImpactJoinedFinding, SmokeImpactProfileFinding } from "./kinds/smoke-impact.js";
export type { TerrainMismatchFinding } from "./kinds/terrain-mismatch.js";
export type { WindDirectionFinding } from "./kinds/wind-direction.js";
export type { WindExceedanceFinding } from "./kinds/wind-exceedance.js";
export type { WindSummaryFinding } from "./kinds/wind-summary.js";

/* The union — one member line per kind. */
export type WindgramFinding =
  | TerrainMismatchFinding
  | DataCaveatsFinding
  | EnsembleMembershipFinding
  | CapTimingFinding
  | ConvectiveDayFinding
  | ThermalWindowFinding
  | PercentileCrossingFinding
  | QuietDayFinding
  | LiftCeilingFinding
  | SmokeImpactFinding
  | WindSummaryFinding
  | WindExceedanceFinding
  | WindDirectionFinding
  | BandShearFinding;

export type FindingKind = WindgramFinding["kind"];

/* -------------------------------------------------------------- thresholds */

/**
 * RESOLVED thresholds — an OUTPUT/echo type (the envelope's and every
 * finding's `thresholds` echo, `resolveAnalyzeThresholds`'s return).
 * Never construct one: pass `AnalyzeThresholdOverrides` and let the
 * defaults fill — a new threshold-using kind adds a required key here,
 * and only hand-built values feel it.
 */
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
  windDirection: { directionFloorMs: number };
  bandShear: { minLayerThicknessM: number; endpointFloorMs: number };
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
  windDirection: { directionFloorMs: 1 },
  bandShear: { minLayerThicknessM: 30, endpointFloorMs: 2 },
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
  /**
   * A same-site smoke document (RAQDPS) to join by validAt for
   * smoke-blind profiles — an ANALYSIS INPUT like `launch`: the
   * `smokeImpact` kind republishes its surface and column magnitudes with
   * a coverage confession and the smoke run's own referenceTime beside
   * the envelope's. Ignored when the profile carries its own
   * `hours[].smoke` (the model's own smoke wins); absent, a smoke-blind
   * analysis says so via the `dataCaveats` `"smoke"` family token.
   */
  smoke?: SmokeDocument | null;
  /**
   * Caller-owned wind ceilings for `windExceedance` — deliberately NOT in
   * `thresholds`, because NO DEFAULTS EXIST: the package never owns a
   * "safe wind" number, and without a ceiling the kind emits nothing.
   * Gust ceilings are per semantics class (`hourMaxMs` / `instantMs`,
   * never reused across classes — S3 measured the gap at a factor
   * ~1.8-2.8 at matched means); each supplied value is echoed verbatim in
   * the findings it produces.
   */
  windCeilings?: WindCeilings;
  /**
   * Caller extractors run over the public `AnalysisFrame` AFTER the
   * built-in findings, receiving the finished findings read-only. Their
   * statements land on the envelope's `extensions` array as named
   * entries, never in `findings` — see `AnalysisExtension` (frame.ts)
   * for the contract and its discipline expectations. Duplicate names in
   * one call throw; a throwing extension fails the analysis.
   */
  extensions?: ReadonlyArray<AnalysisExtension>;
}

/** See `AnalyzeOptions.windCeilings` — caller conventions, no defaults. */
export interface WindCeilings {
  surfaceMs?: number;
  /** Per gust-semantics class; a document only reads the ceiling matching
   * its own declared `semantics.gust`. */
  gust?: { hourMaxMs?: number; instantMs?: number };
  bandMs?: number;
}

/* ---------------------------------------------------------------- envelope */

/* The envelope self-describes (0.22.0): everything `compareAnalyses`
   validates or the comparison ledger states is ON the envelope —
   `thresholds`, `deterministic`, `coveredDays` closed the last three
   reads of the raw profile. Required fields: additive for every READER
   of the envelope; only consumers who CONSTRUCT `WindgramAnalysis`
   values by hand (test fixtures) gain fields to fill. */
export interface WindgramAnalysis {
  /** The vocabulary version that produced this envelope. Typed `number`,
   * not the literal: readers check it at runtime (`compareAnalyses`
   * throws on skew) instead of recompiling on every bump. THE
   * TOLERANT-READER CONVENTION (see the module charter in index.ts):
   * consumers of serialized envelopes MUST ignore finding kinds and
   * envelope fields they do not know; additive kinds bump this number
   * without breaking any conforming reader. Exhaustive `switch` over
   * `finding.kind` remains available to compiled consumers — with a
   * default arm it is also conforming. */
  vocabularyVersion: number;
  model: string;
  /** Whether the document is deterministic (single-valued positions) or
   * an ensemble read at p50 — `isDeterministicProfile`'s verdict,
   * precomputed so envelope consumers never re-open the profile. */
  deterministic: boolean;
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
  /**
   * The local calendar days the document's hours actually touch (sorted,
   * computed in this envelope's own `timeZone` from `hours[].validAt`) —
   * the same truth the day universe and `outOfHorizon` abstentions read,
   * precomputed. Never cadence arithmetic: live documents widen their
   * step mid-horizon.
   */
  coveredDays: LocalDayKey[];
  /**
   * The RESOLVED thresholds this analysis ran under —
   * `resolveAnalyzeThresholds` of the caller's overrides, echoed at the
   * top level so a comparison can validate coherence without
   * reconstructing it (per-finding echoes are absent when a kind emitted
   * nothing).
   */
  thresholds: AnalyzeThresholds;
  findings: WindgramFinding[];
  /**
   * Named third-party statements (`AnalyzeOptions.extensions`), kept OUT
   * of `findings`: the versioned kind set stays closed and first-party,
   * and the vocabulary's guarantees stop at the `findings` array. Each
   * entry echoes its extension's `name` verbatim, so two extensions'
   * outputs never blur; `statements` stays `unknown[]` — consumers narrow
   * through the extension's own types. ABSENT (not empty) when no
   * extensions were passed, so existing serialized envelopes are
   * byte-identical.
   */
  extensions?: ReadonlyArray<{ extension: string; statements: unknown[] }>;
}

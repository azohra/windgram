/* The extraction entry point: one profile document in, the vocabulary's
   findings out. Each kind's extractor lives with its type in
   kinds/<kind>.ts; the shared extraction context lives in kinds/shared.ts;
   the vocabulary barrel (types, thresholds, envelope) is vocabulary.ts;
   the module charter lives in index.ts.

   ADDING A KIND adds exactly one extractor line to the findings array
   below (plus its lines in vocabulary.ts) — keep each kind on its own
   line so parallel kind work merges without conflict. */

import { isDeterministicProfile, type WindgramProfile } from "../contract/index.js";
import { findCapTiming } from "./kinds/cap-timing.js";
import { findDataCaveats } from "./kinds/data-caveats.js";
import { findEnsembleMembership } from "./kinds/ensemble-membership.js";
import { findThermalWindows } from "./kinds/thermal-window.js";
import { findLiftCeilings } from "./kinds/lift-ceiling.js";
import { findQuietDays } from "./kinds/quiet-day.js";
import { citedInstantFactory, hourStepsOf, stepHoursOf, type Context } from "./kinds/shared.js";
import { findTerrainMismatch } from "./kinds/terrain-mismatch.js";
import { findWindSummaries } from "./kinds/wind-summary.js";
import {
  ANALYZE_VOCABULARY_VERSION,
  DEFAULT_ANALYZE_THRESHOLDS,
  type AnalyzeOptions,
  type AnalyzeThresholdOverrides,
  type AnalyzeThresholds,
  type WindgramAnalysis,
  type WindgramFinding,
} from "./vocabulary.js";

/* ------------------------------------------------------------ entry point */

/**
 * Extracts the versioned vocabulary's findings from one profile document.
 * Deterministic and ensemble documents both work: ensemble positions are
 * read at p50, band and membership information surfaces through the
 * `ensembleMembership` kind and the evidence blocks, and `capTiming`
 * gates itself off ensembles and multi-hour cadences (see its JSDoc).
 */
export function analyzeProfile(
  profile: WindgramProfile,
  options: AnalyzeOptions = {},
): WindgramAnalysis {
  const thresholds = mergeThresholds(options.thresholds);
  const timeZoneSource: WindgramAnalysis["timeZoneSource"] = options.timeZone
    ? "override"
    : profile.site.timeZone
      ? "document"
      : "utcFallback";
  const timeZone = options.timeZone ?? profile.site.timeZone ?? "UTC";
  /* The launch is the caller's (AnalyzeOptions.launch) — documents are
     launch-agnostic. Without one, launch-relative arithmetic reads against
     the model's own ground. */
  const launchElevationM = options.launch?.elevationM ?? null;
  const context: Context = {
    profile,
    timeZone,
    deterministic: isDeterministicProfile(profile),
    stepHours: stepHoursOf(profile),
    steps: hourStepsOf(profile),
    launchElevationM,
    launchReferenceM: launchElevationM ?? profile.site.modelElevationM,
    cite: citedInstantFactory(timeZone),
    thresholds,
  };

  const windows = findThermalWindows(context);
  const findings: WindgramFinding[] = [
    ...findTerrainMismatch(context),
    ...windows,
    ...findQuietDays(context, windows),
    ...findLiftCeilings(context, windows),
    ...findCapTiming(context, windows),
    ...findWindSummaries(context),
    ...findEnsembleMembership(context),
    findDataCaveats(context, timeZoneSource),
  ];

  return {
    vocabularyVersion: ANALYZE_VOCABULARY_VERSION,
    model: profile.model,
    site: {
      id: profile.site.id,
      launchAltitudeM: launchElevationM,
      modelElevationM: profile.site.modelElevationM,
    },
    run: { referenceTime: profile.run.referenceTime },
    timeZone,
    timeZoneSource,
    stepHours: context.stepHours,
    hours: profile.hours.length,
    findings,
  };
}

/* ----------------------------------------------------------------- helpers */

/** The exact per-kind merge `analyzeProfile` applies to its `thresholds`
 * option — exported so `compare/` can echo the resolved values in its
 * envelope without restating the merge (one home). */
export function resolveAnalyzeThresholds(
  overrides?: AnalyzeThresholdOverrides,
): AnalyzeThresholds {
  return mergeThresholds(overrides);
}

/* One merge line per threshold-using kind. */
function mergeThresholds(overrides?: AnalyzeThresholdOverrides): AnalyzeThresholds {
  if (!overrides) return DEFAULT_ANALYZE_THRESHOLDS;
  return {
    thermalWindow: { ...DEFAULT_ANALYZE_THRESHOLDS.thermalWindow, ...overrides.thermalWindow },
    liftCeiling: { ...DEFAULT_ANALYZE_THRESHOLDS.liftCeiling, ...overrides.liftCeiling },
    capTiming: { ...DEFAULT_ANALYZE_THRESHOLDS.capTiming, ...overrides.capTiming },
    terrainMismatch: { ...DEFAULT_ANALYZE_THRESHOLDS.terrainMismatch, ...overrides.terrainMismatch },
    windSummary: { ...DEFAULT_ANALYZE_THRESHOLDS.windSummary, ...overrides.windSummary },
    ensembleMembership: {
      ...DEFAULT_ANALYZE_THRESHOLDS.ensembleMembership,
      ...overrides.ensembleMembership,
    },
  };
}

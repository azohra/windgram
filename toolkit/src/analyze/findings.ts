/* The extraction entry point: one profile document in, the vocabulary's
   findings out. Each kind's extractor lives with its type in
   kinds/<kind>.ts; the shared extraction context lives in kinds/shared.ts;
   the vocabulary barrel (types, thresholds, envelope) is vocabulary.ts;
   the module charter lives in index.ts.

   ADDING A KIND adds exactly one extractor line to the findings array
   below (plus its lines in vocabulary.ts) — keep each kind on its own
   line so parallel kind work merges without conflict. */

import { isDeterministicProfile, type WindgramProfile } from "../contract/index.js";
import { localDateKey } from "../derive/day-window.js";
import type { AnalysisFrame } from "./frame.js";
import { findBandShear } from "./kinds/band-shear.js";
import { findCapTiming } from "./kinds/cap-timing.js";
import { findConvectiveDays } from "./kinds/convective-day.js";
import { findDataCaveats } from "./kinds/data-caveats.js";
import { findEnsembleMembership } from "./kinds/ensemble-membership.js";
import { findThermalWindows } from "./kinds/thermal-window.js";
import { findLiftCeilings } from "./kinds/lift-ceiling.js";
import { findPercentileCrossings } from "./kinds/percentile-crossing.js";
import { findQuietDays } from "./kinds/quiet-day.js";
import {
  citedInstantFactory,
  hourStepsOf,
  leadHoursTo,
  stepHoursOf,
  type Context,
} from "./kinds/shared.js";
import { findSmokeImpact } from "./kinds/smoke-impact.js";
import { findTerrainMismatch } from "./kinds/terrain-mismatch.js";
import { findWindDirection } from "./kinds/wind-direction.js";
import { findWindExceedance } from "./kinds/wind-exceedance.js";
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
    ...(options.windCeilings ? { windCeilings: options.windCeilings } : {}),
  };

  const windows = findThermalWindows(context);
  const smokeImpacts = findSmokeImpact(context, windows, options.smoke ?? null);
  const findings: WindgramFinding[] = [
    ...findTerrainMismatch(context),
    ...windows,
    ...findPercentileCrossings(context),
    ...findQuietDays(context, windows),
    ...findLiftCeilings(context, windows),
    ...findCapTiming(context, windows),
    ...findConvectiveDays(context, windows),
    ...smokeImpacts,
    ...findWindSummaries(context, windows),
    ...findWindExceedance(context, windows),
    ...findWindDirection(context, windows),
    ...findBandShear(context, windows),
    ...findEnsembleMembership(context),
    findDataCaveats(context, timeZoneSource, smokeImpacts.length > 0),
  ];

  /* Extensions run AFTER first-party extraction, over the public frame,
     with the finished findings read-only (the closed-set equivalent of
     the anchor access the first-party extractors get — eight of fourteen
     take the thermal windows). Named entries land in `extensions`, never
     in `findings`; the field is absent when no extensions were passed. */
  let extensions: Array<{ extension: string; statements: unknown[] }> | undefined;
  if (options.extensions && options.extensions.length > 0) {
    const names = new Set<string>();
    for (const extension of options.extensions) {
      if (names.has(extension.name)) {
        throw new Error(
          `analyzeProfile: duplicate extension name (${extension.name}) — entries are keyed by name, so each extension in one call needs its own`,
        );
      }
      names.add(extension.name);
    }
    const frame: AnalysisFrame = {
      profile,
      timeZone,
      timeZoneSource,
      deterministic: context.deterministic,
      stepHours: context.stepHours,
      steps: context.steps,
      referenceTime: profile.run.referenceTime,
      launchElevationM,
      launchReferenceM: context.launchReferenceM,
      cite: context.cite,
      dayOf: (validAt) => localDateKey(validAt, timeZone),
      leadHours: (validAt) => leadHoursTo(profile.run.referenceTime, validAt),
    };
    extensions = options.extensions.map((extension) => ({
      extension: extension.name,
      statements: extension.extract(frame, findings),
    }));
  }

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
    ...(extensions ? { extensions } : {}),
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
    convectiveDay: { ...DEFAULT_ANALYZE_THRESHOLDS.convectiveDay, ...overrides.convectiveDay },
    terrainMismatch: { ...DEFAULT_ANALYZE_THRESHOLDS.terrainMismatch, ...overrides.terrainMismatch },
    windSummary: { ...DEFAULT_ANALYZE_THRESHOLDS.windSummary, ...overrides.windSummary },
    windDirection: { ...DEFAULT_ANALYZE_THRESHOLDS.windDirection, ...overrides.windDirection },
    bandShear: { ...DEFAULT_ANALYZE_THRESHOLDS.bandShear, ...overrides.bandShear },
  };
}

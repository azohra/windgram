/* analyze/ — typed findings over ONE profile document.

   THE CHARTER, and why this is its own subpath:

   `derive/` outputs QUANTITIES — numbers with physics homes (a lapse rate, a
   usable-lift top, a projection, a validAt join whose rows are still just
   quantities: no claims). `analyze/` outputs STATEMENTS — typed claims with
   evidence attached, over one document: what it contains (windows, timing,
   magnitudes), what it cannot say (data caveats), and where it undermines
   itself (terrain mismatch, member dropout). Statements need a vocabulary;
   a vocabulary is a contract surface, and adding to it is a contract event —
   which is exactly why statements do not live loose in `derive/`.

   SINGLE-DOCUMENT BY CHARTER, not by accident: every finding kind in the
   vocabulary survived the 2026-08-08 evidence spikes as a single-document
   statement. The cross-document statement kinds trialled beside them
   (consensus, outliers) were killed by staleness, elevation, and semantics
   artifacts — models at one site differ in modelElevationM, gust semantics
   (hourMax vs instant, ~20-30 % apart systematically), run age, and step
   cadence, so a naive cross-model claim is wrong in exactly the ways the
   catalogue exists to prevent. The name `compare` was RESERVED here until
   a cross-document statement kind survived evidence the way
   terrainMismatch did; the 2026-08-09 findings spike was that evidence,
   and `compare/` now exists — comparing STATEMENTS (this module's
   findings), never raw series, with its own versioned vocabulary and its
   charter in its own docblock.

   THE VOCABULARY IS VERSIONED the way models.json capabilities are treated:
   `ANALYZE_VOCABULARY_VERSION` names the finding-kind set, consumers switch
   on `kind`, and ADDING (or changing) A KIND IS A CONTRACT EVENT — bump the
   version, document the evidence that earned the kind its place, and treat
   removal like retiring a capability. Version 1 shipped EXACTLY the kinds
   that survived the spikes; kinds that were trialled and did not survive
   (hazard, barrier, confidence, consensus, outliers) are deliberately
   absent, not merely unimplemented.

   THE DISCIPLINE every kind obeys:
   - magnitudes and timing; NO VERDICT THAT DOES NOT REDUCE to stated
     arithmetic over stated, embedded, caller-movable thresholds (max lift
     top < launch altitude; |CIN| under a stated bound while CAPE exceeds
     a stated bound). The rule was never "no judgment words" —
     thermalWindow and quietDay carry judgment-shaped names under exactly
     that reduction;
   - any finding that used a threshold EMBEDS it (`thresholds`), defaults
     drawn from the spike whose sensitivity sweep measured them low-impact —
     thresholds are the caller's to move, the finding must confess which
     values produced it;
   - every finding carries an `evidence` block scoped to the hours it cites
     — the actual published numbers the claim derives from, keyed by the
     document's own validAt instants so the claim is checkable;
   - times are local (`day` date keys, `CitedInstant.local`) in the
     document's own `site.timeZone`, caller-overridable — local time is
     load-bearing for reading a windgram; the UTC `validAt` rides along in
     every cited instant so evidence joins back to the document;
   - altitudes are launch-relative where the caller supplies a launch
     (`AnalyzeOptions.launch` — documents are launch-agnostic;
     `peakLiftTopAboveLaunchM`), because MSL numbers mean nothing to a
     pilot standing on the hill;
   - ensemble documents are read at p50 with the p10-p90 band carried into
     evidence where the claim leans on it; per-position member counts are a
     first-class finding (`ensembleMembership`), because a p50 computed from
     0-of-21 contributing members is a landmine, not a median.

   What thermalWindow and liftCeiling are for: they RESTATE the published
   derived series — deliberately. Their value is compression (a 13-72k-token
   document down to a ~1-2k statement of when and how high) and the timing
   anchor the other findings reference; they add no information a consumer
   reading every hour would miss.

   The vocabulary barrel (the kind set, thresholds, envelope) lives in
   vocabulary.ts; each kind's type and extractor live together in
   kinds/<kind>.ts over the shared context in kinds/shared.ts; the
   extraction entry point lives in findings.ts. */

export {
  ANALYZE_VOCABULARY_VERSION,
  DEFAULT_ANALYZE_THRESHOLDS,
  type AnalyzeOptions,
  type AnalyzeThresholdOverrides,
  type AnalyzeThresholds,
  type BandShearFinding,
  type CapTimingFinding,
  type CitedInstant,
  type ConvectiveDayFinding,
  type DataCaveat,
  type DataCaveatsFinding,
  type EnsembleMembershipFinding,
  type FindingKind,
  type LiftCeilingFinding,
  type LocalDayKey,
  type PercentileCrossingFinding,
  type PercentileToken,
  type QuietDayFinding,
  type SmokeImpactFinding,
  type SmokeImpactJoinedFinding,
  type SmokeImpactProfileFinding,
  type TerrainMismatchFinding,
  type ThermalWindowFinding,
  type WindCeilings,
  type WindDirectionFinding,
  type WindExceedanceFinding,
  type WindgramAnalysis,
  type WindgramFinding,
  type WindSummaryFinding,
} from "./vocabulary.js";
export { analyzeProfile, resolveAnalyzeThresholds } from "./findings.js";

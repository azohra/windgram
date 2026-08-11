/* The public extraction frame — the normalization ground every extractor,
   first- or third-party, stands on: launch resolution, timezone-bound day
   bucketing, citation, cadence truth, precision. Third-party extractors
   run over it via `AnalyzeOptions.extensions` and land their statements in
   the envelope's `extensions` array — never in `findings`, whose versioned
   kind set stays closed, first-party, and evidence-gated (see the module
   charter in index.ts).

   What is deliberately NOT here: the extraction `Context` (it carries the
   full `AnalyzeThresholds` and `WindCeilings`, so exposing it would
   re-couple this rarely-changing surface to every vocabulary event —
   extensions bring their own thresholds and are expected to embed them in
   their own statements per the house discipline); the citation/cadence
   factories (the frame carries their RESULTS); and the first-party kind
   extractors (extensions consume the finished findings, they do not
   re-run or re-order the pipeline). */

import type { WindgramProfile } from "../contract/index.js";
import type { CitedInstant, HourSteps, LocalDayKey } from "./kinds/shared.js";
import type { WindgramFinding } from "./vocabulary.js";

/* The precision conventions and the per-gap cadence type are part of the
   frame's public surface — one home, no restating (compare/ imports them
   from here through the barrel, not from the internal kinds/shared). */
export { round1, round2 } from "./kinds/shared.js";
export type { HourSteps } from "./kinds/shared.js";

/**
 * The frame's own version. Versioned SEPARATELY from the vocabulary: the
 * frame is where extractors stand, the vocabulary is what they say; the
 * frame changes rarely and a frame change is its own contract event.
 */
export const ANALYSIS_FRAME_VERSION = 1;

/**
 * The extraction frame — the resolved per-analysis facts and the
 * citation/day/lead conventions every extractor reads. Handed to each
 * `AnalysisExtension` so third-party statements get correct
 * timezone/dropout/clipping handling for free; the raw hour data stays
 * available through `profile` (band percentiles are plain contract
 * fields, and `windgram/derive` exports the selectors — `p50`,
 * `localDateKey`, `groupByLocalDay` — the first-party extractors
 * themselves use).
 */
export interface AnalysisFrame {
  readonly profile: WindgramProfile;
  readonly timeZone: string;
  readonly timeZoneSource: "document" | "override" | "utcFallback";
  readonly deterministic: boolean;
  /** LEADING cadence — a display fact, never arithmetic (the extraction
   * context's own rule, restated on the public surface): live documents
   * widen mid-horizon, so spacing arithmetic reads `steps`. */
  readonly stepHours: number;
  /** Per-gap cadence truth, covered-span convention (see `HourSteps`). */
  readonly steps: HourSteps;
  readonly referenceTime: string;
  /** The caller's launch (`AnalyzeOptions.launch`); null when none was
   * supplied — documents are launch-agnostic. */
  readonly launchElevationM: number | null;
  /** launchElevationM, falling back to the model's own ground. */
  readonly launchReferenceM: number;
  /** Citation, day bucketing, and lead, BOUND to this analysis's zone and
   * run — the three ways an extension gets midnight wrong on its own. */
  cite(validAt: string): CitedInstant;
  dayOf(validAt: string): LocalDayKey;
  leadHours(validAt: string): number;
}

/**
 * A caller-supplied extractor run over the frame AFTER first-party
 * extraction. Its statements land on the envelope as a named `extensions`
 * entry, never in `findings`: they stay `unknown[]` so consumers narrow
 * through the extension's OWN types and no third-party statement can
 * masquerade as a first-party finding. The vocabulary's guarantees —
 * evidence blocks, embedded thresholds, the spike gate — stop at the
 * `findings` array; extensions are expected (documented, unenforceable)
 * to hold the same discipline in their own statements. A throwing
 * extension fails the analysis — the caller supplied the code;
 * `analyzeProfile` does not sandbox it.
 */
export interface AnalysisExtension {
  /** Namespaced, echoed verbatim on the envelope entry — e.g.
   * "acrophobia/ridgeDay". Duplicate names in one call throw. */
  name: string;
  extract(
    frame: AnalysisFrame,
    findings: ReadonlyArray<WindgramFinding>,
  ): unknown[];
}

/* compareRuns — convergence: compare's discipline pointed at successive
   runs of ONE model at ONE site. Ratified in
   notes/design-convergence-history.md §§5–7 (2026-08-10).

   THE CHARTER. Convergence is not a new statement discipline; it is
   compare's existing one (no verdict that does not reduce to stated
   arithmetic over stated, embedded, caller-movable thresholds; agreement
   reported, never manufactured; every non-vote with a stated reason)
   with the member axis turned from "models at one instant" to "runs of
   one model through time". compare v2 made this literal — a member
   already IS a (model, referenceTime) run — so `compareRunAnalyses`
   delegates coherence validation and the per-day vote constructions to
   `compareAnalyses` wholesale (WindowVote, QuietVote, Abstention,
   TimingVote with its cadence echo, the clipped-edge and
   midnight-electorate discipline, outOfHorizon abstentions) and adds
   only what through-time needs: the run axis. THE PRODUCT is the
   convergence ladder — per target local day, the ordered per-run
   statement stack (newest to oldest by referenceTime): what each run
   said about that day, as arithmetic restatements of its analyze
   findings. Verdicts ABOUT the ladder are exactly what the rejections
   below forbid.

   STANDING REJECTIONS (recorded 2026-08-09, restated as BINDING):
   - NO graded agreement enums;
   - NO model weighting — and no run weighting either: run age is the
     ledger's `runAgeHours` fact, for the consumer's judgment;
   - NO trend adjectives — no "converging"/"diverging"/"shrinking"/
     "growing" tokens anywhere in the vocabulary. Trajectories are
     series; deltas and rosters state themselves, the reader sees the
     shape;
   - NO staleness-as-finding — run age and horizon coverage are ledger
     and abstention facts (`runAgeHours`, `outOfHorizon`): a target day
     beyond an old run's horizon is an abstention with a reason, never a
     "changed forecast";
   - NO per-finding version tags — the envelope's `vocabularyVersion`
     governs, as everywhere else;
   - NO ensemble-narrowing verdict — the recorded spike measured REPS
     band widths moving BOTH directions as lead fell, so per-day band
     widths ride the magnitude trajectory as evidence and nothing more.

   ENVELOPE HOME (the design's ratified §5 recommendation): a SIBLING
   envelope — `RunComparison`, in windgram/history under "documents
   through time", with its own `RUN_COMPARISON_VOCABULARY_VERSION` —
   rather than new kinds under COMPARE_VOCABULARY_VERSION 3. Cross-model
   compare and through-time compare version independently, and
   `compareProfiles` consumers see no churn.

   DEFERRED (§7): candidate kinds beyond the core five below — flip
   counts, oscillation summaries, cross-model convergence, whatever the
   ladder tempts — wait for their own evidence spike. Nothing here
   pre-approves them. */

import type { WindgramProfile } from "../contract/index.js";
import { localDateKey } from "../derive/day-window.js";
import {
  analyzeProfile,
  round1,
  type AnalyzeThresholdOverrides,
  type AnalyzeThresholds,
  type EnsembleMembershipFinding,
  type LocalDayKey,
  type WindgramAnalysis,
} from "../analyze/index.js";
import {
  compareAnalyses,
  type Abstention,
  type ComparisonMemberLedger,
  type QuietVote,
  type TimingVote,
  type WindowAgreementFinding,
  type WindowVote,
} from "../compare/index.js";
import type { HistoryRevision } from "./index.js";

/**
 * The run-comparison kind set this module can emit — a sibling of
 * `COMPARE_VOCABULARY_VERSION`, versioned independently (the ratified
 * envelope-home decision): through-time statements can grow without a
 * cross-model contract event and vice versa. Version 1 ships exactly the
 * core the recorded 2026-08-09 spike stood behind: the existence, timing,
 * and magnitude trajectories, identityDrift, and arithmetic `settled`.
 * Same tolerant-reader convention as analyze/ and compare/: readers of
 * serialized envelopes ignore kinds and fields they do not know.
 */
export const RUN_COMPARISON_VOCABULARY_VERSION = 1;

/**
 * `settled`'s embedded defaults — TRIAL constants, caller-movable per
 * call (`CompareRunsOptions.settled`). Calibration provenance: the
 * 2026-08-09 spike's read of a THIN archive (days of runs, one basin),
 * not a sweep over a representative one. THE RECORDED RE-SWEEP
 * OBLIGATION STANDS: re-sweep both constants at ≥ 2 weeks of month-file
 * archive (~2026-08-24, paired with the September publication-lag
 * re-verification); if the sweep moves them, that is a defaults change
 * with stated evidence, not a vocabulary event.
 */
export const DEFAULT_SETTLED_THRESHOLDS = { minRuns: 3, magnitudeBandM: 300 } as const;

/**
 * The lead anchor's default local hour: the target day's LOCAL NOON in
 * the comparison's one timeZone — the honest single instant for "the
 * flying day" without minting a judgment about window timing. A caller
 * anchoring elsewhere moves `CompareRunsOptions.leadAnchorLocalHour`,
 * not the arithmetic. This composes with (does not replace) analyze
 * v4's per-finding `leadHours`, which anchors referenceTime → validAt.
 */
export const DEFAULT_LEAD_ANCHOR_LOCAL_HOUR = 12;

/* ------------------------------------------------------------- vocabulary */

/**
 * One run's rung on a day's existence ladder: what the run said about
 * the target day — window, quiet, or an abstention with its reason —
 * with the run's OWN sensitivity flip values carried through, so a
 * genuine forecast flip at a threshold knife-edge reads as knife-edge
 * arithmetic, not model chaos. Benched runs (terrainMismatch, ledger
 * `benched`) appear on no rung: the runs ledger is their stated reason
 * for every day, compare v2's rule inherited.
 */
export interface ExistenceRung {
  /** The run's member key (`"{model}@{referenceTime}"`) — joins the
   * envelope's `runs` ledger and `analyses` record. */
  member: string;
  referenceTime: string;
  /** Hours from this run's referenceTime to the target day's anchor
   * instant (the envelope's `leadAnchorLocalHour` in its timeZone);
   * negative when the anchor precedes the run — a run restating a past
   * day is arithmetic like any other, not an error. */
  leadHours: number;
  vote: "window" | "quiet" | "abstained";
  /** The stated non-vote reason, present exactly when `vote` is
   * "abstained" — compare v2's Abstention reasons, verbatim. */
  abstained?: Abstention["reason"];
  /** The quiet vote's failed floors, present exactly when `vote` is
   * "quiet" — the numbers that failed, per the quietDay statement. */
  failed?: QuietVote["failed"];
  /**
   * The run's own flip values against the shared floors — the same
   * statement as windowAgreement's `sensitivity`, per run instead of
   * per electorate (see that kind's JSDoc for the window-exact /
   * quiet-necessary caveat): a window rung's values are its windows'
   * binding peaks nearest each floor; a quiet rung's are its day peaks
   * below them; an abstained rung offers nothing (null).
   */
  sensitivity: { wstarFlipAtMs: number | null; depthFlipAtM: number | null };
}

/**
 * Per target local day: run-by-run window/quiet/abstain votes, newest
 * run first — the ladder order. An existence flip is read off the
 * `vote` sequence; the finding never names it with an adjective.
 * Emitted for every day the electorate could address (the same
 * suppression rule as windowAgreement: only a day with zero voters AND
 * zero abstentions emits nothing).
 */
export interface ExistenceTrajectoryFinding {
  kind: "existenceTrajectory";
  day: LocalDayKey;
  rungs: ReadonlyArray<ExistenceRung>;
  /** The floors every rung's vote and sensitivity read against. */
  thresholds: { wstarMinMs: number; depthMinM: number };
}

/** A run's unclipped window edge on the target day: compare v2's
 * TimingVote (instant + the window's `stepHours` quantization echo)
 * plus the run axis. */
export interface RunTimingVote extends TimingVote {
  referenceTime: string;
  /** See ExistenceRung.leadHours. */
  leadHours: number;
}

/**
 * Per target local day: window start/end instants across runs, newest
 * run first, reusing compare v2's timing construction verbatim — only
 * UNCLIPPED edges vote (a horizon-clipped edge reads as "open since at
 * least" / "still open at", never as timing), an edge joins the day
 * whose local calendar date contains its instant, and every vote
 * carries its window's `stepHours` so up to stepHours − 1 h of
 * run-to-run difference reads as quantization, not drift. The spreads
 * are max − min arithmetic over the contributing edges (null below two
 * contributors); the reader sees the series, the finding draws no
 * trend. Emitted when at least one run contributes an edge.
 */
export interface TimingTrajectoryFinding {
  kind: "timingTrajectory";
  day: LocalDayKey;
  starts: ReadonlyArray<RunTimingVote>;
  ends: ReadonlyArray<RunTimingVote>;
  startSpreadHours: number | null;
  /** Widest stepHours among `starts` — the quantization bound on the
   * start spread; null when `starts` is empty. */
  startStepHoursMax: number | null;
  endSpreadHours: number | null;
  endStepHoursMax: number | null;
}

/**
 * One run's magnitudes for the target day. Window rungs read the run's
 * windows KEYED to this day (a midnight spanner's vote on its second
 * day carries whole-window numbers, so a via-only run states null here
 * rather than restating another day's magnitudes — the same honesty
 * `viaWindowFrom` encodes); the launch-relative peak follows
 * heightSpread's rule and joins the day its instant falls in. Quiet
 * rungs restate the quiet vote's day peaks.
 */
export interface MagnitudeRung {
  member: string;
  referenceTime: string;
  /** See ExistenceRung.leadHours. */
  leadHours: number;
  vote: "window" | "quiet";
  /** Window: the day's windows' peak W*; quiet: the day's best W*.
   * Null when unpublished or (window) the run touches the day only via
   * a spanner keyed elsewhere. */
  peakThermalVelocityMs: number | null;
  /** Launch-relative lift extent: a window rung's best
   * `peakLiftTopAboveLaunchM` whose peak instant falls in the day (null
   * when no launch was supplied); a quiet rung's `peakLiftDepthM` (its
   * launch fallback is the model's own ground). The magnitude `settled`
   * reads. */
  peakLiftAboveLaunchM: number | null;
  /** Covered duration summed over the run's windows keyed to this day;
   * null for quiet rungs and via-only window rungs. */
  windowDurationHours: number | null;
  /**
   * Ensemble runs only: the run's own per-day p10–p90 band widths at
   * the day's peak-p50-W* hour (ensembleMembership's `dayBands`,
   * non-truncated entries only). EVIDENCE WITH NO NARROWING VERDICT —
   * the recorded rejection stands: REPS widths moved both directions as
   * lead fell, so "narrowing = converging" was manufactured. Widths
   * ship; the reader sees the series.
   */
  bandWidth?: { wstarBandWidthMs: number | null; liftTopBandWidthM: number | null };
}

/**
 * Per target local day: run-by-run peak W*, launch-relative peak lift,
 * and window duration, newest run first — the numbers whose run-to-run
 * deltas state themselves. Emitted when at least one run voted on the
 * day (abstentions carry no magnitudes; their reasons live on the
 * existence trajectory).
 */
export interface MagnitudeTrajectoryFinding {
  kind: "magnitudeTrajectory";
  day: LocalDayKey;
  rungs: ReadonlyArray<MagnitudeRung>;
}

/**
 * Non-meteorological facts that changed between runs, stated so a
 * pipeline or model change is never read as weather — the same
 * rationale that makes the history loader's dedupe mandatory.
 * `revisions` passes the loader's republication statements through
 * verbatim (`LoadedHistory.revisions`, via
 * `CompareRunsOptions.revisions`); `changes` walks chronologically
 * adjacent runs' ledger identity facts. Emitted only when there is
 * drift to state; day-less, like the ledger facts it restates.
 */
export interface IdentityDriftFinding {
  kind: "identityDrift";
  /** Republications the history loader's dedupe stated, passed through
   * verbatim; empty when the caller supplied none. */
  revisions: ReadonlyArray<HistoryRevision>;
  /** Identity facts that differ between chronologically adjacent runs,
   * newest pair first. */
  changes: ReadonlyArray<{
    fact: "modelElevationM" | "stepHours" | "hours";
    from: { referenceTime: string; value: number };
    to: { referenceTime: string; value: number };
  }>;
}

/**
 * Arithmetic stability, per target local day: whether the newest
 * `minRuns` runs' launch-relative lift magnitudes all sit within
 * `magnitudeBandM` of each other (max − min ≤ band). A STABILITY
 * statement about RUNS — "the forecast has stopped moving" — and
 * explicitly NOT probability and NOT skill: a settled forecast can be
 * settled on the wrong answer, and nothing here scores the atmosphere.
 * `settled` is false whenever the arithmetic cannot run (fewer runs
 * than `minRuns`, or any sampled run stating no magnitude — abstained,
 * via-only, or windows without a caller launch); the `sample` roster
 * shows which, so "not stable" and "not statable" stay readable apart.
 *
 * The default constants are TRIAL (see `DEFAULT_SETTLED_THRESHOLDS`:
 * spike provenance, re-sweep obligation ~2026-08-24) and
 * caller-movable via `CompareRunsOptions.settled`.
 */
export interface SettledFinding {
  kind: "settled";
  day: LocalDayKey;
  settled: boolean;
  /** The newest `minRuns` runs' magnitudes (fewer when the comparison
   * holds fewer runs), newest first — the sample the arithmetic reads. */
  sample: ReadonlyArray<{
    member: string;
    referenceTime: string;
    leadHours: number;
    /** See MagnitudeRung.peakLiftAboveLaunchM; null when the run stated
     * no magnitude for the day. */
    peakLiftAboveLaunchM: number | null;
  }>;
  /** max − min over the sample's magnitudes; null when the sample is
   * short of `minRuns` or any magnitude is null. */
  spreadM: number | null;
  thresholds: { minRuns: number; magnitudeBandM: number };
}

export type RunComparisonFinding =
  | ExistenceTrajectoryFinding
  | TimingTrajectoryFinding
  | MagnitudeTrajectoryFinding
  | IdentityDriftFinding
  | SettledFinding;
export type RunComparisonFindingKind = RunComparisonFinding["kind"];

/* ---------------------------------------------------------------- options */

/** The options both entry points share — the run axis's own knobs. */
export interface CompareRunsSharedOptions {
  /**
   * `LoadedHistory.revisions` from the history loader, passed through
   * so republications are stated on identityDrift instead of silenced.
   * The loader already deduped keep-latest-generatedAt; this is the
   * statement of what it discarded.
   */
  revisions?: ReadonlyArray<HistoryRevision>;
  /**
   * The lead anchor: hours after local midnight of the target day, in
   * the comparison's timeZone. Default `DEFAULT_LEAD_ANCHOR_LOCAL_HOUR`
   * (12 — local noon). A wall time skipped by a DST transition resolves
   * to the adjacent instant.
   */
  leadAnchorLocalHour?: number;
  /** `settled`'s constants, merged over `DEFAULT_SETTLED_THRESHOLDS` —
   * embedded TRIAL defaults, the caller's to move. */
  settled?: { minRuns?: number; magnitudeBandM?: number };
}

export interface CompareRunsOptions extends CompareRunsSharedOptions {
  /** ONE IANA timezone for the whole comparison — target days pair
   * across runs only in one zone (compare's rule, inherited). */
  timeZone: string;
  /** ONE launch for every run's analysis; absent, window rungs state no
   * launch-relative magnitude and `settled` reads false (not statable). */
  launch?: { elevationM: number } | null;
  /** Threshold overrides, applied identically to every run. */
  thresholds?: AnalyzeThresholdOverrides;
}

/** Options for `compareRunAnalyses`. As with `compareAnalyses`:
 * timeZone, launch, and thresholds are NOT here — they come from the
 * envelopes and are validated, never supplied. */
export type CompareRunAnalysesOptions = CompareRunsSharedOptions;

/* --------------------------------------------------------------- envelope */

export interface RunComparison {
  /** `RUN_COMPARISON_VOCABULARY_VERSION` — the sibling constant, typed
   * `number` under the tolerant-reader convention. */
  vocabularyVersion: number;
  /** The one model whose runs are compared. */
  model: string;
  site: { id: string; launchAltitudeM: number | null };
  timeZone: string;
  /** The one resolved threshold set every run was analyzed with. */
  thresholds: AnalyzeThresholds;
  newestReferenceTime: string;
  /** The lead anchor every `leadHours` in this envelope reads against —
   * local hour of the target day (default 12, local noon). */
  leadAnchorLocalHour: number;
  /**
   * Per-run ledger, NEWEST FIRST (the ladder order every rung array in
   * this envelope shares) — compare v2's member ledger reused verbatim:
   * `runAgeHours` and `stepHours` are the staleness/cadence facts the
   * rejections keep out of the findings, and `benched` is a benched
   * run's stated reason for appearing on no rung.
   */
  runs: ReadonlyArray<ComparisonMemberLedger>;
  findings: RunComparisonFinding[];
  /** Each run's own analysis, keyed by member key — the rungs'
   * provenance, exactly as on WindgramComparison. */
  analyses: Readonly<Record<string, WindgramAnalysis>>;
}

/* ------------------------------------------------------------ entry points */

/**
 * Compares one site's ANALYSES across successive runs of one model —
 * the seam `compareRuns` wraps, and the door for cached envelopes (the
 * same door `compareAnalyses` opened: analyze at the edge, cache as
 * JSON, compare through time later). Throws `compareRuns: mixed models`
 * on more than one model — the inverse of compareProfiles' axis — and
 * `compareRuns: no runs` on an empty list; every other coherence check
 * (one site, one zone, one launch, one threshold set, duplicate-run
 * guard, vocabulary-version skew, pre-0.22 self-description) is
 * DELEGATED to `compareAnalyses` and throws its named errors verbatim.
 * Input order does not matter; runs are ordered by referenceTime
 * internally.
 */
export function compareRunAnalyses(
  analyses: ReadonlyArray<WindgramAnalysis>,
  options: CompareRunAnalysesOptions = {},
): RunComparison {
  if (analyses.length === 0) throw new Error("compareRuns: no runs");
  const model = analyses[0].model;
  for (const analysis of analyses) {
    if (analysis.model !== model) {
      throw new Error(
        `compareRuns: mixed models (${model} vs ${analysis.model}) — one comparison, one model's runs through time; models at one instant are compareProfiles' axis`,
      );
    }
  }

  /* Coherence validation AND the per-day vote constructions are the
     shipped compareAnalyses door — reused, never re-derived: its
     windowAgreement findings already carry every run's WindowVote/
     QuietVote/Abstention with the clipped-edge, midnight-electorate,
     outOfHorizon, and cadence-echo discipline. compareRuns re-projects
     them along the run axis. */
  const ascending = [...analyses].sort((a, b) =>
    a.run.referenceTime.localeCompare(b.run.referenceTime),
  );
  const comparison = compareAnalyses(ascending);

  const leadAnchorLocalHour = options.leadAnchorLocalHour ?? DEFAULT_LEAD_ANCHOR_LOCAL_HOUR;
  const settledThresholds = { ...DEFAULT_SETTLED_THRESHOLDS, ...options.settled };
  const timeZone = comparison.timeZone;
  const { wstarMinMs, depthMinM } = comparison.thresholds.thermalWindow;

  /* The ladder order: newest run first, everywhere in this envelope. */
  const runsNewestFirst = [...comparison.members].reverse();
  const referenceTimeOf = new Map(
    comparison.members.map((entry) => [entry.member, entry.referenceTime]),
  );

  /* Lead anchoring: one anchor instant per target day (local
     `leadAnchorLocalHour` in the comparison zone), memoized. */
  const anchors = new Map<LocalDayKey, number>();
  const leadOf = (day: LocalDayKey, referenceTime: string): number => {
    let anchor = anchors.get(day);
    if (anchor === undefined) {
      anchor = wallClockInstantMs(day, leadAnchorLocalHour, timeZone);
      anchors.set(day, anchor);
    }
    return round1((anchor - Date.parse(referenceTime)) / 3_600_000);
  };

  /* Each ensemble run's per-day band widths (ensembleMembership's
     dayBands), indexed once — magnitude evidence, never a verdict. */
  const dayBandsOf = new Map<string, EnsembleMembershipFinding["dayBands"]>();
  for (const entry of comparison.members) {
    const membership = comparison.analyses[entry.member].findings.find(
      (finding): finding is EnsembleMembershipFinding => finding.kind === "ensembleMembership",
    );
    if (membership) dayBandsOf.set(entry.member, membership.dayBands);
  }

  const findings: RunComparisonFinding[] = [];

  /* identityDrift: the loader's republication statements pass through;
     the ledger walk states what identity facts changed between
     chronologically adjacent runs. */
  const revisions = [...(options.revisions ?? [])];
  const changes: IdentityDriftFinding["changes"][number][] = [];
  for (let i = comparison.members.length - 1; i >= 1; i -= 1) {
    const from = comparison.members[i - 1];
    const to = comparison.members[i];
    for (const fact of ["modelElevationM", "stepHours", "hours"] as const) {
      if (from[fact] !== to[fact]) {
        changes.push({
          fact,
          from: { referenceTime: from.referenceTime, value: from[fact] },
          to: { referenceTime: to.referenceTime, value: to[fact] },
        });
      }
    }
  }
  if (revisions.length > 0 || changes.length > 0) {
    findings.push({ kind: "identityDrift", revisions, changes });
  }

  /* Per target day, in day order: the windowAgreement finding IS the
     day's electorate — re-project it along the run axis. */
  const agreements = comparison.findings.filter(
    (finding): finding is WindowAgreementFinding => finding.kind === "windowAgreement",
  );
  for (const agreement of agreements) {
    const day = agreement.day;
    const windowsBy = new Map<string, WindowVote[]>();
    for (const vote of agreement.windows) {
      const bucket = windowsBy.get(vote.member);
      if (bucket) bucket.push(vote);
      else windowsBy.set(vote.member, [vote]);
    }
    const quietBy = new Map(agreement.quiet.map((vote) => [vote.member, vote]));
    const abstainedBy = new Map(agreement.abstained.map((entry) => [entry.member, entry]));

    /* Existence: every unbenched run has exactly one rung (compare v2
       guarantees a vote or an abstention for every universe day). */
    const rungs: ExistenceRung[] = [];
    for (const run of runsNewestFirst) {
      const windows = windowsBy.get(run.member);
      const quiet = quietBy.get(run.member);
      const abstention = abstainedBy.get(run.member);
      const base = {
        member: run.member,
        referenceTime: run.referenceTime,
        leadHours: leadOf(day, run.referenceTime),
      };
      if (windows) {
        rungs.push({
          ...base,
          vote: "window",
          sensitivity: {
            wstarFlipAtMs: nearestTo(
              windows.map((vote) => vote.peakThermalVelocityMs),
              wstarMinMs,
            ),
            depthFlipAtM: nearestTo(
              windows
                .map((vote) => vote.peakLiftTopAboveLaunchM)
                .filter((value): value is number => value !== null),
              depthMinM,
            ),
          },
        });
      } else if (quiet) {
        rungs.push({
          ...base,
          vote: "quiet",
          failed: quiet.failed,
          sensitivity: {
            wstarFlipAtMs: quiet.peakThermalVelocityMs,
            depthFlipAtM: quiet.peakLiftDepthM,
          },
        });
      } else if (abstention) {
        rungs.push({
          ...base,
          vote: "abstained",
          abstained: abstention.reason,
          sensitivity: { wstarFlipAtMs: null, depthFlipAtM: null },
        });
      }
    }
    findings.push({
      kind: "existenceTrajectory",
      day,
      rungs,
      thresholds: { wstarMinMs, depthMinM },
    });

    /* Timing: the day's timing envelope, votes decorated with the run
       axis and re-ordered newest first; the spreads are the same
       arithmetic over the same edges, copied verbatim. */
    const newestFirst = (a: { referenceTime: string }, b: { referenceTime: string }) =>
      b.referenceTime.localeCompare(a.referenceTime);
    const decorate = (vote: TimingVote): RunTimingVote => {
      const referenceTime = referenceTimeOf.get(vote.member)!;
      return { ...vote, referenceTime, leadHours: leadOf(day, referenceTime) };
    };
    const starts = agreement.timing.starts.map(decorate).sort(newestFirst);
    const ends = agreement.timing.ends.map(decorate).sort(newestFirst);
    if (starts.length + ends.length > 0) {
      findings.push({
        kind: "timingTrajectory",
        day,
        starts,
        ends,
        startSpreadHours: agreement.timing.startSpreadHours,
        startStepHoursMax: agreement.timing.startStepHoursMax,
        endSpreadHours: agreement.timing.endSpreadHours,
        endStepHoursMax: agreement.timing.endStepHoursMax,
      });
    }

    /* Magnitude: the voting runs' numbers, newest first. */
    const magnitudeRungs: MagnitudeRung[] = [];
    for (const run of runsNewestFirst) {
      const windows = windowsBy.get(run.member);
      const quiet = quietBy.get(run.member);
      if (!windows && !quiet) continue;
      const dayBand = dayBandsOf
        .get(run.member)
        ?.find((entry) => entry.day === day && !entry.truncated);
      const base = {
        member: run.member,
        referenceTime: run.referenceTime,
        leadHours: leadOf(day, run.referenceTime),
        ...(dayBand
          ? {
              bandWidth: {
                wstarBandWidthMs: dayBand.wstarBandWidthMs,
                liftTopBandWidthM: dayBand.liftTopBandWidthM,
              },
            }
          : {}),
      };
      if (windows) {
        /* Whole-window numbers belong to the window's own day: only
           votes keyed here state W* and duration, and the peak joins
           the day its instant falls in (heightSpread's rule). */
        const own = windows.filter((vote) => vote.viaWindowFrom === undefined);
        const peaks = windows
          .map((vote) => vote.peakLiftTopAboveLaunchM)
          .filter(
            (value, index): value is number =>
              value !== null &&
              localDateKey(windows[index].peakLiftTopAt.validAt, timeZone) === day,
          );
        magnitudeRungs.push({
          ...base,
          vote: "window",
          peakThermalVelocityMs:
            own.length > 0 ? Math.max(...own.map((vote) => vote.peakThermalVelocityMs)) : null,
          peakLiftAboveLaunchM: peaks.length > 0 ? Math.max(...peaks) : null,
          windowDurationHours:
            own.length > 0
              ? round1(own.reduce((sum, vote) => sum + vote.durationHours, 0))
              : null,
        });
      } else if (quiet) {
        magnitudeRungs.push({
          ...base,
          vote: "quiet",
          peakThermalVelocityMs: quiet.peakThermalVelocityMs,
          peakLiftAboveLaunchM: quiet.peakLiftDepthM,
          windowDurationHours: null,
        });
      }
    }
    if (magnitudeRungs.length > 0) {
      findings.push({ kind: "magnitudeTrajectory", day, rungs: magnitudeRungs });
    }

    /* settled: the newest minRuns runs' magnitudes, the band, and
       nothing else — the doc's exact arithmetic. */
    const magnitudeOf = new Map(magnitudeRungs.map((rung) => [rung.member, rung]));
    const sample = runsNewestFirst.slice(0, settledThresholds.minRuns).map((run) => ({
      member: run.member,
      referenceTime: run.referenceTime,
      leadHours: leadOf(day, run.referenceTime),
      peakLiftAboveLaunchM: magnitudeOf.get(run.member)?.peakLiftAboveLaunchM ?? null,
    }));
    const values = sample.map((entry) => entry.peakLiftAboveLaunchM);
    const statable =
      sample.length >= settledThresholds.minRuns &&
      values.every((value): value is number => value !== null);
    const spreadM = statable
      ? round1(Math.max(...(values as number[])) - Math.min(...(values as number[])))
      : null;
    findings.push({
      kind: "settled",
      day,
      settled: statable && spreadM! <= settledThresholds.magnitudeBandM,
      sample,
      spreadM,
      thresholds: { ...settledThresholds },
    });
  }

  return {
    vocabularyVersion: RUN_COMPARISON_VOCABULARY_VERSION,
    model,
    site: comparison.site,
    timeZone,
    thresholds: comparison.thresholds,
    newestReferenceTime: comparison.newestReferenceTime,
    leadAnchorLocalHour,
    runs: runsNewestFirst,
    findings,
    analyses: comparison.analyses,
  };
}

/**
 * Compares successive runs of ONE model at ONE site at the findings
 * level — the wrapper over `compareRunAnalyses`, one construction: each
 * run is analyzed HERE with the comparison's single timeZone, launch,
 * and threshold set. The natural feed is the history loader
 * (`loadProfileHistory(...).runs`, already deduped and chronological,
 * with `revisions` passed through for identityDrift); mixed models or
 * sites throw — one model through time is this axis, models at one
 * instant are compareProfiles'.
 */
export function compareRuns(
  runs: ReadonlyArray<WindgramProfile>,
  options: CompareRunsOptions,
): RunComparison {
  const { timeZone, launch, thresholds, ...shared } = options;
  return compareRunAnalyses(
    runs.map((profile) => analyzeProfile(profile, { timeZone, launch, thresholds })),
    shared,
  );
}

/* ----------------------------------------------------------------- helpers */

/* The candidate nearest the floor — the sensitivity statement's value,
   per run (compare/'s own nearestTo restated: ties break toward the
   smaller value for determinism; null when the run offers nothing). */
function nearestTo(candidates: ReadonlyArray<number>, floor: number): number | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((best, value) => {
    const distance = Math.abs(value - floor);
    const bestDistance = Math.abs(best - floor);
    if (distance < bestDistance) return value;
    if (distance === bestDistance && value < best) return value;
    return best;
  });
}

/* Wall-clock → instant: the UTC millisecond at which the zone's clock
   reads `day` + `localHour` hours. Fixed-point iteration over the
   zone's own formatted reading (two rounds absorb any offset change
   between guesses); a wall time skipped by a DST spring-forward
   resolves to the adjacent instant, which is exactly the honesty a
   noon-ish anchor needs. */
const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();

function wallClockAsUtcMs(ms: number, timeZone: string): number {
  let formatter = wallClockFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZone,
    });
    wallClockFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(ms)).map(({ type, value }) => [type, value]),
  );
  return Date.parse(
    `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"]}:${parts["minute"]}:${parts["second"]}Z`,
  );
}

function wallClockInstantMs(day: LocalDayKey, localHour: number, timeZone: string): number {
  const target = Date.parse(`${day}T00:00:00Z`) + localHour * 3_600_000;
  let guess = target;
  for (let i = 0; i < 2; i += 1) guess += target - wallClockAsUtcMs(guess, timeZone);
  return guess;
}

/* compare/ — typed statements over a COLLECTION of documents for one site.

   THE CHARTER, and why this subpath exists at all: the name was RESERVED
   in analyze/'s charter until a cross-document statement kind survived
   evidence the way terrainMismatch did. The 2026-08-09 findings spike
   (notes/spike-compare) is that evidence: over nine live documents for
   one site, agreement at the FINDINGS level tracked real forecast
   divergence where value-level consensus had tracked artifacts —
   8/8 comparable models unanimous on window existence, window ends
   within one hour once horizon-clipped edges stopped voting, and the
   one genuine split (a peak W* of 0.8 against the 0.9 floor) exactly
   the divergence a pilot wants surfaced. The kinds below are the ones
   that survived; nothing else ships until it earns its place the same
   way.

   THE DISCIPLINE, inherited from analyze/ (no verdict that does not
   reduce to stated arithmetic over stated, embedded, caller-movable
   thresholds) and extended:
   - compare statements, not series: members vote through their analyze
     findings, which are already launch-relative, local-day keyed, and
     threshold-embedded — the normalizations the value spike showed a raw
     comparison lacks. Comparability holds by construction: every member
     is analyzed here, with one timeZone and one threshold set.
   - agreement is REPORTED, never manufactured: no averaging, no blended
     consensus, no synthesized forecast. Where members diverge, the
     divergence is the statement (heightSpread carries a roster and a
     spread, deliberately no mean).
   - every non-vote has a stated reason: a member with a terrain deficit
     whose lift never reaches launch is benched in the ledger (its
     launch-relative arithmetic is structurally broken — the GEPS case);
     a truncated quiet day abstains (a model lacking a day's data does
     not get to call the day); a horizon-clipped window edge leaves the
     timing envelope (it reads as >=/<=, not as timing). Documents the
     transport could not deliver enter the roster via
     options.unavailable, so the reader of a comparison sees the whole
     field, not just the survivors.
   - weighting is downstream: run age, cadence, grid kind are stated as
     ledger facts for the consumer's judgment, never applied as scores.

   THE VOCABULARY IS VERSIONED exactly like analyze/'s:
   COMPARE_VOCABULARY_VERSION names the kind set, and adding or changing
   a kind is a contract event — bump it and record the evidence. */

import { isDeterministicProfile, type WindgramProfile } from "../contract/index.js";
import {
  analyzeProfile,
  resolveAnalyzeThresholds,
  type AnalyzeThresholdOverrides,
  type AnalyzeThresholds,
  type CitedInstant,
  type LocalDayKey,
  type QuietDayFinding,
  type WindgramAnalysis,
} from "../analyze/index.js";
import { round1 } from "../analyze/kinds/shared.js";

/**
 * The comparison-kind set this module can emit. Version 1 shipped exactly
 * the kinds the 2026-08-09 findings spike earned: windowAgreement and
 * heightSpread, over the member ledger. Kinds trialled at the value
 * level and killed by artifacts (consensus, outliers) remain
 * deliberately absent.
 */
export const COMPARE_VOCABULARY_VERSION = 2;
/* v2 (2026-08-10): rides analyze v4 as one release (toolkit 0.21.0),
   ratified in notes/design-analyze-compare-v4.md over the 2026-08-10
   spikes (notes/spike-v4: S1-percentiles, S3-wind carry the compare-side
   evidence). Votes read the renamed `thermalWindow` kind. The breaking
   identity change: a member is `(model, referenceTime)`, not the model
   slug — re-derived blind by all three reviews, and the same-model guard
   v1 landed becomes real support for two runs of one model (the
   convergence program's break, pre-paid). BREAKING KEY CHANGE that rides
   it: the envelope's `analyses` record is keyed by the composite member
   key `"{model}@{referenceTime}"` (see `comparisonMemberKey`) for EVERY
   member, not by the model slug — a v1 consumer reading
   `analyses[model]` must re-key via the ledger's `member` field; every
   vote and roster entry now carries both `member` (the analyses/ledger
   key) and `model` (the headline token). windowAgreement gains the
   sensitivity statement (smallest threshold move that flips a voter),
   cadence echoes on timing votes (Tier 0 #5 — a 3-hourly member's edge
   is quantization, not timing), outOfHorizon abstentions (Tier 0 #4:
   "voters 3, unanimous true" said nothing about the 7 members that never
   reached the day) and the midnight-electorate fix (Tier 0 #3); zero-voter
   findings are suppressed only when a day has zero voters AND zero
   abstentions, so horizon-edge days keep their roster records.
   windDivergence lands from S3 with the mandatory elevation-regime echo
   (mean-wind ratios 0.18–1.22 at matched sites are grid-elevation
   regimes, not disagreement), gust spreads stay within one semantics
   class (measured gap ~1.8–2.8×), and shear rates never join a roster
   (not comparable across level densities). heightSpread peaks gain the
   optional p10–p90 band as verdict-free context (S1: 57 of 61 outside
   peaks sit ABOVE the band — exceedance is the norm, never an outlier
   verdict); WindowVote carries the percentile test through. */

/* ------------------------------------------------------------- vocabulary */

/**
 * The member key: `"{model}@{referenceTime}"` — v2's identity, one member
 * per (model, referenceTime) run. Keys the envelope's `analyses` record
 * and the ledger's `member` field; every vote and roster entry carries it
 * beside the plain `model` so provenance joins by one string without
 * parsing it.
 */
export function comparisonMemberKey(model: string, referenceTime: string): string {
  return `${model}@${referenceTime}`;
}

/** One member's comparability facts — stated, never scored. */
export interface ComparisonMemberLedger {
  /** The member key (`comparisonMemberKey(model, referenceTime)`) — the
   * envelope-wide identity every vote, roster entry, and `analyses` key
   * uses. */
  member: string;
  model: string;
  kind: "deterministic" | "ensemble";
  referenceTime: string;
  /** Hours older than the newest member's run — a discount fact. */
  runAgeHours: number;
  /** The member's LEADING cadence (see WindgramAnalysis.stepHours) — a
   * ledger fact; live documents can widen mid-horizon. */
  stepHours: number;
  hours: number;
  modelElevationM: number;
  /** The comparison's one launch (CompareOptions.launch — documents are
   * launch-agnostic); null when none was supplied. */
  launchAltitudeM: number | null;
  /** modelElevationM − launch; null when no launch was supplied. */
  elevationDeltaM: number | null;
  /**
   * Non-null when the member cannot vote on window or height claims:
   * its terrain deficit is such that its published lift top never
   * reaches launch, so every launch-relative statement it makes is
   * structurally biased (the analyze terrainMismatch verdict).
   */
  benched: { reason: "terrainMismatch"; deltaM: number } | null;
}

/** A member's window vote for one local day (its findings restated). */
export interface WindowVote {
  member: string;
  model: string;
  start: CitedInstant;
  end: CitedInstant;
  clippedAtStart: boolean;
  clippedAtEnd: boolean;
  durationHours: number;
  peakLiftTopAboveLaunchM: number | null;
  peakLiftTopAt: CitedInstant;
  peakThermalVelocityMs: number;
}

/** A member's quiet vote for one local day (non-truncated by definition). */
export interface QuietVote {
  member: string;
  model: string;
  failed: QuietDayFinding["failed"];
  peakThermalVelocityMs: number | null;
  peakLiftDepthM: number | null;
}

/**
 * Per local day: who says the day has a thermal window, who says quiet
 * (with the numbers that failed), who abstained and why — and the timing
 * envelope among the edges that are forecasts rather than data
 * boundaries. `unanimous` is arithmetic over the voters (all-window or
 * all-quiet); with fewer than two voters it is null, because unanimity
 * of one is not a statement.
 */
export interface WindowAgreementFinding {
  kind: "windowAgreement";
  day: LocalDayKey;
  windows: ReadonlyArray<WindowVote>;
  quiet: ReadonlyArray<QuietVote>;
  abstained: ReadonlyArray<{ member: string; model: string; reason: "truncatedDay" }>;
  voters: number;
  unanimous: boolean | null;
  /**
   * Start/end spreads among UNCLIPPED edges only (a clipped edge reads
   * as "open since at least" / "still open at"); null when fewer than
   * two members contribute an unclipped edge.
   */
  timing: {
    startSpreadHours: number | null;
    endSpreadHours: number | null;
    starts: ReadonlyArray<{ member: string; model: string; at: CitedInstant }>;
    ends: ReadonlyArray<{ member: string; model: string; at: CitedInstant }>;
  };
}

/**
 * Launch-relative peak lift per voting member, with the spread — the
 * divergence stated as a fact. Deliberately no mean, no median, no
 * consensus height: the spike measured spreads of 1,100–2,500 m among
 * comparable members, and an average of that is a forecast no model
 * made. Emitted for days where at least two unbenched members report a
 * launch-relative peak.
 */
export interface HeightSpreadFinding {
  kind: "heightSpread";
  day: LocalDayKey;
  peaks: ReadonlyArray<{
    member: string;
    model: string;
    peakLiftTopAboveLaunchM: number;
    at: CitedInstant;
  }>;
  spreadM: number;
}

export type ComparisonFinding = WindowAgreementFinding | HeightSpreadFinding;
export type ComparisonFindingKind = ComparisonFinding["kind"];

/* ---------------------------------------------------------------- options */

export interface CompareOptions {
  /**
   * ONE IANA timezone for the whole comparison — day keys pair across
   * members only when every side computes them in the same zone, so
   * unlike analyzeProfile there is no per-document fallback here.
   */
  timeZone: string;
  /** Threshold overrides, applied identically to every member. */
  thresholds?: AnalyzeThresholdOverrides;
  /**
   * ONE launch for the whole comparison, passed to every member's analysis
   * (see AnalyzeOptions.launch) — documents are launch-agnostic, and
   * launch-relative votes compare only when every member reads against the
   * same launch. Absent, members analyze launch-free: no terrainMismatch
   * benching, no launch-relative peaks, no heightSpread.
   */
  launch?: { elevationM: number } | null;
  /**
   * Models that could not be compared because their documents never
   * arrived — the transport's DocumentMiss, passed through so the
   * roster names the whole field. "invalid" members are a contract
   * break; see the transport docs.
   */
  unavailable?: ReadonlyArray<{ model: string; miss: "absent" | "invalid" }>;
}

/* ---------------------------------------------------------------- envelope */

export interface WindgramComparison {
  vocabularyVersion: typeof COMPARE_VOCABULARY_VERSION;
  /** The compared site plus the comparison's launch (CompareOptions.launch);
   * launchAltitudeM is null when no launch was supplied. */
  site: { id: string; launchAltitudeM: number | null };
  timeZone: string;
  /** The one threshold set every member was analyzed with. */
  thresholds: AnalyzeThresholds;
  newestReferenceTime: string;
  members: ReadonlyArray<ComparisonMemberLedger>;
  unavailable: ReadonlyArray<{ model: string; miss: "absent" | "invalid" }>;
  findings: ComparisonFinding[];
  /**
   * Each member's own analysis — the votes' provenance. KEYED BY THE
   * MEMBER KEY (`comparisonMemberKey(model, referenceTime)`, the ledger's
   * `member` field) since v2, for every member: v1 keyed this record by
   * the model slug, and the identity change to (model, referenceTime)
   * re-keys it wholesale — a deliberate breaking change, because two runs
   * of one model are two members and a model-slug key can hold only one.
   */
  analyses: Readonly<Record<string, WindgramAnalysis>>;
}

/* ------------------------------------------------------------ entry point */

/**
 * Compares one site's documents across models at the findings level.
 * Every profile must describe the same site (same `site.id`) — mixing
 * sites is a programming error and throws. Member identity is
 * `(model, referenceTime)` (v2): two runs of one model are two members,
 * each with its own ledger row, votes, and `analyses` entry; passing the
 * SAME run twice is a programming error and throws. Members are analyzed
 * here, with the comparison's single timeZone and threshold set, so votes
 * are apples-to-apples by construction.
 */
export function compareProfiles(
  profiles: ReadonlyArray<WindgramProfile>,
  options: CompareOptions,
): WindgramComparison {
  if (profiles.length === 0) throw new Error("compareProfiles: no members");
  const siteId = profiles[0].site.id;
  const seen = new Set<string>();
  for (const profile of profiles) {
    if (profile.site.id !== siteId) {
      throw new Error(
        `compareProfiles: mixed sites (${siteId} vs ${profile.site.id}) — one comparison, one site`,
      );
    }
    const key = comparisonMemberKey(profile.model, profile.run.referenceTime);
    if (seen.has(key)) {
      throw new Error(
        `compareProfiles: duplicate member (${key}) — a member is one (model, referenceTime) run; two runs of one model are two members, the same run twice is an error`,
      );
    }
    seen.add(key);
  }

  const thresholds = resolveAnalyzeThresholds(options.thresholds);
  const analyses: Record<string, WindgramAnalysis> = {};
  for (const profile of profiles) {
    analyses[comparisonMemberKey(profile.model, profile.run.referenceTime)] = analyzeProfile(
      profile,
      {
        timeZone: options.timeZone,
        launch: options.launch,
        thresholds: options.thresholds,
      },
    );
  }

  const newestReferenceTime = profiles
    .map((profile) => profile.run.referenceTime)
    .sort()
    .at(-1)!;
  const launch = options.launch?.elevationM ?? null;
  const members: ComparisonMemberLedger[] = profiles.map((profile) => {
    const member = comparisonMemberKey(profile.model, profile.run.referenceTime);
    const analysis = analyses[member];
    const terrain = analysis.findings.find(
      (finding) => finding.kind === "terrainMismatch",
    );
    return {
      member,
      model: profile.model,
      kind: isDeterministicProfile(profile) ? "deterministic" : "ensemble",
      referenceTime: profile.run.referenceTime,
      runAgeHours:
        (Date.parse(newestReferenceTime) - Date.parse(profile.run.referenceTime)) / 3_600_000,
      stepHours: analysis.stepHours,
      hours: analysis.hours,
      modelElevationM: profile.site.modelElevationM,
      launchAltitudeM: launch,
      elevationDeltaM: launch === null ? null : round1(profile.site.modelElevationM - launch),
      benched:
        terrain && !terrain.liftTopEverReachesLaunch
          ? { reason: "terrainMismatch", deltaM: terrain.deltaM }
          : null,
    };
  });
  const benched = new Set(
    members.filter((entry) => entry.benched !== null).map((entry) => entry.member),
  );

  /* Votes per local day, from the unbenched members' findings. */
  const byDay = new Map<
    LocalDayKey,
    {
      windows: WindowVote[];
      quiet: QuietVote[];
      abstained: Array<{ member: string; model: string; reason: "truncatedDay" }>;
    }
  >();
  const dayOf = (day: LocalDayKey) => {
    let entry = byDay.get(day);
    if (!entry) byDay.set(day, (entry = { windows: [], quiet: [], abstained: [] }));
    return entry;
  };
  for (const entry of members) {
    if (benched.has(entry.member)) continue;
    for (const finding of analyses[entry.member].findings) {
      if (finding.kind === "thermalWindow") {
        dayOf(finding.day).windows.push({
          member: entry.member,
          model: entry.model,
          start: finding.start,
          end: finding.end,
          clippedAtStart: finding.clippedAtStart,
          clippedAtEnd: finding.clippedAtEnd,
          durationHours: finding.durationHours,
          peakLiftTopAboveLaunchM: finding.peakLiftTopAboveLaunchM,
          peakLiftTopAt: finding.peakLiftTopAt,
          peakThermalVelocityMs: finding.peakThermalVelocityMs,
        });
      } else if (finding.kind === "quietDay") {
        if (finding.coverage.truncated) {
          dayOf(finding.day).abstained.push({
            member: entry.member,
            model: entry.model,
            reason: "truncatedDay",
          });
        } else {
          dayOf(finding.day).quiet.push({
            member: entry.member,
            model: entry.model,
            failed: finding.failed,
            peakThermalVelocityMs: finding.peakThermalVelocityMs,
            peakLiftDepthM: finding.peakLiftDepthM,
          });
        }
      }
    }
  }

  const findings: ComparisonFinding[] = [];
  for (const [day, votes] of [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const windowMembers = new Set(votes.windows.map((vote) => vote.member));
    const voters = windowMembers.size + votes.quiet.length;
    const firstWindows = new Map<string, WindowVote>();
    const lastWindows = new Map<string, WindowVote>();
    for (const vote of votes.windows) {
      const first = firstWindows.get(vote.member);
      if (!first || vote.start.validAt < first.start.validAt) firstWindows.set(vote.member, vote);
      const last = lastWindows.get(vote.member);
      if (!last || vote.end.validAt > last.end.validAt) lastWindows.set(vote.member, vote);
    }
    const starts = [...firstWindows.values()]
      .filter((vote) => !vote.clippedAtStart)
      .map((vote) => ({ member: vote.member, model: vote.model, at: vote.start }));
    const ends = [...lastWindows.values()]
      .filter((vote) => !vote.clippedAtEnd)
      .map((vote) => ({ member: vote.member, model: vote.model, at: vote.end }));
    findings.push({
      kind: "windowAgreement",
      day,
      windows: votes.windows,
      quiet: votes.quiet,
      abstained: votes.abstained,
      voters,
      unanimous: voters < 2 ? null : windowMembers.size === 0 || votes.quiet.length === 0,
      timing: {
        startSpreadHours: spreadHours(starts.map((entry) => entry.at)),
        endSpreadHours: spreadHours(ends.map((entry) => entry.at)),
        starts,
        ends,
      },
    });

    const peaks: Array<HeightSpreadFinding["peaks"][number]> = [];
    for (const [member] of firstWindows) {
      const best = votes.windows
        .filter((vote) => vote.member === member && vote.peakLiftTopAboveLaunchM !== null)
        .sort((a, b) => b.peakLiftTopAboveLaunchM! - a.peakLiftTopAboveLaunchM!)[0];
      if (best) {
        peaks.push({
          member,
          model: best.model,
          peakLiftTopAboveLaunchM: best.peakLiftTopAboveLaunchM!,
          at: best.peakLiftTopAt,
        });
      }
    }
    if (peaks.length >= 2) {
      const values = peaks.map((peak) => peak.peakLiftTopAboveLaunchM);
      findings.push({
        kind: "heightSpread",
        day,
        peaks,
        spreadM: round1(Math.max(...values) - Math.min(...values)),
      });
    }
  }

  return {
    vocabularyVersion: COMPARE_VOCABULARY_VERSION,
    site: { id: siteId, launchAltitudeM: launch },
    timeZone: options.timeZone,
    thresholds,
    newestReferenceTime,
    members,
    unavailable: options.unavailable ?? [],
    findings,
    analyses,
  };
}

/* Spread of instants in hours; null below two voters — a spread of one
   is not a statement. */
function spreadHours(instants: ReadonlyArray<CitedInstant>): number | null {
  if (instants.length < 2) return null;
  const times = instants.map((instant) => Date.parse(instant.validAt));
  return round1((Math.max(...times) - Math.min(...times)) / 3_600_000);
}

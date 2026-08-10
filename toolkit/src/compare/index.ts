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
     not get to call the day); a member whose horizon covers zero hours
     of a day abstains as `outOfHorizon` (v2 — "voters 3, unanimous
     true" must not read as consensus when seven members never reached
     the day); a window spanning local midnight votes on EVERY day its
     cited hours touch (v2 — before, it silenced the member on its
     second day); a horizon-clipped window edge leaves the timing
     envelope (it reads as >=/<=, not as timing). Documents the
     transport could not deliver enter the roster via
     options.unavailable, so the reader of a comparison sees the whole
     field, not just the survivors.
   - weighting is downstream: run age, cadence, grid kind are stated as
     ledger facts for the consumer's judgment, never applied as scores.

   THE VOCABULARY IS VERSIONED exactly like analyze/'s:
   COMPARE_VOCABULARY_VERSION names the kind set, and adding or changing
   a kind is a contract event — bump it and record the evidence. */

import { isDeterministicProfile, type WindgramProfile } from "../contract/index.js";
import { localDateKey } from "../derive/day-window.js";
import { componentsToWind, windToComponents } from "../derive/wind.js";
import {
  analyzeProfile,
  resolveAnalyzeThresholds,
  type AnalyzeThresholdOverrides,
  type AnalyzeThresholds,
  type CitedInstant,
  type LocalDayKey,
  type PercentileToken,
  type QuietDayFinding,
  type ThermalWindowFinding,
  type WindDirectionFinding,
  type WindgramAnalysis,
  type WindSummaryFinding,
} from "../analyze/index.js";
import { round1, round2 } from "../analyze/kinds/shared.js";

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
   reached the day) and the midnight-electorate fix (Tier 0 #3: a window
   spanning local midnight now votes on every day its cited hours touch,
   marked `viaWindowFrom`); zero-voter findings are suppressed only when
   a day has zero voters AND zero abstentions, so horizon-edge days keep
   their roster records. windDivergence lands from S3 with the mandatory
   elevation-regime echo (mean-wind ratios 0.18–1.22 at matched sites are
   grid-elevation regimes, not disagreement), gust spreads stay within
   one declared semantics class (measured gap ~1.8–2.8×), and shear rates
   never join a roster (not comparable across level densities).
   windDirectionSpread lands from S3, deterministic members only, with
   the max-separation pair's elevations riding the statement.
   heightSpread peaks gain the optional p10–p90 band as verdict-free
   context (S1 Q6: 57 of 61 outside peaks sit ABOVE the band — exceedance
   is the norm, never an outlier verdict); WindowVote carries the
   percentile test through as `minimalPassingPercentile`. */

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
   * structurally biased (the analyze terrainMismatch verdict). A benched
   * member appears in NO per-day roster — this ledger entry IS its
   * stated non-vote reason for every day.
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
  /**
   * The window finding's own cadence echo: the widest covered step among
   * its cited hours. Up to stepHours − 1 h of any timing difference
   * against this vote is quantization, not disagreement (Tier 0 #5).
   */
  stepHours: number;
  peakLiftTopAboveLaunchM: number | null;
  peakLiftTopAt: CitedInstant;
  peakThermalVelocityMs: number;
  /**
   * The member's same-day percentileCrossing token (the lowest published
   * percentile whose day verdict passes the thermalWindow floors). Null
   * means the member emitted NO crossing for this day — for deterministic
   * members always (they publish no percentiles), for ensemble members
   * because every percentile agreed with p50. Absence of a crossing, not
   * a confidence claim.
   */
  minimalPassingPercentile: PercentileToken | null;
  /**
   * Present only when this vote is counted onto a day other than the
   * window's own start day — the midnight-electorate fix (Tier 0 #3): a
   * window spanning local midnight votes on every day its cited hours
   * touch, and this field names the window's own day so the reader knows
   * the vote's numbers (duration, peaks) describe the whole window, not
   * just this day's slice.
   */
  viaWindowFrom?: LocalDayKey;
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
 * Why a member is absent from a day's voters: `truncatedDay` — its
 * document covers only a sliver of the day, so its quiet call is a data
 * boundary; `outOfHorizon` — its document covers ZERO hours of the day
 * (computed from the member's own cited hours, never from stepHours
 * arithmetic — live GEPS widens cadence mid-horizon). Benched members
 * appear in neither: the ledger's `benched` entry is their stated reason
 * for every day.
 */
export interface Abstention {
  member: string;
  model: string;
  reason: "truncatedDay" | "outOfHorizon";
}

/** One member's unclipped window edge in a day's timing envelope. */
export interface TimingVote {
  member: string;
  model: string;
  at: CitedInstant;
  /** The contributing window's cadence echo (see WindowVote.stepHours). */
  stepHours: number;
}

/**
 * Per local day: who says the day has a thermal window, who says quiet
 * (with the numbers that failed), who abstained and why — and the timing
 * envelope among the edges that are forecasts rather than data
 * boundaries. `unanimous` is arithmetic over the voters (all-window or
 * all-quiet); with fewer than two voters it is null, because unanimity
 * of one is not a statement. The finding is suppressed only when a day
 * has ZERO voters AND ZERO abstentions (the ratified v2 call): a
 * horizon-edge day whose roster is pure abstentions keeps its record,
 * because "nobody could call the day" is a statement with reasons.
 */
export interface WindowAgreementFinding {
  kind: "windowAgreement";
  day: LocalDayKey;
  windows: ReadonlyArray<WindowVote>;
  quiet: ReadonlyArray<QuietVote>;
  abstained: ReadonlyArray<Abstention>;
  voters: number;
  unanimous: boolean | null;
  /**
   * The smallest threshold move that would flip a voter, stated as the
   * flip VALUE — the voter's own peak nearest each floor (a quiet vote's
   * peak below it, a window vote's binding peak above it). Lowering
   * `wstarMinMs` to `wstarFlipAtMs` (resp. `depthMinM` to `depthFlipAtM`)
   * reaches the nearest miss; raising past it kills the nearest clear.
   * No search cutoff exists: the nearest value IS the statement, however
   * far. Null only when no voter offers the quantity. Caveat: for WINDOW
   * votes the flip is exact (a window dies when its binding peak falls
   * under the floor); for QUIET votes it is necessary, not sufficient —
   * the day peaks are per-quantity maxima at possibly different hours,
   * and a window additionally needs both floors met in the SAME hour
   * (the `coincidence` failure quietDay names).
   */
  sensitivity: {
    wstarFlipAtMs: number | null;
    depthFlipAtM: number | null;
  };
  /**
   * Start/end spreads among UNCLIPPED edges only (a clipped edge reads
   * as "open since at least" / "still open at"); null when fewer than
   * two members contribute an unclipped edge. An edge joins the day
   * whose local calendar date contains its instant — a midnight-spanning
   * window's start belongs to its start day and its end to the next day;
   * a member whose earliest window on a day began the previous day makes
   * no opening statement for that day (its flying is a continuation,
   * not an opening — same for closings, mirrored).
   *
   * CADENCE (Tier 0 #5): every contributing edge carries its window's
   * `stepHours`, and `startStepHoursMax` / `endStepHoursMax` state the
   * widest step among the contributors — up to that many minus one hours
   * of `startSpreadHours` / `endSpreadHours` is quantization, not
   * disagreement (a 3-hourly member's 11:00 edge means "somewhere in
   * 08:00–11:00"). Multi-hour members stay IN the spread — confession
   * over exclusion, because silently dropping them would shrink the
   * roster without a stated reason.
   */
  timing: {
    startSpreadHours: number | null;
    /** Widest stepHours among `starts`; null when `starts` is empty. */
    startStepHoursMax: number | null;
    endSpreadHours: number | null;
    /** Widest stepHours among `ends`; null when `ends` is empty. */
    endStepHoursMax: number | null;
    starts: ReadonlyArray<TimingVote>;
    ends: ReadonlyArray<TimingVote>;
  };
}

/**
 * Launch-relative peak lift per voting member, with the spread — the
 * divergence stated as a fact. Deliberately no mean, no median, no
 * consensus height: the spike measured spreads of 1,100–2,500 m among
 * comparable members, and an average of that is a forecast no model
 * made. Emitted for days where at least two unbenched members report a
 * launch-relative peak whose instant falls in the day.
 */
export interface HeightSpreadFinding {
  kind: "heightSpread";
  day: LocalDayKey;
  peaks: ReadonlyArray<{
    member: string;
    model: string;
    peakLiftTopAboveLaunchM: number;
    at: CitedInstant;
    /**
     * The ENSEMBLE member's own p10–p90 lift-top band at its peak hour,
     * launch-relative like the peak beside it (the window evidence's
     * absolute band minus the comparison launch); null for deterministic
     * members and where the evidence carries no band. VERDICT-FREE
     * CONTEXT ONLY — S1 Q6 (2026-08-10) measured 57 of 61 outside-band
     * deterministic peaks ABOVE the band: exceedance is the norm
     * (physics and vertical-resolution regimes), so "outside the band"
     * carries no verdict weight and this field must never be read as an
     * outlier detector.
     */
    bandP10P90AboveLaunchM: [number, number] | null;
  }>;
  spreadM: number;
}

/** One voting member's in-window climb-band wind maximum. */
export interface BandWindEntry {
  member: string;
  model: string;
  windMs: number;
  heightM: number;
  at: CitedInstant;
  /**
   * MANDATORY regime echo (S3, 2026-08-10): cross-model mean-wind ratios
   * spanned 0.18–1.22 at matched mountain sites — models grounding the
   * site hundreds of metres apart forecast different flow REGIMES, not
   * the same wind, and the roster is only readable with each member's
   * ground beside its number.
   */
  modelElevationM: number;
  /**
   * "duringWindow" when the member's same-day windSummary carries the
   * window-scoped block (the airborne hours — the consumer's question);
   * "wholeDay" only when the vote reached this day via a window keyed to
   * another day (`viaWindowFrom`), where no window-scoped block exists
   * for this day and the whole-day maximum is the honest fallback.
   */
  scope: "duringWindow" | "wholeDay";
}

/** One voting member's gust maximum, rostered within its semantics class. */
export interface GustEntry {
  member: string;
  model: string;
  gustMs: number;
  at: CitedInstant;
  /** Same mandatory regime echo as BandWindEntry.modelElevationM. */
  modelElevationM: number;
  scope: "duringWindow" | "wholeDay";
}

/**
 * Wind divergence among a day's WINDOW VOTERS: each member's in-window
 * climb-band wind maximum (its windSummary restated), with the spread —
 * wind is the most common flyability veto, and v1 could not express a
 * wind split at all. Emitted when at least two members roster a band
 * wind, or at least two share a declared gust semantics class.
 *
 * S3-measured constraints the shape encodes (2026-08-10):
 * - every entry carries `modelElevationM` — mean-wind ratios of
 *   0.18–1.22 at matched sites are grid-elevation REGIMES, and a spread
 *   read without the grounds beside it manufactures disagreement;
 * - gust rosters are grouped STRICTLY within one declared semantics
 *   class (`hourMax` vs `instant` measured a factor ~1.8–2.8 apart at
 *   matched light mountain means — never pooled); members without a
 *   declared gust semantics roster under `undeclared` as a record with
 *   deliberately NO spread — an undeclared gust cannot be compared with
 *   anything, including another undeclared gust;
 * - NO shear rates anywhere in compare: subsampling a dense model to a
 *   5-level ensemble grid read median 0.41× of the dense rate on
 *   identical hours — the rates are not comparable across level
 *   densities;
 * - NO directions here: direction comparison is windDirectionSpread's,
 *   deterministic members only, because ensemble p50s of raw degrees are
 *   not circular statistics.
 */
export interface WindDivergenceFinding {
  kind: "windDivergence";
  day: LocalDayKey;
  bandWind: {
    entries: ReadonlyArray<BandWindEntry>;
    /** max − min of the rostered windMs; null below two entries. */
    spreadMs: number | null;
  };
  gust: {
    hourMax: { entries: ReadonlyArray<GustEntry>; spreadMs: number | null };
    instant: { entries: ReadonlyArray<GustEntry>; spreadMs: number | null };
    /** Rostered, never spread — see the kind JSDoc. */
    undeclared: { entries: ReadonlyArray<GustEntry> };
  };
}

/**
 * Surface-flow direction split among a day's DETERMINISTIC window voters:
 * each member's window vector-mean surface direction (its windDirection
 * finding restated; the analyze kind's own hard gate keeps ensembles out
 * — published direction percentiles are not circular statistics), the
 * maximum pairwise angular separation, and the max-separation pair WITH
 * both members' model elevations — S3 measured that at flagpole 12 of 21
 * daytime max-separations straddled a >300 m model-ground delta: a
 * low-terrain member forecasting a different flow regime, not a
 * disagreement about the same flow. The regime caveat rides the
 * statement, never a footnote.
 *
 * All aggregation is vector math over derive/'s components (a member
 * with several windows on the day recombines their vector means weighted
 * by cited hours); raw degrees are never averaged. A member whose
 * recombined vector-mean speed sits under `directionFloorMs` has no
 * direction to roster and is absent — the calm convention, per-member.
 * Emitted when at least two members roster a direction.
 */
export interface WindDirectionSpreadFinding {
  kind: "windDirectionSpread";
  day: LocalDayKey;
  entries: ReadonlyArray<{
    member: string;
    model: string;
    directionDeg: number;
    speedMs: number;
    /** Same mandatory regime echo as windDivergence's rosters. */
    modelElevationM: number;
  }>;
  /** Max pairwise circular separation among the entries, 0–180°. */
  maxAngularSeparationDeg: number;
  /** The pair realizing the maximum, with the regime facts beside it. */
  maxSeparation: {
    members: [string, string];
    models: [string, string];
    modelElevationM: [number, number];
    elevationDeltaM: number;
  };
  thresholds: { directionFloorMs: number };
}

export type ComparisonFinding =
  | WindowAgreementFinding
  | HeightSpreadFinding
  | WindDivergenceFinding
  | WindDirectionSpreadFinding;
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
  const profileByMember = new Map<string, WindgramProfile>();
  for (const profile of profiles) {
    const key = comparisonMemberKey(profile.model, profile.run.referenceTime);
    profileByMember.set(key, profile);
    analyses[key] = analyzeProfile(profile, {
      timeZone: options.timeZone,
      launch: options.launch,
      thresholds: options.thresholds,
    });
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
  const ledgerByMember = new Map(members.map((entry) => [entry.member, entry]));
  const benched = new Set(
    members.filter((entry) => entry.benched !== null).map((entry) => entry.member),
  );

  /* The day universe and each member's covered days, from the documents'
     own cited hours — never stepHours arithmetic (live GEPS widens its
     cadence mid-horizon; the hours are the truth). Benched members'
     horizons still name days (the field's extent is a fact), but benched
     members join no roster: the ledger's benched entry is their reason. */
  const coveredDays = new Map<string, Set<LocalDayKey>>();
  const allDays = new Set<LocalDayKey>();
  for (const entry of members) {
    const days = new Set(
      profileByMember
        .get(entry.member)!
        .hours.map((hour) => localDateKey(hour.validAt, options.timeZone)),
    );
    coveredDays.set(entry.member, days);
    for (const day of days) allDays.add(day);
  }

  /* Per-member finding indexes the vote enrichments read from. */
  const at = (member: string, day: LocalDayKey) => `${member}|${day}`;
  const crossingTokens = new Map<string, PercentileToken | null>();
  const windowFindings = new Map<string, ThermalWindowFinding[]>();
  const summaries = new Map<string, WindSummaryFinding>();
  const directionFindings = new Map<string, WindDirectionFinding[]>();
  for (const entry of members) {
    if (benched.has(entry.member)) continue;
    for (const finding of analyses[entry.member].findings) {
      if (finding.kind === "percentileCrossing") {
        crossingTokens.set(at(entry.member, finding.day), finding.minimalPassingPercentile);
      } else if (finding.kind === "windSummary") {
        summaries.set(at(entry.member, finding.day), finding);
      } else if (finding.kind === "windDirection") {
        const bucket = directionFindings.get(at(entry.member, finding.day)) ?? [];
        bucket.push(finding);
        directionFindings.set(at(entry.member, finding.day), bucket);
      } else if (finding.kind === "thermalWindow") {
        const bucket = windowFindings.get(entry.member) ?? [];
        bucket.push(finding);
        windowFindings.set(entry.member, bucket);
      }
    }
  }

  /* Votes per local day, from the unbenched members' findings. */
  const byDay = new Map<
    LocalDayKey,
    { windows: WindowVote[]; quiet: QuietVote[]; abstained: Abstention[] }
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
        /* The midnight-electorate fix (Tier 0 #3): the window votes on
           EVERY local day its cited hours touch — exactly the days it
           suppresses quietDay on — so a member never falls silent on a
           day it forecast window hours in. Days beyond the window's own
           start day are marked viaWindowFrom. */
        const touched = [
          ...new Set(
            finding.evidence.hours.map((validAt) => localDateKey(validAt, options.timeZone)),
          ),
        ];
        for (const day of touched) {
          dayOf(day).windows.push({
            member: entry.member,
            model: entry.model,
            start: finding.start,
            end: finding.end,
            clippedAtStart: finding.clippedAtStart,
            clippedAtEnd: finding.clippedAtEnd,
            durationHours: finding.durationHours,
            stepHours: finding.stepHours,
            peakLiftTopAboveLaunchM: finding.peakLiftTopAboveLaunchM,
            peakLiftTopAt: finding.peakLiftTopAt,
            peakThermalVelocityMs: finding.peakThermalVelocityMs,
            minimalPassingPercentile: crossingTokens.get(at(entry.member, day)) ?? null,
            ...(day === finding.day ? {} : { viaWindowFrom: finding.day }),
          });
        }
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

  /* outOfHorizon abstentions (Tier 0 #4): every unbenched member whose
     horizon covers zero hours of a universe day enters that day's roster
     with its reason — "voters 3, unanimous true" must not read as
     consensus when the other members never reached the day. A member
     that covers ANY hour of a day always voted or abstained above
     (window coverage votes, everything else is a quietDay vote or a
     truncatedDay abstention), so zero coverage is the only silent case
     left. */
  for (const day of allDays) {
    const votes = dayOf(day);
    for (const entry of members) {
      if (benched.has(entry.member)) continue;
      if (!coveredDays.get(entry.member)!.has(day)) {
        votes.abstained.push({ member: entry.member, model: entry.model, reason: "outOfHorizon" });
      }
    }
  }

  const findings: ComparisonFinding[] = [];
  for (const [day, votes] of [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const windowMembers = new Set(votes.windows.map((vote) => vote.member));
    const voters = windowMembers.size + votes.quiet.length;
    /* The ratified zero-voter call: suppress only when a day has zero
       voters AND zero abstentions (nothing to state and nobody with a
       reason) — a pure-abstention day keeps its roster record. */
    if (voters === 0 && votes.abstained.length === 0) continue;

    const firstWindows = new Map<string, WindowVote>();
    const lastWindows = new Map<string, WindowVote>();
    for (const vote of votes.windows) {
      const first = firstWindows.get(vote.member);
      if (!first || vote.start.validAt < first.start.validAt) firstWindows.set(vote.member, vote);
      const last = lastWindows.get(vote.member);
      if (!last || vote.end.validAt > last.end.validAt) lastWindows.set(vote.member, vote);
    }
    /* An edge joins the day containing its instant (see the timing
       JSDoc): a midnight spanner's start stays with its start day, its
       end with the next day, and a member still airborne at midnight
       made no closing statement about the first day at all. */
    const starts: TimingVote[] = [...firstWindows.values()]
      .filter(
        (vote) =>
          !vote.clippedAtStart && localDateKey(vote.start.validAt, options.timeZone) === day,
      )
      .map((vote) => ({
        member: vote.member,
        model: vote.model,
        at: vote.start,
        stepHours: vote.stepHours,
      }));
    const ends: TimingVote[] = [...lastWindows.values()]
      .filter(
        (vote) => !vote.clippedAtEnd && localDateKey(vote.end.validAt, options.timeZone) === day,
      )
      .map((vote) => ({
        member: vote.member,
        model: vote.model,
        at: vote.end,
        stepHours: vote.stepHours,
      }));

    /* Sensitivity: each voter's own binding number against the shared
       floors; the nearest one is the statement (see the JSDoc). */
    const wstarCandidates = [
      ...votes.windows.map((vote) => vote.peakThermalVelocityMs),
      ...votes.quiet
        .map((vote) => vote.peakThermalVelocityMs)
        .filter((value): value is number => value !== null),
    ];
    const depthCandidates = [
      ...votes.windows
        .map((vote) => vote.peakLiftTopAboveLaunchM)
        .filter((value): value is number => value !== null),
      ...votes.quiet
        .map((vote) => vote.peakLiftDepthM)
        .filter((value): value is number => value !== null),
    ];

    findings.push({
      kind: "windowAgreement",
      day,
      windows: votes.windows,
      quiet: votes.quiet,
      abstained: votes.abstained,
      voters,
      unanimous: voters < 2 ? null : windowMembers.size === 0 || votes.quiet.length === 0,
      sensitivity: {
        wstarFlipAtMs: nearestTo(wstarCandidates, thresholds.thermalWindow.wstarMinMs),
        depthFlipAtM: nearestTo(depthCandidates, thresholds.thermalWindow.depthMinM),
      },
      timing: {
        startSpreadHours: spreadHours(starts.map((entry) => entry.at)),
        startStepHoursMax:
          starts.length === 0 ? null : Math.max(...starts.map((entry) => entry.stepHours)),
        endSpreadHours: spreadHours(ends.map((entry) => entry.at)),
        endStepHoursMax:
          ends.length === 0 ? null : Math.max(...ends.map((entry) => entry.stepHours)),
        starts,
        ends,
      },
    });

    /* heightSpread: per member, the best launch-relative peak whose
       instant falls in the day (a spanner's peak stays with the day it
       fires in). */
    const peaks: Array<HeightSpreadFinding["peaks"][number]> = [];
    for (const member of windowMembers) {
      const best = votes.windows
        .filter(
          (vote) =>
            vote.member === member &&
            vote.peakLiftTopAboveLaunchM !== null &&
            localDateKey(vote.peakLiftTopAt.validAt, options.timeZone) === day,
        )
        .sort((a, b) => b.peakLiftTopAboveLaunchM! - a.peakLiftTopAboveLaunchM!)[0];
      if (best) {
        peaks.push({
          member,
          model: best.model,
          peakLiftTopAboveLaunchM: best.peakLiftTopAboveLaunchM!,
          at: best.peakLiftTopAt,
          bandP10P90AboveLaunchM: bandAtPeak(
            windowFindings.get(member) ?? [],
            best,
            launch,
          ),
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

    /* windDivergence: the window voters' windSummary maxima, rostered. */
    const bandEntries: BandWindEntry[] = [];
    const gustRosters: Record<"hourMax" | "instant" | "undeclared", GustEntry[]> = {
      hourMax: [],
      instant: [],
      undeclared: [],
    };
    for (const member of windowMembers) {
      const summary = summaries.get(at(member, day));
      if (!summary) continue;
      const ledger = ledgerByMember.get(member)!;
      const scoped = summary.duringWindow;
      /* Prefer the window-scoped block wherever it exists; an absent
         quantity INSIDE it means "none in the window" and is not papered
         over with a whole-day number. Only a via-window day (no scoped
         block at all) falls back to the whole-day maxima, scope stated. */
      const band = scoped ? scoped.maxWindInBand : summary.maxWindInBand;
      const gust = scoped ? scoped.maxGust : summary.maxGust;
      const scope: BandWindEntry["scope"] = scoped ? "duringWindow" : "wholeDay";
      if (band) {
        bandEntries.push({
          member,
          model: ledger.model,
          windMs: band.windMs,
          heightM: band.heightM,
          at: band.at,
          modelElevationM: ledger.modelElevationM,
          scope,
        });
      }
      if (gust) {
        gustRosters[gust.semantics ?? "undeclared"].push({
          member,
          model: ledger.model,
          gustMs: gust.gustMs,
          at: gust.at,
          modelElevationM: ledger.modelElevationM,
          scope,
        });
      }
    }
    if (
      bandEntries.length >= 2 ||
      gustRosters.hourMax.length >= 2 ||
      gustRosters.instant.length >= 2
    ) {
      findings.push({
        kind: "windDivergence",
        day,
        bandWind: {
          entries: bandEntries,
          spreadMs: spreadOf(bandEntries.map((entry) => entry.windMs)),
        },
        gust: {
          hourMax: {
            entries: gustRosters.hourMax,
            spreadMs: spreadOf(gustRosters.hourMax.map((entry) => entry.gustMs)),
          },
          instant: {
            entries: gustRosters.instant,
            spreadMs: spreadOf(gustRosters.instant.map((entry) => entry.gustMs)),
          },
          undeclared: { entries: gustRosters.undeclared },
        },
      });
    }

    /* windDirectionSpread: deterministic voters' window vector means
       (the analyze kind's own gate keeps ensembles out — its findings
       simply never exist for them). */
    const directionEntries: WindDirectionSpreadFinding["entries"][number][] = [];
    const floor = thresholds.windDirection.directionFloorMs;
    for (const member of windowMembers) {
      const dayFindings = directionFindings.get(at(member, day)) ?? [];
      let uSum = 0;
      let vSum = 0;
      let weight = 0;
      for (const finding of dayFindings) {
        const mean = finding.surfaceVectorMean;
        if (mean.directionDeg === null) continue;
        const samples = finding.evidence.hours.length;
        const { uMs, vMs } = windToComponents(mean.speedMs, mean.directionDeg);
        uSum += uMs * samples;
        vSum += vMs * samples;
        weight += samples;
      }
      if (weight === 0) continue;
      const combined = componentsToWind(uSum / weight, vSum / weight);
      if (combined.speedMs < floor) continue;
      const ledger = ledgerByMember.get(member)!;
      directionEntries.push({
        member,
        model: ledger.model,
        directionDeg: Math.round(combined.directionDeg),
        speedMs: round2(combined.speedMs),
        modelElevationM: ledger.modelElevationM,
      });
    }
    if (directionEntries.length >= 2) {
      let bestA = directionEntries[0];
      let bestB = directionEntries[1];
      let maxSeparation = angularSeparationDeg(bestA.directionDeg, bestB.directionDeg);
      for (let i = 0; i < directionEntries.length; i += 1) {
        for (let j = i + 1; j < directionEntries.length; j += 1) {
          const separation = angularSeparationDeg(
            directionEntries[i].directionDeg,
            directionEntries[j].directionDeg,
          );
          if (separation > maxSeparation) {
            maxSeparation = separation;
            bestA = directionEntries[i];
            bestB = directionEntries[j];
          }
        }
      }
      findings.push({
        kind: "windDirectionSpread",
        day,
        entries: directionEntries,
        maxAngularSeparationDeg: maxSeparation,
        maxSeparation: {
          members: [bestA.member, bestB.member],
          models: [bestA.model, bestB.model],
          modelElevationM: [bestA.modelElevationM, bestB.modelElevationM],
          elevationDeltaM: round1(Math.abs(bestA.modelElevationM - bestB.modelElevationM)),
        },
        thresholds: { directionFloorMs: floor },
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

/* ----------------------------------------------------------------- helpers */

/* Spread of instants in hours; null below two voters — a spread of one
   is not a statement. */
function spreadHours(instants: ReadonlyArray<CitedInstant>): number | null {
  if (instants.length < 2) return null;
  const times = instants.map((instant) => Date.parse(instant.validAt));
  return round1((Math.max(...times) - Math.min(...times)) / 3_600_000);
}

/* max − min of a roster's magnitudes; null below two — same rule. */
function spreadOf(values: ReadonlyArray<number>): number | null {
  if (values.length < 2) return null;
  return round2(Math.max(...values) - Math.min(...values));
}

/* The candidate nearest the floor — the sensitivity statement's value.
   Ties break toward the smaller value for determinism; null when no
   voter offered the quantity. */
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

/* Circular separation between two bearings, 0–180°. */
function angularSeparationDeg(aDeg: number, bDeg: number): number {
  const delta = Math.abs(aDeg - bDeg) % 360;
  return delta > 180 ? 360 - delta : delta;
}

/* The ensemble member's own p10–p90 lift-top band at a vote's peak hour,
   launch-relative (see HeightSpreadFinding.peaks JSDoc — context only,
   S1 Q6). Deterministic windows carry no band evidence and read null. */
function bandAtPeak(
  windows: ReadonlyArray<ThermalWindowFinding>,
  vote: WindowVote,
  launch: number | null,
): [number, number] | null {
  if (launch === null) return null;
  const finding = windows.find(
    (candidate) =>
      candidate.start.validAt === vote.start.validAt &&
      candidate.end.validAt === vote.end.validAt,
  );
  if (!finding || !finding.evidence.liftTopBandP10P90) return null;
  const index = finding.evidence.hours.indexOf(vote.peakLiftTopAt.validAt);
  if (index < 0) return null;
  const band = finding.evidence.liftTopBandP10P90[index];
  if (band === null) return null;
  return [round1(band[0] - launch), round1(band[1] - launch)];
}

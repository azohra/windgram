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

   SINGLE-DOCUMENT BY CHARTER, not by accident: every finding kind below
   survived the 2026-08-08 evidence spikes as a single-document statement.
   The cross-document statement kinds trialled beside them (consensus,
   outliers) were killed by staleness, elevation, and semantics artifacts —
   models at one site differ in modelElevationM, gust semantics (hourMax vs
   instant, ~20-30 % apart systematically), run age, and step cadence, so a
   naive cross-model claim is wrong in exactly the ways the catalogue exists
   to prevent. The name `compare` is RESERVED for a future sibling subpath
   (statements over aligned collections, sitting on derive's alignByValidAt)
   and must not be occupied until a cross-document statement kind survives
   evidence the way terrainMismatch did. Do not backfill it casually.

   THE VOCABULARY IS VERSIONED the way models.json capabilities are treated:
   `ANALYZE_VOCABULARY_VERSION` names the finding-kind set, consumers switch
   on `kind`, and ADDING (or changing) A KIND IS A CONTRACT EVENT — bump the
   version, document the evidence that earned the kind its place, and treat
   removal like retiring a capability. Version 1 ships EXACTLY the kinds
   that survived the spikes; kinds that were trialled and did not survive
   (hazard, barrier, confidence, consensus, outliers) are deliberately
   absent, not merely unimplemented.

   THE DISCIPLINE every kind obeys:
   - magnitudes and timing, never judgment words; verdict enums appear ONLY
     where the verdict is an arithmetic relation over published numbers
     (max lift top < launch altitude; |CIN| under a stated bound while CAPE
     exceeds a stated bound);
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
   - altitudes are launch-relative where a launch altitude exists
     (`peakLiftTopAboveLaunchM`), because MSL numbers mean nothing to a
     pilot standing on the hill;
   - ensemble documents are read at p50 with the p10-p90 band carried into
     evidence where the claim leans on it; per-position member counts are a
     first-class finding (`ensembleMembership`), because a p50 computed from
     0-of-21 contributing members is a landmine, not a median.

   What flyableWindow and liftCeiling are for: they RESTATE the published
   derived series — deliberately. Their value is compression (a 13-72k-token
   document down to a ~1-2k statement of when and how high) and the timing
   anchor the other findings reference; they add no information a consumer
   reading every hour would miss. */

import {
  isDeterministicProfile,
  isEnsembleValue,
  type EnsembleValue,
  type Scalar,
  type WindgramHour,
  type WindgramProfile,
} from "../contract/index.js";
import { localDateKey } from "../derive/day-window.js";

/**
 * The finding-kind set this module can emit. Versioned like models.json
 * capabilities: consumers switch on `kind`, so adding, renaming, or removing
 * a kind is a contract event — bump this, and document the evidence that
 * justified the change (see the module charter above).
 */
export const ANALYZE_VOCABULARY_VERSION = 1;

/* ------------------------------------------------------------- vocabulary */

/** An instant a finding cites: the document's own UTC `validAt` (so the
 * claim joins back to the published hour) plus its local clock reading
 * ("2026-08-08T11:00") in the analysis timezone. */
export interface CitedInstant {
  validAt: string;
  local: string;
}

/**
 * The model's grid terrain sits far from the surveyed launch, so every
 * altitude-referenced series in the document is structurally biased — the
 * spike's motivating case is GEPS at Flagpole, which models the site at
 * 144 m though launch is 1222 m, so its usable-lift top never reaches
 * launch. Invisible on a chart; only the metadata says it. The one verdict,
 * `liftTopEverReachesLaunch`, is pure arithmetic: max published lift top
 * vs launch altitude. Emitted only when the document knows its launch
 * altitude and |delta| is at least `thresholds.minAbsDeltaM`.
 */
export interface TerrainMismatchFinding {
  kind: "terrainMismatch";
  modelElevationM: number;
  siteAltitudeM: number;
  /** modelElevationM − siteAltitudeM; negative = model terrain below launch. */
  deltaM: number;
  /** Arithmetic verdict: does any hour's published lift top exceed launch? */
  liftTopEverReachesLaunch: boolean;
  thresholds: { minAbsDeltaM: number };
  evidence: {
    maxUsableLiftTopM: number | null;
    maxUsableLiftTopAt: CitedInstant | null;
  };
}

/** One entry in the dataCaveats honesty layer — all threshold-free. */
export type DataCaveat =
  | {
      /** Quantity families never published in this document — per the
       * contract, absence means "not published", never zero. */
      caveat: "absentQuantities";
      quantities: string[];
    }
  | {
      /** Hours where a derived nullable series is null — a real forecast of
       * "none" (no usable lift, no buoyant parcel), not a gap. */
      caveat: "derivedNullHours";
      quantity: "usableLiftTopM" | "boundaryLayerTopM";
      hoursNull: number;
      ofHours: number;
    }
  | {
      /** Multi-hour steps: timing finer than the cadence (window edges,
       * onset times) is interpolation, not forecast. */
      caveat: "stepCadence";
      stepHours: number;
    }
  | {
      /** The document declares no site.timeZone and no override was given,
       * so every local field in this analysis reads in UTC. */
      caveat: "timesAreUtc";
    };

/**
 * What this document cannot say: quantity families it never publishes,
 * derived-null hours, cadence-interpolation notes. Threshold-free by
 * definition — these are declarations, not judgments.
 */
export interface DataCaveatsFinding {
  kind: "dataCaveats";
  caveats: DataCaveat[];
}

/**
 * The membership honesty layer for ensemble documents. `membership` is the
 * per-quantity member-count profile — the "0-of-21 p50" landmine the spike
 * surfaced on GEPS CAPE, where percentile blocks over an hour can be
 * computed from far fewer than the run's declared members (nulls are
 * excluded, not ranked at zero). `bands` states the p10-p90 band-width
 * magnitude and its trend across the horizon for the derived series. No
 * confidence verdicts: the band is member spread, not a confidence
 * interval, and this module does not use the word.
 */
export interface EnsembleMembershipFinding {
  kind: "ensembleMembership";
  /** run.members where declared; otherwise the max per-position count seen. */
  declaredMembers: number;
  membership: Array<{
    quantity: string;
    minMembers: number;
    hoursBelowFull: number;
    ofHours: number;
    evidence: { examples: Array<{ validAt: string; members: number }> };
  }>;
  bands: Array<{
    series: "usableLiftTopM" | "thermalVelocityMs";
    hoursWithSignal: number;
    medianBandWidth: number;
    maxRelativeSpread: number | null;
    maxSpreadAt: CitedInstant | null;
    /** Arithmetic trend: widening when the last band width exceeds the
     * first by `thresholds.wideningRatio`, else steady. */
    trend: "widening" | "steady";
    thresholds: { wideningRatio: number };
    evidence: { hours: string[]; p50: number[]; bandWidth: number[] };
  }>;
}

/**
 * The overdevelopment-timing story per local day: CAPE build vs CIN erosion
 * vs the flyable window's close. GATED to hourly deterministic documents
 * that publish CIN: the spike found ensemble-median CIN bimodal (a p50 over
 * members half of whom have broken the cap says neither thing), and
 * 3-hourly cadence makes "when the cap breaks" interpolation rather than
 * forecast — so ensembles and multi-hour steps emit nothing here.
 * Verdicts are arithmetic relations over the embedded thresholds:
 * `noInstability` (peak CAPE under `instabilityMinCapeJkg`), `capBreaks`
 * (some hour has |CIN| < `brokenCapMaxAbsCinJkg` while CAPE >
 * `brokenCapMinCapeJkg`), `cappedAllDay` (instability without such an hour).
 */
export interface CapTimingFinding {
  kind: "capTiming";
  day: string;
  verdict: "capBreaks" | "cappedAllDay" | "noInstability";
  peakCapeJkg: number;
  peakCapeAt: CitedInstant | null;
  capBreaksAt?: CitedInstant;
  capeAtBreakJkg?: number;
  /** First hour precipitation exceeds thresholds.precipMinMmHr — the
   * overdevelopment confirmation, when the model forecasts one. */
  precipStartsAt?: CitedInstant;
  peakPrecipMmHr?: number;
  /** The same-day flyableWindow's end — the timing anchor the cap story is
   * read against. Present when that finding exists for this day. */
  flyableWindowEndsAt?: CitedInstant;
  thresholds: {
    instabilityMinCapeJkg: number;
    brokenCapMaxAbsCinJkg: number;
    brokenCapMinCapeJkg: number;
    precipMinMmHr: number;
  };
  evidence: { hours: string[]; capeJkg: number[]; cinJkg: number[] };
}

/**
 * Consecutive hours whose published usable-lift top stands at least
 * `depthMinM` above launch while W* is at least `wstarMinMs` — a
 * COMPRESSION ANCHOR that deliberately restates the published derived
 * series (see the module charter). The default thresholds are the spike's,
 * whose 3×3 sensitivity sweep (W* 0.7/0.9/1.1 × depth 150/300/500 m)
 * measured low sensitivity on real profiles; both are embedded and
 * caller-movable, because "flyable" beyond this arithmetic is pilot, wing,
 * and site judgment that belongs downstream. Launch reference is
 * site.altitudeM, falling back to modelElevationM when the launch is
 * unsurveyed (and then `peakLiftTopAboveLaunchM` is null rather than a
 * number relative to the wrong ground).
 */
export interface FlyableWindowFinding {
  kind: "flyableWindow";
  day: string;
  start: CitedInstant;
  end: CitedInstant;
  durationHours: number;
  peakLiftTopM: number;
  peakLiftTopAt: CitedInstant;
  /** Launch-relative peak; null when site.altitudeM is unknown. */
  peakLiftTopAboveLaunchM: number | null;
  peakThermalVelocityMs: number;
  thresholds: { wstarMinMs: number; depthMinM: number };
  evidence: {
    hours: string[];
    usableLiftTopM: number[];
    thermalVelocityMs: number[];
    /** p10-p90 lift-top band per cited hour; ensemble documents only. */
    liftTopBandP10P90?: Array<[number, number] | null>;
  };
}

/**
 * Within each flyable window: is the top of the climb set by cloud base or
 * by updraft decay? The cause is an arithmetic relation — `cloudCapped`
 * when the published cloud base sits within `cloudCapMarginM` of (or
 * below) the lift top, else `sinkLimited` — segmented into runs with the
 * flip count stated. Like flyableWindow, a compression anchor restating
 * published series.
 */
export interface LiftCeilingFinding {
  kind: "liftCeiling";
  day: string;
  segments: Array<{
    cause: "cloudCapped" | "sinkLimited";
    start: CitedInstant;
    end: CitedInstant;
    hoursN: number;
    evidence: {
      usableLiftTopM: number;
      cloudBaseM: number;
      boundaryLayerTopM: number | null;
    };
  }>;
  flips: number;
  thresholds: { cloudCapMarginM: number };
}

/**
 * Wind magnitudes and timing per local day: the strongest surface gust (and
 * which gust semantics the document declares for it), and the strongest
 * wind at any level inside the climb band — launch to lift top, padded by
 * `bandMarginM` — with its altitude and persistence (consecutive hours
 * around the peak whose band maximum stays within
 * `persistenceFractionOfMax` of it).
 *
 * DELIBERATELY NO hazard or barrier verdicts. The 2026-08-08 evidence spike
 * ran gust-hazard and wind-aloft-barrier extractors over four sites × five
 * models and the verdicts did not survive: the gust-factor branch flagged
 * noise (a "hazardous" 6.5 m/s gust over a 1.6 m/s mean), the barrier
 * verdicts restated magnitudes already visible in the rows, and "hazard"
 * from a data package is a safety judgment that is pilot-, wing-, and
 * site-dependent — downstream's call, made from the magnitudes this finding
 * states.
 */
export interface WindSummaryFinding {
  kind: "windSummary";
  day: string;
  maxGust?: {
    gustMs: number;
    meanWindMs: number | null;
    at: CitedInstant;
    /** The document's own semantics.gust echo — hourMax reads ~20-30 %
     * higher than instant, systematically. */
    semantics?: "hourMax" | "instant";
  };
  maxWindInBand?: {
    windMs: number;
    directionDeg: number | null;
    heightM: number;
    pressureHpa: number;
    at: CitedInstant;
    persistenceHours: number;
  };
  thresholds: { bandMarginM: number; persistenceFractionOfMax: number };
}

export type WindgramFinding =
  | TerrainMismatchFinding
  | DataCaveatsFinding
  | EnsembleMembershipFinding
  | CapTimingFinding
  | FlyableWindowFinding
  | LiftCeilingFinding
  | WindSummaryFinding;

export type FindingKind = WindgramFinding["kind"];

/* -------------------------------------------------------------- thresholds */

export interface AnalyzeThresholds {
  flyableWindow: { wstarMinMs: number; depthMinM: number };
  liftCeiling: { cloudCapMarginM: number };
  capTiming: {
    instabilityMinCapeJkg: number;
    brokenCapMaxAbsCinJkg: number;
    brokenCapMinCapeJkg: number;
    precipMinMmHr: number;
  };
  terrainMismatch: { minAbsDeltaM: number };
  windSummary: { bandMarginM: number; persistenceFractionOfMax: number };
  ensembleMembership: { wideningRatio: number };
}

/**
 * The spike's constants, embedded in every finding they shaped. The
 * flyableWindow pair carried a measured sensitivity sweep (see its JSDoc);
 * the rest are the values the spike's outputs were audited under. All are
 * caller-movable per call — they are conventions, not physics.
 */
export const DEFAULT_ANALYZE_THRESHOLDS: AnalyzeThresholds = {
  flyableWindow: { wstarMinMs: 0.9, depthMinM: 300 },
  liftCeiling: { cloudCapMarginM: 50 },
  capTiming: {
    instabilityMinCapeJkg: 100,
    brokenCapMaxAbsCinJkg: 25,
    brokenCapMinCapeJkg: 200,
    precipMinMmHr: 0.2,
  },
  terrainMismatch: { minAbsDeltaM: 250 },
  windSummary: { bandMarginM: 200, persistenceFractionOfMax: 0.8 },
  ensembleMembership: { wideningRatio: 1.5 },
};

export interface AnalyzeOptions {
  /**
   * IANA timezone for every local field. Defaults to the document's own
   * `site.timeZone`; when neither exists the analysis reads in UTC and says
   * so with a `timesAreUtc` caveat.
   */
  timeZone?: string;
  /** Per-kind threshold overrides, merged over the defaults per kind. */
  thresholds?: Partial<AnalyzeThresholds>;
}

/* ---------------------------------------------------------------- envelope */

export interface WindgramAnalysis {
  vocabularyVersion: typeof ANALYZE_VOCABULARY_VERSION;
  model: string;
  site: { id: string; launchAltitudeM: number | null; modelElevationM: number };
  run: { referenceTime: string };
  /** The timezone every local field below reads in. */
  timeZone: string;
  timeZoneSource: "document" | "override" | "utcFallback";
  stepHours: number;
  hours: number;
  findings: WindgramFinding[];
}

/* ------------------------------------------------------------ entry point */

/**
 * Extracts version-1 vocabulary findings from one profile document.
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
  const context: Context = {
    profile,
    timeZone,
    deterministic: isDeterministicProfile(profile),
    stepHours: stepHoursOf(profile),
    launchReferenceM: profile.site.altitudeM ?? profile.site.modelElevationM,
    cite: citedInstantFactory(timeZone),
    thresholds,
  };

  const windows = findFlyableWindows(context);
  const findings: WindgramFinding[] = [
    ...findTerrainMismatch(context),
    ...windows,
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
      launchAltitudeM: profile.site.altitudeM,
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

interface Context {
  profile: WindgramProfile;
  timeZone: string;
  deterministic: boolean;
  stepHours: number;
  launchReferenceM: number;
  cite: (validAt: string) => CitedInstant;
  thresholds: AnalyzeThresholds;
}

function mergeThresholds(overrides?: Partial<AnalyzeThresholds>): AnalyzeThresholds {
  if (!overrides) return DEFAULT_ANALYZE_THRESHOLDS;
  return {
    flyableWindow: { ...DEFAULT_ANALYZE_THRESHOLDS.flyableWindow, ...overrides.flyableWindow },
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

/** p50 for ensemble blocks, identity for numbers, null through. Local to
 * this module so findings never import renderer machinery. */
function median(value: Scalar | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return isEnsembleValue(value) ? value.p50 : value;
}

function band(value: Scalar | null | undefined): [number, number] | null {
  if (value !== null && value !== undefined && isEnsembleValue(value)) {
    return [value.p10, value.p90];
  }
  return null;
}

function stepHoursOf(profile: WindgramProfile): number {
  if (profile.hours.length < 2) return 1;
  const first = Date.parse(profile.hours[0].validAt);
  const second = Date.parse(profile.hours[1].validAt);
  return Math.max(1, Math.round((second - first) / 3_600_000));
}

const localClockFormatters = new Map<string, Intl.DateTimeFormat>();

function citedInstantFactory(timeZone: string): (validAt: string) => CitedInstant {
  let formatter = localClockFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
    });
    localClockFormatters.set(timeZone, formatter);
  }
  const format = formatter;
  return (validAt: string) => {
    const parts = Object.fromEntries(
      format.formatToParts(new Date(validAt)).map(({ type, value }) => [type, value]),
    );
    return {
      validAt,
      local: `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"]}:${parts["minute"]}`,
    };
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/* ---------------------------------------------------------------- findings */

function findTerrainMismatch(context: Context): TerrainMismatchFinding[] {
  const { profile, thresholds } = context;
  const launch = profile.site.altitudeM;
  if (launch === null) return [];
  const delta = profile.site.modelElevationM - launch;
  if (Math.abs(delta) < thresholds.terrainMismatch.minAbsDeltaM) return [];

  let maxTop: number | null = null;
  let maxTopAt: CitedInstant | null = null;
  for (const hour of profile.hours) {
    const top = median(hour.derived.usableLiftTopM);
    if (top !== null && (maxTop === null || top > maxTop)) {
      maxTop = top;
      maxTopAt = context.cite(hour.validAt);
    }
  }
  return [
    {
      kind: "terrainMismatch",
      modelElevationM: profile.site.modelElevationM,
      siteAltitudeM: launch,
      deltaM: round1(delta),
      liftTopEverReachesLaunch: maxTop !== null && maxTop > launch,
      thresholds: { ...thresholds.terrainMismatch },
      evidence: {
        maxUsableLiftTopM: maxTop === null ? null : round1(maxTop),
        maxUsableLiftTopAt: maxTopAt,
      },
    },
  ];
}

function findFlyableWindows(context: Context): FlyableWindowFinding[] {
  const { profile, launchReferenceM, thresholds, stepHours } = context;
  const { wstarMinMs, depthMinM } = thresholds.flyableWindow;
  const launchKnown = profile.site.altitudeM !== null;
  const ensemble = !context.deterministic;

  const flyable = (hour: WindgramHour): boolean => {
    const top = median(hour.derived.usableLiftTopM);
    const wstar = median(hour.derived.thermalVelocityMs);
    return (
      top !== null && wstar !== null && wstar >= wstarMinMs && top - launchReferenceM >= depthMinM
    );
  };

  const findings: FlyableWindowFinding[] = [];
  let index = 0;
  while (index < profile.hours.length) {
    if (!flyable(profile.hours[index])) {
      index += 1;
      continue;
    }
    let last = index;
    while (last + 1 < profile.hours.length && flyable(profile.hours[last + 1])) last += 1;

    const hours = profile.hours.slice(index, last + 1);
    const tops = hours.map((hour) => median(hour.derived.usableLiftTopM)!);
    const wstars = hours.map((hour) => median(hour.derived.thermalVelocityMs)!);
    const peakIndex = tops.indexOf(Math.max(...tops));
    const peakHour = hours[peakIndex];
    const peakTop = tops[peakIndex];

    const finding: FlyableWindowFinding = {
      kind: "flyableWindow",
      day: localDateKey(hours[0].validAt, context.timeZone),
      start: context.cite(hours[0].validAt),
      end: context.cite(hours[hours.length - 1].validAt),
      durationHours: hours.length * stepHours,
      peakLiftTopM: round1(peakTop),
      peakLiftTopAt: context.cite(peakHour.validAt),
      peakLiftTopAboveLaunchM: launchKnown ? round1(peakTop - launchReferenceM) : null,
      peakThermalVelocityMs: round1(Math.max(...wstars)),
      thresholds: { wstarMinMs, depthMinM },
      evidence: {
        hours: hours.map((hour) => hour.validAt),
        usableLiftTopM: tops.map(round1),
        thermalVelocityMs: wstars.map(round1),
      },
    };
    if (ensemble) {
      finding.evidence.liftTopBandP10P90 = hours.map((hour) => {
        const range = band(hour.derived.usableLiftTopM);
        return range === null ? null : [round1(range[0]), round1(range[1])];
      });
    }
    findings.push(finding);
    index = last + 1;
  }
  return findings;
}

function findLiftCeilings(
  context: Context,
  windows: FlyableWindowFinding[],
): LiftCeilingFinding[] {
  const { profile, thresholds } = context;
  const margin = thresholds.liftCeiling.cloudCapMarginM;
  const hoursByValidAt = new Map(profile.hours.map((hour) => [hour.validAt, hour]));

  const findings: LiftCeilingFinding[] = [];
  for (const window of windows) {
    const segments: LiftCeilingFinding["segments"] = [];
    for (const validAt of window.evidence.hours) {
      const hour = hoursByValidAt.get(validAt)!;
      const top = median(hour.derived.usableLiftTopM);
      const cloudBase = median(hour.derived.cloudBaseM);
      if (top === null || cloudBase === null) continue;
      const cause: "cloudCapped" | "sinkLimited" =
        cloudBase <= top + margin ? "cloudCapped" : "sinkLimited";
      const previous = segments[segments.length - 1];
      if (previous && previous.cause === cause) {
        previous.end = context.cite(validAt);
        previous.hoursN += 1;
      } else {
        const boundaryLayerTop = median(hour.derived.boundaryLayerTopM);
        segments.push({
          cause,
          start: context.cite(validAt),
          end: context.cite(validAt),
          hoursN: 1,
          evidence: {
            usableLiftTopM: round1(top),
            cloudBaseM: round1(cloudBase),
            boundaryLayerTopM: boundaryLayerTop === null ? null : round1(boundaryLayerTop),
          },
        });
      }
    }
    if (segments.length > 0) {
      findings.push({
        kind: "liftCeiling",
        day: window.day,
        segments,
        flips: segments.length - 1,
        thresholds: { cloudCapMarginM: margin },
      });
    }
  }
  return findings;
}

function findCapTiming(context: Context, windows: FlyableWindowFinding[]): CapTimingFinding[] {
  const { profile, thresholds, stepHours } = context;
  // The gate (see the kind's JSDoc): hourly deterministic with CIN only.
  if (!context.deterministic || stepHours !== 1) return [];
  const rows = profile.hours
    .map((hour) => ({
      hour,
      cape: median(hour.surface.capeJkg),
      cin: median(hour.surface.cinJkg),
    }))
    .filter((row): row is typeof row & { cape: number; cin: number } =>
      row.cape !== null && row.cin !== null,
    );
  if (rows.length === 0) return [];

  const limits = thresholds.capTiming;
  const byDay = new Map<string, typeof rows>();
  for (const row of rows) {
    const day = localDateKey(row.hour.validAt, context.timeZone);
    const bucket = byDay.get(day) ?? [];
    bucket.push(row);
    byDay.set(day, bucket);
  }
  const windowEndByDay = new Map(windows.map((window) => [window.day, window.end]));

  const findings: CapTimingFinding[] = [];
  for (const [day, dayRows] of byDay) {
    const peak = dayRows.reduce((best, row) => (row.cape > best.cape ? row : best));
    const evidence = {
      hours: dayRows.map((row) => row.hour.validAt),
      capeJkg: dayRows.map((row) => Math.round(row.cape)),
      cinJkg: dayRows.map((row) => Math.round(row.cin)),
    };
    const shared = {
      thresholds: { ...limits },
      evidence,
      ...(windowEndByDay.has(day) ? { flyableWindowEndsAt: windowEndByDay.get(day)! } : {}),
    };

    if (peak.cape < limits.instabilityMinCapeJkg) {
      findings.push({
        kind: "capTiming",
        day,
        verdict: "noInstability",
        peakCapeJkg: Math.round(peak.cape),
        peakCapeAt: peak.cape > 0 ? context.cite(peak.hour.validAt) : null,
        ...shared,
      });
      continue;
    }

    const broken = dayRows.find(
      (row) => Math.abs(row.cin) < limits.brokenCapMaxAbsCinJkg && row.cape > limits.brokenCapMinCapeJkg,
    );
    const finding: CapTimingFinding = {
      kind: "capTiming",
      day,
      verdict: broken ? "capBreaks" : "cappedAllDay",
      peakCapeJkg: Math.round(peak.cape),
      peakCapeAt: context.cite(peak.hour.validAt),
      ...shared,
    };
    if (broken) {
      finding.capBreaksAt = context.cite(broken.hour.validAt);
      finding.capeAtBreakJkg = Math.round(broken.cape);
    }
    const wet = dayRows
      .map((row) => ({ row, rate: median(row.hour.surface.precipitationMmHr) }))
      .filter((entry): entry is { row: (typeof dayRows)[number]; rate: number } =>
        entry.rate !== null && entry.rate > limits.precipMinMmHr,
      );
    if (wet.length > 0) {
      finding.precipStartsAt = context.cite(wet[0].row.hour.validAt);
      finding.peakPrecipMmHr = round1(Math.max(...wet.map((entry) => entry.rate)));
    }
    findings.push(finding);
  }
  return findings;
}

function findWindSummaries(context: Context): WindSummaryFinding[] {
  const { profile, thresholds, launchReferenceM } = context;
  const { bandMarginM, persistenceFractionOfMax } = thresholds.windSummary;

  const byDay = new Map<string, WindgramHour[]>();
  for (const hour of profile.hours) {
    const day = localDateKey(hour.validAt, context.timeZone);
    const bucket = byDay.get(day) ?? [];
    bucket.push(hour);
    byDay.set(day, bucket);
  }

  const bandMax = (
    hour: WindgramHour,
  ): { windMs: number; directionDeg: number | null; heightM: number; pressureHpa: number } | null => {
    const top = median(hour.derived.usableLiftTopM);
    if (top === null) return null;
    let best: ReturnType<typeof bandMax> = null;
    for (const level of hour.levels) {
      const heightM = median(level.heightM);
      const windMs = median(level.windSpeedMs);
      if (heightM === null || windMs === null) continue;
      if (heightM < launchReferenceM - bandMarginM || heightM > top + bandMarginM) continue;
      if (best === null || windMs > best.windMs) {
        best = {
          windMs,
          directionDeg: median(level.windDirectionDeg),
          heightM,
          pressureHpa: median(level.pressureHpa) ?? Number.NaN,
        };
      }
    }
    return best;
  };

  const findings: WindSummaryFinding[] = [];
  for (const [day, hours] of byDay) {
    const finding: WindSummaryFinding = {
      kind: "windSummary",
      day,
      thresholds: { bandMarginM, persistenceFractionOfMax },
    };

    let gustAt: WindgramHour | null = null;
    let gust = -Infinity;
    for (const hour of hours) {
      const value = median(hour.surface.windGustMs);
      if (value !== null && value > gust) {
        gust = value;
        gustAt = hour;
      }
    }
    if (gustAt !== null) {
      const mean = median(gustAt.surface.windSpeedMs);
      finding.maxGust = {
        gustMs: round1(gust),
        meanWindMs: mean === null ? null : round1(mean),
        at: context.cite(gustAt.validAt),
        ...(profile.semantics?.gust ? { semantics: profile.semantics.gust } : {}),
      };
    }

    const bandMaxima = hours.map((hour) => ({ hour, max: bandMax(hour) }));
    const withBand = bandMaxima.filter(
      (entry): entry is { hour: WindgramHour; max: NonNullable<ReturnType<typeof bandMax>> } =>
        entry.max !== null,
    );
    if (withBand.length > 0) {
      const peakEntry = withBand.reduce((best, entry) =>
        entry.max.windMs > best.max.windMs ? entry : best,
      );
      const peakIndex = bandMaxima.findIndex((entry) => entry === peakEntry);
      const floor = peakEntry.max.windMs * persistenceFractionOfMax;
      let persistence = 1;
      for (let i = peakIndex - 1; i >= 0 && (bandMaxima[i].max?.windMs ?? -1) >= floor; i -= 1) {
        persistence += 1;
      }
      for (
        let i = peakIndex + 1;
        i < bandMaxima.length && (bandMaxima[i].max?.windMs ?? -1) >= floor;
        i += 1
      ) {
        persistence += 1;
      }
      finding.maxWindInBand = {
        windMs: round1(peakEntry.max.windMs),
        directionDeg:
          peakEntry.max.directionDeg === null ? null : Math.round(peakEntry.max.directionDeg),
        heightM: round1(peakEntry.max.heightM),
        pressureHpa: peakEntry.max.pressureHpa,
        at: context.cite(peakEntry.hour.validAt),
        persistenceHours: persistence * context.stepHours,
      };
    }

    if (finding.maxGust || finding.maxWindInBand) findings.push(finding);
  }
  return findings;
}

function findEnsembleMembership(context: Context): EnsembleMembershipFinding[] {
  const { profile, thresholds } = context;
  if (context.deterministic) return [];

  // Per-quantity member-count profile over the surface and derived blocks.
  let observedMax = 0;
  const perQuantity = new Map<string, Array<{ validAt: string; members: number }>>();
  const record = (quantity: string, validAt: string, value: Scalar | null | undefined) => {
    if (value === null || value === undefined || !isEnsembleValue(value)) return;
    observedMax = Math.max(observedMax, value.members);
    const rows = perQuantity.get(quantity) ?? [];
    rows.push({ validAt, members: value.members });
    perQuantity.set(quantity, rows);
  };
  for (const hour of profile.hours) {
    for (const [key, value] of Object.entries(hour.surface)) record(key, hour.validAt, value);
    for (const [key, value] of Object.entries(hour.derived)) record(key, hour.validAt, value);
  }
  const declaredMembers = profile.run.members ?? observedMax;

  const membership: EnsembleMembershipFinding["membership"] = [];
  for (const [quantity, rows] of perQuantity) {
    const below = rows.filter((row) => row.members < declaredMembers);
    if (below.length === 0) continue;
    membership.push({
      quantity,
      minMembers: Math.min(...below.map((row) => row.members)),
      hoursBelowFull: below.length,
      ofHours: rows.length,
      evidence: { examples: below.slice(0, 4) },
    });
  }

  // Band-width magnitude and trend on the derived series.
  const bands: EnsembleMembershipFinding["bands"] = [];
  for (const series of ["usableLiftTopM", "thermalVelocityMs"] as const) {
    const rows: Array<{ validAt: string; p50: number; width: number; relative: number | null }> =
      [];
    for (const hour of profile.hours) {
      const value = hour.derived[series];
      if (value === null || !isEnsembleValue(value)) continue;
      const width = value.p90 - value.p10;
      rows.push({
        validAt: hour.validAt,
        p50: value.p50,
        width,
        relative: value.p50 !== 0 ? width / value.p50 : null,
      });
    }
    if (rows.length === 0) continue;
    const widths = rows.map((row) => row.width).sort((a, b) => a - b);
    const withRelative = rows.filter(
      (row): row is typeof row & { relative: number } => row.relative !== null,
    );
    const worst =
      withRelative.length > 0
        ? withRelative.reduce((best, row) => (row.relative > best.relative ? row : best))
        : null;
    const ratio = thresholds.ensembleMembership.wideningRatio;
    bands.push({
      series,
      hoursWithSignal: rows.length,
      medianBandWidth: round1(widths[Math.floor(widths.length / 2)]),
      maxRelativeSpread: worst === null ? null : round1(worst.relative),
      maxSpreadAt: worst === null ? null : context.cite(worst.validAt),
      trend:
        rows.length > 3 && rows[rows.length - 1].width > ratio * rows[0].width
          ? "widening"
          : "steady",
      thresholds: { wideningRatio: ratio },
      evidence: {
        hours: rows.map((row) => row.validAt),
        p50: rows.map((row) => round1(row.p50)),
        bandWidth: rows.map((row) => round1(row.width)),
      },
    });
  }

  if (membership.length === 0 && bands.length === 0) return [];
  return [{ kind: "ensembleMembership", declaredMembers, membership, bands }];
}

function findDataCaveats(
  context: Context,
  timeZoneSource: WindgramAnalysis["timeZoneSource"],
): DataCaveatsFinding {
  const { profile } = context;
  const caveats: DataCaveat[] = [];

  // Quantity families never present anywhere in this document. Contract
  // semantics: absence means "not published", never zero — so a family
  // absent from every hour is a declaration this document cannot speak to it.
  const surfaceFamilies = [
    "windGustMs",
    "capeJkg",
    "cinJkg",
    "pblHeightM",
    "lowCloudPercent",
    "midCloudPercent",
    "highCloudPercent",
  ] as const;
  const absent: string[] = [];
  for (const family of surfaceFamilies) {
    if (profile.hours.every((hour) => hour.surface[family] === undefined)) absent.push(family);
  }
  if (profile.hours.every((hour) => hour.levels.length === 0)) {
    absent.push("levels");
  } else {
    if (
      profile.hours.every((hour) =>
        hour.levels.every((level) => level.verticalVelocityPaS === undefined),
      )
    ) {
      absent.push("levels[].verticalVelocityPaS");
    }
    if (
      profile.hours.every((hour) =>
        hour.levels.every((level) => level.cloudFractionPercent === undefined),
      )
    ) {
      absent.push("levels[].cloudFractionPercent");
    }
  }
  if (absent.length > 0) caveats.push({ caveat: "absentQuantities", quantities: absent });

  for (const quantity of ["usableLiftTopM", "boundaryLayerTopM"] as const) {
    const hoursNull = profile.hours.filter(
      (hour) => median(hour.derived[quantity]) === null,
    ).length;
    if (hoursNull > 0) {
      caveats.push({ caveat: "derivedNullHours", quantity, hoursNull, ofHours: profile.hours.length });
    }
  }

  if (context.stepHours > 1) caveats.push({ caveat: "stepCadence", stepHours: context.stepHours });
  if (timeZoneSource === "utcFallback") caveats.push({ caveat: "timesAreUtc" });

  return { kind: "dataCaveats", caveats };
}

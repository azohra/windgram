/* The versioned vocabulary: every statement analyze/ can make, as types —
   the contract surface consumers switch on. Extraction lives in
   findings.ts; the module charter (why statements are their own subpath,
   the discipline every kind obeys) lives in index.ts. */

/**
 * The finding-kind set this module can emit. Versioned like models.json
 * capabilities: consumers switch on `kind`, so adding, renaming, or removing
 * a kind is a contract event — bump this, and document the evidence that
 * justified the change (see the module charter in index.ts).
 */
export const ANALYZE_VOCABULARY_VERSION = 3;
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
   `clippedAtEnd` so a clipped edge reads as ≥/≤, not as timing. */

/* ------------------------------------------------------------- vocabulary */

/** An instant a finding cites: the document's own UTC `validAt` (so the
 * claim joins back to the published hour) plus its local clock reading
 * ("2026-08-08T11:00") in the analysis timezone. */
export interface CitedInstant {
  validAt: string;
  /**
   * The FULL local timestamp, ISO-shaped, h23, minute precision — a data
   * value, not display copy. Voice formatting (12-hour clocks, "1 p.m.",
   * dropping the date) is deliberately downstream: format from this or
   * from `validAt` in your own presentation layer; this field never
   * follows the scene's `hourLabel` convention.
   */
  local: string;
}

/**
 * Local calendar date key ("2026-08-09") in the analysis `timeZone` —
 * derive/'s `localDateKey` of the hour's `validAt`. Pairing findings with
 * a consumer's own day tabs (`groupByLocalDay`, `windgramDisplayHours`)
 * works only when both sides compute the key in the SAME zone: pass the
 * same timeZone to `analyzeProfile` as to the windowing, or the days
 * around midnight will land in different tabs.
 */
export type LocalDayKey = string;

/**
 * The model's grid terrain sits far from the launch, so every
 * altitude-referenced series in the document is structurally biased — the
 * spike's motivating case is GEPS at Flagpole, which models the site at
 * 144 m though launch is 1222 m, so its usable-lift top never reaches
 * launch. Invisible on a chart; only the metadata says it. The one verdict,
 * `liftTopEverReachesLaunch`, is pure arithmetic: max published lift top
 * vs launch elevation. Documents are launch-agnostic, so the launch is the
 * caller's (`AnalyzeOptions.launch`): emitted only when a launch is
 * supplied and |delta| is at least `thresholds.minAbsDeltaM`.
 */
export interface TerrainMismatchFinding {
  kind: "terrainMismatch";
  modelElevationM: number;
  /** The caller-supplied launch elevation (AnalyzeOptions.launch), metres MSL. */
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
  day: LocalDayKey;
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
 * series (see the module charter in index.ts). The default thresholds are
 * the spike's, whose 3×3 sensitivity sweep (W* 0.7/0.9/1.1 × depth
 * 150/300/500 m) measured low sensitivity on real profiles; both are
 * embedded and caller-movable, because "flyable" beyond this arithmetic is
 * pilot, wing, and site judgment that belongs downstream. Launch reference
 * is the caller's `AnalyzeOptions.launch.elevationM` — documents are
 * launch-agnostic — falling back to modelElevationM when no launch is
 * supplied (and then `peakLiftTopAboveLaunchM` is null rather than a
 * number relative to the wrong ground).
 */
export interface FlyableWindowFinding {
  kind: "flyableWindow";
  day: LocalDayKey;
  start: CitedInstant;
  end: CitedInstant;
  durationHours: number;
  peakLiftTopM: number;
  peakLiftTopAt: CitedInstant;
  /** Launch-relative peak; null when no launch was supplied. */
  peakLiftTopAboveLaunchM: number | null;
  peakThermalVelocityMs: number;
  /**
   * True when the window's first/last hour is the document's own first/
   * last hour: the edge is the data's horizon, not necessarily the
   * window's. A clipped start reads as "open since at least \<start\>", a
   * clipped end as "still open at \<end\>" — timing comparisons must not
   * count a clipped edge as a forecast of opening or decay.
   */
  clippedAtStart: boolean;
  clippedAtEnd: boolean;
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
  day: LocalDayKey;
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
  day: LocalDayKey;
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

/**
 * A local day that produced NO flyable window — the negative stated with
 * its evidence instead of by absence, so a consumer's headline can say WHY
 * ("peak W* 0.4 m/s, below the 0.9 floor") rather than only "no window".
 * Emitted once per local day that has forecast hours and no flyableWindow
 * finding; a day with a window emits nothing here (the window IS the
 * statement). `failed` names the floors the day's best hours missed —
 * including the honest edge case `"coincidence"`, where each threshold is
 * met at SOME hour but never both in the same hour.
 */
export interface QuietDayFinding {
  kind: "quietDay";
  day: LocalDayKey;
  /** The day's best W*; null when no hour published the series. */
  peakThermalVelocityMs: number | null;
  peakThermalVelocityAt: CitedInstant | null;
  /**
   * The day's best usable-lift depth above the launch reference
   * (AnalyzeOptions.launch.elevationM, or modelElevationM when no launch
   * is supplied — the same arithmetic the window test runs); null when
   * unpublished.
   */
  peakLiftDepthM: number | null;
  peakLiftDepthAt: CitedInstant | null;
  failed: Array<"wstar" | "depth" | "coincidence">;
  /**
   * The hours the claim is built from. `truncated` is the arithmetic
   * verdict that the document's own hour range clips this local day (its
   * covered span misses the day's start or end at the model's cadence):
   * a quiet call built from a sliver of a day — a short-horizon run
   * ending before the thermals start — is a data boundary, not a
   * forecast. A truncated quiet day must not vote in cross-model
   * comparisons; it exists so "no window" and "day not fully forecast"
   * stay distinguishable statements.
   */
  coverage: {
    hours: number;
    first: CitedInstant;
    last: CitedInstant;
    truncated: boolean;
  };
  thresholds: { wstarMinMs: number; depthMinM: number };
}

export type WindgramFinding =
  | TerrainMismatchFinding
  | DataCaveatsFinding
  | EnsembleMembershipFinding
  | CapTimingFinding
  | FlyableWindowFinding
  | QuietDayFinding
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
  thresholds?: Partial<AnalyzeThresholds>;
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
  stepHours: number;
  hours: number;
  findings: WindgramFinding[];
}

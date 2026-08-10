/* The extractors: one profile document in, the vocabulary's findings out.
   The vocabulary itself (finding types, thresholds, envelope) lives in
   vocabulary.ts; the module charter lives in index.ts. */

import {
  isDeterministicProfile,
  isEnsembleValue,
  type Scalar,
  type WindgramHour,
  type WindgramProfile,
} from "../contract/index.js";
import { localDateKey, localHourOfDay } from "../derive/day-window.js";
import { p50 } from "../derive/ensemble.js";
import {
  ANALYZE_VOCABULARY_VERSION,
  DEFAULT_ANALYZE_THRESHOLDS,
  type AnalyzeOptions,
  type AnalyzeThresholds,
  type CapTimingFinding,
  type CitedInstant,
  type DataCaveat,
  type DataCaveatsFinding,
  type EnsembleMembershipFinding,
  type FlyableWindowFinding,
  type LiftCeilingFinding,
  type QuietDayFinding,
  type TerrainMismatchFinding,
  type WindgramAnalysis,
  type WindgramFinding,
  type WindSummaryFinding,
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
    launchElevationM,
    launchReferenceM: launchElevationM ?? profile.site.modelElevationM,
    cite: citedInstantFactory(timeZone),
    thresholds,
  };

  const windows = findFlyableWindows(context);
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

interface Context {
  profile: WindgramProfile;
  timeZone: string;
  deterministic: boolean;
  stepHours: number;
  /** The caller-supplied launch elevation; null when none was supplied. */
  launchElevationM: number | null;
  /** launchElevationM, falling back to the model's own ground. */
  launchReferenceM: number;
  cite: (validAt: string) => CitedInstant;
  thresholds: AnalyzeThresholds;
}

/** The exact per-kind merge `analyzeProfile` applies to its `thresholds`
 * option — exported so `compare/` can echo the resolved values in its
 * envelope without restating the merge (one home). */
export function resolveAnalyzeThresholds(
  overrides?: Partial<AnalyzeThresholds>,
): AnalyzeThresholds {
  return mergeThresholds(overrides);
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

function band(value: Scalar | null | undefined): [number, number] | null {
  if (value !== null && value !== undefined && isEnsembleValue(value)) {
    // Full dropout has no envelope: percentiles of zero members are null.
    if (value.p10 === null || value.p90 === null) return null;
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

/* Stated magnitudes ship at the contract's own precision for their
   quantity — the pipeline's publish table (_FIELD_DECIMALS) is the
   authority: metre quantities at one decimal, m/s quantities at two.
   Coarser would let a finding contradict its own evidence (a raw w* of
   0.89 votes quiet against a 0.9 floor while a 1-dp print says 0.9).
   compare/ imports these rather than restating them. */

/** One decimal — contract precision for metre magnitudes
 * (usableLiftTopM, cloudBaseM, heights, deltas). */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Two decimals — contract precision for m/s magnitudes
 * (thermalVelocityMs, windSpeedMs, windGustMs). */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/* ---------------------------------------------------------------- findings */

function findTerrainMismatch(context: Context): TerrainMismatchFinding[] {
  const { profile, thresholds } = context;
  // Launch vs model ground needs a launch: without AnalyzeOptions.launch
  // there is no statement to make (documents carry no launch).
  const launch = context.launchElevationM;
  if (launch === null) return [];
  const delta = profile.site.modelElevationM - launch;
  if (Math.abs(delta) < thresholds.terrainMismatch.minAbsDeltaM) return [];

  let maxTop: number | null = null;
  let maxTopAt: CitedInstant | null = null;
  for (const hour of profile.hours) {
    const top = p50(hour.derived.usableLiftTopM);
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
  const launchKnown = context.launchElevationM !== null;
  const ensemble = !context.deterministic;

  const flyable = (hour: WindgramHour): boolean => {
    const top = p50(hour.derived.usableLiftTopM);
    const wstar = p50(hour.derived.thermalVelocityMs);
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
    const tops = hours.map((hour) => p50(hour.derived.usableLiftTopM)!);
    const wstars = hours.map((hour) => p50(hour.derived.thermalVelocityMs)!);
    const peakIndex = tops.indexOf(Math.max(...tops));
    const peakHour = hours[peakIndex];
    const peakTop = tops[peakIndex];

    const finding: FlyableWindowFinding = {
      kind: "flyableWindow",
      day: localDateKey(hours[0].validAt, context.timeZone),
      start: context.cite(hours[0].validAt),
      end: context.cite(hours[hours.length - 1].validAt),
      // A window abutting the document's own hour range is clipped by the
      // horizon: the edge is a data boundary, not an opening or a decay.
      clippedAtStart: hours[0].validAt === profile.hours[0].validAt,
      clippedAtEnd:
        hours[hours.length - 1].validAt === profile.hours[profile.hours.length - 1].validAt,
      durationHours: hours.length * stepHours,
      peakLiftTopM: round1(peakTop),
      peakLiftTopAt: context.cite(peakHour.validAt),
      peakLiftTopAboveLaunchM: launchKnown ? round1(peakTop - launchReferenceM) : null,
      peakThermalVelocityMs: round2(Math.max(...wstars)),
      thresholds: { wstarMinMs, depthMinM },
      evidence: {
        hours: hours.map((hour) => hour.validAt),
        usableLiftTopM: tops.map(round1),
        thermalVelocityMs: wstars.map(round2),
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

/* The negative statement: local days that produced no flyable window,
   carrying the numbers that failed. Days covered by any window hour are
   excluded via the windows' own evidence (a window that crosses midnight
   covers both its days). */
function findQuietDays(
  context: Context,
  windows: FlyableWindowFinding[],
): QuietDayFinding[] {
  const { profile, launchReferenceM, thresholds } = context;
  const { wstarMinMs, depthMinM } = thresholds.flyableWindow;
  const windowDays = new Set(
    windows.flatMap((window) =>
      window.evidence.hours.map((validAt) => localDateKey(validAt, context.timeZone)),
    ),
  );
  const byDay = new Map<string, WindgramHour[]>();
  for (const hour of profile.hours) {
    const day = localDateKey(hour.validAt, context.timeZone);
    const group = byDay.get(day) ?? [];
    group.push(hour);
    byDay.set(day, group);
  }

  const findings: QuietDayFinding[] = [];
  for (const [day, hours] of byDay) {
    if (windowDays.has(day)) continue;
    /* Coverage: a continuous profile covers a full local day at cadence k
       exactly when its first covered hour falls inside the day's first
       step and its last inside the day's last step. Anything else means
       the document's own horizon clips the day. */
    const step = context.stepHours;
    const firstLocalH = localHourOfDay(hours[0].validAt, context.timeZone);
    const lastLocalH = localHourOfDay(hours[hours.length - 1].validAt, context.timeZone);
    const truncated = !(firstLocalH < step && lastLocalH >= 24 - step);
    let peakWstar: number | null = null;
    let peakWstarAt: string | null = null;
    let peakDepth: number | null = null;
    let peakDepthAt: string | null = null;
    for (const hour of hours) {
      const wstar = p50(hour.derived.thermalVelocityMs);
      const top = p50(hour.derived.usableLiftTopM);
      const depth = top === null ? null : top - launchReferenceM;
      if (wstar !== null && (peakWstar === null || wstar > peakWstar)) {
        peakWstar = wstar;
        peakWstarAt = hour.validAt;
      }
      if (depth !== null && (peakDepth === null || depth > peakDepth)) {
        peakDepth = depth;
        peakDepthAt = hour.validAt;
      }
    }
    const failed: QuietDayFinding["failed"] = [];
    if (peakWstar === null || peakWstar < wstarMinMs) failed.push("wstar");
    if (peakDepth === null || peakDepth < depthMinM) failed.push("depth");
    // Each floor met at SOME hour, never both in the same hour — a real
    // (if rare) shape: morning depth under a dying W*, or the reverse.
    if (failed.length === 0) failed.push("coincidence");
    findings.push({
      kind: "quietDay",
      day,
      peakThermalVelocityMs: peakWstar === null ? null : round2(peakWstar),
      peakThermalVelocityAt: peakWstarAt === null ? null : context.cite(peakWstarAt),
      peakLiftDepthM: peakDepth === null ? null : round1(peakDepth),
      peakLiftDepthAt: peakDepthAt === null ? null : context.cite(peakDepthAt),
      failed,
      coverage: {
        hours: hours.length * step,
        first: context.cite(hours[0].validAt),
        last: context.cite(hours[hours.length - 1].validAt),
        truncated,
      },
      thresholds: { wstarMinMs, depthMinM },
    });
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
      const top = p50(hour.derived.usableLiftTopM);
      const cloudBase = p50(hour.derived.cloudBaseM);
      if (top === null || cloudBase === null) continue;
      const cause: "cloudCapped" | "sinkLimited" =
        cloudBase <= top + margin ? "cloudCapped" : "sinkLimited";
      const previous = segments[segments.length - 1];
      if (previous && previous.cause === cause) {
        previous.end = context.cite(validAt);
        previous.hoursN += 1;
      } else {
        const boundaryLayerTop = p50(hour.derived.boundaryLayerTopM);
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
      cape: p50(hour.surface.capeJkg),
      cin: p50(hour.surface.cinJkg),
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
      .map((row) => ({ row, rate: p50(row.hour.surface.precipitationMmHr) }))
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
    const top = p50(hour.derived.usableLiftTopM);
    if (top === null) return null;
    let best: ReturnType<typeof bandMax> = null;
    for (const level of hour.levels) {
      const heightM = p50(level.heightM);
      const windMs = p50(level.windSpeedMs);
      if (heightM === null || windMs === null) continue;
      if (heightM < launchReferenceM - bandMarginM || heightM > top + bandMarginM) continue;
      if (best === null || windMs > best.windMs) {
        best = {
          windMs,
          directionDeg: p50(level.windDirectionDeg),
          heightM,
          pressureHpa: p50(level.pressureHpa) ?? Number.NaN,
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
      const value = p50(hour.surface.windGustMs);
      if (value !== null && value > gust) {
        gust = value;
        gustAt = hour;
      }
    }
    if (gustAt !== null) {
      const mean = p50(gustAt.surface.windSpeedMs);
      finding.maxGust = {
        gustMs: round2(gust),
        meanWindMs: mean === null ? null : round2(mean),
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
        windMs: round2(peakEntry.max.windMs),
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
    // Contract precision per series: metres at 1, m/s at 2. The relative
    // spread is a ratio, not a magnitude — it stays at one decimal.
    const roundSeries = series === "thermalVelocityMs" ? round2 : round1;
    const rows: Array<{ validAt: string; p50: number; width: number; relative: number | null }> =
      [];
    for (const hour of profile.hours) {
      const value = hour.derived[series];
      if (value === null || !isEnsembleValue(value)) continue;
      // Full dropout carries no band; the membership counts above already
      // state the zero, which is the finding's job for that hour.
      if (value.p10 === null || value.p90 === null || value.p50 === null) continue;
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
      medianBandWidth: roundSeries(widths[Math.floor(widths.length / 2)]),
      maxRelativeSpread: worst === null ? null : round1(worst.relative),
      maxSpreadAt: worst === null ? null : context.cite(worst.validAt),
      trend:
        rows.length > 3 && rows[rows.length - 1].width > ratio * rows[0].width
          ? "widening"
          : "steady",
      thresholds: { wideningRatio: ratio },
      evidence: {
        hours: rows.map((row) => row.validAt),
        p50: rows.map((row) => roundSeries(row.p50)),
        bandWidth: rows.map((row) => roundSeries(row.width)),
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
      (hour) => p50(hour.derived[quantity]) === null,
    ).length;
    if (hoursNull > 0) {
      caveats.push({ caveat: "derivedNullHours", quantity, hoursNull, ofHours: profile.hours.length });
    }
  }

  if (context.stepHours > 1) caveats.push({ caveat: "stepCadence", stepHours: context.stepHours });
  if (timeZoneSource === "utcFallback") caveats.push({ caveat: "timesAreUtc" });

  return { kind: "dataCaveats", caveats };
}

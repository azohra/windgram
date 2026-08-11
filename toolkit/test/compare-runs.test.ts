import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWindgramProfile, type WindgramProfile } from "../src/contract/index.js";
import {
  analyzeProfile,
  type EnsembleMembershipFinding,
  type WindgramAnalysis,
} from "../src/analyze/index.js";
import {
  compareRunAnalyses,
  compareRuns,
  DEFAULT_SETTLED_THRESHOLDS,
  loadProfileHistory,
  RUN_COMPARISON_VOCABULARY_VERSION,
  type CompareRunsOptions,
  type ExistenceTrajectoryFinding,
  type HistoryFetch,
  type IdentityDriftFinding,
  type LoadedHistory,
  type MagnitudeTrajectoryFinding,
  type RunComparison,
  type SettledFinding,
  type TimingTrajectoryFinding,
} from "../src/history/index.js";

/* The run-sequence fixture: four hand-authored runs of ONE model
   (hrrr-conus clones over the real erie document, the compare.test kit's
   construction) six hours apart, so every trajectory expectation below is
   checkable by hand against the embedded floors (w* >= 0.9, depth >= 300 m
   over the 1247 m launch; local midnight in America/Vancouver is T07:00Z):

   day 1 (2026-08-08) — every run windows; the edges move:
     R0 (07T00Z): hours 00..15 local only; window 10..15 (w* 2.0, top 3000)
                  — start 10:00 unclipped, end AT the horizon (clipped).
     R1 (07T06Z): full 2 days; window 11..15 (w* 1.8, top 2500).
     R2 (07T12Z): window 11..16 (w* 2.2, top 2600).
     R3 (07T18Z): window 11..16 (w* 2.1, top 2700), modelElevationM moved
                  to 1100 — identity drift, NOT weather.
   day 2 (2026-08-09) — existence flips once, stated without adjectives:
     R0 covers zero hours (outOfHorizon), R1 says quiet (w* 0.5, top 1500),
     R2 windows 12..16 (w* 1.6, top 2600), R3 windows 11..16 (w* 1.7, 2700).

   Launch-relative lift peaks: R0 1753, R1 1253, R2 1353, R3 1453 (day 1);
   R1 253 (quiet depth), R2 1353, R3 1453 (day 2). So at the trial
   constants (minRuns 3, band 300 m) day 1 settles (newest three spread
   1453-1253 = 200) and day 2 does not (1453-253 = 1200). */

const fixtures = JSON.parse(
  readFileSync(join(__dirname, "analyze-fixtures.json"), "utf-8"),
) as Record<string, unknown>;

const TZ = "America/Vancouver";
const LAUNCH = { elevationM: 1247 };
const D1 = "2026-08-08";
const D2 = "2026-08-09";

function utcAt(day: string, localHour: number): string {
  return new Date(Date.parse(`${day}T07:00:00Z`) + localHour * 3_600_000)
    .toISOString()
    .replace(".000Z", "Z");
}

interface HourSpec {
  validAt: string;
  wstar: number;
  top: number | null;
}

const QUIET = { wstar: 0.2, top: 1300 };

function hoursFor(
  day: string,
  fromH: number,
  toH: number,
  spec: (localHour: number) => { wstar: number; top: number | null },
): HourSpec[] {
  return Array.from({ length: toH - fromH + 1 }, (_, i) => ({
    validAt: utcAt(day, fromH + i),
    ...spec(fromH + i),
  }));
}

function runProfile(opts: {
  referenceTime: string;
  model?: string;
  siteId?: string;
  modelElevationM?: number;
  hours: HourSpec[];
}): WindgramProfile {
  const doc = JSON.parse(JSON.stringify(fixtures["hrrrConusErie"])) as {
    model: string;
    run: { referenceTime: string };
    site: { id: string; modelElevationM: number };
    hours: Array<{ validAt: string; derived: Record<string, unknown> }>;
  };
  doc.model = opts.model ?? "hrrr-conus";
  doc.run.referenceTime = opts.referenceTime;
  if (opts.siteId !== undefined) doc.site.id = opts.siteId;
  if (opts.modelElevationM !== undefined) doc.site.modelElevationM = opts.modelElevationM;
  const template = JSON.stringify(doc.hours[0]);
  doc.hours = opts.hours.map((spec) => {
    const hour = JSON.parse(template) as (typeof doc.hours)[number];
    hour.validAt = spec.validAt;
    hour.derived.thermalVelocityMs = spec.wstar;
    hour.derived.usableLiftTopM = spec.top;
    return hour;
  });
  const profile = parseWindgramProfile(doc);
  expect(profile, "the fixture run must satisfy the published contract").not.toBeNull();
  return profile!;
}

const R0_REF = "2026-08-07T00:00:00Z";
const R1_REF = "2026-08-07T06:00:00Z";
const R2_REF = "2026-08-07T12:00:00Z";
const R3_REF = "2026-08-07T18:00:00Z";

const r0 = () =>
  runProfile({
    referenceTime: R0_REF,
    hours: hoursFor(D1, 0, 15, (h) => (h >= 10 ? { wstar: 2.0, top: 3000 } : QUIET)),
  });
const r1 = () =>
  runProfile({
    referenceTime: R1_REF,
    hours: [
      ...hoursFor(D1, 0, 23, (h) => (h >= 11 && h <= 15 ? { wstar: 1.8, top: 2500 } : QUIET)),
      ...hoursFor(D2, 0, 23, () => ({ wstar: 0.5, top: 1500 })),
    ],
  });
const r2 = () =>
  runProfile({
    referenceTime: R2_REF,
    hours: [
      ...hoursFor(D1, 0, 23, (h) => (h >= 11 && h <= 16 ? { wstar: 2.2, top: 2600 } : QUIET)),
      ...hoursFor(D2, 0, 23, (h) => (h >= 12 && h <= 16 ? { wstar: 1.6, top: 2600 } : QUIET)),
    ],
  });
const r3 = () =>
  runProfile({
    referenceTime: R3_REF,
    modelElevationM: 1100,
    hours: [
      ...hoursFor(D1, 0, 23, (h) => (h >= 11 && h <= 16 ? { wstar: 2.1, top: 2700 } : QUIET)),
      ...hoursFor(D2, 0, 23, (h) => (h >= 11 && h <= 16 ? { wstar: 1.7, top: 2700 } : QUIET)),
    ],
  });

const allRuns = () => [r0(), r1(), r2(), r3()];

function compared(overrides: Partial<CompareRunsOptions> = {}): RunComparison {
  return compareRuns(allRuns(), { timeZone: TZ, launch: LAUNCH, ...overrides });
}

function findingOf<T extends { kind: string; day?: string }>(
  comparison: RunComparison,
  kind: T["kind"],
  day?: string,
): T {
  const found = comparison.findings.find(
    (finding) =>
      finding.kind === kind &&
      (day === undefined || (finding as { day?: string }).day === day),
  );
  expect(found, `${kind} for ${day ?? "(day-less)"} must exist`).toBeDefined();
  return found as unknown as T;
}

/* -------------------------------------------------------------- the tests */

describe("compareRuns guards — one model's runs through time", () => {
  it("refuses mixed models — the inverse of compareProfiles' axis", () => {
    const other = runProfile({ referenceTime: R1_REF, model: "gfs", hours: r0().hours.map(h => ({ validAt: h.validAt, wstar: 0.2, top: 1300 })) });
    expect(() => compareRuns([r0(), other], { timeZone: TZ })).toThrow(
      /mixed models \(hrrr-conus vs gfs\)/,
    );
  });

  it("refuses mixed sites — compareAnalyses' validation, delegated", () => {
    const elsewhere = runProfile({
      referenceTime: R1_REF,
      siteId: "elsewhere",
      hours: hoursFor(D1, 0, 15, () => QUIET),
    });
    expect(() => compareRuns([r0(), elsewhere], { timeZone: TZ })).toThrow(/mixed sites/);
  });

  it("refuses an empty run list and the same run twice", () => {
    expect(() => compareRuns([], { timeZone: TZ })).toThrow(/no runs/);
    expect(() => compareRuns([r0(), r0()], { timeZone: TZ })).toThrow(
      /duplicate member \(hrrr-conus@2026-08-07T00:00:00Z\)/,
    );
  });
});

describe("the RunComparison envelope", () => {
  it("states its identity: sibling vocabulary, one model, runs newest first", () => {
    const comparison = compared();
    expect(comparison.vocabularyVersion).toBe(RUN_COMPARISON_VOCABULARY_VERSION);
    expect(comparison.model).toBe("hrrr-conus");
    expect(comparison.site).toEqual({ id: "erie", launchAltitudeM: 1247 });
    expect(comparison.timeZone).toBe(TZ);
    expect(comparison.newestReferenceTime).toBe(R3_REF);
    expect(comparison.leadAnchorLocalHour).toBe(12);
    // The ladder order: newest run first, and the ledger is compare v2's
    // (runAgeHours as the stated staleness fact, never a score).
    expect(comparison.runs.map((run) => run.referenceTime)).toEqual([
      R3_REF,
      R2_REF,
      R1_REF,
      R0_REF,
    ]);
    expect(comparison.runs.map((run) => run.runAgeHours)).toEqual([0, 6, 12, 18]);
    expect(comparison.runs.every((run) => run.benched === null)).toBe(true);
    // Every run's analysis rides as provenance, keyed by member key.
    expect(Object.keys(comparison.analyses)).toHaveLength(4);
    expect(comparison.analyses["hrrr-conus@2026-08-07T18:00:00Z"].run.referenceTime).toBe(R3_REF);
  });

  it("is input-order independent — runs are ordered by referenceTime internally", () => {
    const shuffled = compareRuns([r2(), r0(), r3(), r1()], { timeZone: TZ, launch: LAUNCH });
    expect(shuffled).toEqual(compared());
  });

  it("equals the compareRunAnalyses door on the same inputs — one construction", () => {
    const analyses = allRuns().map((profile) =>
      analyzeProfile(profile, { timeZone: TZ, launch: LAUNCH }),
    );
    expect(compareRunAnalyses(analyses)).toEqual(compared());
    // The cached-analysis door: envelopes survive a JSON round trip.
    const cached = analyses.map(
      (analysis) => JSON.parse(JSON.stringify(analysis)) as WindgramAnalysis,
    );
    expect(compareRunAnalyses(cached)).toEqual(compared());
  });

  it("echoes moved thresholds — the one set every run was analyzed with", () => {
    const comparison = compared({ thresholds: { thermalWindow: { wstarMinMs: 0.8 } } });
    expect(comparison.thresholds.thermalWindow.wstarMinMs).toBe(0.8);
    const existence = findingOf<ExistenceTrajectoryFinding>(comparison, "existenceTrajectory", D1);
    expect(existence.thresholds).toEqual({ wstarMinMs: 0.8, depthMinM: 300 });
  });
});

describe("existence trajectory — the ladder's window/quiet/abstain votes", () => {
  it("stacks day 1's unanimous windows newest first with per-run flip values", () => {
    const existence = findingOf<ExistenceTrajectoryFinding>(compared(), "existenceTrajectory", D1);
    expect(existence.thresholds).toEqual({ wstarMinMs: 0.9, depthMinM: 300 });
    // Local noon of 2026-08-08 is T19:00Z; leads read from each run's
    // referenceTime to that anchor: 25, 31, 37, 43 h.
    expect(
      existence.rungs.map(({ referenceTime, leadHours, vote }) => ({
        referenceTime,
        leadHours,
        vote,
      })),
    ).toEqual([
      { referenceTime: R3_REF, leadHours: 25, vote: "window" },
      { referenceTime: R2_REF, leadHours: 31, vote: "window" },
      { referenceTime: R1_REF, leadHours: 37, vote: "window" },
      { referenceTime: R0_REF, leadHours: 43, vote: "window" },
    ]);
    // Each rung's OWN flip values: its window's binding peaks.
    expect(existence.rungs.map((rung) => rung.sensitivity)).toEqual([
      { wstarFlipAtMs: 2.1, depthFlipAtM: 1453 },
      { wstarFlipAtMs: 2.2, depthFlipAtM: 1353 },
      { wstarFlipAtMs: 1.8, depthFlipAtM: 1253 },
      { wstarFlipAtMs: 2.0, depthFlipAtM: 1753 },
    ]);
  });

  it("states day 2's single flip as the vote sequence — no adjectives, reasons on every non-vote", () => {
    const existence = findingOf<ExistenceTrajectoryFinding>(compared(), "existenceTrajectory", D2);
    expect(existence.rungs.map((rung) => rung.vote)).toEqual([
      "window",
      "window",
      "quiet",
      "abstained",
    ]);
    // The quiet rung carries the numbers that failed…
    const quiet = existence.rungs[2];
    expect(quiet.referenceTime).toBe(R1_REF);
    expect(quiet.failed).toEqual(["wstar", "depth"]);
    expect(quiet.sensitivity).toEqual({ wstarFlipAtMs: 0.5, depthFlipAtM: 253 });
    // …and the run that never reached the day abstains with its reason —
    // staleness is an abstention fact, never a "changed forecast".
    const abstained = existence.rungs[3];
    expect(abstained.referenceTime).toBe(R0_REF);
    expect(abstained.abstained).toBe("outOfHorizon");
    expect(abstained.sensitivity).toEqual({ wstarFlipAtMs: null, depthFlipAtM: null });
    // Local noon of 2026-08-09 is T19:00Z: leads 49, 55, 61, 67 h.
    expect(existence.rungs.map((rung) => rung.leadHours)).toEqual([49, 55, 61, 67]);
  });
});

describe("timing trajectory — edges across runs, quantization confessed", () => {
  it("rosters day 1's unclipped edges only: the horizon-clipped end never reads as timing", () => {
    const timing = findingOf<TimingTrajectoryFinding>(compared(), "timingTrajectory", D1);
    // Starts: all four runs forecast an opening (R0 at 10:00 local, the
    // rest at 11:00), newest first, each vote carrying its cadence echo.
    expect(
      timing.starts.map(({ referenceTime, at, stepHours }) => ({
        referenceTime,
        local: at.local,
        stepHours,
      })),
    ).toEqual([
      { referenceTime: R3_REF, local: "2026-08-08T11:00", stepHours: 1 },
      { referenceTime: R2_REF, local: "2026-08-08T11:00", stepHours: 1 },
      { referenceTime: R1_REF, local: "2026-08-08T11:00", stepHours: 1 },
      { referenceTime: R0_REF, local: "2026-08-08T10:00", stepHours: 1 },
    ]);
    expect(timing.startSpreadHours).toBe(1);
    expect(timing.startStepHoursMax).toBe(1);
    // Ends: R0's window dies AT its horizon — clipped, excluded; three
    // ends remain (16:00, 16:00, 15:00 local).
    expect(timing.ends.map(({ referenceTime, at }) => ({ referenceTime, local: at.local }))).toEqual([
      { referenceTime: R3_REF, local: "2026-08-08T16:00" },
      { referenceTime: R2_REF, local: "2026-08-08T16:00" },
      { referenceTime: R1_REF, local: "2026-08-08T15:00" },
    ]);
    expect(timing.endSpreadHours).toBe(1);
    // Lead decoration rides every vote.
    expect(timing.starts.map((vote) => vote.leadHours)).toEqual([25, 31, 37, 43]);
  });

  it("spreads day 2's two window runs and never rosters the quiet or absent ones", () => {
    const timing = findingOf<TimingTrajectoryFinding>(compared(), "timingTrajectory", D2);
    expect(timing.starts.map(({ referenceTime, at }) => ({ referenceTime, local: at.local }))).toEqual([
      { referenceTime: R3_REF, local: "2026-08-09T11:00" },
      { referenceTime: R2_REF, local: "2026-08-09T12:00" },
    ]);
    expect(timing.startSpreadHours).toBe(1);
    expect(timing.endSpreadHours).toBe(0); // both end 16:00
  });
});

describe("magnitude trajectory — the numbers whose deltas state themselves", () => {
  it("stacks day 1's peaks and durations newest first", () => {
    const magnitude = findingOf<MagnitudeTrajectoryFinding>(compared(), "magnitudeTrajectory", D1);
    expect(
      magnitude.rungs.map(
        ({ referenceTime, vote, peakThermalVelocityMs, peakLiftAboveLaunchM, windowDurationHours }) => ({
          referenceTime,
          vote,
          peakThermalVelocityMs,
          peakLiftAboveLaunchM,
          windowDurationHours,
        }),
      ),
    ).toEqual([
      { referenceTime: R3_REF, vote: "window", peakThermalVelocityMs: 2.1, peakLiftAboveLaunchM: 1453, windowDurationHours: 6 },
      { referenceTime: R2_REF, vote: "window", peakThermalVelocityMs: 2.2, peakLiftAboveLaunchM: 1353, windowDurationHours: 6 },
      { referenceTime: R1_REF, vote: "window", peakThermalVelocityMs: 1.8, peakLiftAboveLaunchM: 1253, windowDurationHours: 5 },
      { referenceTime: R0_REF, vote: "window", peakThermalVelocityMs: 2.0, peakLiftAboveLaunchM: 1753, windowDurationHours: 6 },
    ]);
    // Deterministic runs carry no band evidence.
    expect(magnitude.rungs.every((rung) => rung.bandWidth === undefined)).toBe(true);
  });

  it("carries day 2's quiet magnitudes beside the window ones — the abstained run has no rung", () => {
    const magnitude = findingOf<MagnitudeTrajectoryFinding>(compared(), "magnitudeTrajectory", D2);
    expect(
      magnitude.rungs.map(({ referenceTime, vote, peakLiftAboveLaunchM, windowDurationHours }) => ({
        referenceTime,
        vote,
        peakLiftAboveLaunchM,
        windowDurationHours,
      })),
    ).toEqual([
      { referenceTime: R3_REF, vote: "window", peakLiftAboveLaunchM: 1453, windowDurationHours: 6 },
      { referenceTime: R2_REF, vote: "window", peakLiftAboveLaunchM: 1353, windowDurationHours: 5 },
      { referenceTime: R1_REF, vote: "quiet", peakLiftAboveLaunchM: 253, windowDurationHours: null },
    ]);
  });

  it("rides ensemble per-day band widths as evidence with no verdict anywhere near them", () => {
    // Two REPS-cloned ensemble runs covering one FULL local day at 3 h
    // cadence (the real repsErie document is an 8-hour sliver whose days
    // are all truncated — and a truncated day's band width is a horizon
    // artifact dayBands itself refuses to state): each magnitude rung's
    // bandWidth restates the run's OWN ensembleMembership dayBands entry —
    // widths ship, nothing narrows.
    const ens = (p50: number, spread: number) => ({
      members: 21,
      p10: p50 - spread,
      p25: p50 - spread / 2,
      p50,
      p75: p50 + spread / 2,
      p90: p50 + spread,
    });
    const ensembleRun = (referenceTime: string): WindgramProfile => {
      const doc = JSON.parse(JSON.stringify(fixtures["repsErie"])) as {
        run: { referenceTime: string };
        hours: Array<{ validAt: string; derived: Record<string, unknown> }>;
      };
      doc.run.referenceTime = referenceTime;
      const template = JSON.stringify(doc.hours[3]);
      doc.hours = [0, 3, 6, 9, 12, 15, 18, 21].map((localHour) => {
        const hour = JSON.parse(template) as (typeof doc.hours)[number];
        hour.validAt = utcAt(D1, localHour);
        const inWindow = localHour === 12 || localHour === 15;
        hour.derived.thermalVelocityMs = ens(inWindow ? (localHour === 12 ? 1.6 : 1.5) : 0.2, 0.2);
        hour.derived.usableLiftTopM = ens(inWindow ? 2800 : 1300, 150);
        return hour;
      });
      const profile = parseWindgramProfile(doc);
      expect(profile).not.toBeNull();
      return profile!;
    };

    const comparison = compareRuns(
      [ensembleRun("2026-08-07T06:00:00Z"), ensembleRun("2026-08-07T12:00:00Z")],
      { timeZone: TZ, launch: LAUNCH },
    );
    const magnitudes = comparison.findings.filter(
      (finding): finding is MagnitudeTrajectoryFinding => finding.kind === "magnitudeTrajectory",
    );
    expect(magnitudes.length).toBeGreaterThan(0);
    let carried = 0;
    for (const finding of magnitudes) {
      for (const rung of finding.rungs) {
        const membership = comparison.analyses[rung.member].findings.find(
          (candidate): candidate is EnsembleMembershipFinding =>
            candidate.kind === "ensembleMembership",
        );
        const dayBand = membership?.dayBands.find(
          (entry) => entry.day === finding.day && !entry.truncated,
        );
        if (dayBand) {
          carried += 1;
          expect(rung.bandWidth).toEqual({
            wstarBandWidthMs: dayBand.wstarBandWidthMs,
            liftTopBandWidthM: dayBand.liftTopBandWidthM,
          });
        } else {
          expect(rung.bandWidth).toBeUndefined();
        }
      }
    }
    expect(carried).toBeGreaterThan(0);
  });
});

describe("settled — arithmetic stability, not probability", () => {
  it("settles day 1 at the trial constants: newest three lift peaks spread 200 m <= 300 m", () => {
    const settled = findingOf<SettledFinding>(compared(), "settled", D1);
    expect(settled.thresholds).toEqual({ minRuns: 3, magnitudeBandM: 300 });
    expect(settled.thresholds).toEqual(DEFAULT_SETTLED_THRESHOLDS);
    expect(settled.sample.map(({ referenceTime, peakLiftAboveLaunchM }) => ({ referenceTime, peakLiftAboveLaunchM }))).toEqual([
      { referenceTime: R3_REF, peakLiftAboveLaunchM: 1453 },
      { referenceTime: R2_REF, peakLiftAboveLaunchM: 1353 },
      { referenceTime: R1_REF, peakLiftAboveLaunchM: 1253 },
    ]);
    expect(settled.spreadM).toBe(200);
    expect(settled.settled).toBe(true);
  });

  it("does not settle day 2: the quiet run's 253 m sits 1200 m from the window peaks", () => {
    const settled = findingOf<SettledFinding>(compared(), "settled", D2);
    expect(settled.spreadM).toBe(1200);
    expect(settled.settled).toBe(false);
  });

  it("moves with the caller's constants — embedded defaults, not decisions", () => {
    // Wider sample on day 1 pulls in R0's 1753 peak: spread 500 > 300.
    const wider = findingOf<SettledFinding>(
      compared({ settled: { minRuns: 4 } }),
      "settled",
      D1,
    );
    expect(wider.sample).toHaveLength(4);
    expect(wider.spreadM).toBe(500);
    expect(wider.settled).toBe(false);
    // Day 2 settles under a two-run sample and a 100 m band: 1453 vs 1353.
    const narrower = findingOf<SettledFinding>(
      compared({ settled: { minRuns: 2, magnitudeBandM: 100 } }),
      "settled",
      D2,
    );
    expect(narrower.spreadM).toBe(100);
    expect(narrower.settled).toBe(true);
  });
});

describe("identityDrift — pipeline facts stated, never scored as weather", () => {
  it("passes the loader's revisions through and states adjacent-run identity changes", () => {
    const revisions = [
      {
        referenceTime: R2_REF,
        keptGeneratedAt: "2026-08-07T14:00:00Z",
        supersededGeneratedAt: ["2026-08-07T13:00:00Z"],
      },
    ];
    const comparison = compareRuns(allRuns(), { timeZone: TZ, launch: LAUNCH, revisions });
    const drift = findingOf<IdentityDriftFinding>(comparison, "identityDrift");
    expect(drift.revisions).toEqual(revisions);
    const baseElevation = (parseWindgramProfile(fixtures["hrrrConusErie"])!).site.modelElevationM;
    expect(drift.changes).toEqual([
      {
        fact: "modelElevationM",
        from: { referenceTime: R2_REF, value: baseElevation },
        to: { referenceTime: R3_REF, value: 1100 },
      },
      {
        fact: "hours",
        from: { referenceTime: R0_REF, value: 16 },
        to: { referenceTime: R1_REF, value: 48 },
      },
    ]);
  });

  it("emits nothing when identity holds and no revisions were reported", () => {
    const comparison = compareRuns([r1(), r2()], { timeZone: TZ, launch: LAUNCH });
    expect(comparison.findings.some((finding) => finding.kind === "identityDrift")).toBe(false);
  });
});

describe("lead anchoring — local noon by default, a parameter either way", () => {
  it("re-anchors every leadHours when the caller moves the local hour", () => {
    const comparison = compared({ leadAnchorLocalHour: 9 });
    expect(comparison.leadAnchorLocalHour).toBe(9);
    // 09:00 local on 2026-08-08 is T16:00Z: three hours nearer than noon.
    const existence = findingOf<ExistenceTrajectoryFinding>(comparison, "existenceTrajectory", D1);
    expect(existence.rungs.map((rung) => rung.leadHours)).toEqual([22, 28, 34, 40]);
  });
});

describe("loadProfileHistory → compareRuns — the archive end to end", () => {
  /* The real hrdps-west/dundee month archive (two 48 h runs, 2026-08-10
     00Z and 12Z; hand-read from the published series, UTC−7):
     - 2026-08-09: 00Z covers 18:00–23:00 only (its 18:00 w* 0.84 misses
       the floor) — a truncated quiet sliver; 12Z never reaches the day.
     - 2026-08-10: both runs window 10:00–17:00 local; peaks 3764.5 m
       (00Z, 15:00) and 3719.3 m (12Z, 15:00) over the 1311 m launch.
     - 2026-08-11: both window 10:00–17:00, but 17:00 IS the 00Z run's
       last hour — a clipped end that must not read as timing.
     - 2026-08-12: 12Z covers 00:00–05:00 (quiet sliver), 00Z nothing. */
  const archive = new Uint8Array(
    readFileSync(join(__dirname, "fixtures", "hrdps-west-dundee-2026-08.jsonl.gz")),
  );
  const url = "https://example.test/data/hrdps-west/history/dundee/2026-08.jsonl.gz";
  const fetch: HistoryFetch = async (requested) => ({
    ok: requested === url,
    status: requested === url ? 200 : 404,
    arrayBuffer: async () => archive.slice().buffer as ArrayBuffer,
  });

  async function loadAndCompare(): Promise<RunComparison> {
    const loaded = (await loadProfileHistory({
      fetch,
      baseUrl: "https://example.test/data",
      modelSlug: "hrdps-west",
      siteSlug: "dundee",
      months: ["2026-08"],
    })) as LoadedHistory<WindgramProfile>;
    expect(loaded.runs).toHaveLength(2);
    return compareRuns(loaded.runs, {
      timeZone: "America/Vancouver",
      launch: { elevationM: 1311 },
      revisions: loaded.revisions,
    });
  }

  it("compares the loaded runs: ladder, clipped-edge timing, short-sample settled", async () => {
    const comparison = await loadAndCompare();
    expect(comparison.model).toBe("hrdps-west");
    expect(comparison.runs.map((run) => run.referenceTime)).toEqual([
      "2026-08-10T12:00:00Z",
      "2026-08-10T00:00:00Z",
    ]);
    expect(comparison.runs.map((run) => run.runAgeHours)).toEqual([0, 12]);
    // A clean archive: no revisions, no identity change, no drift finding.
    expect(comparison.findings.some((finding) => finding.kind === "identityDrift")).toBe(false);

    // 2026-08-09: nobody could call the day — both non-votes with reasons.
    const past = findingOf<ExistenceTrajectoryFinding>(comparison, "existenceTrajectory", "2026-08-09");
    expect(past.rungs.map(({ vote, abstained }) => ({ vote, abstained }))).toEqual([
      { vote: "abstained", abstained: "outOfHorizon" },
      { vote: "abstained", abstained: "truncatedDay" },
    ]);

    // 2026-08-10: both runs window; noon anchor T19:00Z gives leads 7/19.
    const today = findingOf<ExistenceTrajectoryFinding>(comparison, "existenceTrajectory", "2026-08-10");
    expect(today.rungs.map(({ vote, leadHours }) => ({ vote, leadHours }))).toEqual([
      { vote: "window", leadHours: 7 },
      { vote: "window", leadHours: 19 },
    ]);

    const timing10 = findingOf<TimingTrajectoryFinding>(comparison, "timingTrajectory", "2026-08-10");
    expect(timing10.starts.map((vote) => vote.at.local)).toEqual([
      "2026-08-10T10:00",
      "2026-08-10T10:00",
    ]);
    expect(timing10.startSpreadHours).toBe(0);
    expect(timing10.endSpreadHours).toBe(0);

    // 2026-08-11: the 00Z run's 17:00 end is its own horizon — one end
    // votes, so the spread is null, never a manufactured agreement.
    const timing11 = findingOf<TimingTrajectoryFinding>(comparison, "timingTrajectory", "2026-08-11");
    expect(timing11.starts).toHaveLength(2);
    expect(timing11.ends.map((vote) => vote.referenceTime)).toEqual(["2026-08-10T12:00:00Z"]);
    expect(timing11.endSpreadHours).toBeNull();

    const magnitude10 = findingOf<MagnitudeTrajectoryFinding>(comparison, "magnitudeTrajectory", "2026-08-10");
    expect(
      magnitude10.rungs.map(({ peakThermalVelocityMs, peakLiftAboveLaunchM, windowDurationHours }) => ({
        peakThermalVelocityMs,
        peakLiftAboveLaunchM,
        windowDurationHours,
      })),
    ).toEqual([
      { peakThermalVelocityMs: 2.55, peakLiftAboveLaunchM: 2408.3, windowDurationHours: 8 },
      { peakThermalVelocityMs: 2.63, peakLiftAboveLaunchM: 2453.5, windowDurationHours: 8 },
    ]);

    // Two runs cannot fill a three-run sample: settled is false for want
    // of arithmetic, and the null spread says so.
    for (const day of ["2026-08-09", "2026-08-10", "2026-08-11", "2026-08-12"]) {
      const settled = findingOf<SettledFinding>(comparison, "settled", day);
      expect(settled.settled).toBe(false);
      expect(settled.spreadM).toBeNull();
      expect(settled.sample).toHaveLength(2);
    }
  });
});

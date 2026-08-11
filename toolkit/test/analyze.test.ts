import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANALYSIS_FRAME_VERSION,
  ANALYZE_VOCABULARY_VERSION,
  analyzeProfile,
  DEFAULT_ANALYZE_THRESHOLDS,
  type AnalysisExtension,
  type BandShearFinding,
  type CapTimingFinding,
  type ConvectiveDayFinding,
  type DataCaveatsFinding,
  type EnsembleMembershipFinding,
  type ThermalWindowFinding,
  type LiftCeilingFinding,
  type PercentileCrossingFinding,
  type QuietDayFinding,
  type SmokeImpactFinding,
  type SmokeImpactJoinedFinding,
  type SmokeImpactProfileFinding,
  type TerrainMismatchFinding,
  type WindDirectionFinding,
  type WindExceedanceFinding,
  type WindSummaryFinding,
} from "../src/analyze/index.js";
import {
  parseSmokeDocument,
  parseWindgramProfile,
  type SmokeDocument,
  type WindgramProfile,
} from "../src/contract/index.js";

/* The fixtures are trimmed REAL published documents captured during the
   2026-08-08/09 evidence spike (provenance in the fixture file's note):
   hrrr-conus at erie (hourly deterministic with CAPE, CIN, and gusts),
   geps at flagpole (3-hourly 21-member ensemble — the terrain-deficit case
   and the CAPE member-dropout case), and reps at erie (3-hourly ensemble,
   none of the science families). Every vocabulary kind is exercised against
   the real shape that motivated it. */

const fixtures = JSON.parse(
  readFileSync(join(__dirname, "analyze-fixtures.json"), "utf-8"),
) as Record<string, unknown>;

function load(key: string): WindgramProfile {
  const profile = parseWindgramProfile(fixtures[key]);
  expect(profile, `${key} must satisfy the published contract`).not.toBeNull();
  return profile!;
}

const hrrr = () => load("hrrrConusErie");
const geps = () => load("gepsFlagpole");
const reps = () => load("repsErie");

/* The launches the spike analyzed against — ANALYSIS INPUTS since the
   launch-decoupling wave: the fixtures baked these as v1 site.altitudeM
   (which the contract now strips at parse), and AnalyzeOptions.launch is
   the only source. Same elevations, same expected numbers. */
const ERIE = { launch: { elevationM: 1247 } };
const FLAGPOLE = { launch: { elevationM: 1222 } };

function ofKind<T extends { kind: string }>(
  findings: readonly { kind: string }[],
  kind: T["kind"],
): T[] {
  return findings.filter((finding) => finding.kind === kind) as T[];
}

/* A synthetic ensemble document with hand-authored percentile blocks, so
   every percentileCrossing and dayBands expectation is checkable by hand
   against the floors (w* >= 0.9, depth >= 300 over the 1247 m erie launch
   — lift top must reach 1547). Hours are cloned from the real reps fixture
   (contract shape) and re-stamped: 3-hourly through 08-10T12:00Z, then a
   6-hourly tail — S1's live GEPS cadence switch in miniature.

   Local days (America/Vancouver, UTC−7):
   - 2026-08-09 (h1–h5): quiet except 21:00Z (14:00 local), where p25
     through p90 clear both floors and p10 fails both — the fragile day:
     p50 passes, p10 disagrees, minimal token p25. Starts at 11:00 local —
     a truncated day.
   - 2026-08-10 (h6–h10): quiet at p10/p25/p50 everywhere; p75 and p90
     clear at 18:00Z (11:00 local, 18 contributing lift members), p90
     alone also at 08-11T00:00Z (17:00 local, ceiledMembers 1) — the
     upside day, minimal token p75. Covered 02:00–23:00 local at its own
     cadence — the one fully-covered day.
   - 2026-08-11 (h11–h12): 18:00Z clears both floors at EVERY percentile —
     all-agree, nothing to cross. Ends at 11:00 local — truncated. */

type Ev = {
  members: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  ceiledMembers?: number;
};
function ev(
  p10: number,
  p25: number,
  p50: number,
  p75: number,
  p90: number,
  members = 21,
  ceiledMembers?: number,
): Ev {
  const value: Ev = { members, p10, p25, p50, p75, p90 };
  if (ceiledMembers !== undefined) value.ceiledMembers = ceiledMembers;
  return value;
}
const quietWstar = () => ev(0.1, 0.15, 0.2, 0.3, 0.4);
const quietTop = () => ev(1300, 1350, 1400, 1450, 1500);

function crossingFixture(): WindgramProfile {
  const doc = JSON.parse(JSON.stringify(fixtures["repsErie"])) as {
    hours: Array<{ validAt: string; derived: Record<string, unknown> }>;
  };
  const template = JSON.stringify(doc.hours[0]);
  const hour = (validAt: string, wstar: Ev, top: Ev) => {
    const clone = JSON.parse(template) as (typeof doc.hours)[number];
    clone.validAt = validAt;
    clone.derived.thermalVelocityMs = wstar;
    clone.derived.usableLiftTopM = top;
    return clone;
  };
  doc.hours = [
    hour("2026-08-09T18:00:00Z", quietWstar(), quietTop()),
    hour("2026-08-09T21:00:00Z", ev(0.5, 0.95, 1.2, 1.5, 1.8), ev(1500, 1600, 1900, 2200, 2500, 21, 0)),
    hour("2026-08-10T00:00:00Z", quietWstar(), quietTop()),
    hour("2026-08-10T03:00:00Z", quietWstar(), quietTop()),
    hour("2026-08-10T06:00:00Z", quietWstar(), quietTop()),
    hour("2026-08-10T09:00:00Z", quietWstar(), quietTop()),
    hour("2026-08-10T12:00:00Z", quietWstar(), quietTop()),
    hour("2026-08-10T18:00:00Z", ev(0.3, 0.5, 0.7, 1.1, 1.4), ev(1200, 1300, 1400, 1800, 2200, 18, 0)),
    hour("2026-08-11T00:00:00Z", ev(0.2, 0.4, 0.6, 0.85, 1.0), ev(1100, 1200, 1300, 1900, 2000, 21, 1)),
    hour("2026-08-11T06:00:00Z", quietWstar(), quietTop()),
    hour("2026-08-11T12:00:00Z", quietWstar(), quietTop()),
    hour("2026-08-11T18:00:00Z", ev(1.0, 1.2, 1.5, 1.8, 2.0), ev(1600, 1700, 1900, 2100, 2300)),
  ];
  const profile = parseWindgramProfile(doc);
  expect(profile).not.toBeNull();
  return profile!;
}

describe("the analysis envelope", () => {
  it("stamps the vocabulary version and the document's identity", () => {
    const analysis = analyzeProfile(hrrr(), ERIE);
    expect(analysis.vocabularyVersion).toBe(ANALYZE_VOCABULARY_VERSION);
    expect(analysis.model).toBe("hrrr-conus");
    expect(analysis.site).toEqual({ id: "erie", launchAltitudeM: 1247, modelElevationM: 1177.6 });
    expect(analysis.run.referenceTime).toBe("2026-08-08T18:00:00Z");
    expect(analysis.stepHours).toBe(1);
    expect(analysis.hours).toBe(24);
  });

  it("self-describes for comparison — resolved thresholds, deterministic, covered days", () => {
    // The three fields compareAnalyses validates instead of reconstructing
    // (Tier 2 §2): the resolved threshold echo, the deterministic verdict,
    // and the local days the hours actually touch.
    const analysis = analyzeProfile(hrrr(), {
      ...ERIE,
      thresholds: { thermalWindow: { wstarMinMs: 1.0 } },
    });
    expect(analysis.deterministic).toBe(true);
    expect(analysis.thresholds).toEqual({
      ...DEFAULT_ANALYZE_THRESHOLDS,
      thermalWindow: { ...DEFAULT_ANALYZE_THRESHOLDS.thermalWindow, wstarMinMs: 1.0 },
    });
    // 19:00Z 08-08 through 18:00Z 08-09 is local noon to 11:00 next day.
    expect(analysis.coveredDays).toEqual(["2026-08-08", "2026-08-09"]);
    // No overrides: the echo IS the defaults; the ensemble reads ensemble.
    const reps_ = analyzeProfile(reps(), ERIE);
    expect(reps_.thresholds).toEqual(DEFAULT_ANALYZE_THRESHOLDS);
    expect(reps_.deterministic).toBe(false);
  });

  it("computes coveredDays in the envelope's own zone — the same hours, different days", () => {
    // The same 24 hours read Sydney-local (UTC+10): 08-08T19:00Z is 05:00
    // on 08-09, 08-09T18:00Z is 04:00 on 08-10 — both day keys shift.
    const analysis = analyzeProfile(hrrr(), { ...ERIE, timeZone: "Australia/Sydney" });
    expect(analysis.coveredDays).toEqual(["2026-08-09", "2026-08-10"]);
  });

  it("reads local time from the document's own site.timeZone", () => {
    const analysis = analyzeProfile(hrrr(), ERIE);
    expect(analysis.timeZone).toBe("America/Vancouver");
    expect(analysis.timeZoneSource).toBe("document");
  });

  it("lets the caller override the timezone", () => {
    const analysis = analyzeProfile(hrrr(), { ...ERIE, timeZone: "America/Edmonton" });
    expect(analysis.timeZone).toBe("America/Edmonton");
    expect(analysis.timeZoneSource).toBe("override");
    const window = ofKind<ThermalWindowFinding>(analysis.findings, "thermalWindow")[0];
    expect(window.start.local).toBe("2026-08-08T13:00"); // one hour east of Vancouver
  });

  it("falls back to UTC when nothing declares a zone, and says so in dataCaveats", () => {
    const undeclared = hrrr();
    delete (undeclared.site as { timeZone?: string }).timeZone;
    const analysis = analyzeProfile(undeclared);
    expect(analysis.timeZone).toBe("UTC");
    expect(analysis.timeZoneSource).toBe("utcFallback");
    const caveats = ofKind<DataCaveatsFinding>(analysis.findings, "dataCaveats")[0];
    expect(caveats.caveats).toContainEqual({ caveat: "timesAreUtc" });
  });

  it("analyzes launch-free when no launch is supplied — the honest fallback", () => {
    // Documents are launch-agnostic: without AnalyzeOptions.launch the
    // envelope carries no launch, launch-relative peaks are null, and the
    // depth arithmetic reads against the model's own ground.
    const analysis = analyzeProfile(hrrr());
    expect(analysis.site.launchAltitudeM).toBeNull();
    const windows = ofKind<ThermalWindowFinding>(analysis.findings, "thermalWindow");
    expect(windows.length).toBeGreaterThan(0);
    for (const window of windows) {
      expect(window.peakLiftTopAboveLaunchM).toBeNull();
    }
  });

  it("emits only the versioned vocabulary — kinds are a closed, versioned set", () => {
    const kinds = new Set(
      [
        analyzeProfile(hrrr(), ERIE),
        analyzeProfile(geps(), FLAGPOLE),
        analyzeProfile(reps(), ERIE),
      ].flatMap((analysis) => analysis.findings.map((finding) => finding.kind)),
    );
    for (const kind of kinds) {
      expect([
        "terrainMismatch",
        "dataCaveats",
        "ensembleMembership",
        "capTiming",
        "convectiveDay",
        "thermalWindow",
        "percentileCrossing",
        "quietDay",
        "liftCeiling",
        "smokeImpact",
        "windSummary",
        "windExceedance",
        "windDirection",
        "bandShear",
      ]).toContain(kind);
    }
  });
});

describe("thermalWindow", () => {
  it("finds the deterministic afternoon window with local timing and launch-relative peak", () => {
    const findings = ofKind<ThermalWindowFinding>(
      analyzeProfile(hrrr(), ERIE).findings,
      "thermalWindow",
    );
    const saturday = findings.find((finding) => finding.day === "2026-08-08")!;
    // The spike's window on this document (its local clock approximated
    // UTC-8; these are the same UTC hours read in real Pacific daylight time).
    expect(saturday.start).toEqual({ validAt: "2026-08-08T19:00:00Z", local: "2026-08-08T12:00" });
    expect(saturday.end).toEqual({ validAt: "2026-08-09T01:00:00Z", local: "2026-08-08T18:00" });
    expect(saturday.durationHours).toBe(7);
    expect(saturday.peakLiftTopM).toBe(2905.6);
    expect(saturday.peakLiftTopAboveLaunchM).toBe(1658.6); // 2905.6 − 1247 launch
    expect(saturday.peakThermalVelocityMs).toBe(2.16); // contract 2-dp: the raw published value
    // The thresholds that produced the window are embedded in it.
    expect(saturday.thresholds).toEqual(DEFAULT_ANALYZE_THRESHOLDS.thermalWindow);
    // Evidence is scoped to exactly the cited hours.
    expect(saturday.evidence.hours).toHaveLength(7);
    expect(saturday.evidence.usableLiftTopM[4]).toBe(2905.6);
    expect(saturday.evidence.liftTopBandP10P90).toBeUndefined(); // deterministic document
  });

  it("stamps forecast lead and the cadence echo on every window", () => {
    // leadHours anchors on the day's peak-lift hour (the claim's central
    // instant); stepHours echoes the window's own quantization bound.
    const hrrrWindows = ofKind<ThermalWindowFinding>(
      analyzeProfile(hrrr(), ERIE).findings,
      "thermalWindow",
    );
    const saturday = hrrrWindows.find((finding) => finding.day === "2026-08-08")!;
    // Run 2026-08-08T18:00Z, peak lift at 23:00Z — five hours out.
    expect(saturday.leadHours).toBe(5);
    expect(saturday.stepHours).toBe(1);
    const sunday = hrrrWindows.find((finding) => finding.day === "2026-08-09")!;
    expect(sunday.leadHours).toBe(24);

    const repsWindows = ofKind<ThermalWindowFinding>(
      analyzeProfile(reps(), ERIE).findings,
      "thermalWindow",
    );
    // Same run hour, 3-hourly document: peak at 21:00Z, three hours out,
    // and the duration's quantization (one 3-hour step) rides along.
    expect(repsWindows[0].leadHours).toBe(3);
    expect(repsWindows[0].stepHours).toBe(3);
  });

  it("bridges sub-threshold dips only when asked — maxGapHours states the segmentation convention", () => {
    // One mid-window hour dips under the W* floor: 22:00Z at 0.85.
    const dipped = hrrr();
    for (const hour of dipped.hours) {
      if (hour.validAt === "2026-08-08T22:00:00Z") {
        (hour.derived as { thermalVelocityMs: number }).thermalVelocityMs = 0.85;
      }
    }
    // Default 0: the dip splits the day into two windows — v3 behaviour.
    const split = ofKind<ThermalWindowFinding>(
      analyzeProfile(dipped, ERIE).findings,
      "thermalWindow",
    ).filter((finding) => finding.day === "2026-08-08");
    expect(split.map((finding) => [finding.start.validAt, finding.end.validAt])).toEqual([
      ["2026-08-08T19:00:00Z", "2026-08-08T21:00:00Z"],
      ["2026-08-08T23:00:00Z", "2026-08-09T01:00:00Z"],
    ]);
    // maxGapHours 1 bridges the one-hour dip into a single window; the
    // bridged hour stays in the cited evidence, dip visible.
    const merged = ofKind<ThermalWindowFinding>(
      analyzeProfile(dipped, {
        ...ERIE,
        thresholds: { thermalWindow: { maxGapHours: 1 } },
      }).findings,
      "thermalWindow",
    ).filter((finding) => finding.day === "2026-08-08");
    expect(merged).toHaveLength(1);
    expect(merged[0].start.validAt).toBe("2026-08-08T19:00:00Z");
    expect(merged[0].end.validAt).toBe("2026-08-09T01:00:00Z");
    expect(merged[0].durationHours).toBe(7);
    expect(merged[0].peakLiftTopM).toBe(2905.6); // the far run's peak carries
    const dipIndex = merged[0].evidence.hours.indexOf("2026-08-08T22:00:00Z");
    expect(merged[0].evidence.thermalVelocityMs[dipIndex]).toBe(0.85);
    expect(merged[0].thresholds).toEqual({ wstarMinMs: 0.9, depthMinM: 300, maxGapHours: 1 });
  });

  it("never bridges a data hole — a null hour is not a forecast dip", () => {
    // The same gap, but the hour publishes no lift top at all: bridging
    // would manufacture continuity over data the model never forecast.
    const holed = hrrr();
    for (const hour of holed.hours) {
      if (hour.validAt === "2026-08-08T22:00:00Z") {
        (hour.derived as { usableLiftTopM: number | null }).usableLiftTopM = null;
      }
    }
    const windows = ofKind<ThermalWindowFinding>(
      analyzeProfile(holed, {
        ...ERIE,
        thresholds: { thermalWindow: { maxGapHours: 1 } },
      }).findings,
      "thermalWindow",
    ).filter((finding) => finding.day === "2026-08-08");
    expect(windows.map((finding) => [finding.start.validAt, finding.end.validAt])).toEqual([
      ["2026-08-08T19:00:00Z", "2026-08-08T21:00:00Z"],
      ["2026-08-08T23:00:00Z", "2026-08-09T01:00:00Z"],
    ]);
  });

  it("moves with the caller's thresholds — they are conventions, not physics", () => {
    const strict = analyzeProfile(hrrr(), {
      ...ERIE,
      thresholds: { thermalWindow: { wstarMinMs: 2.1, depthMinM: 1500 } },
    });
    const findings = ofKind<ThermalWindowFinding>(strict.findings, "thermalWindow");
    expect(findings).toHaveLength(1);
    // Only 22:00Z clears both bars (top 2826.3 = 1579 m over launch, W* 2.16).
    expect(findings[0].durationHours).toBe(1);
    expect(findings[0].start.validAt).toBe("2026-08-08T22:00:00Z");
    expect(findings[0].thresholds).toEqual({ wstarMinMs: 2.1, depthMinM: 1500, maxGapHours: 0 });
  });

  it("states the negative: a day with no window emits quietDay with the numbers that failed", () => {
    // Impossible W* floor: every day is quiet, and the finding says why.
    const strict = analyzeProfile(hrrr(), {
      ...ERIE,
      thresholds: { thermalWindow: { wstarMinMs: 99, depthMinM: 300 } },
    });
    expect(ofKind<ThermalWindowFinding>(strict.findings, "thermalWindow")).toHaveLength(0);
    const quiet = ofKind<QuietDayFinding>(strict.findings, "quietDay");
    const saturday = quiet.find((finding) => finding.day === "2026-08-08")!;
    expect(saturday.failed).toEqual(["wstar"]);
    // The evidence is the day's best hour against each floor.
    expect(saturday.peakThermalVelocityMs).toBe(2.16); // contract 2-dp: the raw published value
    expect(saturday.peakLiftDepthM).toBe(1658.6);
    expect(saturday.peakLiftDepthAt?.validAt).toBe("2026-08-08T23:00:00Z");
    expect(saturday.thresholds).toEqual({ wstarMinMs: 99, depthMinM: 300 });
  });

  it("prints m/s evidence at contract precision — a 0.89 w* under a 0.9 floor says 0.89", () => {
    // The defect this pins: round1 coarsened stated m/s magnitudes to one
    // decimal, so a raw w* of 0.89 voted quiet against a 0.9 floor while
    // the printed evidence said 0.9 — the finding contradicted its own
    // evidence. m/s magnitudes ship at the contract's two decimals
    // (pipeline publish _FIELD_DECIMALS); the vote reads raw values.
    const profile = hrrr();
    for (const hour of profile.hours) {
      (hour.derived as { thermalVelocityMs: number }).thermalVelocityMs = 0.89;
    }
    const analysis = analyzeProfile(profile, {
      ...ERIE,
      thresholds: { thermalWindow: { wstarMinMs: 0.9, depthMinM: 300 } },
    });
    expect(ofKind<ThermalWindowFinding>(analysis.findings, "thermalWindow")).toHaveLength(0);
    const saturday = ofKind<QuietDayFinding>(analysis.findings, "quietDay").find(
      (finding) => finding.day === "2026-08-08",
    )!;
    expect(saturday.failed).toEqual(["wstar"]);
    // The quiet vote and its printed evidence agree: 0.89 sits under 0.9.
    expect(saturday.peakThermalVelocityMs).toBe(0.89);
    expect(saturday.peakThermalVelocityMs!).toBeLessThan(saturday.thresholds.wstarMinMs);
  });

  it("flags horizon truncation: a quiet call from a sliver of a day is a data boundary", () => {
    const quiet = ofKind<QuietDayFinding>(analyzeProfile(geps(), FLAGPOLE).findings, "quietDay");
    const byDay = Object.fromEntries(quiet.map((finding) => [finding.day, finding]));
    // The fully-covered middle day is a REAL quiet day (the terrain case).
    expect(byDay["2026-08-09"].coverage.truncated).toBe(false);
    expect(byDay["2026-08-09"].coverage.hours).toBe(24);
    // The first day misses its early hours; the last covers 02:00-05:00
    // local only — pre-thermic slivers whose "quiet" is the horizon.
    expect(byDay["2026-08-08"].coverage.truncated).toBe(true);
    expect(byDay["2026-08-10"].coverage.truncated).toBe(true);
    expect(byDay["2026-08-10"].coverage.hours).toBe(6);
  });

  it("marks windows clipped by the document's own horizon at either edge", () => {
    const windows = ofKind<ThermalWindowFinding>(analyzeProfile(hrrr(), ERIE).findings, "thermalWindow");
    const byDay = Object.fromEntries(windows.map((finding) => [finding.day, finding]));
    // The document opens mid-window and ends mid-window: the first
    // window's start and the last window's end are data boundaries.
    expect(byDay["2026-08-08"].clippedAtStart).toBe(true);
    expect(byDay["2026-08-08"].clippedAtEnd).toBe(false);
    expect(byDay["2026-08-09"].clippedAtStart).toBe(false);
    expect(byDay["2026-08-09"].clippedAtEnd).toBe(true);
  });

  it("emits no quietDay for a day any window hour touches", () => {
    const findings = analyzeProfile(hrrr(), ERIE).findings;
    const windowDays = new Set(
      ofKind<ThermalWindowFinding>(findings, "thermalWindow").map((finding) => finding.day),
    );
    for (const quiet of ofKind<QuietDayFinding>(findings, "quietDay")) {
      expect(windowDays.has(quiet.day)).toBe(false);
    }
  });

  it("reads ensembles at p50 and carries the p10-p90 lift-top band as evidence", () => {
    const findings = ofKind<ThermalWindowFinding>(
      analyzeProfile(reps(), ERIE).findings,
      "thermalWindow",
    );
    expect(findings.map((finding) => finding.day)).toEqual(["2026-08-08", "2026-08-09"]);
    const saturday = findings[0];
    expect(saturday.durationHours).toBe(3); // one 3-hourly step
    expect(saturday.peakLiftTopM).toBe(2853.2);
    expect(saturday.evidence.liftTopBandP10P90).toEqual([[2732.8, 3006.5]]);
  });

  it("finds nothing at the terrain-mismatch site — lift tops never reach 300 m over launch", () => {
    expect(ofKind(analyzeProfile(geps(), FLAGPOLE).findings, "thermalWindow")).toHaveLength(0);
  });
});

describe("quietDay context — the atmospheric WHY beside the arithmetic why", () => {
  /** Every hrrr day quiet: the impossible W* floor from the tests above. */
  const QUIET = { ...ERIE, thresholds: { thermalWindow: { wstarMinMs: 99 } } };
  const quietDays = (profile: WindgramProfile, options: object = QUIET) =>
    ofKind<QuietDayFinding>(analyzeProfile(profile, options).findings, "quietDay");

  it("stamps forecast lead anchored on the day's peak-W* hour", () => {
    const byDay = Object.fromEntries(quietDays(hrrr()).map((finding) => [finding.day, finding]));
    // Run 2026-08-08T18:00Z; Saturday's peak W* (2.16) fires at 22:00Z.
    expect(byDay["2026-08-08"].peakThermalVelocityAt?.validAt).toBe("2026-08-08T22:00:00Z");
    expect(byDay["2026-08-08"].leadHours).toBe(4);
    // Sunday's peak W* (1.1) fires at 18:00Z the next day — 24 h out.
    expect(byDay["2026-08-09"].leadHours).toBe(24);
  });

  it("restates cloud, gust, and flux with cited timing — co-timing, never causality", () => {
    const saturday = quietDays(hrrr()).find((finding) => finding.day === "2026-08-08")!;
    expect(saturday.context.cloudCoverAtPeakWstarPercent).toBe(100);
    expect(saturday.context.daytimeCloudCoverPercent).toBe(100); // 19:00-23:00Z all 100 %
    expect(saturday.context.maxGust).toEqual({
      gustMs: 3.9,
      at: { validAt: "2026-08-08T23:00:00Z", local: "2026-08-08T16:00" },
    });
    expect(saturday.context.peakSensibleHeatFluxWm2).toEqual({
      valueWm2: 280,
      at: { validAt: "2026-08-08T21:00:00Z", local: "2026-08-08T14:00" },
    });
    // A dry day carries no precipitation block, and no verdict anywhere.
    expect(saturday.context.precipitation).toBeUndefined();
    expect(JSON.stringify(saturday)).not.toMatch(/verdict/i);
  });

  it("carries BOTH the peak-hour cloud sample and the daytime aggregate — either alone misleads", () => {
    // S4's live divergence in miniature: the peak W* fires in a clearing
    // (12 %) while the day sits overcast (85 % on the other daytime hours).
    const profile = hrrr();
    for (const hour of profile.hours) {
      const surface = hour.surface as { cloudCoverPercent: number };
      if (hour.validAt === "2026-08-08T22:00:00Z") surface.cloudCoverPercent = 12;
      else if (
        ["2026-08-08T19:00:00Z", "2026-08-08T20:00:00Z", "2026-08-08T21:00:00Z", "2026-08-08T23:00:00Z"].includes(
          hour.validAt,
        )
      )
        surface.cloudCoverPercent = 85;
    }
    const saturday = quietDays(profile).find((finding) => finding.day === "2026-08-08")!;
    expect(saturday.peakThermalVelocityAt?.validAt).toBe("2026-08-08T22:00:00Z");
    expect(saturday.context.cloudCoverAtPeakWstarPercent).toBe(12);
    // Local 10:00-16:00 covered samples: 19:00-23:00Z → (4×85 + 12) / 5.
    expect(saturday.context.daytimeCloudCoverPercent).toBe(70.4);
  });

  it("states the wet day over the embedded floor, with the semantics and step echoes", () => {
    const profile = hrrr();
    const rates: Record<string, number> = {
      "2026-08-08T20:00:00Z": 0.5,
      "2026-08-08T21:00:00Z": 1.2,
      "2026-08-08T22:00:00Z": 0.8,
    };
    for (const hour of profile.hours) {
      const rate = rates[hour.validAt];
      if (rate !== undefined) (hour.surface as { precipitationMmHr: number }).precipitationMmHr = rate;
    }
    (profile as { semantics?: object }).semantics = { precipitation: "instantRate" };
    const parsed = parseWindgramProfile(profile)!;
    const saturday = quietDays(parsed).find((finding) => finding.day === "2026-08-08")!;
    expect(saturday.context.precipitation).toEqual({
      peakMmHr: 1.2,
      peakAt: { validAt: "2026-08-08T21:00:00Z", local: "2026-08-08T14:00" },
      firstWetAt: { validAt: "2026-08-08T20:00:00Z", local: "2026-08-08T13:00" },
      wetHours: 3,
      minMmHr: DEFAULT_ANALYZE_THRESHOLDS.capTiming.precipMinMmHr,
      semantics: "instantRate",
      stepHours: 1,
    });
  });

  it("omits maxGust where the model publishes none — absent is not calm", () => {
    // REPS is gustless; under the impossible floor both its days are quiet.
    const findings = quietDays(reps());
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.context.maxGust).toBeUndefined();
      // The flux restatement still rides — REPS publishes it.
      expect(finding.context.peakSensibleHeatFluxWm2).toBeDefined();
    }
  });

  it("reads honestly when empty: no atmospheric suppressor stated, the flux was simply weak", () => {
    const profile = hrrr();
    for (const hour of profile.hours) {
      (hour.surface as { cloudCoverPercent: number }).cloudCoverPercent = 0;
    }
    const saturday = quietDays(profile).find((finding) => finding.day === "2026-08-08")!;
    expect(saturday.context.precipitation).toBeUndefined();
    expect(saturday.context.cloudCoverAtPeakWstarPercent).toBe(0);
    expect(saturday.context.daytimeCloudCoverPercent).toBe(0);
    // Nothing atmospheric is asserted — the published restatements are all
    // the block says, and none of them names a suppressor.
  });
});

describe("liftCeiling", () => {
  it("attributes the deterministic window's ceiling to sink, citing the segment's peak", () => {
    const findings = ofKind<LiftCeilingFinding>(analyzeProfile(hrrr(), ERIE).findings, "liftCeiling");
    const saturday = findings.find((finding) => finding.day === "2026-08-08")!;
    expect(saturday.segments).toHaveLength(1);
    expect(saturday.segments[0].cause).toBe("sinkLimited");
    expect(saturday.segments[0].hoursN).toBe(7);
    // The Tier 0 fix this pins: the 7-hour segment's evidence is its PEAK
    // hour (23:00Z, top 2905.6), not its first (19:00Z, top 1840.7) — the
    // pre-v4 frozen-first-hour evidence did not represent the claim. Cloud
    // base and BL top are sampled at that same cited hour, so the
    // sinkLimited relation re-derives from the printed row.
    expect(saturday.segments[0].evidence).toEqual({
      peakUsableLiftTopM: 2905.6,
      peakUsableLiftTopAt: { validAt: "2026-08-08T23:00:00Z", local: "2026-08-08T16:00" },
      cloudBaseM: 3401.7,
      boundaryLayerTopM: 2771.2,
    });
    expect(saturday.thresholds).toEqual(DEFAULT_ANALYZE_THRESHOLDS.liftCeiling);
    // flips was removed at v4: it restated segments.length - 1.
    expect("flips" in saturday).toBe(false);
  });

  it("calls the REPS windows cloud-capped — base sits on (or within 50 m of) the top", () => {
    const findings = ofKind<LiftCeilingFinding>(analyzeProfile(reps(), ERIE).findings, "liftCeiling");
    expect(findings).toHaveLength(2);
    for (const finding of findings) {
      expect(finding.segments[0].cause).toBe("cloudCapped");
    }
    // Sunday's is exact: usable lift top IS the published cloud base.
    expect(findings[1].segments[0].evidence.peakUsableLiftTopM).toBe(2543.2);
    expect(findings[1].segments[0].evidence.cloudBaseM).toBe(2543.2);
  });
});

describe("capTiming", () => {
  it("tells the deterministic cap story with local timing and full-day evidence", () => {
    const findings = ofKind<CapTimingFinding>(analyzeProfile(hrrr(), ERIE).findings, "capTiming");
    const saturday = findings.find((finding) => finding.day === "2026-08-08")!;
    expect(saturday.verdict).toBe("capBreaks");
    expect(saturday.cadence).toBe("hourly");
    expect(saturday.stepHours).toBe(1);
    expect(saturday.peakCapeJkg).toBe(540);
    // |CIN| drops under 25 while CAPE exceeds 200 at 18:00 local — the
    // arithmetic the verdict names, one hour before the window closes.
    expect(saturday.capBreaksAt).toEqual({
      validAt: "2026-08-09T01:00:00Z",
      local: "2026-08-08T18:00",
    });
    expect(saturday.capBreaksBetween).toBeUndefined(); // hourly = instant verdicts
    expect(saturday.capeAtBreakJkg).toBe(540);
    expect(saturday.thermalWindowEndsAt?.local).toBe("2026-08-08T18:00");
    expect(saturday.thresholds).toEqual(DEFAULT_ANALYZE_THRESHOLDS.capTiming);
    expect(saturday.evidence.capeJkg).toContain(540);
    expect(saturday.evidence.hours).toHaveLength(saturday.evidence.cinJkg.length);

    const sunday = findings.find((finding) => finding.day === "2026-08-09")!;
    expect(sunday.verdict).toBe("noInstability");
    expect(sunday.peakCapeJkg).toBe(0);
  });

  it("gates itself off ensembles — the median-CIN gate is untouched at v4", () => {
    // GEPS publishes CAPE and CIN, but as 3-hourly ensemble percentiles:
    // the spike found the member-median CIN bimodal, so no cap story.
    expect(ofKind(analyzeProfile(geps(), FLAGPOLE).findings, "capTiming")).toHaveLength(0);
    expect(ofKind(analyzeProfile(reps(), ERIE).findings, "capTiming")).toHaveLength(0);
  });

  it("splits the old cappedAllDay: an all-day-open cap under the break floor reads openButWeak", () => {
    // The live RDPS shape S4 caught twice: CIN ≈ 0 all day (cap physically
    // open), CAPE 100-190 — instability, but never over the 200 J/kg break
    // floor. Before v4 this read "cappedAllDay" with the cap wide open.
    const profile = hrrr();
    for (const hour of profile.hours) {
      const surface = hour.surface as { capeJkg: number; cinJkg: number };
      if (hour.validAt <= "2026-08-09T06:00:00Z") {
        surface.capeJkg = Math.min(150, surface.capeJkg + 150);
        surface.cinJkg = -5;
      }
    }
    const saturday = ofKind<CapTimingFinding>(
      analyzeProfile(profile, ERIE).findings,
      "capTiming",
    ).find((finding) => finding.day === "2026-08-08")!;
    expect(saturday.verdict).toBe("openButWeak");
    expect(saturday.peakCapeJkg).toBe(150); // >= 100 instability, < 200 break floor
    expect(saturday.capBreaksAt).toBeUndefined();
    // Every evidence row agrees: |CIN| under the 25 J/kg threshold all day.
    for (const cin of saturday.evidence.cinJkg) {
      expect(Math.abs(cin)).toBeLessThan(saturday.thresholds.brokenCapMaxAbsCinJkg);
    }
  });

  it("keeps cappedAllDay for the cap that actually holds", () => {
    // Same instability, but the cap is real: CIN -80 wherever CAPE lives.
    const profile = hrrr();
    for (const hour of profile.hours) {
      const surface = hour.surface as { capeJkg: number; cinJkg: number };
      if (hour.validAt <= "2026-08-09T06:00:00Z") {
        surface.capeJkg = 300;
        surface.cinJkg = -80;
      }
    }
    const saturday = ofKind<CapTimingFinding>(
      analyzeProfile(profile, ERIE).findings,
      "capTiming",
    ).find((finding) => finding.day === "2026-08-08")!;
    expect(saturday.verdict).toBe("cappedAllDay");
  });
});

describe("capTiming at multi-hour cadence — interval verdicts (v4, S4)", () => {
  /** The hrrr fixture subsampled to a 3-hourly grid; `offset` picks which
   * hours survive, so the same hourly truth reads from different grids. */
  function threeHourly(offset: number, count = 4): WindgramProfile {
    const doc = JSON.parse(JSON.stringify(fixtures["hrrrConusErie"])) as { hours: unknown[] };
    doc.hours = Array.from({ length: count }, (_, k) => doc.hours[offset + 3 * k]);
    const profile = parseWindgramProfile(doc);
    expect(profile).not.toBeNull();
    return profile!;
  }

  it("re-admits 3-hourly days with an interval between adjacent cited steps", () => {
    // Grid 19:00Z/22:00Z/01:00Z/04:00Z. The hourly truth breaks at 01:00Z
    // (CAPE 540, CIN -9); the interval CONTAINS it (S4: 16/16 containment,
    // zero phantom breaks in the subsampling audit).
    const findings = ofKind<CapTimingFinding>(
      analyzeProfile(threeHourly(0), ERIE).findings,
      "capTiming",
    );
    const saturday = findings.find((finding) => finding.day === "2026-08-08")!;
    expect(saturday.verdict).toBe("capBreaks");
    expect(saturday.cadence).toBe("multiHour");
    expect(saturday.stepHours).toBe(3);
    expect(saturday.capBreaksAt).toBeUndefined(); // interval, never an instant
    expect(saturday.capBreaksBetween).toEqual({
      after: { validAt: "2026-08-08T22:00:00Z", local: "2026-08-08T15:00" },
      by: { validAt: "2026-08-09T01:00:00Z", local: "2026-08-08T18:00" },
    });
    expect(saturday.capeAtBreakJkg).toBe(540);
    // Both endpoints are the evidence's own cited steps.
    expect(saturday.evidence.hours).toContain("2026-08-08T22:00:00Z");
    expect(saturday.evidence.hours).toContain("2026-08-09T01:00:00Z");
  });

  it("states the day edge as its own case: cap already open at first covered step", () => {
    // The document opens ON the broken step (01:00Z): there is no earlier
    // cited step to bound an interval — the 5-live-GDPS-site-days shape.
    const doc = JSON.parse(JSON.stringify(fixtures["hrrrConusErie"])) as { hours: unknown[] };
    doc.hours = [doc.hours[6], doc.hours[9]]; // 01:00Z, 04:00Z — both local 08-08
    const profile = parseWindgramProfile(doc)!;
    const findings = ofKind<CapTimingFinding>(analyzeProfile(profile, ERIE).findings, "capTiming");
    expect(findings).toHaveLength(1);
    expect(findings[0].verdict).toBe("capBreaks");
    expect(findings[0].capAlreadyOpenAt).toEqual({
      validAt: "2026-08-09T01:00:00Z",
      local: "2026-08-08T18:00",
    });
    expect(findings[0].capBreaksBetween).toBeUndefined();
  });

  it("confesses what a multi-hour cappedAllDay is: no PUBLISHED step was broken", () => {
    // Grid 20:00Z/23:00Z/02:00Z/05:00Z misses the 01:00Z break entirely:
    // every published step is capped or weak, so the verdict is
    // cappedAllDay while the hourly truth breaks — the measured 12.5 %
    // phantom-cap rate this shape carries (JSDoc), stated as a claim about
    // published steps via cadence: "multiHour".
    const findings = ofKind<CapTimingFinding>(
      analyzeProfile(threeHourly(1), ERIE).findings,
      "capTiming",
    );
    const saturday = findings.find((finding) => finding.day === "2026-08-08")!;
    expect(saturday.verdict).toBe("cappedAllDay");
    expect(saturday.cadence).toBe("multiHour");
    expect(saturday.peakCapeJkg).toBe(350);
    // The same document's hourly truth: capBreaks at 01:00Z.
    const hourly = ofKind<CapTimingFinding>(analyzeProfile(hrrr(), ERIE).findings, "capTiming");
    expect(hourly.find((finding) => finding.day === "2026-08-08")!.verdict).toBe("capBreaks");
  });

  it("echoes the precipitation semantics beside the threshold it compares against", () => {
    const doc = JSON.parse(JSON.stringify(fixtures["hrrrConusErie"])) as {
      semantics?: object;
      hours: Array<{ surface: { precipitationMmHr: number } }>;
    };
    doc.semantics = { precipitation: "windowMeanRate" };
    doc.hours[5].surface.precipitationMmHr = 0.85; // 00:00Z, local 08-08
    const profile = parseWindgramProfile(doc)!;
    const saturday = ofKind<CapTimingFinding>(
      analyzeProfile(profile, ERIE).findings,
      "capTiming",
    ).find((finding) => finding.day === "2026-08-08")!;
    expect(saturday.precipSemantics).toBe("windowMeanRate");
    expect(saturday.precipStartsAt?.validAt).toBe("2026-08-09T00:00:00Z");
    expect(saturday.peakPrecipMmHr).toBe(0.85); // contract 2-dp for mm/h
  });
});

describe("convectiveDay — the CIN-less convective story (v4, S4)", () => {
  const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

  /** An HRDPS-shaped document built from the hrrr fixture: CIN deleted
   * everywhere (the HRDPS family publishes CAPE with no CIN), hours
   * re-stamped hourly from `firstValidAt` so full days and horizon
   * slivers can both be constructed; CAPE optionally overridden. */
  function cinless(firstValidAt: string, count: number, capes?: number[]): WindgramProfile {
    const doc = JSON.parse(JSON.stringify(fixtures["hrrrConusErie"])) as {
      hours: Array<{ validAt: string; surface: { capeJkg?: number; cinJkg?: number } }>;
    };
    const start = Date.parse(firstValidAt);
    doc.hours = doc.hours.slice(0, count).map((hour, k) => {
      delete hour.surface.cinJkg;
      if (capes) hour.surface.capeJkg = capes[k];
      return { ...hour, validAt: iso(start + k * 3_600_000) };
    });
    const profile = parseWindgramProfile(doc);
    expect(profile).not.toBeNull();
    return profile!;
  }

  it("states CAPE magnitude and timing where capTiming is mute, refusing the cap question", () => {
    // A full local day: 24 hourly rows re-stamped 07:00Z-06:00Z, local
    // 00:00-23:00. The fixture's CAPE ridge (peak 540) lands at index 6.
    const profile = cinless("2026-08-08T07:00:00Z", 24);
    const analysis = analyzeProfile(profile, ERIE);
    // The un-gating: no CIN means capTiming stays silent…
    expect(ofKind(analysis.findings, "capTiming")).toHaveLength(0);
    // …and convectiveDay now carries what the model CAN say.
    const findings = ofKind<ConvectiveDayFinding>(analysis.findings, "convectiveDay");
    expect(findings).toHaveLength(1);
    const day = findings[0];
    expect(day.day).toBe("2026-08-08");
    expect(day.peakCapeJkg).toBe(540);
    expect(day.peakCapeAt).toEqual({ validAt: "2026-08-08T13:00:00Z", local: "2026-08-08T06:00" });
    // The refusal is explicit: absence of CIN is never "no cap".
    expect(day.capIsJudgeable).toBe(false);
    expect(day.capNotJudgeableReason).toBe("modelPublishesNoCin");
    expect(JSON.stringify(day)).not.toMatch(/verdict/i);
    // Full-day coverage, stated.
    expect(day.coverage.truncated).toBe(false);
    expect(day.coverage.hours).toBe(24);
    expect(day.stepHours).toBe(1);
    // The window anchor rides along, as on capTiming (this re-stamped day
    // carries two windows; the anchor is the day's last window's end).
    expect(day.thermalWindowEndsAt?.validAt).toBe("2026-08-09T06:00:00Z");
    expect(day.thresholds).toEqual(DEFAULT_ANALYZE_THRESHOLDS.convectiveDay);
    // Evidence arrays cover exactly the cited hours.
    expect(day.evidence.hours).toHaveLength(24);
    expect(day.evidence.capeJkg[6]).toBe(540);
    expect(day.evidence.precipitationMmHr).toHaveLength(24);
  });

  it("states the dry forecast positively — a 0.00 series is a forecast, not absence", () => {
    const day = ofKind<ConvectiveDayFinding>(
      analyzeProfile(cinless("2026-08-08T07:00:00Z", 24), ERIE).findings,
      "convectiveDay",
    )[0];
    // No covered hour exceeds the floor: the honest positive, and exactly
    // one of the two precip statements is present.
    expect(day.noPrecipAboveThreshold).toBe(true);
    expect(day.precipStartsAt).toBeUndefined();
    expect(day.peakPrecipMmHr).toBeUndefined();
  });

  it("carries precip timing over the embedded floor, with the semantics echo", () => {
    const profile = cinless("2026-08-08T07:00:00Z", 24);
    const rates: Record<string, number> = {
      "2026-08-08T15:00:00Z": 0.3,
      "2026-08-08T16:00:00Z": 1.46,
      "2026-08-08T17:00:00Z": 0.8,
    };
    for (const hour of profile.hours) {
      const rate = rates[hour.validAt];
      if (rate !== undefined) (hour.surface as { precipitationMmHr: number }).precipitationMmHr = rate;
    }
    (profile as { semantics?: object }).semantics = { precipitation: "windowMeanRate" };
    const parsed = parseWindgramProfile(profile)!;
    const day = ofKind<ConvectiveDayFinding>(
      analyzeProfile(parsed, ERIE).findings,
      "convectiveDay",
    )[0];
    expect(day.precipStartsAt).toEqual({
      validAt: "2026-08-08T15:00:00Z",
      local: "2026-08-08T08:00",
    });
    expect(day.peakPrecipMmHr).toBe(1.46); // contract 2-dp for mm/h
    expect(day.noPrecipAboveThreshold).toBeUndefined();
    expect(day.precipSemantics).toBe("windowMeanRate");
    // The threshold is caller-movable: raise the floor over the peak and
    // the same day reads dry, positively.
    const strict = ofKind<ConvectiveDayFinding>(
      analyzeProfile(parsed, { ...ERIE, thresholds: { convectiveDay: { precipMinMmHr: 2 } } })
        .findings,
      "convectiveDay",
    )[0];
    expect(strict.noPrecipAboveThreshold).toBe(true);
    expect(strict.thresholds.precipMinMmHr).toBe(2);
  });

  it("confesses the horizon sliver — nocturnal CAPE on a truncated day is not a soaring statement", () => {
    // S4's live HRDPS 08-12 shape: a 00:00-05:00 local sliver carrying
    // elevated nocturnal CAPE, day peak cited at 01:00.
    const sliver = cinless("2026-08-12T07:00:00Z", 6, [100, 294, 250, 180, 120, 100]);
    const day = ofKind<ConvectiveDayFinding>(
      analyzeProfile(sliver, ERIE).findings,
      "convectiveDay",
    )[0];
    expect(day.day).toBe("2026-08-12");
    expect(day.peakCapeJkg).toBe(294);
    expect(day.peakCapeAt?.local).toBe("2026-08-12T01:00");
    // The confession that keeps the peak honest: covered hours only, and
    // a truncated day must not vote in comparisons (see the JSDoc).
    expect(day.coverage.truncated).toBe(true);
    expect(day.coverage.hours).toBe(6);
  });

  it("emits only where the document publishes CAPE and no CIN — the S4-measured family", () => {
    // hrrr publishes both: the full cap story belongs to capTiming.
    expect(ofKind(analyzeProfile(hrrr(), ERIE).findings, "convectiveDay")).toHaveLength(0);
    // geps is an ensemble (and publishes CIN); reps publishes no CAPE.
    expect(ofKind(analyzeProfile(geps(), FLAGPOLE).findings, "convectiveDay")).toHaveLength(0);
    expect(ofKind(analyzeProfile(reps(), ERIE).findings, "convectiveDay")).toHaveLength(0);
  });
});

describe("windSummary", () => {
  it("states gust and band-wind magnitudes and timing for the deterministic day", () => {
    const findings = ofKind<WindSummaryFinding>(analyzeProfile(hrrr(), ERIE).findings, "windSummary");
    const saturday = findings.find((finding) => finding.day === "2026-08-08")!;
    expect(saturday.maxGust?.gustMs).toBe(3.9);
    expect(saturday.maxGust?.at.local).toBe("2026-08-08T16:00");
    expect(saturday.maxWindInBand).toMatchObject({
      windMs: 4.28, // contract 2-dp: the raw published value

      directionDeg: 289,
      heightM: 2581.5,
      pressureHpa: 750,
      persistenceHours: 4,
    });
    expect(saturday.thresholds).toEqual(DEFAULT_ANALYZE_THRESHOLDS.windSummary);
    // No verdict field exists on the type — magnitudes and timing only; the
    // spike's null result on hazard/barrier verdicts is cited in the JSDoc.
    expect("verdict" in saturday).toBe(false);
  });

  it("omits maxGust where the model publishes none, and carries the semantics echo where it does", () => {
    const findings = ofKind<WindSummaryFinding>(analyzeProfile(reps(), ERIE).findings, "windSummary");
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.maxGust).toBeUndefined(); // REPS is gustless
      expect(finding.maxWindInBand).toBeDefined();
    }
    // The hrrr fixture predates the semantics echo, so maxGust.semantics is
    // absent there; a document carrying the tag propagates it.
    const tagged = hrrr();
    (tagged as { semantics?: object }).semantics = { gust: "instant", precipitation: "instantRate" };
    const parsed = parseWindgramProfile(tagged)!;
    const summary = ofKind<WindSummaryFinding>(analyzeProfile(parsed).findings, "windSummary")[0];
    expect(summary.maxGust?.semantics).toBe("instant");
  });
});

describe("terrainMismatch", () => {
  it("finds the GEPS flagpole case — model terrain 1,078 m below launch", () => {
    const findings = ofKind<TerrainMismatchFinding>(
      analyzeProfile(geps(), FLAGPOLE).findings,
      "terrainMismatch",
    );
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.modelElevationM).toBe(144.1);
    expect(finding.siteAltitudeM).toBe(1222);
    expect(finding.deltaM).toBe(-1077.9);
    // The arithmetic verdict: no hour's published lift top exceeds launch.
    expect(finding.liftTopEverReachesLaunch).toBe(false);
    expect(finding.evidence.maxUsableLiftTopM).toBe(793.7);
    expect(finding.evidence.maxUsableLiftTopAt?.validAt).toBe("2026-08-09T21:00:00Z");
    // The band's own top so the bench is checkable beyond the median: even
    // the most optimistic member family (p90 max 809.4 m) sits 412.6 m
    // under the 1222 m launch — benched at every percentile.
    expect(finding.evidence.maxUsableLiftTopP90M).toBe(809.4);
    expect(finding.thresholds).toEqual(DEFAULT_ANALYZE_THRESHOLDS.terrainMismatch);
  });

  it("stays silent where model terrain sits close to launch", () => {
    // hrrr at erie: model terrain 1177.6 m vs launch 1247 m -> 69.4 m under
    // the default 250 m; reps at erie is 0.9 m off.
    expect(ofKind(analyzeProfile(hrrr(), ERIE).findings, "terrainMismatch")).toHaveLength(0);
    expect(ofKind(analyzeProfile(reps(), ERIE).findings, "terrainMismatch")).toHaveLength(0);
  });

  it("says nothing without a launch — there is no launch in the document to mismatch", () => {
    // Even the extreme GEPS terrain deficit is only a statement AGAINST a
    // launch; launch-free analyses have nothing to compare.
    expect(ofKind(analyzeProfile(geps()).findings, "terrainMismatch")).toHaveLength(0);
  });

  it("moves with the caller's threshold", () => {
    const loose = analyzeProfile(hrrr(), { ...ERIE, thresholds: { terrainMismatch: { minAbsDeltaM: 50 } } });
    const findings = ofKind<TerrainMismatchFinding>(loose.findings, "terrainMismatch");
    expect(findings).toHaveLength(1);
    expect(findings[0].deltaM).toBe(-69.4);
    expect(findings[0].liftTopEverReachesLaunch).toBe(true); // 2905.6 m > 1247 m launch
    // Deterministic documents publish no band: the p90 evidence is null,
    // never a restated median.
    expect(findings[0].evidence.maxUsableLiftTopP90M).toBeNull();
  });
});

describe("ensembleMembership", () => {
  it("surfaces the GEPS CAPE member-dropout landmine per quantity", () => {
    const findings = ofKind<EnsembleMembershipFinding>(
      analyzeProfile(geps(), FLAGPOLE).findings,
      "ensembleMembership",
    );
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.declaredMembers).toBe(21);
    const cape = finding.membership.find((entry) => entry.quantity === "capeJkg")!;
    // Real dropout: percentile blocks over these 48 h computed from as few
    // as 5 of 21 members, on 10 of the 14 hours that publish CAPE at all.
    expect(cape.minMembers).toBe(5);
    expect(cape.hoursBelowFull).toBe(10);
    expect(cape.ofHours).toBe(14);
    expect(cape.evidence.examples.length).toBeGreaterThan(0);
    expect(cape.evidence.examples[0]).toEqual({ validAt: "2026-08-09T06:00:00Z", members: 18 });
  });

  it("states band-width magnitude with no trend verdict — the v4 removals stay removed", () => {
    const finding = ofKind<EnsembleMembershipFinding>(
      analyzeProfile(reps(), ERIE).findings,
      "ensembleMembership",
    )[0];
    const liftBand = finding.bands.find((entry) => entry.series === "usableLiftTopM")!;
    expect(liftBand.hoursWithSignal).toBe(4);
    expect(liftBand.medianBandWidth).toBe(287.8);
    // Removed at v4 (S1: both diurnal-confound directions measured live on
    // one document): the trend verdict, its wideningRatio threshold — gone
    // from the threshold set entirely — and the p50-ratio spread whose
    // denominator explodes as p50 approaches 0.
    expect(liftBand).not.toHaveProperty("trend");
    expect(liftBand).not.toHaveProperty("thresholds");
    expect(liftBand).not.toHaveProperty("maxRelativeSpread");
    expect(liftBand).not.toHaveProperty("maxSpreadAt");
    expect(DEFAULT_ANALYZE_THRESHOLDS).not.toHaveProperty("ensembleMembership");
    expect(JSON.stringify(finding)).not.toMatch(/confidence/i);
  });

  it("carries the per-day band-width series at each day's peak-p50-w* hour", () => {
    const finding = ofKind<EnsembleMembershipFinding>(
      analyzeProfile(reps(), ERIE).findings,
      "ensembleMembership",
    )[0];
    // Two local days, both horizon-clipped (the document opens at 14:00
    // local and closes at 11:00). Widths read at each day's own peak-p50-w*
    // hour: day one at 21:00Z (p50 1.06 vs 0.43 at 00:00Z), day two at
    // 18:00Z (1.62). Hand arithmetic: 1.22−0.96 and 3006.5−2732.8;
    // 1.68−1.51 and 2679.6−2391.8. Leads read from the 18:00Z run.
    expect(finding.dayBands).toEqual([
      {
        day: "2026-08-08",
        peakHour: { validAt: "2026-08-08T21:00:00Z", local: "2026-08-08T14:00" },
        leadHours: 3,
        wstarBandWidthMs: 0.26,
        liftTopBandWidthM: 273.7,
        truncated: true,
      },
      {
        day: "2026-08-09",
        peakHour: { validAt: "2026-08-09T18:00:00Z", local: "2026-08-09T11:00" },
        leadHours: 24,
        wstarBandWidthMs: 0.17,
        liftTopBandWidthM: 287.8,
        truncated: true,
      },
    ]);
  });

  it("reads day coverage at the day's own cadence and flags horizon stubs", () => {
    // The synthetic switch fixture (see crossingFixture): only the middle
    // day is fully covered — 02:00 local first sample inside its 3 h
    // arriving step, 23:00 last sample covering to midnight at 6 h.
    const finding = ofKind<EnsembleMembershipFinding>(
      analyzeProfile(crossingFixture(), ERIE).findings,
      "ensembleMembership",
    )[0];
    const byDay = Object.fromEntries(finding.dayBands.map((row) => [row.day, row]));
    expect(byDay["2026-08-10"]).toEqual({
      day: "2026-08-10",
      peakHour: { validAt: "2026-08-10T18:00:00Z", local: "2026-08-10T11:00" },
      leadHours: 48,
      wstarBandWidthMs: 1.1, // 1.4 − 0.3 at the peak hour
      liftTopBandWidthM: 1000, // 2200 − 1200
      truncated: false,
    });
    // Edge days are horizon stubs: the widths ride along, flagged so the
    // series never reads a clipped day as a day the run forecast.
    expect(byDay["2026-08-09"].truncated).toBe(true);
    expect(byDay["2026-08-09"].wstarBandWidthMs).toBe(1.3); // 1.8 − 0.5
    expect(byDay["2026-08-09"].liftTopBandWidthM).toBe(1000); // 2500 − 1500
    expect(byDay["2026-08-09"].leadHours).toBe(27);
    expect(byDay["2026-08-11"].truncated).toBe(true);
    expect(byDay["2026-08-11"].wstarBandWidthMs).toBe(1); // 2.0 − 1.0
    expect(byDay["2026-08-11"].liftTopBandWidthM).toBe(700); // 2300 − 1600
  });

  it("says nothing about deterministic documents", () => {
    expect(ofKind(analyzeProfile(hrrr(), ERIE).findings, "ensembleMembership")).toHaveLength(0);
  });
});

describe("mixed cadence — spacing is per-gap, never a document constant", () => {
  /* The defect S1 measured live (2026-08-10): GEPS publishes 63 steps at
     3 h then 32 at 6 h, and the old first-pair `stepHoursOf` misread every
     spacing-derived statement on the far horizon — quiet days on fully
     covered 6-hourly days read truncated, covered spans counted 6-hour
     steps as 3. These constructions re-stamp real fixture hours onto a
     switching grid: the spacing is what is under test. */

  const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

  /** GEPS's live shape in miniature: ten 3-hourly steps, then a 6-hourly
   * tail (re-stamped clones of the remaining published hours). */
  function gepsSwitching(): WindgramProfile {
    const doc = JSON.parse(JSON.stringify(fixtures["gepsFlagpole"])) as {
      hours: Array<{ validAt: string }>;
    };
    const head = doc.hours.slice(0, 10);
    const anchor = Date.parse(head[9].validAt); // 2026-08-09T18:00:00Z
    const tail = doc.hours
      .slice(10, 16)
      .map((hour, k) => ({ ...hour, validAt: iso(anchor + (k + 1) * 6 * 3_600_000) }));
    doc.hours = [...head, ...tail];
    const profile = parseWindgramProfile(doc);
    expect(profile).not.toBeNull();
    return profile!;
  }

  /** HRRR's hourly head with a 3-hourly tail (published hours, subsampled). */
  function hrrrWidening(): WindgramProfile {
    const doc = JSON.parse(JSON.stringify(fixtures["hrrrConusErie"])) as {
      hours: unknown[];
    };
    doc.hours = [
      ...doc.hours.slice(0, 7), // 19:00Z..01:00Z hourly
      doc.hours[9],
      doc.hours[12],
      doc.hours[15],
      doc.hours[18],
      doc.hours[21], // 04:00Z..16:00Z three-hourly
    ];
    const profile = parseWindgramProfile(doc);
    expect(profile).not.toBeNull();
    return profile!;
  }

  it("keeps the envelope's stepHours as the leading cadence and confesses the widest step", () => {
    const analysis = analyzeProfile(gepsSwitching(), FLAGPOLE);
    expect(analysis.stepHours).toBe(3); // leading pair — a display fact
    const caveats = ofKind<DataCaveatsFinding>(analysis.findings, "dataCaveats")[0];
    // The caveat names the WIDEST gap: timing at the far horizon is
    // 6-hour interpolation even though the document opens 3-hourly.
    expect(caveats.caveats).toContainEqual({ caveat: "stepCadence", stepHours: 6 });
  });

  it("judges quiet-day truncation at the day's own cadence — a covered 6-hourly day is no data boundary", () => {
    const quiet = ofKind<QuietDayFinding>(analyzeProfile(gepsSwitching(), FLAGPOLE).findings, "quietDay");
    const byDay = Object.fromEntries(quiet.map((finding) => [finding.day, finding]));
    // The far day samples 05:00/11:00/17:00/23:00 local at 6 h — full
    // coverage. The old document-wide constant (3 h) read 05:00 as a
    // late start and called the day truncated with 12 covered hours.
    expect(byDay["2026-08-10"].coverage.truncated).toBe(false);
    expect(byDay["2026-08-10"].coverage.hours).toBe(24);
    // The switch day: four 3-hour steps then two 6-hour steps; its last
    // sample (23:00 local) covers the 6 hours to the next published
    // sample, crossing midnight — the stated covered-span convention.
    expect(byDay["2026-08-09"].coverage.truncated).toBe(false);
    expect(byDay["2026-08-09"].coverage.hours).toBe(27);
    // The 3-hourly near day is untouched by the fix.
    expect(byDay["2026-08-08"].coverage.truncated).toBe(true);
    expect(byDay["2026-08-08"].coverage.hours).toBe(18);
  });

  it("counts durationHours as covered span at the actual cadence", () => {
    const windows = ofKind<ThermalWindowFinding>(
      analyzeProfile(hrrrWidening(), ERIE).findings,
      "thermalWindow",
    );
    const saturday = windows.find((finding) => finding.day === "2026-08-08")!;
    // Same seven cited instants as the hourly document (19:00Z-01:00Z),
    // but the last cited step is 3 h wide (next published sample 04:00Z):
    // six 1-hour steps plus one 3-hour step, not 7 × leading cadence.
    expect(saturday.evidence.hours).toHaveLength(7);
    expect(saturday.start.validAt).toBe("2026-08-08T19:00:00Z");
    expect(saturday.end.validAt).toBe("2026-08-09T01:00:00Z");
    expect(saturday.durationHours).toBe(9);
    // The echo names the widest cited step — the quantization bound.
    expect(saturday.stepHours).toBe(3);
  });

  it("branches capTiming per day — a day whose rows widen mid-horizon reads interval semantics", () => {
    // Baseline: both local days carry instant verdicts on the hourly document.
    for (const finding of ofKind<CapTimingFinding>(
      analyzeProfile(hrrr(), ERIE).findings,
      "capTiming",
    )) {
      expect(finding.cadence).toBe("hourly");
    }
    // Widened: day one's CAPE/CIN rows end 3-hourly, day two is entirely
    // 3-hourly. Before v4 both days went silent; the cadence branch is
    // judged AT THE DAY (never the leading pair), and multi-hour days now
    // speak with interval verdicts instead of instants.
    const widened = ofKind<CapTimingFinding>(
      analyzeProfile(hrrrWidening(), ERIE).findings,
      "capTiming",
    );
    expect(widened).toHaveLength(2);
    const saturday = widened.find((finding) => finding.day === "2026-08-08")!;
    expect(saturday.cadence).toBe("multiHour");
    expect(saturday.stepHours).toBe(3); // the widest gap between cited rows
    expect(saturday.verdict).toBe("capBreaks");
    // The break instant (01:00Z on the hourly truth) becomes an interval
    // between the adjacent cited rows around it.
    expect(saturday.capBreaksBetween).toEqual({
      after: { validAt: "2026-08-09T00:00:00Z", local: "2026-08-08T17:00" },
      by: { validAt: "2026-08-09T01:00:00Z", local: "2026-08-08T18:00" },
    });
    const sunday = widened.find((finding) => finding.day === "2026-08-09")!;
    expect(sunday.cadence).toBe("multiHour");
    expect(sunday.verdict).toBe("noInstability");
  });

  it("measures wind persistence as covered span — a lone far-horizon sample is as wide as its step", () => {
    const doc = JSON.parse(JSON.stringify(fixtures["repsErie"])) as { hours: unknown[] };
    // 3-hourly through 09:00Z, then one 6-hour gap to the last sample.
    doc.hours = [...doc.hours.slice(0, 5), doc.hours[6]];
    const profile = parseWindgramProfile(doc)!;
    const findings = ofKind<WindSummaryFinding>(
      analyzeProfile(profile, ERIE).findings,
      "windSummary",
    );
    const sunday = findings.find((finding) => finding.day === "2026-08-09")!;
    // The peak stands alone at the document's last sample, whose arriving
    // gap is 6 h — the persistence states that step's real width, where
    // the leading cadence would have said 3.
    expect(sunday.maxWindInBand?.at.validAt).toBe("2026-08-09T15:00:00Z");
    expect(sunday.maxWindInBand?.persistenceHours).toBe(6);
  });
});

describe("smokeImpact", () => {
  /* The S2 shape in miniature (2026-08-10 memo): a smoke-carrying profile
     whose day-peak AOT falls OUTSIDE the window while the surface peak
     falls inside it (the erie 08-11 divergence), and a RAQDPS-like joined
     document whose horizon covers day one fully and day two by a single
     hour (S2 Q4: every join miss is horizon, never cadence). Values are
     hand-placed on the real hrrr fixture's hours; the windows they read
     against are the fixture's own (08-08: 19:00Z-01:00Z; 08-09: 18:00Z). */

  const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

  /** The hrrr fixture wearing S2-shaped smoke blocks and the contract's
   * radiativelyCoupled tag. Two raw-precision values (154.24 µg/m³,
   * AOT 0.9174) pin the contract rounding: µg/m³ at one decimal, aot at
   * three (the pipeline's publish table). */
  function smokyHrrr(): WindgramProfile {
    const doc = JSON.parse(JSON.stringify(fixtures["hrrrConusErie"])) as {
      semantics?: object;
      hours: Array<{ validAt: string; smoke?: object }>;
    };
    doc.semantics = { smoke: "radiativelyCoupled" };
    const blocks: Record<string, { surfaceUgm3: number; columnMgm2: number; aot: number }> = {
      // Local day 08-08 (19:00Z-06:00Z at UTC-7); window 19:00Z-01:00Z.
      "2026-08-08T19:00:00Z": { surfaceUgm3: 92.4, columnMgm2: 98.6, aot: 0.755 },
      "2026-08-08T21:00:00Z": { surfaceUgm3: 154.24, columnMgm2: 173.1, aot: 0.9174 },
      "2026-08-09T01:00:00Z": { surfaceUgm3: 130.6, columnMgm2: 151.9, aot: 0.622 },
      "2026-08-09T05:00:00Z": { surfaceUgm3: 88.1, columnMgm2: 260.4, aot: 1.383 }, // 22:00 local
      // Local day 08-09; window is the single hour 18:00Z (11:00 local).
      "2026-08-09T15:00:00Z": { surfaceUgm3: 15.3, columnMgm2: 40.2, aot: 0.213 },
      "2026-08-09T18:00:00Z": { surfaceUgm3: 19.0, columnMgm2: 38.7, aot: 0.201 },
    };
    for (const hour of doc.hours) {
      const block = blocks[hour.validAt];
      if (block) hour.smoke = block;
    }
    const profile = parseWindgramProfile(doc);
    expect(profile, "the smoke-carrying construction must satisfy the contract").not.toBeNull();
    return profile!;
  }

  /** A RAQDPS-shaped smoke document: hourly 19:00Z-07:00Z, so it covers
   * all 12 profile hours of local 08-08 and exactly one of 08-09 — the
   * horizon confession under test. Run 12Z against the profile's 18Z
   * (the routine 6 h gap S2 measured). */
  function raqdpsErie(): SmokeDocument {
    const start = Date.parse("2026-08-08T19:00:00Z");
    const rows: Array<[number, number]> = [
      [90.4, 5.2], // 19:00Z
      [93.1, 6.0],
      [111.0, 9.8], // 21:00Z - surface day-peak, in-window
      [105.5, 12.1],
      [99.9, 14.0],
      [96.2, 15.3],
      [94.0, 16.8], // 01:00Z - the window's last hour
      [92.5, 18.5], // 02:00Z - column day-peak, 19:00 local, OUTSIDE the window
      [60.3, 15.0],
      [40.8, 11.2],
      [30.1, 8.4],
      [22.6, 6.1],
      [12.7, 3.9], // 07:00Z - local 08-09's only covered hour
    ];
    const parsed = parseSmokeDocument({
      schemaVersion: 1,
      model: "raqdps",
      run: { referenceTime: "2026-08-08T12:00:00Z", generatedAt: "2026-08-08T16:05:00Z" },
      site: {
        id: "erie",
        name: "Erie",
        latitude: 49.43,
        longitude: -117.28,
        timeZone: "America/Vancouver",
      },
      hours: rows.map(([smokePlumeSurfaceUgm3, smokePlumeColumnMgm2], k) => ({
        validAt: iso(start + k * 3_600_000),
        pm25Ugm3: smokePlumeSurfaceUgm3 + 4.5,
        smokePlumeSurfaceUgm3,
        smokePlumeColumnMgm2,
      })),
    });
    expect(parsed, "the smoke-document construction must satisfy the contract").not.toBeNull();
    return parsed!;
  }

  it("republishes the profile's own smoke per day — day peaks AND during-window maxima, both", () => {
    const findings = ofKind<SmokeImpactFinding>(
      analyzeProfile(smokyHrrr(), ERIE).findings,
      "smokeImpact",
    );
    expect(findings.map((finding) => finding.day)).toEqual(["2026-08-08", "2026-08-09"]);
    const saturday = findings[0] as SmokeImpactProfileFinding;
    expect(saturday.source).toBe("profile");
    expect(saturday.semantics).toBe("radiativelyCoupled");
    // The S2 divergence: the surface peak sits in-window at 14:00 local...
    expect(saturday.peakSurfaceUgm3).toBe(154.2); // 154.24 raw - contract 1-dp
    expect(saturday.peakSurfaceAt).toEqual({
      validAt: "2026-08-08T21:00:00Z",
      local: "2026-08-08T14:00",
    });
    // ...while the day's AOT peak falls at 22:00 local, outside the window.
    expect(saturday.peakAot).toBe(1.383);
    expect(saturday.peakAotAt).toEqual({
      validAt: "2026-08-09T05:00:00Z",
      local: "2026-08-08T22:00",
    });
    // The during-window maxima are the materially different facts: max AOT
    // inside 12:00-18:00 local is 0.917 (raw 0.9174 - contract 3-dp aot).
    expect(saturday.duringWindow).toEqual({ maxSurfaceUgm3: 154.2, maxAot: 0.917 });
    // Evidence is scoped to exactly the smoke-carrying hours, at contract
    // precision, aligned per hour.
    expect(saturday.evidence.hours).toEqual([
      "2026-08-08T19:00:00Z",
      "2026-08-08T21:00:00Z",
      "2026-08-09T01:00:00Z",
      "2026-08-09T05:00:00Z",
    ]);
    expect(saturday.evidence.surfaceUgm3).toEqual([92.4, 154.2, 130.6, 88.1]);
    expect(saturday.evidence.aot).toEqual([0.755, 0.917, 0.622, 1.383]);
    // Profile source: the model's own AOT, no joined-source fields.
    expect("peakColumnMgm2" in saturday).toBe(false);
    expect("smokeRun" in saturday).toBe(false);
    expect("coverage" in saturday).toBe(false);

    const sunday = findings[1] as SmokeImpactProfileFinding;
    // The single-hour window at 18:00Z catches only its own hour's smoke.
    expect(sunday.peakSurfaceUgm3).toBe(19);
    expect(sunday.peakAot).toBe(0.213);
    expect(sunday.peakAotAt.validAt).toBe("2026-08-09T15:00:00Z");
    expect(sunday.duringWindow).toEqual({ maxSurfaceUgm3: 19, maxAot: 0.201 });
  });

  it("joins a smoke document onto a smoke-blind profile and confesses the horizon", () => {
    const findings = ofKind<SmokeImpactFinding>(
      analyzeProfile(hrrr(), { ...ERIE, smoke: raqdpsErie() }).findings,
      "smokeImpact",
    );
    expect(findings.map((finding) => finding.day)).toEqual(["2026-08-08", "2026-08-09"]);
    const saturday = findings[0] as SmokeImpactJoinedFinding;
    expect(saturday.source).toBe("joined");
    // A joined day is passive by construction: the profile's lift numbers
    // never felt this smoke.
    expect(saturday.semantics).toBe("passive");
    // Both reference times: the smoke run's 12Z beside the envelope's 18Z.
    expect(saturday.smokeRun).toEqual({
      model: "raqdps",
      referenceTime: "2026-08-08T12:00:00Z",
    });
    // Full coverage on day one: all 12 local-day hours matched by validAt.
    expect(saturday.coverage).toEqual({ joinedHours: 12, profileHours: 12 });
    expect(saturday.peakSurfaceUgm3).toBe(111);
    expect(saturday.peakSurfaceAt.validAt).toBe("2026-08-08T21:00:00Z");
    // The column peak (18.5 at 19:00 local) falls outside the window; the
    // in-window column max is the window's last hour.
    expect(saturday.peakColumnMgm2).toBe(18.5);
    expect(saturday.peakColumnAt).toEqual({
      validAt: "2026-08-09T02:00:00Z",
      local: "2026-08-08T19:00",
    });
    expect(saturday.duringWindow).toEqual({ maxSurfaceUgm3: 111, maxColumnMgm2: 16.8 });
    expect(saturday.evidence.hours).toHaveLength(12);
    expect(saturday.evidence.surfaceUgm3[2]).toBe(111);
    expect(saturday.evidence.columnMgm2[7]).toBe(18.5);
    // NO aot, anywhere: the RAQDPS column is quarantined from derived
    // optics (S2 caveat 5), so a joined day republishes the column only.
    expect("peakAot" in saturday).toBe(false);
    expect("aot" in saturday.evidence).toBe(false);
    expect(JSON.stringify(saturday)).not.toMatch(/aot/i);

    const sunday = findings[1] as SmokeImpactJoinedFinding;
    // The horizon confession: the smoke document reaches one hour into the
    // second local day (07:00Z), and the numbers read over that hour only.
    expect(sunday.coverage).toEqual({ joinedHours: 1, profileHours: 12 });
    expect(sunday.peakSurfaceUgm3).toBe(12.7);
    expect(sunday.peakColumnMgm2).toBe(3.9);
    expect(sunday.evidence.hours).toEqual(["2026-08-09T07:00:00Z"]);
    // The day HAS a window (18:00Z), but no joined hour lands on it: the
    // during-window block is null, and coverage says why.
    expect(sunday.duringWindow).toBeNull();
  });

  it("says nothing without smoke — no blocks, no document, no finding", () => {
    expect(ofKind(analyzeProfile(hrrr(), ERIE).findings, "smokeImpact")).toHaveLength(0);
  });

  it("prefers the profile's own smoke over a joined document — one sky, stated once", () => {
    const findings = ofKind<SmokeImpactFinding>(
      analyzeProfile(smokyHrrr(), { ...ERIE, smoke: raqdpsErie() }).findings,
      "smokeImpact",
    );
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.source).toBe("profile");
    }
  });

  it("echoes the semantics tag, and reads an untagged smoke block as passive", () => {
    // The tag is load-bearing: radiativelyCoupled says the analysis's own
    // lift numbers already feel this smoke; its absence must read as
    // passive - derive/'s isSmokeAwareProfile convention, never a default
    // toward "already accounted for".
    const untagged = JSON.parse(JSON.stringify(fixtures["hrrrConusErie"])) as {
      semantics?: object;
      hours: Array<{ validAt: string; smoke?: object }>;
    };
    untagged.hours[0].smoke = { surfaceUgm3: 45.7, columnMgm2: 61.3, aot: 0.412 };
    const profile = parseWindgramProfile(untagged)!;
    const finding = ofKind<SmokeImpactFinding>(
      analyzeProfile(profile, ERIE).findings,
      "smokeImpact",
    )[0];
    expect(finding.source).toBe("profile");
    expect(finding.semantics).toBe("passive");
  });
});

describe("percentileCrossing", () => {
  const crossings = () =>
    ofKind<PercentileCrossingFinding>(
      analyzeProfile(crossingFixture(), ERIE).findings,
      "percentileCrossing",
    );

  it("states the upside day the median suppresses — p50 quiet, p75/p90 clear, minimal token p75", () => {
    const upside = crossings().find((finding) => finding.day === "2026-08-10")!;
    expect(upside.minimalPassingPercentile).toBe("p75");
    // The p50 zeros are load-bearing: the median said quiet.
    expect(upside.perPercentile.p10).toEqual({
      passingSteps: 0,
      hours: [],
      membersMin: null,
      ceiledMembersMax: null,
    });
    expect(upside.perPercentile.p50.passingSteps).toBe(0);
    // p75 clears at one cited instant — 11:00 local, a midday convective
    // hour, over 12 contributing lift members' worth of dilution (18/21).
    expect(upside.perPercentile.p75).toEqual({
      passingSteps: 1,
      hours: ["2026-08-10T18:00:00Z"],
      membersMin: 18,
      ceiledMembersMax: 0,
    });
    // p90 clears at two instants; the min/max echoes span BOTH cited
    // hours (members dip 18 at the first, ceiling touches 1 at the second).
    expect(upside.perPercentile.p90).toEqual({
      passingSteps: 2,
      hours: ["2026-08-10T18:00:00Z", "2026-08-11T00:00:00Z"],
      membersMin: 18,
      ceiledMembersMax: 1,
    });
    expect(upside.thresholds).toEqual({ wstarMinMs: 0.9, depthMinM: 300 });
  });

  it("states the robust mirror on the same shape — p50 passes, p10 fails, minimal token p25", () => {
    const fragile = crossings().find((finding) => finding.day === "2026-08-09")!;
    expect(fragile.minimalPassingPercentile).toBe("p25");
    expect(fragile.perPercentile.p10.passingSteps).toBe(0);
    for (const q of ["p25", "p50", "p75", "p90"] as const) {
      expect(fragile.perPercentile[q].passingSteps).toBe(1);
      expect(fragile.perPercentile[q].hours).toEqual(["2026-08-09T21:00:00Z"]);
      expect(fragile.perPercentile[q].membersMin).toBe(21);
    }
    // The day ALSO carries a thermalWindow (p50 passes): the crossing
    // adds the band's disagreement beside it, not instead of it.
    const windows = ofKind<ThermalWindowFinding>(
      analyzeProfile(crossingFixture(), ERIE).findings,
      "thermalWindow",
    );
    expect(windows.some((finding) => finding.day === "2026-08-09")).toBe(true);
  });

  it("emits nothing for a day where every percentile agrees with the median", () => {
    // 2026-08-11 clears both floors down to p10 — robust everywhere, no
    // crossing to state; the all-quiet hours of other days likewise never
    // appear as findings of their own.
    expect(crossings().map((finding) => finding.day).sort()).toEqual([
      "2026-08-09",
      "2026-08-10",
    ]);
  });

  it("anchors leadHours on the minimal percentile's peak-lift hour and confesses cited spacing per-gap", () => {
    const byDay = Object.fromEntries(crossings().map((finding) => [finding.day, finding]));
    // Run 2026-08-08T18:00Z. The fragile day's one cited hour is 27 h out,
    // on the 3-hourly head: stepHours 3.
    expect(byDay["2026-08-09"].leadHours).toBe(27);
    expect(byDay["2026-08-09"].stepHours).toBe(3);
    // The upside day's minimal (p75) peak-lift hour is 18:00Z, 48 h out;
    // its cited hours sit on the 6-hourly tail — the spacing echo reads
    // the actual gaps (S1's live GEPS switch), never the leading cadence.
    expect(byDay["2026-08-10"].leadHours).toBe(48);
    expect(byDay["2026-08-10"].stepHours).toBe(6);
  });

  it("moves with the caller's thermalWindow floors — one test, one threshold home", () => {
    // Raising the depth floor to 700 m (lift top 1947) kills the fragile
    // day's p25/p50 (1600/1900) but keeps p75/p90 (2200/2500): the same
    // day re-reads as an upside crossing under the caller's convention.
    const strict = ofKind<PercentileCrossingFinding>(
      analyzeProfile(crossingFixture(), {
        ...ERIE,
        thresholds: { thermalWindow: { depthMinM: 700 } },
      }).findings,
      "percentileCrossing",
    );
    const fragile = strict.find((finding) => finding.day === "2026-08-09")!;
    expect(fragile.minimalPassingPercentile).toBe("p75");
    expect(fragile.perPercentile.p50.passingSteps).toBe(0);
    expect(fragile.thresholds).toEqual({ wstarMinMs: 0.9, depthMinM: 700 });
  });

  it("stays silent on deterministic documents and on real ensembles without a crossing day", () => {
    // Deterministic: no percentiles, nothing to cross.
    expect(ofKind(analyzeProfile(hrrr(), ERIE).findings, "percentileCrossing")).toHaveLength(0);
    // Real reps at erie: both local days agree at every percentile (the
    // window day is robust down to p10). Real geps at flagpole: no
    // percentile's lift top ever reaches 300 m over launch (max p90
    // 809.4 m vs 1222 m launch) — quiet at every percentile.
    expect(ofKind(analyzeProfile(reps(), ERIE).findings, "percentileCrossing")).toHaveLength(0);
    expect(
      ofKind(analyzeProfile(geps(), FLAGPOLE).findings, "percentileCrossing"),
    ).toHaveLength(0);
  });
});

describe("windSummary.duringWindow", () => {
  /* S3 (2026-08-10): the whole-day maxGust cited an hour OUTSIDE the day's
     window in 29.9 % of corpus rows. The block scopes the same numbers to
     the thermalWindow's cited hours and stops discarding the per-hour band
     maxima the extractor already computed. */

  it("scopes gust and band wind to the window's hours and keeps the whole-day numbers", () => {
    const saturday = ofKind<WindSummaryFinding>(
      analyzeProfile(hrrr(), ERIE).findings,
      "windSummary",
    ).find((finding) => finding.day === "2026-08-08")!;
    // Whole-day block untouched.
    expect(saturday.maxGust?.gustMs).toBe(3.9);
    // The scope is the Saturday window's seven cited hours, 19:00Z-01:00Z.
    expect(saturday.duringWindow?.windowHours).toHaveLength(7);
    expect(saturday.duringWindow?.windowHours[0]).toBe("2026-08-08T19:00:00Z");
    expect(saturday.duringWindow?.windowHours[6]).toBe("2026-08-09T01:00:00Z");
    // On this document the day's strongest gust falls INSIDE the window —
    // both blocks cite 16:00 local, and now say which question they answer.
    expect(saturday.duringWindow?.maxGust).toEqual({
      gustMs: 3.9,
      meanWindMs: 2.72,
      at: { validAt: "2026-08-08T23:00:00Z", local: "2026-08-08T16:00" },
    });
    expect(saturday.duringWindow?.maxWindInBand).toEqual({
      windMs: 4.28,
      directionDeg: 289,
      heightM: 2581.5,
      at: { validAt: "2026-08-08T23:00:00Z", local: "2026-08-08T16:00" },
    });
    // The per-hour series over exactly the scope hours (published gusts;
    // hand-computed climb-band maxima, launch 1247 ± 200 m to top + 200 m).
    expect(saturday.duringWindow?.evidence.hours).toEqual(saturday.duringWindow?.windowHours);
    expect(saturday.duringWindow?.evidence.windGustMs).toEqual([
      2.33, 2.15, 2.59, 3.23, 3.9, 3.74, 3.46,
    ]);
    expect(saturday.duringWindow?.evidence.bandMaxWindMs).toEqual([
      1.87, 2.06, 3.19, 3.65, 4.28, 3.77, 3.49,
    ]);
  });

  it("pins the 02:00 divergence — the whole-day gust cites an hour nobody is airborne", () => {
    // The S3 briefing-changer in miniature (nam@red-mountain 08-12: 7.23
    // m/s at 02:00 local vs 2.23 in-window): plant a 7.23 m/s nocturnal
    // gust at 09:00Z = 02:00 local Sunday and read both blocks.
    const gusty = hrrr();
    for (const hour of gusty.hours) {
      if (hour.validAt === "2026-08-09T09:00:00Z") {
        (hour.surface as { windGustMs: number }).windGustMs = 7.23;
      }
    }
    const sunday = ofKind<WindSummaryFinding>(
      analyzeProfile(gusty, ERIE).findings,
      "windSummary",
    ).find((finding) => finding.day === "2026-08-09")!;
    // Whole-day: the nocturnal spike, at an hour with w* 0 and no lift top.
    expect(sunday.maxGust?.gustMs).toBe(7.23);
    expect(sunday.maxGust?.at.local).toBe("2026-08-09T02:00");
    // During the window (its single hour, 11:00 local): less than half that.
    expect(sunday.duringWindow?.windowHours).toEqual(["2026-08-09T18:00:00Z"]);
    expect(sunday.duringWindow?.maxGust?.gustMs).toBe(3.05);
    expect(sunday.duringWindow?.maxGust?.at.local).toBe("2026-08-09T11:00");
    expect(sunday.duringWindow?.evidence.windGustMs).toEqual([3.05]);
    expect(sunday.duringWindow?.evidence.bandMaxWindMs).toEqual([1.51]);
  });

  it("is absent on quiet days — the scope is the thermalWindow, and there is none", () => {
    // An impossible w* floor makes every day quiet; the wind summaries
    // still state whole-day magnitudes, but there is no scope to report.
    const analysis = analyzeProfile(hrrr(), {
      ...ERIE,
      thresholds: { thermalWindow: { wstarMinMs: 99 } },
    });
    expect(ofKind(analysis.findings, "thermalWindow")).toHaveLength(0);
    const findings = ofKind<WindSummaryFinding>(analysis.findings, "windSummary");
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.maxGust).toBeDefined();
      expect(finding.duringWindow).toBeUndefined();
    }
  });

  it("carries the gust semantics echo, and gustless models read null gust evidence", () => {
    // REPS publishes no gust: the block still scopes the band wind, and the
    // gust evidence says null per hour rather than pretending calm.
    const saturday = ofKind<WindSummaryFinding>(
      analyzeProfile(reps(), ERIE).findings,
      "windSummary",
    ).find((finding) => finding.day === "2026-08-08")!;
    expect(saturday.duringWindow?.windowHours).toEqual(["2026-08-08T21:00:00Z"]);
    expect(saturday.duringWindow?.maxGust).toBeUndefined();
    expect(saturday.duringWindow?.evidence.windGustMs).toEqual([null]);
    expect(saturday.duringWindow?.evidence.bandMaxWindMs).toEqual([1.78]);
    // Whole-day and in-window band maxima diverge here too: the day's
    // strongest in-band wind (2.01 m/s at 17:00 local) is after the window.
    expect(saturday.maxWindInBand?.windMs).toBe(2.01);
    expect(saturday.duringWindow?.maxWindInBand?.windMs).toBe(1.78);

    const tagged = hrrr();
    (tagged as { semantics?: object }).semantics = {
      gust: "instant",
      precipitation: "instantRate",
    };
    const summary = ofKind<WindSummaryFinding>(
      analyzeProfile(parseWindgramProfile(tagged)!, ERIE).findings,
      "windSummary",
    )[0];
    expect(summary.duringWindow?.maxGust?.semantics).toBe("instant");
  });

  it("states pressureHpa as null under full ensemble dropout — no more NaN under a number type", () => {
    // Tier 0 #2: `?? NaN` serialized to null under JSON while the type said
    // number. Drop the winning level's pressure to full dropout (members 0,
    // every percentile null) and the field is honestly null in the object.
    const doc = JSON.parse(JSON.stringify(fixtures["repsErie"])) as {
      hours: Array<{ levels: Array<{ pressureHpa: unknown }> }>;
    };
    // 15:00Z carries Sunday's strongest in-band wind (1.58 m/s at 1511.9 m).
    doc.hours[6].levels[0].pressureHpa = {
      members: 0,
      p10: null,
      p25: null,
      p50: null,
      p75: null,
      p90: null,
    };
    const sunday = ofKind<WindSummaryFinding>(
      analyzeProfile(parseWindgramProfile(doc)!, ERIE).findings,
      "windSummary",
    ).find((finding) => finding.day === "2026-08-09")!;
    expect(sunday.maxWindInBand?.windMs).toBe(1.58);
    expect(sunday.maxWindInBand?.pressureHpa).toBeNull();
    expect(Number.isNaN(sunday.maxWindInBand?.pressureHpa)).toBe(false);
  });
});

describe("windExceedance", () => {
  /* S3 candidate 2: caller-thresholded absolute runs over window hours.
     The package never owns a ceiling; the caller's value is echoed
     verbatim; gust ceilings are per semantics class, never reused. */

  const tagged = () => {
    const doc = hrrr();
    (doc as { semantics?: object }).semantics = {
      gust: "hourMax",
      precipitation: "instantRate",
    };
    return parseWindgramProfile(doc)!;
  };

  it("emits nothing without caller ceilings — no defaults exist anywhere", () => {
    const findings = ofKind(analyzeProfile(tagged(), ERIE).findings, "windExceedance");
    expect(findings).toHaveLength(0);
    // An empty ceilings object supplies no quantity either.
    expect(
      ofKind(analyzeProfile(tagged(), { ...ERIE, windCeilings: {} }).findings, "windExceedance"),
    ).toHaveLength(0);
  });

  it("finds maximal runs per day and quantity over window hours, threshold echoed verbatim", () => {
    const findings = ofKind<WindExceedanceFinding>(
      analyzeProfile(tagged(), {
        ...ERIE,
        windCeilings: { surfaceMs: 2.5, gust: { hourMaxMs: 3 }, bandMs: 4 },
      }).findings,
      "windExceedance",
    );
    // Saturday: gust, surface, and band all exceed; Sunday: gust only
    // (its window hour reads surface 1.02, band 1.51).
    expect(
      findings.map((finding) => [finding.day, finding.quantity]).sort(),
    ).toEqual([
      ["2026-08-08", "bandWind"],
      ["2026-08-08", "gust"],
      ["2026-08-08", "surfaceWind"],
      ["2026-08-09", "gust"],
    ]);

    const gust = findings.find(
      (finding) => finding.day === "2026-08-08" && finding.quantity === "gust",
    )!;
    // Window gusts [2.33, 2.15, 2.59, 3.23, 3.9, 3.74, 3.46]: one maximal
    // run, 22:00Z-01:00Z, peaking 3.9 at 16:00 local.
    expect(gust.thresholdMs).toBe(3);
    expect(gust.gustSemantics).toBe("hourMax");
    expect(gust.stepHours).toBe(1);
    expect(gust.runs).toEqual([
      {
        start: { validAt: "2026-08-08T22:00:00Z", local: "2026-08-08T15:00" },
        end: { validAt: "2026-08-09T01:00:00Z", local: "2026-08-08T18:00" },
        hours: 4,
        peakMs: 3.9,
        peakAt: { validAt: "2026-08-08T23:00:00Z", local: "2026-08-08T16:00" },
      },
    ]);
    expect(gust.evidence.hours).toHaveLength(7);
    expect(gust.evidence.valueMs).toEqual([2.33, 2.15, 2.59, 3.23, 3.9, 3.74, 3.46]);

    const surface = findings.find(
      (finding) => finding.day === "2026-08-08" && finding.quantity === "surfaceWind",
    )!;
    // Surface winds [1.92, 1.56, 2.11, 2.59, 2.72, 2.47, 2.32]: 22:00Z and
    // 23:00Z stand at/above 2.5; 00:00Z (2.47) ends the run.
    expect(surface.gustSemantics).toBeUndefined();
    expect(surface.runs).toEqual([
      {
        start: { validAt: "2026-08-08T22:00:00Z", local: "2026-08-08T15:00" },
        end: { validAt: "2026-08-08T23:00:00Z", local: "2026-08-08T16:00" },
        hours: 2,
        peakMs: 2.72,
        peakAt: { validAt: "2026-08-08T23:00:00Z", local: "2026-08-08T16:00" },
      },
    ]);

    const band = findings.find(
      (finding) => finding.day === "2026-08-08" && finding.quantity === "bandWind",
    )!;
    // Band maxima [1.87, 2.06, 3.19, 3.65, 4.28, 3.77, 3.49]: 23:00Z alone.
    expect(band.runs).toHaveLength(1);
    expect(band.runs[0].hours).toBe(1);
    expect(band.runs[0].peakMs).toBe(4.28);

    const sundayGust = findings.find(
      (finding) => finding.day === "2026-08-09" && finding.quantity === "gust",
    )!;
    expect(sundayGust.runs).toEqual([
      {
        start: { validAt: "2026-08-09T18:00:00Z", local: "2026-08-09T11:00" },
        end: { validAt: "2026-08-09T18:00:00Z", local: "2026-08-09T11:00" },
        hours: 1,
        peakMs: 3.05,
        peakAt: { validAt: "2026-08-09T18:00:00Z", local: "2026-08-09T11:00" },
      },
    ]);
  });

  it("refuses across gust semantics classes — an instant ceiling reads nothing from an hourMax document", () => {
    // The caller supplied only the OTHER class's ceiling: silence, never a
    // silently misread threshold (S3: the class gap is a factor ~1.8-2.8).
    const wrongClass = analyzeProfile(tagged(), {
      ...ERIE,
      windCeilings: { gust: { instantMs: 3 } },
    });
    expect(ofKind(wrongClass.findings, "windExceedance")).toHaveLength(0);
    // An UNTAGGED document declares no gust semantics: no ceiling matches,
    // whichever classes the caller supplies.
    const untagged = analyzeProfile(hrrr(), {
      ...ERIE,
      windCeilings: { gust: { hourMaxMs: 3, instantMs: 3 } },
    });
    expect(ofKind(untagged.findings, "windExceedance")).toHaveLength(0);
  });

  it("breaks runs at scope gaps — two same-day windows never bridge into one run", () => {
    // The dip splits Saturday into two windows (19:00Z-21:00Z and
    // 23:00Z-01:00Z); every scope hour gusts >= 2, but the out-of-scope
    // 22:00Z hour keeps the runs apart.
    const dipped = tagged();
    for (const hour of dipped.hours) {
      if (hour.validAt === "2026-08-08T22:00:00Z") {
        (hour.derived as { thermalVelocityMs: number }).thermalVelocityMs = 0.85;
      }
    }
    const saturday = ofKind<WindExceedanceFinding>(
      analyzeProfile(dipped, { ...ERIE, windCeilings: { gust: { hourMaxMs: 2 } } }).findings,
      "windExceedance",
    ).find((finding) => finding.day === "2026-08-08")!;
    expect(saturday.evidence.hours).toHaveLength(6);
    expect(saturday.runs.map((run) => [run.start.validAt, run.end.validAt, run.hours])).toEqual([
      ["2026-08-08T19:00:00Z", "2026-08-08T21:00:00Z", 3],
      ["2026-08-08T23:00:00Z", "2026-08-09T01:00:00Z", 3],
    ]);
  });

  it("reads ensembles at p50 and confesses coarse cadence in run lengths", () => {
    // REPS is gustless (no gust runs whatever the ceilings), but its band
    // wind exceeds a 1.5 m/s ceiling on Saturday's single-sample window —
    // a run whose covered span is the 3-hour step, stated.
    const findings = ofKind<WindExceedanceFinding>(
      analyzeProfile(reps(), {
        ...ERIE,
        windCeilings: { gust: { hourMaxMs: 1, instantMs: 1 }, bandMs: 1.5 },
      }).findings,
      "windExceedance",
    );
    expect(findings).toHaveLength(1);
    const band = findings[0];
    expect(band.day).toBe("2026-08-08");
    expect(band.quantity).toBe("bandWind");
    expect(band.stepHours).toBe(3);
    expect(band.runs).toEqual([
      {
        start: { validAt: "2026-08-08T21:00:00Z", local: "2026-08-08T14:00" },
        end: { validAt: "2026-08-08T21:00:00Z", local: "2026-08-08T14:00" },
        hours: 3,
        peakMs: 1.78,
        peakAt: { validAt: "2026-08-08T21:00:00Z", local: "2026-08-08T14:00" },
      },
    ]);
  });
});

describe("windDirection", () => {
  /* S3 candidate 3: direction evolution per thermalWindow, deterministic
     documents only. Every expectation below is hand-computed with vector
     math over the raw fixture values — no raw degrees were averaged in
     the making of these numbers. */

  const winHours = [
    "2026-08-08T19:00:00Z",
    "2026-08-08T20:00:00Z",
    "2026-08-08T21:00:00Z",
    "2026-08-08T22:00:00Z",
    "2026-08-08T23:00:00Z",
    "2026-08-09T00:00:00Z",
    "2026-08-09T01:00:00Z",
  ];

  /** The S3 drainage→upvalley rotation stamped onto the Saturday window:
   * monotone 115° → 242° at a steady 2 m/s (thermal series untouched, so
   * the window itself is unchanged). */
  function rotating(): WindgramProfile {
    const doc = hrrr();
    const dirs = [115, 126, 141, 165, 195, 216, 242];
    for (const hour of doc.hours) {
      const index = winHours.indexOf(hour.validAt);
      if (index === -1) continue;
      (hour.surface as { windSpeedMs: number; windDirectionDeg: number }).windSpeedMs = 2;
      (hour.surface as { windSpeedMs: number; windDirectionDeg: number }).windDirectionDeg =
        dirs[index];
    }
    return doc;
  }

  it("states the rotation: start, peak-lift, end samples and the net circular veer", () => {
    const saturday = ofKind<WindDirectionFinding>(
      analyzeProfile(rotating(), ERIE).findings,
      "windDirection",
    ).find((finding) => finding.day === "2026-08-08")!;
    expect(saturday.window.start.validAt).toBe("2026-08-08T19:00:00Z");
    expect(saturday.window.end.validAt).toBe("2026-08-09T01:00:00Z");
    expect(saturday.surface.start).toEqual({ directionDeg: 115, speedMs: 2 });
    // Peak lift is 23:00Z (16:00 local) — the rotation is established there.
    expect(saturday.surface.peakLift).toEqual({
      directionDeg: 195,
      speedMs: 2,
      at: { validAt: "2026-08-08T23:00:00Z", local: "2026-08-08T16:00" },
    });
    expect(saturday.surface.end).toEqual({ directionDeg: 242, speedMs: 2 });
    // Net circular displacement 115° → 242°: +127 — the S3 statement.
    expect(saturday.netVeerDeg).toBe(127);
    // Vector mean of the seven 2 m/s samples: components sum to
    // (-1.7477, 9.9957)/7 → 1.4496 m/s from 170.1° (cancellation across
    // the rotation drops the mean speed below the samples' 2).
    expect(saturday.surfaceVectorMean).toEqual({ directionDeg: 170, speedMs: 1.45 });
    expect(saturday.thresholds).toEqual({ directionFloorMs: 1 });
    expect(saturday.evidence.hours).toEqual(winHours);
    expect(saturday.evidence.surfaceDirectionDeg).toEqual([115, 126, 141, 165, 195, 216, 242]);
    expect(saturday.evidence.surfaceSpeedMs).toEqual([2, 2, 2, 2, 2, 2, 2]);
  });

  it("reads the real document: gentle veer, vector means, and the band mean over 24 level samples", () => {
    const findings = ofKind<WindDirectionFinding>(
      analyzeProfile(hrrr(), ERIE).findings,
      "windDirection",
    );
    expect(findings.map((finding) => finding.day)).toEqual(["2026-08-08", "2026-08-09"]);
    const saturday = findings[0];
    // Raw fixture surface: 228° @ 1.92 → … → 232° @ 2.32 across the window.
    expect(saturday.surface.start).toEqual({ directionDeg: 228, speedMs: 1.92 });
    expect(saturday.surface.end).toEqual({ directionDeg: 232, speedMs: 2.32 });
    expect(saturday.netVeerDeg).toBe(4);
    expect(saturday.surfaceVectorMean).toEqual({ directionDeg: 238, speedMs: 2.21 });
    // 24 in-band level samples (launch 1247 m to each hour's lift top)
    // vector-average to 2.31 m/s from 262° — the WNW flow aloft.
    expect(saturday.bandVectorMean).toEqual({ directionDeg: 262, speedMs: 2.31, samples: 24 });

    // Sunday's window is a single clipped hour: start, peak, and end are
    // the same sample and the net veer is zero by construction.
    const sunday = findings[1];
    expect(sunday.surface.start).toEqual({ directionDeg: 220, speedMs: 1.02 });
    expect(sunday.netVeerDeg).toBe(0);
    expect(sunday.bandVectorMean).toEqual({ directionDeg: 252, speedMs: 1.25, samples: 2 });
  });

  it("suppresses direction under the floor — calm has no bearing, and the floor is the caller's", () => {
    const drifting = rotating();
    for (const hour of drifting.hours) {
      if (hour.validAt === "2026-08-08T19:00:00Z") {
        (hour.surface as { windSpeedMs: number }).windSpeedMs = 0.4;
      }
    }
    const saturday = ofKind<WindDirectionFinding>(
      analyzeProfile(drifting, ERIE).findings,
      "windDirection",
    ).find((finding) => finding.day === "2026-08-08")!;
    // The 0.4 m/s drift states its speed and no direction; the net veer
    // loses its start endpoint and is honestly null.
    expect(saturday.surface.start).toEqual({ directionDeg: null, speedMs: 0.4 });
    expect(saturday.netVeerDeg).toBeNull();
    // The floor is a convention: a caller who accepts the measured 0.5 m/s
    // jitter cliff (S3: medians 20°→7° across it) may lower it.
    const lowered = ofKind<WindDirectionFinding>(
      analyzeProfile(drifting, {
        ...ERIE,
        thresholds: { windDirection: { directionFloorMs: 0.3 } },
      }).findings,
      "windDirection",
    ).find((finding) => finding.day === "2026-08-08")!;
    expect(lowered.surface.start).toEqual({ directionDeg: 115, speedMs: 0.4 });
    expect(lowered.netVeerDeg).toBe(127);
    expect(lowered.thresholds).toEqual({ directionFloorMs: 0.3 });
  });

  it("gates itself off ensembles — direction percentiles are not circular statistics", () => {
    // REPS has real thermalWindows and publishes level directions, and
    // still says nothing here: a p50 of raw degrees near north is
    // arithmetic nonsense, and member vectors are not recoverable.
    const analysis = analyzeProfile(reps(), ERIE);
    expect(ofKind(analysis.findings, "thermalWindow").length).toBeGreaterThan(0);
    expect(ofKind(analysis.findings, "windDirection")).toHaveLength(0);
    expect(ofKind(analyzeProfile(geps(), FLAGPOLE).findings, "windDirection")).toHaveLength(0);
  });
});

describe("bandShear", () => {
  /* S3 candidate 4: adjacent-level layer shear inside launch→lift-top,
     analyze-only (rates are not comparable across level densities). All
     layer numbers below are hand-computed component-wise from the raw
     fixture winds. */

  it("finds the day's strongest layer with mandatory bounds and endpoint winds", () => {
    const findings = ofKind<BandShearFinding>(
      analyzeProfile(hrrr(), ERIE).findings,
      "bandShear",
    );
    const saturday = findings.find((finding) => finding.day === "2026-08-08")!;
    // 20:00Z (13:00 local): 1.39 m/s @ 214° against 2.06 m/s @ 265° across
    // the 1525.6-2040.5 m layer — 1.6 m/s of vector shear over 514.9 m.
    expect(saturday.maxShear.ratePerKm).toBe(3.11);
    expect(saturday.maxShear.shearMs).toBe(1.6);
    expect(saturday.maxShear.layer).toEqual({ fromM: 1525.6, toM: 2040.5, thicknessM: 514.9 });
    expect(saturday.maxShear.at).toEqual({
      validAt: "2026-08-08T20:00:00Z",
      local: "2026-08-08T13:00",
    });
    expect(saturday.maxShear.lower).toEqual({ speedMs: 1.39, directionDeg: 214, heightM: 1525.6 });
    expect(saturday.maxShear.upper).toEqual({ speedMs: 2.06, directionDeg: 265, heightM: 2040.5 });
    expect(saturday.levelsInBand).toBe(3);
    expect(saturday.bothEndpointsUnderFloorMs).toBe(false); // 2.06 stands over the 2 m/s floor
    expect(saturday.thresholds).toEqual({ minLayerThicknessM: 30, endpointFloorMs: 2 });
    // Per window hour, the hour's own max layer rate.
    expect(saturday.evidence.hours).toHaveLength(7);
    expect(saturday.evidence.maxRatePerKm).toEqual([1.19, 3.11, 2.48, 2.18, 2.21, 1.95, 1.97]);
  });

  it("flags a layer whose endpoints are both light wind — an arithmetic relation, no verdict", () => {
    // Sunday's single-hour window is the S3 12 % case live: 1.01 m/s @ 245°
    // against 1.51 m/s @ 257° reads 2.27 m/s/km, and both endpoints sit
    // under the 2 m/s floor — the number is a direction difference between
    // light winds, and the finding says exactly that relation.
    const sunday = ofKind<BandShearFinding>(
      analyzeProfile(hrrr(), ERIE).findings,
      "bandShear",
    ).find((finding) => finding.day === "2026-08-09")!;
    expect(sunday.maxShear.ratePerKm).toBe(2.27);
    expect(sunday.maxShear.layer).toEqual({ fromM: 1258.4, toM: 1506.4, thicknessM: 248 });
    expect(sunday.levelsInBand).toBe(2);
    expect(sunday.bothEndpointsUnderFloorMs).toBe(true);
    expect(JSON.stringify(sunday)).not.toMatch(/hazard|quality|suspect/i);
  });

  it("is absent when the column offers fewer than two in-band levels — too sparse to state", () => {
    // Strip every hour to its lowest level: one in-band level has no
    // layer, so the kind says nothing (absence means "column too sparse
    // to state", the honest GEPS/REPS behaviour S3 measured at 0.4-6 %).
    const sparse = hrrr();
    for (const hour of sparse.hours) {
      (hour as { levels: unknown[] }).levels = hour.levels.slice(0, 1);
    }
    expect(ofKind(analyzeProfile(sparse, ERIE).findings, "bandShear")).toHaveLength(0);
    // The thickness floor is a caller convention too: demanding thicker
    // layers than the column publishes silences the kind the same way.
    expect(
      ofKind(
        analyzeProfile(hrrr(), {
          ...ERIE,
          thresholds: { bandShear: { minLayerThicknessM: 600 } },
        }).findings,
        "bandShear",
      ),
    ).toHaveLength(0);
  });

  it("gates itself off ensembles — level direction percentiles are no more circular than surface ones", () => {
    // REPS has thermalWindows and publishes level winds; the gate holds.
    const analysis = analyzeProfile(reps(), ERIE);
    expect(ofKind(analysis.findings, "thermalWindow").length).toBeGreaterThan(0);
    expect(ofKind(analysis.findings, "bandShear")).toHaveLength(0);
    expect(ofKind(analyzeProfile(geps(), FLAGPOLE).findings, "bandShear")).toHaveLength(0);
  });
});

describe("dataCaveats", () => {
  it("declares what REPS cannot say — the whole science wave absent, threshold-free", () => {
    const finding = ofKind<DataCaveatsFinding>(analyzeProfile(reps(), ERIE).findings, "dataCaveats")[0];
    const absent = finding.caveats.find((caveat) => caveat.caveat === "absentQuantities")!;
    expect(absent.quantities).toEqual(
      expect.arrayContaining(["windGustMs", "capeJkg", "cinJkg", "pblHeightM"]),
    );
    expect(finding.caveats).toContainEqual({
      caveat: "derivedNullHours",
      quantity: "usableLiftTopM",
      hoursNull: 4,
      ofHours: 8,
    });
    expect(finding.caveats).toContainEqual({ caveat: "stepCadence", stepHours: 3 });
    expect(JSON.stringify(finding)).not.toMatch(/threshold/i);
  });

  it("names the smoke family absent on a smoke-blind analysis — absence is never clear air", () => {
    // No hours[].smoke, no joined document: the analysis is smoke-blind,
    // no finding in it accounts for smoke, and the caveat is the only
    // place that says so (S2 Q5: live smoke-blind and smoke-carrying
    // analyses produced indistinguishable caveats on a heavy-smoke day).
    const analysis = analyzeProfile(hrrr(), ERIE);
    expect(ofKind(analysis.findings, "smokeImpact")).toHaveLength(0);
    const absent = ofKind<DataCaveatsFinding>(analysis.findings, "dataCaveats")[0].caveats.find(
      (caveat) => caveat.caveat === "absentQuantities",
    )!;
    expect(absent.quantities).toContain("smoke");
  });

  it("drops the smoke caveat exactly when the analysis states smoke", () => {
    // A profile carrying its own smoke blocks speaks for itself...
    const smoky = hrrr();
    smoky.hours[0].smoke = { surfaceUgm3: 45.7, columnMgm2: 61.3, aot: 0.412 };
    const own = ofKind<DataCaveatsFinding>(
      analyzeProfile(smoky, ERIE).findings,
      "dataCaveats",
    )[0].caveats.find((caveat) => caveat.caveat === "absentQuantities");
    expect(own?.quantities ?? []).not.toContain("smoke");
    // ...and so does a joined smoke document that actually matches hours.
    const smoke = parseSmokeDocument({
      schemaVersion: 1,
      model: "raqdps",
      run: { referenceTime: "2026-08-08T12:00:00Z", generatedAt: "2026-08-08T16:05:00Z" },
      site: { id: "erie", name: "Erie", latitude: 49.43, longitude: -117.28 },
      hours: [
        {
          validAt: "2026-08-08T19:00:00Z",
          pm25Ugm3: 94.9,
          smokePlumeSurfaceUgm3: 90.4,
          smokePlumeColumnMgm2: 5.2,
        },
      ],
    })!;
    const joined = analyzeProfile(hrrr(), { ...ERIE, smoke });
    expect(ofKind(joined.findings, "smokeImpact")).toHaveLength(1);
    const viaJoin = ofKind<DataCaveatsFinding>(joined.findings, "dataCaveats")[0].caveats.find(
      (caveat) => caveat.caveat === "absentQuantities",
    );
    expect(viaJoin?.quantities ?? []).not.toContain("smoke");
  });

  it("keeps the smoke caveat when a supplied document never matches — smoke-blind is a join OUTCOME", () => {
    // Every smoke hour sits beyond the profile's hours (the S2-measured
    // failure mode is the mirror — a profile outrunning the smoke horizon
    // — but the arithmetic is the same): nothing joins, nothing is stated.
    const smoke = parseSmokeDocument({
      schemaVersion: 1,
      model: "raqdps",
      run: { referenceTime: "2026-08-12T12:00:00Z", generatedAt: "2026-08-12T16:05:00Z" },
      site: { id: "erie", name: "Erie", latitude: 49.43, longitude: -117.28 },
      hours: [
        {
          validAt: "2026-08-12T19:00:00Z",
          pm25Ugm3: 94.9,
          smokePlumeSurfaceUgm3: 90.4,
          smokePlumeColumnMgm2: 5.2,
        },
      ],
    })!;
    const analysis = analyzeProfile(hrrr(), { ...ERIE, smoke });
    expect(ofKind(analysis.findings, "smokeImpact")).toHaveLength(0);
    const absent = ofKind<DataCaveatsFinding>(analysis.findings, "dataCaveats")[0].caveats.find(
      (caveat) => caveat.caveat === "absentQuantities",
    )!;
    expect(absent.quantities).toContain("smoke");
  });

  it("does not call a science-capable document's fields absent", () => {
    const finding = ofKind<DataCaveatsFinding>(analyzeProfile(hrrr(), ERIE).findings, "dataCaveats")[0];
    const absent = finding.caveats.find((caveat) => caveat.caveat === "absentQuantities");
    expect(absent?.quantities ?? []).not.toContain("capeJkg");
    expect(absent?.quantities ?? []).not.toContain("windGustMs");
    // Hourly cadence: no stepCadence note.
    expect(finding.caveats.some((caveat) => caveat.caveat === "stepCadence")).toBe(false);
  });
});

describe("tolerant-reader versioning (Tier 2 §3)", () => {
  it("types vocabularyVersion as number — cached envelopes survive upgrades as data", () => {
    const analysis = analyzeProfile(hrrr(), ERIE);
    // The widening, as a consumer sees it: the field binds as plain
    // number (a literal-4 binding no longer compiles) and runtime checks
    // keep working unchanged.
    const version: number = analysis.vocabularyVersion;
    expect(version).toBe(ANALYZE_VOCABULARY_VERSION);
  });

  it("a compiled consumer with a default arm is conforming — unknown kinds are ignorable", () => {
    // The convention's compiled shape: switch on the kinds you know and
    // let the default arm pass the rest through — a future additive kind
    // changes this consumer's counts, never its compilation. (Exhaustive
    // switching stays available to consumers who choose the compile
    // event instead.)
    const analysis = analyzeProfile(hrrr(), ERIE);
    let known = 0;
    let ignored = 0;
    for (const finding of analysis.findings) {
      switch (finding.kind) {
        case "thermalWindow":
        case "quietDay":
        case "dataCaveats":
          known += 1;
          break;
        default:
          ignored += 1;
          break;
      }
    }
    expect(known).toBeGreaterThan(0);
    expect(known + ignored).toBe(analysis.findings.length);
  });
});

describe("the extension door (the public frame)", () => {
  // A caller extension exercising every frame convention: citation, day
  // bucketing, and lead bound to the analysis zone/run, the resolved
  // launch, cadence truth, and read access to the finished findings.
  const frameProbe: AnalysisExtension = {
    name: "test/frameProbe",
    extract: (frame, findings) => [
      {
        frameVersion: ANALYSIS_FRAME_VERSION,
        deterministic: frame.deterministic,
        stepHours: frame.stepHours,
        maxStepHours: frame.steps.maxStepHours,
        launchElevationM: frame.launchElevationM,
        launchReferenceM: frame.launchReferenceM,
        firstHour: frame.cite(frame.profile.hours[0].validAt),
        firstDay: frame.dayOf(frame.profile.hours[0].validAt),
        firstLeadHours: frame.leadHours(frame.profile.hours[0].validAt),
        windowCount: findings.filter((finding) => finding.kind === "thermalWindow").length,
      },
    ],
  };

  it("hands the extension the resolved per-analysis facts, bound to the zone and run", () => {
    const analysis = analyzeProfile(hrrr(), { ...ERIE, extensions: [frameProbe] });
    expect(analysis.extensions).toHaveLength(1);
    expect(analysis.extensions![0].extension).toBe("test/frameProbe");
    const windowCount = ofKind<ThermalWindowFinding>(analysis.findings, "thermalWindow").length;
    expect(analysis.extensions![0].statements).toEqual([
      {
        frameVersion: 1,
        deterministic: true,
        stepHours: 1,
        maxStepHours: 1,
        launchElevationM: 1247,
        launchReferenceM: 1247,
        // 2026-08-08T19:00Z is noon in America/Vancouver (UTC−7), one
        // hour after the 18:00Z reference — all three by hand.
        firstHour: { validAt: "2026-08-08T19:00:00Z", local: "2026-08-08T12:00" },
        firstDay: "2026-08-08",
        firstLeadHours: 1,
        windowCount,
      },
    ]);
  });

  it("keeps extension statements OUT of findings, and findings untouched", () => {
    const plain = analyzeProfile(hrrr(), ERIE);
    const extended = analyzeProfile(hrrr(), { ...ERIE, extensions: [frameProbe] });
    expect(extended.findings).toEqual(plain.findings);
    // The plain envelope has NO extensions key at all — serialized
    // envelopes from extension-free calls stay byte-identical.
    expect("extensions" in plain).toBe(false);
  });

  it("delivers entries named and in caller order — two extensions never blur", () => {
    const constant = (name: string, value: string): AnalysisExtension => ({
      name,
      extract: () => [value],
    });
    const analysis = analyzeProfile(hrrr(), {
      ...ERIE,
      extensions: [constant("a/one", "first"), constant("b/two", "second")],
    });
    expect(analysis.extensions).toEqual([
      { extension: "a/one", statements: ["first"] },
      { extension: "b/two", statements: ["second"] },
    ]);
  });

  it("refuses duplicate extension names in one call", () => {
    const noop: AnalysisExtension = { name: "dup", extract: () => [] };
    expect(() => analyzeProfile(hrrr(), { ...ERIE, extensions: [noop, { ...noop }] })).toThrow(
      /duplicate extension name \(dup\)/,
    );
  });

  it("lets a throwing extension fail the analysis — caller code is not sandboxed", () => {
    const broken: AnalysisExtension = {
      name: "broken",
      extract: () => {
        throw new Error("extension bug");
      },
    };
    expect(() => analyzeProfile(hrrr(), { ...ERIE, extensions: [broken] })).toThrow(
      /extension bug/,
    );
  });

  it("receives the FINISHED findings and the honest ensemble facts", () => {
    // The probe's windowCount was computed from the findings handed to the
    // extension; it must match the envelope's own final array.
    const analysis = analyzeProfile(geps(), { ...FLAGPOLE, extensions: [frameProbe] });
    const statement = analysis.extensions![0].statements[0] as {
      windowCount: number;
      deterministic: boolean;
      stepHours: number;
    };
    expect(statement.windowCount).toBe(
      ofKind<ThermalWindowFinding>(analysis.findings, "thermalWindow").length,
    );
    // And the frame facts read true: geps is a 3-hourly ensemble.
    expect(statement.deterministic).toBe(false);
    expect(statement.stepHours).toBe(3);
  });
});

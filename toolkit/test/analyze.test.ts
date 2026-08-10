import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANALYZE_VOCABULARY_VERSION,
  analyzeProfile,
  DEFAULT_ANALYZE_THRESHOLDS,
  type CapTimingFinding,
  type DataCaveatsFinding,
  type EnsembleMembershipFinding,
  type ThermalWindowFinding,
  type LiftCeilingFinding,
  type QuietDayFinding,
  type SmokeImpactFinding,
  type SmokeImpactJoinedFinding,
  type SmokeImpactProfileFinding,
  type TerrainMismatchFinding,
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
        "thermalWindow",
        "quietDay",
        "liftCeiling",
        "smokeImpact",
        "windSummary",
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

describe("liftCeiling", () => {
  it("attributes the deterministic window's ceiling to sink, with evidence per segment", () => {
    const findings = ofKind<LiftCeilingFinding>(analyzeProfile(hrrr(), ERIE).findings, "liftCeiling");
    const saturday = findings.find((finding) => finding.day === "2026-08-08")!;
    expect(saturday.segments).toHaveLength(1);
    expect(saturday.flips).toBe(0);
    expect(saturday.segments[0].cause).toBe("sinkLimited");
    expect(saturday.segments[0].hoursN).toBe(7);
    // Cloud base stands 1.4 km above the lift top at the segment's start.
    expect(saturday.segments[0].evidence).toEqual({
      usableLiftTopM: 1840.7,
      cloudBaseM: 3248,
      boundaryLayerTopM: 1841.7,
    });
    expect(saturday.thresholds).toEqual(DEFAULT_ANALYZE_THRESHOLDS.liftCeiling);
  });

  it("calls the REPS windows cloud-capped — base sits on (or within 50 m of) the top", () => {
    const findings = ofKind<LiftCeilingFinding>(analyzeProfile(reps(), ERIE).findings, "liftCeiling");
    expect(findings).toHaveLength(2);
    for (const finding of findings) {
      expect(finding.segments[0].cause).toBe("cloudCapped");
    }
    // Sunday's is exact: usable lift top IS the published cloud base.
    expect(findings[1].segments[0].evidence.usableLiftTopM).toBe(2543.2);
    expect(findings[1].segments[0].evidence.cloudBaseM).toBe(2543.2);
  });
});

describe("capTiming", () => {
  it("tells the deterministic cap story with local timing and full-day evidence", () => {
    const findings = ofKind<CapTimingFinding>(analyzeProfile(hrrr(), ERIE).findings, "capTiming");
    const saturday = findings.find((finding) => finding.day === "2026-08-08")!;
    expect(saturday.verdict).toBe("capBreaks");
    expect(saturday.peakCapeJkg).toBe(540);
    // |CIN| drops under 25 while CAPE exceeds 200 at 18:00 local — the
    // arithmetic the verdict names, one hour before the window closes.
    expect(saturday.capBreaksAt).toEqual({
      validAt: "2026-08-09T01:00:00Z",
      local: "2026-08-08T18:00",
    });
    expect(saturday.capeAtBreakJkg).toBe(540);
    expect(saturday.thermalWindowEndsAt?.local).toBe("2026-08-08T18:00");
    expect(saturday.thresholds).toEqual(DEFAULT_ANALYZE_THRESHOLDS.capTiming);
    expect(saturday.evidence.capeJkg).toContain(540);
    expect(saturday.evidence.hours).toHaveLength(saturday.evidence.cinJkg.length);

    const sunday = findings.find((finding) => finding.day === "2026-08-09")!;
    expect(sunday.verdict).toBe("noInstability");
    expect(sunday.peakCapeJkg).toBe(0);
  });

  it("gates itself off ensembles and multi-hour cadences — GEPS says nothing here", () => {
    // GEPS publishes CAPE and CIN, but as 3-hourly ensemble percentiles:
    // the spike found the member-median CIN bimodal, so no cap story.
    expect(ofKind(analyzeProfile(geps(), FLAGPOLE).findings, "capTiming")).toHaveLength(0);
    expect(ofKind(analyzeProfile(reps(), ERIE).findings, "capTiming")).toHaveLength(0);
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

  it("states band-width magnitude and trend, with no confidence verdicts", () => {
    const finding = ofKind<EnsembleMembershipFinding>(
      analyzeProfile(reps(), ERIE).findings,
      "ensembleMembership",
    )[0];
    const liftBand = finding.bands.find((entry) => entry.series === "usableLiftTopM")!;
    expect(liftBand.hoursWithSignal).toBe(4);
    expect(liftBand.medianBandWidth).toBe(287.8);
    expect(liftBand.maxRelativeSpread).toBe(1.1);
    expect(liftBand.trend).toBe("steady");
    expect(liftBand.thresholds).toEqual(DEFAULT_ANALYZE_THRESHOLDS.ensembleMembership);
    expect(JSON.stringify(finding)).not.toMatch(/confidence/i);
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

  it("gates capTiming per day — a document that merely starts hourly gets no coarse-day cap story", () => {
    // Baseline: both local days carry a verdict on the hourly document.
    expect(
      ofKind<CapTimingFinding>(analyzeProfile(hrrr(), ERIE).findings, "capTiming"),
    ).toHaveLength(2);
    // Widened: day one's CAPE/CIN rows end 3-hourly, day two is entirely
    // 3-hourly — instant verdicts need hourly sampling AT THE DAY, and
    // the old leading-pair gate would have admitted both.
    expect(
      ofKind<CapTimingFinding>(analyzeProfile(hrrrWidening(), ERIE).findings, "capTiming"),
    ).toHaveLength(0);
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

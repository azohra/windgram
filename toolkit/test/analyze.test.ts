import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANALYZE_VOCABULARY_VERSION,
  analyzeProfile,
  DEFAULT_ANALYZE_THRESHOLDS,
  type BandShearFinding,
  type CapTimingFinding,
  type DataCaveatsFinding,
  type EnsembleMembershipFinding,
  type ThermalWindowFinding,
  type LiftCeilingFinding,
  type QuietDayFinding,
  type TerrainMismatchFinding,
  type WindDirectionFinding,
  type WindExceedanceFinding,
  type WindSummaryFinding,
} from "../src/analyze/index.js";
import { parseWindgramProfile, type WindgramProfile } from "../src/contract/index.js";

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

  it("does not call a science-capable document's fields absent", () => {
    const finding = ofKind<DataCaveatsFinding>(analyzeProfile(hrrr(), ERIE).findings, "dataCaveats")[0];
    const absent = finding.caveats.find((caveat) => caveat.caveat === "absentQuantities");
    expect(absent?.quantities ?? []).not.toContain("capeJkg");
    expect(absent?.quantities ?? []).not.toContain("windGustMs");
    // Hourly cadence: no stepCadence note.
    expect(finding.caveats.some((caveat) => caveat.caveat === "stepCadence")).toBe(false);
  });
});

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
  type FlyableWindowFinding,
  type LiftCeilingFinding,
  type QuietDayFinding,
  type TerrainMismatchFinding,
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

function ofKind<T extends { kind: string }>(
  findings: readonly { kind: string }[],
  kind: T["kind"],
): T[] {
  return findings.filter((finding) => finding.kind === kind) as T[];
}

describe("the analysis envelope", () => {
  it("stamps the vocabulary version and the document's identity", () => {
    const analysis = analyzeProfile(hrrr());
    expect(analysis.vocabularyVersion).toBe(ANALYZE_VOCABULARY_VERSION);
    expect(analysis.model).toBe("hrrr-conus");
    expect(analysis.site).toEqual({ id: "erie", launchAltitudeM: 1247, modelElevationM: 1177.6 });
    expect(analysis.run.referenceTime).toBe("2026-08-08T18:00:00Z");
    expect(analysis.stepHours).toBe(1);
    expect(analysis.hours).toBe(24);
  });

  it("reads local time from the document's own site.timeZone", () => {
    const analysis = analyzeProfile(hrrr());
    expect(analysis.timeZone).toBe("America/Vancouver");
    expect(analysis.timeZoneSource).toBe("document");
  });

  it("lets the caller override the timezone", () => {
    const analysis = analyzeProfile(hrrr(), { timeZone: "America/Edmonton" });
    expect(analysis.timeZone).toBe("America/Edmonton");
    expect(analysis.timeZoneSource).toBe("override");
    const window = ofKind<FlyableWindowFinding>(analysis.findings, "flyableWindow")[0];
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

  it("emits only the version-2 vocabulary — kinds are a closed, versioned set", () => {
    const kinds = new Set(
      [hrrr(), geps(), reps()].flatMap((profile) =>
        analyzeProfile(profile).findings.map((finding) => finding.kind),
      ),
    );
    for (const kind of kinds) {
      expect([
        "terrainMismatch",
        "dataCaveats",
        "ensembleMembership",
        "capTiming",
        "flyableWindow",
        "quietDay",
        "liftCeiling",
        "windSummary",
      ]).toContain(kind);
    }
  });
});

describe("flyableWindow", () => {
  it("finds the deterministic afternoon window with local timing and launch-relative peak", () => {
    const findings = ofKind<FlyableWindowFinding>(
      analyzeProfile(hrrr()).findings,
      "flyableWindow",
    );
    const saturday = findings.find((finding) => finding.day === "2026-08-08")!;
    // The spike's window on this document (its local clock approximated
    // UTC-8; these are the same UTC hours read in real Pacific daylight time).
    expect(saturday.start).toEqual({ validAt: "2026-08-08T19:00:00Z", local: "2026-08-08T12:00" });
    expect(saturday.end).toEqual({ validAt: "2026-08-09T01:00:00Z", local: "2026-08-08T18:00" });
    expect(saturday.durationHours).toBe(7);
    expect(saturday.peakLiftTopM).toBe(2905.6);
    expect(saturday.peakLiftTopAboveLaunchM).toBe(1658.6); // 2905.6 − 1247 launch
    expect(saturday.peakThermalVelocityMs).toBe(2.2);
    // The thresholds that produced the window are embedded in it.
    expect(saturday.thresholds).toEqual(DEFAULT_ANALYZE_THRESHOLDS.flyableWindow);
    // Evidence is scoped to exactly the cited hours.
    expect(saturday.evidence.hours).toHaveLength(7);
    expect(saturday.evidence.usableLiftTopM[4]).toBe(2905.6);
    expect(saturday.evidence.liftTopBandP10P90).toBeUndefined(); // deterministic document
  });

  it("moves with the caller's thresholds — they are conventions, not physics", () => {
    const strict = analyzeProfile(hrrr(), {
      thresholds: { flyableWindow: { wstarMinMs: 2.1, depthMinM: 1500 } },
    });
    const findings = ofKind<FlyableWindowFinding>(strict.findings, "flyableWindow");
    expect(findings).toHaveLength(1);
    // Only 22:00Z clears both bars (top 2826.3 = 1579 m over launch, W* 2.2).
    expect(findings[0].durationHours).toBe(1);
    expect(findings[0].start.validAt).toBe("2026-08-08T22:00:00Z");
    expect(findings[0].thresholds).toEqual({ wstarMinMs: 2.1, depthMinM: 1500 });
  });

  it("states the negative: a day with no window emits quietDay with the numbers that failed", () => {
    // Impossible W* floor: every day is quiet, and the finding says why.
    const strict = analyzeProfile(hrrr(), {
      thresholds: { flyableWindow: { wstarMinMs: 99, depthMinM: 300 } },
    });
    expect(ofKind<FlyableWindowFinding>(strict.findings, "flyableWindow")).toHaveLength(0);
    const quiet = ofKind<QuietDayFinding>(strict.findings, "quietDay");
    const saturday = quiet.find((finding) => finding.day === "2026-08-08")!;
    expect(saturday.failed).toEqual(["wstar"]);
    // The evidence is the day's best hour against each floor.
    expect(saturday.peakThermalVelocityMs).toBe(2.2);
    expect(saturday.peakLiftDepthM).toBe(1658.6);
    expect(saturday.peakLiftDepthAt?.validAt).toBe("2026-08-08T23:00:00Z");
    expect(saturday.thresholds).toEqual({ wstarMinMs: 99, depthMinM: 300 });
  });

  it("flags horizon truncation: a quiet call from a sliver of a day is a data boundary", () => {
    const quiet = ofKind<QuietDayFinding>(analyzeProfile(geps()).findings, "quietDay");
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
    const windows = ofKind<FlyableWindowFinding>(analyzeProfile(hrrr()).findings, "flyableWindow");
    const byDay = Object.fromEntries(windows.map((finding) => [finding.day, finding]));
    // The document opens mid-window and ends mid-window: the first
    // window's start and the last window's end are data boundaries.
    expect(byDay["2026-08-08"].clippedAtStart).toBe(true);
    expect(byDay["2026-08-08"].clippedAtEnd).toBe(false);
    expect(byDay["2026-08-09"].clippedAtStart).toBe(false);
    expect(byDay["2026-08-09"].clippedAtEnd).toBe(true);
  });

  it("emits no quietDay for a day any window hour touches", () => {
    const findings = analyzeProfile(hrrr()).findings;
    const windowDays = new Set(
      ofKind<FlyableWindowFinding>(findings, "flyableWindow").map((finding) => finding.day),
    );
    for (const quiet of ofKind<QuietDayFinding>(findings, "quietDay")) {
      expect(windowDays.has(quiet.day)).toBe(false);
    }
  });

  it("reads ensembles at p50 and carries the p10-p90 lift-top band as evidence", () => {
    const findings = ofKind<FlyableWindowFinding>(
      analyzeProfile(reps()).findings,
      "flyableWindow",
    );
    expect(findings.map((finding) => finding.day)).toEqual(["2026-08-08", "2026-08-09"]);
    const saturday = findings[0];
    expect(saturday.durationHours).toBe(3); // one 3-hourly step
    expect(saturday.peakLiftTopM).toBe(2853.2);
    expect(saturday.evidence.liftTopBandP10P90).toEqual([[2732.8, 3006.5]]);
  });

  it("finds nothing at the terrain-mismatch site — lift tops never reach 300 m over launch", () => {
    expect(ofKind(analyzeProfile(geps()).findings, "flyableWindow")).toHaveLength(0);
  });
});

describe("liftCeiling", () => {
  it("attributes the deterministic window's ceiling to sink, with evidence per segment", () => {
    const findings = ofKind<LiftCeilingFinding>(analyzeProfile(hrrr()).findings, "liftCeiling");
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
    const findings = ofKind<LiftCeilingFinding>(analyzeProfile(reps()).findings, "liftCeiling");
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
    const findings = ofKind<CapTimingFinding>(analyzeProfile(hrrr()).findings, "capTiming");
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
    expect(saturday.flyableWindowEndsAt?.local).toBe("2026-08-08T18:00");
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
    expect(ofKind(analyzeProfile(geps()).findings, "capTiming")).toHaveLength(0);
    expect(ofKind(analyzeProfile(reps()).findings, "capTiming")).toHaveLength(0);
  });
});

describe("windSummary", () => {
  it("states gust and band-wind magnitudes and timing for the deterministic day", () => {
    const findings = ofKind<WindSummaryFinding>(analyzeProfile(hrrr()).findings, "windSummary");
    const saturday = findings.find((finding) => finding.day === "2026-08-08")!;
    expect(saturday.maxGust?.gustMs).toBe(3.9);
    expect(saturday.maxGust?.at.local).toBe("2026-08-08T16:00");
    expect(saturday.maxWindInBand).toMatchObject({
      windMs: 4.3,
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
    const findings = ofKind<WindSummaryFinding>(analyzeProfile(reps()).findings, "windSummary");
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
      analyzeProfile(geps()).findings,
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
    expect(ofKind(analyzeProfile(hrrr()).findings, "terrainMismatch")).toHaveLength(0);
    expect(ofKind(analyzeProfile(reps()).findings, "terrainMismatch")).toHaveLength(0);
  });

  it("moves with the caller's threshold", () => {
    const loose = analyzeProfile(hrrr(), { thresholds: { terrainMismatch: { minAbsDeltaM: 50 } } });
    const findings = ofKind<TerrainMismatchFinding>(loose.findings, "terrainMismatch");
    expect(findings).toHaveLength(1);
    expect(findings[0].deltaM).toBe(-69.4);
    expect(findings[0].liftTopEverReachesLaunch).toBe(true); // 2905.6 m > 1247 m launch
  });
});

describe("ensembleMembership", () => {
  it("surfaces the GEPS CAPE member-dropout landmine per quantity", () => {
    const findings = ofKind<EnsembleMembershipFinding>(
      analyzeProfile(geps()).findings,
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
      analyzeProfile(reps()).findings,
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
    expect(ofKind(analyzeProfile(hrrr()).findings, "ensembleMembership")).toHaveLength(0);
  });
});

describe("dataCaveats", () => {
  it("declares what REPS cannot say — the whole science wave absent, threshold-free", () => {
    const finding = ofKind<DataCaveatsFinding>(analyzeProfile(reps()).findings, "dataCaveats")[0];
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
    const finding = ofKind<DataCaveatsFinding>(analyzeProfile(hrrr()).findings, "dataCaveats")[0];
    const absent = finding.caveats.find((caveat) => caveat.caveat === "absentQuantities");
    expect(absent?.quantities ?? []).not.toContain("capeJkg");
    expect(absent?.quantities ?? []).not.toContain("windGustMs");
    // Hourly cadence: no stepCadence note.
    expect(finding.caveats.some((caveat) => caveat.caveat === "stepCadence")).toBe(false);
  });
});

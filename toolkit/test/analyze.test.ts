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
  type PercentileCrossingFinding,
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
        "percentileCrossing",
        "quietDay",
        "liftCeiling",
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

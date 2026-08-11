import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWindgramProfile, type WindgramProfile } from "../src/contract/index.js";
import {
  compareAnalyses,
  compareProfiles,
  comparisonMemberKey,
  COMPARE_VOCABULARY_VERSION,
  type HeightSpreadFinding,
  type WindDirectionSpreadFinding,
  type WindDivergenceFinding,
  type WindowAgreementFinding,
} from "../src/compare/index.js";
import {
  analyzeProfile,
  DEFAULT_ANALYZE_THRESHOLDS,
  type AnalyzeOptions,
  type WindgramAnalysis,
} from "../src/analyze/index.js";

/* Same corpus as analyze's tests: two real erie documents (hourly
   deterministic HRRR, 3-hourly ensemble REPS) compare as members; the
   flagpole GEPS document is the mixed-site guard case and — with its
   terrain deficit — the benching case once retagged onto erie's site.
   The v2 statements (member identity, the midnight electorate, horizon
   rosters, sensitivity, the wind kinds) are pinned on synthetic members
   cloned from the HRRR document with hand-authored values, so every
   expectation is checkable by hand against the embedded floors. */

const fixtures = JSON.parse(
  readFileSync(join(__dirname, "analyze-fixtures.json"), "utf-8"),
) as Record<string, unknown>;

function load(key: string): WindgramProfile {
  const profile = parseWindgramProfile(fixtures[key]);
  expect(profile).not.toBeNull();
  return profile!;
}

const TZ = "America/Vancouver";
const hrrr = () => load("hrrrConusErie");
const reps = () => load("repsErie");

/* Erie's launch — ONE launch per comparison, a caller input since the
   launch-decoupling wave (the fixtures baked it as v1 site.altitudeM,
   which the contract now strips at parse). Same elevation the spike used,
   so the expected votes and spreads are unchanged. */
const ERIE_LAUNCH = { elevationM: 1247 };

function ofKind<T extends { kind: string }>(
  findings: readonly { kind: string }[],
  kind: T["kind"],
): T[] {
  return findings.filter((finding) => finding.kind === kind) as T[];
}

/* ------------------------------------------------- synthetic member kit */

/* Local midnight in America/Vancouver (PDT, UTC−7) is T07:00Z: local
   hour H of day D is D T(07+H):00Z. Every synthetic hour below is
   authored through this helper so the local-day bookkeeping is legible. */
function utcAt(day: string, localHour: number): string {
  return new Date(Date.parse(`${day}T07:00:00Z`) + localHour * 3_600_000)
    .toISOString()
    .replace(".000Z", "Z");
}

interface HourSpec {
  validAt: string;
  /** p50 thermal velocity — against the 0.9 floor. */
  wstar: number;
  /** p50 usable-lift top, MSL — depth reads against the 1247 m launch. */
  top: number | null;
  wind?: { speedMs: number; directionDeg: number };
  gustMs?: number;
  levels?: Array<{
    heightM: number;
    windSpeedMs: number;
    windDirectionDeg: number;
    pressureHpa: number;
  }>;
}

/** A deterministic erie member cloned from the real HRRR document with
 * hand-authored hours — full control over every voted number. */
function detMember(opts: {
  model: string;
  referenceTime: string;
  modelElevationM?: number;
  gustSemantics?: "hourMax" | "instant";
  hours: HourSpec[];
}): WindgramProfile {
  const doc = JSON.parse(JSON.stringify(fixtures["hrrrConusErie"])) as {
    model: string;
    run: { referenceTime: string };
    site: { modelElevationM: number };
    semantics?: { gust: "hourMax" | "instant" };
    hours: Array<{
      validAt: string;
      surface: Record<string, unknown>;
      derived: Record<string, unknown>;
      levels: Array<Record<string, unknown>>;
    }>;
  };
  doc.model = opts.model;
  doc.run.referenceTime = opts.referenceTime;
  if (opts.modelElevationM !== undefined) doc.site.modelElevationM = opts.modelElevationM;
  if (opts.gustSemantics) doc.semantics = { gust: opts.gustSemantics };
  const template = JSON.stringify(doc.hours[0]);
  doc.hours = opts.hours.map((spec) => {
    const hour = JSON.parse(template) as (typeof doc.hours)[number];
    hour.validAt = spec.validAt;
    hour.derived.thermalVelocityMs = spec.wstar;
    hour.derived.usableLiftTopM = spec.top;
    if (spec.wind) {
      hour.surface.windSpeedMs = spec.wind.speedMs;
      hour.surface.windDirectionDeg = spec.wind.directionDeg;
    }
    if (spec.gustMs !== undefined) hour.surface.windGustMs = spec.gustMs;
    if (spec.levels) {
      const levelTemplate = hour.levels[0];
      hour.levels = spec.levels.map((level) => ({ ...levelTemplate, ...level }));
    }
    return hour;
  });
  const profile = parseWindgramProfile(doc);
  expect(profile, `${opts.model} must satisfy the published contract`).not.toBeNull();
  return profile!;
}

/** Full local day of hourly hours (00:00–23:00) — never truncated. */
function fullDay(day: string, spec: (localHour: number) => Omit<HourSpec, "validAt">): HourSpec[] {
  return Array.from({ length: 24 }, (_, localHour) => ({
    validAt: utcAt(day, localHour),
    ...spec(localHour),
  }));
}

const QUIET = { wstar: 0.1, top: 1300 };

/* -------------------------------------------------------------- the tests */

describe("compareProfiles guards", () => {
  it("refuses mixed sites — one comparison, one site", () => {
    expect(() => compareProfiles([hrrr(), load("gepsFlagpole")], { timeZone: TZ })).toThrow(
      /mixed sites/,
    );
  });

  it("refuses an empty member list", () => {
    expect(() => compareProfiles([], { timeZone: TZ })).toThrow(/no members/);
  });

  it("refuses the SAME run twice — identity is (model, referenceTime)", () => {
    expect(() => compareProfiles([hrrr(), hrrr()], { timeZone: TZ })).toThrow(
      /duplicate member \(hrrr-conus@2026-08-08T18:00:00Z\)/,
    );
  });
});

describe("compareAnalyses — the coherence-validated door", () => {
  // The seam compareProfiles wraps: cached or edge-produced envelopes
  // enter here, and coherence is VALIDATED from their self-description
  // instead of reconstructed from raw profiles.
  const analyzed = (profile: WindgramProfile, overrides: Partial<AnalyzeOptions> = {}) =>
    analyzeProfile(profile, { timeZone: TZ, launch: ERIE_LAUNCH, ...overrides });

  it("equals the wrapper on the same inputs — one construction, no duplicated logic", () => {
    const unavailable = [{ model: "nam-conus-nest", miss: "absent" as const }];
    const viaProfiles = compareProfiles([hrrr(), reps()], {
      timeZone: TZ,
      launch: ERIE_LAUNCH,
      unavailable,
    });
    const viaAnalyses = compareAnalyses([analyzed(hrrr()), analyzed(reps())], { unavailable });
    expect(viaAnalyses).toEqual(viaProfiles);
  });

  it("refuses an empty member list", () => {
    expect(() => compareAnalyses([])).toThrow(/no members/);
  });

  it("refuses mixed sites — one comparison, one site", () => {
    expect(() =>
      compareAnalyses([analyzed(hrrr()), analyzed(load("gepsFlagpole"))]),
    ).toThrow(/mixed sites \(erie vs flagpole\)/);
  });

  it("refuses the SAME analysis twice — identity is (model, referenceTime)", () => {
    expect(() => compareAnalyses([analyzed(hrrr()), analyzed(hrrr())])).toThrow(
      /duplicate member \(hrrr-conus@2026-08-08T18:00:00Z\)/,
    );
  });

  it("refuses vocabulary version skew, naming the member, both versions, and the remedy", () => {
    // A cached envelope written by an older vocabulary: compare's vote
    // readers are compiled against exactly one — strict equality is v1
    // of this surface.
    // No cast needed: §3's widening types the field as number, so a
    // cached envelope's stale stamp is representable data, not a type error.
    const stale: WindgramAnalysis = { ...analyzed(hrrr()), vocabularyVersion: 3 };
    expect(() => compareAnalyses([stale, analyzed(reps())])).toThrow(
      /vocabulary version skew — member hrrr-conus@2026-08-08T18:00:00Z carries vocabularyVersion 3, this toolkit compares vocabulary 4; re-analyze/,
    );
  });

  it("refuses an envelope that does not self-describe — the pre-0.22 case", () => {
    // A toolkit-0.21 envelope carries vocabulary 4 but none of the three
    // self-description fields; each absence is its own named error.
    for (const field of ["thresholds", "deterministic", "coveredDays"]) {
      const legacy = { ...analyzed(hrrr()) } as unknown as Record<string, unknown>;
      delete legacy[field];
      expect(() => compareAnalyses([legacy as unknown as WindgramAnalysis])).toThrow(
        new RegExp(`member hrrr-conus@2026-08-08T18:00:00Z lacks ${field} — .*re-analyze`),
      );
    }
  });

  it("refuses mixed timezones — day keys pair only in one zone", () => {
    expect(() =>
      compareAnalyses([analyzed(hrrr()), analyzed(reps(), { timeZone: "America/Edmonton" })]),
    ).toThrow(/mixed timezones \(America\/Vancouver vs America\/Edmonton\)/);
  });

  it("refuses mixed launches, null included — one launch per comparison", () => {
    expect(() =>
      compareAnalyses([analyzed(hrrr()), analyzed(reps(), { launch: null })]),
    ).toThrow(/mixed launches \(1247 vs null\)/);
    expect(() =>
      compareAnalyses([analyzed(hrrr()), analyzed(reps(), { launch: { elevationM: 1200 } })]),
    ).toThrow(/mixed launches \(1247 vs 1200\)/);
  });

  it("refuses threshold inequality, naming the first differing path with both values", () => {
    expect(() =>
      compareAnalyses([
        analyzed(hrrr()),
        analyzed(reps(), { thresholds: { thermalWindow: { wstarMinMs: 0.8 } } }),
      ]),
    ).toThrow(/threshold mismatch \(thermalWindow\.wstarMinMs: 0\.9 vs 0\.8\)/);
  });
});

describe("member identity (model, referenceTime) — the v2 breaking change", () => {
  // The same document reissued as a six-hours-newer run: v1's duplicate
  // guard threw here; v2 holds both runs as two members.
  const laterDoc = JSON.parse(JSON.stringify(fixtures["hrrrConusErie"])) as {
    run: { referenceTime: string };
  };
  laterDoc.run.referenceTime = "2026-08-09T00:00:00Z";
  const later = parseWindgramProfile(laterDoc)!;
  const comparison = compareProfiles([hrrr(), later], { timeZone: TZ, launch: ERIE_LAUNCH });

  it("holds two runs of one model as two members with distinct keys", () => {
    expect(comparison.members).toHaveLength(2);
    const keys = comparison.members.map((member) => member.member);
    expect(keys).toEqual([
      "hrrr-conus@2026-08-08T18:00:00Z",
      "hrrr-conus@2026-08-09T00:00:00Z",
    ]);
    expect(comparison.members.every((member) => member.model === "hrrr-conus")).toBe(true);
    // The key is the exported helper's — one construction everywhere.
    expect(keys[0]).toBe(comparisonMemberKey("hrrr-conus", "2026-08-08T18:00:00Z"));
    // Run age reads against the newest member: 6 h and 0 h.
    expect(comparison.newestReferenceTime).toBe("2026-08-09T00:00:00Z");
    expect(comparison.members.map((member) => member.runAgeHours)).toEqual([6, 0]);
  });

  it("keys analyses by the member key — both runs' provenance held at once", () => {
    expect(Object.keys(comparison.analyses).sort()).toEqual([
      "hrrr-conus@2026-08-08T18:00:00Z",
      "hrrr-conus@2026-08-09T00:00:00Z",
    ]);
  });

  it("counts the two runs as two voters", () => {
    const agreement = ofKind<WindowAgreementFinding>(comparison.findings, "windowAgreement");
    const day = agreement.find((finding) => finding.day === "2026-08-08")!;
    // Identical hours: both runs vote the same window — 2 voters, unanimous.
    expect(day.voters).toBe(2);
    expect(day.unanimous).toBe(true);
    expect(day.windows.map((vote) => vote.member).sort()).toEqual([
      "hrrr-conus@2026-08-08T18:00:00Z",
      "hrrr-conus@2026-08-09T00:00:00Z",
    ]);
    // And the identical peaks make a genuine zero spread, not a collapse.
    const spread = ofKind<HeightSpreadFinding>(comparison.findings, "heightSpread").find(
      (finding) => finding.day === "2026-08-08",
    )!;
    expect(spread.peaks).toHaveLength(2);
    expect(spread.spreadM).toBe(0);
  });
});

describe("the member ledger", () => {
  const comparison = compareProfiles([hrrr(), reps()], {
    timeZone: TZ,
    launch: ERIE_LAUNCH,
    unavailable: [{ model: "nam-conus-nest", miss: "absent" }],
  });

  it("states comparability facts per member — kind, cadence, run age, elevation delta", () => {
    const byModel = Object.fromEntries(comparison.members.map((member) => [member.model, member]));
    expect(byModel["hrrr-conus"].kind).toBe("deterministic");
    expect(byModel["reps"].kind).toBe("ensemble");
    expect(byModel["hrrr-conus"].stepHours).toBe(1);
    expect(byModel["reps"].stepHours).toBe(3);
    for (const member of comparison.members) {
      expect(member.member).toBe(comparisonMemberKey(member.model, member.referenceTime));
      expect(member.runAgeHours).toBeGreaterThanOrEqual(0);
      expect(member.elevationDeltaM).not.toBeNull();
      expect(member.benched).toBeNull();
    }
    expect(comparison.newestReferenceTime).toBe(
      comparison.members.map((member) => member.referenceTime).sort().at(-1),
    );
  });

  it("echoes the one threshold set and carries the unavailable roster through", () => {
    expect(comparison.thresholds).toEqual(DEFAULT_ANALYZE_THRESHOLDS);
    expect(comparison.unavailable).toEqual([{ model: "nam-conus-nest", miss: "absent" }]);
    // §3 widening: the stamp binds as plain number and still reads the
    // constant at runtime — checks, not recompiles.
    const version: number = comparison.vocabularyVersion;
    expect(version).toBe(COMPARE_VOCABULARY_VERSION);
  });

  it("benches a member whose lift never reaches launch — the GEPS case, by arithmetic", () => {
    // The real terrain-deficit document, retagged onto erie's site: GEPS
    // models the ground at 144.1 m, and against the comparison's 1247 m
    // launch its published lift tops (max 793.7 m) never reach launch.
    const deficit = load("gepsFlagpole");
    (deficit.site as { id: string }).id = "erie";
    const withBenched = compareProfiles([hrrr(), reps(), deficit], {
      timeZone: TZ,
      launch: ERIE_LAUNCH,
    });
    const benched = withBenched.members.find((member) => member.model === "geps")!;
    expect(benched.benched).toMatchObject({ reason: "terrainMismatch" });
    // Benched members appear in the ledger and never in any roster — the
    // ledger entry IS their stated non-vote reason for every day.
    for (const finding of ofKind<WindowAgreementFinding>(withBenched.findings, "windowAgreement")) {
      expect(finding.windows.map((vote) => vote.model)).not.toContain("geps");
      expect(finding.quiet.map((vote) => vote.model)).not.toContain("geps");
      expect(finding.abstained.map((entry) => entry.model)).not.toContain("geps");
    }
    // The benched member's horizon still names the day: GEPS runs into
    // local 2026-08-10, which HRRR and REPS never reach — that day keeps
    // its roster record as pure outOfHorizon abstentions (the ratified
    // zero-voter call: suppress only at zero voters AND zero abstentions).
    const edge = ofKind<WindowAgreementFinding>(withBenched.findings, "windowAgreement").find(
      (finding) => finding.day === "2026-08-10",
    )!;
    expect(edge.voters).toBe(0);
    expect(edge.unanimous).toBeNull();
    expect(edge.abstained.map((entry) => ({ model: entry.model, reason: entry.reason }))).toEqual([
      { model: "hrrr-conus", reason: "outOfHorizon" },
      { model: "reps", reason: "outOfHorizon" },
    ]);
  });

  it("benches nobody without a launch — terrainMismatch is a launch statement", () => {
    const deficit = load("gepsFlagpole");
    (deficit.site as { id: string }).id = "erie";
    const launchFree = compareProfiles([hrrr(), reps(), deficit], { timeZone: TZ });
    expect(launchFree.site.launchAltitudeM).toBeNull();
    for (const member of launchFree.members) {
      expect(member.benched).toBeNull();
      expect(member.launchAltitudeM).toBeNull();
      expect(member.elevationDeltaM).toBeNull();
    }
    // And with no launch-relative peaks there is no heightSpread to state.
    expect(ofKind<HeightSpreadFinding>(launchFree.findings, "heightSpread")).toEqual([]);
  });
});

describe("windowAgreement", () => {
  const comparison = compareProfiles([hrrr(), reps()], { timeZone: TZ, launch: ERIE_LAUNCH });
  const agreement = ofKind<WindowAgreementFinding>(comparison.findings, "windowAgreement");
  const byDay = Object.fromEntries(agreement.map((finding) => [finding.day, finding]));

  it("is unanimous where both members forecast a window", () => {
    expect(byDay["2026-08-08"].voters).toBe(2);
    expect(byDay["2026-08-08"].unanimous).toBe(true);
    expect(byDay["2026-08-08"].windows.map((vote) => vote.model).sort()).toEqual([
      "hrrr-conus",
      "reps",
    ]);
    expect(byDay["2026-08-08"].quiet).toEqual([]);
    expect(byDay["2026-08-08"].abstained).toEqual([]);
  });

  it("keeps clipped edges out of the timing envelope — they are data boundaries", () => {
    // Both documents begin mid-window on day one: no unclipped starts.
    expect(byDay["2026-08-08"].timing.starts).toEqual([]);
    expect(byDay["2026-08-08"].timing.startSpreadHours).toBeNull();
    // Both ends are real forecasts on day one: HRRR decays at 18:00,
    // REPS at 14:00 local — a four-hour spread, honestly disagreed.
    expect(byDay["2026-08-08"].timing.endSpreadHours).toBe(4);
    // Day two inverts it: real starts (both 11:00, spread 0), clipped ends.
    expect(byDay["2026-08-09"].timing.startSpreadHours).toBe(0);
    expect(byDay["2026-08-09"].timing.ends).toEqual([]);
    expect(byDay["2026-08-09"].timing.endSpreadHours).toBeNull();
  });

  it("echoes each timing vote's cadence and states the widest step beside the spread", () => {
    // Tier 0 #5: REPS's 11:00 edge is 3-hourly — "somewhere in 08:00–11:00"
    // — so up to 2 h of any spread against it is quantization. Both
    // members stay IN the spread; the step is confessed beside it.
    const starts = byDay["2026-08-09"].timing.starts;
    expect(Object.fromEntries(starts.map((entry) => [entry.model, entry.stepHours]))).toEqual({
      "hrrr-conus": 1,
      reps: 3,
    });
    expect(byDay["2026-08-09"].timing.startStepHoursMax).toBe(3);
    expect(byDay["2026-08-09"].timing.endStepHoursMax).toBeNull();
    expect(byDay["2026-08-08"].timing.endStepHoursMax).toBe(3);
    expect(byDay["2026-08-08"].timing.startStepHoursMax).toBeNull();
  });

  it("turns truncated quiet days into abstentions, never votes — and keeps the day (zero voters, nonzero abstentions)", () => {
    // An impossible W* floor makes every day windowless; both documents
    // clip both their days, so every quiet call is a data boundary.
    const quiet = compareProfiles([hrrr(), reps()], {
      timeZone: TZ,
      launch: ERIE_LAUNCH,
      thresholds: { thermalWindow: { wstarMinMs: 99, depthMinM: 300 } },
    });
    const findings = ofKind<WindowAgreementFinding>(quiet.findings, "windowAgreement");
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.windows).toEqual([]);
      expect(finding.quiet).toEqual([]);
      expect(finding.voters).toBe(0);
      expect(finding.unanimous).toBeNull();
      expect(finding.abstained.length).toBeGreaterThan(0);
      for (const abstention of finding.abstained) {
        expect(abstention.reason).toBe("truncatedDay");
      }
      // No voter offered a number: sensitivity has nothing to state.
      expect(finding.sensitivity).toEqual({ wstarFlipAtMs: null, depthFlipAtM: null });
    }
  });
});

describe("the midnight electorate (Tier 0 #3)", () => {
  // det-a forecasts one window across local midnight: 22:00 (08-08) to
  // 02:00 (08-09), W* 1.2 / top 1847 (depth 600 over the 1247 launch).
  // det-b is quiet on both days at W* 0.2 / top 1350 (depth 103).
  const twoDays = (day1: string, day2: string, spec: (validAt: string) => Omit<HourSpec, "validAt">) =>
    [...fullDay(day1, () => QUIET), ...fullDay(day2, () => QUIET)].map((hour) => ({
      ...hour,
      ...spec(hour.validAt),
    }));
  const spannerHours = new Set([5, 6, 7, 8, 9].map((utcHour) => `2026-08-09T0${utcHour}:00:00Z`));
  const detA = detMember({
    model: "det-a",
    referenceTime: "2026-08-08T06:00:00Z",
    hours: twoDays("2026-08-08", "2026-08-09", (validAt) =>
      spannerHours.has(validAt) ? { wstar: 1.2, top: 1847 } : QUIET,
    ),
  });
  const detB = detMember({
    model: "det-b",
    referenceTime: "2026-08-08T06:00:00Z",
    hours: twoDays("2026-08-08", "2026-08-09", () => ({ wstar: 0.2, top: 1350 })),
  });
  const comparison = compareProfiles([detA, detB], { timeZone: TZ, launch: ERIE_LAUNCH });
  const byDay = Object.fromEntries(
    ofKind<WindowAgreementFinding>(comparison.findings, "windowAgreement").map((finding) => [
      finding.day,
      finding,
    ]),
  );

  it("votes the spanning window on BOTH days it touches — no silently shrunken electorate", () => {
    // Before v2 the spanner suppressed det-a's quietDay on 08-09 but voted
    // only 08-08: day two read voters 1 over a silently shrunken field.
    for (const day of ["2026-08-08", "2026-08-09"]) {
      expect(byDay[day].voters).toBe(2);
      expect(byDay[day].unanimous).toBe(false);
      expect(byDay[day].windows.map((vote) => vote.model)).toEqual(["det-a"]);
      expect(byDay[day].quiet.map((vote) => vote.model)).toEqual(["det-b"]);
      expect(byDay[day].abstained).toEqual([]);
    }
  });

  it("marks the second day's vote viaWindowFrom — the numbers describe the whole window", () => {
    expect(byDay["2026-08-08"].windows[0].viaWindowFrom).toBeUndefined();
    expect(byDay["2026-08-09"].windows[0].viaWindowFrom).toBe("2026-08-08");
    // Both votes restate the SAME window.
    expect(byDay["2026-08-09"].windows[0].start.validAt).toBe("2026-08-09T05:00:00Z");
    expect(byDay["2026-08-09"].windows[0].end.validAt).toBe("2026-08-09T09:00:00Z");
    expect(byDay["2026-08-09"].windows[0].durationHours).toBe(5);
  });

  it("assigns each timing edge to the day containing its instant", () => {
    // The spanner OPENS on 08-08 (22:00 local) and CLOSES on 08-09 (02:00):
    // each edge is a statement about its own day, never the other's.
    expect(byDay["2026-08-08"].timing.starts.map((entry) => entry.at.local)).toEqual([
      "2026-08-08T22:00",
    ]);
    expect(byDay["2026-08-08"].timing.ends).toEqual([]);
    expect(byDay["2026-08-09"].timing.starts).toEqual([]);
    expect(byDay["2026-08-09"].timing.ends.map((entry) => entry.at.local)).toEqual([
      "2026-08-09T02:00",
    ]);
  });

  it("states the sensitivity arithmetic from the voters' own peaks", () => {
    // W* floor 0.9: det-a clears at 1.2 (0.3 away), det-b misses at 0.2
    // (0.7 away) — the nearest flip is the window vote's own peak, 1.2.
    // Depth floor 300: det-a clears at 600 (300 away), det-b misses at
    // 103 (197 away) — the nearest flip is the quiet vote's peak, 103.
    for (const day of ["2026-08-08", "2026-08-09"]) {
      expect(byDay[day].sensitivity).toEqual({ wstarFlipAtMs: 1.2, depthFlipAtM: 103 });
    }
  });

  it("keeps the peak with the day it fires in — no heightSpread from a one-peak day", () => {
    // det-a's peak instant (22:00 local) belongs to 08-08; det-b is quiet
    // everywhere. Neither day has two peaks, so no spread is a statement.
    expect(ofKind<HeightSpreadFinding>(comparison.findings, "heightSpread")).toEqual([]);
  });
});

describe("outOfHorizon abstentions (Tier 0 #4)", () => {
  // Two runs of one model with disjoint horizons: run A covers local
  // 08-08 only, run B local 08-09 only — each day's roster must name the
  // run that never reached it.
  const windowSpec = (localHour: number) =>
    localHour >= 11 && localHour <= 13 ? { wstar: 1.2, top: 1847 } : QUIET;
  const runA = detMember({
    model: "det-c",
    referenceTime: "2026-08-08T06:00:00Z",
    hours: fullDay("2026-08-08", windowSpec),
  });
  const runB = detMember({
    model: "det-c",
    referenceTime: "2026-08-09T06:00:00Z",
    hours: fullDay("2026-08-09", windowSpec),
  });
  const comparison = compareProfiles([runA, runB], { timeZone: TZ, launch: ERIE_LAUNCH });
  const byDay = Object.fromEntries(
    ofKind<WindowAgreementFinding>(comparison.findings, "windowAgreement").map((finding) => [
      finding.day,
      finding,
    ]),
  );

  it("rosters the member that never reaches the day, with its reason", () => {
    expect(byDay["2026-08-08"].voters).toBe(1);
    expect(byDay["2026-08-08"].unanimous).toBeNull();
    expect(byDay["2026-08-08"].windows.map((vote) => vote.member)).toEqual([
      "det-c@2026-08-08T06:00:00Z",
    ]);
    expect(byDay["2026-08-08"].abstained).toEqual([
      { member: "det-c@2026-08-09T06:00:00Z", model: "det-c", reason: "outOfHorizon" },
    ]);
    // And mirrored on the day only run B reaches.
    expect(byDay["2026-08-09"].windows.map((vote) => vote.member)).toEqual([
      "det-c@2026-08-09T06:00:00Z",
    ]);
    expect(byDay["2026-08-09"].abstained).toEqual([
      { member: "det-c@2026-08-08T06:00:00Z", model: "det-c", reason: "outOfHorizon" },
    ]);
  });

  it("states single-voter sensitivity from the lone window vote's peaks", () => {
    // One voter: W* 1.2 and depth 600 are the only candidates — the
    // nearest clear IS the statement, however far.
    expect(byDay["2026-08-08"].sensitivity).toEqual({ wstarFlipAtMs: 1.2, depthFlipAtM: 600 });
  });
});

describe("zero-voter suppression (the ratified call)", () => {
  it("suppresses a day only at zero voters AND zero abstentions", () => {
    // A lone benched member: its horizon names days, but with no unbenched
    // member there is nobody to vote and nobody to abstain — nothing to
    // state, so no windowAgreement finding exists at all. (The kept-day
    // half of the rule is pinned in the ledger and truncation tests:
    // pure-abstention days keep their roster records.)
    const deficit = load("gepsFlagpole");
    (deficit.site as { id: string }).id = "erie";
    const comparison = compareProfiles([deficit], { timeZone: TZ, launch: ERIE_LAUNCH });
    expect(comparison.members[0].benched).toMatchObject({ reason: "terrainMismatch" });
    expect(ofKind<WindowAgreementFinding>(comparison.findings, "windowAgreement")).toEqual([]);
  });
});

describe("windDivergence", () => {
  // Three deterministic members, identical windows (11:00–13:00 local),
  // hand-authored climb-band winds and gusts. Surface wind is held at
  // 0.5 m/s — under the direction floor — so no windDirectionSpread
  // finding muddies the day. Band: launch 1247 − 200 margin to
  // 1847 + 200, so the 1500 m level is in-band and 3000 m is out.
  const divMember = (
    model: string,
    bandWindMs: number,
    gustMs: number,
    gustSemantics?: "hourMax" | "instant",
  ) =>
    detMember({
      model,
      referenceTime: "2026-08-08T06:00:00Z",
      ...(gustSemantics ? { gustSemantics } : {}),
      hours: fullDay("2026-08-08", (localHour) => ({
        ...(localHour >= 11 && localHour <= 13 ? { wstar: 1.2, top: 1847 } : QUIET),
        wind: { speedMs: 0.5, directionDeg: 90 },
        gustMs,
        levels: [
          { heightM: 1500, windSpeedMs: bandWindMs, windDirectionDeg: 270, pressureHpa: 850 },
          { heightM: 3000, windSpeedMs: 20, windDirectionDeg: 270, pressureHpa: 700 },
        ],
      })),
    });
  const comparison = compareProfiles(
    [
      divMember("div-a", 5, 10, "hourMax"),
      divMember("div-b", 7.5, 6, "instant"),
      divMember("div-c", 6, 8),
    ],
    { timeZone: TZ, launch: ERIE_LAUNCH },
  );
  const divergence = ofKind<WindDivergenceFinding>(comparison.findings, "windDivergence");

  it("rosters every voter's in-window band maximum with the mandatory elevation echo", () => {
    expect(divergence).toHaveLength(1);
    const finding = divergence[0];
    expect(finding.day).toBe("2026-08-08");
    expect(finding.bandWind.entries).toHaveLength(3);
    expect(
      finding.bandWind.entries.map((entry) => ({ model: entry.model, windMs: entry.windMs })),
    ).toEqual([
      { model: "div-a", windMs: 5 },
      { model: "div-b", windMs: 7.5 },
      { model: "div-c", windMs: 6 },
    ]);
    for (const entry of finding.bandWind.entries) {
      expect(entry.modelElevationM).toBe(1177.6); // S3: the regime echo, per entry
      expect(entry.heightM).toBe(1500);
      expect(entry.scope).toBe("duringWindow");
      expect(entry.at.local).toBe("2026-08-08T11:00");
    }
    expect(finding.bandWind.spreadMs).toBe(2.5); // 7.5 − 5, by hand
  });

  it("never pools gusts across semantics classes — undeclared rosters without a spread", () => {
    const gust = divergence[0].gust;
    // One member per class: each roster stands, no spread is manufactured.
    expect(gust.hourMax.entries.map((entry) => entry.model)).toEqual(["div-a"]);
    expect(gust.hourMax.entries[0].gustMs).toBe(10);
    expect(gust.hourMax.spreadMs).toBeNull();
    expect(gust.instant.entries.map((entry) => entry.model)).toEqual(["div-b"]);
    expect(gust.instant.spreadMs).toBeNull();
    // div-c declares nothing: rostered as a record, deliberately never
    // spread — an undeclared gust compares with nothing (measured class
    // gap ~1.8–2.8×, S3).
    expect(gust.undeclared.entries.map((entry) => entry.model)).toEqual(["div-c"]);
    expect("spreadMs" in gust.undeclared).toBe(false);
  });

  it("spreads gusts within one declared class", () => {
    const twin = compareProfiles(
      [divMember("div-a", 5, 10, "hourMax"), divMember("div-d", 6.5, 7.2, "hourMax")],
      { timeZone: TZ, launch: ERIE_LAUNCH },
    );
    const finding = ofKind<WindDivergenceFinding>(twin.findings, "windDivergence")[0];
    expect(finding.gust.hourMax.entries).toHaveLength(2);
    expect(finding.gust.hourMax.spreadMs).toBe(2.8); // 10 − 7.2, by hand
    expect(finding.gust.instant.entries).toEqual([]);
    expect(finding.gust.instant.spreadMs).toBeNull();
  });
});

describe("windDirectionSpread", () => {
  // Two deterministic members with steady 3 m/s surface flow 120° apart,
  // grounded 277.6 m apart — plus the real REPS ensemble, whose published
  // direction percentiles are not circular statistics and which therefore
  // never enters (the analyze kind's own hard gate).
  const dirMember = (model: string, directionDeg: number, modelElevationM?: number) =>
    detMember({
      model,
      referenceTime: "2026-08-08T18:00:00Z",
      ...(modelElevationM !== undefined ? { modelElevationM } : {}),
      hours: fullDay("2026-08-08", (localHour) => ({
        ...(localHour >= 11 && localHour <= 13 ? { wstar: 1.2, top: 1847 } : QUIET),
        wind: { speedMs: 3, directionDeg },
      })),
    });
  const comparison = compareProfiles([dirMember("dir-a", 90), dirMember("dir-b", 210, 900), reps()], {
    timeZone: TZ,
    launch: ERIE_LAUNCH,
  });
  const spreads = ofKind<WindDirectionSpreadFinding>(comparison.findings, "windDirectionSpread");

  it("rosters deterministic voters only, with vector-mean directions and elevations", () => {
    const finding = spreads.find((entry) => entry.day === "2026-08-08")!;
    // REPS voted the window on 08-08 but has no direction statement to
    // roster: exactly two entries.
    expect(finding.entries).toEqual([
      { member: "dir-a@2026-08-08T18:00:00Z", model: "dir-a", directionDeg: 90, speedMs: 3, modelElevationM: 1177.6 },
      { member: "dir-b@2026-08-08T18:00:00Z", model: "dir-b", directionDeg: 210, speedMs: 3, modelElevationM: 900 },
    ]);
    expect(finding.thresholds).toEqual({ directionFloorMs: 1 });
  });

  it("states the max circular separation with the pair's elevations riding it", () => {
    const finding = spreads.find((entry) => entry.day === "2026-08-08")!;
    expect(finding.maxAngularSeparationDeg).toBe(120); // 90 vs 210, circular
    expect(finding.maxSeparation).toEqual({
      members: ["dir-a@2026-08-08T18:00:00Z", "dir-b@2026-08-08T18:00:00Z"],
      models: ["dir-a", "dir-b"],
      modelElevationM: [1177.6, 900],
      elevationDeltaM: 277.6, // S3: the regime caveat rides the statement
    });
  });
});

describe("the percentile carry-through and the heightSpread band (S1)", () => {
  /* The analyze suite's hand-authored crossing document, rebuilt here:
     a REPS clone whose 08-09 window hour (14:00 local) passes p25–p90
     while p10 fails both floors (minimal token p25), and whose 08-11
     window hour passes at EVERY percentile (no crossing — token null).
     The 21:00Z band [p10, p90] = [1500, 2500] MSL is the peak-hour band
     the heightSpread context restates launch-relative. */
  type Ev = { members: number; p10: number; p25: number; p50: number; p75: number; p90: number };
  const ev = (p10: number, p25: number, p50: number, p75: number, p90: number): Ev => ({
    members: 21,
    p10,
    p25,
    p50,
    p75,
    p90,
  });
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
      hour("2026-08-09T21:00:00Z", ev(0.5, 0.95, 1.2, 1.5, 1.8), ev(1500, 1600, 1900, 2200, 2500)),
      hour("2026-08-10T00:00:00Z", quietWstar(), quietTop()),
      hour("2026-08-10T03:00:00Z", quietWstar(), quietTop()),
      hour("2026-08-10T06:00:00Z", quietWstar(), quietTop()),
      hour("2026-08-10T09:00:00Z", quietWstar(), quietTop()),
      hour("2026-08-10T12:00:00Z", quietWstar(), quietTop()),
      hour("2026-08-10T18:00:00Z", quietWstar(), quietTop()),
      hour("2026-08-11T00:00:00Z", quietWstar(), quietTop()),
      hour("2026-08-11T06:00:00Z", quietWstar(), quietTop()),
      hour("2026-08-11T12:00:00Z", quietWstar(), quietTop()),
      hour("2026-08-11T18:00:00Z", ev(1.0, 1.2, 1.5, 1.8, 2.0), ev(1600, 1700, 1900, 2100, 2300)),
    ];
    const profile = parseWindgramProfile(doc);
    expect(profile).not.toBeNull();
    return profile!;
  }

  const comparison = compareProfiles([crossingFixture(), hrrr()], {
    timeZone: TZ,
    launch: ERIE_LAUNCH,
  });
  const byDay = Object.fromEntries(
    ofKind<WindowAgreementFinding>(comparison.findings, "windowAgreement").map((finding) => [
      finding.day,
      finding,
    ]),
  );

  it("carries the member's minimal passing percentile onto its window vote", () => {
    const votes = byDay["2026-08-09"].windows;
    // The fragile day: p50 passes while p10 fails — the crossing exists
    // and its token rides the vote.
    expect(votes.find((vote) => vote.model === "reps")!.minimalPassingPercentile).toBe("p25");
    // The deterministic member publishes no percentiles: null, always.
    expect(votes.find((vote) => vote.model === "hrrr-conus")!.minimalPassingPercentile).toBeNull();
  });

  it("leaves the token null where every percentile agrees — no crossing, not confidence", () => {
    const votes = byDay["2026-08-11"].windows;
    expect(votes).toHaveLength(1);
    expect(votes[0].model).toBe("reps");
    expect(votes[0].minimalPassingPercentile).toBeNull();
  });

  it("gives the ensemble peak its own launch-relative p10–p90 band as context", () => {
    const spread = ofKind<HeightSpreadFinding>(comparison.findings, "heightSpread").find(
      (finding) => finding.day === "2026-08-09",
    )!;
    const repsPeak = spread.peaks.find((peak) => peak.model === "reps")!;
    expect(repsPeak.peakLiftTopAboveLaunchM).toBe(653); // 1900 − 1247
    expect(repsPeak.at.validAt).toBe("2026-08-09T21:00:00Z");
    // The member's own envelope at its peak hour, in the peak's frame:
    // [1500, 2500] MSL − 1247 launch. Context only — never a verdict.
    expect(repsPeak.bandP10P90AboveLaunchM).toEqual([253, 1253]);
    // Deterministic peaks carry no band: there is no envelope to restate.
    const hrrrPeak = spread.peaks.find((peak) => peak.model === "hrrr-conus")!;
    expect(hrrrPeak.bandP10P90AboveLaunchM).toBeNull();
  });
});

describe("heightSpread", () => {
  const comparison = compareProfiles([hrrr(), reps()], { timeZone: TZ, launch: ERIE_LAUNCH });
  const spreads = ofKind<HeightSpreadFinding>(comparison.findings, "heightSpread");

  it("states launch-relative peaks per member with the spread — and no aggregate", () => {
    expect(spreads.length).toBeGreaterThan(0);
    for (const finding of spreads) {
      expect(finding.peaks.length).toBeGreaterThanOrEqual(2);
      const values = finding.peaks.map((peak) => peak.peakLiftTopAboveLaunchM);
      expect(finding.spreadM).toBeCloseTo(Math.max(...values) - Math.min(...values), 6);
      // Divergence is the statement: no mean, no median, no consensus key.
      expect(Object.keys(finding).sort()).toEqual(["day", "kind", "peaks", "spreadM"]);
    }
  });
});

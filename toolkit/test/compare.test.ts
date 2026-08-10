import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWindgramProfile, type WindgramProfile } from "../src/contract/index.js";
import {
  compareProfiles,
  COMPARE_VOCABULARY_VERSION,
  type HeightSpreadFinding,
  type WindowAgreementFinding,
} from "../src/compare/index.js";
import { DEFAULT_ANALYZE_THRESHOLDS } from "../src/analyze/index.js";

/* Same corpus as analyze's tests: two real erie documents (hourly
   deterministic HRRR, 3-hourly ensemble REPS) compare as members; the
   flagpole GEPS document is the mixed-site guard case and — with its
   terrain deficit — the benching case once retagged onto erie's site. */

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

describe("compareProfiles guards", () => {
  it("refuses mixed sites — one comparison, one site", () => {
    expect(() => compareProfiles([hrrr(), load("gepsFlagpole")], { timeZone: TZ })).toThrow(
      /mixed sites/,
    );
  });

  it("refuses an empty member list", () => {
    expect(() => compareProfiles([], { timeZone: TZ })).toThrow(/no members/);
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
    expect(comparison.vocabularyVersion).toBe(COMPARE_VOCABULARY_VERSION);
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
    // Benched members appear in the ledger and never in the votes.
    for (const finding of ofKind<WindowAgreementFinding>(withBenched.findings, "windowAgreement")) {
      expect(finding.windows.map((vote) => vote.model)).not.toContain("geps");
      expect(finding.quiet.map((vote) => vote.model)).not.toContain("geps");
    }
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

  it("turns truncated quiet days into abstentions, never votes", () => {
    // An impossible W* floor makes every day windowless; both documents
    // clip both their days, so every quiet call is a data boundary.
    const quiet = compareProfiles([hrrr(), reps()], {
      timeZone: TZ,
      launch: ERIE_LAUNCH,
      thresholds: { flyableWindow: { wstarMinMs: 99, depthMinM: 300 } },
    });
    for (const finding of ofKind<WindowAgreementFinding>(quiet.findings, "windowAgreement")) {
      expect(finding.windows).toEqual([]);
      expect(finding.quiet).toEqual([]);
      expect(finding.voters).toBe(0);
      expect(finding.unanimous).toBeNull();
      expect(finding.abstained.length).toBeGreaterThan(0);
      for (const abstention of finding.abstained) {
        expect(abstention.reason).toBe("truncatedDay");
      }
    }
  });
});

describe("heightSpread", () => {
  const comparison = compareProfiles([hrrr(), reps()], { timeZone: TZ, launch: ERIE_LAUNCH });
  const spreads = ofKind<HeightSpreadFinding>(comparison.findings, "heightSpread");

  it("states launch-relative peaks per model with the spread — and no aggregate", () => {
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

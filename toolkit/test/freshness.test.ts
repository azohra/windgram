import { describe, expect, it } from "vitest";
import { runFreshness, type RunFreshnessThresholds } from "../src/derive/index.js";

/* HRDPS-continental-shaped facts: a run every 6 h, published within 4.5 h
   of its referenceTime at the upper end of normal. */
const MODEL = { runIntervalHours: 6, typicalPublicationLagHours: 4.5 };

/* The downstream prototype's tolerance: current while the successor may
   simply not exist yet (one interval + lag), delayed through a second
   interval, stale beyond. */
const THRESHOLDS: RunFreshnessThresholds = { currentIntervals: 1, staleAfterIntervals: 2 };

const RUN = { referenceTime: "2026-08-10T00:00:00Z", generatedAt: "2026-08-10T03:55:00Z" };

function at(hoursAfterReference: number): string {
  return new Date(Date.parse(RUN.referenceTime) + hoursAfterReference * 3_600_000).toISOString();
}

describe("runFreshness", () => {
  it("grades current, delayed, and stale exactly at the interval+lag boundaries", () => {
    // Current through 1×6 + 4.5 = 10.5 h: the successor may not exist yet.
    expect(runFreshness(RUN, MODEL, at(0), THRESHOLDS)).toBe("current");
    expect(runFreshness(RUN, MODEL, at(10.5), THRESHOLDS)).toBe("current");
    // Delayed through 2×6 + 4.5 = 16.5 h: late, but still the newest there is.
    expect(runFreshness(RUN, MODEL, at(10.51), THRESHOLDS)).toBe("delayed");
    expect(runFreshness(RUN, MODEL, at(16.5), THRESHOLDS)).toBe("delayed");
    // Stale beyond: the feed has missed whole runs.
    expect(runFreshness(RUN, MODEL, at(16.51), THRESHOLDS)).toBe("stale");
    expect(runFreshness(RUN, MODEL, at(48), THRESHOLDS)).toBe("stale");
  });

  it("takes the facts from the catalogue entry — a slower model stays current longer", () => {
    const gdps = { runIntervalHours: 12, typicalPublicationLagHours: 6 };
    // 16 h after a GDPS reference time is current (≤ 12 + 6)…
    expect(runFreshness(RUN, gdps, at(16), THRESHOLDS)).toBe("current");
    // …while the same age is delayed for the 6-hourly model above.
    expect(runFreshness(RUN, MODEL, at(16), THRESHOLDS)).toBe("delayed");
  });

  it("leaves the tolerance to the consumer — thresholds move the boundaries, not the facts", () => {
    const lenient: RunFreshnessThresholds = { currentIntervals: 2, staleAfterIntervals: 4 };
    expect(runFreshness(RUN, MODEL, at(16), THRESHOLDS)).toBe("delayed");
    expect(runFreshness(RUN, MODEL, at(16), lenient)).toBe("current");
    expect(runFreshness(RUN, MODEL, at(20), THRESHOLDS)).toBe("stale");
    expect(runFreshness(RUN, MODEL, at(20), lenient)).toBe("delayed");
  });

  it("judges age on referenceTime — a republish never makes the forecast younger", () => {
    const republished = { ...RUN, generatedAt: at(11) };
    expect(runFreshness(republished, MODEL, at(12), THRESHOLDS)).toBe("delayed");
    // And an entry without generatedAt is equally acceptable.
    expect(
      runFreshness({ referenceTime: RUN.referenceTime }, MODEL, at(12), THRESHOLDS),
    ).toBe("delayed");
  });

  it("tolerates a referenceTime in the future (clock skew) as current, never negative-age weirdness", () => {
    expect(runFreshness(RUN, MODEL, "2026-08-09T23:00:00Z", THRESHOLDS)).toBe("current");
  });

  it("throws on an unparseable instant instead of returning a plausible grade", () => {
    expect(() =>
      runFreshness({ referenceTime: "not a time" }, MODEL, at(0), THRESHOLDS),
    ).toThrow(RangeError);
    expect(() => runFreshness(RUN, MODEL, "not a time", THRESHOLDS)).toThrow(RangeError);
  });
});

import { describe, expect, it } from "vitest";
import {
  isDeterministicProfile,
  parseWindgramProfile,
  type DeterministicWindgramProfile,
  type WindgramProfile,
} from "../src/contract/index.js";
import { deterministicHour, deterministicProfile, ensembleProfile, ensembleValue } from "./fixtures.js";

describe("isDeterministicProfile", () => {
  it("accepts a deterministic document", () => {
    expect(isDeterministicProfile(deterministicProfile())).toBe(true);
  });

  it("answers from the run.members declaration first — no scan needed", () => {
    // A 0.3.0 ensemble document whose every position happens to be a plain
    // number (degenerate but possible) is still an ensemble by declaration.
    const declared = deterministicProfile();
    (declared.run as { members?: number }).members = 21;
    expect(isDeterministicProfile(declared)).toBe(false);
  });

  it("falls back to the shape scan for pre-declaration ensemble documents", () => {
    const legacy = ensembleProfile();
    delete (legacy.run as { members?: number }).members; // pre-0.3.0 document
    expect(isDeterministicProfile(legacy)).toBe(false);
  });

  it("scans levels and derived, not just the surface", () => {
    const base = deterministicHour();
    const levelEnsemble = deterministicProfile({
      hours: [
        deterministicHour({
          levels: [{ ...base.levels[0], temperatureC: ensembleValue({ p50: 20 }) }],
        }),
      ],
    });
    expect(isDeterministicProfile(levelEnsemble)).toBe(false);

    const derivedEnsemble = deterministicProfile({
      hours: [
        deterministicHour({
          derived: { ...base.derived, thermalVelocityMs: ensembleValue({ p50: 1.6 }) },
        }),
      ],
    });
    expect(isDeterministicProfile(derivedEnsemble)).toBe(false);
  });

  it("treats null positions as deterministic — null is a value, not a spread", () => {
    const withNulls = deterministicProfile({
      hours: [
        deterministicHour({
          derived: {
            boundaryLayerTopM: null,
            thermalVelocityMs: 0,
            cloudBaseM: 1500,
            usableLiftTopM: null,
          },
        }),
      ],
    });
    expect(isDeterministicProfile(withNulls)).toBe(true);
  });

  it("narrows the type so p50() becomes unnecessary — the one-check escape", () => {
    const parsed = parseWindgramProfile(deterministicProfile());
    expect(parsed).not.toBeNull();
    const profile: WindgramProfile = parsed!;
    expect(isDeterministicProfile(profile)).toBe(true);
    if (isDeterministicProfile(profile)) {
      // Type-level assertions: every assignment below only compiles if the
      // narrowing really turned Scalar positions into numbers.
      const wStar: number = profile.hours[0].derived.thermalVelocityMs;
      const blTop: number | null = profile.hours[0].derived.boundaryLayerTopM;
      const temperature: number = profile.hours[0].surface.temperatureC;
      const gust: number | undefined = profile.hours[0].surface.windGustMs;
      const levelHeight: number = profile.hours[0].levels[0].heightM;
      const members: undefined = profile.run.members;
      expect(wStar).toBeCloseTo(1.63);
      expect(blTop).toBeCloseTo(3223.1);
      expect(temperature).toBeCloseTo(28.28);
      expect(gust).toBeUndefined();
      expect(levelHeight).toBeCloseTo(1252.4);
      expect(members).toBeUndefined();
      // And the narrowed document is still a WindgramProfile.
      const widened: WindgramProfile = profile satisfies DeterministicWindgramProfile;
      expect(widened.model).toBe("hrdps-continental");
    }
  });
});

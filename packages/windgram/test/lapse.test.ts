import { describe, expect, it } from "vitest";
import {
  lapseRateCPer1000Ft,
  lapseRateCPerKm,
  surfaceLapseCPer1000Ft,
  surfaceLapseCPerKm,
} from "../src/derive/lapse.js";

const lower = { heightM: 1000, temperatureC: 10 };
const upper = { heightM: 2000, temperatureC: 3.5 };

describe("lapse rate between adjacent levels", () => {
  it("computes degC per km", () => {
    expect(lapseRateCPerKm(lower, upper)).toBeCloseTo(-6.5, 10);
  });

  it("computes degC per 1000 ft with the 304.8 m-per-1000-ft factor", () => {
    expect(lapseRateCPer1000Ft(lower, upper)).toBeCloseTo((-6.5 / 1000) * 304.8, 10);
  });

  it("is null for a zero-thickness layer", () => {
    expect(lapseRateCPerKm(lower, { ...upper, heightM: lower.heightM })).toBeNull();
    expect(lapseRateCPer1000Ft(lower, { ...upper, heightM: lower.heightM })).toBeNull();
  });

  it("is positive for an inversion", () => {
    expect(lapseRateCPerKm(lower, { heightM: 1500, temperatureC: 12 })).toBeCloseTo(4, 10);
  });
});

describe("surface-to-first-level lapse", () => {
  it("anchors the surface lapse at model elevation", () => {
    // ((first.T - surfaceT) / (first.heightM - modelElevationM)) * 304.8
    const first = { heightM: 1252.4, temperatureC: 25.74 };
    const expected = ((25.74 - 28.28) / (1252.4 - 1072.5)) * 304.8;
    expect(surfaceLapseCPer1000Ft(28.28, 1072.5, first)).toBeCloseTo(expected, 10);
  });

  it("offers the per-km variant", () => {
    expect(surfaceLapseCPerKm(10, 1000, { heightM: 1500, temperatureC: 6 })).toBeCloseTo(-8, 10);
  });

  it("is null when the first level does not sit above model elevation", () => {
    expect(surfaceLapseCPer1000Ft(10, 1500, { heightM: 1500, temperatureC: 9 })).toBeNull();
    expect(surfaceLapseCPerKm(10, 1500, { heightM: 1400, temperatureC: 9 })).toBeNull();
  });
});

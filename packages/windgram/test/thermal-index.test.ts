import { describe, expect, it } from "vitest";
import {
  DRY_ADIABATIC_LAPSE_C_PER_M,
  thermalIndexC,
  thermalIndexProfile,
} from "../src/derive/thermal-index.js";

describe("thermalIndexC", () => {
  it("uses the pipeline's dry adiabatic constant", () => {
    expect(DRY_ADIABATIC_LAPSE_C_PER_M).toBe(0.0098);
  });

  it("compares the lifted parcel against the level temperature", () => {
    // Parcel: 30 - 0.0098 * 1000 = 20.2; TI = 21.5 - 20.2 = 1.3 (stable).
    expect(
      thermalIndexC({
        surfaceTemperatureC: 30,
        surfaceElevationM: 1000,
        level: { heightM: 2000, temperatureC: 21.5 },
      }),
    ).toBeCloseTo(1.3, 10);
  });

  it("is negative while the parcel stays warmer than the environment", () => {
    expect(
      thermalIndexC({
        surfaceTemperatureC: 30,
        surfaceElevationM: 1000,
        level: { heightM: 2000, temperatureC: 15 },
      }),
    ).toBeCloseTo(-5.2, 10);
  });

  it("is zero at the surface itself", () => {
    expect(
      thermalIndexC({
        surfaceTemperatureC: 28.28,
        surfaceElevationM: 1072.5,
        level: { heightM: 1072.5, temperatureC: 28.28 },
      }),
    ).toBeCloseTo(0, 10);
  });
});

describe("thermalIndexProfile", () => {
  it("maps every level in published order", () => {
    const profile = thermalIndexProfile(30, 1000, [
      { heightM: 1500, temperatureC: 24 },
      { heightM: 2000, temperatureC: 21.5 },
    ]);
    expect(profile).toHaveLength(2);
    expect(profile[0].heightM).toBe(1500);
    expect(profile[0].thermalIndexC).toBeCloseTo(24 - (30 - 0.0098 * 500), 10);
    expect(profile[1].thermalIndexC).toBeCloseTo(1.3, 10);
  });

  it("returns an empty profile for a model without levels", () => {
    expect(thermalIndexProfile(30, 1000, [])).toEqual([]);
  });
});

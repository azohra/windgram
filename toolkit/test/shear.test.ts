import { describe, expect, it } from "vitest";
import {
  buoyancyShearRatio,
  surfaceToBoundaryLayerShearMs,
  vectorShearMs,
} from "../src/derive/shear.js";

describe("vectorShearMs", () => {
  it("is zero for identical winds", () => {
    expect(
      vectorShearMs(
        { windSpeedMs: 6, windDirectionDeg: 245 },
        { windSpeedMs: 6, windDirectionDeg: 245 },
      ),
    ).toBeCloseTo(0, 10);
  });

  it("is zero between two calm levels", () => {
    expect(
      vectorShearMs(
        { windSpeedMs: 0, windDirectionDeg: 0 },
        { windSpeedMs: 0, windDirectionDeg: 0 },
      ),
    ).toBe(0);
  });

  it("adds speeds for opposed directions", () => {
    expect(
      vectorShearMs(
        { windSpeedMs: 5, windDirectionDeg: 0 },
        { windSpeedMs: 5, windDirectionDeg: 180 },
      ),
    ).toBeCloseTo(10, 10);
  });

  it("composes perpendicular winds vectorially (3-4-5)", () => {
    expect(
      vectorShearMs(
        { windSpeedMs: 3, windDirectionDeg: 180 },
        { windSpeedMs: 4, windDirectionDeg: 270 },
      ),
    ).toBeCloseTo(5, 10);
  });
});

describe("surfaceToBoundaryLayerShearMs", () => {
  const base = {
    surfaceWind: { windSpeedMs: 0, windDirectionDeg: 0 },
    modelElevationM: 1000,
    levels: [
      { heightM: 2000, windSpeedMs: 10, windDirectionDeg: 270 },
      { heightM: 3000, windSpeedMs: 20, windDirectionDeg: 270 },
    ],
  };

  it("interpolates the wind at the boundary-layer top", () => {
    // Calm surface at 1000 m, 10 m/s at 2000 m: halfway up, 5 m/s.
    expect(surfaceToBoundaryLayerShearMs({ ...base, boundaryLayerTopM: 1500 })).toBeCloseTo(5, 10);
  });

  it("interpolates between levels above the first", () => {
    expect(surfaceToBoundaryLayerShearMs({ ...base, boundaryLayerTopM: 2500 })).toBeCloseTo(15, 10);
  });

  it("is null when the hour has no boundary layer", () => {
    expect(surfaceToBoundaryLayerShearMs({ ...base, boundaryLayerTopM: null })).toBeNull();
  });

  it("is null when the model publishes no levels", () => {
    expect(
      surfaceToBoundaryLayerShearMs({ ...base, levels: [], boundaryLayerTopM: 1500 }),
    ).toBeNull();
  });

  it("clamps a BL top above the column to the highest level's wind", () => {
    expect(surfaceToBoundaryLayerShearMs({ ...base, boundaryLayerTopM: 9000 })).toBeCloseTo(20, 10);
  });

  it("shears the surface against itself below model elevation", () => {
    expect(surfaceToBoundaryLayerShearMs({ ...base, boundaryLayerTopM: 900 })).toBeCloseTo(0, 10);
  });

  it("subtracts a non-calm surface wind vectorially", () => {
    // Surface 5 m/s from 270 vs 10 m/s from 270 aloft at BL top = 2000 m.
    expect(
      surfaceToBoundaryLayerShearMs({
        ...base,
        surfaceWind: { windSpeedMs: 5, windDirectionDeg: 270 },
        boundaryLayerTopM: 2000,
      }),
    ).toBeCloseTo(5, 10);
  });
});

describe("buoyancyShearRatio", () => {
  it("divides W* by the boundary-layer shear", () => {
    expect(buoyancyShearRatio(2, 4)).toBeCloseTo(0.5, 10);
    expect(buoyancyShearRatio(1.63, 0.5)).toBeCloseTo(3.26, 10);
  });

  it("is unbounded when thermals rise through zero shear", () => {
    expect(buoyancyShearRatio(1.63, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("is undefined with neither thermals nor shear", () => {
    expect(buoyancyShearRatio(0, 0)).toBeNull();
  });

  it("is zero when there are no thermals but some shear", () => {
    expect(buoyancyShearRatio(0, 3)).toBe(0);
  });
});

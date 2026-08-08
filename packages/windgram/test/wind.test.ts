import { describe, expect, it } from "vitest";
import { componentsToWind, normalizeDegrees, windToComponents } from "../src/derive/wind.js";

describe("windToComponents", () => {
  it("sends a north wind (from 0) blowing south", () => {
    const { uMs, vMs } = windToComponents(5, 0);
    expect(uMs).toBeCloseTo(0, 10);
    expect(vMs).toBeCloseTo(-5, 10);
  });

  it("sends a west wind (from 270) blowing east", () => {
    const { uMs, vMs } = windToComponents(5, 270);
    expect(uMs).toBeCloseTo(5, 10);
    expect(vMs).toBeCloseTo(0, 10);
  });
});

describe("componentsToWind", () => {
  it("round-trips speed and direction", () => {
    for (const [speed, direction] of [
      [7, 123],
      [1.47, 246],
      [12, 0],
      [3, 359],
    ] as const) {
      const { uMs, vMs } = windToComponents(speed, direction);
      const wind = componentsToWind(uMs, vMs);
      expect(wind.speedMs).toBeCloseTo(speed, 10);
      expect(wind.directionDeg).toBeCloseTo(direction, 10);
    }
  });

  it("reports calm air as speed 0, direction 0", () => {
    expect(componentsToWind(0, 0)).toEqual({ speedMs: 0, directionDeg: 0 });
  });
});

describe("normalizeDegrees", () => {
  it("wraps into [0, 360)", () => {
    expect(normalizeDegrees(-90)).toBe(270);
    expect(normalizeDegrees(720)).toBe(0);
    expect(normalizeDegrees(359.5)).toBe(359.5);
  });
});

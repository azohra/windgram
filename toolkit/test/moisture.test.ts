import { describe, expect, it } from "vitest";
import { dewPointC, dewPointDepressionC, relativeHumidityPercent } from "../src/derive/moisture.js";

describe("relativeHumidityPercent", () => {
  it("matches the published Magnus value for 20C / dew point 10C", () => {
    expect(relativeHumidityPercent(20, 10)).toBeCloseTo(52.54, 1);
  });

  it("is 100 when saturated", () => {
    expect(relativeHumidityPercent(15, 15)).toBeCloseTo(100, 10);
  });

  it("clamps supersaturated data noise to 100", () => {
    expect(relativeHumidityPercent(15, 15.3)).toBe(100);
  });

  it("falls as the dew point drops", () => {
    expect(relativeHumidityPercent(20, 0)).toBeLessThan(relativeHumidityPercent(20, 10));
  });
});

describe("dewPointC", () => {
  it("round-trips with relativeHumidityPercent", () => {
    for (const [temperature, dewPoint] of [
      [30, 5],
      [20, 10],
      [0, -12],
      [-15, -20],
    ] as const) {
      const rh = relativeHumidityPercent(temperature, dewPoint);
      expect(dewPointC(temperature, rh)).toBeCloseTo(dewPoint, 6);
    }
  });

  it("returns the temperature at 100% humidity", () => {
    expect(dewPointC(22.5, 100)).toBeCloseTo(22.5, 10);
  });

  it("clamps RH above 100 to the temperature", () => {
    expect(dewPointC(22.5, 130)).toBeCloseTo(22.5, 10);
  });

  it("has no dew point at zero or negative humidity", () => {
    expect(dewPointC(20, 0)).toBeNaN();
    expect(dewPointC(20, -5)).toBeNaN();
  });
});

describe("dewPointDepressionC", () => {
  it("is temperature minus dew point", () => {
    expect(dewPointDepressionC(28.28, 4.72)).toBeCloseTo(23.56, 10);
    expect(dewPointDepressionC(5, 5)).toBe(0);
  });
});

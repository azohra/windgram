import { describe, expect, it } from "vitest";
import { sampledFieldPaths } from "../src/scene/index.js";

/* The iso-band engine, pinned on synthetic fields where the exact answer
   is computable by hand: a linear ramp's class boundary must land on the
   true crossing, not on a sampling-grid line. */

const frame = { floorM: 0, topM: 100, plotLeft: 0, plotTop: 0, plotBottom: 100, plotWidth: 100 };
const ramp = [
  { altitudeM: 0, value: 0 },
  { altitudeM: 100, value: 10 },
];

function ys(path: string): number[] {
  return [...path.matchAll(/[ML][-\d.]+ ([-\d.]+)/g)].map((match) => Number(match[1]));
}

describe("sampledFieldPaths iso-bands", () => {
  it("places the class boundary at the exact threshold crossing", () => {
    // Value 10 at the top, 0 at the floor; threshold 5 crosses at y = 50
    // exactly — regardless of the 1.5 px row grid.
    const paths = sampledFieldPaths({
      ...frame,
      banding: { breakpoints: [5], classNames: ["low", "high"] },
      nodesByHour: [ramp, ramp],
    });
    expect(Math.max(...ys(paths["high"]))).toBe(50);
    expect(paths["high"]).toBe("M0 0L100 0L100 50L0 50L0 0Z");
  });

  it("pairs the bottom band with the domain outline for even-odd fill", () => {
    const paths = sampledFieldPaths({
      ...frame,
      banding: { breakpoints: [5], classNames: ["low", "high"] },
      nodesByHour: [ramp, ramp],
    });
    // Two rings: the full domain plus the upper region — even-odd leaves
    // exactly the lower half painted.
    expect(paths["low"].match(/M/g)).toHaveLength(2);
    expect(paths["low"]).toContain(paths["high"]);
  });

  it("leaves null regions out of the domain — nodes starting above the floor", () => {
    const lifted = [
      { altitudeM: 50, value: 0 },
      { altitudeM: 100, value: 10 },
    ];
    const paths = sampledFieldPaths({
      ...frame,
      banding: { breakpoints: [], classNames: ["all"] },
      nodesByHour: [lifted, lifted],
    });
    // The domain's lower edge sits near y = 50 (altitude 50); the border
    // between valid and null has no value to interpolate toward, so it is
    // grid-resolution — within one row of the true edge.
    expect(Math.max(...ys(paths["all"]))).toBeLessThanOrEqual(51.6);
    expect(Math.max(...ys(paths["all"]))).toBeGreaterThanOrEqual(48.4);
  });

  it("rejects a banding whose classNames do not cover every interval", () => {
    expect(() =>
      sampledFieldPaths({
        ...frame,
        banding: { breakpoints: [5], classNames: ["only-one"] },
        nodesByHour: [ramp],
      }),
    ).toThrow(/classNames/);
  });
});

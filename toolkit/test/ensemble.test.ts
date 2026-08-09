import { describe, expect, it } from "vitest";
import { p50 } from "../src/derive/ensemble.js";
import { stabilityClass } from "../src/derive/stability.js";
import { ensembleValue } from "./fixtures.js";

describe("p50", () => {
  it("passes plain numbers through", () => {
    expect(p50(1.47)).toBe(1.47);
    expect(p50(0)).toBe(0);
  });

  it("selects the median from an ensemble value", () => {
    expect(p50(ensembleValue({ p50: 3556.4, ceiledMembers: 2 }))).toBe(3556.4);
  });

  it("passes null through for nullable positions", () => {
    expect(p50(null)).toBeNull();
  });

  it("has no median for full dropout — zero members produced no value to select", () => {
    expect(p50({ members: 0, p10: null, p25: null, p50: null, p75: null, p90: null })).toBeNull();
  });

  it("feeds deterministic derivations from ensemble state", () => {
    expect(stabilityClass(p50(ensembleValue({ p50: -2.7 }))!)).toBe("unstable");
  });
});

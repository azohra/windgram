import { describe, expect, it } from "vitest";
import { stabilityClass, WINDGRAM_STABILITY_CLASSES } from "../src/derive/stability.js";

describe("WINDGRAM_STABILITY_CLASSES", () => {
  it("keeps the eight stability classes in ascending boundary order", () => {
    expect(WINDGRAM_STABILITY_CLASSES.map((entry) => entry.className)).toEqual([
      "very-unstable",
      "unstable",
      "conditional-strong",
      "conditional",
      "near-neutral",
      "stable",
      "inverted",
      "strong-inversion",
    ]);
    expect(WINDGRAM_STABILITY_CLASSES.map((entry) => entry.maxLapse)).toEqual([
      -3,
      -2.5,
      -2,
      -1.5,
      -1.2,
      0,
      0.5,
      Number.POSITIVE_INFINITY,
    ]);
  });
});

describe("stabilityClass", () => {
  it("includes each class's upper boundary (lapse <= maxLapse)", () => {
    expect(stabilityClass(-3)).toBe("very-unstable");
    expect(stabilityClass(-2.5)).toBe("unstable");
    expect(stabilityClass(-2)).toBe("conditional-strong");
    expect(stabilityClass(-1.5)).toBe("conditional");
    expect(stabilityClass(-1.2)).toBe("near-neutral");
    expect(stabilityClass(0)).toBe("stable");
    expect(stabilityClass(0.5)).toBe("inverted");
  });

  it("classifies interior values", () => {
    expect(stabilityClass(-100)).toBe("very-unstable");
    expect(stabilityClass(-2.99)).toBe("unstable");
    expect(stabilityClass(-1.19)).toBe("stable");
    expect(stabilityClass(0.2)).toBe("inverted");
    expect(stabilityClass(0.51)).toBe("strong-inversion");
    expect(stabilityClass(100)).toBe("strong-inversion");
  });
});

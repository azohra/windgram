import { describe, expect, it } from "vitest";

import type { SmokeDocument, WindgramProfile } from "../src/contract/index.js";
import {
  cosSolarZenith,
  isSmokeAwareProfile,
  SMOKE_TRANSMITTANCE_K_MIDDAY,
  smokeAdjustedThermalVelocityMs,
  smokeAotFromColumn,
  smokeHoursByValidAt,
  smokeTransmittance,
} from "../src/derive/smoke.js";

describe("smokeAotFromColumn", () => {
  it("converts a plume column through the cited extinction efficiency", () => {
    // 200 mg/m² = 0.2 g/m² × 4.7 m²/g — the plan-of-record cross-check case.
    expect(smokeAotFromColumn(200)).toBeCloseTo(0.94, 10);
  });

  it("treats a clean or noisy-negative column as no smoke", () => {
    expect(smokeAotFromColumn(0)).toBe(0);
    expect(smokeAotFromColumn(-0.1)).toBe(0);
  });
});

describe("smokeTransmittance", () => {
  it("is 1 for clear air", () => {
    expect(smokeTransmittance(0)).toBe(1);
  });

  it("applies the midday effective constant without a zenith", () => {
    expect(smokeTransmittance(1)).toBeCloseTo(Math.exp(-SMOKE_TRANSMITTANCE_K_MIDDAY), 10);
  });

  it("lengthens the slant path with the zenith-aware constant", () => {
    // cos 0.5 doubles the vertical path: f = exp(−0.13·τ/0.5).
    expect(smokeTransmittance(1, 0.5)).toBeCloseTo(Math.exp(-0.26), 10);
    // Low sun beats midday attenuation; high sun nearly matches vertical.
    expect(smokeTransmittance(1, 0.5)).toBeLessThan(smokeTransmittance(1, 0.95));
  });

  it("caps the path near the horizon and is 1 with the sun down", () => {
    expect(smokeTransmittance(1, 0.01)).toBeCloseTo(Math.exp(-0.13 / 0.15), 10);
    expect(smokeTransmittance(1, 0)).toBe(1);
    expect(smokeTransmittance(1, -0.4)).toBe(1);
  });

  it("matches the observed severe-smoke range: gentle, not exp(−τ)", () => {
    // The whole-chain cross-check: 100 µg/m³ mixed through 2 km ≈ 200 mg/m²
    // → τ ≈ 0.94 → ~14 % irradiance loss (Donaldson/Chubarova/McKendry
    // moderate-smoke observations), nowhere near exp(−0.94) ≈ 0.39.
    const f = smokeTransmittance(smokeAotFromColumn(200));
    expect(f).toBeGreaterThan(0.85);
    expect(f).toBeLessThan(0.87);
  });
});

describe("smokeAdjustedThermalVelocityMs", () => {
  it("derates by the cube root of the transmittance", () => {
    expect(smokeAdjustedThermalVelocityMs(2, 0.729)).toBeCloseTo(1.8, 10);
  });

  it("keeps no-thermals days at zero and clamps a wild factor", () => {
    expect(smokeAdjustedThermalVelocityMs(0, 0.5)).toBe(0);
    expect(smokeAdjustedThermalVelocityMs(-1, 0.5)).toBe(0);
    expect(smokeAdjustedThermalVelocityMs(2, 1.7)).toBe(2);
    expect(smokeAdjustedThermalVelocityMs(2, -0.2)).toBe(0);
  });

  it("is a gentle correction even in severe smoke — the honest headline", () => {
    // τ = 2 (severe BC episode): f ≈ 0.73, w* keeps ~90 % of its strength.
    const adjusted = smokeAdjustedThermalVelocityMs(2, smokeTransmittance(2));
    expect(adjusted / 2).toBeGreaterThan(0.89);
    expect(adjusted / 2).toBeLessThan(0.91);
  });
});

describe("isSmokeAwareProfile", () => {
  const base = { semantics: { gust: "instant" } } as WindgramProfile;

  it("recognizes the radiativelyCoupled declaration and nothing else", () => {
    expect(
      isSmokeAwareProfile({ semantics: { smoke: "radiativelyCoupled" } } as WindgramProfile),
    ).toBe(true);
    expect(isSmokeAwareProfile({ semantics: { smoke: "passive" } } as WindgramProfile)).toBe(
      false,
    );
    expect(isSmokeAwareProfile(base)).toBe(false);
    expect(isSmokeAwareProfile({} as WindgramProfile)).toBe(false);
  });
});

describe("smokeHoursByValidAt", () => {
  it("keys the smoke series for a validAt join", () => {
    const smoke = {
      hours: [
        { validAt: "2026-08-10T01:00:00Z", pm25Ugm3: 37.5 },
        { validAt: "2026-08-10T02:00:00Z", pm25Ugm3: 40.1 },
      ],
    } as SmokeDocument;
    const byValidAt = smokeHoursByValidAt(smoke);
    expect(byValidAt.get("2026-08-10T02:00:00Z")?.pm25Ugm3).toBe(40.1);
    expect(byValidAt.has("2026-08-10T03:00:00Z")).toBe(false);
  });
});

describe("cosSolarZenith", () => {
  it("puts the summer-solstice midday sun high over southwest BC", () => {
    // Solar noon in Vancouver (123.1°W) is ~20:12Z; zenith ≈ 49.25° − 23.44°.
    const cos = cosSolarZenith("2026-06-21T20:12:00Z", 49.25, -123.1);
    expect(cos).toBeGreaterThan(0.88);
    expect(cos).toBeLessThan(0.92);
  });

  it("is negative at night", () => {
    expect(cosSolarZenith("2026-06-21T08:12:00Z", 49.25, -123.1)).toBeLessThan(0);
  });
});

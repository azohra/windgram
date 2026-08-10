import { describe, expect, it } from "vitest";

import type { SmokeDocument } from "../src/contract/index.js";
import { cursorReading } from "../src/scene/hit-test.js";
import { buildKeySpec } from "../src/scene/key.js";
import { buildScene } from "../src/scene/scene.js";
import { tinySceneProfile } from "./scene-fixtures.js";

const OPTIONS = { columnWidthPx: 20, timeZone: "America/Vancouver" };

function smokeDocumentFor(validAts: string[]): SmokeDocument {
  return {
    schemaVersion: 1,
    model: "raqdps",
    run: { referenceTime: "2026-08-09T12:00:00Z", generatedAt: "2026-08-09T14:00:00Z" },
    site: { id: "dundee", name: "Dundee", latitude: 49.1, longitude: -122.2 },
    hours: validAts.map((validAt) => ({
      validAt,
      pm25Ugm3: 40,
      smokePlumeSurfaceUgm3: 37.5,
      smokePlumeColumnMgm2: 200,
    })),
  };
}

describe("the smoke strip", () => {
  it("draws nothing and reports no source without smoke data", () => {
    const scene = buildScene(tinySceneProfile(), OPTIONS);
    expect(scene.strips.find((strip) => strip.key === "smoke")).toBeUndefined();
    expect(scene.smokeSource).toBeNull();
  });

  it("draws the profile's own smoke block with same-run provenance", () => {
    const profile = tinySceneProfile();
    profile.hours[0].smoke = { surfaceUgm3: 184.6, columnMgm2: 228.2, aot: 1.018 };
    const scene = buildScene(profile, OPTIONS);

    const strip = scene.strips.find((entry) => entry.key === "smoke");
    expect(strip?.values[0]).toBe(184.6);
    expect(strip?.unit).toBe("µg/m³");
    // AOT 1.018 hazes the hour's cell at 1.018/3 of full tint.
    expect(strip?.cells?.[0]?.opacity).toBeCloseTo(0.34, 2);
    expect(scene.smokeSource).toEqual({
      model: profile.model,
      referenceTime: profile.run.referenceTime,
    });
  });

  it("joins a smoke document by validAt when the profile is smoke-blind", () => {
    const profile = tinySceneProfile();
    const smoke = smokeDocumentFor(profile.hours.map((hour) => hour.validAt));
    const scene = buildScene(profile, { ...OPTIONS, smoke });

    const strip = scene.strips.find((entry) => entry.key === "smoke");
    expect(strip?.values.every((value) => value === 37.5)).toBe(true);
    // AOT derives from the 200 mg/m² column: 0.94, so cells tint at 0.94/3.
    expect(strip?.cells?.[0]?.opacity).toBeCloseTo(0.31, 2);
    // The label's provenance is the smoke model's run, not the profile's.
    expect(scene.smokeSource).toEqual({
      model: "raqdps",
      referenceTime: "2026-08-09T12:00:00Z",
    });
  });

  it("never blends two models under one strip", () => {
    const profile = tinySceneProfile();
    profile.hours[0].smoke = { surfaceUgm3: 184.6, columnMgm2: 228.2, aot: 1.018 };
    const smoke = smokeDocumentFor(profile.hours.map((hour) => hour.validAt));
    const scene = buildScene(profile, { ...OPTIONS, smoke });

    const strip = scene.strips.find((entry) => entry.key === "smoke");
    // The profile publishes smoke, so the document never fills its gaps:
    // hours without a profile block stay holes rather than switch models.
    expect(strip?.values[0]).toBe(184.6);
    expect(strip?.values.slice(1).every((value) => value === null)).toBe(true);
    expect(scene.smokeSource?.model).toBe(profile.model);
  });

  it("derates w* coherently in the adjusted view and declares it", () => {
    const profile = tinySceneProfile();
    const smoke = smokeDocumentFor(profile.hours.map((hour) => hour.validAt));
    const base = buildScene(profile, { ...OPTIONS, smoke });
    const adjusted = buildScene(profile, { ...OPTIONS, smoke, smokeAdjusted: true });

    const baseW = base.strips.find((strip) => strip.key === "thermalStrength")?.values[0];
    const adjustedW = adjusted.strips.find((strip) => strip.key === "thermalStrength")
      ?.values[0];
    // τ from 200 mg/m² is 0.94; whatever the hour's sun angle, the derate
    // is real but gentle — never below the extreme-slant floor ∛exp(−0.13·0.94/0.15).
    expect(adjustedW).toBeLessThan(baseW as number);
    expect(adjustedW).toBeGreaterThan((baseW as number) * 0.75);
    expect(adjusted.smokeAdjustment).toEqual({
      smokeModel: "raqdps",
      smokeRun: "2026-08-09T12:00:00Z",
    });
    expect(base.smokeAdjustment).toBeNull();
  });

  it("no-ops the adjustment on a smoke-aware profile", () => {
    const profile = tinySceneProfile();
    profile.semantics = { smoke: "radiativelyCoupled" };
    profile.hours[0].smoke = { surfaceUgm3: 184.6, columnMgm2: 228.2, aot: 1.018 };
    const scene = buildScene(profile, { ...OPTIONS, smokeAdjusted: true });

    // The strip still draws (the data is real); the derate must not: this
    // model's published w* already includes its own smoke attenuation.
    expect(scene.strips.find((strip) => strip.key === "smoke")).toBeDefined();
    expect(scene.smokeAdjustment).toBeNull();
    expect(
      scene.strips.find((strip) => strip.key === "thermalStrength")?.values[0],
    ).toBe(profile.hours[0].derived.thermalVelocityMs);
  });

  it("declares no adjustment when the sun is down through the smoky hours", () => {
    // Same smoke, same request — but at this longitude the profile's hours
    // are local night, so the zenith-aware transmittance is 1 everywhere
    // and the correction changes nothing. The label must not pretend it did.
    const profile = tinySceneProfile();
    profile.site.longitude = 60;
    const smoke = smokeDocumentFor(profile.hours.map((hour) => hour.validAt));
    const base = buildScene(profile, { ...OPTIONS, smoke });
    const adjusted = buildScene(profile, { ...OPTIONS, smoke, smokeAdjusted: true });

    expect(adjusted.smokeAdjustment).toBeNull();
    expect(JSON.stringify(adjusted.strips)).toBe(JSON.stringify(base.strips));
    expect(JSON.stringify(adjusted.series)).toBe(JSON.stringify(base.series));
  });

  it("declares no adjustment when there is nothing to derate", () => {
    // Sun up, smoke thick — but every hour's w* is zero and no envelope
    // rides it, so × ∛f leaves the scene untouched.
    const profile = tinySceneProfile();
    for (const hour of profile.hours) hour.derived.thermalVelocityMs = 0;
    const smoke = smokeDocumentFor(profile.hours.map((hour) => hour.validAt));
    const adjusted = buildScene(profile, { ...OPTIONS, smoke, smokeAdjusted: true });

    expect(adjusted.smokeAdjustment).toBeNull();
  });

  it("reports the drawn smoke in cursor readings, so tooltips match pixels", () => {
    const profile = tinySceneProfile();
    profile.hours[0].smoke = { surfaceUgm3: 184.6, columnMgm2: 228.2, aot: 1.018 };
    const scene = buildScene(profile, OPTIONS);
    const { plotLeft, plotTop, plotHeight, columnWidth } = scene.scales;

    const smoky = cursorReading(scene, plotLeft + columnWidth / 2, plotTop + plotHeight / 2);
    expect(smoky?.smokeSurfaceUgm3).toBe(184.6);
    expect(smoky?.smokeAot).toBe(1.018);
    const clear = cursorReading(
      scene,
      plotLeft + columnWidth * 1.5,
      plotTop + plotHeight / 2,
    );
    expect(clear?.smokeSurfaceUgm3).toBeNull();
    expect(clear?.smokeAot).toBeNull();
  });

  it("keys the haze chip and labels the adjusted view", () => {
    const profile = tinySceneProfile();
    const smoke = smokeDocumentFor(profile.hours.map((hour) => hour.validAt));
    const base = buildKeySpec(buildScene(profile, { ...OPTIONS, smoke }));
    expect(base.smokeHaze?.label).toContain("optical depth");
    expect(base.smokeAdjusted).toBeNull();

    const adjusted = buildKeySpec(
      buildScene(profile, { ...OPTIONS, smoke, smokeAdjusted: true }),
    );
    // The key's note IS the must-label rule satisfied: model + run, visible.
    expect(adjusted.smokeAdjusted?.label).toContain("raqdps");
    expect(adjusted.smokeAdjusted?.label).toContain("2026-08-09T12:00:00Z");

    const clean = buildKeySpec(buildScene(profile, OPTIONS));
    expect(clean.smokeHaze).toBeNull();
  });

  it("stays out of the graph when the overlay is off", () => {
    const profile = tinySceneProfile();
    profile.hours[0].smoke = { surfaceUgm3: 184.6, columnMgm2: 228.2, aot: 1.018 };
    const scene = buildScene(profile, { ...OPTIONS, overlays: { smoke: false } });

    expect(scene.strips.find((entry) => entry.key === "smoke")).toBeUndefined();
    expect(scene.smokeSource).toBeNull();
  });
});

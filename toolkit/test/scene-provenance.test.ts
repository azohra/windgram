import { describe, expect, it } from "vitest";

import type { SmokeDocument } from "../src/contract/index.js";
import { buildScene } from "../src/scene/scene.js";
import { renderSvg } from "../src/svg/index.js";
import { tinySceneProfile } from "./scene-fixtures.js";

const OPTIONS = { columnWidthPx: 20, timeZone: "America/Vancouver" };

function smokeDocumentFor(validAts: string[]): SmokeDocument {
  return {
    schemaVersion: 1,
    model: "raqdps",
    run: { referenceTime: "2026-08-09T12:00:00Z", generatedAt: "2026-08-09T14:00:00Z" },
    site: { id: "synthetic-ridge", name: "Synthetic Ridge", latitude: 49, longitude: -123 },
    hours: validAts.map((validAt) => ({
      validAt,
      pm25Ugm3: 40,
      smokePlumeSurfaceUgm3: 37.5,
      smokePlumeColumnMgm2: 200,
    })),
  };
}

describe("strip provenance zones", () => {
  it("keeps a model-only stack undivided", () => {
    const scene = buildScene(tinySceneProfile(), OPTIONS);
    expect(scene.stripDivider).toBeNull();
    expect(scene.strips.every((strip) => strip.provenance === "model")).toBe(true);
  });

  it("moves joined smoke below the divider with its source inline", () => {
    const profile = tinySceneProfile();
    const smoke = smokeDocumentFor(profile.hours.map((hour) => hour.validAt));
    const scene = buildScene(profile, { ...OPTIONS, smoke });

    const strip = scene.strips.find((entry) => entry.key === "smoke");
    expect(strip?.provenance).toBe("crossModel");
    expect(strip?.sourceLabel).toBe("raqdps · 2026-08-09 12Z run");
    expect(scene.stripDivider?.label).toContain("not in its physics");
    // Foreign strips render strictly below every model strip.
    const modelTops = scene.strips
      .filter((entry) => entry.provenance === "model")
      .map((entry) => entry.top);
    expect(Math.min(strip!.top, Infinity)).toBeGreaterThan(Math.max(...modelTops));
    expect(strip!.top).toBeGreaterThan(scene.stripDivider!.y);

    const svg = renderSvg(scene, { idPrefix: "prov-joined" });
    expect(svg).toContain("raqdps · 2026-08-09 12Z run");
    expect(svg).toContain("beside this model — not in its physics");
  });

  it("keeps the model's own passive smoke above the line, but says so", () => {
    const profile = tinySceneProfile();
    profile.semantics = { smoke: "passive" };
    profile.hours[0].smoke = { surfaceUgm3: 100, columnMgm2: 200, aot: 0.9 };
    const scene = buildScene(profile, OPTIONS);

    const strip = scene.strips.find((entry) => entry.key === "smoke");
    expect(strip?.provenance).toBe("model");
    expect(strip?.sourceLabel).toBe("this model's forecast · not in its physics");
    expect(scene.stripDivider).toBeNull();
  });

  it("says nothing extra for radiatively coupled smoke — it is ordinary model data", () => {
    const profile = tinySceneProfile();
    profile.semantics = { smoke: "radiativelyCoupled" };
    profile.hours[0].smoke = { surfaceUgm3: 100, columnMgm2: 200, aot: 0.9 };
    const scene = buildScene(profile, OPTIONS);

    const strip = scene.strips.find((entry) => entry.key === "smoke");
    expect(strip?.provenance).toBe("model");
    expect(strip?.sourceLabel).toBeUndefined();
    expect(scene.stripDivider).toBeNull();
  });

  it("puts measurements in the foreign zone labeled as measured", () => {
    const profile = tinySceneProfile();
    const observations = {
      schemaVersion: 1 as const,
      model: "goes18-dsr",
      observed: {
        firstObservedAt: profile.hours[0].validAt,
        lastObservedAt: "2026-08-09T22:10:21Z",
        generatedAt: "2026-08-10T06:00:00Z",
      },
      site: { id: "synthetic-ridge", name: "Synthetic Ridge", latitude: 49, longitude: -123 },
      observations: profile.hours.map((hour) => ({
        observedAt: hour.validAt,
        downwardShortwaveWm2: 500,
      })),
    };
    const scene = buildScene(profile, { ...OPTIONS, observations });

    const strip = scene.strips.find((entry) => entry.key === "observedIrradiance");
    expect(strip?.provenance).toBe("measurement");
    expect(strip?.sourceLabel).toBe("goes18-dsr · measured to 2026-08-09 22:10Z");
    expect(scene.stripDivider).not.toBeNull();
  });
});

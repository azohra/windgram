import { describe, expect, it } from "vitest";

import type { ObservationDocument } from "../src/contract/index.js";
import {
  clearSkyGhiWm2,
  nearestObservation,
  observedTransmittance,
} from "../src/derive/irradiance.js";
import { cursorReading } from "../src/scene/hit-test.js";
import { buildKeySpec } from "../src/scene/key.js";
import { buildScene } from "../src/scene/scene.js";
import { tinySceneProfile } from "./scene-fixtures.js";

const OPTIONS = { columnWidthPx: 20, timeZone: "America/Vancouver" };

function observationsFor(
  validAts: string[],
  wm2: number,
  offsetMinutes = 10,
): ObservationDocument {
  const observations = validAts.map((validAt) => ({
    observedAt: new Date(Date.parse(validAt) + offsetMinutes * 60_000)
      .toISOString()
      .replace(".000Z", "Z"),
    downwardShortwaveWm2: wm2,
  }));
  return {
    schemaVersion: 1,
    model: "goes18-dsr",
    observed: {
      firstObservedAt: observations[0].observedAt,
      lastObservedAt: observations[observations.length - 1].observedAt,
      generatedAt: "2026-08-10T06:00:00Z",
    },
    site: { id: "synthetic-ridge", name: "Synthetic Ridge", latitude: 49, longitude: -123 },
    observations,
  };
}

describe("clear-sky irradiance and observed transmittance", () => {
  it("evaluates Haurwitz at the overhead sun and at sunset", () => {
    // cosθ = 1: 1098·e^(−0.059) ≈ 1035 W/m².
    expect(clearSkyGhiWm2(1)).toBeCloseTo(1035.1, 0);
    expect(clearSkyGhiWm2(0)).toBe(0);
    expect(clearSkyGhiWm2(-0.3)).toBe(0);
  });

  it("reads a smoky sky as a transmittance deficit", () => {
    // The first live GOES day: dundee measured 624.7 W/m² under the
    // plume where a clear sky at that sun would deliver ~700 — the
    // ratio is the observed transmittance the smoke claim predicts.
    const cosZenith = 0.7;
    const transmittance = observedTransmittance(624.7, cosZenith);
    expect(transmittance).toBeGreaterThan(0.8);
    expect(transmittance).toBeLessThan(1);
  });

  it("refuses the ratio near the horizon and caps a suspicious one", () => {
    expect(observedTransmittance(100, 0.1)).toBeNull();
    expect(observedTransmittance(-5, 0.7)).toBeNull();
    expect(observedTransmittance(9_999, 0.7)).toBe(1.5);
  });

  it("joins by nearest instant within the tolerance", () => {
    const document = observationsFor(
      ["2026-08-09T21:00:00Z", "2026-08-09T22:00:00Z"],
      600,
      10,
    );
    const hit = nearestObservation(document, "2026-08-09T22:00:00Z");
    expect(hit?.observation.observedAt).toBe("2026-08-09T22:10:00Z");
    expect(hit?.offsetMinutes).toBeCloseTo(10);
    expect(nearestObservation(document, "2026-08-10T04:00:00Z")).toBeNull();
    expect(nearestObservation(document, "2026-08-09T22:00:00Z", 5)).toBeNull();
  });
});

describe("the measured Sun strip", () => {
  it("draws nothing and reports no source without observations", () => {
    const scene = buildScene(tinySceneProfile(), OPTIONS);
    expect(scene.strips.find((strip) => strip.key === "observedIrradiance")).toBeUndefined();
    expect(scene.observationSource).toBeNull();
  });

  it("draws measurements with dimming shadows and names the source", () => {
    const profile = tinySceneProfile();
    const observations = observationsFor(
      profile.hours.map((hour) => hour.validAt),
      500,
    );
    const scene = buildScene(profile, { ...OPTIONS, observations });

    const strip = scene.strips.find((entry) => entry.key === "observedIrradiance");
    expect(strip?.values.every((value) => value === 500)).toBe(true);
    expect(strip?.unit).toBe("W/m²");
    // tinySceneProfile's hours sit in daylight, so the sub-clear-sky
    // measurement casts a dimming shadow whose opacity is the deficit.
    const shadow = (strip?.cells ?? []).find((cell) => cell !== null);
    expect(shadow?.className).toBe("wg-dim-cell");
    expect(shadow?.opacity).toBeGreaterThan(0);
    expect(scene.observationSource).toEqual({
      model: "goes18-dsr",
      lastObservedAt: observations.observed.lastObservedAt,
    });

    const key = buildKeySpec(scene);
    expect(key.measuredDimming?.label).toContain("dimming");

    const { plotLeft, plotTop, plotHeight, columnWidth } = scene.scales;
    const reading = cursorReading(scene, plotLeft + columnWidth / 2, plotTop + plotHeight / 2);
    expect(reading?.observedIrradianceWm2).toBe(500);
    expect(reading?.observedTransmittance).toBeGreaterThan(0);
  });

  it("stays out of the graph when the overlay is off", () => {
    const profile = tinySceneProfile();
    const observations = observationsFor(
      profile.hours.map((hour) => hour.validAt),
      500,
    );
    const scene = buildScene(profile, {
      ...OPTIONS,
      observations,
      overlays: { observedIrradiance: false },
    });
    expect(scene.strips.find((entry) => entry.key === "observedIrradiance")).toBeUndefined();
    expect(scene.observationSource).toBeNull();
  });
});

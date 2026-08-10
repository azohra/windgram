import { describe, expect, it } from "vitest";

import type { ObservationDocument } from "../src/contract/index.js";
import { cursorReading } from "../src/scene/hit-test.js";
import { buildKeySpec } from "../src/scene/key.js";
import { buildScene } from "../src/scene/scene.js";
import { renderSvg } from "../src/svg/index.js";
import { tinySceneProfile } from "./scene-fixtures.js";

const OPTIONS = { columnWidthPx: 20, timeZone: "America/Vancouver" };

/* One AOT entry per validAt, offset off the forecast hour like the real
   product (GOES scan starts, never on the hour). Pass fewer aots than
   validAts to leave the remaining hours unmeasured. */
function aotObservationsFor(
  validAts: string[],
  aots: number[],
  offsetMinutes = 10,
  lastObservedAt?: string,
): ObservationDocument {
  const observations = aots.map((aot, index) => ({
    observedAt: new Date(Date.parse(validAts[index]) + offsetMinutes * 60_000)
      .toISOString()
      .replace(".000Z", "Z"),
    aot,
  }));
  return {
    schemaVersion: 1,
    model: "goes18-aod",
    observed: {
      firstObservedAt: observations[0].observedAt,
      lastObservedAt: lastObservedAt ?? observations[observations.length - 1].observedAt,
      generatedAt: "2026-08-10T06:00:00Z",
    },
    site: { id: "synthetic-ridge", name: "Synthetic Ridge", latitude: 49, longitude: -123 },
    observations,
  };
}

describe("the measured AOT strip", () => {
  it("draws nothing and reports no source without a document", () => {
    const scene = buildScene(tinySceneProfile(), OPTIONS);
    expect(scene.strips.find((strip) => strip.key === "observedAot")).toBeUndefined();
    expect(scene.aotObservationSource).toBeNull();
  });

  it("joins measured AOT onto the rendered hours by nearest instant", () => {
    const profile = tinySceneProfile();
    const aotObservations = aotObservationsFor(
      profile.hours.map((hour) => hour.validAt),
      [0.6, 2.4],
    );
    const scene = buildScene(profile, { ...OPTIONS, aotObservations });

    const strip = scene.strips.find((entry) => entry.key === "observedAot");
    expect(strip?.values).toEqual([0.6, 2.4]);
    expect(strip?.label).toBe("AOT");
    expect(strip?.unit).toBe("550 nm");
    expect(scene.aotObservationSource).toEqual({
      model: "goes18-aod",
      lastObservedAt: aotObservations.observed.lastObservedAt,
    });
  });

  it("draws nothing when every observation sits beyond the half-hour tolerance", () => {
    const profile = tinySceneProfile();
    // A single retrieval three hours after the window: 180 and 120 minutes
    // from the two rendered hours, both beyond the half-hour tolerance.
    const aotObservations = aotObservationsFor(
      profile.hours.map((hour) => hour.validAt),
      [0.6],
      180,
    );
    const scene = buildScene(profile, { ...OPTIONS, aotObservations });
    expect(scene.strips.find((entry) => entry.key === "observedAot")).toBeUndefined();
    expect(scene.aotObservationSource).toBeNull();
  });

  it("takes nothing from DSR-shaped entries supplied as aotObservations", () => {
    const profile = tinySceneProfile();
    const dsrDocument: ObservationDocument = {
      schemaVersion: 1,
      model: "goes18-dsr",
      observed: {
        firstObservedAt: profile.hours[0].validAt,
        lastObservedAt: profile.hours[1].validAt,
        generatedAt: "2026-08-10T06:00:00Z",
      },
      site: { id: "synthetic-ridge", name: "Synthetic Ridge", latitude: 49, longitude: -123 },
      observations: profile.hours.map((hour) => ({
        observedAt: hour.validAt,
        downwardShortwaveWm2: 500,
      })),
    };
    const scene = buildScene(profile, { ...OPTIONS, aotObservations: dsrDocument });
    expect(scene.strips.find((entry) => entry.key === "observedAot")).toBeUndefined();
    expect(scene.aotObservationSource).toBeNull();
  });

  it("tints the haze on the forecast smoke strip's own scale, with the value line over it", () => {
    const profile = tinySceneProfile();
    // The profile's own smoke at AOT 0.9 beside a measurement of 0.9: the
    // two strips must tint identically, or "compare at a glance" lies.
    profile.semantics = { smoke: "radiativelyCoupled" };
    profile.hours[0].smoke = { surfaceUgm3: 100, columnMgm2: 200, aot: 0.9 };
    const aotObservations = aotObservationsFor(
      profile.hours.map((hour) => hour.validAt),
      [0.9, 2.4],
    );
    const scene = buildScene(profile, { ...OPTIONS, aotObservations });

    const strip = scene.strips.find((entry) => entry.key === "observedAot");
    const cells = strip?.cells ?? [];
    expect(cells[0]?.className).toBe("wg-smoke-cell");
    expect(cells[0]?.opacity).toBeCloseTo(0.3); // 0.9 / 3, the smoke scale
    expect(cells[1]?.opacity).toBeCloseTo(0.8); // 2.4 / 3 — thicker is darker
    const smokeStrip = scene.strips.find((entry) => entry.key === "smoke");
    expect(smokeStrip?.cells?.[0]?.opacity).toBe(cells[0]?.opacity);

    // One haze explanation covers both strips: the chip keys the shared cell class.
    const key = buildKeySpec(scene);
    expect(key.smokeHaze?.id).toBe("wg-smoke-cell");

    const svg = renderSvg(scene, { idPrefix: "aot-tint" });
    expect(svg).toContain(">AOT<"); // the strip names its value line
    expect(svg).toContain('class="wg-strip-observedAot"');
  });

  it("keys the haze chip from the measured strip alone", () => {
    const profile = tinySceneProfile();
    const aotObservations = aotObservationsFor(
      profile.hours.map((hour) => hour.validAt),
      [0.6, 2.4],
    );
    const scene = buildScene(profile, { ...OPTIONS, aotObservations });
    expect(scene.strips.find((entry) => entry.key === "smoke")).toBeUndefined();
    expect(buildKeySpec(scene).smokeHaze?.label).toContain("optical depth");
  });

  it("reports the drawn hour's value at the cursor, null where none drew", () => {
    const profile = tinySceneProfile();
    // One measurement near the first hour only: the second hour's nearest
    // instant is 50 minutes away, beyond the tolerance.
    const aotObservations = aotObservationsFor(
      profile.hours.map((hour) => hour.validAt),
      [0.6],
    );
    const scene = buildScene(profile, { ...OPTIONS, aotObservations });

    const strip = scene.strips.find((entry) => entry.key === "observedAot");
    expect(strip?.values).toEqual([0.6, null]);
    expect(strip?.cells?.[1]).toBeNull();

    const { plotLeft, plotTop, plotHeight, columnWidth } = scene.scales;
    const midY = plotTop + plotHeight / 2;
    expect(cursorReading(scene, plotLeft + columnWidth / 2, midY)?.observedAot).toBe(0.6);
    expect(cursorReading(scene, plotLeft + 1.5 * columnWidth, midY)?.observedAot).toBeNull();
  });

  it("stays out of the graph when the overlay is off", () => {
    const profile = tinySceneProfile();
    const aotObservations = aotObservationsFor(
      profile.hours.map((hour) => hour.validAt),
      [0.6, 2.4],
    );
    const scene = buildScene(profile, {
      ...OPTIONS,
      aotObservations,
      overlays: { observedAot: false },
    });
    expect(scene.strips.find((entry) => entry.key === "observedAot")).toBeUndefined();
    expect(scene.aotObservationSource).toBeNull();
    const { plotLeft, plotTop, plotHeight, columnWidth } = scene.scales;
    const reading = cursorReading(scene, plotLeft + columnWidth / 2, plotTop + plotHeight / 2);
    expect(reading?.observedAot).toBeNull();
    // Stylesheet omitted: the default sheet always carries the strip's
    // rules, so element markup is what proves nothing was drawn.
    const svg = renderSvg(scene, { idPrefix: "aot-off", stylesheet: null });
    expect(svg).not.toContain("observedAot");
  });
});

describe("the measured AOT strip's provenance", () => {
  it("renders below the divider labeled as measured, with the exact source line", () => {
    const profile = tinySceneProfile();
    const aotObservations = aotObservationsFor(
      profile.hours.map((hour) => hour.validAt),
      [0.6, 2.4],
      10,
      "2026-08-09T22:10:21Z",
    );
    const scene = buildScene(profile, { ...OPTIONS, aotObservations });

    const strip = scene.strips.find((entry) => entry.key === "observedAot");
    expect(strip?.provenance).toBe("measurement");
    expect(strip?.sourceLabel).toBe("goes18-aod · measured to 2026-08-09 22:10Z");
    expect(scene.stripDivider).not.toBeNull();
    expect(strip!.top).toBeGreaterThan(scene.stripDivider!.y);

    const svg = renderSvg(scene, { idPrefix: "aot-prov" });
    expect(svg).toContain("goes18-aod · measured to 2026-08-09 22:10Z");
    expect(svg).toContain("beside this model — not in its physics");
  });

  it("orders stably beside the Sun strip: both measured, Sun first, both below the divider", () => {
    const profile = tinySceneProfile();
    const observations: ObservationDocument = {
      schemaVersion: 1,
      model: "goes18-dsr",
      observed: {
        firstObservedAt: profile.hours[0].validAt,
        lastObservedAt: profile.hours[1].validAt,
        generatedAt: "2026-08-10T06:00:00Z",
      },
      site: { id: "synthetic-ridge", name: "Synthetic Ridge", latitude: 49, longitude: -123 },
      observations: profile.hours.map((hour) => ({
        observedAt: hour.validAt,
        downwardShortwaveWm2: 500,
      })),
    };
    const aotObservations = aotObservationsFor(
      profile.hours.map((hour) => hour.validAt),
      [0.6, 2.4],
    );
    const scene = buildScene(profile, { ...OPTIONS, observations, aotObservations });

    const sun = scene.strips.find((entry) => entry.key === "observedIrradiance");
    const aot = scene.strips.find((entry) => entry.key === "observedAot");
    expect(sun?.provenance).toBe("measurement");
    expect(aot?.provenance).toBe("measurement");
    expect(sun!.top).toBeGreaterThan(scene.stripDivider!.y);
    expect(aot!.top).toBeGreaterThan(sun!.top);
    // Each measured strip labels its own document.
    expect(scene.observationSource?.model).toBe("goes18-dsr");
    expect(scene.aotObservationSource?.model).toBe("goes18-aod");
  });
});

import { describe, expect, it } from "vitest";
import {
  altitudeForY,
  buildScene,
  clientPointToScene,
  cursorReading,
  drawnBarbsForHour,
  hourIndexForValidAt,
  hourIndexForX,
  nearestDrawnBarb,
  xForHour,
  xForTime,
  yForAltitude,
} from "../src/scene/index.js";
import { deterministicSceneProfile, ensembleSceneProfile, tinySceneProfile } from "./scene-fixtures.js";

const TZ = { timeZone: "America/Vancouver" };

describe("scale helpers", () => {
  const scene = buildScene(tinySceneProfile(), TZ);

  it("round-trips altitude and y", () => {
    for (const altitude of [1000, 1800, 2600]) {
      expect(altitudeForY(scene, yForAltitude(scene, altitude))).toBeCloseTo(altitude, 6);
    }
    expect(yForAltitude(scene, scene.scales.floorM)).toBeCloseTo(
      scene.scales.plotTop + scene.scales.plotHeight,
      6,
    );
  });

  it("maps x positions onto hour columns, null outside", () => {
    expect(hourIndexForX(scene, xForHour(scene, 0))).toBe(0);
    expect(hourIndexForX(scene, xForHour(scene, 1))).toBe(1);
    expect(hourIndexForX(scene, scene.scales.plotLeft - 1)).toBeNull();
    expect(hourIndexForX(scene, scene.scales.plotLeft + scene.scales.plotWidth + 1)).toBeNull();
  });

  it("clamps to the edge columns when asked — strips and margins still select", () => {
    const { plotLeft, plotWidth, hourCount } = scene.scales;
    expect(hourIndexForX(scene, plotLeft - 30, { clamp: true })).toBe(0);
    expect(hourIndexForX(scene, plotLeft + plotWidth + 30, { clamp: true })).toBe(hourCount - 1);
    // Inside the plot the clamp changes nothing.
    expect(hourIndexForX(scene, xForHour(scene, 1), { clamp: true })).toBe(1);
  });
});

describe("clientPointToScene", () => {
  const scene = buildScene(tinySceneProfile(), TZ);

  it("maps client pixels through the mount rect, x and y scaled independently", () => {
    // Mounted at half width and double height: the two factors must differ.
    const rect = { left: 40, top: 10, width: scene.width / 2, height: scene.height * 2 };
    expect(clientPointToScene(scene, rect, 40, 10)).toEqual({ x: 0, y: 0 });
    const centre = clientPointToScene(
      scene,
      rect,
      40 + rect.width / 2,
      10 + rect.height / 2,
    );
    expect(centre!.x).toBeCloseTo(scene.width / 2, 6);
    expect(centre!.y).toBeCloseTo(scene.height / 2, 6);
  });

  it("is null for a zero-area rect — the hidden-tab measurement", () => {
    expect(clientPointToScene(scene, { left: 0, top: 0, width: 0, height: 300 }, 5, 5)).toBeNull();
    expect(clientPointToScene(scene, { left: 0, top: 0, width: 300, height: 0 }, 5, 5)).toBeNull();
  });
});

describe("hourIndexForValidAt", () => {
  const scene = buildScene(tinySceneProfile(), TZ);

  it("answers with the rendered index for the same instant, in any spelling", () => {
    expect(hourIndexForValidAt(scene, scene.hourValidAts[1])).toBe(1);
    // Timestamps, not strings: the +00:00 spelling names the same instant.
    const offsetSpelling = scene.hourValidAts[0].replace("Z", "+00:00");
    expect(hourIndexForValidAt(scene, offsetSpelling)).toBe(0);
    expect(hourIndexForValidAt(scene, new Date(scene.hourValidAts[0]))).toBe(0);
  });

  it("is null for instants the window does not render, and for garbage", () => {
    expect(hourIndexForValidAt(scene, "2026-08-10T18:00:00Z")).toBeNull();
    expect(hourIndexForValidAt(scene, "not a date")).toBeNull();
  });

  it("carries a pin across a rebuild that renumbers the window", () => {
    const profile = deterministicSceneProfile();
    const whole = buildScene(profile, TZ);
    const pinnedValidAt = whole.hourValidAts[3];
    // Rebuild windowed to hours 2..: the pinned hour is now index 1.
    const windowed = buildScene(profile, { ...TZ, hourIndices: [2, 3, 4] });
    expect(hourIndexForValidAt(windowed, pinnedValidAt)).toBe(1);
    // A window that dropped the hour says so instead of guessing.
    const without = buildScene(profile, { ...TZ, hourIndices: [5, 6] });
    expect(hourIndexForValidAt(without, pinnedValidAt)).toBeNull();
  });
});

describe("xForTime", () => {
  const scene = buildScene(tinySceneProfile(), TZ);
  const { plotLeft, plotWidth } = scene.scales;

  it("agrees with xForHour at the hour centres and interpolates between them", () => {
    expect(xForTime(scene, scene.hourValidAts[0])).toBeCloseTo(xForHour(scene, 0), 6);
    const halfPast = new Date(Date.parse(scene.hourValidAts[0]) + 1_800_000);
    expect(xForTime(scene, halfPast)).toBeCloseTo(
      (xForHour(scene, 0) + xForHour(scene, 1)) / 2,
      6,
    );
  });

  it("extends the end segments across the edge half-columns, to the frame and no further", () => {
    // Half an hour before the first hour is the column's left edge exactly.
    const halfBefore = new Date(Date.parse(scene.hourValidAts[0]) - 1_800_000);
    expect(xForTime(scene, halfBefore)).toBeCloseTo(plotLeft, 6);
    // A full hour before is past the frame: null, or the edge when clamped.
    const hourBefore = new Date(Date.parse(scene.hourValidAts[0]) - 3_600_000);
    expect(xForTime(scene, hourBefore)).toBeNull();
    expect(xForTime(scene, hourBefore, { clamp: true })).toBeCloseTo(plotLeft, 6);
    const dayAfter = new Date(Date.parse(scene.hourValidAts[1]) + 86_400_000);
    expect(xForTime(scene, dayAfter, { clamp: true })).toBeCloseTo(plotLeft + plotWidth, 6);
  });

  it("is null for garbage", () => {
    expect(xForTime(scene, "not a date")).toBeNull();
  });
});

describe("drawn-barb queries", () => {
  const scene = buildScene(tinySceneProfile(), TZ);

  it("returns one hour's barbs as rendered: surface first, levels bottom-up", () => {
    const barbs = drawnBarbsForHour(scene, 0);
    expect(barbs.length).toBe(3); // surface + both levels
    expect(barbs[0].surface).toBe(true);
    expect(barbs[0].altitudeM).toBe(scene.scales.floorM);
    expect(barbs[0].y).toBe(scene.scales.surfaceWindY);
    expect(barbs.slice(1).map((barb) => barb.altitudeM)).toEqual([2000, 3000]);
    expect(barbs.every((barb) => barb.hourIndex === 0)).toBe(true);
  });

  it("is empty for an hour the barb stride skipped, and with the wind overlay off", () => {
    const strided = buildScene(tinySceneProfile(), { ...TZ, barbStride: 2 });
    expect(drawnBarbsForHour(strided, 0).length).toBeGreaterThan(0);
    expect(drawnBarbsForHour(strided, 1)).toEqual([]);
    const windless = buildScene(tinySceneProfile(), { ...TZ, overlays: { wind: false } });
    expect(drawnBarbsForHour(windless, 0)).toEqual([]);
  });

  it("snaps a y to the nearest drawn barb — the surface barb included, at its DRAWN y", () => {
    // Just above the plot floor: nearest is the surface barb, whose drawn
    // position is surfaceWindY, not y(floorM) — the offset the first
    // consumer restated as its own +28 m constant.
    const nearFloor = nearestDrawnBarb(scene, 0, scene.scales.plotTop + scene.scales.plotHeight - 2);
    expect(nearFloor!.surface).toBe(true);
    expect(nearFloor!.altitudeM).toBe(scene.scales.floorM);
    const atLevel = nearestDrawnBarb(scene, 0, yForAltitude(scene, 2050));
    expect(atLevel!.surface).toBe(false);
    expect(atLevel!.altitudeM).toBe(2000);
  });

  it("is null when the hour drew nothing", () => {
    const strided = buildScene(tinySceneProfile(), { ...TZ, barbStride: 2 });
    expect(nearestDrawnBarb(strided, 1, scene.scales.plotTop + 10)).toBeNull();
  });
});

describe("cursorReading", () => {
  const scene = buildScene(tinySceneProfile(), TZ);

  it("is null outside the plot", () => {
    expect(cursorReading(scene, 0, 0)).toBeNull();
    expect(cursorReading(scene, xForHour(scene, 0), scene.scales.plotTop - 5)).toBeNull();
  });

  it("interpolates temperature and moisture vertically within the column", () => {
    // Hour 0: surface 20degC at 1000 m, level 10degC at 2000 m -> 15 at 1500 m.
    const reading = cursorReading(scene, xForHour(scene, 0), yForAltitude(scene, 1500));
    expect(reading).not.toBeNull();
    expect(reading!.hourIndex).toBe(0);
    expect(reading!.validAt).toBe("2026-08-09T18:00:00Z");
    expect(reading!.altitudeM).toBeCloseTo(1500, 6);
    expect(reading!.temperatureC).toBeCloseTo(15, 6);
    // Dew point: surface 10 at 1000 m, level 0 at 2000 m -> 5; depression 10.
    expect(reading!.dewPointC).toBeCloseTo(5, 6);
    expect(reading!.dewPointDepressionC).toBeCloseTo(10, 6);
    expect(reading!.relativeHumidityPercent).toBeGreaterThan(0);
    expect(reading!.relativeHumidityPercent).toBeLessThan(100);
  });

  it("reports wind by interpolating components, not speeds", () => {
    // Calm surface at 1000 m, 10 m/s from 270 at 2000 m -> 5 m/s from 270 midway.
    const reading = cursorReading(scene, xForHour(scene, 0), yForAltitude(scene, 1500));
    expect(reading!.windSpeedMs).toBeCloseTo(5, 6);
    expect(reading!.windDirectionDeg).toBeCloseTo(270, 6);
  });

  it("classifies stability from the interpolated lapse", () => {
    /* Node semantics: the surface node carries the surface->L1 lapse
       (-3.048) and the L1 node carries the L1->L2 lapse (-2.4384), so
       halfway up the first layer the field reads their blend, -2.7432. */
    const reading = cursorReading(scene, xForHour(scene, 0), yForAltitude(scene, 1500));
    expect(reading!.lapseCPer1000Ft).toBeCloseTo(-2.7432, 4);
    expect(reading!.stabilityClassName).toBe("unstable");
  });

  it("reads the second hour's column at its x", () => {
    const reading = cursorReading(scene, xForHour(scene, 1), yForAltitude(scene, 1500));
    expect(reading!.hourIndex).toBe(1);
    expect(reading!.temperatureC).toBeCloseTo(16, 6); // surface 22 -> level 10
  });

  it("nulls quantities above the column's data", () => {
    const scene2 = buildScene(tinySceneProfile(), TZ);
    // topM > 3000 (domain padding), so just under the plot top is above data.
    const reading = cursorReading(scene2, xForHour(scene2, 0), scene2.scales.plotTop + 1);
    expect(reading).not.toBeNull();
    expect(reading!.temperatureC).toBeNull();
    expect(reading!.windSpeedMs).toBeNull();
    expect(reading!.stabilityClassName).toBeNull();
  });

  it("degrades to surface-only readings for a model without levels", () => {
    const scene2 = buildScene(ensembleSceneProfile(), TZ);
    const reading = cursorReading(scene2, xForHour(scene2, 2), yForAltitude(scene2, 2500));
    expect(reading).not.toBeNull();
    expect(reading!.temperatureC).toBeNull(); // single surface node spans nothing
    expect(reading!.thermalIndexC).toBeNull();
  });

  it("has no omega where the model publishes none", () => {
    const reading = cursorReading(scene, xForHour(scene, 0), yForAltitude(scene, 1500));
    expect(reading!.verticalVelocityPaS).toBeNull();
  });
});

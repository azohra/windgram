import { describe, expect, it } from "vitest";
import {
  altitudeForY,
  buildScene,
  cursorReading,
  hourIndexForX,
  xForHour,
  yForAltitude,
} from "../src/scene/index.js";
import { ensembleSceneProfile, tinySceneProfile } from "./scene-fixtures.js";

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

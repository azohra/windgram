import { describe, expect, it } from "vitest";
import { parseWindgramProfile } from "../src/contract/index.js";
import { buildScene, DEFAULT_OVERLAYS } from "../src/scene/index.js";
import {
  deterministicSceneProfile,
  ensembleSceneProfile,
  tinySceneProfile,
} from "./scene-fixtures.js";

const TZ = { timeZone: "America/Vancouver" };

describe("fixtures", () => {
  it("are valid profiles by the package's own contract", () => {
    expect(parseWindgramProfile(deterministicSceneProfile())).not.toBeNull();
    expect(parseWindgramProfile(ensembleSceneProfile())).not.toBeNull();
    expect(parseWindgramProfile(tinySceneProfile())).not.toBeNull();
  });
});

describe("scales and layout", () => {
  const scene = buildScene(deterministicSceneProfile(), TZ);

  it("places the plot below the default four strips", () => {
    // 20 + 4 * (25 + 5) + 8 — the site's PROFILE_TOP, now derived not magic.
    expect(scene.scales.plotTop).toBe(148);
    expect(scene.scales.plotHeight).toBe(340);
  });

  it("sizes one 44px column per hour inside 60px margins", () => {
    expect(scene.scales.plotLeft).toBe(60);
    expect(scene.scales.plotWidth).toBe(44 * 8);
    expect(scene.width).toBe(60 + 44 * 8 + 60);
  });

  it("floors the domain at model elevation and pads the top by 4%", () => {
    expect(scene.scales.floorM).toBe(1072.5);
    // Highest drawable: cloud base 2600 + 7*150 = 3650 (levels top out lower).
    expect(scene.scales.topM).toBeCloseTo(3650 * 1.04, 6);
  });

  it("shrinks the plot top when a default strip's overlay is off", () => {
    const noClouds = buildScene(deterministicSceneProfile(), { ...TZ, overlays: { clouds: false } });
    expect(noClouds.scales.plotTop).toBe(148 - 30);
    expect(noClouds.strips.map((strip) => strip.key)).toEqual([
      "pressure",
      "precipitation",
      "thermalStrength",
    ]);
  });

  it("renders a subset via hourIndices", () => {
    const subset = buildScene(deterministicSceneProfile(), { ...TZ, hourIndices: [2, 3, 4] });
    expect(subset.scales.hourCount).toBe(3);
    expect(subset.hourValidAts).toEqual([
      "2026-08-09T16:00:00Z",
      "2026-08-09T17:00:00Z",
      "2026-08-09T18:00:00Z",
    ]);
  });

  it("renders the same subset via hour objects — no index bookkeeping", () => {
    const profile = deterministicSceneProfile();
    const byIndices = buildScene(profile, { ...TZ, hourIndices: [2, 3, 4] });
    const byHours = buildScene(profile, { ...TZ, hours: profile.hours.slice(2, 5) });
    expect(byHours).toEqual(byIndices);
    // Matching is by validAt, so pre-windowed copies select too, and hours
    // the profile does not contain are ignored rather than crashing.
    const byCopies = buildScene(profile, {
      ...TZ,
      hours: [
        { validAt: "2026-08-09T16:00:00Z" },
        { validAt: "2026-08-09T17:00:00Z" },
        { validAt: "2026-08-09T18:00:00Z" },
        { validAt: "2031-01-01T00:00:00Z" }, // not in the profile
      ],
    });
    expect(byCopies).toEqual(byIndices);
  });

  it("renders one local day via { timeZone, dateKey }", () => {
    const profile = deterministicSceneProfile(); // 8 hours, all Aug 9 PDT
    const day = buildScene(profile, {
      ...TZ,
      hours: { timeZone: "America/Vancouver", dateKey: "2026-08-09" },
    });
    expect(day).toEqual(buildScene(profile, TZ));
    // The same instants belong to a different local day elsewhere: all
    // eight hours (14:00Z-21:00Z) are already Aug 10 in Sydney (UTC+10),
    // so the Aug 9 Sydney day selects none of them and Aug 10 all.
    const sydney = buildScene(profile, {
      ...TZ,
      hours: { timeZone: "Australia/Sydney", dateKey: "2026-08-10" },
    });
    expect(sydney.hourValidAts).toEqual(profile.hours.map((hour) => hour.validAt));
  });

  it("gives hourIndices precedence over hours when both are passed", () => {
    const profile = deterministicSceneProfile();
    const both = buildScene(profile, {
      ...TZ,
      hourIndices: [0, 1],
      hours: profile.hours.slice(4),
    });
    expect(both.hourValidAts).toEqual(profile.hours.slice(0, 2).map((hour) => hour.validAt));
  });
});

describe("axes", () => {
  const scene = buildScene(deterministicSceneProfile(), TZ);

  it("draws six altitude gridlines from floor to top", () => {
    expect(scene.axes.altitude).toHaveLength(6);
    expect(scene.axes.altitude[0].altitudeM).toBe(scene.scales.floorM);
    expect(scene.axes.altitude[0].y).toBeCloseTo(scene.scales.plotTop + 340, 6);
    expect(scene.axes.altitude[5].altitudeM).toBeCloseTo(scene.scales.topM, 6);
    expect(scene.axes.altitude[0].labelMetres).toBe("1073m");
    expect(scene.axes.altitude[0].labelFeet).toBe("3519ft");
  });

  it("labels hours in the requested timezone", () => {
    // 2026-08-09T14:00Z is 07:00 PDT.
    expect(scene.axes.hours[0].label).toBe("7");
    expect(scene.axes.hours[0].gridline).toBe(true);
    expect(scene.axes.hours[1].gridline).toBe(false);
    const sydney = buildScene(deterministicSceneProfile(), { timeZone: "Australia/Sydney" });
    expect(sydney.axes.hours[0].label).toBe("0"); // midnight AEST
  });

  it("builds pressure-altitude ticks from median level heights, 80 m apart", () => {
    const ticks = scene.axes.pressureAltitude;
    expect(ticks[0]).toMatchObject({ altitudeM: 1073, pressureHpa: null });
    expect(ticks.map((tick) => tick.pressureHpa)).toEqual([null, 925, 900, 875, 850, 800]);
    for (let index = 1; index < ticks.length; index += 1) {
      expect(ticks[index].altitudeM - ticks[index - 1].altitudeM).toBeGreaterThanOrEqual(80);
    }
  });
});

describe("strips", () => {
  it("shows today's four strips by default, in order", () => {
    const scene = buildScene(deterministicSceneProfile(), TZ);
    expect(scene.strips.map((strip) => strip.key)).toEqual([
      "pressure",
      "precipitation",
      "cloudCover",
      "thermalStrength",
    ]);
    for (const strip of scene.strips) {
      expect(strip.linePath).not.toBe("");
      expect(strip.areaPath).not.toBe("");
      expect(strip.bandPath).toBeNull(); // deterministic model: no envelope
    }
  });

  it("adds the B/S strip when the overlay is on, with gaps where BL or levels are missing", () => {
    const scene = buildScene(deterministicSceneProfile(), { ...TZ, overlays: { buoyancyShear: true } });
    const strip = scene.strips.find((entry) => entry.key === "buoyancyShear");
    expect(strip).toBeDefined();
    expect(strip!.values[0]).toBeNull(); // hour 0 has no boundary layer
    expect(strip!.values[4]).not.toBeNull();
    expect(strip!.areaPath).toBe(""); // gapped series: line only, no area fill
    expect(strip!.cells).toBeUndefined(); // sheared fixture: nothing unopposed
  });

  it("marks an unopposed-buoyancy hour with a cell — the best reading is not a gap", () => {
    // Zero shear: identical wind at the surface and every level, with a
    // boundary layer and positive W*, makes the ratio unbounded.
    const profile = deterministicSceneProfile();
    const hour = profile.hours[4];
    const wind = { windSpeedMs: 3, windDirectionDeg: 200 };
    Object.assign(hour.surface, wind);
    hour.levels = hour.levels.map((level) => ({ ...level, ...wind }));
    const scene = buildScene(profile, { ...TZ, overlays: { buoyancyShear: true } });
    const strip = scene.strips.find((entry) => entry.key === "buoyancyShear")!;
    expect(strip.values[4]).toBeNull(); // no point: infinity has no y
    expect(strip.cells![4]).toMatchObject({ className: "wg-bs-unopposed" });
    expect(strip.cells![0]).toBeNull(); // no-BL hour stays a plain gap
    expect(strip.cells![3]).toBeNull(); // sheared hours carry no cell
  });

  it("carries p25-p75 envelopes for ensemble strips", () => {
    const scene = buildScene(ensembleSceneProfile(), TZ);
    for (const strip of scene.strips) {
      expect(strip.bandPath, strip.key).not.toBeNull();
    }
  });
});

describe("fields", () => {
  it("classifies the default stability and cloud fields", () => {
    const scene = buildScene(deterministicSceneProfile(), TZ);
    const keys = scene.fields.map((field) => field.key);
    expect(keys).toEqual(["stability", "clouds"]);
    const stability = scene.fields[0];
    expect(stability.paths.length).toBeGreaterThan(0);
    for (const { className } of stability.paths) {
      expect(className).toMatch(/^wg-stab-/);
    }
    const clouds = scene.fields[1];
    expect(clouds.paths.map((entry) => entry.className)).toContain("wg-cloud-dense");
  });

  it("adds TI, shear, RH and omega fields when toggled on", () => {
    const scene = buildScene(deterministicSceneProfile(), {
      ...TZ,
      overlays: { thermalIndex: true, windShear: true, relativeHumidity: true, verticalVelocity: true },
    });
    const keys = scene.fields.map((field) => field.key);
    expect(keys).toContain("thermalIndex");
    expect(keys).toContain("windShear");
    expect(keys).toContain("relativeHumidity");
    expect(keys).toContain("verticalVelocity");
  });

  it("omits the omega field when the model publishes no verticalVelocityPaS", () => {
    const scene = buildScene(tinySceneProfile(), { ...TZ, overlays: { verticalVelocity: true } });
    expect(scene.fields.map((field) => field.key)).not.toContain("verticalVelocity");
  });

  it("handles a model without levels gracefully: no fields, no isotherms, surface-only barbs", () => {
    const scene = buildScene(ensembleSceneProfile(), TZ);
    expect(scene.fields).toEqual([]);
    expect(scene.series.filter((entry) => entry.key === "isotherm")).toEqual([]);
    expect(scene.barbs).toHaveLength(6); // one surface barb per hour
    expect(scene.axes.pressureAltitude.map((tick) => tick.pressureHpa)).toEqual([null]);
  });
});

describe("series", () => {
  it("draws the three derived series with the reference strokes", () => {
    const scene = buildScene(deterministicSceneProfile(), TZ);
    const byKey = Object.fromEntries(scene.series.map((entry) => [entry.key, entry]));
    expect(byKey["boundaryLayerTop"]).toMatchObject({ strokeWidth: 2, dash: "10 5" });
    expect(byKey["cloudBase"]).toMatchObject({ strokeWidth: 1.8, dash: "1 5" });
    expect(byKey["usableLiftTop"]).toMatchObject({ strokeWidth: 2.3, dash: null });
    expect(byKey["boundaryLayerTop"].bandPath).toBeNull();
  });

  it("applies 1-2-1 smoothing to cloud base and usable lift by default, and only to them", () => {
    const smoothed = buildScene(deterministicSceneProfile(), TZ);
    const raw = buildScene(deterministicSceneProfile(), { ...TZ, smooth: false });
    const pick = (scene: typeof smoothed, key: string) =>
      scene.series.find((entry) => entry.key === key)!.path;
    expect(pick(smoothed, "cloudBase")).toBe(pick(raw, "cloudBase")); // linear ramp: kernel is identity
    expect(pick(smoothed, "boundaryLayerTop")).toBe(pick(raw, "boundaryLayerTop"));
    // A ramp with a null start is NOT identity under the kernel at its elbow.
    expect(pick(smoothed, "usableLiftTop")).not.toBe(pick(raw, "usableLiftTop"));
  });

  it("renders a full-dropout position as a gap, never a fabricated point", () => {
    const profile = ensembleSceneProfile();
    const dropout = { members: 0, p10: null, p25: null, p50: null, p75: null, p90: null };
    profile.hours[3].derived.usableLiftTopM = dropout as never;
    const baseline = buildScene(ensembleSceneProfile(), { ...TZ, smooth: false });
    const scene = buildScene(profile, { ...TZ, smooth: false });
    const usable = (s: typeof scene) => s.series.find((entry) => entry.key === "usableLiftTop")!;
    expect(usable(scene).path).not.toBe(usable(baseline).path);
    expect(usable(scene).path).not.toContain("NaN");
    expect(usable(scene).bandPath).not.toContain("NaN");
    // The other hours keep their state: only the dropout hour is a gap.
    expect(scene.scales.hourCount).toBe(baseline.scales.hourCount);
  });

  it("exposes p25-p75 band geometry for ensemble series", () => {
    const scene = buildScene(ensembleSceneProfile(), TZ);
    const byKey = Object.fromEntries(scene.series.map((entry) => [entry.key, entry]));
    expect(byKey["cloudBase"].bandPath).not.toBeNull();
    expect(byKey["usableLiftTop"].bandPath).not.toBeNull();
    expect(byKey["boundaryLayerTop"].bandPath).not.toBeNull();
  });

  it("draws isotherms with the freezing level emphasized, plus labels", () => {
    const scene = buildScene(deterministicSceneProfile(), TZ);
    const isotherms = scene.series.filter((entry) => entry.key === "isotherm");
    expect(isotherms.length).toBeGreaterThan(0);
    expect(isotherms.some((entry) => entry.className.includes("wg-isotherm-freezing"))).toBe(true);
    expect(scene.labels.some((label) => label.text === "0°")).toBe(true);
  });

  it("draws isodrosotherms under the dewPoint overlay", () => {
    const scene = buildScene(deterministicSceneProfile(), { ...TZ, overlays: { dewPoint: true } });
    expect(scene.series.some((entry) => entry.key === "dewPointIsoline")).toBe(true);
    expect(scene.labels.some((label) => label.text.startsWith("Td "))).toBe(true);
  });
});

describe("barbs and markers", () => {
  it("places surface + level barbs per hour, in km/h", () => {
    const scene = buildScene(deterministicSceneProfile(), TZ);
    // 8 hours (stride 1), 1 surface + 4 levels each: the first level sits
    // within the min gap of the lifted surface row, so the walk drops it.
    expect(scene.barbs).toHaveLength(8 * 5);
    expect(scene.barbs[0].speedKmh).toBeCloseTo(1 * 3.6, 6);
    expect(scene.barbs[0].calm).toBe(false); // 3.6 km/h rounds to a half barb
  });

  it("omits barbs when the wind overlay is off", () => {
    const scene = buildScene(deterministicSceneProfile(), { ...TZ, overlays: { wind: false } });
    expect(scene.barbs).toEqual([]);
  });

  it("marks the max-W* hour with wing and cloud glyphs", () => {
    const scene = buildScene(deterministicSceneProfile(), TZ);
    expect(scene.selectedHourIndex).toBe(5); // w* peaks at 2.4
    expect(scene.markers.map((marker) => marker.kind).sort()).toEqual(["cloud", "wing"]);
  });

  it("skips the launch line when site altitude is unknown", () => {
    expect(buildScene(tinySceneProfile(), TZ).launch).toBeNull();
    const withLaunch = buildScene(deterministicSceneProfile(), TZ);
    expect(withLaunch.launch?.label).toBe("launch 1485 m");
  });
});

describe("defaults", () => {
  it("keeps the default overlay set equal to today's windgram", () => {
    expect(DEFAULT_OVERLAYS).toMatchObject({
      temperature: true,
      wind: true,
      clouds: true,
      thermalStrength: true,
      stability: true,
      thermalIndex: false,
      windShear: false,
      buoyancyShear: false,
      dewPoint: false,
      relativeHumidity: false,
      verticalVelocity: false,
    });
  });

  it("defaults every complete-control overlay on, so the default render is unchanged", () => {
    expect(DEFAULT_OVERLAYS).toMatchObject({
      pressure: true,
      precipitation: true,
      boundaryLayerTop: true,
      cloudBase: true,
      usableLiftTop: true,
      launch: true,
      selectedHour: true,
    });
  });
});

describe("complete overlay control", () => {
  it("removes the pressure and precipitation strips, shrinking the plot top", () => {
    const scene = buildScene(deterministicSceneProfile(), {
      ...TZ,
      overlays: { pressure: false, precipitation: false },
    });
    expect(scene.strips.map((strip) => strip.key)).toEqual(["cloudCover", "thermalStrength"]);
    expect(scene.scales.plotTop).toBe(148 - 2 * 30);
  });

  it("removes each derived-height line — and its selected-hour glyph — per toggle", () => {
    const base = buildScene(deterministicSceneProfile(), TZ);
    expect(base.series.map((entry) => entry.key)).toContain("boundaryLayerTop");

    const noBoundary = buildScene(deterministicSceneProfile(), {
      ...TZ,
      overlays: { boundaryLayerTop: false },
    });
    expect(noBoundary.series.some((entry) => entry.key === "boundaryLayerTop")).toBe(false);

    const noCloudBase = buildScene(deterministicSceneProfile(), {
      ...TZ,
      overlays: { cloudBase: false },
    });
    expect(noCloudBase.series.some((entry) => entry.key === "cloudBase")).toBe(false);
    expect(noCloudBase.markers.some((marker) => marker.kind === "cloud")).toBe(false);
    expect(noCloudBase.markers.some((marker) => marker.kind === "wing")).toBe(true);

    const noUsable = buildScene(deterministicSceneProfile(), {
      ...TZ,
      overlays: { usableLiftTop: false },
    });
    expect(noUsable.series.some((entry) => entry.key === "usableLiftTop")).toBe(false);
    expect(noUsable.markers.some((marker) => marker.kind === "wing")).toBe(false);
    expect(noUsable.markers.some((marker) => marker.kind === "cloud")).toBe(true);
  });

  it("drops a hidden height line from the altitude-domain scan", () => {
    // Cloud base is the deterministic profile's tallest series (3,650 m);
    // with it hidden the domain relaxes to usable lift's 3,450 m.
    const scene = buildScene(deterministicSceneProfile(), { ...TZ, overlays: { cloudBase: false } });
    expect(scene.scales.topM).toBeCloseTo(3450 * 1.04, 6);
  });

  it("removes the launch line under its toggle", () => {
    const scene = buildScene(deterministicSceneProfile(), { ...TZ, overlays: { launch: false } });
    expect(scene.launch).toBeNull();
  });

  it("suppresses the selected-hour highlight while keeping the index computed", () => {
    const scene = buildScene(deterministicSceneProfile(), { ...TZ, overlays: { selectedHour: false } });
    expect(scene.highlightSelectedHour).toBe(false);
    expect(scene.selectedHourIndex).toBe(5); // readouts still know the best hour
    expect(buildScene(deterministicSceneProfile(), TZ).highlightSelectedHour).toBe(true);
  });

  it("scales the profile panel via plotHeightPx without touching the strips", () => {
    const tall = buildScene(deterministicSceneProfile(), { ...TZ, plotHeightPx: 480 });
    const base = buildScene(deterministicSceneProfile(), TZ);
    expect(tall.scales.plotHeight).toBe(480);
    expect(tall.scales.plotTop).toBe(base.scales.plotTop);
    expect(tall.height).toBe(base.height + (480 - 340));
    // The altitude axis spans the taller panel: same domain, more pixels.
    expect(tall.axes.altitude[0].y - tall.axes.altitude[5].y).toBeCloseTo(480, 6);
  });
});

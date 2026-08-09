import { describe, expect, it } from "vitest";
import { parseWindgramProfile } from "../src/contract/index.js";
import { DEFAULT_CAPE_CLASSES, buildScene } from "../src/scene/index.js";
import { deterministicSceneProfile, scienceSceneProfile } from "./scene-fixtures.js";

const TZ = { timeZone: "America/Vancouver" };

describe("science fixture", () => {
  it("is a valid profile by the package's own contract", () => {
    expect(parseWindgramProfile(scienceSceneProfile())).not.toBeNull();
  });
});

describe("CAPE strip", () => {
  const scene = buildScene(scienceSceneProfile(), TZ);
  const strip = scene.strips.find((entry) => entry.key === "cape");

  it("joins the strip stack next to w*, with the line over classed cells", () => {
    expect(scene.strips.map((entry) => entry.key)).toEqual([
      "pressure",
      "precipitation",
      "cloudCover",
      "cloudLayers",
      "thermalStrength",
      "cape",
    ]);
    expect(strip!.linePath).not.toBe("");
    expect(strip!.cells).toHaveLength(6);
  });

  it("classifies every overdevelopment-risk band the fixture crosses", () => {
    // 120 calm | 450 watch | 950 risk | 1700 severe | 650 watch | 90 calm.
    expect(strip!.cells!.map((cell) => cell!.className.split(" ")[0])).toEqual([
      "wg-cape-calm",
      "wg-cape-watch",
      "wg-cape-risk",
      "wg-cape-severe",
      "wg-cape-watch",
      "wg-cape-calm",
    ]);
  });

  it("dims — never clears — hours capped by CIN <= -50 J/kg", () => {
    const capped = strip!.cells!.map((cell) => cell!.className.includes("wg-cape-capped"));
    expect(capped).toEqual([false, true, false, true, false, false]); // CIN -80 and -120
  });

  it("keeps the scale honest: the axis reaches at least the severe band", () => {
    expect(strip!.minimum).toBe(0);
    expect(strip!.maximum).toBeGreaterThanOrEqual(1700);
  });

  it("passing DEFAULT_CAPE_CLASSES explicitly changes nothing", () => {
    const explicit = buildScene(scienceSceneProfile(), {
      ...TZ,
      capeClasses: { ...DEFAULT_CAPE_CLASSES },
    });
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(scene));
  });

  it("reclassifies by options.capeClasses when a consumer overrides the doctrine", () => {
    const custom = buildScene(scienceSceneProfile(), {
      ...TZ,
      capeClasses: { watchJkg: 100, riskJkg: 500, severeJkg: 1000, cappedCinJkg: -100 },
    });
    const customStrip = custom.strips.find((entry) => entry.key === "cape")!;
    // 120 | 450 | 950 | 1700 | 650 | 90 against 100 / 500 / 1000.
    expect(customStrip.cells!.map((cell) => cell!.className.split(" ")[0])).toEqual([
      "wg-cape-watch",
      "wg-cape-watch",
      "wg-cape-risk",
      "wg-cape-severe",
      "wg-cape-risk",
      "wg-cape-calm",
    ]);
    // The -100 cap threshold releases CIN -80 and keeps CIN -120 dimmed.
    expect(customStrip.cells!.map((cell) => cell!.className.includes("wg-cape-capped"))).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
    ]);
  });
});

describe("gust marks", () => {
  it("places one G<km/h> readout per barb-stride hour above the surface row", () => {
    const scene = buildScene(scienceSceneProfile(), TZ);
    expect(scene.gusts).toHaveLength(6); // 6 hours -> stride 1
    expect(scene.gusts[0].label).toBe("G22"); // 6 m/s -> 21.6 km/h
    expect(scene.gusts[0].speedKmh).toBeCloseTo(21.6, 6);
    const surfaceY = scene.scales.plotTop + scene.scales.plotHeight;
    for (const gust of scene.gusts) expect(gust.y).toBeLessThan(surfaceY);
  });

  it("draws nothing when the overlay is off", () => {
    const scene = buildScene(scienceSceneProfile(), { ...TZ, overlays: { gusts: false } });
    expect(scene.gusts).toEqual([]);
  });
});

describe("model PBL series", () => {
  it("adds modelPblTop with its own class, dash, and thinner stroke", () => {
    const scene = buildScene(scienceSceneProfile(), TZ);
    const pbl = scene.series.find((entry) => entry.key === "modelPblTop");
    expect(pbl).toMatchObject({ className: "wg-series-pbl", strokeWidth: 1.6, dash: "3 3" });
    expect(pbl!.path).not.toBe("");
  });

  it("plots pblHeightM + modelElevationM — identical to the parcel line when the AGL depths agree", () => {
    // Force pblHeightM = boundaryLayerTopM - floor: if the AGL->MSL
    // conversion is right, the two series produce the same path.
    const profile = scienceSceneProfile();
    const floorM = profile.site.modelElevationM;
    for (const hour of profile.hours) {
      const top = hour.derived.boundaryLayerTopM;
      if (top === null) {
        delete hour.surface.pblHeightM;
      } else {
        hour.surface.pblHeightM = (top as number) - floorM;
      }
    }
    const scene = buildScene(profile, TZ);
    const byKey = Object.fromEntries(scene.series.map((entry) => [entry.key, entry]));
    expect(byKey["modelPblTop"].path).toBe(byKey["boundaryLayerTop"].path);
  });

  it("is omitted, not empty, when no hour publishes pblHeightM", () => {
    const scene = buildScene(deterministicSceneProfile(), TZ);
    expect(scene.series.some((entry) => entry.key === "modelPblTop")).toBe(false);
  });
});

describe("cloud-layer strip", () => {
  const scene = buildScene(scienceSceneProfile(), TZ);
  const strip = scene.strips.find((entry) => entry.key === "cloudLayers");

  it("stacks high, middle, low reading downward like the sky", () => {
    expect(strip!.rows!.map((row) => row.label)).toEqual(["H", "M", "L"]);
    const tops = strip!.rows!.map((row) => row.top);
    expect(tops[0]).toBeLessThan(tops[1]);
    expect(tops[1]).toBeLessThan(tops[2]);
    expect(strip!.rows![0].height).toBeCloseTo(strip!.height / 3, 6);
  });

  it("grades cell opacity by layer fraction", () => {
    const midRow = strip!.rows![1];
    expect(midRow.cells[4]!.opacity).toBeCloseTo(0.9, 6); // 90 % mid cloud
    expect(midRow.cells[0]!.opacity).toBeCloseTo(0.05, 6); // 5 %
    expect(midRow.cells[0]!.className).toBe("wg-cloud-cell");
  });

  it("draws no strip line — the rows are the data", () => {
    expect(strip!.linePath).toBe("");
    expect(strip!.values.every((value) => value === null)).toBe(true);
  });
});

describe("cloud-shading precedence", () => {
  it("shades from the model's cloud profile where levels carry it, inference elsewhere", () => {
    // Hours 0-2 have no cloudFractionPercent (inference), hours 3-5 do
    // (model cloud): both routes must be present as separate class layers
    // under the one "clouds" key.
    const scene = buildScene(scienceSceneProfile(), TZ);
    const cloudLayers = scene.fields.filter((field) => field.key === "clouds");
    expect(cloudLayers).toHaveLength(2);
    // The model-cloud hours peak at 90 % >= the 85 % dense threshold.
    const classNames = cloudLayers.flatMap((layer) => layer.paths.map((entry) => entry.className));
    expect(classNames).toContain("wg-cloud-dense");
  });

  it("keeps a single inference layer when no level carries model cloud", () => {
    const scene = buildScene(deterministicSceneProfile(), TZ);
    expect(scene.fields.filter((field) => field.key === "clouds")).toHaveLength(1);
  });
});

describe("graceful degradation", () => {
  it("adds nothing at all to a profile without the science fields", () => {
    // The overlays default ON — a pre-wave document must render
    // byte-identically to having them off.
    const on = buildScene(deterministicSceneProfile(), TZ);
    const off = buildScene(deterministicSceneProfile(), {
      ...TZ,
      overlays: { cape: false, gusts: false, pblHeight: false, cloudLayers: false },
    });
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
    expect(on.strips.some((strip) => strip.key === "cape")).toBe(false);
    expect(on.strips.some((strip) => strip.key === "cloudLayers")).toBe(false);
    expect(on.gusts).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { BARB_GLYPH_RADIUS, buildScene, windBarbPaths } from "../src/scene/index.js";
import { renderSvg } from "../src/svg/index.js";
import { deterministicSceneProfile, scienceSceneProfile } from "./scene-fixtures.js";

const TZ = { timeZone: "America/Vancouver" };

/* The presentation wave: hour-label conventions, geometry-aware barb
   density and scale, the surface-temperature row, marker trains,
   container-fit sizing, and display-label overrides. Each option's
   default must leave the scene identical to passing nothing — the
   goldens are the pixels; these tests are the contracts. */

describe("hourLabel", () => {
  it("defaults to 24h — identical to passing nothing, ':00' in the aria label", () => {
    const bare = buildScene(deterministicSceneProfile(), TZ);
    const explicit = buildScene(deterministicSceneProfile(), { ...TZ, hourLabel: "24h" });
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(bare));
    expect(bare.ariaLabel).toContain("7:00 to 14:00");
  });

  it("renders 12h ticks as 7a … 12p … 2p and threads the aria label", () => {
    const scene = buildScene(deterministicSceneProfile(), { ...TZ, hourLabel: "12h" });
    expect(scene.axes.hours.map((tick) => tick.label)).toEqual([
      "7a",
      "8a",
      "9a",
      "10a",
      "11a",
      "12p",
      "1p",
      "2p",
    ]);
    // No ":00" — that suffix is a 24-hour idiom.
    expect(scene.ariaLabel).toContain("7a to 2p");
    expect(scene.ariaLabel).not.toContain(":00");
  });

  it("labels midnight 12a and noon 12p", () => {
    // 14:00Z is midnight AEST (UTC+10); 02:00Z the same day is noon.
    const sydney = buildScene(deterministicSceneProfile(), {
      timeZone: "Australia/Sydney",
      hourLabel: "12h",
    });
    expect(sydney.axes.hours[0].label).toBe("12a");
  });

  it("hands a formatter function the validAt and timezone, verbatim into ticks and aria", () => {
    const scene = buildScene(deterministicSceneProfile(), {
      ...TZ,
      hourLabel: (validAt, timeZone) => `${new Date(validAt).getUTCHours()}Z/${timeZone}`,
    });
    expect(scene.axes.hours[0].label).toBe("14Z/America/Vancouver");
    expect(scene.ariaLabel).toContain("14Z/America/Vancouver to 21Z/America/Vancouver");
  });
});

describe("geometry-aware barbs", () => {
  it("auto stride is 1 wherever the column covers the glyph footprint", () => {
    // 44px default columns cover the 2 x radius x 0.85 footprint, so all
    // eight hours keep their barbs (the old heuristic would too, at 8 h).
    const scene = buildScene(deterministicSceneProfile(), TZ);
    const surfaceBarbCount = scene.barbs.filter((barb) => barb.y === Math.max(...scene.barbs.map((entry) => entry.y))).length;
    expect(surfaceBarbCount).toBe(8);
  });

  it("auto stride widens only when columns get too narrow for the glyph", () => {
    const narrow = buildScene(deterministicSceneProfile(), { ...TZ, columnWidthPx: 20 });
    // footprint = 2 * radius * 0.85 = 34px; ceil(34/20) = 2.
    const expectedStride = Math.ceil((2 * BARB_GLYPH_RADIUS * 0.85) / 20);
    expect(expectedStride).toBe(2);
    const barbHourXs = new Set(narrow.barbs.map((barb) => barb.x));
    expect(barbHourXs.size).toBe(4); // every 2nd of 8 hours
  });

  it("an explicit barbStride forces the hour stride, and gusts follow it", () => {
    const scene = buildScene(scienceSceneProfile(), { ...TZ, barbStride: 3 });
    const barbXs = [...new Set(scene.barbs.map((barb) => barb.x))].sort((a, b) => a - b);
    const gustXs = scene.gusts.map((gust) => gust.x).sort((a, b) => a - b);
    expect(barbXs).toEqual(gustXs); // 6 hours at stride 3: hours 0 and 3
    expect(gustXs).toHaveLength(2);
  });

  it("scale follows the pitch: 0.85 at 44px, 1.0 from 66px, pinnable", () => {
    const at = (columnWidthPx?: number, barbScale?: number) =>
      buildScene(deterministicSceneProfile(), { ...TZ, columnWidthPx, barbScale }).barbs[0].scale;
    expect(at()).toBe(0.85);
    expect(at(55)).toBeCloseTo(0.925, 6);
    expect(at(66)).toBe(1);
    expect(at(90)).toBe(1);
    expect(at(90, 0.85)).toBe(0.85); // pinned
  });

  it("thins a column by pixel gap — surface always drawn, the top always wins", () => {
    // A gap larger than the whole panel keeps exactly surface + top.
    const scene = buildScene(deterministicSceneProfile(), { ...TZ, barbMinGapPx: 1000 });
    const columnYs = scene.barbs.filter((barb) => barb.x === scene.barbs[0].x).map((barb) => barb.y);
    expect(columnYs).toHaveLength(2);
    const surfaceY = Math.max(...columnYs);
    const topY = Math.min(...columnYs);
    expect(surfaceY).toBeGreaterThan(topY);
  });

  it("default gap thins only what actually collides on the fixture column", () => {
    const scene = buildScene(deterministicSceneProfile(), TZ);
    // Surface + levels 2..5: the first level is inside the lifted surface
    // glyph's clearance and drops; everything above keeps its barb.
    expect(scene.barbs).toHaveLength(8 * 5);
  });
});

describe("surface barb row", () => {
  it("lifts the surface barbs half a glyph height clear of the plot floor", () => {
    const scene = buildScene(deterministicSceneProfile(), TZ);
    const plotBottom = scene.scales.plotTop + scene.scales.plotHeight;
    const surfaceBarbY = Math.max(...scene.barbs.map((barb) => barb.y));
    expect(surfaceBarbY).toBe(scene.scales.surfaceWindY);
    expect(surfaceBarbY).toBeLessThan(plotBottom);
    // Half the rendered glyph height: the glyph's base just reaches the floor.
    expect(plotBottom - surfaceBarbY).toBeCloseTo((25 / 2) * scene.barbs[0].scale, 6);
  });

  it("keeps the gust row clear of the lifted glyphs' rotated reach", () => {
    const scene = buildScene(scienceSceneProfile(), TZ);
    const reach = 20 * scene.barbs[0].scale;
    for (const gust of scene.gusts) {
      expect(gust.y).toBeLessThanOrEqual(scene.scales.surfaceWindY - reach);
    }
  });
});

describe("barb glyph geometry", () => {
  it("spaces feathers 4.8 apart on a shaft long enough for the densest sub-50 stack", () => {
    // 45 km/h: four full feathers plus a half, from the -20 shaft tip.
    const { shaft } = windBarbPaths(45);
    expect(shaft).toContain("M0 5 L0 -20");
    const featherYs = [...shaft.matchAll(/M0 (-?[\d.]+) L8/g)].map((match) => Number(match[1]));
    expect(featherYs).toEqual([-20, -15.2, -10.4, -5.6]);
    expect(shaft).toContain("M0 -0.8 L4.5"); // the half barb, still on the shaft
  });

  it("exports the glyph radius the auto stride sizes against", () => {
    expect(BARB_GLYPH_RADIUS).toBe(20);
  });
});

describe("surfaceTemperature row", () => {
  it("prints one rounded readout per hour under the hour labels", () => {
    const scene = buildScene(deterministicSceneProfile(), TZ);
    expect(scene.surfaceTemperatures).toHaveLength(8);
    expect(scene.surfaceTemperatures[0].label).toBe("8°");
    expect(scene.surfaceTemperatures[7].label).toBe("22°");
    const hourLabelY = scene.scales.plotTop + scene.scales.plotHeight + 18;
    for (const mark of scene.surfaceTemperatures) {
      expect(mark.y).toBeGreaterThan(hourLabelY);
      expect(mark.y).toBeLessThan(scene.height);
    }
  });

  it("rides its toggle: off removes the row and its reserved height", () => {
    const on = buildScene(deterministicSceneProfile(), TZ);
    const off = buildScene(deterministicSceneProfile(), {
      ...TZ,
      overlays: { surfaceTemperature: false },
    });
    expect(off.surfaceTemperatures).toEqual([]);
    expect(off.height).toBe(on.height - 14);
    expect(renderSvg(off, { stylesheet: null })).not.toContain("wg-surface-temp");
  });
});

describe("markerStride", () => {
  it("defaults to a single glyph per line at the selected hour", () => {
    const scene = buildScene(deterministicSceneProfile(), TZ);
    expect(scene.markers.map((marker) => marker.kind).sort()).toEqual(["cloud", "wing"]);
  });

  it("draws a train along the line that always includes the selected hour", () => {
    const scene = buildScene(deterministicSceneProfile(), {
      ...TZ,
      markerStride: { cloudBase: 2 },
    });
    const clouds = scene.markers.filter((marker) => marker.kind === "cloud");
    const wings = scene.markers.filter((marker) => marker.kind === "wing");
    expect(wings).toHaveLength(1); // untouched line keeps the single glyph
    expect(clouds).toHaveLength(4); // hours 1, 3, 5, 7 — congruent to selected (5) mod 2
    const selectedX = wings[0].x;
    expect(clouds.some((marker) => marker.x === selectedX)).toBe(true);
  });

  it("each train rides its own line's overlay toggle", () => {
    const scene = buildScene(deterministicSceneProfile(), {
      ...TZ,
      overlays: { cloudBase: false },
      markerStride: { cloudBase: 1 },
    });
    expect(scene.markers.some((marker) => marker.kind === "cloud")).toBe(false);
  });
});

describe("widthPx container fit", () => {
  it("derives the column width so scene.width equals the target", () => {
    const scene = buildScene(deterministicSceneProfile(), { ...TZ, widthPx: 900 });
    expect(scene.width).toBe(900);
    expect(scene.scales.columnWidth).toBeCloseTo((900 - 120) / 8, 9);
  });

  it("wins over columnWidthPx — it is the statement of intent", () => {
    const scene = buildScene(deterministicSceneProfile(), {
      ...TZ,
      widthPx: 900,
      columnWidthPx: 44,
    });
    expect(scene.width).toBe(900);
  });

  it("windowing happens first: the same target over fewer hours widens columns", () => {
    const scene = buildScene(deterministicSceneProfile(), {
      ...TZ,
      widthPx: 900,
      hourIndices: [2, 3, 4],
    });
    expect(scene.width).toBe(900);
    expect(scene.scales.columnWidth).toBe(260);
  });
});

describe("stripLabels", () => {
  it("overrides display voice while the key stays the identity", () => {
    const scene = buildScene(deterministicSceneProfile(), {
      ...TZ,
      stripLabels: { thermalStrength: "LIFT" },
    });
    const strip = scene.strips.find((entry) => entry.key === "thermalStrength")!;
    expect(strip.label).toBe("LIFT");
    expect(strip.className).toBe("wg-strip-thermalStrength");
    // Untouched strips keep the reference voice.
    expect(scene.strips.find((entry) => entry.key === "pressure")!.label).toBe("Pressure");
  });
});

describe("strip scale values", () => {
  it("prints each strip's maximum and minimum at its right edge", () => {
    const svg = renderSvg(buildScene(deterministicSceneProfile(), TZ));
    expect(svg).toContain('class="wg-strip-scale wg-mono">101.3<');
    expect(svg).toContain('class="wg-strip-scale wg-mono">101<');
    expect(svg).toContain('class="wg-strip-scale wg-mono">0.5<');
  });

  it("row strips keep their tags instead — no scale text where H/M/L sit", () => {
    const scene = buildScene(scienceSceneProfile(), TZ);
    const svg = renderSvg(scene, { stylesheet: null });
    const layers = scene.strips.find((strip) => strip.key === "cloudLayers");
    expect(layers).toBeDefined();
    // One scale pair per line strip; none for the row strip.
    const scaleTexts = svg.match(/wg-strip-scale/g) ?? [];
    const lineStrips = scene.strips.filter((strip) => !strip.rows);
    expect(scaleTexts).toHaveLength(lineStrips.length * 2);
  });
});

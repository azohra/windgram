import { describe, expect, it } from "vitest";
import { WINDGRAM_STABILITY_CLASSES } from "../src/derive/index.js";
import { buildKeySpec, buildScene } from "../src/scene/index.js";
import { renderKeySvg } from "../src/svg/index.js";
import {
  deterministicSceneProfile,
  ensembleSceneProfile,
  scienceSceneProfile,
} from "./scene-fixtures.js";

const TZ = { timeZone: "America/Vancouver" };

/* The key states only inherited facts: every assertion here compares the
   spec against the scene (or derive/'s table), never against literals —
   the tests that make drift impossible. */

describe("buildKeySpec series entries", () => {
  it("derives style facts from scene.series — dash, width, class are the scene's own", () => {
    const scene = buildScene(scienceSceneProfile(), TZ);
    const spec = buildKeySpec(scene);
    for (const entry of spec.series) {
      const source = scene.series.find((candidate) =>
        candidate.className.split(/\s+/).includes(entry.id),
      );
      expect(source, entry.id).toBeDefined();
      expect(entry.className).toBe(source!.className);
      expect(entry.dash).toBe(source!.dash);
      expect(entry.strokeWidth).toBe(source!.strokeWidth);
      expect(entry.key).toBe(source!.key);
    }
  });

  it("orders by the reference reading: lift, cloud base, boundary layers, 0 °C", () => {
    const spec = buildKeySpec(buildScene(scienceSceneProfile(), TZ));
    expect(spec.series.map((entry) => entry.id)).toEqual([
      "wg-series-usable",
      "wg-series-cloud-base",
      "wg-series-boundary",
      "wg-series-pbl",
      "wg-isotherm-freezing",
    ]);
    expect(spec.series.map((entry) => entry.label)).toEqual([
      "Usable lift",
      "Cloud base",
      "Boundary layer",
      "Model boundary layer",
      "0 °C",
    ]);
  });

  it("keys only what the scene drew — toggled-off lines leave the key", () => {
    const spec = buildKeySpec(
      buildScene(scienceSceneProfile(), { ...TZ, overlays: { cloudBase: false, pblHeight: false } }),
    );
    const ids = spec.series.map((entry) => entry.id);
    expect(ids).not.toContain("wg-series-cloud-base");
    expect(ids).not.toContain("wg-series-pbl");
    expect(ids).toContain("wg-series-usable");
  });

  it("leaves self-labelled lines out: plain isotherms and Td isolines", () => {
    const spec = buildKeySpec(
      buildScene(deterministicSceneProfile(), { ...TZ, overlays: { dewPoint: true } }),
    );
    const ids = spec.series.map((entry) => entry.id);
    expect(ids).toContain("wg-isotherm-freezing");
    expect(ids).not.toContain("wg-isotherm");
    expect(ids).not.toContain("wg-dewpoint-isoline");
  });
});

describe("buildKeySpec blocks", () => {
  it("stability classes come from derive/'s table — boundaries can never drift", () => {
    const spec = buildKeySpec(buildScene(deterministicSceneProfile(), TZ));
    expect(spec.stability).not.toBeNull();
    expect(
      spec.stability!.classes.map((entry) => ({
        className: entry.className,
        maxLapse: entry.maxLapse,
      })),
    ).toEqual(WINDGRAM_STABILITY_CLASSES.map((entry) => ({ ...entry })));
    expect(spec.stability!.groups.map((group) => group.span)).toEqual([2, 3, 1, 2]);
    expect(
      spec.stability!.groups.reduce((sum, group) => sum + group.span, 0),
    ).toBe(WINDGRAM_STABILITY_CLASSES.length);
  });

  it("keys the hatch when dense cloud drew, the band when a series carries one", () => {
    const deterministic = buildKeySpec(buildScene(deterministicSceneProfile(), TZ));
    expect(deterministic.hatch).not.toBeNull();
    expect(deterministic.band).toBeNull();

    // Ensemble: no levels — no fields at all — but banded series.
    const ensemble = buildKeySpec(buildScene(ensembleSceneProfile(), TZ));
    expect(ensemble.hatch).toBeNull();
    expect(ensemble.stability).toBeNull();
    expect(ensemble.band).not.toBeNull();
  });

  it("drops the stability bar when the overlay is off", () => {
    const spec = buildKeySpec(
      buildScene(deterministicSceneProfile(), { ...TZ, overlays: { stability: false } }),
    );
    expect(spec.stability).toBeNull();
  });

  it("overrides prose by id, and only prose", () => {
    const scene = buildScene(deterministicSceneProfile(), TZ);
    const spec = buildKeySpec(scene, {
      labels: {
        "wg-series-usable": "Hcrit",
        "wg-cloud-dense": "Saturated",
        "stability-title": "STABILITY",
        "stab-group-conditional": "Conditional",
      },
    });
    expect(spec.series.find((entry) => entry.id === "wg-series-usable")!.label).toBe("Hcrit");
    expect(spec.hatch!.label).toBe("Saturated");
    expect(spec.stability!.title).toBe("STABILITY");
    expect(spec.stability!.groups[1].label).toBe("Conditional");
    // The facts stay the scene's.
    const usable = scene.series.find((entry) => entry.key === "usableLiftTop")!;
    expect(spec.series[0].dash).toBe(usable.dash);
  });
});

describe("renderKeySvg", () => {
  const scene = buildScene(scienceSceneProfile(), TZ);
  const svg = renderKeySvg(buildKeySpec(scene));

  it("matches the key golden", async () => {
    await expect(svg).toMatchFileSnapshot("golden/key.svg");
  });

  it("is deterministic across renders", () => {
    expect(renderKeySvg(buildKeySpec(scene))).toBe(svg);
  });

  it("draws swatches with each entry's real class and dash so tokens retheme chart and key together", () => {
    const usable = scene.series.find((entry) => entry.key === "usableLiftTop")!;
    const boundary = scene.series.find((entry) => entry.key === "boundaryLayerTop")!;
    expect(svg).toContain(`class="${usable.className}"`);
    expect(svg).toContain(`stroke-dasharray="${boundary.dash}"`);
    // The same stylesheet rule the chart uses, so one token moves both.
    expect(svg).toContain(".wg-series-usable { stroke: var(--wg-usable");
  });

  it("names every stability cell in plain words and the ramp's direction in the aria", () => {
    expect(svg).toContain("<title>Very unstable</title>");
    expect(svg).toContain("<title>Strong inversion</title>");
    expect(svg).toContain("very unstable at the left through strong inversion at the right");
  });

  it("prints the boundaries above the cell edges, none on the unbounded last cell", () => {
    for (const boundary of ["-3", "-2.5", "-2", "-1.5", "-1.2", "0", "0.5"]) {
      expect(svg).toContain(`class="wg-key-boundary wg-mono">${boundary}<`);
    }
    expect(svg).not.toContain("Infinity");
  });

  it("keeps its own pattern namespace so a page can hold chart and key with default prefixes", () => {
    expect(svg).toContain('id="wg-key-cloud-hatch"');
    expect(svg).toContain('fill="url(#wg-key-cloud-hatch)"');
  });
});

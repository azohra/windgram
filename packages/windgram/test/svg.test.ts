import { describe, expect, it } from "vitest";
import { buildScene } from "../src/scene/index.js";
import {
  DEFAULT_STYLESHEET,
  STABILITY_TOKEN_DEFAULTS,
  TOKEN_DEFAULTS,
  renderSvg,
} from "../src/svg/index.js";
import {
  deterministicSceneProfile,
  ensembleSceneProfile,
  scienceSceneProfile,
} from "./scene-fixtures.js";

const TZ = { timeZone: "America/Vancouver" };

function deterministicSvg(): string {
  return renderSvg(
    buildScene(deterministicSceneProfile(), {
      ...TZ,
      overlays: { thermalIndex: true, windShear: true, buoyancyShear: true },
    }),
  );
}

function ensembleSvg(): string {
  return renderSvg(buildScene(ensembleSceneProfile(), TZ));
}

function scienceSvg(): string {
  return renderSvg(buildScene(scienceSceneProfile(), TZ));
}

describe("golden SVG fixtures", () => {
  it("matches the deterministic golden", async () => {
    await expect(deterministicSvg()).toMatchFileSnapshot("golden/deterministic.svg");
  });

  it("matches the ensemble golden", async () => {
    await expect(ensembleSvg()).toMatchFileSnapshot("golden/ensemble.svg");
  });

  it("matches the science golden", async () => {
    await expect(scienceSvg()).toMatchFileSnapshot("golden/science.svg");
  });

  it("is deterministic across renders", () => {
    expect(deterministicSvg()).toBe(deterministicSvg());
    expect(ensembleSvg()).toBe(ensembleSvg());
    expect(scienceSvg()).toBe(scienceSvg());
  });
});

describe("renderSvg structure", () => {
  const svg = deterministicSvg();

  it("is a self-contained SVG document with the default stylesheet", () => {
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain("<style>");
    // The stylesheet's stability fallbacks derive from the exported ramp —
    // the one home for those hexes.
    expect(svg).toContain(
      `--wg-stab-very-unstable, ${STABILITY_TOKEN_DEFAULTS["very-unstable"]}`,
    );
    // Every other fallback derives from TOKEN_DEFAULTS the same way,
    // including the cream cloud-marker fill paired with the cloud-base
    // outline (the reference look).
    expect(svg).toContain(`--wg-pbl, ${TOKEN_DEFAULTS.pbl}`);
    expect(svg).toContain(
      `.wg-marker-cloud { fill: var(--wg-cloud-marker, ${TOKEN_DEFAULTS["cloud-marker"]}); stroke: var(--wg-cloud-base, ${TOKEN_DEFAULTS["cloud-base"]}); }`,
    );
  });

  it("derives every stylesheet fallback from the exported token maps", () => {
    // Strip var() fallbacks that match an exported default; any hex left
    // in the stylesheet would be a value living outside its one home.
    let sheet = DEFAULT_STYLESHEET;
    for (const [name, value] of Object.entries(TOKEN_DEFAULTS)) {
      sheet = sheet.replaceAll(`var(--wg-${name}, ${value})`, "");
    }
    for (const [name, value] of Object.entries(STABILITY_TOKEN_DEFAULTS)) {
      sheet = sheet.replaceAll(`var(--wg-stab-${name}, ${value})`, "");
    }
    expect(sheet).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(sheet).not.toContain("var(");
  });

  it("styles by class name only — no hardcoded hex outside the stylesheet", () => {
    const body = svg.slice(svg.indexOf("</style>"));
    expect(body).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });

  it("draws the stability field, hatch pattern, series, barbs and labels", () => {
    expect(svg).toContain('class="wg-stab-');
    expect(svg).toContain('id="wg-cloud-hatch"');
    expect(svg).toContain('fill="url(#wg-cloud-hatch)"');
    expect(svg).toContain('class="wg-series-usable"');
    expect(svg).toContain('class="wg-barb"');
    expect(svg).toContain(">7</text>"); // 07:00 PDT hour tick
    expect(svg).toContain("launch 1485 m");
  });

  it("renders the new overlay strips and fields when enabled", () => {
    expect(svg).toContain('class="wg-strip-buoyancyShear"');
    expect(svg).toContain('class="wg-ti-');
    expect(svg).toContain('class="wg-shear-');
  });

  it("renders ensemble bands for strips and series", () => {
    const ensemble = ensembleSvg();
    expect(ensemble).toContain('class="wg-strip-thermalStrength-band"');
    expect(ensemble).toContain('class="wg-series-usable-band"');
    expect(ensemble).not.toContain('class="wg-stab-'); // no levels, no field
  });

  it("renders the science-wave elements: CAPE cells, cloud-layer rows, gusts, PBL series", () => {
    const science = scienceSvg();
    expect(science).toContain('class="wg-cape-severe wg-cape-capped"');
    expect(science).toContain('class="wg-cape-calm"');
    expect(science).toContain('class="wg-strip-cape"');
    expect(science).toContain('class="wg-cloud-cell"');
    expect(science).toContain(">H</text>");
    expect(science).toContain(">L</text>");
    expect(science).toContain(">G22</text>");
    expect(science).toContain('class="wg-series-pbl"');
  });

  it("adds no science markup for a profile without the fields", () => {
    // The overlays default on; a pre-wave document must not grow chrome.
    // (stylesheet: null — the default <style> block names every class.)
    const svg = renderSvg(buildScene(deterministicSceneProfile(), TZ), { stylesheet: null });
    expect(svg).not.toContain("wg-cape");
    expect(svg).not.toContain("wg-cloud-cell");
    expect(svg).not.toContain("wg-gust");
    expect(svg).not.toContain("wg-series-pbl");
  });

  it("leaves nothing unremovable except the axes and frame", () => {
    // Every remaining element rides an overlay toggle (stylesheet: null so
    // class names appear only where elements are actually drawn).
    const everythingOff = renderSvg(
      buildScene(scienceSceneProfile(), {
        ...TZ,
        overlays: {
          temperature: false,
          wind: false,
          clouds: false,
          thermalStrength: false,
          stability: false,
          cape: false,
          gusts: false,
          pblHeight: false,
          cloudLayers: false,
          pressure: false,
          precipitation: false,
          boundaryLayerTop: false,
          cloudBase: false,
          usableLiftTop: false,
          launch: false,
          selectedHour: false,
        },
      }),
      { stylesheet: null },
    );
    for (const forbidden of [
      "wg-strip-",
      "wg-series-",
      "wg-stab-",
      // (the invisible hatch <pattern> def keeps its class; nothing fills with it)
      "wg-cloud-dense",
      "wg-cloud-medium",
      "wg-cloud-light",
      "wg-cloud-cell",
      "wg-cape-",
      "wg-barb",
      "wg-gust",
      "wg-marker-",
      "wg-isotherm",
      "wg-launch-line",
      "wg-selected-column",
      "wg-selected-line",
      "launch 1485 m",
    ]) {
      expect(everythingOff, forbidden).not.toContain(forbidden);
    }
    // The axes and frame remain: this is still a windgram, not a blank.
    expect(everythingOff).toContain('class="wg-frame"');
    expect(everythingOff).toContain('class="wg-gridline"');
    expect(everythingOff).toContain('class="wg-text-mute wg-mono"');
  });

  it("removes the derived-height lines and selected-hour highlight per toggle", () => {
    const scene = buildScene(scienceSceneProfile(), {
      ...TZ,
      overlays: { boundaryLayerTop: false, cloudBase: false, selectedHour: false },
    });
    const svg = renderSvg(scene, { stylesheet: null });
    expect(svg).not.toContain("wg-series-boundary");
    expect(svg).not.toContain("wg-series-cloud-base");
    expect(svg).not.toContain("wg-marker-cloud");
    expect(svg).not.toContain("wg-selected-column");
    // The untouched siblings stay: per-line means per-line.
    expect(svg).toContain('class="wg-series-usable"');
    expect(svg).toContain('class="wg-series-pbl"');
    expect(svg).toContain('class="wg-marker-wing"');
  });

  it("honours idPrefix and stylesheet overrides", () => {
    const scene = buildScene(deterministicSceneProfile(), TZ);
    const custom = renderSvg(scene, { idPrefix: "left", stylesheet: null });
    expect(custom).toContain('id="left-cloud-hatch"');
    expect(custom).toContain('fill="url(#left-cloud-hatch)"');
    expect(custom).not.toContain("<style>");
    expect(DEFAULT_STYLESHEET).toContain(".wg-cloud-hatch-line");
  });
});

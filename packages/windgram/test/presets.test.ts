import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWindgramProfile } from "../src/contract/index.js";
import { WINDGRAM_STABILITY_CLASSES } from "../src/derive/index.js";
import { buildScene } from "../src/scene/index.js";
import { CANADARASP_PRESET, REFERENCE_PRESET, applyPreset } from "../src/presets/index.js";
import { STABILITY_TOKEN_DEFAULTS, TOKEN_DEFAULTS } from "../src/svg/index.js";
import {
  deterministicSceneProfile,
  ensembleSceneProfile,
  scienceSceneProfile,
} from "./scene-fixtures.js";

const TZ = { timeZone: "America/Vancouver" };

/* The real pipeline column (see usable-lift.test.ts): the fixture whose
   published usableLiftTopM the recompute path reproduces exactly at 1.0. */
const pipelineFixture = parseWindgramProfile(
  JSON.parse(readFileSync(join(__dirname, "pipeline-parity.json"), "utf-8")),
)!;

describe("REFERENCE_PRESET", () => {
  it("applies to exactly the scene passing no options builds — deterministic, ensemble, science", () => {
    for (const profile of [
      deterministicSceneProfile(),
      ensembleSceneProfile(),
      scienceSceneProfile(),
    ]) {
      const bare = buildScene(profile, TZ);
      const preset = buildScene(profile, applyPreset(REFERENCE_PRESET, TZ));
      expect(JSON.stringify(preset)).toBe(JSON.stringify(bare));
    }
  });

  it("tokens are TOKEN_DEFAULTS plus the stab-prefixed stability ramp — composed, complete, collision-free", () => {
    const expected: Record<string, string> = { ...TOKEN_DEFAULTS };
    for (const [name, hex] of Object.entries(STABILITY_TOKEN_DEFAULTS)) {
      expect(expected[`stab-${name}`]).toBeUndefined();
      expected[`stab-${name}`] = hex;
    }
    expect(REFERENCE_PRESET.tokens).toEqual(expected);
    expect(Object.keys(REFERENCE_PRESET.tokens!)).toHaveLength(
      Object.keys(TOKEN_DEFAULTS).length + Object.keys(STABILITY_TOKEN_DEFAULTS).length,
    );
  });

  it("deliberately does not name sinkRateMs — the default is the published series, not a recompute", () => {
    expect(REFERENCE_PRESET.sceneOptions).not.toHaveProperty("sinkRateMs");
  });
});

describe("CANADARASP_PRESET", () => {
  it("sceneOptions coincide with the defaults: identical scene geometry for a pipeline-derived document", () => {
    // The verified option inheritances are already this package's
    // conventions: smoothing is on by default, and the recomputed
    // usable-lift series at canadarasp's 1.0 m/s sink threshold equals the
    // published one exactly. The preset's visible difference lives
    // entirely in tokens — the scene graph carries no colours.
    const bare = buildScene(pipelineFixture, TZ);
    const preset = buildScene(pipelineFixture, applyPreset(CANADARASP_PRESET, TZ));
    expect(JSON.stringify(preset)).toBe(JSON.stringify(bare));
  });

  it("sinkRateMs flows through the recompute path — overriding it on top of the preset moves the line", () => {
    const at = (sinkRateMs: number) =>
      buildScene(pipelineFixture, {
        ...applyPreset(CANADARASP_PRESET, TZ),
        sinkRateMs,
      }).series.find((entry) => entry.key === "usableLiftTop")!.path;
    expect(at(1.6)).not.toBe(at(1.0));
    expect(at(1.0)).toBe(
      buildScene(pipelineFixture, applyPreset(CANADARASP_PRESET, TZ)).series.find(
        (entry) => entry.key === "usableLiftTop",
      )!.path,
    );
  });

  it("smooth: true is load-bearing — turning smoothing off on top of the preset changes the scene", () => {
    const smoothed = buildScene(pipelineFixture, applyPreset(CANADARASP_PRESET, TZ));
    const raw = buildScene(pipelineFixture, {
      ...applyPreset(CANADARASP_PRESET, TZ),
      smooth: false,
    });
    expect(JSON.stringify(raw)).not.toBe(JSON.stringify(smoothed));
  });

  it("colours the complete stability ramp — one token per WINDGRAM_STABILITY_CLASSES class", () => {
    for (const { className } of WINDGRAM_STABILITY_CLASSES) {
      expect(CANADARASP_PRESET.tokens![`stab-${className}`]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("keeps canadarasp's design pivot: stable air matches the background", () => {
    // windgram-continental-colormap.ncl: "matching the background is stable".
    expect(CANADARASP_PRESET.tokens!["stab-stable"]).toBe(CANADARASP_PRESET.tokens!.surface);
    expect(CANADARASP_PRESET.tokens!["strip-bg"]).toBe(CANADARASP_PRESET.tokens!.surface);
  });

  it("names only real --wg-* slots — every token key exists in the reference map", () => {
    for (const key of Object.keys(CANADARASP_PRESET.tokens!)) {
      expect(REFERENCE_PRESET.tokens, key).toHaveProperty(key);
    }
  });

  it("pins the verified palette — the values extracted from canadarasp's source", () => {
    expect(CANADARASP_PRESET.tokens).toEqual({
      "stab-very-unstable": "#ff3d3d",
      "stab-unstable": "#ff7800",
      "stab-conditional-strong": "#ff96ff",
      "stab-conditional": "#ccbfff",
      "stab-near-neutral": "#facab1",
      "stab-stable": "#8080e6",
      "stab-inverted": "#cccccc",
      "stab-strong-inversion": "#999999",
      surface: "#8080e6",
      "strip-bg": "#8080e6",
      pressure: "#cd5b45",
      rain: "#00ced1",
      cloud: "#7f7f7f",
      lift: "#cdad00",
      "cloud-marker": "#ffffff",
      usable: "#0000ff",
      boundary: "#ffff00",
    });
  });

  it("deliberately claims no ink-family tokens — canadarasp's text scheme collides one slot with two conventions", () => {
    for (const excluded of ["ink", "ink-soft", "ink-mute", "rule", "halo", "wind"]) {
      expect(CANADARASP_PRESET.tokens).not.toHaveProperty(excluded);
    }
  });
});

describe("applyPreset", () => {
  it("consumer options win over the preset — presets are starting points, not modes", () => {
    const options = applyPreset(CANADARASP_PRESET, { ...TZ, smooth: false });
    expect(options.smooth).toBe(false);
    expect(options.sinkRateMs).toBe(1.0);
    expect(options.timeZone).toBe(TZ.timeZone);
  });
});

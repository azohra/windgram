import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseWindgramProfile,
  windgramProfileSchema,
  type WindgramProfile,
} from "../src/contract/index.js";
import { stabilityClass } from "../src/derive/index.js";
import { buildScene, type SceneGraph } from "../src/scene/index.js";
import { renderSvg } from "../src/svg/index.js";

interface ScenarioOutput {
  path: string;
  sha256: string;
  variant?: string;
  title?: string;
}

interface ScenarioEntry {
  id: string;
  title: string;
  lesson: string;
  kind: "deterministic" | "ensemble" | "comparison";
  modelShape: string;
  timeZone: string;
  site: { id: string };
  /** The launch the scenario teaches against — index metadata, passed to
      the renderer as SceneOptions.launch; documents are launch-agnostic. */
  launch: { elevationM: number };
  outputs: ScenarioOutput[];
}

interface ScenarioIndex {
  schemaVersion: number;
  scenarios: ScenarioEntry[];
}

interface LoadedOutput {
  entry: ScenarioEntry;
  output: ScenarioOutput;
  profile: WindgramProfile;
  /** The scenario's launch, read from its index entry. */
  launch: { elevationM: number };
  scene: SceneGraph;
  svg: string;
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = resolve(TEST_DIR, "../../scenarios");
const rawIndex = JSON.parse(readFileSync(join(SCENARIO_DIR, "index.json"), "utf8")) as unknown;

function scenarioIndex(value: unknown): ScenarioIndex {
  expect(value).toBeTypeOf("object");
  const candidate = value as Partial<ScenarioIndex>;
  expect(candidate.schemaVersion).toBe(1);
  expect(Array.isArray(candidate.scenarios)).toBe(true);
  return candidate as ScenarioIndex;
}

function outputLabel(entry: ScenarioEntry, output: ScenarioOutput): string {
  return output.variant === undefined ? entry.id : `${entry.id}:${output.variant}`;
}

function loadOutput(entry: ScenarioEntry, output: ScenarioOutput): LoadedOutput {
  const label = outputLabel(entry, output);
  expect(output.path, `${label} output must stay below scenarios/generated`).toMatch(
    /^generated\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)?\.profile\.json$/,
  );
  const source = readFileSync(join(SCENARIO_DIR, output.path), "utf8");
  expect(createHash("sha256").update(source).digest("hex"), `${label} sha256`).toBe(
    output.sha256,
  );
  const rawProfile = JSON.parse(source) as unknown;

  const schemaResult = windgramProfileSchema.safeParse(rawProfile);
  expect(
    schemaResult.success,
    `${label} must satisfy windgramProfileSchema${
      schemaResult.success ? "" : `: ${schemaResult.error.message}`
    }`,
  ).toBe(true);

  // Exercise the public nullable parser separately: this is the API a
  // consumer uses at a stored-document trust boundary.
  const profile = parseWindgramProfile(rawProfile);
  expect(profile, `${label} must satisfy parseWindgramProfile`).not.toBeNull();
  expect(profile!.site.id, `${label} site identity`).toBe(entry.site.id);

  // Launches are render inputs (SceneOptions.launch); the scenario's launch
  // is index metadata, never a document field.
  const launch = entry.launch;
  expect(launch?.elevationM, `${label} index entry must carry the launch`).toBeTypeOf("number");

  assertFiniteNumbers(profile, `${label} profile`);
  const scene = buildScene(profile!, { timeZone: entry.timeZone, launch });
  assertFiniteNumbers(scene, `${label} scene`);
  const svg = renderSvg(scene, { idPrefix: `scenario-${entry.id}-${output.variant ?? "only"}` });
  validateSvg(svg, label);

  return { entry, output, profile: profile!, launch, scene, svg };
}

function assertFiniteNumbers(value: unknown, label: string, seen = new Set<object>()): void {
  if (typeof value === "number") {
    expect(Number.isFinite(value), `${label} contains a non-finite number`).toBe(true);
    return;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    assertFiniteNumbers(child, `${label}.${key}`, seen);
  }
}

function validateSvg(svg: string, label: string): void {
  expect(svg, `${label} SVG root`).toMatch(/^<svg\b[\s\S]*<\/svg>$/);
  expect(svg, `${label} SVG contains an invalid numeric token`).not.toMatch(
    /(?:^|[^A-Za-z])(?:NaN|[+-]?Infinity)(?:$|[^A-Za-z])/,
  );

  const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  expect(new Set(ids).size, `${label} SVG contains duplicate ids: ${duplicateValues(ids).join(", ")}`).toBe(
    ids.length,
  );

  const paths = [...svg.matchAll(/<path\b[^>]*\bd="([^"]*)"[^>]*>/g)].map(
    (match) => match[1],
  );
  expect(paths.length, `${label} SVG must contain paths`).toBeGreaterThan(0);
  for (const path of paths) assertValidSvgPath(path, label);
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function assertValidSvgPath(path: string, label: string): void {
  const tokenPattern = /[A-Za-z]|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/g;
  const tokens: string[] = [];
  let end = 0;
  for (const match of path.matchAll(tokenPattern)) {
    expect(path.slice(end, match.index), `${label} has invalid SVG path syntax: ${path}`).toMatch(
      /^[\s,]*$/,
    );
    tokens.push(match[0]);
    end = (match.index ?? 0) + match[0].length;
  }
  expect(path.slice(end), `${label} has invalid SVG path syntax: ${path}`).toMatch(/^[\s,]*$/);
  expect(tokens.length, `${label} has an empty SVG path`).toBeGreaterThan(0);

  const arity: Record<string, number> = {
    A: 7,
    C: 6,
    H: 1,
    L: 2,
    M: 2,
    Q: 4,
    S: 4,
    T: 2,
    V: 1,
    Z: 0,
  };
  let index = 0;
  while (index < tokens.length) {
    const command = tokens[index];
    expect(command, `${label} SVG path must begin each segment with a command`).toMatch(/^[A-Za-z]$/);
    index += 1;
    const expected = arity[command.toUpperCase()];
    expect(expected, `${label} SVG path uses unsupported command ${command}`).not.toBeUndefined();
    let count = 0;
    while (index < tokens.length && !/^[A-Za-z]$/.test(tokens[index])) {
      expect(Number.isFinite(Number(tokens[index])), `${label} SVG path contains ${tokens[index]}`).toBe(
        true,
      );
      count += 1;
      index += 1;
    }
    if (expected === 0) {
      expect(count, `${label} close-path command must not carry coordinates`).toBe(0);
    } else {
      expect(count, `${label} SVG path command ${command} has no coordinates`).toBeGreaterThanOrEqual(
        expected,
      );
      expect(count % expected, `${label} SVG path command ${command} has the wrong arity`).toBe(0);
    }
  }
}

const index = scenarioIndex(rawIndex);
const scenarioIds = index.scenarios.map((entry) => entry.id);
const outputs = index.scenarios.flatMap((entry) =>
  entry.outputs.map((output) => loadOutput(entry, output)),
);

describe("generated teaching scenarios", () => {
  it("has unique scenario ids, output labels, paths, and comparison variants", () => {
    expect(new Set(scenarioIds).size, `duplicate scenario ids: ${duplicateValues(scenarioIds).join(", ")}`).toBe(
      scenarioIds.length,
    );
    const labels = outputs.map(({ entry, output }) => outputLabel(entry, output));
    expect(new Set(labels).size, `duplicate scenario outputs: ${duplicateValues(labels).join(", ")}`).toBe(
      labels.length,
    );
    const paths = outputs.map(({ output }) => output.path);
    expect(new Set(paths).size, `duplicate scenario paths: ${duplicateValues(paths).join(", ")}`).toBe(
      paths.length,
    );

    for (const entry of index.scenarios) {
      expect(entry.outputs.length, `${entry.id} must have at least one output`).toBeGreaterThan(0);
      if (entry.kind === "comparison") {
        expect(entry.outputs.length, `${entry.id} comparison needs multiple outputs`).toBeGreaterThan(1);
        expect(
          entry.outputs.every((output) => output.variant && output.title),
          `${entry.id} comparison outputs need variant metadata`,
        ).toBe(true);
      } else {
        expect(entry.outputs, `${entry.id} has one profile`).toHaveLength(1);
        expect(entry.outputs[0].variant, `${entry.id} must not declare a comparison variant`).toBeUndefined();
      }
    }
  });

  it.each(outputs.map((loaded) => [outputLabel(loaded.entry, loaded.output), loaded] as const))(
    "parses, builds, and renders %s through the TypeScript package",
    (_label, loaded) => {
      expect(loaded.profile.hours.length).toBeGreaterThan(0);
      expect(loaded.scene.scales.hourCount).toBe(loaded.profile.hours.length);
      expect(loaded.svg).toContain(`id="scenario-${loaded.entry.id}-${loaded.output.variant ?? "only"}-cloud-hatch"`);
    },
  );

  it("makes the convective cycle legible as a changing time-height field", () => {
    const cycle = outputs.find(({ entry }) => entry.id === "convective-cycle");
    expect(cycle, "missing convective-cycle scenario").toBeDefined();

    const stabilityByHour = cycle!.scene.sampling.map((hour) =>
      hour.lapseCPer1000Ft.map((node) => stabilityClass(node.value)),
    );
    expect(stabilityByHour[0].slice(0, 2)).toEqual(["strong-inversion", "stable"]);
    expect(stabilityByHour[9].slice(0, 2)).toEqual(["strong-inversion", "stable"]);
    expect(
      stabilityByHour[5]
        .slice(0, 6)
        .every((name) => name === "very-unstable" || name === "unstable"),
    ).toBe(true);
    expect(new Set(stabilityByHour.flat()).size).toBeGreaterThanOrEqual(6);

    const firstSubfreezingHeights = cycle!.scene.sampling.map(
      (hour) => hour.temperatureC.find((node) => node.value <= 0)?.altitudeM,
    );
    expect(firstSubfreezingHeights).toEqual([
      3150,
      3150,
      3150,
      3150,
      3650,
      3650,
      3650,
      4250,
      3650,
      3150,
    ]);
    expect(new Set(firstSubfreezingHeights).size).toBe(3);
    expect(cycle!.scene.series.some((series) => series.className.includes("wg-isotherm-freezing"))).toBe(true);

    const cape = cycle!.scene.strips.find((strip) => strip.key === "cape");
    expect(cape, "convective-cycle must render its published CAPE strip").toBeDefined();
    expect(cape!.values).toEqual([0, 0, 0, 60, 320, 780, 440, 80, 20, 0]);
  });
});

describe("scenario SVG goldens", () => {
  // Intentional renderer changes update these with:
  // pnpm --dir toolkit exec vitest run test/scenarios.test.ts --update
  for (const id of ["convective-cycle", "ensemble-wide", "smoke-over-thermals"] as const) {
    it(`matches the ${id} golden`, async () => {
      const loaded = outputs.find(({ entry }) => entry.id === id);
      expect(loaded, `missing selected golden scenario ${id}`).toBeDefined();
      await expect(loaded!.svg).toMatchFileSnapshot(`golden/scenario-${id}.svg`);
    });
  }

  it("matches the smoke-over-thermals ADJUSTED golden — the alternate view is a render option, not a different profile", async () => {
    const loaded = outputs.find(({ entry }) => entry.id === "smoke-over-thermals");
    expect(loaded).toBeDefined();
    const scene = buildScene(loaded!.profile, {
      timeZone: loaded!.entry.timeZone,
      launch: loaded!.launch,
      smokeAdjusted: true,
    });
    // The view must declare itself: the graph carries the derating smoke
    // model + run, and the reference key renders that label.
    expect(scene.smokeAdjustment).toEqual({
      smokeModel: loaded!.profile.model,
      smokeRun: loaded!.profile.run.referenceTime,
    });
    const svg = renderSvg(scene, { idPrefix: "scenario-smoke-over-thermals-adjusted" });
    validateSvg(svg, "smoke-over-thermals adjusted view");
    await expect(svg).toMatchFileSnapshot("golden/scenario-smoke-over-thermals-adjusted.svg");
  });

  it("the smoke-over-thermals correction is material, not merely nonzero", () => {
    // The scenario's whole lesson is the gap between the smoke-blind and
    // adjusted views. Byte-inequality once passed while the panels looked
    // identical (a ~7% peak-w* derate is ~2px at figure scale): the
    // committed scenario must keep a plume severe enough, during the
    // hours that actually carry thermals, for a reader to SEE the derate.
    const loaded = outputs.find(({ entry }) => entry.id === "smoke-over-thermals");
    expect(loaded).toBeDefined();
    const options = { timeZone: loaded!.entry.timeZone };
    const wPeak = (scene: ReturnType<typeof buildScene>) =>
      Math.max(
        ...scene.strips
          .find((strip) => strip.key === "thermalStrength")!
          .values.map((value) => value ?? 0),
      );
    const base = wPeak(buildScene(loaded!.profile, options));
    const adjusted = wPeak(buildScene(loaded!.profile, { ...options, smokeAdjusted: true }));
    expect(adjusted).toBeLessThan(base * 0.87);
    expect(adjusted).toBeGreaterThan(base * 0.5); // still a partial correction, not an eraser
  });
});

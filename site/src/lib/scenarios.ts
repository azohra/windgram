import {
  windgramProfileSchema,
  type WindgramProfile,
} from "windgram/contract";
import rawIndex from "../../../scenarios/index.json";

// This registry eagerly imports and schema-validates every generated profile,
// so it must never reach a client bundle. Components resolve their scenario
// here in Astro frontmatter and pass the profile inline; client scripts get
// exactly the documents their page embeds.
if (typeof window !== "undefined") {
  throw new Error(
    "[scenarios] the scenario registry is server-only — resolve profiles in Astro frontmatter and embed them inline for client scripts",
  );
}

export type ScenarioKind = "deterministic" | "ensemble" | "comparison";

export interface ScenarioCapabilities {
  levels: boolean;
  pressureLevels: number[];
  verticalVelocity: false | "omega" | "fromGeometricW";
  verticalVelocityLevels?: number[];
  heatFluxes: boolean;
  gust: false | "hourMax" | "instant";
  cape: boolean;
  cin: boolean;
  pblHeight: boolean;
  cloudLayers: boolean;
  cloudProfile: boolean;
}

interface ScenarioOutputIndexEntry {
  path: string;
  sha256: string;
  variant?: string;
  title?: string;
}

interface ScenarioIndexEntry {
  id: string;
  title: string;
  lesson: string;
  kind: ScenarioKind;
  modelShape: string;
  timeZone: string;
  capabilities: ScenarioCapabilities;
  outputs: ScenarioOutputIndexEntry[];
}

export interface TeachingScenario {
  id: string;
  variant?: string;
  kind: ScenarioKind;
  modelShape: string;
  profile: WindgramProfile;
  lesson: string;
  label: string;
  timeZone: string;
  capabilities: ScenarioCapabilities;
  accessibilityDescription: string;
}

const rawProfileModules = import.meta.glob("../../../scenarios/generated/*.profile.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;

function fail(message: string): never {
  throw new Error(`[scenarios] ${message}`);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${field} must be a non-empty string`);
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(`${field} must be a boolean`);
  return value;
}

function requireFiniteNumbers(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.some((item) => !Number.isFinite(item))) {
    fail(`${field} must contain only finite numbers`);
  }
  return [...value] as number[];
}

function parseCapabilities(value: unknown, id: string): ScenarioCapabilities {
  if (value === null || typeof value !== "object") fail(`${id}.capabilities must be an object`);
  const candidate = value as Record<string, unknown>;
  const verticalVelocity = candidate.verticalVelocity;
  if (
    verticalVelocity !== false &&
    verticalVelocity !== "omega" &&
    verticalVelocity !== "fromGeometricW"
  ) {
    fail(`${id}.capabilities.verticalVelocity has an unsupported value`);
  }
  const verticalVelocityLevels = candidate.verticalVelocityLevels === undefined
    ? undefined
    : requireFiniteNumbers(
        candidate.verticalVelocityLevels,
        `${id}.capabilities.verticalVelocityLevels`,
      );
  if (verticalVelocity === false && verticalVelocityLevels !== undefined) {
    fail(`${id}.capabilities.verticalVelocityLevels requires a vertical-velocity capability`);
  }
  if (verticalVelocity !== false && verticalVelocityLevels === undefined) {
    fail(`${id}.capabilities.verticalVelocityLevels is required for ${verticalVelocity}`);
  }
  const gust = candidate.gust;
  if (gust !== false && gust !== "hourMax" && gust !== "instant") {
    fail(`${id}.capabilities.gust has an unsupported value`);
  }
  return {
    levels: requireBoolean(candidate.levels, `${id}.capabilities.levels`),
    pressureLevels: requireFiniteNumbers(
      candidate.pressureLevels,
      `${id}.capabilities.pressureLevels`,
    ),
    verticalVelocity,
    verticalVelocityLevels,
    heatFluxes: requireBoolean(candidate.heatFluxes, `${id}.capabilities.heatFluxes`),
    gust,
    cape: requireBoolean(candidate.cape, `${id}.capabilities.cape`),
    cin: requireBoolean(candidate.cin, `${id}.capabilities.cin`),
    pblHeight: requireBoolean(candidate.pblHeight, `${id}.capabilities.pblHeight`),
    cloudLayers: requireBoolean(candidate.cloudLayers, `${id}.capabilities.cloudLayers`),
    cloudProfile: requireBoolean(candidate.cloudProfile, `${id}.capabilities.cloudProfile`),
  };
}

function parseOutput(value: unknown, id: string, index: number): ScenarioOutputIndexEntry {
  if (value === null || typeof value !== "object") fail(`${id}.outputs[${index}] must be an object`);
  const candidate = value as Record<string, unknown>;
  const path = requireString(candidate.path, `${id}.outputs[${index}].path`);
  if (!/^generated\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)?\.profile\.json$/.test(path)) {
    fail(`${id}.outputs[${index}].path must name a generated profile`);
  }
  const sha256 = requireString(candidate.sha256, `${id}.outputs[${index}].sha256`);
  if (!/^[a-f0-9]{64}$/.test(sha256)) fail(`${id}.outputs[${index}].sha256 must be lowercase SHA-256`);
  const variant = candidate.variant === undefined
    ? undefined
    : requireString(candidate.variant, `${id}.outputs[${index}].variant`);
  const title = candidate.title === undefined
    ? undefined
    : requireString(candidate.title, `${id}.outputs[${index}].title`);
  return { path, sha256, variant, title };
}

function parseIndexEntry(value: unknown, index: number): ScenarioIndexEntry {
  if (value === null || typeof value !== "object") fail(`index.scenarios[${index}] must be an object`);
  const candidate = value as Record<string, unknown>;
  const id = requireString(candidate.id, `index.scenarios[${index}].id`);
  const kind = candidate.kind;
  if (kind !== "deterministic" && kind !== "ensemble" && kind !== "comparison") {
    fail(`${id}.kind has an unsupported value`);
  }
  if (!Array.isArray(candidate.outputs) || candidate.outputs.length === 0) {
    fail(`${id}.outputs must contain at least one profile`);
  }
  const outputs = candidate.outputs.map((output, outputIndex) => parseOutput(output, id, outputIndex));
  if (kind === "comparison") {
    if (outputs.length < 2 || outputs.some((output) => !output.variant || !output.title)) {
      fail(`${id} comparison outputs require variant and title metadata`);
    }
  } else if (outputs.length !== 1 || outputs[0].variant !== undefined) {
    fail(`${id} ${kind} scenario must have exactly one unvaried output`);
  }
  return {
    id,
    title: requireString(candidate.title, `${id}.title`),
    lesson: requireString(candidate.lesson, `${id}.lesson`),
    kind,
    modelShape: requireString(candidate.modelShape, `${id}.modelShape`),
    timeZone: requireString(candidate.timeZone, `${id}.timeZone`),
    capabilities: parseCapabilities(candidate.capabilities, id),
    outputs,
  };
}

function profileModule(path: string): unknown {
  const suffix = `/${path}`;
  const matches = Object.entries(rawProfileModules).filter(([modulePath]) => modulePath.endsWith(suffix));
  if (matches.length !== 1) fail(`${path} resolved to ${matches.length} generated profile modules`);
  return matches[0][1];
}

function accessibilityDescription(
  entry: ScenarioIndexEntry,
  output: ScenarioOutputIndexEntry,
  profile: WindgramProfile,
): string {
  const label = output.title ?? entry.title;
  const shape = entry.kind === "ensemble"
    ? `an ensemble of ${profile.run.members ?? "multiple"} members`
    : entry.kind === "comparison"
      ? "one profile in a controlled timing comparison"
      : "one atmospheric profile";
  return `${label}. This windgram shows ${shape} in ${entry.timeZone}. ${entry.lesson}`;
}

function buildRegistry(): Map<string, TeachingScenario[]> {
  const candidate = rawIndex as unknown as { schemaVersion?: unknown; scenarios?: unknown };
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.scenarios)) {
    fail("index.json must contain schemaVersion 1 and a scenarios array");
  }
  const entries = candidate.scenarios.map(parseIndexEntry);
  const registry = new Map<string, TeachingScenario[]>();
  const outputPaths = new Set<string>();
  for (const entry of entries) {
    if (registry.has(entry.id)) fail(`duplicate scenario id ${entry.id}`);
    const variants = new Set<string>();
    const scenarios = entry.outputs.map((output) => {
      if (outputPaths.has(output.path)) fail(`duplicate generated profile path ${output.path}`);
      outputPaths.add(output.path);
      if (output.variant && variants.has(output.variant)) fail(`duplicate ${entry.id} variant ${output.variant}`);
      if (output.variant) variants.add(output.variant);

      const parsed = windgramProfileSchema.safeParse(profileModule(output.path));
      if (!parsed.success) fail(`${output.path} is not a valid profile document: ${parsed.error.message}`);
      return {
        id: entry.id,
        variant: output.variant,
        kind: entry.kind,
        modelShape: entry.modelShape,
        profile: parsed.data,
        lesson: entry.lesson,
        label: output.title ?? entry.title,
        timeZone: entry.timeZone,
        capabilities: entry.capabilities,
        accessibilityDescription: accessibilityDescription(entry, output, parsed.data),
      } satisfies TeachingScenario;
    });
    registry.set(entry.id, scenarios);
  }
  return registry;
}

// Eager construction makes an invalid index or generated profile a build-time
// failure even before a particular figure requests it.
const REGISTRY = buildRegistry();

/** Return every output for an id (one normally, multiple for comparisons). */
function scenariosById(id: string): readonly TeachingScenario[] {
  const scenarios = REGISTRY.get(id);
  if (!scenarios) fail(`unknown scenario id ${JSON.stringify(id)}`);
  return scenarios;
}

/**
 * Resolve one teaching profile. Comparison scenarios require their declared
 * variant so a page cannot silently choose one side of the comparison.
 */
export function scenarioById(id: string, variant?: string): TeachingScenario {
  const scenarios = scenariosById(id);
  if (scenarios.length === 1) {
    if (variant !== undefined) fail(`${id} has no variant ${JSON.stringify(variant)}`);
    return scenarios[0];
  }
  if (variant === undefined) fail(`${id} is a comparison; request one of: ${scenarios.map((item) => item.variant).join(", ")}`);
  const scenario = scenarios.find((item) => item.variant === variant);
  if (!scenario) fail(`${id} has no variant ${JSON.stringify(variant)}`);
  return scenario;
}

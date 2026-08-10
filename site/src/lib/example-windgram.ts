import type { WindgramProfile } from "windgram/contract";
import { groupByLocalDay, windgramDisplayHours } from "windgram/derive";
import {
  buildScene,
  DEFAULT_OVERLAYS,
  type OverlayName,
  type SceneGraph,
  type SceneOptions,
} from "windgram/scene";
import { renderSvg } from "windgram/svg";

/**
 * Everything a synthetic windgram needs at render time, whether that render
 * happens in Astro frontmatter (resolved from the server-only scenario
 * registry in `./scenarios`) or in a client script (parsed from the same
 * values the component embedded inline). `TeachingScenario` satisfies this
 * shape structurally. Keeping this module free of the registry import is what
 * keeps the scenario JSON glob and its schema validation out of client
 * bundles.
 */
export interface SyntheticScenarioSource {
  id: string;
  variant?: string;
  profile: WindgramProfile;
  timeZone: string;
}

export interface SyntheticWindgramOptions
  extends Omit<SceneOptions, "timeZone" | "hours"> {
  /**
   * Render the longest display-day window rather than every scenario hour.
   * Synthetic teaching scenarios normally fit one UTC day, but retaining
   * this switch keeps the wrapper useful if a later lesson crosses midnight.
   */
  displayDay?: boolean;
}

/** Presentation options that remain serializable across Astro hydration. */
export type InteractiveSyntheticWindgramOptions = Pick<
  SyntheticWindgramOptions,
  | "overlays"
  | "columnWidthPx"
  | "widthPx"
  | "plotHeightPx"
  | "barbStride"
  | "barbMinGapPx"
  | "barbScale"
  | "markerStride"
  | "stripLabels"
  | "displayDay"
> & {
  /** Function formatters remain available to server-only callers. */
  hourLabel?: "24h" | "12h";
};

const DEFAULT_COLUMN_WIDTH_PX = 72;
const DEFAULT_PLOT_HEIGHT_PX = 390;

function displayHours(scenario: SyntheticScenarioSource) {
  const windowed = windgramDisplayHours(scenario.profile.hours, {
    timeZone: scenario.timeZone,
  });
  const days = groupByLocalDay(windowed, scenario.timeZone);
  return [...days].sort((left, right) => right.hours.length - left.hours.length)[0]?.hours ?? [];
}

/**
 * Build and serialize a teaching scenario through the npm package's only
 * chart-geometry path. Site components may annotate this result, but do not
 * calculate paths, fields, barbs, or derived height series themselves.
 */
export function renderSyntheticWindgram(
  scenario: SyntheticScenarioSource,
  options: SyntheticWindgramOptions = {},
  idPrefix = `synthetic-${scenario.id}${scenario.variant ? `-${scenario.variant}` : ""}`,
): { scene: SceneGraph; svg: string } {
  const { displayDay = false, ...sceneOptions } = options;
  const scene = buildScene(scenario.profile, {
    timeZone: scenario.timeZone,
    columnWidthPx: DEFAULT_COLUMN_WIDTH_PX,
    plotHeightPx: DEFAULT_PLOT_HEIGHT_PX,
    ...(displayDay ? { hours: displayHours(scenario) } : {}),
    ...sceneOptions,
  });
  return { scene, svg: renderSvg(scene, { idPrefix }) };
}

/** A complete overlay state with only the requested package layers enabled. */
export function onlyOverlays(...enabled: OverlayName[]): Record<OverlayName, boolean> {
  const selected = new Set(enabled);
  return Object.fromEntries(
    Object.keys(DEFAULT_OVERLAYS).map((name) => [name, selected.has(name as OverlayName)]),
  ) as Record<OverlayName, boolean>;
}

/**
 * Renderer truth for a scenario: build once with every package overlay on,
 * then inspect which scene collections actually contain marks.
 */
export function overlayAvailability(
  scenario: SyntheticScenarioSource,
): Record<OverlayName, boolean> {
  const everything = Object.fromEntries(
    Object.keys(DEFAULT_OVERLAYS).map((name) => [name, true]),
  ) as Record<OverlayName, boolean>;
  const { scene } = renderSyntheticWindgram(scenario, { overlays: everything });
  const strips = new Set(scene.strips.map((strip) => strip.key));
  const fields = new Set(scene.fields.map((field) => field.key));
  const series = new Set(scene.series.map((entry) => entry.key));
  return {
    temperature: series.has("isotherm"),
    wind: scene.barbs.length > 0,
    clouds: fields.has("clouds") || strips.has("cloudCover"),
    thermalStrength: strips.has("thermalStrength"),
    stability: fields.has("stability"),
    thermalIndex: fields.has("thermalIndex"),
    windShear: fields.has("windShear"),
    buoyancyShear: strips.has("buoyancyShear"),
    dewPoint: series.has("dewPointIsoline"),
    relativeHumidity: fields.has("relativeHumidity"),
    verticalVelocity: fields.has("verticalVelocity"),
    cape: strips.has("cape"),
    gusts: scene.gusts.length > 0,
    pblHeight: series.has("modelPblTop"),
    cloudLayers: strips.has("cloudLayers"),
    smoke: strips.has("smoke"),
    pressure: strips.has("pressure"),
    precipitation: strips.has("precipitation"),
    boundaryLayerTop: series.has("boundaryLayerTop"),
    cloudBase: series.has("cloudBase"),
    usableLiftTop: series.has("usableLiftTop"),
    launch: scene.launch !== null,
    selectedHour: scene.scales.hourCount > 0,
    surfaceTemperature: scene.surfaceTemperatures.length > 0,
  };
}

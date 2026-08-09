import type { WindgramProfile } from "windgram/contract";
import { groupByLocalDay, windgramDisplayHours } from "windgram/derive";
import { buildScene, DEFAULT_OVERLAYS, type OverlayName, type SceneGraph } from "windgram/scene";
import { renderSvg } from "windgram/svg";
import rawExample from "../components/research/forecast-example.json";
import { DISPLAY_TZ } from "./time";

/* The field guide's fixed example — the Red Mountain HRRR afternoon every
   section of reading-a-windgram reads — rendered by the reference renderer
   itself. This module is shared by the figure component (build-time first
   paint) and its client script (re-render on toggle), so the two can never
   draw different charts. The JSON is validated against the package contract
   at build time in ExampleWindgram.astro; the client reuses the same object
   without shipping the schema. */
export const EXAMPLE_PROFILE = rawExample as unknown as WindgramProfile;

export const EXAMPLE_ID_PREFIX = "exwg";

/* Article-scale proportions: the figure owns the article's breakout width,
   so the columns widen and the profile panel deepens accordingly — the
   package's 44 px / 340 px defaults are sized for compact embeds. */
const COLUMN_WIDTH_PX = 96;
const PLOT_HEIGHT_PX = 450;

/* The one displayed day: the pilots' flyable-hours window, longest local
   day — the same windowing the derive/ helpers give every consumer. */
function dayHours(profile: WindgramProfile): WindgramProfile["hours"] {
  const windowed = windgramDisplayHours(profile.hours, { timeZone: DISPLAY_TZ });
  const days = groupByLocalDay(windowed, DISPLAY_TZ);
  const day = [...days].sort((left, right) => right.hours.length - left.hours.length)[0];
  return day?.hours ?? [];
}

export function renderExample(overlays: Partial<Record<OverlayName, boolean>>): {
  scene: SceneGraph;
  svg: string;
} {
  const scene = buildScene(EXAMPLE_PROFILE, {
    timeZone: DISPLAY_TZ,
    hours: dayHours(EXAMPLE_PROFILE),
    overlays,
    columnWidthPx: COLUMN_WIDTH_PX,
    plotHeightPx: PLOT_HEIGHT_PX,
  });
  return { scene, svg: renderSvg(scene, { idPrefix: EXAMPLE_ID_PREFIX }) };
}

/**
 * Which overlays draw anything for this document — renderer truth, probed
 * from a scene built with every overlay on. A switch for a field the model
 * does not publish reads as a stated absence instead of a control that
 * silently does nothing, and the statement can never drift from what the
 * chart would actually draw.
 */
export function exampleOverlayAvailability(): Record<OverlayName, boolean> {
  const everything = Object.fromEntries(
    Object.keys(DEFAULT_OVERLAYS).map((name) => [name, true]),
  ) as Record<OverlayName, boolean>;
  const { scene } = renderExample(everything);
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
    pressure: strips.has("pressure"),
    precipitation: strips.has("precipitation"),
    boundaryLayerTop: series.has("boundaryLayerTop"),
    cloudBase: series.has("cloudBase"),
    usableLiftTop: series.has("usableLiftTop"),
    launch: scene.launch !== null,
    selectedHour: scene.scales.hourCount > 0,
  };
}

import { WINDGRAM_STABILITY_CLASSES } from "../derive/stability.js";
import type { FieldLayer, SceneGraph, SeriesElement } from "./types.js";

/* The key: a windgram is not readable without one — the chart encodes
   meaning in line STYLE, and nothing on the plot says which is which.
   buildKeySpec derives a typed, serializable description of what THIS
   scene's key must say from what the scene actually drew, so every fact
   a key states (dash patterns, stroke widths, class names, stability
   boundaries) is inherited, never copied. Consumers render it with
   svg/renderKeySvg, or read the spec and draw their own — the spec is
   the interaction surface for focusable keys (hover-to-preview,
   click-to-pin), which need the data, not a flattened picture. */

/** One series line in the key, carrying the REAL style facts. */
export interface KeySeriesEntry {
  /** Same identity as the scene.series entries it describes. */
  key: SeriesElement["key"];
  /**
   * Label-override id: the entry's most specific class token
   * ("wg-series-usable", "wg-isotherm-freezing").
   */
  id: string;
  /** Reference prose; override via KeySpecOptions.labels[id]. */
  label: string;
  /** The series' own class — tokens theme the key exactly as the chart. */
  className: string;
  /** The real dash, inherited from the scene, never restated. */
  dash: string | null;
  strokeWidth: number;
}

/**
 * One field overlay's colour ramp — the classed patches the plot shades
 * with. `classes` are the classes the scene actually drew, in the key's
 * weak-to-strong reading order: the chips' REAL identities, so an SVG key
 * inherits fill and opacity from the same rules that painted the chart,
 * and an HTML legend reads the same facts from svg/'s
 * `FIELD_STYLE_DEFAULTS` instead of restating tokens and opacities.
 */
export interface KeyRampEntry {
  key: FieldLayer["key"];
  /** Label-override id ("ramp-thermalIndex"). */
  id: string;
  /** Reference prose, direction included ("Thermal index, weak → strong"). */
  label: string;
  classes: ReadonlyArray<string>;
}

export interface KeyStabilityClass {
  className: string;
  /** Upper bound of the class in °C per 1000 ft (from derive/'s table). */
  maxLapse: number;
  /** Plain words — each cell's tooltip / accessible name. */
  label: string;
}

/** A group word printed across `span` adjacent stability cells. */
export interface KeyStabilityGroup {
  id: string;
  label: string;
  span: number;
}

export interface KeySpec {
  /**
   * Keyed lines in the reference reading order — usable lift first (the
   * line a pilot came to read), then cloud base, the boundary layers,
   * and the emphasized 0 °C isotherm. Lines that label themselves on the
   * plot (the 10°/20° isotherms, the Td isolines) stay out of the key.
   */
  series: ReadonlyArray<KeySeriesEntry>;
  /**
   * Field-overlay ramps for what this scene shaded, in the reference
   * order (thermal index, shear, humidity, vertical motion). The clouds
   * field stays out: its dense class speaks through the hatch chip, and
   * the stability field has its own bar below.
   */
  ramps: ReadonlyArray<KeyRampEntry>;
  /** The condensation hatch chip; null when the clouds overlay drew none. */
  hatch: { id: string; label: string } | null;
  /** The eight-class lapse ramp; null when the stability field is absent. */
  stability: {
    title: string;
    classes: ReadonlyArray<KeyStabilityClass>;
    groups: ReadonlyArray<KeyStabilityGroup>;
  } | null;
  /** The p25-p75 envelope note; null unless some series carries a band. */
  band: { id: string; label: string } | null;
  /**
   * The smoke-haze chip — the column tint whose opacity is optical
   * depth; null when the scene drew no smoke cells. The strip's line
   * labels itself ("Smoke µg/m³") like every strip, so only the tint
   * needs the key.
   */
  smokeHaze: { id: string; label: string } | null;
  /**
   * The smoke-adjusted view's label, carrying the smoke model and run
   * that derated the drawn w* and lift — present exactly when the scene
   * IS the adjusted view (SceneGraph.smokeAdjustment). Rendering this
   * note is how a reference-key consumer satisfies the must-label rule.
   */
  smokeAdjusted: { id: string; label: string } | null;
}

export interface KeySpecOptions {
  /**
   * Prose overrides keyed by entry id — series class tokens
   * ("wg-series-usable"), "ramp-<field>" for the overlay ramps,
   * "wg-cloud-dense" for the hatch, "band" for the
   * envelope, "stability-title" for the bar's row title,
   * "wg-stab-<class>" for stability cell names and "stab-group-<name>"
   * for the group words. The reference words are the defaults; the style
   * facts are not overridable, they are the scene's.
   */
  labels?: Readonly<Record<string, string>>;
  /**
   * Line families that label themselves on the plot ("Td 0°", "10°") stay
   * out of the key by default; a consumer whose look keys them anyway —
   * the first integration keys its always-on dew-point lines — opts a
   * family in here and receives the entry with its REAL style facts
   * (ids "wg-dewpoint-isoline" / "wg-isotherm") instead of restating dash
   * and width. Families the scene did not draw stay out either way.
   */
  selfLabeled?: ReadonlyArray<"dewPointIsoline" | "isotherm">;
}

/* The reference reading order and prose — the only place key words live;
   every style fact is inherited from the scene. Order is a reference-look
   decision, not scene build order: lift first. */
const KEY_SERIES_ORDER: ReadonlyArray<{ id: string; label: string }> = [
  { id: "wg-series-usable", label: "Usable lift" },
  { id: "wg-series-cloud-base", label: "Cloud base" },
  { id: "wg-series-boundary", label: "Boundary layer" },
  { id: "wg-series-pbl", label: "Model boundary layer" },
  { id: "wg-isotherm-freezing", label: "0 °C" },
];

/* Self-labeling families a consumer can opt in (KeySpecOptions.selfLabeled),
   appended after the keyed lines. Ids are the families' real class tokens;
   dash and width still arrive from the drawn series. */
const SELF_LABELED_ORDER: ReadonlyArray<{
  key: "dewPointIsoline" | "isotherm";
  id: string;
  label: string;
}> = [
  { key: "dewPointIsoline", id: "wg-dewpoint-isoline", label: "Dew point" },
  { key: "isotherm", id: "wg-isotherm", label: "Isotherms" },
];

/* Ramp reading order and prose — like KEY_SERIES_ORDER, a reference-look
   decision (weak first, the direction the words state); the classes
   themselves arrive from what the scene drew. */
const KEY_RAMP_ORDER: ReadonlyArray<{
  key: KeyRampEntry["key"];
  label: string;
  classOrder: ReadonlyArray<string>;
}> = [
  {
    key: "thermalIndex",
    label: "Thermal index, weak → strong",
    classOrder: ["wg-ti-weak", "wg-ti-fair", "wg-ti-good", "wg-ti-strong"],
  },
  {
    key: "windShear",
    label: "Wind shear, light → strong",
    classOrder: ["wg-shear-light", "wg-shear-moderate", "wg-shear-strong"],
  },
  {
    key: "relativeHumidity",
    label: "Humidity, 60 → 95%",
    classOrder: ["wg-rh-60", "wg-rh-80", "wg-rh-95"],
  },
  {
    key: "verticalVelocity",
    label: "Vertical motion, sink → lift",
    classOrder: ["wg-omega-sink-strong", "wg-omega-sink", "wg-omega-lift", "wg-omega-lift-strong"],
  },
];

/* Group words over the eight classes, most unstable first: 2 + 3 + 1 + 2. */
const STABILITY_GROUPS: ReadonlyArray<KeyStabilityGroup> = [
  { id: "stab-group-unstable", label: "Unstable", span: 2 },
  { id: "stab-group-conditional", label: "Conditional instability", span: 3 },
  { id: "stab-group-stable", label: "Stable", span: 1 },
  { id: "stab-group-inverted", label: "Inverted", span: 2 },
];

function lastClassToken(className: string): string {
  const tokens = className.trim().split(/\s+/);
  return tokens[tokens.length - 1];
}

/* "very-unstable" -> "Very unstable": the cell's plain-words name. */
function plainWords(className: string): string {
  const words = className.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Derives the key facts for exactly what `scene` drew. */
export function buildKeySpec(scene: SceneGraph, options: KeySpecOptions = {}): KeySpec {
  const labels = options.labels ?? {};
  const drawn = new Map<string, SeriesElement>();
  for (const entry of scene.series) {
    const id = lastClassToken(entry.className);
    if (!drawn.has(id)) drawn.set(id, entry);
  }
  const series: KeySeriesEntry[] = [];
  for (const { id, label } of KEY_SERIES_ORDER) {
    const entry = drawn.get(id);
    if (!entry) continue;
    series.push({
      key: entry.key,
      id,
      label: labels[id] ?? label,
      className: entry.className,
      dash: entry.dash,
      strokeWidth: entry.strokeWidth,
    });
  }
  for (const { key, id, label } of SELF_LABELED_ORDER) {
    if (!options.selfLabeled?.includes(key)) continue;
    const entry = drawn.get(id);
    if (!entry) continue;
    series.push({
      key: entry.key,
      id,
      label: labels[id] ?? label,
      className: entry.className,
      dash: entry.dash,
      strokeWidth: entry.strokeWidth,
    });
  }

  const ramps: KeyRampEntry[] = [];
  for (const { key, label, classOrder } of KEY_RAMP_ORDER) {
    const drawnClasses = new Set(
      scene.fields
        .filter((field) => field.key === key)
        .flatMap((field) => field.paths.map((path) => path.className)),
    );
    const classes = classOrder.filter((className) => drawnClasses.has(className));
    if (classes.length === 0) continue;
    const id = `ramp-${key}`;
    ramps.push({ key, id, label: labels[id] ?? label, classes });
  }

  const hasDenseCloud = scene.fields.some(
    (field) =>
      field.key === "clouds" &&
      field.paths.some((path) => path.className === "wg-cloud-dense"),
  );
  const hasStability = scene.fields.some((field) => field.key === "stability");
  const hasBand = scene.series.some((entry) => entry.bandPath !== null);
  const hasSmokeHaze = scene.strips.some(
    (strip) => strip.key === "smoke" && (strip.cells ?? []).some((cell) => cell !== null),
  );

  return {
    series,
    ramps,
    hatch: hasDenseCloud
      ? { id: "wg-cloud-dense", label: labels["wg-cloud-dense"] ?? "Condensation" }
      : null,
    stability: hasStability
      ? {
          title: labels["stability-title"] ?? "LAPSE RATE",
          classes: WINDGRAM_STABILITY_CLASSES.map((entry) => ({
            className: entry.className,
            maxLapse: entry.maxLapse,
            label: labels[`wg-stab-${entry.className}`] ?? plainWords(entry.className),
          })),
          groups: STABILITY_GROUPS.map((group) => ({
            ...group,
            label: labels[group.id] ?? group.label,
          })),
        }
      : null,
    band: hasBand
      ? { id: "band", label: labels["band"] ?? "p25–p75 ensemble spread" }
      : null,
    smokeHaze: hasSmokeHaze
      ? {
          id: "wg-smoke-cell",
          label: labels["wg-smoke-cell"] ?? "Smoke haze — tint deepens with optical depth",
        }
      : null,
    smokeAdjusted: scene.smokeAdjustment
      ? {
          id: "smoke-adjusted",
          label:
            labels["smoke-adjusted"] ??
            `Smoke-adjusted w* and lift — ${scene.smokeAdjustment.smokeModel} ${scene.smokeAdjustment.smokeRun}`,
        }
      : null,
  };
}

import { WINDGRAM_STABILITY_CLASSES } from "../derive/stability.js";
import type { SceneGraph, SeriesElement } from "./types.js";

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
}

export interface KeySpecOptions {
  /**
   * Prose overrides keyed by entry id — series class tokens
   * ("wg-series-usable"), "wg-cloud-dense" for the hatch, "band" for the
   * envelope, "stability-title" for the bar's row title,
   * "wg-stab-<class>" for stability cell names and "stab-group-<name>"
   * for the group words. The reference words are the defaults; the style
   * facts are not overridable, they are the scene's.
   */
  labels?: Readonly<Record<string, string>>;
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

  const hasDenseCloud = scene.fields.some(
    (field) =>
      field.key === "clouds" &&
      field.paths.some((path) => path.className === "wg-cloud-dense"),
  );
  const hasStability = scene.fields.some((field) => field.key === "stability");
  const hasBand = scene.series.some((entry) => entry.bandPath !== null);

  return {
    series,
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
  };
}

import type { BarbPlacement, SceneGraph } from "../scene/types.js";
import type { KeySpec } from "../scene/key.js";
import { short } from "../scene/path.js";

/* svg/ — the reference serializer: scene -> self-contained SVG string.
   Styling is class-name-driven; every colour lives in the stylesheet as a
   CSS custom property with a default matching the site's theme.css (the
   current gold-standard look), so consumers theme by overriding --wg-*
   tokens without forking the renderer. Output is deterministic: stable
   element ordering, two-decimal rounding, no generated ids beyond the
   configurable prefix. */

const METRIC_TOP = 20;

export interface RenderSvgOptions {
  /**
   * Stylesheet embedded in a <style> block. Defaults to DEFAULT_STYLESHEET;
   * pass null to omit it and style the classes from an external sheet.
   */
  stylesheet?: string | null;
  /**
   * Prefix for generated element ids (the cloud-hatch pattern). Give each
   * windgram on a page its own prefix so pattern ids cannot collide.
   * Default "wg" — what DEFAULT_STYLESHEET's url() reference expects.
   */
  idPrefix?: string;
}

/**
 * The default stability ramp — the ONE home for these eight hexes; the
 * stylesheet fallbacks below and any consumer legend derive from this
 * export instead of restating hex values. Keys are the `wg-stab-*`
 * class/token suffixes in threshold order (most unstable first).
 *
 * The field is BACKGROUND, and the ramp is designed for that layer's job:
 * the whole ramp lives in a pale register so the content drawn over it —
 * series lines, barbs, markers, labels, the actual flight decision —
 * keeps figure-ground contrast for every reader. Salience is relative:
 * with the field quiet, the warm unstable classes are the loudest thing
 * on the chart without spending ink mass. Hues follow the aerogram
 * convention this renderer descends from (warm = unstable, pink/lavender
 * = conditional, tan pivot, blue = stable, greys = inverted); an earlier
 * default that ordered the whole ramp by monotone lightness optimized
 * the wrong layer — it bought class-boundary ΔE with the figure-ground
 * contrast of everything drawn on top.
 *
 * What the pale register can and cannot promise, measured with the
 * dataviz palette validator (OKLab, Machado 2009 CVD simulation) against
 * the default surface #fffdf8: every adjacent pair clears the 6.0 CVD
 * floor on every axis (worst 7.0 deutan, 6.8 tritan); global
 * grayscale ordering is NOT achievable in ~30 L* points across eight
 * classes and is not claimed — class identity rides hue plus the
 * chart's non-colour channels (the key's plain-words cells, cursor
 * readouts, spatial structure); the cool tail is internally light-
 * ordered (stable → inverted → strong-inversion); palest cells sit
 * near 2:1 against the surface — receding toward the page is the
 * design, not an accident. Restyle via the --wg-stab-* tokens.
 */
export const STABILITY_TOKEN_DEFAULTS = {
  "very-unstable": "#d95f52",
  unstable: "#de8f3a",
  "conditional-strong": "#c67eb6",
  conditional: "#aeaad9",
  "near-neutral": "#d7b29b",
  stable: "#768bb9",
  inverted: "#9aa19d",
  "strong-inversion": "#b3b9b6",
} as const;

const STABILITY_RULES = Object.entries(STABILITY_TOKEN_DEFAULTS)
  .map(([name, hex]) => `.wg-stab-${name} { fill: var(--wg-stab-${name}, ${hex}); }`)
  .join("\n");

/**
 * Default values for every non-stability `--wg-*` token DEFAULT_STYLESHEET
 * declares — the ONE home for these values, exactly like
 * STABILITY_TOKEN_DEFAULTS is for the eight-class ramp. Keys are the token
 * suffixes (`--wg-<key>`); the stylesheet's `var()` fallbacks derive from
 * this map, and a consumer building a legend, chip, or swatch reads the
 * same entry instead of restating a hex.
 *
 * The values are the reference theme's — the colours actually rendered
 * today. Note `cloud-marker`: the cloud glyph drawn at cloud base FILLS
 * with this cream (the reference look — a cloud is pale, not ink-dark)
 * while its outline keeps the `cloud-base` hue of the line it marks.
 *
 * `text-*` entries are the type scale: every font size the serializer
 * sets, as `--wg-text-<role>` tokens, so a page-scale consumer retypes
 * the chart without forking the renderer. Weights stay in the rules.
 *
 * The halo tokens are per-element. `--wg-halo-marker` and
 * `--wg-halo-text` fall back to the shared `--wg-halo` (paper, so glyphs
 * and labels punch out of the field). `--wg-halo-series` defaults
 * `transparent`: series lines are bare ink — a halo repeated dash-by-dash
 * reads as fuzz, the production verdict from the first consumer port.
 * `--wg-halo-barb` defaults to the old barb slate: the barbs themselves
 * are white (`wind`), the convention that survived every saturated field
 * the reference ramp lost slate barbs on, and the fine dark rim is what
 * keeps a white glyph legible on a chart with no field to sit on (models
 * without levels draw barbs straight on the paper). Set it `transparent`
 * for the bare-white club look, or any colour to re-halo an element.
 */
export const TOKEN_DEFAULTS = {
  font: '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif',
  "font-mono": '"IBM Plex Mono", ui-monospace, monospace',
  "text-strip-name": "10.5px",
  "text-strip-unit": "9.5px",
  "text-strip-scale": "8px",
  "text-row-tag": "7.5px",
  "text-tick": "10.5px",
  "text-hour-tick": "11px",
  "text-gust": "9.5px",
  "text-series-label": "10.5px",
  "text-launch": "10.5px",
  "text-surface-temp": "9.5px",
  "text-key-title": "9px",
  "text-key-boundary": "8px",
  "text-key-group": "8px",
  // The stability-bar group words: white with a dark halo so they hold
  // on the lighter cells (the ramp's light end is ~2:1 on the surface).
  "key-group-ink": "#ffffff",
  "key-group-halo": "#00000066",
  surface: "#fffdf8",
  "strip-bg": "#f2f4f1",
  rule: "#776956",
  ink: "#152529",
  "ink-soft": "#2f454a",
  "ink-mute": "#40565a",
  halo: "#fffdf8",
  "halo-series": "transparent",
  "halo-barb": "#355963",
  accent: "#913b0c",
  // The surface-temperature row's ink: its own slot (theme it apart from
  // the highlight), shipping at the accent's warm default.
  temp: "#913b0c",
  pressure: "#963f36",
  rain: "#207a83",
  cloud: "#5b6969",
  lift: "#9a7500",
  bs: "#6d597a",
  cape: "#8a4a08",
  "cape-calm": "#dde3d5",
  "cape-watch": "#e7c46c",
  "cape-risk": "#d98243",
  "cape-severe": "#c04f3a",
  gust: "#355963",
  pbl: "#56609b",
  "ti-weak": "#f4e3c0",
  "ti-fair": "#ecc57e",
  "ti-good": "#de9b4e",
  "ti-strong": "#c96a33",
  "shear-light": "#cfc3de",
  "shear-moderate": "#a58ec4",
  "shear-strong": "#7b5ea7",
  "rh-60": "#d3e0e3",
  "rh-80": "#a9c7cf",
  "rh-95": "#7fadbb",
  "omega-lift": "#8dc2a0",
  "omega-lift-strong": "#56a377",
  "omega-sink": "#d3a68f",
  "omega-sink-strong": "#bd7d5c",
  boundary: "#a46b10",
  "cloud-base": "#355963",
  "cloud-marker": "#f8f3d8",
  usable: "#2179ad",
  freezing: "#2b748f",
  dewpoint: "#3a7d4f",
  // White barbs, rimmed by halo-barb: legible on every field cell and on
  // bare paper alike (see the halo notes above).
  wind: "#ffffff",
} as const;

/** `var(--wg-<name>, <default>)` with the fallback read from TOKEN_DEFAULTS. */
function v(name: keyof typeof TOKEN_DEFAULTS): string {
  return `var(--wg-${name}, ${TOKEN_DEFAULTS[name]})`;
}

/** Per-element halo slot falling back to the shared `--wg-halo` (marker
 * and text only; series and barb halos have their own TOKEN_DEFAULTS
 * entries — transparent and the barb rim slate respectively). */
function haloVar(element: "marker" | "text"): string {
  return `var(--wg-halo-${element}, ${v("halo")})`;
}

/* The default look. Token defaults are the site's theme.css values — the
   colours actually rendered today — not the older fallback constants that
   had drifted inside the site's chart.ts. Every fallback derives from
   TOKEN_DEFAULTS / STABILITY_TOKEN_DEFAULTS above; no hex lives only here. */
export const DEFAULT_STYLESHEET = `
.wg text { font-family: ${v("font")}; }
.wg .wg-mono { font-family: ${v("font-mono")}; }
.wg-frame { fill: ${v("surface")}; stroke: ${v("rule")}; }
.wg-strip-frame { fill: ${v("strip-bg")}; stroke: ${v("rule")}; }
.wg-gridline { stroke: ${v("rule")}; }
.wg-hourline { stroke: ${v("ink")}; }
.wg-text { fill: ${v("ink")}; }
.wg-text-soft { fill: ${v("ink-soft")}; }
.wg-text-mute { fill: ${v("ink-mute")}; }
.wg-strip-name { fill: ${v("ink")}; font-size: ${v("text-strip-name")}; font-weight: 700; }
.wg-strip-unit { fill: ${v("ink-mute")}; font-size: ${v("text-strip-unit")}; }
.wg-strip-scale { fill: ${v("ink-mute")}; font-size: ${v("text-strip-scale")}; }
.wg-tick { fill: ${v("ink-mute")}; font-size: ${v("text-tick")}; }
.wg-hour-tick { fill: ${v("ink-mute")}; font-size: ${v("text-hour-tick")}; }
.wg-series-label { font-size: ${v("text-series-label")}; font-weight: 700; }
.wg-launch-label { fill: ${v("ink")}; font-size: ${v("text-launch")}; font-weight: 600; }
.wg-surface-temp { fill: ${v("temp")}; font-size: ${v("text-surface-temp")}; font-weight: 700; }
.wg-haloed-text { stroke: ${haloVar("text")}; paint-order: stroke; }
.wg-halo { stroke: ${v("halo-series")}; }
.wg-selected-column { fill: ${v("accent")}; opacity: 0.05; }
.wg-selected-line { stroke: ${v("accent")}; }
.wg-launch-line { stroke: ${v("ink")}; }
.wg-strip-pressure { stroke: ${v("pressure")}; }
.wg-strip-pressure-area, .wg-strip-pressure-band { fill: ${v("pressure")}; }
.wg-strip-precipitation { stroke: ${v("rain")}; }
.wg-strip-precipitation-area, .wg-strip-precipitation-band { fill: ${v("rain")}; }
.wg-strip-cloudCover { stroke: ${v("cloud")}; }
.wg-strip-cloudCover-area, .wg-strip-cloudCover-band { fill: ${v("cloud")}; }
.wg-strip-thermalStrength { stroke: ${v("lift")}; }
.wg-strip-thermalStrength-area, .wg-strip-thermalStrength-band { fill: ${v("lift")}; }
.wg-strip-buoyancyShear { stroke: ${v("bs")}; }
.wg-strip-buoyancyShear-area, .wg-strip-buoyancyShear-band { fill: ${v("bs")}; }
.wg-strip-cape { stroke: ${v("cape")}; }
.wg-strip-cape-area, .wg-strip-cape-band { fill: ${v("cape")}; }
.wg-cape-calm { fill: ${v("cape-calm")}; opacity: 0.6; }
.wg-cape-watch { fill: ${v("cape-watch")}; opacity: 0.6; }
.wg-cape-risk { fill: ${v("cape-risk")}; opacity: 0.6; }
.wg-cape-severe { fill: ${v("cape-severe")}; opacity: 0.6; }
.wg-cape-capped { opacity: 0.28; }
.wg-bs-unopposed { fill: ${v("bs")}; opacity: 0.18; }
.wg-cloud-cell { fill: ${v("cloud")}; }
.wg-strip-row-label { fill: ${v("ink-mute")}; font-size: ${v("text-row-tag")}; }
.wg-gust { fill: ${v("gust")}; font-size: ${v("text-gust")}; font-weight: 700; }
.wg-series-pbl { stroke: ${v("pbl")}; }
.wg-series-pbl-band { fill: ${v("pbl")}; opacity: 0.16; }
${STABILITY_RULES}
.wg-cloud-hatch-line { stroke: ${v("ink-soft")}; }
.wg-cloud-medium { fill: ${v("cloud")}; opacity: 0.22; }
.wg-cloud-light { fill: ${v("cloud")}; opacity: 0.1; }
.wg-ti-weak { fill: ${v("ti-weak")}; opacity: 0.55; }
.wg-ti-fair { fill: ${v("ti-fair")}; opacity: 0.55; }
.wg-ti-good { fill: ${v("ti-good")}; opacity: 0.55; }
.wg-ti-strong { fill: ${v("ti-strong")}; opacity: 0.55; }
.wg-shear-light { fill: ${v("shear-light")}; opacity: 0.5; }
.wg-shear-moderate { fill: ${v("shear-moderate")}; opacity: 0.5; }
.wg-shear-strong { fill: ${v("shear-strong")}; opacity: 0.5; }
.wg-rh-60 { fill: ${v("rh-60")}; opacity: 0.5; }
.wg-rh-80 { fill: ${v("rh-80")}; opacity: 0.5; }
.wg-rh-95 { fill: ${v("rh-95")}; opacity: 0.5; }
.wg-omega-lift { fill: ${v("omega-lift")}; opacity: 0.4; }
.wg-omega-lift-strong { fill: ${v("omega-lift-strong")}; opacity: 0.5; }
.wg-omega-sink { fill: ${v("omega-sink")}; opacity: 0.4; }
.wg-omega-sink-strong { fill: ${v("omega-sink-strong")}; opacity: 0.5; }
.wg-series-boundary { stroke: ${v("boundary")}; }
.wg-series-boundary-band { fill: ${v("boundary")}; opacity: 0.16; }
.wg-series-cloud-base { stroke: ${v("cloud-base")}; }
.wg-series-cloud-base-band { fill: ${v("cloud-base")}; opacity: 0.16; }
.wg-series-usable { stroke: ${v("usable")}; }
.wg-series-usable-band { fill: ${v("usable")}; opacity: 0.16; }
.wg-isotherm { stroke: ${v("ink")}; }
.wg-isotherm-freezing { stroke: ${v("freezing")}; }
.wg-isotherm-label { fill: ${v("ink")}; }
.wg-isotherm-label-freezing { fill: ${v("freezing")}; }
.wg-dewpoint-isoline { stroke: ${v("dewpoint")}; }
.wg-dewpoint-label { fill: ${v("dewpoint")}; }
.wg-barb { stroke: ${v("wind")}; }
.wg-barb-fill { fill: ${v("wind")}; stroke: ${v("wind")}; }
.wg-barb-halo { stroke: ${v("halo-barb")}; }
.wg-barb-fill-halo { fill: ${v("halo-barb")}; stroke: ${v("halo-barb")}; }
.wg-marker-wing { fill: ${v("usable")}; stroke: ${v("usable")}; }
.wg-marker-cloud { fill: ${v("cloud-marker")}; stroke: ${v("cloud-base")}; }
.wg-marker-halo { fill: ${haloVar("marker")}; stroke: ${haloVar("marker")}; }
.wg-key-label { fill: ${v("ink-mute")}; font-size: ${v("text-tick")}; }
.wg-key-title { fill: ${v("ink")}; font-size: ${v("text-key-title")}; font-weight: 700; letter-spacing: 0.08em; }
.wg-key-boundary { fill: ${v("ink-mute")}; font-size: ${v("text-key-boundary")}; }
.wg-key-group { fill: ${v("key-group-ink")}; stroke: ${v("key-group-halo")}; paint-order: stroke; font-size: ${v("text-key-group")}; font-weight: 700; }
.wg-key-band { fill: ${v("ink-mute")}; opacity: 0.16; }
.wg-key-frame { fill: none; stroke: ${v("rule")}; }
`.trim();

type AttrValue = string | number;

function el(tag: string, attrs: Record<string, AttrValue>, children?: string): string {
  const rendered = Object.entries(attrs)
    .map(([name, value]) => ` ${name}="${escapeXml(String(value))}"`)
    .join("");
  if (children === undefined) return `<${tag}${rendered}/>`;
  return `<${tag}${rendered}>${children}</${tag}>`;
}

function text(attrs: Record<string, AttrValue>, content: string): string {
  return el("text", attrs, escapeXml(content));
}

/* One decimal at most, trailing zero dropped: "101.3", "101", "0.5",
   "2.6" — enough to read a strip's scale without crowding the gutter. */
function stripScaleLabel(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderBarb(barb: BarbPlacement): string {
  if (barb.calm) {
    const shared = { cx: short(barb.x), cy: short(barb.y), r: short(3.6 * barb.scale), fill: "none" };
    return [
      el("circle", { ...shared, class: "wg-barb-halo", "stroke-width": 2.4 }),
      el("circle", { ...shared, class: "wg-barb", "stroke-width": 1.1 }),
    ].join("");
  }
  const parts: string[] = [];
  parts.push(
    el("path", {
      d: barb.shaftPath,
      class: "wg-barb-halo",
      "stroke-width": 2.6,
      fill: "none",
      "stroke-linecap": "round",
    }),
  );
  for (const pennant of barb.pennantPaths) {
    parts.push(el("path", { d: pennant, class: "wg-barb-fill-halo", "stroke-width": 1 }));
  }
  parts.push(
    el("path", {
      d: barb.shaftPath,
      class: "wg-barb",
      "stroke-width": 1.3,
      fill: "none",
      "stroke-linecap": "round",
    }),
  );
  for (const pennant of barb.pennantPaths) {
    parts.push(el("path", { d: pennant, class: "wg-barb-fill", "stroke-width": 1 }));
  }
  return el(
    "g",
    {
      transform: `translate(${short(barb.x)} ${short(barb.y)}) rotate(${short(barb.directionDeg)}) scale(${barb.scale})`,
    },
    parts.join(""),
  );
}

/** Serializes a scene graph to a self-contained SVG document string. */
export function renderSvg(scene: SceneGraph, options: RenderSvgOptions = {}): string {
  const idPrefix = options.idPrefix ?? "wg";
  const stylesheet = options.stylesheet === undefined ? DEFAULT_STYLESHEET : options.stylesheet;
  const { plotLeft, plotTop, plotWidth, plotHeight, columnWidth } = scene.scales;
  const plotBottom = plotTop + plotHeight;
  const body: string[] = [];

  if (stylesheet) body.push(el("style", {}, `\n${stylesheet}\n`));

  const hatchId = `${idPrefix}-cloud-hatch`;
  body.push(
    el(
      "defs",
      {},
      el(
        "pattern",
        { id: hatchId, width: 7, height: 7, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
        el("line", { x1: 0, y1: 0, x2: 0, y2: 7, class: "wg-cloud-hatch-line", "stroke-width": 1.2 }),
      ),
    ),
  );

  /* ----- surface metric strips ----- */
  for (const strip of scene.strips) {
    body.push(
      el("rect", {
        x: plotLeft,
        y: strip.top,
        width: plotWidth,
        height: strip.height,
        class: "wg-strip-frame",
        "stroke-width": 0.7,
      }),
      el("line", {
        x1: plotLeft,
        y1: short(strip.top + strip.height / 2),
        x2: plotLeft + plotWidth,
        y2: short(strip.top + strip.height / 2),
        class: "wg-gridline",
        "stroke-width": 0.6,
        "stroke-dasharray": "2 4",
        opacity: 0.45,
      }),
    );
    // Classed hour cells (CAPE risk classes) sit under band, area and line.
    for (const cell of strip.cells ?? []) {
      if (!cell) continue;
      body.push(
        el("rect", {
          x: short(cell.x),
          y: strip.top,
          width: short(cell.width),
          height: strip.height,
          class: cell.className,
        }),
      );
    }
    // Stacked sub-rows (cloud layers): opacity-graded cells plus a
    // one-letter row tag at the strip's right edge.
    for (const row of strip.rows ?? []) {
      for (const cell of row.cells) {
        if (!cell) continue;
        const attrs: Record<string, AttrValue> = {
          x: short(cell.x),
          y: short(row.top),
          width: short(cell.width),
          height: short(row.height),
          class: cell.className,
        };
        if (cell.opacity !== undefined) attrs["opacity"] = short(cell.opacity);
        body.push(el("rect", attrs));
      }
      body.push(
        text(
          {
            x: plotLeft + plotWidth + 8,
            y: short(row.top + row.height / 2 + 2.5),
            class: "wg-strip-row-label wg-mono",
          },
          row.label,
        ),
      );
    }
    if (strip.bandPath) {
      body.push(el("path", { d: strip.bandPath, class: `${strip.className}-band` }));
    }
    if (strip.areaPath) {
      body.push(el("path", { d: strip.areaPath, class: `${strip.className}-area`, opacity: 0.3 }));
    }
    if (strip.linePath) {
      body.push(
        el("path", {
          d: strip.linePath,
          class: strip.className,
          fill: "none",
          "stroke-width": 1.7,
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
        }),
      );
    }
    body.push(
      text(
        {
          x: plotLeft - 8,
          y: strip.top + 11,
          "text-anchor": "end",
          class: "wg-strip-name",
        },
        strip.label,
      ),
      text(
        { x: plotLeft - 8, y: strip.top + 22, "text-anchor": "end", class: "wg-strip-unit" },
        strip.unit,
      ),
    );
    // The strip's scale, at its right edge: maximum up top, minimum at the
    // bottom — without them the strips read as shapes, not numbers. Row
    // strips (cloud layers) put their tags there instead and have no line
    // to scale.
    if (!strip.rows) {
      body.push(
        text(
          { x: plotLeft + plotWidth + 8, y: strip.top + 8, class: "wg-strip-scale wg-mono" },
          stripScaleLabel(strip.maximum),
        ),
        text(
          {
            x: plotLeft + plotWidth + 8,
            y: strip.top + strip.height,
            class: "wg-strip-scale wg-mono",
          },
          stripScaleLabel(strip.minimum),
        ),
      );
    }
  }

  /* ----- plot frame, fields, selected column ----- */
  body.push(
    el("rect", { x: plotLeft, y: plotTop, width: plotWidth, height: plotHeight, class: "wg-frame" }),
  );
  for (const layer of scene.fields) {
    for (const { className, path } of layer.paths) {
      // Field paths are iso-band outlines: the region between two
      // thresholds is the pair of threshold outlines under even-odd fill.
      const attrs: Record<string, AttrValue> = {
        d: path,
        class: className,
        "fill-rule": "evenodd",
      };
      // The dense-cloud class fills with the hatch pattern; the pattern id
      // is prefix-dependent, so it rides as an attribute, not in the sheet.
      if (className === "wg-cloud-dense") attrs["fill"] = `url(#${hatchId})`;
      body.push(el("path", attrs));
    }
  }
  if (scene.scales.hourCount > 0 && scene.highlightSelectedHour) {
    const selectedLeft = plotLeft + scene.selectedHourIndex * columnWidth;
    const selectedCenter = short(selectedLeft + columnWidth / 2);
    body.push(
      el("rect", {
        x: short(selectedLeft),
        y: METRIC_TOP,
        width: columnWidth,
        height: plotBottom - METRIC_TOP,
        class: "wg-selected-column",
      }),
      el("line", {
        x1: selectedCenter,
        x2: selectedCenter,
        y1: METRIC_TOP,
        y2: plotBottom,
        class: "wg-selected-line",
        "stroke-width": 1,
        "stroke-dasharray": "3 4",
      }),
    );
  }

  /* ----- axes ----- */
  for (const tick of scene.axes.altitude) {
    body.push(
      el("line", {
        x1: plotLeft,
        y1: short(tick.y),
        x2: plotLeft + plotWidth,
        y2: short(tick.y),
        class: "wg-gridline",
        "stroke-width": 1,
      }),
      text(
        { x: plotLeft - 8, y: short(tick.y + 3), "text-anchor": "end", class: "wg-tick" },
        tick.labelMetres,
      ),
      text(
        { x: plotLeft + plotWidth + 8, y: short(tick.y + 3), class: "wg-tick" },
        tick.labelFeet,
      ),
    );
  }
  for (const tick of scene.axes.hours) {
    if (tick.gridline) {
      body.push(
        el("line", {
          x1: short(tick.x),
          x2: short(tick.x),
          y1: plotTop,
          y2: plotBottom,
          class: "wg-hourline",
          "stroke-width": 0.6,
          opacity: 0.15,
        }),
      );
    }
    body.push(
      text(
        {
          x: short(tick.x),
          y: plotBottom + 18,
          "text-anchor": "middle",
          class: "wg-hour-tick wg-mono",
        },
        tick.label,
      ),
    );
  }
  for (const mark of scene.surfaceTemperatures) {
    body.push(
      text(
        { x: short(mark.x), y: short(mark.y), "text-anchor": "middle", class: "wg-surface-temp wg-mono" },
        mark.label,
      ),
    );
  }

  /* ----- launch line ----- */
  if (scene.launch) {
    body.push(
      el("line", {
        x1: plotLeft,
        x2: plotLeft + plotWidth,
        y1: short(scene.launch.y),
        y2: short(scene.launch.y),
        class: "wg-launch-line",
        "stroke-width": 1,
        "stroke-dasharray": "2 4",
        opacity: 0.68,
      }),
      text(
        {
          x: plotLeft + 7,
          y: short(scene.launch.y - 6),
          class: "wg-launch-label wg-haloed-text",
          "stroke-width": 2.5,
        },
        scene.launch.label,
      ),
    );
  }

  /* ----- series: all ensemble bands first (they sit under every line) ----- */
  for (const entry of scene.series) {
    if (entry.bandPath) {
      body.push(el("path", { d: entry.bandPath, class: `${entry.className.split(" ")[0]}-band` }));
    }
  }
  for (const entry of scene.series) {
    if (!entry.path) continue;
    const halo: Record<string, AttrValue> = {
      d: entry.path,
      class: "wg-halo",
      fill: "none",
      "stroke-width": short(entry.strokeWidth + 1.8),
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    };
    const main: Record<string, AttrValue> = {
      d: entry.path,
      class: entry.className,
      fill: "none",
      "stroke-width": entry.strokeWidth,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    };
    if (entry.dash) {
      halo["stroke-dasharray"] = entry.dash;
      main["stroke-dasharray"] = entry.dash;
    }
    body.push(el("path", halo), el("path", main));
  }

  /* ----- markers, barbs, labels ----- */
  for (const marker of scene.markers) {
    body.push(
      el(
        "g",
        { transform: `translate(${short(marker.x)} ${short(marker.y)})` },
        el("path", { d: marker.path, class: "wg-marker-halo", "stroke-width": 2.4 }) +
          el("path", {
            d: marker.path,
            class: marker.kind === "wing" ? "wg-marker-wing" : "wg-marker-cloud",
            "stroke-width": 0.6,
          }),
      ),
    );
  }
  for (const barb of scene.barbs) body.push(renderBarb(barb));
  for (const gust of scene.gusts) {
    body.push(
      text(
        {
          x: short(gust.x),
          y: short(gust.y),
          "text-anchor": "middle",
          class: "wg-gust wg-haloed-text wg-mono",
          "stroke-width": 2.2,
        },
        gust.label,
      ),
    );
  }
  for (const label of scene.labels) {
    body.push(
      text(
        {
          x: short(label.x),
          y: short(label.y),
          "text-anchor": label.anchor,
          class: `${label.className} wg-series-label wg-haloed-text`,
          "stroke-width": 2.5,
        },
        label.text,
      ),
    );
  }

  return el(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      viewBox: `0 0 ${short(scene.width)} ${short(scene.height)}`,
      role: "img",
      "aria-label": scene.ariaLabel,
      class: "wg",
    },
    `\n${body.join("\n")}\n`,
  );
}

/* ------------------------------------------------------------------ key */

/* Key layout constants. Text widths are estimated (label chars x an
   average glyph width for the reference face) because the serializer is
   headless — deterministic beats typographically perfect here. */
const KEY_PAD = 12;
const KEY_LABEL_CHAR_PX = 5.8;
const KEY_TITLE_CHAR_PX = 6.3;
const KEY_GROUP_CHAR_PX = 4.9;
const KEY_SWATCH_W = 26;
const KEY_CHIP_W = 24;
const KEY_CHIP_H = 9;
const KEY_SWATCH_STROKE = 2;
const KEY_LABEL_GAP = 6;
const KEY_ENTRY_GAP = 18;
const KEY_ROW_H = 26;
const KEY_TITLE_GAP = 10;
const KEY_MIN_CELL_W = 40;
const KEY_BAR_H = 22;

/**
 * Serializes a key spec (scene/buildKeySpec) to a self-contained SVG
 * string — the reference key. Swatches draw with each entry's REAL dash,
 * stroke width and class, so `--wg-*` tokens theme the key exactly as
 * they theme the chart and the two cannot disagree; the stability bar
 * prints the class boundaries above its cell edges and the group words
 * inside the cells. Default `idPrefix` is "wg-key" so a page holding the
 * default-prefixed chart and its key has no colliding pattern ids.
 */
export function renderKeySvg(spec: KeySpec, options: RenderSvgOptions = {}): string {
  const idPrefix = options.idPrefix ?? "wg-key";
  const stylesheet = options.stylesheet === undefined ? DEFAULT_STYLESHEET : options.stylesheet;

  type RowItem =
    | { kind: "series"; label: string; className: string; dash: string | null }
    | { kind: "hatch"; label: string }
    | { kind: "band"; label: string };
  const items: RowItem[] = [
    ...spec.series.map((entry) => ({
      kind: "series" as const,
      label: entry.label,
      className: entry.className,
      dash: entry.dash,
    })),
    ...(spec.hatch ? [{ kind: "hatch" as const, label: spec.hatch.label }] : []),
    ...(spec.band ? [{ kind: "band" as const, label: spec.band.label }] : []),
  ];
  const itemWidth = (item: RowItem) =>
    (item.kind === "series" ? KEY_SWATCH_W : KEY_CHIP_W) +
    KEY_LABEL_GAP +
    Math.ceil(item.label.length * KEY_LABEL_CHAR_PX);
  const rowWidth =
    items.reduce((sum, item) => sum + itemWidth(item), 0) +
    KEY_ENTRY_GAP * Math.max(items.length - 1, 0);
  const title = spec.stability?.title ?? "";
  const titleWidth = spec.stability ? Math.ceil(title.length * KEY_TITLE_CHAR_PX) + KEY_TITLE_GAP : 0;
  const minStabilityWidth = spec.stability
    ? titleWidth + KEY_MIN_CELL_W * spec.stability.classes.length
    : 0;
  const width = Math.max(rowWidth, minStabilityWidth) + 2 * KEY_PAD;
  const rowBottom = items.length > 0 ? 6 + KEY_ROW_H : 6;
  const barTop = rowBottom + 14;
  const height = spec.stability ? barTop + KEY_BAR_H + 10 : rowBottom + 6;

  const body: string[] = [];
  if (stylesheet) body.push(el("style", {}, `\n${stylesheet}\n`));
  if (spec.hatch) {
    const hatchId = `${idPrefix}-cloud-hatch`;
    body.push(
      el(
        "defs",
        {},
        el(
          "pattern",
          { id: hatchId, width: 7, height: 7, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
          el("line", { x1: 0, y1: 0, x2: 0, y2: 7, class: "wg-cloud-hatch-line", "stroke-width": 1.2 }),
        ),
      ),
    );
  }

  /* ----- the centred row: swatches with the REAL dashes, then chips ----- */
  let x = (width - rowWidth) / 2;
  const swatchY = 6 + KEY_ROW_H / 2;
  for (const item of items) {
    if (item.kind === "series") {
      const attrs: Record<string, AttrValue> = {
        d: `M${short(x)} ${short(swatchY)} H${short(x + KEY_SWATCH_W)}`,
        class: item.className,
        fill: "none",
        "stroke-width": KEY_SWATCH_STROKE,
        "stroke-linecap": "round",
      };
      if (item.dash) attrs["stroke-dasharray"] = item.dash;
      body.push(el("path", attrs));
      x += KEY_SWATCH_W;
    } else {
      const chipX = short(x);
      const chipY = short(swatchY - KEY_CHIP_H / 2);
      const chip: Record<string, AttrValue> = {
        x: chipX,
        y: chipY,
        width: KEY_CHIP_W,
        height: KEY_CHIP_H,
      };
      if (item.kind === "hatch") chip["fill"] = `url(#${idPrefix}-cloud-hatch)`;
      else chip["class"] = "wg-key-band";
      body.push(
        el("rect", chip),
        el("rect", {
          x: chipX,
          y: chipY,
          width: KEY_CHIP_W,
          height: KEY_CHIP_H,
          class: "wg-key-frame",
          "stroke-width": 0.7,
        }),
      );
      x += KEY_CHIP_W;
    }
    x += KEY_LABEL_GAP;
    body.push(text({ x: short(x), y: short(swatchY + 3.5), class: "wg-key-label" }, item.label));
    x += Math.ceil(item.label.length * KEY_LABEL_CHAR_PX) + KEY_ENTRY_GAP;
  }

  /* ----- the stability row: title at the left, the bar filling the rest,
     boundary values above the cell edges, group words inside ----- */
  if (spec.stability) {
    const barX = KEY_PAD + titleWidth;
    const cellW = (width - 2 * KEY_PAD - titleWidth) / spec.stability.classes.length;
    const cells: string[] = [];
    cells.push(
      text(
        { x: KEY_PAD, y: short(barTop + KEY_BAR_H / 2 + 3), class: "wg-key-title" },
        title,
      ),
    );
    spec.stability.classes.forEach((entry, index) => {
      // <title> is the cell's tooltip and accessible name: plain words
      // for a colour that otherwise only a legend-reader could name.
      cells.push(
        el(
          "rect",
          {
            x: short(barX + index * cellW),
            y: short(barTop),
            width: short(cellW),
            height: KEY_BAR_H,
            class: `wg-stab-${entry.className}`,
          },
          el("title", {}, escapeXml(entry.label)),
        ),
      );
    });
    spec.stability.classes.slice(0, -1).forEach((entry, index) => {
      cells.push(
        text(
          {
            x: short(barX + (index + 1) * cellW),
            y: short(barTop - 4),
            "text-anchor": "middle",
            class: "wg-key-boundary wg-mono",
          },
          String(entry.maxLapse),
        ),
      );
    });
    let offset = 0;
    for (const group of spec.stability.groups) {
      const maxPx = group.span * cellW - 8;
      const label =
        group.label.length * KEY_GROUP_CHAR_PX <= maxPx
          ? group.label
          : `${group.label.slice(0, Math.max(1, Math.floor(maxPx / KEY_GROUP_CHAR_PX) - 1))}…`;
      cells.push(
        text(
          {
            x: short(barX + (offset + group.span / 2) * cellW),
            y: short(barTop + KEY_BAR_H / 2 + 3),
            "text-anchor": "middle",
            class: "wg-key-group",
            "stroke-width": 2,
          },
          label,
        ),
      );
      offset += group.span;
    }
    body.push(
      el(
        "g",
        {
          role: "img",
          "aria-label":
            "Lapse-rate stability ramp: very unstable at the left through strong inversion at the right; boundary values in °C per 1,000 ft",
        },
        cells.join(""),
      ),
    );
  }

  const ariaParts = [
    items.length > 0 ? `line styles for ${items.map((item) => item.label).join(", ")}` : null,
    spec.stability ? "and the lapse-rate stability ramp" : null,
  ].filter((part): part is string => part !== null);
  return el(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      viewBox: `0 0 ${short(width)} ${short(height)}`,
      role: "img",
      "aria-label": `Windgram key: ${ariaParts.join(" ") || "empty"}.`,
      class: "wg wg-key",
    },
    `\n${body.join("\n")}\n`,
  );
}

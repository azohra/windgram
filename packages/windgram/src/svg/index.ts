import type { BarbPlacement, SceneGraph } from "../scene/types.js";
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
 * Derived with the dataviz palette validator (OKLab/OKLCH, Machado 2009
 * CVD simulation) against the default surface #fffdf8: lightness is
 * strictly monotone across the whole ramp (OKLCH L 0.79 → 0.33, so
 * grayscale and CVD readers keep the unstable→inverted ordering), the warm
 * arm carries the unstable half and the cool arm the stable half with a
 * neutral pivot at near-neutral, minimum adjacent-pair ΔE 11.0 (normal
 * vision), 7.7 protan / 8.9 deutan (above the validator's 6.0 floor, with
 * the field's spatial adjacency, legend, and cursor readouts as secondary
 * encoding), light end 2.02:1 against the surface. Restyle via the
 * --wg-stab-* tokens.
 */
export const STABILITY_TOKEN_DEFAULTS = {
  "very-unstable": "#fe9996",
  unstable: "#da934a",
  "conditional-strong": "#a68300",
  conditional: "#6a753f",
  "near-neutral": "#5b5f6b",
  stable: "#04548d",
  inverted: "#004f4a",
  "strong-inversion": "#1b3071",
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
 */
export const TOKEN_DEFAULTS = {
  font: '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif',
  "font-mono": '"IBM Plex Mono", ui-monospace, monospace',
  surface: "#fffdf8",
  "strip-bg": "#f2f4f1",
  rule: "#776956",
  ink: "#152529",
  "ink-soft": "#2f454a",
  "ink-mute": "#40565a",
  halo: "#fffdf8",
  accent: "#913b0c",
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
  wind: "#355963",
} as const;

/** `var(--wg-<name>, <default>)` with the fallback read from TOKEN_DEFAULTS. */
function v(name: keyof typeof TOKEN_DEFAULTS): string {
  return `var(--wg-${name}, ${TOKEN_DEFAULTS[name]})`;
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
.wg-haloed-text { stroke: ${v("halo")}; paint-order: stroke; }
.wg-halo { stroke: ${v("halo")}; }
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
.wg-cloud-cell { fill: ${v("cloud")}; }
.wg-strip-row-label { fill: ${v("ink-mute")}; }
.wg-gust { fill: ${v("gust")}; }
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
.wg-barb-halo { stroke: ${v("halo")}; }
.wg-barb-fill-halo { fill: ${v("halo")}; stroke: ${v("halo")}; }
.wg-marker-wing { fill: ${v("usable")}; stroke: ${v("usable")}; }
.wg-marker-cloud { fill: ${v("cloud-marker")}; stroke: ${v("cloud-base")}; }
.wg-marker-halo { fill: ${v("halo")}; stroke: ${v("halo")}; }
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
            "font-size": 7.5,
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
          "font-size": 10.5,
          "font-weight": 700,
          class: "wg-text",
        },
        strip.label,
      ),
      text(
        { x: plotLeft - 8, y: strip.top + 22, "text-anchor": "end", "font-size": 9.5, class: "wg-text-mute" },
        strip.unit,
      ),
    );
  }

  /* ----- plot frame, fields, selected column ----- */
  body.push(
    el("rect", { x: plotLeft, y: plotTop, width: plotWidth, height: plotHeight, class: "wg-frame" }),
  );
  for (const layer of scene.fields) {
    for (const { className, path } of layer.paths) {
      const attrs: Record<string, AttrValue> = { d: path, class: className };
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
        { x: plotLeft - 8, y: short(tick.y + 3), "text-anchor": "end", "font-size": 10.5, class: "wg-text-mute" },
        tick.labelMetres,
      ),
      text(
        { x: plotLeft + plotWidth + 8, y: short(tick.y + 3), "font-size": 10.5, class: "wg-text-mute" },
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
          "font-size": 11,
          class: "wg-text-mute wg-mono",
        },
        tick.label,
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
          "font-size": 10.5,
          "font-weight": 600,
          class: "wg-text wg-haloed-text",
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
          "font-size": 9.5,
          "font-weight": 700,
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
          "font-size": 10.5,
          "font-weight": 700,
          class: `${label.className} wg-haloed-text`,
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

/* The reference theme: every `--wg-*` token's default and the stylesheet
   built from them. Styling is class-name-driven; every colour lives in the
   stylesheet as a CSS custom property with a default matching the site's
   theme.css (the reference look), so consumers theme by overriding --wg-*
   tokens without forking the renderer. The serializers live in index.ts;
   this module is the one home for the token values, which consumers
   (legends, chips, swatches) read directly. */

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
  // The consumer-selection marks (column, hairline, barb ring): their own
  // slot so a theme can split "the day's best hour" (accent) from "the
  // hour you are reading", shipping at the same warm default.
  selection: "#913b0c",
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
  // Wildfire smoke: a warm haze brown, apart from the lift gold and the
  // CAPE ambers it shares strip space with.
  smoke: "#8c5a3c",
  // Measured irradiance: a sun gold apart from the lift ochre, and the
  // dimming shadow it casts when the sky under-delivers.
  sun: "#b07a1a",
  "sun-dim": "#43404a",
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

/**
 * Key-entry id -> the `--wg-*` token suffix that themes its stroke. The
 * ids are `buildKeySpec`'s (each series' most specific class token); this
 * map is the one home for that correspondence — the stylesheet's series
 * rules derive from it below, and a consumer building its own swatches or
 * focus styling reads it here instead of parsing id strings.
 */
export const SERIES_TOKENS = {
  "wg-series-usable": "usable",
  "wg-series-cloud-base": "cloud-base",
  "wg-series-boundary": "boundary",
  "wg-series-pbl": "pbl",
  "wg-isotherm": "ink",
  "wg-isotherm-freezing": "freezing",
  "wg-dewpoint-isoline": "dewpoint",
} as const satisfies Readonly<Record<string, keyof typeof TOKEN_DEFAULTS>>;

/**
 * Fill token and opacity per field-overlay class — the one home for the
 * facts a ramp chip needs (the stylesheet's field rules derive from this
 * map). `buildKeySpec`'s `ramps` name these classes; an HTML legend reads
 * the token and opacity here instead of restating them.
 */
export const FIELD_STYLE_DEFAULTS = {
  "wg-cloud-medium": { token: "cloud", opacity: 0.22 },
  "wg-cloud-light": { token: "cloud", opacity: 0.1 },
  "wg-ti-weak": { token: "ti-weak", opacity: 0.55 },
  "wg-ti-fair": { token: "ti-fair", opacity: 0.55 },
  "wg-ti-good": { token: "ti-good", opacity: 0.55 },
  "wg-ti-strong": { token: "ti-strong", opacity: 0.55 },
  "wg-shear-light": { token: "shear-light", opacity: 0.5 },
  "wg-shear-moderate": { token: "shear-moderate", opacity: 0.5 },
  "wg-shear-strong": { token: "shear-strong", opacity: 0.5 },
  "wg-rh-60": { token: "rh-60", opacity: 0.5 },
  "wg-rh-80": { token: "rh-80", opacity: 0.5 },
  "wg-rh-95": { token: "rh-95", opacity: 0.5 },
  "wg-omega-lift": { token: "omega-lift", opacity: 0.4 },
  "wg-omega-lift-strong": { token: "omega-lift-strong", opacity: 0.5 },
  "wg-omega-sink": { token: "omega-sink", opacity: 0.4 },
  "wg-omega-sink-strong": { token: "omega-sink-strong", opacity: 0.5 },
} as const satisfies Readonly<Record<string, { token: keyof typeof TOKEN_DEFAULTS; opacity: number }>>;

/** `var(--wg-<name>, <default>)` with the fallback read from TOKEN_DEFAULTS. */
function v(name: keyof typeof TOKEN_DEFAULTS): string {
  return `var(--wg-${name}, ${TOKEN_DEFAULTS[name]})`;
}

/** One field class's stylesheet rule, derived from FIELD_STYLE_DEFAULTS. */
function fieldRule(className: keyof typeof FIELD_STYLE_DEFAULTS): string {
  const style = FIELD_STYLE_DEFAULTS[className];
  return `.${className} { fill: ${v(style.token)}; opacity: ${style.opacity}; }`;
}

/** One series class's stroke value, derived from SERIES_TOKENS. */
function seriesStroke(id: keyof typeof SERIES_TOKENS): string {
  return v(SERIES_TOKENS[id]);
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
.wg-selection-column { fill: ${v("selection")}; opacity: 0.07; }
.wg-selection-line { stroke: ${v("selection")}; }
.wg-selection-ring { stroke: ${v("selection")}; }
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
.wg-strip-smoke { stroke: ${v("smoke")}; }
.wg-strip-smoke-area, .wg-strip-smoke-band { fill: ${v("smoke")}; }
.wg-smoke-cell { fill: ${v("smoke")}; }
.wg-strip-observedIrradiance { stroke: ${v("sun")}; }
.wg-strip-observedIrradiance-area, .wg-strip-observedIrradiance-band { fill: ${v("sun")}; }
.wg-dim-cell { fill: ${v("sun-dim")}; }
.wg-strip-observedAot { stroke: ${v("smoke")}; }
.wg-strip-observedAot-area, .wg-strip-observedAot-band { fill: ${v("smoke")}; }
.wg-strip-source { fill: ${v("ink-mute")}; font-size: 8px; font-style: italic; }
.wg-strip-divider { stroke: ${v("rule")}; stroke-dasharray: 2 3; stroke-width: 0.8; }
.wg-strip-divider-label { fill: ${v("ink-mute")}; font-size: 8px; font-style: italic; letter-spacing: 0.04em; }
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
.wg-series-pbl { stroke: ${seriesStroke("wg-series-pbl")}; }
.wg-series-pbl-band { fill: ${v("pbl")}; opacity: 0.16; }
${STABILITY_RULES}
.wg-cloud-hatch-line { stroke: ${v("ink-soft")}; }
${fieldRule("wg-cloud-medium")}
${fieldRule("wg-cloud-light")}
${fieldRule("wg-ti-weak")}
${fieldRule("wg-ti-fair")}
${fieldRule("wg-ti-good")}
${fieldRule("wg-ti-strong")}
${fieldRule("wg-shear-light")}
${fieldRule("wg-shear-moderate")}
${fieldRule("wg-shear-strong")}
${fieldRule("wg-rh-60")}
${fieldRule("wg-rh-80")}
${fieldRule("wg-rh-95")}
${fieldRule("wg-omega-lift")}
${fieldRule("wg-omega-lift-strong")}
${fieldRule("wg-omega-sink")}
${fieldRule("wg-omega-sink-strong")}
.wg-series-boundary { stroke: ${seriesStroke("wg-series-boundary")}; }
.wg-series-boundary-band { fill: ${v("boundary")}; opacity: 0.16; }
.wg-series-cloud-base { stroke: ${seriesStroke("wg-series-cloud-base")}; }
.wg-series-cloud-base-band { fill: ${v("cloud-base")}; opacity: 0.16; }
.wg-series-usable { stroke: ${seriesStroke("wg-series-usable")}; }
.wg-series-usable-band { fill: ${v("usable")}; opacity: 0.16; }
.wg-isotherm { stroke: ${seriesStroke("wg-isotherm")}; }
.wg-isotherm-freezing { stroke: ${seriesStroke("wg-isotherm-freezing")}; }
.wg-isotherm-label { fill: ${v("ink")}; }
.wg-isotherm-label-freezing { fill: ${v("freezing")}; }
.wg-dewpoint-isoline { stroke: ${seriesStroke("wg-dewpoint-isoline")}; }
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

/* presets/ — named bundles of the option and token surface, so a consumer
   applies a coherent set of conventions in one move instead of assembling
   them field by field. A preset is a starting point, not a mode: spread its
   `sceneOptions` under your own and override anything on top, and apply its
   `tokens` as `--wg-<key>` CSS custom properties (or ignore them).

   The honesty rule: a preset claims only conventions verified in the source
   it is named for, with a dated note saying what was checked and what is
   deliberately excluded. A truthful thin preset beats a fabricated rich
   one. */

import type { SceneOptions } from "../scene/types.js";
import { DEFAULT_CAPE_CLASSES, DEFAULT_OVERLAYS } from "../scene/types.js";
import { DEFAULT_COLUMN_WIDTH, DEFAULT_PLOT_HEIGHT } from "../scene/scene.js";
import { STABILITY_TOKEN_DEFAULTS, TOKEN_DEFAULTS } from "../svg/index.js";

/**
 * A named bundle of conventions. `sceneOptions` spreads into
 * `buildScene`'s options (see {@link applyPreset}); `tokens` are `--wg-*`
 * CSS custom-property values keyed by token suffix, exactly like
 * `TOKEN_DEFAULTS` — stability-ramp entries carry their `stab-` prefix so
 * one flat map covers the whole token surface. Either side may be absent
 * when a preset has nothing verified to say about it.
 */
export interface Preset {
  sceneOptions?: Partial<SceneOptions>;
  tokens?: Readonly<Record<string, string>>;
}

/**
 * Merge a preset under a consumer's own options. The consumer's fields win,
 * so overriding a preset is spelling out the field you disagree with:
 * `buildScene(profile, applyPreset(CANADARASP_PRESET, { timeZone, smooth: false }))`.
 * `options` carries the required `timeZone`, which no preset presumes to set.
 * Tokens are not merged here — they are CSS, applied (or not) by the
 * consumer's stylesheet.
 */
export function applyPreset(preset: Preset, options: SceneOptions): SceneOptions {
  return { ...preset.sceneOptions, ...options };
}

/**
 * Today's defaults, named — the reference windgram's conventions as a
 * documented citizen instead of a privileged silence. Applying it is
 * exactly equivalent to passing no options (asserted as scene-JSON
 * identity in the tests):
 *
 * - `sceneOptions` names every optional convention `buildScene` defaults:
 *   the reference overlay set, 1-2-1 smoothing on, the WMO-No. 1038 CAPE
 *   classes, the gold-standard proportions, the 24-hour tick convention
 *   and geometry-aware barb density. `sinkRateMs` is deliberately absent:
 *   the default is to draw the PUBLISHED usable-lift series (which embeds
 *   the 1.0 m/s convention), and naming a number here would switch to the
 *   recompute path instead — a different code path, not the default.
 *   `barbScale` and `barbMinGapPx` are absent for the same reason: their
 *   defaults are pitch-following computations, and naming a number would
 *   pin them;
 * - `tokens` is the complete reference palette: `TOKEN_DEFAULTS` plus the
 *   stability ramp from `STABILITY_TOKEN_DEFAULTS` under its `stab-`
 *   prefix. Composed from those exports, never restated.
 */
export const REFERENCE_PRESET: Preset = {
  sceneOptions: {
    overlays: DEFAULT_OVERLAYS,
    smooth: true,
    capeClasses: DEFAULT_CAPE_CLASSES,
    columnWidthPx: DEFAULT_COLUMN_WIDTH,
    plotHeightPx: DEFAULT_PLOT_HEIGHT,
    hourLabel: "24h",
    barbStride: "auto",
  },
  tokens: {
    ...TOKEN_DEFAULTS,
    ...Object.fromEntries(
      Object.entries(STABILITY_TOKEN_DEFAULTS).map(([name, hex]) => [`stab-${name}`, hex]),
    ),
  },
};

/**
 * The conventions this project verifiably inherits from
 * [canadarasp](https://github.com/ajberkley/canadarasp), the project this
 * pipeline descends from — gratefully. Every claim below was checked in
 * canadarasp's own source rather than remembered; the citations are paths
 * (and lines) relative to that repository's root, verified 2026-08-08.
 * The `sceneOptions` coincide with this package's defaults, so they change
 * nothing renderable; the `tokens` are the recognizable face — canadarasp's
 * stability palette on canadarasp's background, with its strip inks and
 * marker colours.
 *
 * `sceneOptions`:
 *
 * - `sinkRateMs: 1.0` — canadarasp's hcrit sink threshold.
 *   `continental-test/plot-generation/windgram-continental.ncl` defaults
 *   `sink_rate=1.0` (lines 83-85) and walks the strongest-core updraft
 *   profile down to it (lines 377-420); no invocation script in the
 *   repository overrides it. This pipeline's published `usableLiftTopM`
 *   embeds the same 1.0 m/s — the two conventions coincide. Setting it
 *   here recomputes the drawn series through derive/'s `usableLiftTopM`,
 *   which at 1.0 reproduces the published series exactly for
 *   pipeline-derived documents (and deliberately no-ops for ensembles);
 * - `smooth: true` — the 1-2-1 kernel. The same file smooths the LCL and
 *   hcrit series as `(previous + 2*current + next) / 4` when `smooth` is
 *   set (lines 483-487), and
 *   `continental-test/plot-generation/windgram-hrdps.ncl` line 5 sets
 *   `smooth = 1` for the HRDPS windgrams canadarasp's production scripts
 *   generate (`run-my-windgrams.sh`); GDPS stays unsmoothed
 *   (`windgram-gdps.ncl` line 6). This package's `smooth121` ports those
 *   kernel semantics, applied to the same two series (cloud base and
 *   usable-lift top).
 *
 * `tokens` — the stability field first, because the class boundaries
 * correspond EXACTLY. canadarasp contours the lapse-rate field at
 * −3 / −2.5 / −2 / −1.5 / −1.2 / −0.5 / 0 / 0.5 degC per 1000 ft
 * (`windgram-continental.ncl` line 910) with fill colours by colormap
 * index (line 913, indices into
 * `continental-test/plot-generation/windgram-continental-colormap.ncl`).
 * The extra −0.5 boundary is invisible: both bands around it fill with the
 * same index 2, and its contour line takes that same colour
 * (`cnLineColors = cnFillColors(1:)`, line 922), leaving eight visible
 * bands whose boundaries are exactly `WINDGRAM_STABILITY_CLASSES`. The
 * background is the design's ninth colour: `background_color=(.5,.5,.9)`
 * (line 73) is colormap index 2 to 8-bit rounding, and the colormap's own
 * comments say "matching the background is stable" — stable air disappears
 * into the page, which is why `surface`/`strip-bg` ship here alongside the
 * ramp. The strip inks are each strip's `gsnAboveYRefLineColor` (NCL named
 * colours, standard rgb.txt values). Where canadarasp marks a height with
 * symbols instead of drawing a line, the preset carries the verified
 * marker colour onto this renderer's line-and-marker slot for the same
 * quantity; each such transfer is noted on the token.
 *
 * Deliberately NOT reproduced — checked and excluded, not guessed:
 *
 * - the text/ink family (`ink`, `ink-soft`, `ink-mute`, `rule`, `halo`):
 *   canadarasp sets one white foreground for all text and axes
 *   (`foreground_color="white"`, line 72) plus per-strip label colours
 *   (paleturquoise/gray80/gold/coral, lines 746-849) — one convention per
 *   slot cannot carry both, and `ink-soft` doubly collides (below);
 * - the dense-cloud cross-hatch ink: canadarasp cross-hatches DPR < 0.5
 *   degC in colormap index 22, #464646 (lines 877, 896) — the exact
 *   convention behind this renderer's dense-cloud hatch, but the hatch
 *   stroke shares `--wg-ink-soft` with secondary text, which in canadarasp
 *   is white. One slot, two verified conventions: neither is claimed;
 * - wind-barb colour: never assigned explicitly — it falls back to NCL's
 *   foreground default, and inferring library defaults is guessing;
 * - `dp_cut=0.5` and the 07:00-21:00 local window (lines 86-87 and 58-59):
 *   both already coincide with this package's conventions and are not
 *   scene options — there is nothing to set;
 * - `max_altitude`, unit schemes, per-strip axis labelling: not options
 *   here, or not verified as equivalent.
 */
export const CANADARASP_PRESET: Preset = {
  sceneOptions: {
    smooth: true,
    sinkRateMs: 1.0,
  },
  tokens: {
    // The eight-band lapse-rate palette: cnLevels (windgram-continental.ncl
    // line 910) x cnFillColors (line 913) x windgram-continental-colormap.ncl.
    "stab-very-unstable": "#ff3d3d", // < -3: index 11, "dark red"
    "stab-unstable": "#ff7800", // -3..-2.5: index 10, "dark orange"
    "stab-conditional-strong": "#ff96ff", // -2.5..-2: index 7, "pale pink"
    "stab-conditional": "#ccbfff", // -2..-1.5: index 8, "pale purple lavender"
    "stab-near-neutral": "#facab1", // -1.5..-1.2: index 3, "light tan"
    "stab-stable": "#8080e6", // -1.2..0: index 2 twice, "purple/blue"
    "stab-inverted": "#cccccc", // 0..0.5: index 13, "darker grey"
    "stab-strong-inversion": "#999999", // > 0.5: index 14, "even darker grey"
    // The page the design pivots on: background_color=(.5,.5,.9), line 73 —
    // "matching the background is stable" (colormap line 8).
    surface: "#8080e6",
    "strip-bg": "#8080e6", // canadarasp strips draw on the same background
    // Strip inks: gsnAboveYRefLineColor per strip, X11 rgb.txt values.
    pressure: "#cd5b45", // "coral3", line 854
    rain: "#00ced1", // "darkturquoise", line 752
    cloud: "#7f7f7f", // "gray50", cloud-cover strip, line 782
    lift: "#cdad00", // "gold3", the W* strip, line 815
    // Marker colours carried onto this renderer's slot for the same
    // quantity (canadarasp marks these heights; it does not draw lines):
    "cloud-marker": "#ffffff", // white LCL cloud glyphs, line 979
    usable: "#0000ff", // blue crescents at hcrit, line 990
    boundary: "#ffff00", // yellow bars at the BL top, line 1001
  },
};

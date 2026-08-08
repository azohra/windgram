# windgram

TypeScript companion to the windgram dataset published from
[github.com/azohra/windgram](https://github.com/azohra/windgram): the
published contract, the derivations that are pure functions of it, and the
gold-standard renderer (headless scene graph + reference SVG serializer).

```sh
npm install windgram
```

The package ships ESM with type declarations; the only dependency is zod.
Nothing touches the DOM, so everything below runs identically in Node,
workers, and browsers.

## Fetch a live document

The dataset is static JSON on GitHub's CDN — no key, no API. Discover models
from the catalogue instead of hardcoding a list: the catalogue grows, slugs
are the only model identity, and each entry declares what its model actually
publishes.

```ts
import {
  parseModelCatalogueJson,
  parseWindgramManifestJson,
  parseWindgramProfileJson,
} from "windgram/contract";

const DATA = "https://raw.githubusercontent.com/azohra/windgram/main/data";
async function text(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

const catalogue = parseModelCatalogueJson(await text(`${DATA}/models.json`));
if (!catalogue) throw new Error("models.json failed contract validation");

// Pick by declared capability, never by name.
const model = catalogue.models.find(
  (entry) => entry.kind === "deterministic" && entry.capabilities.cape,
);
if (!model) throw new Error("no deterministic model with CAPE is published");

const manifest = parseWindgramManifestJson(await text(`${DATA}/${model.slug}/manifest.json`));
if (!manifest) throw new Error("manifest failed contract validation");

const site = manifest.sites[0];
if (!site) throw new Error(`${model.label} published no sites`);

const profile = parseWindgramProfileJson(await text(`${DATA}/${model.slug}/sites/${site.slug}.json`));
if (!profile) throw new Error("profile failed contract validation");

console.log(`${model.label} at ${profile.site.name}, run ${profile.run.referenceTime}`);
```

The `parse…Json` guards return the typed document or `null`. A `null` from a
URL that served 200 means publisher and consumer disagree about the contract;
fail loudly rather than patching around it. (`parseWindgramProfile` and
friends do the same for values you have already `JSON.parse`d — history
lines, for instance, are one profile document per line.)

## Depth one: data only (`contract` + `derive`)

For consumers bringing their own UI. Everything that is a pure function of
the published JSON lives in `windgram/derive`; the pipeline's own quantities
(`derived.*` — W\*, boundary-layer top, cloud base, usable-lift top) arrive
in the document and are never recomputed here.

```ts
import { p50, stabilityClass, surfaceLapseCPer1000Ft, windgramDisplayHours } from "windgram/derive";

// Day windowing runs in the consumer's timezone — the dataset has no clock.
// Defaults: local 07:00–21:00, days with at least five in-window hours.
const day = windgramDisplayHours(profile.hours, { timeZone: "America/Vancouver" });

for (const hour of day) {
  const wStar = p50(hour.derived.thermalVelocityMs);
  const liftTopM = p50(hour.derived.usableLiftTopM); // null when lift can't beat sink
  const cape = hour.surface.capeJkg; // optional: absent means "not published", never zero
  console.log(hour.validAt, wStar.toFixed(1), liftTopM ?? "—", cape === undefined ? "—" : p50(cape));
}

// Derivations take plain numbers; ensemble positions go through p50 first.
const noon = day[Math.floor(day.length / 2)];
const first = noon?.levels[0];
if (noon && first) {
  const lapse = surfaceLapseCPer1000Ft(p50(noon.surface.temperatureC), profile.site.modelElevationM, {
    heightM: p50(first.heightM),
    temperatureC: p50(first.temperatureC),
  });
  if (lapse !== null) console.log(stabilityClass(lapse));
}
```

Optional fields (`windGustMs`, `capeJkg`, `cinJkg`, `pblHeightM`, the cloud
layers and profile) exist only where a model publishes them, and the
catalogue's `capabilities` say which — including semantics, not just
presence: `capabilities.gust` distinguishes an hour-max "gusting to" from an
instantaneous sample. Render the declaration; never fill a gap with zero.

## Depth two: custom rendering with shared numbers (`scene`)

`buildScene(profile, options)` computes everything a chart needs — scales,
axis ticks, metric strips, classified field patches, derived-height series,
wind-barb and gust placements, markers, labels — as one typed, serializable
scene graph. No DOM: draw it with SVG, canvas, or anything else, and use the
same graph for interaction so tooltips and pixels can never disagree.

```ts
import { windgramDisplayHours } from "windgram/derive";
import { buildScene, cursorReading } from "windgram/scene";

const timeZone = "America/Vancouver";
const day = windgramDisplayHours(profile.hours, { timeZone });
const scene = buildScene(profile, {
  timeZone,
  hourIndices: day.map((hour) => profile.hours.indexOf(hour)),
  overlays: { thermalIndex: true }, // analysis overlays are opt-in
});

for (const strip of scene.strips) console.log(strip.label, strip.unit, strip.linePath);
for (const series of scene.series) console.log(series.key, series.path, series.bandPath);

// Hit-testing interpolates the same numbers the chart plots.
const reading = cursorReading(scene, scene.scales.plotLeft + 5, scene.scales.plotTop + 5);
if (reading) console.log(reading.temperatureC, reading.stabilityClassName);
```

`DEFAULT_OVERLAYS` reproduces the reference windgram. The science-field
overlays (`cape`, `gusts`, `pblHeight`, `cloudLayers`) default on and
contribute nothing for models that do not publish their fields; the analysis
overlays (`thermalIndex`, `windShear`, `buoyancyShear`, `dewPoint`,
`relativeHumidity`, `verticalVelocity`) are opt-in. Everything else the
renderer draws is removable too — nothing is unconditional except the axes
and plot frame: the always-published strips (`pressure`, `precipitation`),
each derived-height line by name (`boundaryLayerTop`, `cloudBase`,
`usableLiftTop`, beside the existing `pblHeight`), the `launch` line, and
the `selectedHour` column highlight all default on and toggle off
individually. `smooth` (default true)
applies the 1-2-1 kernel to the cloud-base and usable-lift series — a
renderer choice, undoable because the documents publish unsmoothed values.
`columnWidthPx` (default 44) and `plotHeightPx` (default 340) size the chart
for its page instead of hard-coding the reference proportions.

Two more options move conventions into the consumer's hands. `capeClasses`
sets the CAPE strip's class boundaries; the default,
`DEFAULT_CAPE_CLASSES` (calm < 300, watch < 800, risk < 1500,
severe ≥ 1500 J/kg, cells dimmed as capped at CIN ≤ −50), documents its
WMO-No. 1038 soaring rationale in its JSDoc and renders byte-identically to
the pre-option output. `sinkRateMs` recomputes the usable-lift-top series
with `windgram/derive`'s parameterized `usableLiftTopM` instead of reading
the document's published value (which embeds the fixed 1.0 m/s convention);
at 1.0 the recomputed series equals the published one exactly, and for
ensemble documents the option deliberately no-ops — recomputing from p50
inputs is not the pipeline's per-member derivation aggregated to
percentiles, so the published percentile series is kept.

## Depth three: the reference chart (`svg`)

`renderSvg(scene)` serializes the scene to a deterministic, self-contained
SVG string — the same rendering the golden fixtures lock down.

```ts
import { buildScene } from "windgram/scene";
import { renderSvg } from "windgram/svg";

const svg = renderSvg(buildScene(profile, { timeZone: "America/Vancouver" }), {
  idPrefix: "wg-main", // give each windgram on a page its own prefix
});
```

Every colour is a `--wg-*` CSS custom property with defaults matching the
reference theme, so retheming is a token override on any ancestor — no fork:

```css
.forecast-panel {
  --wg-surface: #14181c;
  --wg-ink: #e8e4da;
  --wg-cape-watch: #b98a2d;
}
```

The eight-class stability ramp restyles the same way through the
`--wg-stab-*` tokens (`--wg-stab-very-unstable` … `--wg-stab-strong-inversion`);
its validated defaults are exported as `STABILITY_TOKEN_DEFAULTS` for
consumers building legends from the same values. Every other token default
is exported the same way as `TOKEN_DEFAULTS`, keyed by token suffix
(`TOKEN_DEFAULTS.pbl` is the `--wg-pbl` fallback) — a consumer's legend
chip or swatch reads the map instead of restating a hex, and the embedded
stylesheet's own fallbacks derive from it. One deliberate pairing:
the cloud glyph at cloud base fills with `--wg-cloud-marker` (a pale cream,
the reference look) while its outline keeps `--wg-cloud-base`, the hue of
the line it marks.

For full control, pass `stylesheet: null` to omit the embedded sheet and
style the classes yourself; the exported `DEFAULT_STYLESHEET` string is the
reference to start from.

## Presets

`windgram/presets` bundles the option and token surface into named
conventions, applied in one move. A `Preset` is
`{ sceneOptions?, tokens? }`; `applyPreset(preset, options)` merges it under
your own options, and your fields win — presets are starting points, not
modes:

```ts
import { CANADARASP_PRESET, REFERENCE_PRESET, applyPreset } from "windgram/presets";

const scene = buildScene(profile, applyPreset(CANADARASP_PRESET, { timeZone }));
// Disagreeing with a preset is spelling out the field:
buildScene(profile, applyPreset(CANADARASP_PRESET, { timeZone, smooth: false }));
```

`REFERENCE_PRESET` is today's defaults, named: applying it is exactly
equivalent to passing no options (asserted in the tests), and its `tokens`
map is the complete reference palette — `TOKEN_DEFAULTS` plus the stability
ramp under its `stab-` prefix — so the default conventions are a documented
citizen rather than a privileged silence.

Presets follow an honesty rule: they claim only conventions verified in the
source they are named for, with a dated note in their JSDoc listing what was
checked and what is deliberately excluded. `CANADARASP_PRESET` names what
this project verifiably inherits from
[canadarasp](https://github.com/ajberkley/canadarasp), the project this
pipeline gratefully descends from. Its `sceneOptions` — the 1.0 m/s hcrit
sink threshold and the 1-2-1 smoothing of the cloud-base and usable-lift
lines — coincide with this package's defaults, so the geometry is unchanged;
the recognizable face is in its `tokens`. canadarasp's lapse-rate bands
correspond exactly to the eight `WINDGRAM_STABILITY_CLASSES` (its extra
−0.5 °C/1000 ft contour is fill-invisible), so the preset carries its full
stability palette, together with the design that palette pivots on — stable
air matches the page background — plus its strip inks and the marker
colours of its height conventions, every value extracted from cited lines
of canadarasp's source rather than remembered. (This reproduces lineage,
not this package's accessibility validation: the default ramp is
CVD-checked, canadarasp's palette is symbolic.) Its text scheme, wind-barb
colour, and per-strip axis labelling are deliberately excluded — checked,
and either colliding two conventions into one token slot or resting on
library defaults the JSDoc declines to guess.

## Ensemble documents

Every numeric data position in `surface`, `levels`, and `derived` is a
`Scalar = number | EnsembleValue`: deterministic models publish numbers,
ensemble models publish `{members, p10, p25, p50, p75, p90, ceiledMembers?}`
in the same positions. Switch on shape, never on model name:

```ts
import { isEnsembleValue } from "windgram/contract";

const wind = profile.hours[0]?.surface.windSpeedMs;
if (wind !== undefined) {
  if (isEnsembleValue(wind)) {
    console.log(`p50 ${wind.p50} m/s, p10–p90 ${wind.p10}–${wind.p90}, ${wind.members} members`);
  } else {
    console.log(`${wind} m/s`);
  }
}
```

`p50(scalar)` collapses either shape to the median (null passes through), so
deterministic code paths work on ensemble profiles unchanged. The scene
graph handles the rest itself: ensemble series render their p50 line with
p25–p75 band geometry wherever percentiles exist, and a model without levels
gracefully drops barbs, fields, and isotherms.

## Non-JS consumers

JSON Schema artifacts generated from the same zod schemas ship in the npm
package and repository under [`schema/`](schema/) —
`profile.schema.json`, `manifest.schema.json`, `models.schema.json` — so any
language with a JSON Schema validator gets the identical contract.
Regenerate with `pnpm schemas`.

## Exports

### `windgram/contract`

Zod schemas, inferred types, and safeParse guards for the three published
document kinds:

- `windgramProfileSchema` / `WindgramProfile` — the per-site profile at
  `data/<model-slug>/sites/<site-slug>.json` (history lines are the same
  document, one per line);
- `windgramManifestSchema` / `WindgramManifest` — `data/<model-slug>/manifest.json`;
- `modelCatalogueSchema` / `ModelCatalogue` — `data/models.json`, the
  discovery catalogue.

Guards come in pairs: `parseWindgramProfile(value)` for already-parsed
values and `parseWindgramProfileJson(text)` for raw stored strings (both
return the typed document or `null`); likewise for the manifest and the
catalogue.

### `windgram/derive`

Pure, unit-tested functions of published state. All of them take plain
numbers; to run one against an ensemble profile, select the median first
with `p50(scalar)`.

- moisture: `relativeHumidityPercent`, `dewPointC`, `dewPointDepressionC`
  (Magnus, Alduchov–Eskridge coefficients);
- wind: `windToComponents` / `componentsToWind` (met from-direction ↔ u/v),
  `normalizeDegrees`;
- lapse: `lapseRateCPerKm` / `lapseRateCPer1000Ft` between samples, plus the
  `surfaceLapse…` variants against model elevation;
- stability: `WINDGRAM_STABILITY_CLASSES` and `stabilityClass` (the eight
  fixed bands; boundaries match the shipped site's stability palette);
- thermal index: `thermalIndexC` / `thermalIndexProfile` (surface parcel
  lifted at 0.0098 °C/m against level temperature);
- shear: `vectorShearMs` between levels,
  `surfaceToBoundaryLayerShearMs` for a profile hour, and
  `buoyancyShearRatio` (W* ÷ BL shear — definition in the JSDoc);
- usable lift: `usableLiftTopM` — the pipeline's hcrit derivation with the
  sink rate as a parameter, over published inputs only. The published
  `derived.usableLiftTopM` embeds a fixed **1.0 m/s** sink rate — that
  convention is part of the published value — and the default here
  reproduces it exactly (asserted against a real pipeline fixture); other
  sink rates answer "what about my glider?" without republishing anything
  (the scene option `sinkRateMs` wires this into the renderer);
- day windowing: `windgramDisplayHours` with timezone and day bounds as
  parameters (nothing hardcodes a timezone), plus `localHourOfDay` and
  `localDateKey` for building day tabs;
- smoothing: `smooth121`, the pipeline's retired 1-2-1 kernel as a renderer
  option (only across contiguous one-hour steps).

### `windgram/scene`

The headless renderer core: `buildScene(profile, options)` and the
`SceneGraph` types, `DEFAULT_OVERLAYS`, `DEFAULT_CAPE_CLASSES`,
hit-testing (`cursorReading`,
`xForHour`, `yForAltitude`, …), and the low-level geometry helpers the site's
own figures reuse (`windBarbPaths`, `sampledFieldPaths`, `curvedPath`,
`pointPath`, `interpolateVertical`, `msToKmh`).

### `windgram/svg`

The reference serializer: `renderSvg(scene, options)`, `DEFAULT_STYLESHEET`,
the token-default maps (`TOKEN_DEFAULTS`, `STABILITY_TOKEN_DEFAULTS`), and
the `RenderSvgOptions` type (`stylesheet`, `idPrefix`). Output is
deterministic — stable element ordering, two-decimal rounding — and golden
fixtures in `test/golden/` lock it down.

### `windgram/presets`

Named convention bundles (see [Presets](#presets)): the `Preset` type,
`applyPreset`, `REFERENCE_PRESET` (today's defaults plus the complete token
palette, named), and `CANADARASP_PRESET` (the verified canadarasp
inheritances — options and palette — dated and cited line-by-line in its
JSDoc).

## The one-home rule

Every quantity has exactly one implementation. The pipeline (Python) owns
anything needing inputs beyond the published JSON or cross-run authority —
W\*, boundary-layer top, cloud base, usable-lift top arrive in the documents
and this package **never recomputes them**. This package owns anything that
is a pure function of the published JSON — RH, TI, shear, B/S, lapse,
stability, windowing, smoothing — and the pipeline never publishes those.

## Developing

```sh
pnpm --dir packages/windgram test      # vitest
pnpm --dir packages/windgram build     # tsc -> dist/ (types + ESM)
pnpm --dir packages/windgram schemas   # regenerate schema/*.json
```

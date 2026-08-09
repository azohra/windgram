# windgram

TypeScript companion to the windgram dataset published from
[github.com/azohra/windgram](https://github.com/azohra/windgram): the
published contract, the derivations that are pure functions of it, the
transport that fetches the documents consistently, and the gold-standard
renderer (headless scene graph + reference SVG serializer).

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
publishes. Then fetch the manifest + profile pair through
`windgram/transport`, never by hand — the CDN's cache entries expire
independently, so two naive fetches can silently span two different runs
(the "torn read" the transport guard exists for; see
[Transport](#transport-windgramtransport)).

```ts
import { parseModelCatalogueJson } from "windgram/contract";
import { loadProfile } from "windgram/transport";

const DATA = "https://raw.githubusercontent.com/azohra/windgram/main/data";

// The catalogue is a single document — no pair to tear — so a plain
// guarded fetch is the right tool for it.
const response = await fetch(`${DATA}/models.json`);
if (!response.ok) throw new Error(`models.json: HTTP ${response.status}`);
const catalogue = parseModelCatalogueJson(await response.text());
if (!catalogue) throw new Error("models.json failed contract validation");

// Pick by declared capability, never by name.
const model = catalogue.models.find(
  (entry) => entry.kind === "deterministic" && entry.capabilities.cape,
);
if (!model) throw new Error("no deterministic model with CAPE is published");

// The manifest + profile pair goes through the skew guard.
const loaded = await loadProfile({
  fetch,
  baseUrl: DATA,
  modelSlug: model.slug,
  siteSlug: "dundee",
});
if (!loaded) throw new Error(`${model.label} does not publish dundee`);
const { manifest, profile, stale } = loaded;
if (stale) console.warn("run still syncing across the CDN — pair may span two runs");

console.log(`${model.label} at ${profile.site.name}, run ${profile.run.referenceTime}`);
```

Everything arrives contract-validated: the `parse…Json` guards (and the
transport, which uses them) return the typed document or `null`. A `null`
from a URL that served 200 means publisher and consumer disagree about the
contract; fail loudly rather than patching around it.
(`parseWindgramProfile` and friends do the same for values you have already
`JSON.parse`d — history lines, for instance, are one profile document per
line.)

## Transport (`windgram/transport`)

The pipeline publishes a model's manifest and its site profiles as separate
files, and raw.githubusercontent's cache holds each for ~5 minutes
independently — so around a publish, a manifest and a profile fetched
together can describe **two different runs**. `loadProfile` owns the
reference-time skew dance: fetch the pair, compare `run.referenceTime`
against the manifest's, and on disagreement retry the pair once after a
short delay (default 1500 ms). It resolves to:

- `{ manifest, profile, stale: false }` — a consistent pair;
- `{ manifest, profile, stale: true }` — still torn after the retry: a
  publish is mid-sync. Show a "still syncing" note or fall back to a pair
  you kept from earlier; never render the two documents as one forecast;
- `null` — the model or site is not published here (404), **or** a body
  failed the contract guards: a model still publishing pre-release
  prototype data reads as unavailable rather than rendering garbage.

Non-404 HTTP failures throw `TransportHttpError` instead of masking
themselves as absence. The pure pair check is exported too:
`runsConsistent(manifest, profile)` is true exactly when both documents
name the same model and run.

`fetch` is a parameter, not an import: pass the runtime's own (browser,
Node, workers — anything WHATWG-shaped), which keeps the module
runtime-agnostic and the rest of the package I/O-free. Deliberately **no
caching, no storage side effects**: no storage API is portable across those
runtimes, and cache doctrine — keys, quotas, invalidation, whether a stale
pair beats none — is consumer policy, not transport fact. The transport
reports `stale` honestly; keeping a last-known-good pair around (as the
reference site does with `sessionStorage`) is a layer you add on top.

`loadRuns({ fetch, baseUrl })` fetches `data/runs.json`, the cross-model
run index: per published model, its current run's `referenceTime` and
`generatedAt`, keyed by slug. One fetch answers "how fresh is everything"
— judge lateness against each model's declared `runIntervalHours` (a run
older than about twice the interval is genuinely late, not just a slow
CDN).

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
instantaneous sample, and `capabilities.precipitation` an instantaneous
rate from a window mean. Documents from the 0.3.0 wave echo those
declarations in their own optional top-level `semantics` tag, so a stored
profile stays interpretable without the catalogue beside it. Render the
declaration; never fill a gap with zero.

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
  hours: day, // pre-windowed hour objects select directly, no index bookkeeping
  overlays: { thermalIndex: true }, // analysis overlays are opt-in
});

for (const strip of scene.strips) console.log(strip.label, strip.unit, strip.linePath);
for (const series of scene.series) console.log(series.key, series.path, series.bandPath);

// Hit-testing interpolates the same numbers the chart plots.
const reading = cursorReading(scene, scene.scales.plotLeft + 5, scene.scales.plotTop + 5);
if (reading) console.log(reading.temperatureC, reading.stabilityClassName);
```

Three windowing forms, mapping to the same thing internally: `hourIndices`
(indices into `profile.hours`, the most explicit form — it wins when both
are passed), `hours` as hour objects (matched by `validAt`, so
`windgramDisplayHours` output or one group from `derive`'s
`groupByLocalDay(hours, timeZone)` drops straight in), or `hours` as
`{ timeZone, dateKey }`, which renders one local calendar day. Absent all
three, every hour renders.

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

Ensemble documents from the 0.3.0 wave also declare their member count once,
in `run.members`; each `EnsembleValue`'s own `members` is the per-position
count of contributing members, which can be lower where members were
censored.

## Deterministic documents: escaping `p50` with one check

Code that only ever handles deterministic models shouldn't pay the `Scalar`
tax on every read. `isDeterministicProfile` narrows a parsed profile to
`DeterministicWindgramProfile` — the same document type with every `Scalar`
position narrowed to `number` — so after one check, `p50()` disappears:

```ts
import { isDeterministicProfile } from "windgram/contract";

if (isDeterministicProfile(profile)) {
  for (const hour of profile.hours) {
    const wStar = hour.derived.thermalVelocityMs; // number — no p50()
    const liftTopM = hour.derived.usableLiftTopM; // number | null
    console.log(hour.validAt, wStar.toFixed(1), liftTopM ?? "—");
  }
}
```

The guard is declaration-first: 0.3.0 ensemble documents declare
`run.members`, so its presence answers in O(1). When it is absent the
document may simply predate the declaration (`schemaVersion` stayed 1), so
the guard falls back to scanning the Scalar positions — a pre-declaration
ensemble document exits at the first percentile object it meets, while a
genuinely deterministic one pays a full pass (a few thousand property reads
on a real 48 h profile) to prove the negative. Run it once per document,
not per hour.

## Non-JS consumers

JSON Schema artifacts generated from the same zod schemas ship in the npm
package and repository under [`schema/`](schema/) —
`profile.schema.json`, `manifest.schema.json`, `models.schema.json`,
`sites.schema.json`, `runs.schema.json` — so any language with a JSON
Schema validator gets the identical contract, including every field's
semantics: the schemas carry the same descriptions the TypeScript JSDoc
does (gust and precipitation semantics, the derived quantities'
definitions and null conditions, the AGL-vs-MSL and Pa-vs-hPa
conventions). Regenerate with `pnpm schemas`; a test fails if the shipped
artifacts drift behind the zod contract.

## Exports

### `windgram/contract`

Zod schemas, inferred types, and safeParse guards for the five published
document kinds:

- `windgramProfileSchema` / `WindgramProfile` — the per-site profile at
  `data/<model-slug>/sites/<site-slug>.json` (history lines are the same
  document, one per line); its optional `semantics` tag echoes the model's
  gust and precipitation semantics per document;
- `windgramManifestSchema` / `WindgramManifest` — `data/<model-slug>/manifest.json`;
  `stats` is typed as the stable core (`downloads`, `downloadBytes`,
  `retries`, `durationMs`) plus an open numeric extension — the core keys
  are contract, everything else is transport-specific and unstable;
- `modelCatalogueSchema` / `ModelCatalogue` — `data/models.json`, the
  discovery catalogue (`runIntervalHours` and
  `capabilities.precipitation` required since 0.3.0);
- `sitesCatalogueSchema` / `SitesCatalogue` — `sites.json`, the site
  catalogue; each entry's `elevationM` is the launch's surveyed elevation,
  the same quantity a profile stores per-document as `site.altitudeM`
  (nullable there — a profile built before the survey keeps its null; the
  catalogue is current);
- `runsIndexSchema` / `RunsIndex` — `data/runs.json`, the cross-model run
  index keyed by model slug.

Guards come in pairs: `parseWindgramProfile(value)` for already-parsed
values and `parseWindgramProfileJson(text)` for raw stored strings (both
return the typed document or `null`); likewise `parseWindgramManifest…`,
`parseModelCatalogue…`, `parseSitesCatalogue…`, and `parseRunsIndex…`.

Deterministic narrowing: `DeterministicWindgramProfile` and
`isDeterministicProfile` (see
[Deterministic documents](#deterministic-documents-escaping-p50-with-one-check)).

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
  parameters (nothing hardcodes a timezone), `groupByLocalDay(hours,
  timeZone)` → `[{ dateKey, hours }]` for day tabs (each group feeds
  `buildScene`'s `hours` option directly), plus `localHourOfDay` and
  `localDateKey`;
- units: `msToKmh` (moved here from `windgram/scene` in 0.3.0 — it is a
  pure unit conversion, not scene geometry);
- smoothing: `smooth121`, the pipeline's retired 1-2-1 kernel as a renderer
  option (only across contiguous one-hour steps).

### `windgram/transport`

Fetching published documents correctly, with the runtime's fetch injected:
`loadProfile` (the manifest + profile pair through the reference-time skew
guard), `loadRuns` (the `data/runs.json` index), the pure pair check
`runsConsistent`, and `TransportHttpError`. No caching, no storage — see
[Transport](#transport-windgramtransport).

### `windgram/scene`

The headless renderer core: `buildScene(profile, options)` and the
`SceneGraph` types, `DEFAULT_OVERLAYS`, `DEFAULT_CAPE_CLASSES`,
hit-testing (`cursorReading`,
`xForHour`, `yForAltitude`, …), and the low-level geometry helpers the site's
own figures reuse (`windBarbPaths`, `sampledFieldPaths`, `curvedPath`,
`pointPath`, `interpolateVertical`). `msToKmh` remains re-exported here
through 0.3.x, deprecated — it moved to `windgram/derive` and the re-export
departs in 0.4.

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

## Versions

The document `schemaVersion` stays 1 across these releases: profile
additions are additive-optional, and consumers discover the rest from the
catalogue.

**0.3.0** — the first-consumer feedback wave.

- New `windgram/transport` subpath: `loadProfile` (the reference-time skew
  guard as a library, fetch-injected, no storage), `loadRuns`,
  `runsConsistent`, `TransportHttpError`.
- Deterministic narrowing: `DeterministicWindgramProfile` +
  `isDeterministicProfile` escape `p50()` with one check.
- Contract: profiles gain the optional `semantics` tag (gust and
  precipitation semantics echoed per document) and ensemble profiles
  declare `run.members`; new `sitesCatalogueSchema` (sites.json is now
  `{ schemaVersion, sites }`) and `runsIndexSchema` (`data/runs.json`)
  with their parse guards; `manifest.stats` is typed as the stable core
  (`downloads`, `downloadBytes`, `retries`, `durationMs`) plus an open
  numeric extension. **Stricter**: `runIntervalHours` and
  `capabilities.precipitation` are required — pre-0.3.0 catalogues no
  longer validate (published data updated in the same change).
- Ergonomics: `buildScene` accepts `hours` (hour objects or
  `{ timeZone, dateKey }`) beside `hourIndices`; `derive` gains
  `groupByLocalDay` and `msToKmh` (the latter moved from `scene`, where a
  deprecated re-export remains until 0.4).
- The JSON Schema artifacts now carry every field's semantics as
  descriptions, and `sites.schema.json` / `runs.schema.json` join them.

**0.2.0** — contract, derivations, scene graph, SVG serializer, presets.

## Developing

```sh
pnpm --dir packages/windgram test      # vitest
pnpm --dir packages/windgram build     # tsc -> dist/ (types + ESM)
pnpm --dir packages/windgram schemas   # regenerate schema/*.json
```

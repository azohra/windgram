# windgram

TypeScript companion to the windgram dataset published from
[github.com/azohra/windgram](https://github.com/azohra/windgram): the
published contract, the derivations that are pure functions of it, the
transport that fetches the documents consistently, and the reference renderer
(headless scene graph + SVG serializer).

```sh
npm install windgram
```

The package ships ESM with type declarations; the only dependency is zod.
Nothing touches the DOM, so these APIs run identically in Node,
workers, and browsers.

## Load a published document

Discover models from the catalogue. Each entry supplies the model slug and
declares its published capabilities. Load a manifest and profile through
`windgram/transport`: the two files can occupy independent cache entries, so
the transport verifies that they describe the same run (see
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
if ("miss" in loaded) {
  throw new Error(`${model.label}/dundee ${loaded.miss}: ${loaded.url}`);
}
const { manifest, profile, stale } = loaded;
if (stale) console.warn("run still syncing across the CDN — pair may span two runs");

console.log(`${model.label} at ${profile.site.name}, run ${profile.run.referenceTime}`);
```

The `parse…Json` guards return a typed document or `null`. Transport loaders
return the typed document or a `DocumentMiss`: `"absent"` for a 404 and
`"invalid"` when a response body fails its published contract.
(`parseWindgramProfile` and friends do the same for values you have already
`JSON.parse`d — history lines, for instance, are one profile document per
line.)

## Transport (`windgram/transport`)

The pipeline publishes a model's manifest and its site profiles as separately
cached files, so around a publish a manifest and profile fetched
together can describe **two different runs**. `loadProfile` performs the
consistency check: fetch the pair, compare `run.referenceTime`
against the manifest's, and on disagreement retry the pair once after a
short delay (default 1500 ms). It resolves to:

- `{ manifest, profile, stale: false }` — a consistent pair;
- `{ manifest, profile, stale: true }` — the pair still names different runs
  after the retry;
- `{ miss: "absent", url }` — the model or site returned 404;
- `{ miss: "invalid", url }` — a response body failed its contract guard.

Non-404 HTTP failures throw `TransportHttpError` instead of masking
themselves as absence. The pure pair check is exported too:
`runsConsistent(manifest, profile)` is true exactly when both documents
name the same model and run.

`fetch` is a parameter, not an import: pass the runtime's own (browser,
Node, workers — anything WHATWG-shaped), which keeps the module
runtime-agnostic and the rest of the package I/O-free. The transport performs
no caching or storage writes because keys, quotas, invalidation, and stale-pair
policy belong to the consumer. The transport
reports `stale`; callers can add a last-known-good store when their runtime
and cache policy require one.

`loadRuns({ fetch, baseUrl })` fetches `data/runs.json`, the cross-model run
index. It returns each published model's `referenceTime` and `generatedAt`,
keyed by slug. Consumers can compare those timestamps with the catalogue's
`runIntervalHours` under their own freshness policy.

## Depth one: data only (`contract` + `derive`)

For consumers bringing their own UI. Everything that is a pure function of
the published JSON lives in `windgram/derive`. The pipeline publishes the
authoritative `derived.*` values. Package functions can project those published
inputs with consumer parameters; for example, `usableLiftTopM` applies a chosen
sink rate without changing the document.

```ts
import { p50, stabilityClass, surfaceLapseCPer1000Ft, windgramDisplayHours } from "windgram/derive";

// Day windowing runs in a timezone the consumer chooses. Documents from the
// 0.4.0 wave echo their site's own zone (site.timeZone); older documents
// need one supplied. Defaults: local 07:00–21:00, days with ≥ 5 in-window hours.
const day = windgramDisplayHours(profile.hours, {
  timeZone: profile.site.timeZone ?? "America/Vancouver",
});

for (const hour of day) {
  const wStar = p50(hour.derived.thermalVelocityMs);
  const liftTopM = p50(hour.derived.usableLiftTopM); // null when lift can't beat sink
  const cape = hour.surface.capeJkg;
  console.log(
    hour.validAt,
    wStar === null ? "—" : wStar.toFixed(1),
    liftTopM ?? "—",
    cape === undefined ? "—" : (p50(cape) ?? "—"),
  );
}

// Derivations take plain numbers; ensemble positions go through p50 first.
const noon = day[Math.floor(day.length / 2)];
const first = noon?.levels[0];
if (noon && first) {
  const surfaceTemperatureC = p50(noon.surface.temperatureC);
  const heightM = p50(first.heightM);
  const temperatureC = p50(first.temperatureC);
  if (surfaceTemperatureC !== null && heightM !== null && temperatureC !== null) {
    const lapse = surfaceLapseCPer1000Ft(surfaceTemperatureC, profile.site.modelElevationM, {
      heightM,
      temperatureC,
    });
    if (lapse !== null) console.log(stabilityClass(lapse));
  }
}
```

Optional fields (`windGustMs`, `capeJkg`, `cinJkg`, `pblHeightM`, the cloud
layers and profile) exist only where a model publishes them. The catalogue's
`capabilities` declare presence and semantics: `capabilities.gust`
distinguishes an hour-max "gusting to" from an
instantaneous sample, and `capabilities.precipitation` an instantaneous
rate from a window mean. Documents from the 0.3.0 wave echo those
declarations in their own optional top-level `semantics` tag, so a stored
profile stays interpretable without the catalogue beside it. Render the
declaration; never fill a gap with zero.

## Statements with evidence (`windgram/analyze`)

`derive/` outputs quantities; `analyze/` outputs **statements**: typed
findings over one profile document, each carrying the thresholds that
produced it and an evidence block scoped to the hours it cites.
`ANALYZE_VOCABULARY_VERSION` versions the finding vocabulary; adding a kind
is a contract event. Version 3 defines eight kinds:

- `flyableWindow` / `liftCeiling` — restate the published derived series as
  time and height findings. Each finding records its W\* and height-over-launch
  thresholds; defaults are 0.9 m/s and 300 m, and callers can override them.
  `clippedAtStart` and `clippedAtEnd` identify windows that touch the document
  horizon.
- `quietDay` — records a local day with no qualifying window, the day's best
  W\* and lift depth, the effective thresholds, and which thresholds failed.
  `coverage.truncated` identifies incomplete local-day coverage.
- `capTiming` — relates CAPE growth and CIN erosion to the window close. It
  requires hourly deterministic documents with CIN.
- `windSummary` — max gust and max wind-in-band with altitude, timing, and
  persistence.
- `terrainMismatch` — model grid terrain vs surveyed launch, with the one
  arithmetic verdict (`liftTopEverReachesLaunch`).
- `ensembleMembership` — the per-quantity member-count profile (a p50
  can contain fewer contributors than the model's total membership) and
  band-width magnitude and trend.
- `dataCaveats` — reports absent quantity families, derived-null hours, and
  cadence notes.

```ts
import { analyzeProfile } from "windgram/analyze";

const analysis = analyzeProfile(profile); // local times from site.timeZone
for (const finding of analysis.findings) {
  if (finding.kind === "flyableWindow") {
    console.log(finding.day, finding.start.local, "→", finding.end.local,
      `peak ${finding.peakLiftTopAboveLaunchM} m over launch`);
  }
}
```

Verdict enums describe arithmetic relations over published numbers. Findings
remain scoped to one document. Cross-model statements live in
`windgram/compare`.

## Agreement with evidence (`windgram/compare`)

`compareProfiles` analyzes each document with one timezone and threshold set,
then compares the resulting statements. It preserves model elevation, cadence,
run age, and availability in the member ledger.

```ts
import { compareProfiles } from "windgram/compare";

const comparison = compareProfiles([hrdps, gfs, reps], {
  timeZone: "America/Vancouver",
  unavailable: [{ model: "nam", miss: "absent" }],
});

for (const finding of comparison.findings) {
  if (finding.kind === "windowAgreement") {
    console.log(finding.day, finding.windows.length, finding.quiet.length);
  }
  if (finding.kind === "heightSpread") {
    console.log(finding.day, finding.spreadM);
  }
}
```

`windowAgreement` reports qualifying-window votes, quiet-day votes,
abstentions, and an envelope over unclipped window edges. `heightSpread`
reports each model's launch-relative peak and their spread without averaging
them into a new forecast. Terrain-mismatched members, truncated quiet days,
and unavailable models remain visible in the comparison. The vocabulary
version is exported as `COMPARE_VOCABULARY_VERSION`.

## Choose an analysis payload

- Pass the parsed profile when the consumer needs every published field.
- Use `projectProfile` to select a local day, remove levels, or retain named
  fields. Projection only removes data.
- Use `analyzeProfile` when the consumer needs typed findings with their
  thresholds and supporting values.

Measure the serialized result against the consumer's actual input budget.
Projections and findings use `site.timeZone` unless the caller supplies an
override.

## Depth two: custom rendering with shared numbers (`scene`)

`buildScene(profile, options)` computes everything a chart needs — scales,
axis ticks, metric strips, classified field patches, derived-height series,
wind-barb and gust placements, markers, labels — as one typed, serializable
scene graph. No DOM: draw it with SVG, canvas, or another target. Interaction
can read the same scene scales and values used by the serializer.

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
for its page instead of hard-coding the reference proportions; `widthPx`
states the intent directly — a target total width, from which the column
width is derived after windowing, so a consumer filling a measured panel
never probe-builds to learn the gutters.

Presentation is parameterized too (all defaults preserve the reference
look). `hourLabel` sets the tick convention — `"24h"` (default), `"12h"`
(`7a … 12p … 9p`), or a formatter function — and threads through
everything the scene prints an hour in, ticks and aria label alike.
`surfaceTemperature` (an overlay, default on) prints the per-hour `<n>°`
row under the time axis. Barb density is geometry-aware: stride 1 wherever
the column pitch fits the glyph, a greedy pixel-gap walk up each column
where level spacing is dense, and a pitch-following glyph scale — pin or
force any of it with `barbStride`, `barbMinGapPx`, `barbScale`.
`markerStride` turns the single selected-hour cloud/wing glyphs into trains
along their lines. An object form such as `{ every: 2, offset: 1 }` phases a
train so coincident cloud-base and usable-lift markers can alternate hours.
`stripLabels` overrides strip display names
(`{ thermalStrength: "LIFT" }`) while keys and classes keep the honest
identity.

Two more options move conventions into the consumer's hands. `capeClasses`
sets the CAPE strip's class boundaries; the default,
`DEFAULT_CAPE_CLASSES` (calm < 300, watch < 800, risk < 1500,
severe ≥ 1500 J/kg, cells dimmed as capped at CIN ≤ −50), defines renderer
classes rather than weather-severity categories or operational thresholds.
`sinkRateMs` recomputes the usable-lift-top series
with `windgram/derive`'s parameterized `usableLiftTopM` instead of reading
the document's published value (which embeds the fixed 1.0 m/s convention);
at 1.0 the recomputed series equals the published one exactly. Ensemble
documents keep the published percentile series because recomputing from p50
inputs would differ from the pipeline's aggregated per-member derivation.

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
reference look, so a local colour override belongs on an ancestor — no fork:

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

Type and halos are tokens too: every font size the serializer sets is a
`--wg-text-*` custom property (`--wg-text-tick`, `--wg-text-strip-name`,
…), and the halo colour splits per element — `--wg-halo-series`,
`--wg-halo-barb`, `--wg-halo-marker`, `--wg-halo-text` — each falling back
to the shared `--wg-halo`, so one override still retints everything while
any element can be tuned, or switched off with `transparent`, alone.

For full control, pass `stylesheet: null` to omit the embedded sheet and
style the classes yourself; the exported `DEFAULT_STYLESHEET` string is the
reference to start from.

### The key

A windgram encodes meaning in line style, and nothing on the plot says
which is which. `buildKeySpec(scene)` (from `windgram/scene`) derives a
typed, serializable description of what that scene's key must say from
what it drew — series entries carrying the dash, stroke
width, and class name; the condensation-hatch chip; the eight-class
stability ramp with its boundaries straight from
`WINDGRAM_STABILITY_CLASSES`; the p25–p75 band note for ensemble scenes.
The key reads these facts from the scene instead of restating them.
`renderKeySvg(keySpec, options)` (from `windgram/svg`) is the
reference look: the centred swatch row, then the LAPSE RATE bar with
boundary values above the cell edges and group words inside. The same
`--wg-*` tokens style chart and key together; labels are the only prose,
overridable per entry id via `buildKeySpec`'s `labels` option. Consumers
building a focusable key (hover-to-preview, click-to-pin) read the spec
and draw their own.

```ts
import { buildKeySpec, buildScene } from "windgram/scene";
import { renderKeySvg } from "windgram/svg";

const scene = buildScene(profile, { timeZone });
const key = renderKeySvg(buildKeySpec(scene)); // place it under the chart
```

## Presentation defaults

The package ships one reference look. Override scene options and the `--wg-*`
tokens directly for another presentation. `DEFAULT_OVERLAYS`,
`DEFAULT_CAPE_CLASSES`, `TOKEN_DEFAULTS`, and `STABILITY_TOKEN_DEFAULTS`
export the reference values. The stability ramp keeps a pale background field
behind wind, height, marker, and temperature marks while preserving adjacent
colour-vision boundaries.

## Ensemble documents

Every numeric data position in `surface`, `levels`, and `derived` is a
`Scalar = number | EnsembleValue`: deterministic models publish numbers,
ensemble models publish `{members, p10, p25, p50, p75, p90, ceiledMembers?}`
in the same positions. Switch on shape, never on model name:

```ts
import { isEnsembleDropout, isEnsembleValue } from "windgram/contract";

const wind = profile.hours[0]?.surface.windSpeedMs;
if (wind !== undefined) {
  if (isEnsembleValue(wind)) {
    if (isEnsembleDropout(wind)) console.log("no contributing members");
    else console.log(`p50 ${wind.p50} m/s, p10–p90 ${wind.p10}–${wind.p90}, ${wind.members} members`);
  } else {
    console.log(`${wind} m/s`);
  }
}
```

`p50(scalar)` returns the numeric value or ensemble median. It returns `null`
for `null` and for full dropout (`members: 0` with every percentile `null`).
The scene renders dropout positions as gaps and drops a level or hour whose
required positions have no contributing members. Ensemble series render their
p50 line with p25–p75 band geometry wherever percentiles exist.

Ensemble documents from the 0.3.0 wave also declare their member count once,
in `run.members`; each `EnsembleValue`'s own `members` is the per-position
count of contributing members, which can be lower where members were censored
or zero for full dropout.

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
  catalogue is current), and each entry's `timeZone` (required since
  0.4.0) is the launch's IANA timezone, echoed per-profile as the optional
  `site.timeZone`;
- `runsIndexSchema` / `RunsIndex` — `data/runs.json`, the cross-model run
  index keyed by model slug.

Guards come in pairs: `parseWindgramProfile(value)` for already-parsed
values and `parseWindgramProfileJson(text)` for raw stored strings (both
return the typed document or `null`); likewise `parseWindgramManifest…`,
`parseModelCatalogue…`, `parseSitesCatalogue…`, and `parseRunsIndex…`.

Deterministic narrowing: `DeterministicWindgramProfile` and
`isDeterministicProfile` (see
[Deterministic documents](#deterministic-documents-escaping-p50-with-one-check)).
`isEnsembleValue` narrows percentile objects; `isEnsembleDropout` identifies
the all-null, zero-member shape.

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
  `buoyancyShearRatio` (W* ÷ BL shear). Surface-to-boundary-layer shear
  assumes both winds describe the same air mass; terrain-driven valley
  circulation can violate that assumption. Use the height-resolved
  `windShear` field when terrain separates the layers;
- usable lift: `usableLiftTopM` — the pipeline's hcrit derivation with the
  sink rate as a parameter, over published inputs only. The published
  `derived.usableLiftTopM` embeds a fixed **1.0 m/s** sink rate — that
  convention is part of the published value — and the default here
  reproduces it exactly (asserted against a pipeline fixture); other sink
  rates project the same inputs without republishing them (the scene option
  `sinkRateMs` wires this into the renderer);
- day windowing: `windgramDisplayHours` with timezone and day bounds as
  parameters (nothing hardcodes a timezone), `groupByLocalDay(hours,
  timeZone)` → `[{ dateKey, hours }]` for day tabs (each group feeds
  `buildScene`'s `hours` option directly), plus `localHourOfDay` and
  `localDateKey`;
- projection: `projectProfile(profile, { day?, timeZone?, dropLevels?,
  fields? })` — window to one local day (the document's `site.timeZone` by
  default), strip levels, and select field subsets per block. Projection
  only removes data and applies no thresholds;
- alignment: `alignByValidAt(profiles)` — the minimal cross-document join:
  the instants every profile publishes, chronological, each row carrying
  the models' own hours keyed by slug. Rows are quantities, not claims;
  elevation, semantics, and staleness differences remain visible;
- units: `msToKmh`, a pure m/s-to-km/h conversion;
- smoothing: `smooth121`, a 1-2-1 renderer option that applies only across
  contiguous one-hour steps.

### `windgram/analyze`

Typed findings over one profile document (see
[Statements with evidence](#statements-with-evidence-windgramanalyze)):
`analyzeProfile(profile, { timeZone?, thresholds? })` →
`WindgramAnalysis`, the finding types (`WindgramFinding` and its eight
kinds), `DEFAULT_ANALYZE_THRESHOLDS` (embedded in every finding they shape
and overridable per call), `resolveAnalyzeThresholds`, and
`ANALYZE_VOCABULARY_VERSION`. Analyze findings remain scoped to one document.

### `windgram/compare`

`compareProfiles(profiles, { timeZone, thresholds?, unavailable? })` returns
`WindgramComparison`: a member ledger, per-day `windowAgreement` findings,
per-day `heightSpread` findings, the source analyses, and
`COMPARE_VOCABULARY_VERSION`.

### `windgram/transport`

Fetching published documents correctly, with the runtime's fetch injected:
`loadProfile` (the manifest + profile pair through the reference-time skew
guard), `loadRuns` (the `data/runs.json` index), the pure pair check
`runsConsistent`, the discriminated `DocumentMiss`, and `TransportHttpError`.
No caching, no storage — see
[Transport](#transport-windgramtransport).

### `windgram/scene`

The headless renderer core: `buildScene(profile, options)` and the
`SceneGraph` types, `DEFAULT_OVERLAYS`, `DEFAULT_CAPE_CLASSES`, the key
facts (`buildKeySpec`, the `KeySpec` types), hit-testing (`cursorReading`,
`xForHour`, `yForAltitude`, `scales.surfaceWindY`, …), and the low-level geometry helpers the site's
own figures reuse (`windBarbPaths`, `BARB_GLYPH_RADIUS`,
`sampledFieldPaths`, `curvedPath`, `pointPath`, `interpolateVertical`).
`sampledFieldPaths` takes ordered `{ breakpoints, classNames }` banding and
returns interpolated iso-band paths. Fill `FieldLayer` paths with
`fill-rule="evenodd"`; the reference SVG serializer does this automatically.
The deprecated `msToKmh` re-export departed in 0.4.0 as promised — import
it from `windgram/derive`.

### `windgram/svg`

The reference serializer: `renderSvg(scene, options)` and
`renderKeySvg(keySpec, options)`, `DEFAULT_STYLESHEET`, the token-default
maps (`TOKEN_DEFAULTS`, `STABILITY_TOKEN_DEFAULTS`), and the
`RenderSvgOptions` type (`stylesheet`, `idPrefix`). Output is
deterministic — stable element ordering, two-decimal rounding — and golden
fixtures in `test/golden/` lock it down.

## Authority boundary

The pipeline (Python) owns stored values that need provider inputs or
cross-run authority: W\*,
boundary-layer top, cloud base, and usable-lift top. This package owns pure
functions of the published JSON: RH, TI, shear, B/S, lapse, stability,
windowing, smoothing, and consumer-parameter projections such as a different
usable-lift sink rate. A projection does not replace the document's published
value.

Release history lives in the repository
[CHANGELOG](https://github.com/azohra/windgram/blob/main/CHANGELOG.md).

## Developing

```sh
pnpm --dir packages/windgram test      # vitest
pnpm --dir packages/windgram build     # tsc -> dist/ (types + ESM)
pnpm --dir packages/windgram schemas   # regenerate schema/*.json
```

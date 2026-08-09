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
if ("miss" in loaded) {
  // "absent" is routine (site outside the model's domain); "invalid" is a
  // contract break and should be loud — that's why they're discriminated.
  throw new Error(`${model.label}/dundee ${loaded.miss}: ${loaded.url}`);
}
const { manifest, profile, stale } = loaded;
if (stale) console.warn("run still syncing across the CDN — pair may span two runs");

console.log(`${model.label} at ${profile.site.name}, run ${profile.run.referenceTime}`);
```

Everything arrives contract-validated: the `parse…Json` guards return the
typed document or `null`, and the transport turns that into a
discriminated miss — `{ miss: "invalid" }` from a URL that served 200
means publisher and consumer disagree about the contract; fail loudly
rather than patching around it, and never confuse it with `"absent"`.
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
- `{ miss: "absent", url }` — a 404: the model or site is simply not
  published here (a site outside a model's domain reads this way; routine,
  rarely worth a log line);
- `{ miss: "invalid", url }` — the document exists but failed the contract
  guards: a contract break or pre-release prototype data. It must not
  render as garbage, and — the reason the two are discriminated — it must
  not hide as a 404 either: log it loudly. Discriminate with
  `"miss" in result`.

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

// Day windowing runs in a timezone the consumer chooses. Documents from the
// 0.4.0 wave echo their site's own zone (site.timeZone); older documents
// need one supplied. Defaults: local 07:00–21:00, days with ≥ 5 in-window hours.
const day = windgramDisplayHours(profile.hours, {
  timeZone: profile.site.timeZone ?? "America/Vancouver",
});

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

## Statements with evidence (`windgram/analyze`)

`derive/` outputs quantities; `analyze/` outputs **statements**: typed
findings over one profile document, each carrying the thresholds that
produced it and an evidence block scoped to the hours it cites. The
vocabulary is deliberately small and versioned
(`ANALYZE_VOCABULARY_VERSION`) — adding a kind is a contract event.
Version 1 shipped exactly the kinds that survived the 2026-08 evidence
spikes; version 2 adds `quietDay` on production consumer evidence:

- `flyableWindow` / `liftCeiling` — the compression anchors. They restate
  the published derived series on purpose: their value is compressing a
  13–72k-token document into a ~1–2k statement of when and how high, plus
  the timing anchor the other findings reference. Window thresholds
  (W\* ≥ 0.9 m/s, ≥ 300 m over launch) are embedded in every finding and
  caller-movable; the spike's sensitivity sweep measured them low-impact.
- `quietDay` — the negative stated with evidence: a local day with no
  flyable window carries the numbers that failed (the day's best W\* and
  lift depth against the embedded floors, plus which floors failed), so a
  consumer's headline can say *why* instead of only "no window". Its
  `coverage` block carries the arithmetic `truncated` verdict — a quiet
  call built from a sliver of a day (a short-horizon run ending before
  the thermals start) is a data boundary, not a forecast, and must not
  vote in cross-model comparisons. `flyableWindow` mirrors the same
  honesty on the positive side with `clippedAtStart`/`clippedAtEnd`: a
  window abutting the document's own hour range reads as ≥/≤, not as
  opening or decay.
- `capTiming` — CAPE build vs CIN erosion vs the window's close, gated to
  hourly deterministic documents with CIN (ensemble-median CIN is bimodal;
  3-hourly cap timing is interpolation).
- `windSummary` — max gust and max wind-in-band with altitude, timing, and
  persistence. Magnitudes only, no hazard verdicts (the spikes' null
  result; its JSDoc has the story).
- `terrainMismatch` — model grid terrain vs surveyed launch, with the one
  arithmetic verdict (`liftTopEverReachesLaunch`).
- `ensembleMembership` — the per-quantity member-count profile (a p50
  computed from 5-of-21 contributing members is a landmine) and band-width
  magnitude/trend. Not called confidence, because it isn't.
- `dataCaveats` — what the document cannot say: absent quantity families,
  derived-null hours, cadence notes. Threshold-free.

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

Verdict enums appear only where the verdict is an arithmetic relation over
published numbers; everything judgment-shaped ("flyable" beyond the stated
arithmetic, "hazard", "confidence") stays downstream where it belongs.
Findings are single-document by charter: cross-model statements live in
`windgram/compare`, which compares these findings — never raw series.

## Agreement with evidence (`windgram/compare`)

Humans open three windgrams to read agreement and disagreement; naive
cross-model comparison of the raw numbers reads mostly artifacts (grid
elevation deltas, gust semantics families, run staleness, cadence — the
documented reason the early consensus/outlier trials died).
`compareProfiles(profiles, { timeZone })` does what a careful human does,
explicitly: it analyzes every member with one timezone and one threshold
set, then compares the *statements*.

```ts
import { compareProfiles } from "windgram/compare";

const comparison = compareProfiles([hrdps, gfs, reps], {
  timeZone: "America/Vancouver",
  unavailable: [{ model: "nam", miss: "absent" }], // the roster names the whole field
});
for (const finding of comparison.findings) {
  if (finding.kind === "windowAgreement") {
    // per local day: window votes, quiet votes (with the numbers that
    // failed), abstentions with reasons, and a timing envelope over the
    // edges that are forecasts rather than data boundaries.
  }
  if (finding.kind === "heightSpread") {
    // launch-relative peaks per model + the spread — divergence stated,
    // never averaged: no consensus height exists that any model forecast.
  }
}
```

Every non-vote has a stated reason: a member whose lift never reaches
launch is benched in the `members` ledger (`terrainMismatch` — the case
where a model's grid puts the site 1,300 m below the real launch); a
truncated quiet day abstains (a model lacking a day's data does not get
to call the day); a horizon-clipped window edge stays out of the timing
envelope. The ledger states run age, cadence, and elevation deltas as
facts for downstream judgment — weighting is deliberately not applied
here. The vocabulary is versioned like analyze's
(`COMPARE_VOCABULARY_VERSION`), and version 1 ships exactly the kinds the
2026-08-09 findings spike earned: over nine live documents, 8/8
comparable models were unanimous on window existence with ends within an
hour of each other, while value-level consensus over the same corpus had
measured mostly artifacts.

## Feeding a windgram to an LLM

The dataset was built to be self-describing — SI field names, per-document
`semantics` tags, declared absences — so the honest recipe is raw documents
plus the published reading context, projected down only as far as the
budget requires. Measured budgets (2026-08 spikes, chars/4; dense JSON
tokenizes ~25 % worse):

| Payload | ≈ tokens |
| --- | ---: |
| one deterministic profile, full horizon, with reading context¹ | 13–14k |
| one GEPS ensemble document, full horizon, raw | 72k |
| one local day (`projectProfile({ day })`) | ~7.7k |
| one day, levels stripped (`dropLevels`) | ~2.4k |
| one day, derived-block field selection | ~0.5–1.5k |
| `analyzeProfile` findings, evidence included | 0.8–2.2k |

¹ profile + its models.json entry + the "reading a windgram" and
derivations articles from `research/`.

When each is appropriate:

- **Raw document + reading context** — the default. One site, one or a few
  models: it fits any current frontier context with room to spare, and the
  LLM sees everything, including what a findings pass would summarize away.
- **`projectProfile`** — when horizons multiply (all-model comparison at
  one site: ~229k raw, ~48k day-windowed, ~10k derived-only) or sites do
  (a 40-site scan fits under derived-only projection). Pure subtraction:
  nothing is judged on the way down.
- **`analyzeProfile` findings** — when the budget is tight, the sites are
  many, or you want the model reasoning over claims it can check: every
  finding carries its thresholds and the published numbers it derives
  from, so the LLM (or a human) can audit the statement against the
  evidence in the same payload. Verdicts exist only where they are
  arithmetic; everything else is magnitudes and timing.

Local time is load-bearing for all three: documents carry `site.timeZone`
(0.4.0 wave), findings and projections use it, and the caller can override
it.

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
`markerStride` turns the single selected-hour cloud/wing glyphs into
trains along their lines. `stripLabels` overrides strip display names
(`{ thermalStrength: "LIFT" }`) while keys and classes keep the honest
identity.

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
what it actually drew — series entries carrying the REAL dash, stroke
width, and class name; the condensation-hatch chip; the eight-class
stability ramp with its boundaries straight from
`WINDGRAM_STABILITY_CLASSES`; the p25–p75 band note for ensemble scenes.
Every fact is inherited, never copied, so a key cannot drift from its
chart. `renderKeySvg(keySpec, options)` (from `windgram/svg`) is the
reference look: the centred swatch row, then the LAPSE RATE bar with
boundary values above the cell edges and group words inside. The same
`--wg-*` tokens theme chart and key together; labels are the only prose,
overridable per entry id via `buildKeySpec`'s `labels` option. Consumers
building a focusable key (hover-to-preview, click-to-pin) read the spec
and draw their own.

```ts
import { buildKeySpec, buildScene } from "windgram/scene";
import { renderKeySvg } from "windgram/svg";

const scene = buildScene(profile, { timeZone });
const key = renderKeySvg(buildKeySpec(scene)); // place it under the chart
```

## One look, no themes

The package ships one look — the reference defaults — and consumers who
want a different one override the `--wg-*` tokens and scene options
directly; there is no theme catalogue and no preset concept (the
`windgram/presets` subpath departed in 0.6.0 — its one real job, naming
the defaults, is done by the exports that ARE the defaults:
`DEFAULT_OVERLAYS`, `DEFAULT_CAPE_CLASSES`, `TOKEN_DEFAULTS`,
`STABILITY_TOKEN_DEFAULTS`). The reference look's stability hues follow
the aerogram convention this pipeline gratefully inherits from
[canadarasp](https://github.com/ajberkley/canadarasp) — warm instability
over a receding stable field — hardened for colour-vision deficiency
(see `STABILITY_TOKEN_DEFAULTS`' JSDoc for exactly what is and is not
promised).

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

`p50(scalar)` collapses either shape to the median (null passes through),
so deterministic code paths work on ensemble profiles unchanged — noting
that since 0.7.0 its return is honestly `number | null` for any Scalar,
because of dropout (below). The scene graph handles the rest itself:
ensemble series render their p50 line with p25–p75 band geometry wherever
percentiles exist, a model without levels gracefully drops barbs, fields,
and isotherms, and a dropout position renders as a gap.

Ensemble documents from the 0.3.0 wave also declare their member count once,
in `run.members`; each `EnsembleValue`'s own `members` is the per-position
count of contributing members, which can be lower where members were
censored — all the way to **full dropout**: `members: 0` with every
percentile `null` means the run asked every member and none produced a
value at this position. That is a published fact, distinct from both "not
published" (the field is absent) and a forecast of none (the position is
plain `null`); `isEnsembleDropout(value)` names it, `p50()` of it is
`null`, and `analyze`'s `ensembleMembership` finding is where it surfaces
as a statement.

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
- projection: `projectProfile(profile, { day?, timeZone?, dropLevels?,
  fields? })` — window to one local day (the document's `site.timeZone` by
  default), strip levels, select field subsets per block. Pure
  subtraction, no thresholds; the budgets it buys are tabulated in
  [Feeding a windgram to an LLM](#feeding-a-windgram-to-an-llm);
- alignment: `alignByValidAt(profiles)` — the minimal cross-document join:
  the instants every profile publishes, chronological, each row carrying
  the models' own hours keyed by slug. Rows are quantities, not claims —
  elevation, semantics, and staleness differences are deliberately left
  visible;
- units: `msToKmh` (moved here from `windgram/scene` in 0.3.0 — it is a
  pure unit conversion, not scene geometry);
- smoothing: `smooth121`, the pipeline's retired 1-2-1 kernel as a renderer
  option (only across contiguous one-hour steps).

### `windgram/analyze`

Typed findings over one profile document (see
[Statements with evidence](#statements-with-evidence-windgramanalyze)):
`analyzeProfile(profile, { timeZone?, thresholds? })` →
`WindgramAnalysis`, the finding types (`WindgramFinding` and its eight
kinds), `DEFAULT_ANALYZE_THRESHOLDS` (the spikes' constants, embedded in
every finding they shape, caller-movable per call), and
`ANALYZE_VOCABULARY_VERSION`. The module docs carry the charter: analyze
is single-document by evidence; cross-document statements live in
`windgram/compare`.

### `windgram/compare`

Typed statements over one site's documents across models (see
[Agreement with evidence](#agreement-with-evidence-windgramcompare)):
`compareProfiles(profiles, { timeZone, thresholds?, unavailable? })` →
`WindgramComparison` — the member ledger (`ComparisonMemberLedger`,
benching included), `windowAgreement` and `heightSpread` findings, and
`COMPARE_VOCABULARY_VERSION`. Statements are compared, never raw series;
agreement is reported, never manufactured.

### `windgram/transport`

Fetching published documents correctly, with the runtime's fetch injected:
`loadProfile` (the manifest + profile pair through the reference-time skew
guard), `loadRuns` (the `data/runs.json` index), the pure pair check
`runsConsistent`, and `TransportHttpError`. No caching, no storage — see
[Transport](#transport-windgramtransport).

### `windgram/scene`

The headless renderer core: `buildScene(profile, options)` and the
`SceneGraph` types, `DEFAULT_OVERLAYS`, `DEFAULT_CAPE_CLASSES`, the key
facts (`buildKeySpec`, the `KeySpec` types), hit-testing (`cursorReading`,
`xForHour`, `yForAltitude`, …), and the low-level geometry helpers the site's
own figures reuse (`windBarbPaths`, `BARB_GLYPH_RADIUS`,
`sampledFieldPaths`, `curvedPath`, `pointPath`, `interpolateVertical`).
The deprecated `msToKmh` re-export departed in 0.4.0 as promised — import
it from `windgram/derive`.

### `windgram/svg`

The reference serializer: `renderSvg(scene, options)` and
`renderKeySvg(keySpec, options)`, `DEFAULT_STYLESHEET`, the token-default
maps (`TOKEN_DEFAULTS`, `STABILITY_TOKEN_DEFAULTS`), and the
`RenderSvgOptions` type (`stylesheet`, `idPrefix`). Output is
deterministic — stable element ordering, two-decimal rounding — and golden
fixtures in `test/golden/` lock it down.

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

**0.8.0** — `windgram/compare`: agreement with evidence.

- New subpath, occupying the name analyze's charter reserved, on the
  evidence that reservation demanded: the 2026-08-09 findings spike over
  nine live documents, where statement-level agreement tracked real
  forecast divergence (8/8 comparable models unanimous on window
  existence; ends within 1 h once clipped edges stopped voting) while
  value-level consensus over the same corpus had measured artifacts.
- `compareProfiles(profiles, { timeZone, thresholds?, unavailable? })`
  analyzes every member identically, then compares statements: the
  comparability ledger (kind, cadence, run age, elevation delta,
  terrain benching), `windowAgreement` per local day (window votes,
  quiet votes with their failed numbers, truncation abstentions, timing
  envelopes over unclipped edges), and `heightSpread` (per-model
  launch-relative peaks + spread — divergence stated, never averaged).
- `analyze` exports `resolveAnalyzeThresholds` so the comparison envelope
  echoes the resolved threshold set without restating the merge.

**0.7.0** — full ensemble dropout is a valid published fact; horizon
truncation is named on both sides of the window vocabulary.

- Contract: `EnsembleValue` admits exactly one new shape — `members: 0`
  with every percentile `null` (nothing in between) — the form the live
  GEPS/REPS documents already publish at hours where no member produced a
  value. Both ECCC ensembles had become unreadable by the package's own
  guards (`loadProfile` returned `miss: "invalid"`); the schema was
  stricter than the honest data. `isEnsembleDropout` names the shape;
  `schema/*.json` regenerated.
- **Breaking (types)**: `p50()` returns `number | null` for any Scalar —
  a dropout has no median. The scene renders dropout positions as gaps
  and drops a level or hour whose core positions lost every member;
  `analyze` carries dropout through membership counts and skips it in
  band evidence.
- `analyze` vocabulary v3: `quietDay.coverage` (hours, first/last cited
  instants, the `truncated` verdict) and
  `flyableWindow.clippedAtStart/clippedAtEnd` — the findings spike over
  nine live documents showed a short-horizon run voting "quiet" on
  pre-thermic hours alone, and window end-times spreading 7 h purely from
  horizon clipping (1 h once clipped edges stop voting). A model lacking
  a day's data does not get to call the day.

**0.6.0** — the reference look, re-founded on the field-is-background
principle; one look, no themes.

- The stability ramp is replaced: the pale-register palette proven in
  production by the first consumer, hardened where the validator found
  real hazards (the deutan-blind conditional pair separated, the cool
  tail internally light-ordered) — five of eight values are the
  production palette's exactly. The old monotone-lightness ramp
  optimized the wrong layer: it bought class-boundary ΔE with the
  figure-ground contrast of everything drawn on top.
  `STABILITY_TOKEN_DEFAULTS`' JSDoc states precisely what the pale
  register does and does not promise.
- Barbs are white (`--wg-wind`) with a fine slate rim (`--wg-halo-barb`)
  — legible on every field cell and, unlike bare white, on the plain
  paper of models that publish no levels; set the rim `transparent` for
  the bare look. Series halos default off (`--wg-halo-series:
  transparent`) — the dash-by-dash halo read as fuzz in production.
- **Breaking**: the `windgram/presets` subpath is removed. The package
  ships one look; the defaults' one-home exports (`DEFAULT_OVERLAYS`,
  `DEFAULT_CAPE_CLASSES`, `TOKEN_DEFAULTS`, `STABILITY_TOKEN_DEFAULTS`)
  replace `REFERENCE_PRESET`, and the canadarasp lineage stays credited
  where it is inherited.
- Marker trains take a phase (`markerStride: { usableLiftTop: { every: 2,
  offset: 1 } }`) so trains on lines that can coincide alternate hours —
  lift is capped at cloud base by contract, so a cloud with no wing means
  "lift to base"; strips hold their terminal values flat to the plot
  edges, closing the data-less half-column at each end; the surface barb
  row sits clear of the plot floor instead of being bisected by it, with
  `scales.surfaceWindY` exposed for hit-testing.
- **Breaking**: `loadProfile` and `loadRuns` return a discriminated
  `DocumentMiss` (`{ miss: "absent" | "invalid", url }`) instead of bare
  `null`, so a site outside a model's domain and a contract break stop
  presenting identically to logging pipelines.
- `analyze` vocabulary v2: the new `quietDay` finding states a windowless
  day's evidence (the day's best numbers against the embedded floors)
  instead of leaving the negative to absence; `day` fields are typed
  `LocalDayKey` with the zone-pairing contract documented, and
  `CitedInstant.local` documents that voice formatting is deliberately
  downstream.

**0.5.0** — the presentation wave: the second consumer feedback list, plus
the key.

- The default render changes, deliberately (goldens regenerated once):
  strip scales print at each strip's right edge (max top, min bottom);
  the per-hour surface-temperature row appears under the time axis (the
  `surfaceTemperature` overlay, on by default); barb density is
  geometry-aware on both axes with a pitch-following glyph scale, and the
  glyph itself spaces feathers wider on a longer shaft so stacks read as
  feathers, not blobs; the surface wind row sits half a glyph height
  clear of the plot floor instead of being bisected by it, with the gust
  readouts just above the glyphs' reach and the placed row exposed as
  `scales.surfaceWindY` for hit-testing.
- New scene options, all defaulting to the reference conventions:
  `hourLabel` (`"24h"` | `"12h"` | formatter, threaded through ticks and
  aria label), `barbStride` / `barbMinGapPx` / `barbScale`, `widthPx`
  (container fit), `markerStride` (glyph trains), `stripLabels` (display
  voice; identity stays).
- The key: `buildKeySpec(scene)` derives the typed key facts from what
  the scene drew — real dashes, widths, classes, and the stability
  boundaries from `WINDGRAM_STABILITY_CLASSES` — and
  `renderKeySvg(keySpec)` is the reference look; tokens theme chart and
  key together, and tests assert the spec against the scene so the two
  cannot drift.
- The token surface grows: `--wg-text-*` type-scale tokens for every
  font size the serializer sets, per-element halo tokens
  (`--wg-halo-series/-barb/-marker/-text`, each falling back to
  `--wg-halo`, `transparent` as the off-switch), and `--wg-temp` for the
  temperature row.

**0.4.0** — the analysis-minimum wave, built to the evidence spikes'
verdicts.

- New `windgram/analyze` subpath: `analyzeProfile` and the version-1
  finding vocabulary — exactly the kinds the spikes endorsed, thresholds
  embedded, evidence scoped, verdicts only where arithmetic (see
  [Statements with evidence](#statements-with-evidence-windgramanalyze)).
- `derive` gains `projectProfile` (day window / levels strip / field
  selection — the LLM-budget subtraction) and `alignByValidAt` (the
  minimal cross-document join).
- Contract: site catalogue entries **require** `timeZone` (IANA) —
  pre-0.4.0 catalogues no longer validate (published data updated in the
  same change, the 0.3.0 `runIntervalHours` precedent) — and profile
  `site.timeZone` echoes it, optional: local time is load-bearing for
  reading a windgram, and stored documents self-interpret their clock.
- The README gains the measured
  [Feeding a windgram to an LLM](#feeding-a-windgram-to-an-llm) recipe.
- Removed: `windgram/scene`'s deprecated `msToKmh` re-export, as the
  0.3.x deprecation promised; import from `windgram/derive`.

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

# Windgram

![Windgram publication pipeline and package-rendered reference windgram](docs/assets/readme-hero.svg)

<p align="center">
  <strong>An open pipeline and renderer for inspectable free-flight windgrams.</strong><br>
  A Python publication pipeline, a static JSON contract, and a headless TypeScript toolkit in one repository.
</p>

<p align="center">
  <a href="https://windgram.azohra.com">Project site</a> ·
  <a href="https://windgram.azohra.com/docs/overview/">Documentation</a> ·
  <a href="packages/windgram/README.md">Integration guide</a> ·
  <a href="research/README.md">Research</a> ·
  <a href="reference/forecast-model-feeds.md">Feed reference</a> ·
  <a href="sites.json">Site catalogue</a>
</p>

Windgram generates versioned profile documents and supplies the tools to validate and render them.
Clubs, pilots, and other downstream publishers decide where, when, and for whom those documents are
presented.

## The whole path, in one repository

Windgram carries a forecast from provider files to an inspectable chart. The layers are independent: use the published profiles without running a builder, bring the typed data into a custom UI, or use the reference renderer end to end.

| Layer | Home | What it provides |
| --- | --- | --- |
| **Python publication pipeline** | [`windgram/`](windgram/) | Fetches ECCC and NOAA model fields, samples each catalogued launch, derives soaring quantities, and publishes current runs plus history. |
| **Static data contract** | [`data/`](data/) | A discoverable model catalogue, manifests, versioned site profiles, and append-only archives. |
| **TypeScript toolkit** | [`packages/windgram`](packages/windgram/) | Zod schemas and types, pure derivations, typed findings, transport guards, a serializable scene graph, hit-testing, the reference SVG renderer, and a scene-derived key. |
| **Project website** | [`site/`](site/) | Documentation, research, and reproducible teaching figures built with the same npm package available to every consumer. |

Profiles include surface conditions, winds and temperatures aloft, thermal velocity, boundary-layer top, cloud base, and usable-lift top. [`data/models.json`](data/models.json) declares each model's capabilities and semantics.

### Use the data directly

```sh
curl -sS https://raw.githubusercontent.com/azohra/windgram/main/data/hrdps-continental/sites/dundee.json \
  | jq '.hours[] | {validAt} + .derived'
```

### Build with TypeScript

```sh
npm install windgram
```

```ts
import { parseWindgramProfileJson } from "windgram/contract";
import { buildScene } from "windgram/scene";
import { renderSvg } from "windgram/svg";

const profileUrl =
  "https://raw.githubusercontent.com/azohra/windgram/main/data/hrdps-continental/sites/dundee.json";
const response = await fetch(profileUrl);
const profile = parseWindgramProfileJson(await response.text());
if (!profile) throw new Error("profile failed contract validation");

const svg = renderSvg(buildScene(profile, { timeZone: "America/Vancouver" }));
```

The [integration guide](packages/windgram/README.md) covers the contract, derivations, analysis, transport, scene graph, rendering tokens, ensemble documents, and every export.

## Published data

The repository publishes static profiles for a subset of catalogued launches. GitHub’s CDN exposes
the artifacts through stable paths:

```text
https://raw.githubusercontent.com/azohra/windgram/main/data/models.json
https://raw.githubusercontent.com/azohra/windgram/main/data/<model>/manifest.json
https://raw.githubusercontent.com/azohra/windgram/main/data/<model>/sites/<slug>.json
```

[`data/models.json`](data/models.json) is the discovery authority for model
identity, grid, cadence, horizon, kind, capabilities, levels, and lifecycle.
The [forecast model feed reference](reference/forecast-model-feeds.md) records
provider sources and verification dates.

The [profile document reference](https://windgram.azohra.com/docs/reference/profile-document/)
defines the published blocks and identity fields. The
[schemas and units reference](https://windgram.azohra.com/docs/reference/schemas-and-units/)
defines validation and units. The npm package ships the same document schemas
for TypeScript and non-JavaScript consumers.

Past forecasts are append-only gzip archives, one profile document per line, one file per month of the run's `referenceTime`:

```text
data/<model>/history/<slug>/<YYYY-MM>.jsonl.gz
```

```sh
gzip -cd data/nam/history/dundee/2026-08.jsonl.gz | jq -r .run.referenceTime
```

## TypeScript package

[`packages/windgram`](packages/windgram/) is the TypeScript companion,
published to npm as `windgram`. Its subpaths validate documents, derive pure
quantities, analyze one profile, compare findings across models, load static
publications, build scene graphs, and serialize the reference SVG and key.
The site uses the same exports.

## Run the Python publishers

Python 3.12 and [uv](https://docs.astral.sh/uv/) are required.

```sh
uv sync --frozen
uv run windgram build --model hrrr-conus --dry-run
uv run pytest
```

The [publisher documentation](https://windgram.azohra.com/docs/publish/run-one-model/)
covers external site catalogues, output paths, smoke caps, and full builds.

The ECCC builders stream whole-domain Datamart GRIB2: each file is fetched into memory, sampled at the catalogued sites, and dropped before the next. That moves real volume — roughly 4–9 GiB per deterministic run and 9–14 GiB per ensemble run. The NOAA builders (HRRR, GFS, NAM) fetch only the needed records by byte range against the `.idx` sidecars. Do not run a builder more often than its model publishes.

## Add a site

Add its slug, name, launch coordinates, elevation, and IANA timezone to [`sites.json`](sites.json). The next successful build publishes it for every model whose domain covers the coordinates.

## Licence

ECCC source data is used under the [Environment and Climate Change Canada Data Server End-use Licence](https://eccc-msc.github.io/open-data/licence/readme_en/); derived profiles retain its attribution requirement. NOAA HRRR, GFS, and NAM data are public-domain products distributed through the [Open Data Dissemination program](https://www.noaa.gov/information-technology/open-data-dissemination). Code is [MIT licensed](LICENSE).

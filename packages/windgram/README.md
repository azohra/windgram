# windgram

TypeScript companion to the windgram dataset published from
[github.com/azohra/windgram](https://github.com/azohra/windgram): the
published contract, the derivations that are pure functions of it, the
transport that fetches the documents consistently, and the reference renderer
(headless scene graph + SVG serializer).

[![npm version](https://img.shields.io/npm/v/windgram)](https://www.npmjs.com/package/windgram)
[![CI](https://img.shields.io/github/actions/workflow/status/azohra/windgram/ci.yml?branch=main&label=CI)](https://github.com/azohra/windgram/actions/workflows/ci.yml)
[![licence](https://img.shields.io/github/license/azohra/windgram?label=licence)](https://github.com/azohra/windgram/blob/main/LICENSE)

![Typed data in, chart out: the package validates a published profile document and serializes the reference windgram](https://raw.githubusercontent.com/azohra/windgram/main/docs/assets/package-hero.svg)

```sh
npm install windgram
```

The package ships ESM with type declarations; the only dependency is zod.
Nothing touches the DOM, so these APIs run identically in Node,
workers, and browsers.

## Sixty seconds to a chart

Discover a model from the published catalogue, load a consistent
manifest/profile pair, and serialize the reference chart:

```ts
import { parseModelCatalogueJson } from "windgram/contract";
import { buildScene } from "windgram/scene";
import { renderSvg } from "windgram/svg";
import { loadProfile } from "windgram/transport";

const DATA = "https://raw.githubusercontent.com/azohra/windgram/main/data";

// Pick a model by declared capability, never by name.
const response = await fetch(`${DATA}/models.json`);
if (!response.ok) throw new Error(`models.json: HTTP ${response.status}`);
const catalogue = parseModelCatalogueJson(await response.text());
if (!catalogue) throw new Error("models.json failed contract validation");
const model = catalogue.models.find(
  (entry) => entry.kind === "deterministic" && entry.capabilities.cape,
);
if (!model) throw new Error("no deterministic model with CAPE is published");

// The manifest + profile pair goes through the reference-time skew guard.
const loaded = await loadProfile({
  fetch,
  baseUrl: DATA,
  modelSlug: model.slug,
  siteSlug: "dundee",
});
if ("miss" in loaded) {
  throw new Error(`${model.slug}/dundee ${loaded.miss}: ${loaded.url}`);
}
if (loaded.stale) console.warn("run still syncing across the CDN");

const timeZone = loaded.profile.site.timeZone ?? "America/Vancouver";
const svg = renderSvg(buildScene(loaded.profile, { timeZone }));
```

The `parse…Json` guards return the typed document or `null`; transport
loaders return the typed pair or a discriminated `DocumentMiss`. The
[first-windgram guide](https://windgram.azohra.com/docs/typescript/render-first-windgram/)
walks this path step by step and shows the chart it produces.

## Entry points

One import subpath per job; each links to its guide.

| Subpath | What it gives you | Guide |
| --- | --- | --- |
| `windgram/contract` | Zod schemas, inferred types, and nullable parse guards for the five published document kinds | [Contract validation](https://windgram.azohra.com/docs/typescript/contract/) |
| `windgram/derive` | Pure derivations of published state: moisture, wind, lapse, stability, shear, usable lift, day windowing, projection, alignment | [Pure derivations](https://windgram.azohra.com/docs/typescript/derive/) |
| `windgram/analyze` | Typed findings over one profile, each carrying the thresholds and evidence that produced it | [Analyze a profile](https://windgram.azohra.com/docs/typescript/analyze/) |
| `windgram/compare` | Cross-model window agreement and height spread with a member ledger | [Compare model profiles](https://windgram.azohra.com/docs/typescript/compare/) |
| `windgram/transport` | `loadProfile` and `loadRuns` with the torn-pair skew guard and discriminated misses | [Load published documents](https://windgram.azohra.com/docs/typescript/transport/) |
| `windgram/scene` | The headless scene graph: scales, strips, series, barbs, markers, hit-testing, the key spec | [Build a scene graph](https://windgram.azohra.com/docs/typescript/scene/) |
| `windgram/svg` | The deterministic reference serializer for chart and key, styled entirely by CSS custom-property tokens | [Render SVG and a key](https://windgram.azohra.com/docs/typescript/svg/) |

Every option and token defaults to the reference look;
[Defaults and tokens](https://windgram.azohra.com/docs/typescript/defaults-and-tokens/)
lists the exported default maps.

## Ensemble documents

Every numeric position is a `Scalar = number | EnsembleValue`: deterministic
models publish numbers, ensemble models publish percentile objects in the
same positions. Switch on shape, never on model name — `isEnsembleValue` and
`isEnsembleDropout` narrow one position, `p50(scalar)` reads the median, and
`isDeterministicProfile` narrows a whole document once so deterministic-only
code never touches `p50()`. Semantics live in
[Ensemble values](https://windgram.azohra.com/docs/data/ensemble-values/).

## JSON Schemas for non-JS consumers

JSON Schema artifacts generated from the same zod contract ship as plain
files in the npm tarball's `schema/` directory
(`node_modules/windgram/schema/profile.schema.json` and its four siblings)
and in the repository at
[`packages/windgram/schema/`](https://github.com/azohra/windgram/tree/main/packages/windgram/schema).
They are not a package export specifier — read them from the filesystem or
the repository, not through `import`. Their field semantics match the
TypeScript JSDoc.

## Authority boundary

The pipeline (Python) owns stored values that need provider inputs or
cross-run authority: W\*, boundary-layer top, cloud base, and usable-lift
top. This package owns pure functions of the published JSON: RH, TI, shear,
B/S, lapse, stability, windowing, smoothing, and consumer-parameter
projections such as a different usable-lift sink rate. A projection does not
replace the document's published value. The
[project overview](https://windgram.azohra.com/docs/overview/#authority-by-quantity)
maps the full boundary.

## Developing

```sh
pnpm --dir packages/windgram test      # vitest
pnpm --dir packages/windgram build     # tsc -> dist/ (types + ESM)
pnpm --dir packages/windgram schemas   # regenerate schema/*.json
```

## Documentation and licence

Guides, data references, and teaching material live at the
[documentation portal](https://windgram.azohra.com/docs/overview/). Release
history lives in the repository
[CHANGELOG](https://github.com/azohra/windgram/blob/main/CHANGELOG.md).

The code is [MIT licensed](https://github.com/azohra/windgram/blob/main/LICENSE).
Published profiles derive from ECCC and NOAA source data; the
[repository licence section](https://github.com/azohra/windgram#licence)
records the attribution requirements.

Made with <3 by Justin Watts.

# Why this project exists

The forecasts free-flight pilots plan around mostly arrive as rendered images from services whose
data, derivations, and history stay private. A pilot can read the picture; nobody can check the
number behind it, replay yesterday's forecast against what the sky did, or build something new on
top of it. This project takes the opposite bet: publish the dataset, the derivations, the renderer,
and the history, and let any frontend draw the same inspectable picture. It stands on its own —
[acrophobia.ca](https://acrophobia.ca) is its first consumer, not its owner — and it aims to be the
open foundation for windgrams anywhere.

Concretely, it publishes per-site soaring profiles for every catalogued launch, from every supported
weather model whose domain covers it, as static JSON behind no key. The [README](../README.md)
states the contract; the [model catalogue](../data/models.json) states, per model, exactly what is
and is not available. The rest of this entry is the design that makes those aims hold.

## State, not presentation

A dataset other frontends consume must not bake in one renderer's decisions. The prototype did —
each field below answered a rendering question, not a state question:

| Prototype behaviour | What it hardcoded |
| --- | --- |
| `windSpeedKmh`, `pressureKpa`, lapse in °C/1000 ft | display units and display arithmetic |
| smoothed `cloudBaseM` and `usableLiftTopM` | one aesthetic choice; the model's values were unrecoverable |
| hours cut to 07:00–21:00 Pacific | one timezone, for every consumer |
| heat fluxes consumed, then dropped | consumers could not recompute or improve w\* |
| `cloud: true` when depression < 0.5 °C | a hatching threshold masquerading as data |
| `model: "HRDPS"` prose label | consumers keying on a display string |

None of these are wrong for a renderer. All of them are wrong for a dataset, because a consumer who
wants a different window, a different smoothing kernel, or SI units cannot undo a decision the
pipeline already made. So the prototype was replaced outright, before anything external consumed it,
with a contract that inverts the defaults: SI everywhere, unsmoothed derived series, every forecast
hour, dew point instead of depression, published fluxes and coordinates, slugs as identity with
prose names confined to the catalogue, and a `schemaVersion` on every document so no future break is
silent.

## One home per quantity

Every computed quantity lives in exactly one of two homes. The pipeline owns what needs inputs
beyond the published JSON or cross-run authority: boundary-layer top, thermal velocity, cloud base,
usable-lift top — the derived core, held constant through the contract replacement as its
verification oracle. The `windgram` npm package owns everything that is a pure function of the
published document: humidity conversions, lapse and stability, thermal index, shear, day windowing
with the timezone as a parameter, and the 1–2–1 smoothing kernel, now a renderer option that
defaults to the historical look.

The package is also the reference renderer: a headless scene graph and an SVG serializer, locked by
golden fixtures. Before it existed, this repository's site and its first consumer each carried a
several-hundred-line windgram renderer, drifting independently; now both consume one implementation,
and a tooltip shows the same number the chart plots because hit-testing lives in the same scene.

## Transports follow the data

Four ECCC models had read GeoMet WCS — kilobyte crops, request-count budgets, and only the fields
the service chose to expose. The Datamart GRIB files behind the same models carry what WCS never
did: vertical velocity, a true 2 m dew point, the full low-atmosphere pressure column, and
per-member ensemble wind. All four builders now stream whole-domain GRIB2, which trades the old
elegance for volume — gigabytes per run instead of megabytes, fetched into memory, sampled, and
dropped. The [feed reference](../reference/forecast-model-feeds.md) records the verified inventories
and costs. The trade was accepted deliberately: subsetting was an optimization for reading a
service's rendering of the model; the files are the model.

## Ensembles are first-class

The contract types every numeric position as number-or-percentile, so an ensemble is not a special
case: REPS publishes per-level percentile blocks — an ensemble sounding of 21 members' temperature,
moisture, and wind, reduced to conditional percentiles under the same member-accounting rules the
scalar spread uses. A consumer reads one document shape and switches on value shape, never on model
name. [What ensemble spread can—and cannot—tell you](ensemble-spread.md) covers how to read it.

## Honest limits, growing catalogue

Models differ, and the dataset says so instead of papering over it: the catalogue declares per model
which fields, levels, and semantics exist, so a missing capability is a stated fact rather than a
silent null. Sites and models are data, not code — adding either is a catalogue change, and no model
is the flagship. Forecast history begins with the published schema and accumulates append-only per
site, because the long game is verification: replaying forecasts against outcomes, site by site,
model by model. The prototype's archives were wiped rather than converted — pre-release data in an
unversioned schema, windowed and smoothed, is not a verification baseline — and because every
document now declares its schema version, no contract change can ever again require a wipe instead
of a migration.

Executable authority: [`windgram/windgram.py`](../windgram/windgram.py) for the pipeline's
derivations, [`packages/windgram`](../packages/windgram) for the contract, derivations, and
renderer, and [`data/models.json`](../data/models.json) for the catalogue.

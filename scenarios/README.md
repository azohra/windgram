# Synthetic teaching scenarios

This directory holds deterministic recipes for model-shaped windgram data.
The resulting profiles are teaching and test artifacts, not forecasts. They do
not describe present conditions, past conditions, or expected conditions at a
launch. Public figures using them must retain a visible **Synthetic scenario**
label and a useful accessibility description.

The distinction is structural as well as editorial:

- definitions use synthetic scenario ids and one of the abstract model shapes
  in `scenario.schema.json`, never a production model slug as public identity;
- every clock instant and time zone is explicit and every definition carries a
  seed, so output cannot depend on the current date, ambient randomness, or a
  machine-local time zone;
- baselines are repository-local JSON files, so generation performs no network
  access;
- definitions and baselines contain source values only;
- `windgram.windgram.derive_windgram_profile()` remains the authority for
  `derived.*` values;
- generated profiles are committed for reproducible rendering, but they are
  never edited by hand.

## Directory contract

```text
scenarios/
├── scenario.schema.json        definition schema and closed vocabulary
├── definitions/                one discoverable recipe per top-level JSON file
│   └── invalid/                rejection fixtures, never discovered as scenarios
├── baselines/                  source-shaped inputs and provenance records
├── generated/                  generated profile documents; do not hand-edit
└── index.json                  generated public registry
```

The scenario runner discovers only
`scenarios/definitions/*.json`. Files below `definitions/invalid/` are test
fixtures. It resolves baseline paths from `scenarios/`, not from the definition
file's directory or the process working directory.

`index.json` is a generated registry. Generation populates each entry with the
definition's teaching metadata, generated output path or paths, and SHA-256
output hash. A definition without generated output must not be advertised
through the index.

## Definition fields

Every definition has these required fields:

- `id`, `title`, and `lesson` identify the recipe and the single relationship
  it is meant to teach;
- `kind` is `deterministic`, `ensemble`, or `comparison`;
- `modelShape` selects a synthetic transport shape, not a named forecast model;
- `timeZone` is an explicit IANA-style zone echoed into the generated
  profile as `site.timeZone` for local-time analysis, projection, and
  presentation;
- `site.synthetic` is always `true`;
- `clock` fixes the UTC reference, generation, and first-valid instants,
  sampling step, hour count, and random seed;
- `baseline` names one local source file and, for calibrated material, its
  provenance record;
- `transforms` contains only declared source-input operations;
- `semantics` explicitly declares how synthetic gust and precipitation fields
  map to the v0.3 published transport contract;
- `capabilities` uses the same field-presence vocabulary as the published model
  catalogue without claiming that a production model produced the data;
- `assertions` records machine-checkable relationships that establish the
  lesson.

The model shapes and their structural promises are tabulated in the
[scenario authoring guide](https://windgram.azohra.com/docs/contribute/scenario-authoring/#model-shape-and-capabilities).

An ensemble definition also declares its member count and seeded source-field
perturbations. `symmetric` perturbations are balanced ranks over the declared
spread, `uniform` uses the spread as a bounded half-range, and `normal` uses it
as the standard deviation. Correlation selects one draw for the whole column,
for each teaching hour, for each pressure level, or for each individual source
position. Every member source column is derived independently before the
resulting profiles enter the production ensemble aggregator.

A comparison declares two to four neutral variant ids; variant-specific
transforms refer to those ids through `target`. Its output filenames include
the variant id and the generated index keeps the corresponding label beside
each path. Comparison labels describe controlled differences, not correctness
or probability.

## Transform vocabulary

The schema rejects any operation outside this list:

| Type | Effect on source input |
| --- | --- |
| `surface-field-curve` | Set a declared surface field at teaching-hour offsets |
| `temperature-offset` | Offset level temperature within an MSL altitude band |
| `dew-point-depression-offset` | Offset level dew-point depression within an MSL altitude band |
| `wind-speed-scale` | Scale non-negative level wind speed within an MSL altitude band |
| `wind-direction-rotate` | Rotate level wind direction within an MSL altitude band |
| `pressure-tendency` | Apply a surface-pressure change per teaching hour |
| `capability-field` | Explicitly add or omit an optional source field |
| `time-shift` | Shift fixed profile times by a declared whole-hour offset |
| `elevation-adjustment` | Adjust site and/or model elevation by declared deltas |

Scheduled transform numbers can be constants or `byHour` point sets. The
validator rejects duplicate or out-of-range hour offsets, inverted altitude
bands, comparison targets not declared by the definition, and capability
declarations that disagree with the resulting source shape.

Transforms cannot name a `derived.*` field. Assertions may read derived fields
because their job is to check the pipeline's result; they do not write values.
Assertions use explicit hour indices and, for pressure-level fields, an exact
pressure or nearest-height selector. Presence assertions preserve the important
difference between an absent field and a field whose value is zero.

Ensemble positions are addressed by a trailing percentile key: a field such as
`derived.usableLiftTopM.p50` names one position inside the published percentile
block, and `.members` names its contributor count. Wind direction (a circular
median) and the level pressure coordinate publish plain numbers and take no
suffix. A nearest-height selector positions ensemble levels by their median
(`p50`) height — the same position the aggregation orders levels by.

## Baselines and attribution

A `synthetic` baseline is authored input with no claim of observational or
forecast provenance. It still uses the exact source shape accepted by
`derive_windgram_profile()` so the teaching pipeline exercises production
derivations.

A `calibrated` baseline may be reconstructed from real provider output to keep
synthetic magnitudes and vertical relationships credible. It is calibration
material only: the website must never import it directly and public prose must
not present its timestamps as a current or historical forecast example. Its
definition must name a sibling `*.provenance.json` record containing:

- provider and model;
- model reference time and retrieval or capture date;
- source URL or feed identifier and applicable attribution or licence terms;
- site identity and coordinates used during capture;
- fields retained, fields omitted, and the reconstruction method;
- numeric tolerances introduced by reconstruction;
- the repository revision and a `[verified YYYY-MM-DD]` date for provider
  facts.

The provenance record credits the provider adjacent to any discussion of the
calibration method. Generated teaching output continues to be labelled
synthetic and uses synthetic public identity.

At generation time the definition's `site`, `timeZone`, and `clock` replace
baseline metadata: valid times are rebuilt from `startAt`, `stepHours`, and
`hourCount`, and the zone is echoed as the profile's `site.timeZone`.
The baseline contributes the atmospheric source columns, not public identity or
time claims. The validator also rejects a scenario id that equals any slug in
the current `data/models.json` catalogue. The check reads the catalogue instead
of copying its slugs into this schema.

## Validation fixtures

`definitions/minimal-valid.json` is the smallest committed valid recipe. Its
source baseline contains two fixed hourly columns and no `derived` block.

The fixtures below `definitions/invalid/` each isolate a required rejection:

- `missing-lesson.json` omits `lesson`;
- `unknown-transform.json` names an operation outside the closed vocabulary;
- `invalid-clock.json` uses an unsupported two-hour cadence for an hourly
  shape;
- `direct-derived-authorship.json` attempts to transform
  `derived.thermalVelocityMs`.

Run the schema, fixture, generated-output, and registry checks together:

```sh
uv run python -m windgram.scenarios check
```

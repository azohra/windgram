# Changelog

Notable repository and `windgram` package changes are recorded here. Dataset
schema, npm package, and Python pipeline versions are independent; each release
entry names the versions it actually changes.

## [0.9.1] - 2026-08-09

Repository tag `v0.9.1`; npm package `windgram` 0.9.1 (documentation-only
package changes). Published document `schemaVersion` remained 1 and Python
project metadata remained 2.0.0.

### Added

- A deterministic synthetic-scenario contract, offline generator, committed
  teaching profiles, and hash-indexed scenario registry.
- Synthetic ensemble and controlled timing-comparison scenarios using the
  production member aggregation and pipeline derivations.
- Percentile paths in scenario assertions (`.p10`–`.p90`, `.members`);
  `nearestHeightM` selects ensemble levels by their median height, and shape
  mismatches raise scenario errors instead of TypeErrors.
- An attributed offline HRRR calibration baseline that is excluded from site
  imports.
- Astro content collections and a branded Starlight documentation portal
  shared with the research archive.

### Changed

- Research articles now use explicit MDX figure composition and collection
  metadata instead of a hard-coded page registry.
- Documentation, research, reference, and About content have distinct
  canonical routes with permanent redirects from retired paths.
- The project boundary now identifies the website as documentation, research,
  and synthetic teaching material rather than an operational forecast browser.
- REPS and GEPS share one ensemble aggregation authority with synthetic
  teaching scenarios.
- The scenario registry is server-only; each page embeds the one profile it
  renders, so windgram-embedding pages ship a fraction of the JavaScript.
- The five interactive labs share one logic and style home.
- Contributor documentation keeps each policy in one home with pointers
  (check gate, file authority, golden-SVG policy, calibration provenance).

### Fixed

- Ensemble scenario generation carries every optional surface field the
  definition's capabilities declare (gust, CAPE/CIN, PBL height, cloud
  layers), and validation rejects an aggregate that drops one.
- `windgram scenarios …` resolves the repository root from the current
  directory upward (install source as fallback), names the tree it writes,
  and shares one dispatch with `python -m windgram.scenarios`.
- The homepage barb caption reads km/h; learn-page figure narration matches
  the rendered scenarios; repository Markdown links to documentation pages
  resolve as site routes.
- The publisher-example test derives the pack tarball name from
  `package.json` instead of hardcoding a version.

## [0.9.0] - 2026-08-09

Repository tag `v0.9.0`; npm package `windgram` 0.9.0. Published document
`schemaVersion` remained 1 and Python project metadata remained 2.0.0.

### Added

- Interpolated iso-band paths for classified time-height fields.
- A distinct `wg-bs-unopposed` strip cell for nonzero buoyancy with zero
  surface-to-boundary-layer shear.
- A terrain case study documenting the B/S ratio's same-air-mass assumption.

### Changed

- `sampledFieldPaths` now accepts ordered `{ breakpoints, classNames }`
  banding and emits compound paths that require `fill-rule="evenodd"`.
- Stability banding derives directly from `WINDGRAM_STABILITY_CLASSES`.
- Surface-to-boundary-layer shear and B/S JSDoc identify mountain-valley
  circulation as a structural limit and point terrain readers to the
  height-resolved wind-shear field.

## [0.8.0] - 2026-08-09

Repository tag `v0.8.0`; npm package `windgram` 0.8.0. Published document
`schemaVersion` remained 1 and Python project metadata remained 2.0.0.

### Added

- `windgram/compare` with `compareProfiles`, a model comparability ledger,
  per-day `windowAgreement`, per-day `heightSpread`, and
  `COMPARE_VOCABULARY_VERSION` 1.
- `resolveAnalyzeThresholds` for sharing one resolved threshold set across
  profile analysis and comparison.

## [0.7.0] - 2026-08-09

Repository tag `v0.7.0`; npm package `windgram` 0.7.0. Published document
`schemaVersion` remained 1 and Python project metadata remained 2.0.0.

### Added

- Full ensemble dropout as `members: 0` with every percentile `null`, plus
  the `isEnsembleDropout` guard.
- Analyze vocabulary version 3 with quiet-day coverage and horizon-clipped
  window edges.

### Changed

- `p50()` now returns `number | null` and preserves full dropout.
- Scene and analysis paths omit percentile geometry and evidence at dropout
  positions while retaining contributor counts.

## [0.6.0] - 2026-08-09

Repository tag `v0.6.0`; npm package `windgram` 0.6.0. Published document
`schemaVersion` remained 1 and Python project metadata remained 2.0.0.

### Added

- Analyze vocabulary version 2 with the evidence-carrying `quietDay` finding
  and exported `LocalDayKey`.
- Marker-train offsets through `{ every, offset }` stride objects.
- Discriminated `DocumentMiss` results that separate absent publications from
  documents rejected by contract guards.

### Changed

- The reference renderer uses a pale stability field, white wind barbs with a
  slate rim, bare series lines, and scalar strips extended to the plot edges.
- Analysis day fields use the same exported local-day key type as day
  windowing.

### Removed

- The `windgram/presets` export. Scene options and renderer tokens remain the
  direct configuration surfaces.

## [0.5.0] - 2026-08-08

Repository tag `v0.5.0`; npm package `windgram` 0.5.0. Published document
`schemaVersion` remained 1 and Python project metadata remained 2.0.0.

### Added

- `buildKeySpec(scene)` and `renderKeySvg(spec)` for a typed, deterministic key
  derived from the scene's visible line styles, cloud hatch, stability ramp,
  and ensemble bands.
- Presentation options for total `widthPx`, hour labels, horizontal and
  vertical wind-barb density, barb scale, marker trains, and strip-label
  overrides.
- The exhaustive `surfaceTemperature` overlay, on by default, with one rounded
  Celsius readout per rendered hour.
- Exported text-scale and key tokens plus per-element halo overrides that fall
  back to the shared halo token.

### Changed

- Scalar strips print their maximum and minimum values at the right edge; the
  cloud-layer strip retains its H/M/L row labels.
- Default wind-barb density follows the resolved chart geometry, gust labels
  follow the same horizontal stride, and page-scale columns can grow the
  glyphs without consumer-side geometry.
- The surface wind row now clears the plot floor by half the resolved glyph
  height, with its actual placement exposed as `scene.scales.surfaceWindY`.
- The default SVG is one surface-temperature text row taller. The release
  regenerated package goldens for this visual boundary.

## [0.4.0] - 2026-08-08

Repository tag `v0.4.0`; npm package `windgram` 0.4.0. Published document
`schemaVersion` remained 1 and Python project metadata remained 2.0.0.

### Added

- `windgram/analyze` with a versioned seven-kind vocabulary of typed findings
  over one profile. Threshold-dependent findings embed their effective
  thresholds and cited statements carry source evidence; the vocabulary does
  not issue hazard, confidence, consensus, or go/no-go verdicts.
- `projectProfile` for pure-subtraction local-day, level, and field projection,
  and `alignByValidAt` for a quantity-only intersection of shared UTC instants.
- Required IANA `timeZone` declarations in the site catalogue, echoed as the
  optional `site.timeZone` field in newly built profiles.

### Changed

- Local-time analysis and day projection use a profile's timezone echo by
  default while retaining explicit override and older-profile handling.
- The package integration guide records measured projection and analysis
  payload budgets for inspectable document workflows.

### Removed

- The deprecated `msToKmh` re-export from `windgram/scene`; import the
  conversion from `windgram/derive`.

### Fixed

- GEPS surface orography is decoded from the legacy feed's undocumented
  decametre values into metres before derivation. A plausibility guard now
  rejects both the original low-datum regression and an inverse over-scaling
  failure; the affected run was queued for corrected re-publication.

## [0.3.0] - 2026-08-08

Repository tag `v0.3.0`; npm package `windgram` 0.3.0. Published document
`schemaVersion` remained 1 and Python project metadata remained 2.0.0.

### Added

- `windgram/transport` with injected-fetch profile loading, manifest/profile
  run-consistency checks, cross-model run-index loading, and explicit HTTP
  errors.
- `DeterministicWindgramProfile` and `isDeterministicProfile` for narrowing a
  validated deterministic document once.
- Contract guards and generated JSON Schemas for the versioned site catalogue
  and cross-model run index.
- Per-profile gust and precipitation semantics plus ensemble `run.members`.
- Field descriptions in the generated JSON Schema artifacts.
- Scene hour selection by hour objects or local-day window, along with local
  day grouping and the `msToKmh` derivation export.

### Changed

- `runIntervalHours` and `capabilities.precipitation` became required model
  catalogue declarations; pre-0.3.0 catalogues do not pass the 0.3.0 guard.
- Manifest statistics gained a stable four-field core while retaining open,
  transport-specific numeric counters.
- A publication is identified by its `referenceTime` and `generatedAt` pair;
  monthly history stores complete profile documents.
- The site adopted the package's contract, transport, and time exports.
- `msToKmh` moved from `windgram/scene` to `windgram/derive`; the old export is
  deprecated and retained through 0.3.x.

### Fixed

- NAM 12 km and CONUS-nest precipitation bucket lengths now follow each
  product's per-cycle accumulation resets, including 06Z and 18Z runs.

[Unreleased]: https://github.com/azohra/windgram/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/azohra/windgram/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/azohra/windgram/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/azohra/windgram/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/azohra/windgram/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/azohra/windgram/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/azohra/windgram/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/azohra/windgram/tree/v0.3.0

# Changelog

Notable repository and `windgram` package changes are recorded here. Dataset
schema, npm package, and Python pipeline versions are independent; each release
entry names the versions it actually changes.

## [0.22.1] - 2026-08-10

`windgram` (npm and JSR) 0.22.1 — the scene stops fabricating optical
depth from the quarantined column. Caught by the first downstream
consumer within hours of 0.22.0: the joined-smoke haze tint still
derived AOT via `smokeAotFromColumn` from the RAQDPS plume column the
same release had quarantined — a column measured ~15–26× low paints a
nearly invisible haze during heavy smoke, the worst direction to be
wrong in. Joined hours now carry no AOT: the healthy surface
magnitudes keep printing, no haze cell is drawn, and the opt-in
smoke-adjusted view no-ops on joined smoke exactly like the analyze
vocabulary's cut derate verdict. A profile's own published AOT (HRRR)
is untouched. Until the provider fixes the column, `smokeAdjusted` is
effectively inert across the live catalogue — stated here so nobody
wonders why the toggle changes nothing.

## [0.22.0] - 2026-08-10

`windgram` (npm and JSR) 0.22.0 and `windgram` pipeline (PyPI) 0.9.0 —
documents through time, and the frame goes public. Two ratified
programs in one release: the Tier 2 architecture thread (the
normalization machinery stops being the vocabulary's private
scaffolding) and the convergence/history program (the archive becomes
a first-class read surface and successive runs of one model become a
statement). Plus the RAQDPS column verdict: the provider's field is
defective, and the dataset now says so where the field is described.

### Added — `windgram/history` (new subpath, server-side)

- **The member-splitting reader**: month archives are independent gzip
  members, one document per line, and the platforms genuinely
  disagree about that (measured 2026-08-10: Node 24 throws
  ERR_TRAILING_JUNK_AFTER_STREAM_END, Deno 2.9 a different TypeError,
  Bun 1.3 silently succeeds) — so the subpath ships its own splitter,
  verified against all 92 live archive files. node:zlib makes this
  the one server-side subpath; every other subpath stays
  runtime-agnostic.
- **`loadHistory` / `loadProfileHistory` / `loadSmokeHistory`**: months
  load contract-guarded and DEDUPED (key (model, referenceTime),
  keep-latest-generatedAt — mandatory, because the archive is
  append-only and republications are real), with every republication
  stated in `revisions`, per-month misses discriminated, and corrupt
  lines quarantined without poisoning their month.
- **The advisory sidecar index**: `{YYYY-MM}.index.json` beside each
  archive (written by the pipeline on every append; exact byte
  offsets per gzip member) lets a `since` load Range-fetch a suffix
  instead of the month; absent or mismatched, loading silently does
  the full fetch — the index can never make a read wrong.
- **`compareRuns`**: the convergence ladder over one model's
  successive runs, in its own sibling envelope (`RunComparison`,
  vocabulary 1 — cross-model and through-time version independently).
  Five kinds and nothing else: existence, timing, and magnitude
  trajectories (windowAgreement's own vote/cadence/clipped-edge
  discipline re-projected along the run axis), `identityDrift`
  (republications and ledger-fact changes stated), and arithmetic
  `settled` — a stability statement, explicitly not probability or
  skill, whose minRuns=3 / 300 m defaults are TRIAL constants
  awaiting the ≥2-weeks-of-archive re-sweep (~2026-08-24). The
  recorded rejections stay binding: no trend adjectives, no model
  weighting, no graded agreement — deltas and rosters state
  themselves. Lead anchors local noon by default, parameterized.

### Added — the architecture thread

- **The analysis frame is public**: `AnalysisFrame` (its own
  ANALYSIS_FRAME_VERSION, changes rarely — it is normalization, not
  claims) + `AnalyzeOptions.extensions` run caller extractors over
  the same citation/day/lead machinery the built-in kinds use, into a
  separate envelope `extensions` array — the findings vocabulary
  stays closed and first-party; the evidence-spike gate keeps
  guarding it and stops being the only door in the building.
- **`compareAnalyses(analyses)`**: compare now eats the
  self-describing envelope analyze produces (new envelope fields:
  `deterministic`, `coveredDays`, resolved `thresholds` echo), with
  coherence VALIDATED — mixed sites, duplicate members, vocabulary
  skew, mixed timezones/launches/thresholds each throw by name.
  `compareProfiles` is now the convenience wrapper around it; cached
  and edge-computed analyses round-trip through JSON.
- **Tolerant-reader versioning**: both `vocabularyVersion` fields
  widen from literal types to `number`, and the charters state the
  convention — unknown kinds are ignorable, switch with a default
  arm. The release's one type-level break; no wire change.

### Changed — pipeline 0.9.0

- **Every history append rewrites the month's sidecar index** (a pure
  function of the archive bytes; key names deliberately match the
  toolkit reader's guard — a mismatch there is not an error but a
  permanent silent full-fetch, the worst kind of wrong).
- **upload-data.sh syncs indexes on their month's TTL** — the old
  everything-but-open-months pass would have swept an open month's
  index onto the immutable TTL (caught on paper before the first
  index shipped).
- **`windgram repack`**: the one-time CLI that folds the legacy year
  archives into the month scheme — idempotent, seeded from published
  bytes, dedupe-keep-latest, aborts on mid-repack races and on
  equal-generatedAt-different-bytes conflicts rather than guessing,
  and deletes a year file only after every line is verified
  byte-identical or superseded. Runs by hand, with credentials, once.

### Changed — the RAQDPS column is described as measured

- Root cause closed 2026-08-10: the pipeline republishes ECCC's
  `PM2.5-WildfireSmokePlume_EAtm` faithfully, and the field itself is
  defective — declared as an entire-atmosphere column (kg/m²),
  measured as a ~50–250 m near-surface slab (~15–26× below
  satellite-consistent columns; essentially no elevated smoke; full
  chain in the contract JSDoc, the field's one home). Reported to
  ECCC 2026-08-10; the optics quarantine stands until their response
  or the ~September GOES re-arbitration. The smoke docs pages now
  point at the note instead of selling the field as an optics input.

## [0.21.0] - 2026-08-10

`windgram` (npm and JSR) 0.21.0 — analyze vocabulary 4, compare
vocabulary 2: the statement modules catch up to the documents they
read. Three adversarial reviews (run blind against source and live
data, licensed to attack every recorded rejection) located the
tameness in under-extraction, not in the discipline — and four
evidence spikes over live published documents then gated every
addition. Two of the paper's own proposals died in those spikes and
did not ship (the smoke-derated window verdict; the BL-saturation
overlap series): the vocabulary grows only by measurement. Pipeline
stays 0.8.0; this is a toolkit release.

### Changed (breaking by design; one vocabulary event)

- **`flyableWindow` is renamed `thermalWindow`** — the kind string was
  the one judgment word the discipline could not reduce: the
  arithmetic tests thermals (w* and lift depth over floors), not
  flyability, and it is blind to wind, rain, and overdevelopment. The
  kind also gains `leadHours` (anchored on the day's peak-lift hour),
  a `stepHours` echo (widest covered step among its cited hours), and
  a caller-movable `maxGapHours` segmentation tolerance (default 0 =
  exact old behaviour).
- **A compare member is a run, not a model**: identity is
  `(model, referenceTime)`, `comparisonMemberKey` joins rosters to
  the ledger, and `WindgramComparison.analyses` is re-keyed by the
  composite key — the breaking change the convergence program needs,
  paid once. Two runs of one model are two members; same-run
  duplicates throw.
- **The windowAgreement electorate is now whole**: a window crossing
  local midnight votes on every day it touches (`viaWindowFrom`
  confesses the join); members whose horizon never reaches a day
  appear as `outOfHorizon` abstentions (previously "voters 3,
  unanimous true" while 7 of 10 members couldn't see the day); a day
  with zero voters AND zero abstentions emits nothing; timing votes
  carry each member's cadence (up to stepHours−1 h of any spread is
  quantization, now stated beside the spread).
- **Verdicts that measured as artifacts are removed**:
  `ensembleMembership.bands.trend` and its `wideningRatio` threshold
  (first-vs-last band width is a diurnal confound — both failure
  directions measured live on one document), `maxRelativeSpread` /
  `maxSpreadAt` (explodes as p50→0, cites the least consequential
  hour), and `liftCeiling.flips` (restated `segments.length − 1`).
  Replacement where one was earned: per-day band widths at each day's
  peak-p50-w* hour (`dayBands`, with lead and truncation flags, no
  trend words).
- **capTiming distinguishes the atmospheres it conflated**: new
  `openButWeak` verdict for CIN ≈ 0 with CAPE under the break floor
  (previously read "cappedAllDay" with the cap physically open);
  multi-hour-cadence deterministic documents are re-admitted with
  interval verdicts between adjacent CITED steps (subsampling audit:
  16/16 interval containment, zero phantom breaks; cappedAllDay's
  measured 12.5% phantom rate at 3 h is confessed on the kind);
  precipitation statements echo their declared semantics and step.
- **Mixed cadence is read honestly everywhere**: live GEPS switches
  3 h → 6 h mid-horizon and the old single-constant `stepHours`
  arithmetic misread durations, truncation, and persistence on every
  such document — spacing now comes from the actual adjacent cited
  hours throughout.
- **liftCeiling segments cite their peak** (evidence was frozen at
  each segment's first hour — a 7-hour segment cited 1973 m against
  its own 3440 m peak); `maxWindInBand.pressureHpa` is honestly
  `number | null` (no more NaN-serializes-to-null type lie).
- The charters state the actual discipline: no verdict that does not
  reduce to stated arithmetic over stated, embedded, caller-movable
  thresholds — the rule was never "no judgment words".

### Added (every kind gated by a 2026-08-10 evidence spike)

- **`percentileCrossing`** (ensembles): the same window arithmetic at
  every published percentile, emitted only where a percentile's day
  verdict differs from p50's. Measured: 26% of live ensemble days are
  upside days (p50 quiet, p75/p90 clears both floors by real
  margins) — all at ≥72 h lead, so the finding carries `leadHours`.
  No windows-per-percentile (marginals cannot assert continuity);
  counts + minimal-passing-percentile + cited instants + per-hour
  membership.
- **`smokeImpact`**: the smoke the analysis was silent about, as
  republished magnitudes only — HRRR's own blocks (source "profile",
  semantics echo says whether the lift numbers already feel the
  smoke) or a joined RAQDPS document (`AnalyzeOptions.smoke`; both
  reference times; per-day join coverage). Day-peak AND during-window
  maxima (measured materially different). The derate verdict is
  deliberately absent: the RAQDPS column measured ~15–20× below the
  GOES-implied column on a verified heavy-smoke day (quarantined
  pending pipeline investigation), and even satellite-magnitude AOT
  flipped 1 of 284 window hours. `dataCaveats` names the `"smoke"`
  family on smoke-blind analyses — absence is never clear air.
- **`convectiveDay`**: the convective story a CIN-less model CAN tell
  (the HRDPS family published CAPE into silence): peak CAPE and
  precip timing against the window end, `capIsJudgeable: false`
  stated with its reason, a zero precip series stated as a forecast,
  and a mandatory coverage block (live horizon slivers carry
  nocturnal elevated CAPE that must confess truncation).
- **quietDay grows `context` and `leadHours`**: the atmospheric WHY
  beside the arithmetic why — precip peak/onset/wet hours, cloud
  cover at the peak-w* hour AND the daytime aggregate (peak-hour
  alone measured misleading: 12% vs 85% on one live day), gust with
  semantics, sensible heat flux. 17/17 live quiet days carried a
  stated suppressor; an empty block reads honestly as none.
- **The wind family** (whole-day maxGust cited an unflyable hour on
  30% of live rows): `windSummary.duringWindow` (window-scoped gust
  and band maxima plus the per-hour series the extractor previously
  discarded); **`windExceedance`** — maximal runs over caller-owned
  ceilings (`AnalyzeOptions.windCeilings`, NO defaults anywhere,
  per-gust-semantics-class ceilings never reused across classes: the
  gap measured a factor ~1.8–2.8 at matched means); **`windDirection`**
  (deterministic only — published direction percentiles are not
  circular statistics): start/peak-lift/end samples, vector means,
  net veer (never accumulated rotation: 206° of pure jitter measured
  on one light-wind day), 1.0 m/s floor with the measured 0.5 m/s
  cliff recorded; **`bandShear`** — max layer-shear rate with
  mandatory layer bounds and a light-wind endpoint relation, analyze
  only, never compared (rates measured incomparable across level
  densities: median 0.41× under subsampling).
- **compare speaks wind and sensitivity**: `windDivergence` (band-wind
  roster with mandatory model-elevation echoes; gust classes never
  pooled; undeclared gusts roster without a spread; no shear, ever),
  `windDirectionSpread` (deterministic members, circular separation,
  the max pair carries both elevations), `sensitivity` on
  windowAgreement (the smallest threshold move that flips a voter —
  the 0.8-vs-0.9 split is now a statement), WindowVote's
  `minimalPassingPercentile`, and heightSpread's
  `bandP10P90AboveLaunchM` (context only — 57 of 61 live
  deterministic peaks sat ABOVE the band; never an outlier detector).
- **terrainMismatch carries the p90 lift-top max** so an ensemble's
  bench is checkable at the band's top; `AnalyzeThresholdOverrides`
  is the honest public type for per-kind partial overrides.
- The contract's gust-semantics note carries the measured class gap
  (~1.8–2.8× at matched light mountain means, one region one week)
  beside its original ~20–30% figure.

## [0.20.1] - 2026-08-10

`windgram` (npm and JSR) 0.20.1 — a finding can no longer contradict
its own evidence. The published contract rounds m/s quantities at two
decimals, but analyze/compare evidence coarsened every stated magnitude
to one: a raw w* of 0.89 voted quiet against a 0.9 windows floor while
its printed evidence said 0.9. Stated magnitudes now ship at the
contract's own precision per quantity (m/s at 2, metres at 1 —
pipeline `_FIELD_DECIMALS` is the authority); vote logic always read
raw values and is untouched. A regression test pins the observed case.

## [0.20.0] - 2026-08-10

`windgram` (npm and JSR) 0.20.0 and `windgram` pipeline (PyPI) 0.8.0 —
the launch-decoupled dataset: a windgram document describes the
atmosphere the model computed over a grid sample; a launch is a place
a human flies from. Humans author WHERE, the pipeline measures WHAT,
and consumers attach the launch at render time. Designed once, on
paper, before a line was written; breaking by design (we are the
dataset's only consumer).

### Changed

- **Documents are launch-agnostic samples.** The profile `site` block
  is re-scoped to sample provenance — id, name, coordinates, timezone
  echo, and `modelElevationM` (the model's own ground: plot floor,
  physics reference). `altitudeM` is REMOVED from the contract and
  from every builder: the old values were free-website estimates the
  schema mis-described as "surveyed", and baking even a perfect number
  in binds a forecast that covers several launches to one of them. Old
  stored documents still parse (the guard strips the field).
- **The launch is a render input.** `SceneOptions.launch: {name?,
  elevationM}` draws the marker and stretches the scale; no launch →
  no marker, honestly, never an error. `AnalyzeOptions.launch` /
  `CompareOptions.launch` follow the same pattern (without one, the
  reference falls back to model ground and launch-relative findings
  are absent). One fetched document renders for every launch its grid
  cell covers. Teaching scenarios author a top-level `launch` block
  and the scenario index carries it; every SVG golden is
  byte-identical when fed the launch the documents used to bake.
- **sites.json (schemaVersion 2) is identity and build selection
  only**: slug, name, coordinates, timezone. An elevation in the file
  is rejected with a pointer at its real home.
- **site-context.json (schemaVersion 2) owns the launch elevation**:
  a required `elevation {source, elevationM}` block — a measurement
  selection, not a computation — picked by explicit priority
  (LidarBC 1 m ground returns → MRDEM 30 m DTM → GLO-30 surface model
  as a loud last resort), replacing the optional bareEarth block.
  Consumers pull it on their own schedule and own the did-it-change
  check.
- **GEPS regained its unit-error tripwire, catalogue-free and
  stronger**: the model's terrain datum must be barometrically
  consistent with its OWN surface pressure (|H·ln(p0/p_sfc) − datum| ≤
  1,000 m — honest weather moves the implied elevation well under
  700 m; a dropped ×10 leaves kilometres). Verified against the live
  feed; the old guard had compared against the catalogue estimate.

### Added (downstream-driven, validated against the first real consumer)

- **Transport generalizes across document kinds**: `loadDocument`
  parameterized by contract guard (the manifest/document skew dance —
  torn-reported-as-stale, retry-once, manifest-miss-wins — now written
  once); `loadProfile` and new `loadSmoke` are typed wrappers;
  `loadObservation` is a guarded single fetch whose docblock carries
  the proof that observation series cannot tear.
- **`loadSiteSet`**: manifest-anchored multi-site coherence — the
  manifest is the publication's commit point; every site document is
  validated against its run identity; a mid-publish fan-out retries
  once and then reports a discriminated `{syncing}` result rather
  than throwing. An all-old coherent set is honestly the previous
  publication.
- **`typicalPublicationLagHours`** on every profile and smoke model in
  the catalogue: the upper end of normal for this dataset's publish of
  a run, seeded 2026-08-10 from the feeds page's verified provider
  availability plus pipeline overhead (three seeds flagged unverified
  in their own provenance; all re-verify from the history archive
  ~September 2026). `derive/` gains pure `runFreshness(runsEntry,
  model, now, thresholds)` — the facts are the catalogue's, the
  current/delayed/stale boundaries stay the consumer's.
- **The ingest recipe** (docs): the server-side counterpart of "Wire
  an inspector" — poll runs.json, detect publication by
  (referenceTime, generatedAt), ingest coherent sets, serve the
  predecessor through gaps, treat a baseline model's failure
  differently from a bonus feed's, judge freshness with your own
  thresholds.

## [0.19.0] - 2026-08-10 — RETRACTED, DO NOT USE

`windgram` (npm/JSR) 0.19.0 and `windgram` pipeline (PyPI) 0.7.0
**shipped in error and were fully reverted the same day** (unpublished
from npm; yanked on JSR and PyPI where the registries allow). Nothing
they introduced exists in any later release in that form:

- There is no identity-only `sites.json` v2, no `sitesInputSchema`, no
  generated published catalogue with `elevation`/`datasets` blocks, no
  `what3words` anywhere in the contract or documents, and no
  site-context v2 of that shape. **Do not write code against 0.19.0's
  schemas, parsers, or fields** — target 0.18.0 (current) or ≥ 0.20.0.
- The one piece that survived, re-landed separately on main: the
  pipeline's authenticated S3 read path (`dataset.py` reading the
  published state through the R2 endpoint).
- The launch/elevation redesign these versions gestured at ships
  properly, once, as 0.20.0 — see that entry when it exists.

## [0.6.3] - 2026-08-10

`windgram` pipeline (PyPI) 0.6.3 — a challenged read is a broken read,
never absence. A production probe found Cloudflare bot-challenging
GitHub runners with 403s on every read of the data hostname
(`cf-mitigated: challenge`), and `fetch_published`'s 403-means-absent
rule (the S3 missing-key tradeoff) turned that into builders silently
seeing an empty dataset: CI published `runs.json` as `{}` while the
dataset sat fully populated, freshness gates no-opped, and incremental
GOES windows and history would have reset every run. `fetch_published`
now distinguishes the two 403s: a response carrying
`cf-mitigated: challenge` fails immediately with an error naming the
zone-level fix, so the pipeline goes loudly stale instead of quietly
wrong. **Operator action required**: the Cloudflare zone needs a
WAF/bot exception for automated reads of the data hostname; until
then, scheduled builds warn and publish nothing new.

## [0.6.2] - 2026-08-10

`windgram` pipeline (PyPI) 0.6.2 — the real shutdown-crash fix, proven
on the environment that crashed. 0.6.1's diagnosis was incomplete: with
netCDF4 out of the process, CI still exited 139. A CI-side bisect (the
one-HDF5-stack theory could not be reproduced in any local or Docker
environment) pinned it to the two ranged-fallback tests alone: a failed
`h5py.File(...)` over a poisoned or garbage reader leaves
partially-initialized HDF5 library state whose atexit teardown
segfaults the interpreter after Python finalization — after every test
has passed, invisible to faulthandler. The builder now refuses to hand
h5py a file that cannot be HDF5: the ranged path checks the 8-byte HDF5
signature on block 0 (already cached for the superblock read) and
routes poisoned readers and garbage responses straight to the
whole-file fallback. The fallback subset and the full suite were run on
the failing CI environment via a diagnostic branch: exit 0 and exit 0.
(0.6.1's one-HDF5-stack-per-process restructuring remains — it is the
right architecture even though it was not the crash.)

## [0.6.1] - 2026-08-10

`windgram` pipeline (PyPI) 0.6.1 — one HDF5 stack per process. The
0.18.0 push's CI and PyPI release both died with exit 139: the h5py and
netCDF4 wheels each bundle their own libhdf5, and loading both into one
interpreter segfaults it at shutdown — after every test had passed
(pipeline 0.6.0 was tagged but never reached PyPI; this release carries
its content). The GOES builder now reads BOTH paths through h5py (the
whole-file fallback wraps an in-memory copy in the same mask-and-scale
wrapper as the ranged path), netCDF4 moved to a test-only dev
dependency whose single importer is a subprocess-isolated reference
script, the bit-identical regression now compares both h5py paths
against netCDF4's own reading across a process boundary, and a guard
test pins the invariant: importing the builder must never load netCDF4.

## [0.18.0] - 2026-08-10

`windgram` (npm and JSR) 0.18.0 and `windgram` pipeline (PyPI) 0.6.0 —
smoke gets its measured third opinion, observations stop discarding
their own record, and GOES ingest drops ~47× to read only the pixels it
publishes.

### Added

- **`goes18-aod` observation dataset**: GOES-18 ABI L2 Aerosol Optical
  Depth (full disk, 10-minute, same fixed grid as DSR — one navigation
  serves both), published per site as `{observedAt, aot}` — the same
  field name and 550 nm wavelength the smoke document forecasts, so
  forecast and measurement compare with no translation. Quality gate
  DQF ≤ 1 (high+medium — Zhang, Kondragunta et al. 2020 measured
  high-only as very conservative; top-2 scores bias 0.04, RMSE 0.09 vs
  AERONET). Honest absences: night is fill+DQF 3, thick plume cores
  can fail cloud tests, winter snow suppresses land retrievals —
  absence means "not measured", never clear air. The observation
  contract's `observations[]` becomes a union of the DSR and AOT entry
  shapes; consumers narrow with a key check.
- **The measured-AOT strip**: pass the AOD document as
  `SceneOptions.aotObservations` and the windgram draws measured AOT
  in the measurement zone below the provenance divider, beside the Sun
  strip, labeled via `scene.aotObservationSource`. The haze tint
  behind the line is the forecast smoke strip's own cell encoding at
  the same scale (full tint at AOT 3) — "forecast smoke" and "measured
  smoke" read against each other at a glance, and one key chip
  explains both. Overlay `observedAot` (default on); `cursorReading`
  packets carry `observedAot`.
- **Observation history archives** (both GOES datasets):
  `<slug>/history/<site>/<YYYY-MM>.jsonl.gz`, one observation object
  per JSON line, archived exactly once when the instant first enters
  the rolling window, under the month of its own `observedAt`. The
  line grammar deliberately differs from profile history (whole
  documents per run there): the window republishes every ~15 minutes,
  so document-grained archives would store each instant ~400 times.
  NOAA's bucket remains the deep granule archive; this is the curated
  per-site record of exactly what was published.

### Changed

- **GOES granules are read by HTTP byte range** (h5py over a seekable
  ranged reader): the value variables are full-row chunk bands and the
  catalogued sites span two of them, so a build moves ~757 KB per AOD
  granule instead of 40.6 MB (54×) and ~849 KB per DSR granule instead
  of 39.7 MB (47×) — about 230 MB/day at full cadence instead of
  ~11 GB. Extracted values are regression-tested bit-identical to the
  whole-file netCDF4 path, which remains as an automatic fallback on
  any ranged-path failure (a fallback is logged, never an error). The
  ranged reader never raises inside h5py's driver callbacks — a
  failure poisons the reader and is re-raised outside, so a poisoned
  read can never masquerade as data.
- The GOES builder is product-parameterized (one module, N products);
  `windgram build --model goes18-aod` joins the CLI and the scheduled
  NOAA job builds AOD right after DSR.

## [0.17.0] - 2026-08-10

`windgram` (npm and JSR) 0.17.0 and `windgram` pipeline (PyPI) 0.5.0 —
the catalogue learns what its launches are made of: static per-site
terrain and land-cover context, generated once from open data and
committed beside the catalogues it annotates.

### Added

- **`site-context.json`** at the repository root and the dataset root:
  machine-generated, git-committed terrain and land-cover context per
  catalogued site — the third catalogue file beside `models.json` and
  `sites.json`. Per site: a `terrain` block from one consistent DEM
  across the whole catalogue (Copernicus GLO-30 — point elevation,
  Horn slope/aspect, relief min/max and the launch's percentile rank
  within 1/3/10 km discs), an optional `bareEarth` block (best
  available lidar DTM: LidarBC 1 m, falling back to NRCan MRDEM-30 —
  absent means "not measured", never agreement), and a `landCover`
  block (ESA WorldCover 2021 v200: class at the launch pixel plus
  composition fractions within 1/3 km). Identity is deliberately not
  echoed — sites.json stays the home of coordinates, surveyed
  elevation and timezone; consumers join by slug. The `sources[]`
  array carries each licence's required attribution string so it
  travels with the data.
- **`windgram terrain`** pipeline command (one-shot; rerun when the
  site catalogue changes; no cadence, no manifest): streams COG
  windows over anonymous HTTPS (~27 MB, under a minute for the whole
  catalogue), fails loudly when a wall-to-wall source returns nodata
  or an analysis disc would cross a tile edge, warns when the DEM
  disagrees with the surveyed elevation by more than 100 m, and
  refuses unknown WorldCover class codes rather than guessing.
  rasterio/numpy live behind a new `terrain` dependency extra so the
  scheduled builds stay lean.
- **Toolkit contract**: `siteContextSchema`, `parseSiteContext` /
  `parseSiteContextJson`, exported entry/block types, and the
  `schema/site-context.schema.json` artifact. A drift test parses the
  committed `site-context.json` so the generator and the contract
  cannot diverge silently.
- **Docs**: a site-context document reference (sources, licences,
  verification stamps, and the honest caveats: GLO-30 is a surface
  model that includes canopy; a single 10 m cover pixel is fragile;
  near-summit aspect is low-confidence), and a learn article — *The
  mountain the model sees* — with infographics drawn from the real
  committed data: the elevation ladder (surveyed vs bare-earth vs
  surface DEM vs the model's smoothed terrain), relief percentiles as
  launch topology, and land-cover composition as thermal-source
  character.
- **GOES-18 validation numbers** in the observation reference
  [verified 2026-08-10, NOAA OSPO Full Data Quality ReadMe]: Enterprise
  DSR bias generally < 30 W/m², std dev of biases generally < 80 W/m²
  vs SURFRAD/SOLRAD — with the caveats that Full maturity was granted
  by default after two anomaly-free years and the narrowband→broadband
  coefficients are still GOES-16-derived. (The long-unreachable
  noaasis.noaa.gov host was decommissioned 2026-06-23; the PS-PVR
  documents live on OSPO now.)

### Notes

- The founding verification lesson, recorded in the reference: HRDEM
  covers only one of the four catalogued sites, and STAC/bbox
  footprints overstate lidar coverage — only pixel sampling proves
  data at a point. That is why bare earth comes from LidarBC/MRDEM
  and the analysis DEM is GLO-30.

## [0.16.0] - 2026-08-10

`windgram` (npm and JSR) 0.16.0 — the observation loop closes: measured
sunlight becomes interpretable, joinable, and drawable — plus the smoke
before/after lesson becoming legible.

### Added

- **`windgram/derive` irradiance**: `clearSkyGhiWm2` (Haurwitz 1945 —
  the best zenith-only clear-sky model per Reno, Hansen & Stein 2012,
  SAND2012-2389), `observedTransmittance` (measured over expected;
  null near the horizon where the ratio means nothing, capped at 1.5
  where cloud-edge brightening and clean air legitimately beat the
  sea-level model), and `nearestObservation` — the join primitive for
  a series that lives at the product's native cadence (GOES scan
  starts), where an exact-key match against a forecast hour never
  hits.
- **The Sun strip**: pass a site's observation document as
  `SceneOptions.observations` and the windgram draws satellite-measured
  W/m² beside its forecasts, nearest-instant per rendered hour, with a
  shadow behind the line that deepens as the measured sky
  under-delivers (tint = 1 − observed transmittance).
  `scene.observationSource` names the dataset and newest instant for
  the mandatory label; `KeySpec.measuredDimming` explains the shadow;
  `cursorReading` packets carry the measurement.
- **Provenance zones in the strip stack**: every strip declares whose
  data it draws (`provenance: "model" | "crossModel" | "measurement"`),
  and anything foreign renders below a labeled divider ("beside this
  model — not in its physics", `scene.stripDivider`) with its source
  and instant written inside the strip (`sourceLabel`) — so the
  pixels, not just the metadata, answer "did the model account for
  this?". A model's own passive smoke stays in the model zone but
  states "this model's forecast · not in its physics"; radiatively
  coupled smoke carries no statement — it is ordinary model data.

### Changed

- The smoke before/after figure contrasts reads, not renders: the base
  panel hides the plume entirely (the smoke-blind READ — clear strips,
  full-strength w*), and only the adjusted panel draws the smoke strip
  beside its derated thermals. Both panels previously showed the same
  smoke bar, leaving nothing that said which one was "smoke-blind".
- `smoke-over-thermals` carries a severe plume through the thermal
  window (τ reaching ~3–3.8 over the working hours, 4.5 by evening —
  the observed severe-episode range), so the correction is visible at
  figure scale: peak w* derates ~16% instead of ~7%. The arc still
  climbs into the evening and all scenario assertions hold.
- The figure's guard tests assert the design, not byte-inequality: the
  base panel must draw no smoke strip, the adjusted panel must, their
  w* strips must differ — and a toolkit test pins the committed
  scenario's correction as material (adjusted peak below 0.87× base)
  while still partial (above 0.5×).

## [0.15.1] - 2026-08-10

`windgram` (npm and JSR) 0.15.1 — fixes plus scenario and site repairs:
every interactive teaching control now visibly moves what it claims to
move.

### Fixed

- The SVG serializer carries a strip cell's data-driven `opacity` into
  the markup. The smoke strip's "haze tint = τ" was graded in the scene
  but dropped at serialization, so every optical depth rendered at the
  same constant CSS tint — the smoke lab's slider changed almost nothing
  visible.
- `buildScene` declares `scene.smokeAdjustment` only when the adjustment
  actually changed at least one hour. Previously the label was set on
  entering the branch, so a correction that touched nothing (sun below
  the horizon through the smoky hours, or w* zero wherever it was up)
  still labeled the panel "smoke-adjusted" over a byte-identical render.
- The `smoke-over-thermals` scenario runs a real afternoon: August 1,
  `America/Vancouver`, hours 10:00–19:00 local at its own longitude. As
  authored (January 1, 10:00–19:00 UTC at −121.8°) every convective hour
  was local night, the zenith-aware transmittance correctly returned 1,
  and the smoke-adjusted view — the scenario's whole lesson — was
  byte-identical to the base. The authoring guide now states the rule: a
  smoke recipe's clock is physics, not convention.
- The usable-lift laboratory teaches on `gusts-after-heating`, whose
  column holds both regimes — midday hours cloud-base-capped at any sink
  rate, shoulder hours sink-limited — so the sink slider visibly moves
  what it can and visibly cannot move what cloud base owns. It taught on
  `cloud-base-limits-lift`, capped at every hour, which pinned the line
  across the slider's entire range.

### Added

- Control-sensitivity guards (`site/test/labs.spec.ts`): every
  laboratory control is driven across its range in the built site, and
  the test fails when the mounted chart (or readout, for the
  readout-only timing lens) does not respond.

## [0.15.0] - 2026-08-10

`windgram` (npm and JSR) 0.15.0 · `windgram` Python pipeline 0.4.0.
The dataset's first measurements: GOES-18 satellite irradiance beside
the forecasts — the smoke correction's constants now have a
measurement stream to answer to. All schema changes are additive.

### Added

- **A third document kind — observation**: per-site measured time
  series at `goes18-dsr/sites/<site>.json` (`observation.schema.json`,
  `parseObservationDocument`), carrying GOES-18 ABI L2 Downward
  Shortwave Radiation at the catalogued sites. Measurements, not
  forecasts: no run block — an `observed` window instead — and an
  absent instant means "not measured" (night, quality flags), never
  zero. The window rolls (~72 h); NOAA's own bucket is the permanent
  archive. Discovery via a new optional catalogue `observationModels`
  array (same pre-existing-parser compatibility as `smokeModels`).
- **An eighth builder** for the full-disk Enterprise DSR (2 km,
  10-minute granules — the product NOAA swapped in during April 2024;
  older docs describing hourly 0.5° DSR are about its predecessor).
  Incremental fetches at the 15-minute build tick, sites located on
  the ABI fixed grid through the PUG Volume 3 forward equations with
  the visibility inequality, and validity requiring both an unmasked
  DSR value AND good DQF — the two live-verified traps (fill inside
  valid_range; DQF 0 on night fill pixels) are documented in the
  builder.

### Fixed

- `runs.json` now indexes every dataset the catalogue declares —
  profile models plus `smokeModels` and `observationModels`. It had
  silently skipped raqdps since 0.13.0, hiding exactly the feeds whose
  freshness matters most.

## [0.14.0] - 2026-08-09

`windgram` (npm and JSR) 0.14.0 — coincident height markers render
honestly.

### Changed

- Coincident derived-height markers render as one symbol: cloud glyphs
  draw before wings, so a wing sharing the hour is never buried under
  the cloud, and a wing at the cloud's own height (the contract caps
  `usableLiftTopM` at `cloudBaseM`, so lift reaching base puts both
  lines on one point) tucks just below the cloud glyph — canopy
  overlapping the cloud's lower body, wing in front — carrying
  `atCloudBase` on its `SceneMarker`.
- The wing marker glyph is a paraglider read whole — canopy arc,
  suspension lines, pilot pod — replacing the bare crescent, which
  disappeared entirely under a coincident cloud.

### Removed

- `MarkerTrainStride.offset` — the phase control existed to shift marker
  trains apart so coincident glyphs would not stack, and the scene now
  renders coincidence itself; the workaround surface goes with the
  workaround. Breaking for callers passing `{ every, offset }`; the
  `{ every }` object and bare-number forms are unchanged.

## [0.13.0] - 2026-08-09

`windgram` (npm and JSR) 0.13.0 · `windgram` Python pipeline 0.3.0.
Wildfire smoke lands across every layer, plus the dataset-hosting move.
All schema changes are additive; documents and catalogues that predate
smoke parse unchanged.

### Added

- **Profiles carry smoke where the model does**: an optional per-hour
  `smoke` block (`surfaceUgm3`, `columnMgm2`, `aot`) on models declaring
  `capabilities.smoke` — HRRR today, whose three smoke records ship in the
  files the builder already reads. The token is a coupling claim, not a
  boolean: HRRR declares `"radiativelyCoupled"` because its forecast smoke
  attenuates its own shortwave (fluxes and derived w* are already
  smoke-aware), echoed per document as `semantics.smoke`.
- **A new document kind**: per-site wildfire-smoke time series from ECCC's
  RAQDPS (`raqdps/sites/<site>.json`, `smoke.schema.json`,
  `parseSmokeDocument`), built by a seventh builder — 00Z/12Z, hourly to
  72 h. The catalogue lists it in a new optional `smokeModels` array,
  separate from `models` so pre-smoke consumers keep parsing untouched.
- **`windgram/derive` smoke corrections**: cited constants
  (`SMOKE_MASS_EXTINCTION_M2_PER_G`, `SMOKE_TRANSMITTANCE_K_MIDDAY`/
  `K_VERTICAL`), `smokeAotFromColumn`, `smokeTransmittance`,
  `smokeAdjustedThermalVelocityMs` (= w* × ∛f over published values),
  `smokeHoursByValidAt`, `isSmokeAwareProfile`, and `cosSolarZenith`.
- **Scene and SVG**: a `smoke` overlay strip (concentration line, haze
  cells whose opacity is optical depth) fed by the profile's own block or
  a joined smoke document — one source per strip, never blended, named in
  `scene.smokeSource`; a `smokeAdjusted` render option building the
  labeled alternate view (`scene.smokeAdjustment`, `KeySpec.smokeAdjusted`,
  haze chip `KeySpec.smokeHaze`); smoke in `cursorReading` packets.
- **Teaching scenario** `smoke-over-thermals` with base and adjusted SVG
  goldens, and two portal pages: *Smoke and thermals* (learn) and the
  *Smoke document* reference.

### Changed

- The published dataset moved out of git to public object storage: model
  manifests, current profiles, history archives, and `runs.json` are served
  from <https://data.meteo.azohra.com>, with the authored catalogues
  (`models.json`, `sites.json`) published at the same root. Consumers who
  fetched `raw.githubusercontent.com/azohra/windgram/main/data/...` should
  point at the new base; paths under it are unchanged.
- `models.json` lives at the repository root beside `sites.json` — `data/`
  held only generated output, and that output no longer lands in git.
- Builders learn what is already published from the data base itself
  (`WINDGRAM_DATA_BASE`, default the public URL): the already-published
  check and history appends fetch over HTTPS instead of reading a committed
  tree, and the build workflow uploads each completed model instead of
  committing it, so the repository is a pure source repo.

### Removed

- The scheduled workflow's commit-and-rebase publishing machinery
  (`.github/scripts/commit-data.sh`); the run index converges by
  regeneration from the published manifests instead.

## [0.12.0] - 2026-08-09

`windgram` (npm and JSR) 0.12.0.

### Added

- `resolveSelection(scene, { hourIndex, altitudeM? })` — the selection
  resolver as an exported scene query. It is the very function `buildScene`
  runs for its `selection` option (the build now delegates to it), so a
  consumer overlay that must not pay for a rebuild — the hover preview in
  the Wire-an-inspector recipe — draws from geometry that cannot differ
  from the serializer-drawn pin. Demanded by the first downstream rewrite,
  where preview and pin otherwise resolve through two implementations.

## [0.11.0] - 2026-08-09

`windgram` (npm and JSR) 0.11.0 — the scene interaction extensions from the
two-part interact audit: pure queries and key-spec coverage in the package's
existing homes, no new subpath, with the pointer state machine shipping as a
portal recipe rather than code.

### Added

- Scene interaction queries beside the hit-tests: `clientPointToScene`
  (client pixels → scene coordinates through the mount's rect, DOM-free),
  `hourIndexForValidAt` (the pin-carry primitive — selections keyed by
  `validAt` survive hour-window renumbering; index-keyed pins silently
  move), fractional `xForTime` for time cursors and solar ticks, and
  `drawnBarbsForHour` / `nearestDrawnBarb` over the barbs a column actually
  drew. `hourIndexForX` gains `{ clamp: true }` so strips and margins still
  select; `xForTime` takes the same option to pin out-of-window instants to
  the frame edges.
- Barb identity as scene facts: every `BarbPlacement` carries its
  `hourIndex`, data `altitudeM`, and a `surface` flag, closing the gap that
  had the first consumer restating the surface row's offset as its own
  `+28 m` constant.
- Consumer selection as a scene option: `selection: { hourIndex, altitudeM? }`
  resolves against what the build drew (reported as `scene.selection`), and
  the reference serializer renders the tinted column, centre hairline, and
  barb ring (`wg-selection-*` classes, themed by the new `--wg-selection`
  token) — so the marker and the consumer's readout share one authority.
  Golden-covered (`selection.svg`), distinct from the computed peak-W*
  `selectedHourIndex`.
- `buildKeySpec` coverage: field-overlay `ramps` whose chips carry the drawn
  classes in weak-to-strong reading order, and a `selfLabeled` opt-in that
  admits the Td-isoline and plain-isotherm families with their real style
  facts. `renderKeySvg` draws the ramps with the classes themselves, so
  fill and opacity inherit from the same rules that shaded the chart.
- Pitch policy as build options: `minColumnWidthPx` / `maxColumnWidthPx`
  clamp the resolved column pitch (the minimum wins a conflict), and
  `fitMinColumns` keeps a short window from stretching by making the
  `widthPx` fit divide by at least that many columns — so a density policy
  is one build instead of a probe build plus a corrected one. Defaults
  change nothing.
- Token authorities for legends built outside SVG: `SERIES_TOKENS`
  (key-entry id → theme token, replacing downstream id parsing) and
  `FIELD_STYLE_DEFAULTS` (field class → fill token and opacity, replacing
  restated `0.55`/`0.5` opacities); the default stylesheet now derives
  those rules from the maps, byte-identically.
- A "Wire an inspector" portal page — the preview/pin/touch state machine
  as a documented recipe with figures (a real render of the selection
  option, and the state diagram), the pointer→selection pipeline, the
  rebuild-versus-overlay tradeoff, and the carry-or-reset decision — plus
  scene, svg, and defaults-and-tokens page coverage of the new exports.

### Removed

- The deep browser QA suites (per-route accessibility audits, interaction
  contracts, stable-frame and overflow checks) and the no-live-data gate:
  presentation-layer ceremony disproportionate to a documentation site, and
  a design guidance that had been mechanized into a permanent contract. The
  site keeps two browser tests — content-source routes exist in the build,
  and the rendered windgram matches the package's presentation defaults.
- The end-to-end club-project rehearsal test, the builder source-text grep
  assertions, and the doc-parity prose pins (including the CITATION.cff
  version fence): checks whose maintenance tax outweighed their stakes.
  The club example now lives in the portal's publish guide as
  compile-checked code fences instead of a checked-in project — the
  doc-fences gate proves it against the built package on every push, and
  its inputs are the real published dataset.

## [0.10.0] - 2026-08-09

### Added

- JSR publishing: one `toolkit-v` tag releases the package to npm and JSR
  (`@azohra/windgram`) in lockstep, version-guarded on `package.json` and
  `jsr.json`.
- `SceneGraph` `scales.stripTop` publishes the strip-stack origin the scene
  already owned, so serializers stop re-declaring it.

- A transport documentation page — the one home for the torn-read problem,
  `loadProfile`'s miss/stale contract, `loadRuns`, and `runsConsistent` —
  and an opening figure on every TypeScript documentation page, rendered at
  build time from committed scenarios by the real package.
- Generated documentation figures: a registry script that outlines brand
  typography to paths, producing the README hero, an npm package hero, a
  six-scenario gallery, and a link-preview social card, all drift-checked
  in CI. Pages site-wide now emit `og:image`/`twitter:image`.
- Documentation rot machinery: parity tests asserting documented versions
  and defaults against package exports and source, and CI typechecking of
  every TypeScript code fence in the documentation against the built
  package.
- The contract's building-block exports documented on the contract page.

### Changed

- The repository is reorganized around its four layers — `pipeline/` (the
  Python pipeline, released to PyPI on `pipeline-v*` tags), `toolkit/` (this
  package, formerly `packages/windgram`), `site/`, and `data/` — with
  internal package splits whose rendered output is byte-identical.
- The documentation portal is the authority for package API detail. The
  package README is a front door — badges, hero, one sixty-second example,
  an entry-points table linking each subpath's guide — and the root README
  gains badges, the scenario gallery, and a lineage section crediting
  canadarasp and soaringmeteo.
- Multi-home facts (the transport contract, timezone-echo semantics, the
  authority boundary) collapsed to one home each; portal tables render
  live values from package imports wherever the value is exported.
- Conventions rewritten: one stakes sentence, seven mechanisms.

### Removed

- Stored-PNG visual snapshots: browser rasterization is platform-bound, so
  committed baselines only ever matched the machine that reviewed them. The
  platform-independent assertions — stable-frame self-comparison, overflow
  containment, reduced-motion audits — now run in CI, and pixel-exact chart
  output stays fenced by the golden SVGs.

### Fixed

- Stale npm version statements in the versioning page (now rendered from
  imports); a false `windgram/schema` export-specifier claim; one
  non-compiling documentation example.

- The data publisher resolves same-model rebase conflicts by the manifests'
  referenceTime — the newer publication wins, a duplicate of an
  already-published run is dropped — and builder jobs check out the branch
  tip at job start instead of the SHA pinned at run creation.
- CI runs every site suite except the visual snapshots, whose committed
  baselines only match the platform they were reviewed on; screenshot
  comparison stays a local review gate.
- The club journey's checkout-side pnpm commands run from inside the
  checkout, where corepack resolves the pinned pnpm version; test failures
  now carry the failing subprocess's own output.

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

[Unreleased]: https://github.com/azohra/windgram/compare/toolkit-v0.10.0...HEAD
[0.10.0]: https://github.com/azohra/windgram/compare/v0.9.1...toolkit-v0.10.0
[0.9.1]: https://github.com/azohra/windgram/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/azohra/windgram/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/azohra/windgram/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/azohra/windgram/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/azohra/windgram/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/azohra/windgram/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/azohra/windgram/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/azohra/windgram/tree/v0.3.0

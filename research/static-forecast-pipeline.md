# How the static forecast pipeline works

Windgram publishes profiles as static JSON. Weather centres run the numerical models, GitHub Actions
derives each site profile, git records each publication, and browsers fetch the files. The project
operates no application server, database service, queue, or API; it still depends on provider and
GitHub infrastructure.

## Each model builder follows the same run contract

A scheduled workflow wakes every 15 minutes. Each builder has the same contract:

1. Discover the newest upstream cycle.
2. Probe its final required forecast hour; exit if the run is incomplete.
3. Compare the cycle with the local manifest; exit if nothing is new.
4. Fetch only what the derivation needs — by byte range or crop where the provider permits,
   whole-domain files where it does not.
5. Validate, derive, and serialize deterministically.
6. Write one model directory and append its history records.
7. Commit all completed model updates once.

A concurrency group prevents overlapping schedules from racing. Experimental or less reliable feeds
can warn without blocking the baseline publish. Quiet no-op exits make aggressive polling cheap and
polite: most schedules perform one discovery request and stop.

## Git records each publication

Each completed model run contributes one deterministic change set to the workflow commit:

- `git log data/<model>/manifest.json` shows its publication history.
- Diffs expose field, site, and serialization changes.
- Manifests record request count, byte volume, and duration for the build.
- A bad publication can be reverted with ordinary repository history.

Stable, small output makes Git viable. Key order is deliberate; integral floats are normalized; each
builder writes only its own model directory. Append-oriented files measured in kilobytes per site remain
reviewable. Arbitrary mutable binaries would not.

The Python derivation reproduces the output of the TypeScript implementation that served as its
verification oracle within one double ULP.
Serialization preserves the TypeScript representation: integral floats become integers and dictionary
key order remains stable. When diffs are the audit trail, representation is part of correctness.

## Match every profile to its manifest

Consumers read files from `raw.githubusercontent.com`. A manifest and a site profile are cached
independently, so immediately after a commit a browser may receive a new manifest and an older profile—or
the reverse.

Every profile therefore carries its own `referenceTime`. The client accepts the file only when that time
matches the manifest it just read. On mismatch it retains the previous good copy and retries later. A
few lines at the trust boundary replace server-side transactions for this update pattern.

## Two transports: byte ranges and whole-domain streams

NOAA and ECCC price the same job differently. NOAA places a plain-text `.idx` beside each GRIB2
object, so the HRRR, GFS, and NAM builds fetch only the records the derivation needs. ECCC's Datamart has no
index and one message per file, so the ECCC builds fetch whole-domain files — gigabytes per run —
streaming each into memory, sampling the catalogued launches, and dropping it before the next fetch,
so peak residency stays at a handful of files regardless of run size.

The pipeline once read the ECCC models through GeoMet WCS crops of a few kilobytes each. It gave that
subsetting up deliberately: the crops were a rendering of the model, and the fields the derivation
most wanted — vertical velocity, true dew point, the full low-level column — were never in them. The
bytes bought data that did not otherwise exist.

All transports identify the project with a real User-Agent, honor `Retry-After`, and retry 429 and 5xx
responses with jitter. Free public data remains viable when clients are visible and bounded.

## Append history as concatenated gzip members

Each publication also appends one JSON line to:

```
data/<model>/history/<slug>/<YYYY-MM>.jsonl.gz
```

The line is compressed as its own gzip member and appended byte-for-byte. The gzip format permits
concatenated members, so `zcat` and Python’s `gzip` expose one continuous JSONL stream while existing
compressed bytes never change. A few tens of kilobytes per site per run buys the dataset needed for
forecast verification, bias studies, and later calibration.

## The static pipeline has no query API or atomic multi-file read

The static pipeline also provides no database index or service-level agreement.
GitHub’s availability and acceptable-use rules are dependencies. History queries require downloading
the archive, and a large site catalogue would eventually outgrow repository ergonomics.

The catalogue has four sites, small JSON profiles, and model cycles no faster than hourly. A larger
catalogue can keep the derivation and file schema while moving publication and history to another store.

This pipeline descends from [canadarasp](https://github.com/ajberkley/canadarasp#readme), which ran
this job for years and published its operations openly enough to learn from — a debt this project is
glad to carry. The derivations began as a faithful port of its constants. The jobs and architectures
differ: canadarasp draws national maps from a standing server; this project derives site columns on
scheduled runners and publishes static files.

Executable details: [the workflow](../.github/workflows/build.yml),
[`windgram/publish.py`](../windgram/publish.py), and the per-provider builders in `windgram/`.

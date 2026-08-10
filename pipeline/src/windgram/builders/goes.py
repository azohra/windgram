"""Builds per-site observation documents from GOES-18's ABI L2 full-disk
products — the pipeline's measurements, not forecasts. One module, N
products (PRODUCTS), each published as its own observation dataset:
Downward Shortwave Radiation (goes18-dsr) and Aerosol Optical Depth
(goes18-aod).

Both full-disk Enterprise products (verified 2026-08-10): one NetCDF
granule every 10 minutes on the anonymous `noaa-goes18` bucket, ~6
minutes behind the scan, the identical 5424² 2 km-nadir fixed grid with
the same projection attributes (effective ~2.4 × 4.1 km at the
catalogued sites' 49°N view angle). Files carry no lat/lon — sites are
located on the ABI fixed grid through the GOES-R PUG Volume 3 forward
equations, using each granule's OWN projection attributes so nothing
hardcoded can drift. Validity is per product — see PRODUCTS — and a
value publishes only when it passes; everything else is absence, never
zero and never clear air.

The build is incremental: granules newer than the published manifest's
`lastObservedAt` (bounded by WINDGRAM_GOES_BACKFILL_HOURS, default 6)
are sampled, merged into each site's rolling ~72 h window, and
republished. Each granule is read by HTTP Range by default — the four
sites' pixels live in a handful of HDF5 chunks, a few hundred KiB of a
9–41 MB file — with an automatic whole-file fallback on any ranged-path
failure (a fallback is printed, not an error). Both paths read through
h5py: one HDF5 stack per process (see _granule).

History: NOAA's own bucket is the permanent granule archive, but each
observation instant is also archived once — the first time it enters
the window — under <slug>/history/<site>/<YYYY-MM>.jsonl.gz, the month
taken from the observation's own observedAt. The line grammar
deliberately differs from profile history: one observation OBJECT per
line, not one whole document per run — the window is rebuilt every
~15 minutes, so archiving documents would store each instant ~400
times over.
"""

from __future__ import annotations

import io
import json
import math
import os
import re
import sys
import time
import xml.etree.ElementTree as ElementTree
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import h5py
import numpy
import requests

from ..config import output_directory
from ..dataset import fetch_published, published_manifest
from ..noaa import DownloadStats
from ..publish import (
    append_history_lines,
    manifest_stats,
    round_document,
    write_json,
)
from ..rangedfile import RangedHTTPFile
from ..sites import load_sites

SCHEMA_VERSION = 1
BUCKET = "https://noaa-goes18.s3.amazonaws.com"
WINDOW_HOURS = 72
DEFAULT_BACKFILL_HOURS = 6
REQUEST_TIMEOUT_S = 120
# A site farther than one grid step from its nearest fixed-grid point is
# outside the disk (or the projection math broke) — refuse, don't clamp.
MAX_INDEX_OFFSET_RAD = 5.6e-05 * 1.5


@dataclass(frozen=True)
class Product:
    """One GOES-18 L2 product published as one observation dataset."""

    slug: str
    prefix: str  # S3 key prefix on the noaa-goes18 bucket
    variable: str  # the granule's retrieval variable
    value_key: str  # the published observation field
    max_quality: int  # a retrieval is valid when unmasked AND DQF <= this
    label: str  # log prose


PRODUCTS = {
    # DSR's two validity traps, both measured live: `_FillValue` (65535)
    # sits INSIDE `valid_range`, and DQF=0 does NOT imply a retrieval —
    # night pixels are fill with DQF=0. Unmasked AND DQF==0, always both.
    "goes18-dsr": Product(
        slug="goes18-dsr",
        prefix="ABI-L2-DSRF",
        variable="DSR",
        value_key="downwardShortwaveWm2",
        max_quality=0,
        label="GOES-18 DSR",
    ),
    # AOD accepts DQF <= 1 (high + medium quality): Zhang, Kondragunta
    # et al. 2020 (AMT 13:5955) found high-only very conservative — the
    # top-2 set scores bias 0.04, RMSE 0.09 against AERONET. AOD's
    # _FillValue 65535 sits OUTSIDE valid_range [0, 65530], so netCDF4
    # masking alone would suffice [verified 2026-08-10, live granule] —
    # but the unmasked-AND-DQF gate is shared code and stays.
    "goes18-aod": Product(
        slug="goes18-aod",
        prefix="ABI-L2-AODF",
        variable="AOD",
        value_key="aot",
        max_quality=1,
        label="GOES-18 AOD",
    ),
}

_S3_NS = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
_KEY_STAMP = re.compile(r"_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})\d_")


def _out_dir(product: Product) -> Path:
    return output_directory(product.slug)


def main(product: Product = PRODUCTS["goes18-dsr"]) -> None:
    sites = load_sites()
    now = datetime.now(timezone.utc)
    backfill_hours = float(os.environ.get("WINDGRAM_GOES_BACKFILL_HOURS", DEFAULT_BACKFILL_HOURS))
    manifest = published_manifest(product.slug)
    last_observed = (
        _instant_to_datetime(manifest["lastObservedAt"])
        if manifest is not None
        else now - timedelta(hours=backfill_hours)
    )
    # A stale dataset never triggers an unbounded catch-up fetch.
    last_observed = max(last_observed, now - timedelta(hours=backfill_hours))

    stats = DownloadStats()
    keys = _scan_keys_since(product, last_observed, now, stats)
    if not keys:
        print(f"No {product.label} granules newer than {_datetime_to_instant(last_observed)}.")
        return

    print(f"Sampling {len(keys)} {product.label} granules for {len(sites)} sites…")
    started_at = time.monotonic()
    new_observations: dict[str, list[dict]] = {site["slug"]: [] for site in sites}
    indices: dict[str, tuple[int, int]] | None = None
    for key, observed_at in keys:
        indices, samples, path_used = _granule_samples(
            f"{BUCKET}/{key}", product, sites, indices, stats
        )
        print(f"  {key.rsplit('/', 1)[-1]}: {path_used}")
        for site_slug, value in samples.items():
            new_observations[site_slug].append({"observedAt": observed_at, product.value_key: value})

    total_new = sum(len(entries) for entries in new_observations.values())
    if total_new == 0:
        print(f"No valid {product.label} retrievals in {len(keys)} granules (night or flagged).")
        return

    generated_at = _datetime_to_instant(datetime.now(timezone.utc))
    sites_dir = _out_dir(product) / "sites"
    sites_dir.mkdir(parents=True, exist_ok=True)
    history_dir = _out_dir(product) / "history"
    first_observed_at = None
    last_observed_at = None
    observation_count = 0
    for site in sites:
        observations, newly_added = _merged_window(
            product, site["slug"], new_observations[site["slug"]]
        )
        if not observations:
            continue
        _append_history(product, site["slug"], newly_added, history_dir)
        document = _site_document(product, site, observations, generated_at)
        write_json(sites_dir / f"{site['slug']}.json", document, compact=True)
        observation_count += len(observations)
        if first_observed_at is None or observations[0]["observedAt"] < first_observed_at:
            first_observed_at = observations[0]["observedAt"]
        if last_observed_at is None or observations[-1]["observedAt"] > last_observed_at:
            last_observed_at = observations[-1]["observedAt"]

    manifest_document = {
        # referenceTime doubles as the freshness instant everywhere the
        # dataset machinery compares manifests; for observations it is the
        # newest measured instant, stated again as lastObservedAt.
        "firstObservedAt": first_observed_at,
        "generatedAt": _instant_milliseconds(),
        "lastObservedAt": last_observed_at,
        "model": product.slug,
        "observationCount": observation_count,
        "referenceTime": last_observed_at,
        "schemaVersion": SCHEMA_VERSION,
        "sites": [{"name": site["name"], "slug": site["slug"]} for site in sites],
        "stats": manifest_stats(stats, started_at),
    }
    write_json(_out_dir(product) / "manifest.json", manifest_document, compact=False)
    print(
        f"Published {total_new} new {product.label} observations "
        f"(window now {first_observed_at} … {last_observed_at}, "
        f"{stats.requests} requests, {stats.response_bytes // (1024 * 1024)} MiB)."
    )


def _scan_keys_since(
    product: Product, last_observed: datetime, now: datetime, stats: DownloadStats
) -> list[tuple[str, str]]:
    """Granule keys with a scan start strictly after last_observed,
    chronological, discovered hour prefix by hour prefix."""
    keys: list[tuple[str, str]] = []
    cursor = last_observed.replace(minute=0, second=0, microsecond=0)
    while cursor <= now:
        prefix = (
            f"{product.prefix}/{cursor.year}/{cursor.timetuple().tm_yday:03d}/{cursor.hour:02d}/"
        )
        for key in _list_keys(prefix, stats):
            stamp = _KEY_STAMP.search(key)
            if not stamp:
                continue
            observed = _stamp_to_datetime(stamp)
            if observed > last_observed:
                keys.append((key, _datetime_to_instant(observed)))
        cursor += timedelta(hours=1)
    keys.sort(key=lambda entry: entry[1])
    return keys


def _list_keys(prefix: str, stats: DownloadStats) -> list[str]:
    payload = _fetch(f"{BUCKET}/?list-type=2&prefix={prefix}", stats)
    root = ElementTree.fromstring(payload)
    return [
        element.text
        for element in root.findall("s3:Contents/s3:Key", _S3_NS)
        if element.text and element.text.endswith(".nc")
    ]


# ------------------------------------------------------- granule sampling


def _granule_samples(
    url: str,
    product: Product,
    sites: list[dict],
    indices: dict[str, tuple[int, int]] | None,
    stats: DownloadStats,
) -> tuple[dict[str, tuple[int, int]], dict[str, float], str]:
    """Every site's valid retrieval from one granule: ranged reads by
    default, a whole-file download through the same h5py wrapper as the
    safety net on ANY ranged-path failure — a fallback costs one full
    download, never the build."""
    try:
        with _ranged_granule(url, stats) as granule:
            indices, samples = _sample_sites(granule, product, sites, indices)
        return indices, samples, "ranged"
    except Exception as error:  # noqa: BLE001 — any ranged failure falls back
        print(f"Ranged read of {url.rsplit('/', 1)[-1]} failed ({error}); downloading whole.")
    with _granule(_fetch(url, stats)) as granule:
        indices, samples = _sample_sites(granule, product, sites, indices)
    return indices, samples, "whole-file"


def _sample_sites(
    granule, product: Product, sites: list[dict], indices: dict[str, tuple[int, int]] | None
) -> tuple[dict[str, tuple[int, int]], dict[str, float]]:
    """The granule's valid retrievals per site slug. The fixed grid is
    identical across granules and products [verified 2026-08-10,
    side-by-side granule dump], so indices are located once and reused."""
    if indices is None:
        indices = {site["slug"]: _site_index(granule, site) for site in sites}
    values = granule[product.variable]
    dqf = granule["DQF"]
    samples: dict[str, float] = {}
    for site in sites:
        y_index, x_index = indices[site["slug"]]
        value = values[y_index, x_index]
        # Masked means _FillValue or out of valid_range — no retrieval
        # (night, gaps). DQF alone proves nothing (DSR fill pixels carry
        # DQF 0), so the gate is always unmasked AND quality.
        if value is None or getattr(value, "mask", False):
            continue
        quality = dqf[y_index, x_index]
        if getattr(quality, "mask", False) or int(quality) > product.max_quality:
            continue
        samples[site["slug"]] = float(value)
    return indices, samples


def _granule(payload: bytes) -> "_Granule":
    """The whole-file path: the same h5py wrapper over an in-memory copy.

    Deliberately NOT netCDF4: the h5py and netCDF4 wheels each bundle
    their own libhdf5, and loading both into one process segfaults the
    interpreter at shutdown (exit 139 — observed on every Linux CI run
    of the first 0.6.0 push, after all tests had passed). One HDF5 stack
    per process is the invariant; netCDF4 survives only as the tests'
    subprocess-isolated reference implementation."""
    return _Granule(io.BytesIO(payload))


class _Granule:
    """Just enough of a netCDF4.Dataset's surface for sampling and site
    navigation, over h5py on any seekable file. When the file is a
    RangedHTTPFile the reader never raises inside h5py's driver callbacks
    (see rangedfile) — instead every operation here re-raises the
    reader's recorded failure, so a poisoned read can never masquerade
    as data."""

    def __init__(self, fileobj) -> None:
        self._fileobj = fileobj
        try:
            self._file = h5py.File(fileobj, "r")
        except Exception:
            # A transport failure surfaces as an unparseable file; the
            # recorded error names the real cause.
            self._raise_reader_error()
            raise
        self._raise_reader_error()

    def _raise_reader_error(self) -> None:
        error = getattr(self._fileobj, "error", None)
        if error is not None:
            raise error

    def __getitem__(self, name: str) -> "_RangedVariable":
        variable = _RangedVariable(self._file[name], self._raise_reader_error)
        self._raise_reader_error()
        return variable

    def __enter__(self) -> "_Granule":
        return self

    def __exit__(self, *exc) -> None:
        self._file.close()
        self._fileobj.close()


_HDF5_SIGNATURE = b"\x89HDF\r\n\x1a\n"


def _ranged_granule(url: str, stats: DownloadStats) -> "_Granule":
    """The ranged path, with a signature gate in front of h5py.

    A failed `h5py.File(...)` leaves partially-initialized HDF5 library
    state whose atexit teardown can segfault the interpreter AFTER
    Python finalization (exit 139 — proven by CI bisect 2026-08-10: the
    fallback tests alone crashed the process, after passing). So h5py
    never sees a file that cannot be HDF5: a poisoned reader or a
    garbage first block fails here, cheaply (block 0 stays cached for
    h5py's own superblock read), and the whole-file fallback takes
    over. GOES granules carry the signature at offset 0."""
    reader = RangedHTTPFile(url, stats)
    signature = reader.read(len(_HDF5_SIGNATURE))
    if reader.error is not None:
        raise reader.error
    if signature != _HDF5_SIGNATURE:
        raise RuntimeError(f"{url} does not start with the HDF5 signature")
    reader.seek(0)
    return _Granule(reader)


class _RangedVariable:
    """One h5py dataset wearing netCDF4's variable conventions: scalar
    attribute access, and indexing that applies netCDF4's auto
    mask-and-scale — mask the RAW integers against _FillValue and
    valid_range, then data*scale_factor + add_offset in the attributes'
    own dtypes — so ranged values are bit-identical to the whole-file
    netCDF4 path."""

    def __init__(self, dataset, raise_reader_error) -> None:
        self._dataset = dataset
        self._raise_reader_error = raise_reader_error

    def __getattr__(self, name: str):
        try:
            value = self._dataset.attrs[name]
        except KeyError:
            raise AttributeError(name) from None
        self._raise_reader_error()
        return _attribute_scalar(value)

    def __getitem__(self, item):
        raw = self._dataset[item]
        self._raise_reader_error()
        data = numpy.ma.masked_array(raw)
        attributes = self._dataset.attrs
        if "_FillValue" in attributes:
            data = numpy.ma.masked_equal(data, _attribute_scalar(attributes["_FillValue"]))
        if "valid_range" in attributes:
            low, high = numpy.asarray(attributes["valid_range"]).reshape(-1)
            data = numpy.ma.masked_outside(data, low, high)
        if "scale_factor" in attributes:
            scale = _attribute_scalar(attributes["scale_factor"])
            offset = (
                _attribute_scalar(attributes["add_offset"])
                if "add_offset" in attributes
                else numpy.zeros((), dtype=scale.dtype)[()]
            )
            data = data * scale + offset
        elif "add_offset" in attributes:
            data = data + _attribute_scalar(attributes["add_offset"])
        return data


def _attribute_scalar(value):
    """A single-valued attribute as a NUMPY scalar — netCDF stores scalar
    attributes as 1-element arrays, and the numpy dtype (float32 for these
    products) must survive so the unpacking arithmetic promotes exactly as
    netCDF4's does."""
    array = numpy.asarray(value)
    return array.reshape(-1)[0] if array.size == 1 else array


# ------------------------------------------------------- site navigation


def _site_index(granule, site: dict) -> tuple[int, int]:
    """The site's nearest fixed-grid pixel, from the granule's own
    projection attributes via the GOES-R PUG Volume 3 forward equations
    (geodetic → scan angles; sweep_angle_axis x)."""
    projection = granule["goes_imager_projection"]
    req = float(projection.semi_major_axis)
    rpol = float(projection.semi_minor_axis)
    satellite_radius = float(projection.perspective_point_height) + req
    lon0 = math.radians(float(projection.longitude_of_projection_origin))

    lat = math.radians(site["latitude"])
    lon = math.radians(site["longitude"])
    geocentric_lat = math.atan((rpol * rpol) / (req * req) * math.tan(lat))
    rc = rpol / math.sqrt(
        1 - ((req * req - rpol * rpol) / (req * req)) * math.cos(geocentric_lat) ** 2
    )
    sx = satellite_radius - rc * math.cos(geocentric_lat) * math.cos(lon - lon0)
    sy = -rc * math.cos(geocentric_lat) * math.sin(lon - lon0)
    sz = rc * math.sin(geocentric_lat)
    # PUG visibility inequality: without it the forward equations happily
    # map a point BEHIND the earth onto plausible-looking scan angles near
    # the disk centre.
    if satellite_radius * (satellite_radius - sx) < sy * sy + (req * req) / (
        rpol * rpol
    ) * sz * sz:
        raise RuntimeError(f"{site['name']} is outside the GOES-18 full-disk grid")
    x = math.asin(-sy / math.sqrt(sx * sx + sy * sy + sz * sz))
    y = math.atan(sz / sx)

    x_values = granule["x"][:]
    y_values = granule["y"][:]
    x_index = int(abs(x_values - x).argmin())
    y_index = int(abs(y_values - y).argmin())
    if (
        abs(float(x_values[x_index]) - x) > MAX_INDEX_OFFSET_RAD
        or abs(float(y_values[y_index]) - y) > MAX_INDEX_OFFSET_RAD
    ):
        raise RuntimeError(f"{site['name']} is outside the GOES-18 full-disk grid")
    return y_index, x_index


# --------------------------------------------------- window and history


def _merged_window(
    product: Product, site_slug: str, new_entries: list[dict]
) -> tuple[list[dict], list[dict]]:
    """The published window plus the new samples, deduplicated by instant,
    chronological, trimmed to WINDOW_HOURS behind the newest — plus the
    entries whose instants are genuinely new to the window, the
    authoritative "archive these once" set (a re-listed instant replaces
    its published twin in the window but is NOT new)."""
    merged: dict[str, dict] = {}
    payload = fetch_published(f"{product.slug}/sites/{site_slug}.json")
    if payload is not None:
        published = json.loads(payload)
        for entry in published.get("observations", []):
            merged[entry["observedAt"]] = entry
    published_instants = set(merged)
    newly_added: dict[str, dict] = {}
    for entry in new_entries:
        merged[entry["observedAt"]] = entry
        if entry["observedAt"] not in published_instants:
            newly_added[entry["observedAt"]] = entry
    if not merged:
        return [], []
    observations = sorted(merged.values(), key=lambda entry: entry["observedAt"])
    horizon = _instant_to_datetime(observations[-1]["observedAt"]) - timedelta(hours=WINDOW_HOURS)
    window = [
        entry
        for entry in observations
        if _instant_to_datetime(entry["observedAt"]) >= horizon
    ]
    return window, sorted(newly_added.values(), key=lambda entry: entry["observedAt"])


def _site_document(
    product: Product, site: dict, observations: list[dict], generated_at: str
) -> dict:
    """One site's published observation document, rounded per the
    contract's table — the shape toolkit/schema/observation.schema.json
    holds every observation dataset to."""
    return round_document(
        {
            "schemaVersion": SCHEMA_VERSION,
            "model": product.slug,
            "observed": {
                "firstObservedAt": observations[0]["observedAt"],
                "lastObservedAt": observations[-1]["observedAt"],
                "generatedAt": generated_at,
            },
            "site": {
                "id": site["slug"],
                "name": site["name"],
                "latitude": site["latitude"],
                "longitude": site["longitude"],
                **({"timeZone": site["timeZone"]} if site.get("timeZone") else {}),
            },
            "observations": observations,
        }
    )


def _append_history(
    product: Product, site_slug: str, newly_added: list[dict], history_dir: Path
) -> None:
    """Archives each observation instant exactly once, when it first
    enters the window: one observation object per JSON line (NOT one
    document per run — see the module docstring), rounded exactly as the
    published window is, under the month of the observation's own
    observedAt — a granule near a month boundary lands in its own month,
    not the run's."""
    by_month: dict[str, list[dict]] = {}
    for entry in newly_added:
        by_month.setdefault(entry["observedAt"][:7], []).append(round_document(entry))
    for month in sorted(by_month):
        append_history_lines(product.slug, site_slug, month, by_month[month], history_dir)


# ----------------------------------------------------------------- misc


def _fetch(url: str, stats: DownloadStats) -> bytes:
    last_error: Exception | None = None
    for attempt in range(3):
        stats.record_request(retry=attempt > 0)
        try:
            response = requests.get(url, timeout=REQUEST_TIMEOUT_S)
            if response.status_code == 200:
                stats.record_bytes(len(response.content))
                return response.content
            if response.status_code < 500:
                raise RuntimeError(f"GOES {url} failed with {response.status_code}")
            last_error = RuntimeError(f"GOES {url} failed with {response.status_code}")
        except requests.RequestException as error:
            last_error = error
        time.sleep(2**attempt)
    raise RuntimeError(f"GOES {url} failed after retries") from last_error


def _stamp_to_datetime(stamp: re.Match) -> datetime:
    year, day_of_year, hour, minute, second = (int(group) for group in stamp.groups())
    return datetime(year, 1, 1, hour, minute, second, tzinfo=timezone.utc) + timedelta(
        days=day_of_year - 1
    )


def _instant_to_datetime(instant: str) -> datetime:
    return datetime.fromisoformat(instant.replace("Z", "+00:00"))


def _datetime_to_instant(value: datetime) -> str:
    return value.strftime("%Y-%m-%dT%H:%M:%SZ")


def _instant_milliseconds() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


if __name__ == "__main__":
    try:
        main(PRODUCTS[sys.argv[1]] if len(sys.argv) > 1 else PRODUCTS["goes18-dsr"])
    except Exception as error:  # noqa: BLE001 — the workflow wants the message, not a trace
        print(error, file=sys.stderr)
        sys.exit(1)

"""Builds per-site observation documents from GOES-18's ABI L2 Downward
Shortwave Radiation — the pipeline's first measurements, not forecasts.

The full-disk Enterprise DSR (verified 2026-08-10): one NetCDF granule
every 10 minutes on the anonymous `noaa-goes18` bucket, ~6 minutes behind
the scan, 2 km nadir grid (effective ~2.4 × 4.1 km at the catalogued
sites' 49°N view angle). Files carry no lat/lon — sites are located on
the ABI fixed grid through the GOES-R PUG Volume 3 forward equations,
using each granule's OWN projection attributes so nothing hardcoded can
drift. Two validity traps, both measured live: `_FillValue` (65535) sits
INSIDE `valid_range`, and DQF=0 does NOT imply a retrieval — night
pixels are fill with DQF=0. A value publishes only when DSR is unmasked
AND DQF is 0; everything else is absence, never zero.

The build is incremental: granules newer than the published manifest's
`lastObservedAt` (bounded by WINDGRAM_GOES_BACKFILL_HOURS, default 6)
are fetched whole, sampled, merged into each site's rolling window, and
republished. NOAA's own bucket is the permanent archive; this dataset
keeps a ~72 h window and writes no history archives.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
import time
import xml.etree.ElementTree as ElementTree
from datetime import datetime, timedelta, timezone
from pathlib import Path

import netCDF4
import requests

from ..config import output_directory
from ..dataset import fetch_published, published_manifest
from ..noaa import DownloadStats
from ..publish import manifest_stats, round_document, write_json
from ..sites import load_sites

SLUG = "goes18-dsr"
SCHEMA_VERSION = 1
BUCKET = "https://noaa-goes18.s3.amazonaws.com"
PREFIX = "ABI-L2-DSRF"
WINDOW_HOURS = 72
DEFAULT_BACKFILL_HOURS = 6
REQUEST_TIMEOUT_S = 120
# A site farther than one grid step from its nearest fixed-grid point is
# outside the disk (or the projection math broke) — refuse, don't clamp.
MAX_INDEX_OFFSET_RAD = 5.6e-05 * 1.5

_S3_NS = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
_KEY_STAMP = re.compile(r"_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})\d_")


def _out_dir() -> Path:
    return output_directory(SLUG)


def main() -> None:
    sites = load_sites()
    now = datetime.now(timezone.utc)
    backfill_hours = float(os.environ.get("WINDGRAM_GOES_BACKFILL_HOURS", DEFAULT_BACKFILL_HOURS))
    manifest = published_manifest(SLUG)
    last_observed = (
        _instant_to_datetime(manifest["lastObservedAt"])
        if manifest is not None
        else now - timedelta(hours=backfill_hours)
    )
    # A stale dataset never triggers an unbounded catch-up fetch.
    last_observed = max(last_observed, now - timedelta(hours=backfill_hours))

    stats = DownloadStats()
    keys = _scan_keys_since(last_observed, now, stats)
    if not keys:
        print(f"No GOES-18 DSR granules newer than {_datetime_to_instant(last_observed)}.")
        return

    print(f"Sampling {len(keys)} GOES-18 DSR granules for {len(sites)} sites…")
    started_at = time.monotonic()
    new_observations: dict[str, list[dict]] = {site["slug"]: [] for site in sites}
    indices: dict[str, tuple[int, int]] | None = None
    for key, observed_at in keys:
        payload = _fetch(f"{BUCKET}/{key}", stats)
        with _granule(payload) as granule:
            if indices is None:
                indices = {site["slug"]: _site_index(granule, site) for site in sites}
            dsr = granule["DSR"]
            dqf = granule["DQF"]
            for site in sites:
                y_index, x_index = indices[site["slug"]]
                value = dsr[y_index, x_index]
                quality = int(dqf[y_index, x_index])
                # Masked means _FillValue — no retrieval (night, gaps).
                # DQF 0 alone proves nothing (fill pixels carry DQF 0).
                if value is None or getattr(value, "mask", False) or quality != 0:
                    continue
                new_observations[site["slug"]].append(
                    {"observedAt": observed_at, "downwardShortwaveWm2": float(value)}
                )

    total_new = sum(len(entries) for entries in new_observations.values())
    if total_new == 0:
        print(f"No valid daytime retrievals in {len(keys)} granules (night or flagged).")
        return

    generated_at = _datetime_to_instant(datetime.now(timezone.utc))
    sites_dir = _out_dir() / "sites"
    sites_dir.mkdir(parents=True, exist_ok=True)
    first_observed_at = None
    last_observed_at = None
    observation_count = 0
    for site in sites:
        observations = _merged_window(site["slug"], new_observations[site["slug"]])
        if not observations:
            continue
        document = {
            "schemaVersion": SCHEMA_VERSION,
            "model": SLUG,
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
        write_json(sites_dir / f"{site['slug']}.json", round_document(document), compact=True)
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
        "model": SLUG,
        "observationCount": observation_count,
        "referenceTime": last_observed_at,
        "schemaVersion": SCHEMA_VERSION,
        "sites": [{"name": site["name"], "slug": site["slug"]} for site in sites],
        "stats": manifest_stats(stats, started_at),
    }
    write_json(_out_dir() / "manifest.json", manifest_document, compact=False)
    print(
        f"Published {total_new} new GOES-18 DSR observations "
        f"(window now {first_observed_at} … {last_observed_at}, "
        f"{stats.requests} requests, {stats.response_bytes // (1024 * 1024)} MiB)."
    )


def _scan_keys_since(
    last_observed: datetime, now: datetime, stats: DownloadStats
) -> list[tuple[str, str]]:
    """Granule keys with a scan start strictly after last_observed,
    chronological, discovered hour prefix by hour prefix."""
    keys: list[tuple[str, str]] = []
    cursor = last_observed.replace(minute=0, second=0, microsecond=0)
    while cursor <= now:
        prefix = f"{PREFIX}/{cursor.year}/{cursor.timetuple().tm_yday:03d}/{cursor.hour:02d}/"
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


def _granule(payload: bytes) -> netCDF4.Dataset:
    return netCDF4.Dataset("granule", mode="r", memory=payload)


def _site_index(granule: netCDF4.Dataset, site: dict) -> tuple[int, int]:
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


def _merged_window(site_slug: str, new_entries: list[dict]) -> list[dict]:
    """The published window plus the new samples, deduplicated by instant,
    chronological, trimmed to WINDOW_HOURS behind the newest."""
    merged: dict[str, dict] = {}
    payload = fetch_published(f"{SLUG}/sites/{site_slug}.json")
    if payload is not None:
        published = json.loads(payload)
        for entry in published.get("observations", []):
            merged[entry["observedAt"]] = entry
    for entry in new_entries:
        merged[entry["observedAt"]] = entry
    if not merged:
        return []
    observations = sorted(merged.values(), key=lambda entry: entry["observedAt"])
    horizon = _instant_to_datetime(observations[-1]["observedAt"]) - timedelta(hours=WINDOW_HOURS)
    return [
        entry
        for entry in observations
        if _instant_to_datetime(entry["observedAt"]) >= horizon
    ]


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
        main()
    except Exception as error:  # noqa: BLE001 — the workflow wants the message, not a trace
        print(error, file=sys.stderr)
        sys.exit(1)

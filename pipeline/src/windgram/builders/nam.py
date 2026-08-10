"""Builds windgram profiles from NOAA's NAM: the 12 km parent and its 3 km
CONUS nest. Both retire 2026-10-06 in favour of RRFS; models.json carries
the machine-readable sunset.

Both products publish whole-domain GRIB2 files with .idx sidecars on the
noaa-nam-pds S3 bucket, four cycles a day (00/06/12/18Z). The nest
(conusnest.hiresf) runs hourly to 60 h on HRRR's exact Lambert grid; the
parent (awphys, AWIPS grid 218) runs hourly to 36 h then 3-hourly to 84 h.
awphys carries every contract field except layered cloud, which at 12 km
exists only in the awip12 companion file (identical grid), so the parent
build byte-ranges three LCDC/MCDC/HCDC records per hour from awip12
alongside awphys. Verified live 2026-08-08: GUST is instantaneous, the
un-suffixed SHTFL/LHTFL records are instantaneous (the nest's "ave" twins
are skipped by exact forecast-token matching), VVEL (omega, Pa/s) exists at
all nine curated levels, level moisture is RH (level dew point is absent or
partial), and terrain HGT:surface is present every hour.

NAM winds are grid-relative on each product's own Lambert conformal
projection — the nest shares HRRR's parameters (Latin1 38.5°, LoV 262.5°)
while awphys uses Latin1 25°, LoV 265° — so the rotation to true north is a
per-product constant. NCEP packs each UGRD/VGRD pair as two submessages of
one GRIB message (idx lines N.1/N.2 at a shared offset): one ranged fetch
yields both components.

Precipitation is bucketed, and the parent's bucket length depends on the
cycle: nest buckets reset every 3 h on every cycle, parent buckets every
12 h on the 00/12Z cycles but every 3 h on 06/18Z (verified live
2026-08-08 across all four cycles and prior days). The hourly step is the
difference of consecutive bucket records (the record itself in the hour
right after a reset), and the parent's 3-hourly tail publishes a direct
(h−3)–h record, divided by 3 for mm/h. At 00/12Z bucket boundaries two
APCP records coexist in a parent file ("12-24" beside "21-24" at f24), so
records are selected by their exact idx window token, never by variable
name alone.

Nest fields carry a sparse bitmap (~100 of 1.9M points); sampling publishes
a masked gridpoint as absence, never a value (noaa.sample_sites). Set
WINDGRAM_MAX_STEPS to cap the forecast steps fetched (used by smoke tests).
"""

from __future__ import annotations

import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from ..config import output_directory
from ..dataset import published_reference_time
from ..derive import SCHEMA_VERSION, derive_windgram_profile
from ..moisture import dew_point_depression
from ..noaa import (
    DownloadStats,
    IdxRecord,
    MissingRecordError,
    exists,
    fetch_index,
    fetch_record,
    find_record,
    sample_sites,
    sample_sites_uv,
    wind_from_uv,
)
from ..publish import append_history, manifest_stats, round_document, write_json
from ..sites import load_sites

BASE_URL = "https://noaa-nam-pds.s3.amazonaws.com"
RUN_HOURS = ("18", "12", "06", "00")
# NOAA Open Data (NODD) S3 buckets document no per-client connection
# ceiling: access is anonymous S3, whose own design guidance is thousands
# of GETs per second per prefix. The cap is therefore self-imposed
# politeness, not a provider limit — 10 concurrent ranged GETs keeps one
# CI runner negligible against the bucket while cutting wall time versus
# the old 6. Each bucket is its own host and the workflow gives all NOAA
# builders one job running them sequentially, so no NOAA host ever sees
# more than FETCH_CONCURRENCY connections from this pipeline.
FETCH_CONCURRENCY = 10

KELVIN = 273.15
# field → (GRIB variable, level). All instantaneous; precipitation is a
# bucketed accumulation handled by its own task, and 2 m temperature/
# dewpoint and the winds need pairs of records. pressurePa is PRMSL —
# the contract field is MSL pressure, and NAM publishes PRMSL directly
# (PRES:surface sits beside it but is station pressure, not the contract
# field; HRRR falls back to MSLMA only because it has no PRMSL). NAM's
# TCDC idx level token is the long form, unlike HRRR/GFS.
SURFACE_FIELDS = {
    "cloudCoverPercent": ("TCDC", "entire atmosphere (considered as a single layer)"),
    "latentHeatFluxWm2": ("LHTFL", "surface"),
    "pressurePa": ("PRMSL", "mean sea level"),
    "sensibleHeatFluxWm2": ("SHTFL", "surface"),
}
# Science fields, tolerated when a record goes missing. NAM's GUST is the
# instantaneous diagnostic gust (models.json declares gust: "instant" — no
# hour-max exists on NOAA feeds). CAPE/CIN are the surface-based variant
# and HPBL is metres AGL.
OPTIONAL_SURFACE_FIELDS = {
    "windGustMs": ("GUST", "surface"),
    "capeJkg": ("CAPE", "surface"),
    "cinJkg": ("CIN", "surface"),
    "pblHeightM": ("HPBL", "surface"),
}
# NCEP's terrain-following sigma-layer cloud fractions: in the nest's own
# file, but at 12 km only in the awip12 companion.
CLOUD_LAYER_FIELDS = {
    "lowCloudPercent": ("LCDC", "low cloud layer"),
    "midCloudPercent": ("MCDC", "middle cloud layer"),
    "highCloudPercent": ("HCDC", "high cloud layer"),
}
PRESSURE_LEVELS = (925, 900, 875, 850, 800, 750, 700, 650, 600)
# Both products carry VVEL (omega, Pa/s, instantaneous) at every curated
# level; models.json declares verticalVelocity: "omega" with these levels.
# The field is additive — a missing record leaves the level published
# without it, never incomplete.
OMEGA_LEVELS = PRESSURE_LEVELS

# The document's transport-semantics declaration (contract "semantics"),
# shared by both products: GUST is NOAA's instantaneous diagnostic gust at
# the valid time; precipitation is bucketed APCP, differenced per step and
# divided by the window into the mean mm/h rate.
SEMANTICS = {"gust": "instant", "precipitation": "windowMeanRate"}


@dataclass(frozen=True)
class NamProduct:
    slug: str  # catalogue slug == data/ directory name == argv token
    label: str  # log prose
    file_token: str  # the product token in nam.tHHz.<token>NN.tm00.grib2
    forecast_hours: tuple[int, ...]
    hourly_through: int  # last hour of the hourly cadence; 3-hourly beyond
    bucket_reset_hours: int  # APCP bucket length on the 00/12Z cycles
    off_cycle_bucket_reset_hours: int  # APCP bucket length on 06/18Z
    lambert_orientation_deg: float  # LoV
    lambert_cone: float  # sin(Latin1); one standard parallel on both grids
    max_nearest_km: float
    cloud_file_token: str | None  # layered cloud companion file, if separate


PRODUCTS = {
    "nam-conus-nest": NamProduct(
        slug="nam-conus-nest",
        label="NAM CONUS nest",
        file_token="conusnest.hiresf",
        forecast_hours=tuple(range(1, 61)),
        hourly_through=60,
        bucket_reset_hours=3,
        off_cycle_bucket_reset_hours=3,
        lambert_orientation_deg=262.5,
        lambert_cone=math.sin(math.radians(38.5)),
        # On the 3 km grid the nearest gridpoint is within ~2 km; anything
        # farther means ecCodes clamped an out-of-domain site to the grid
        # boundary.
        max_nearest_km=5.0,
        cloud_file_token=None,
    ),
    "nam": NamProduct(
        slug="nam",
        label="NAM 12 km",
        file_token="awphys",
        forecast_hours=tuple(range(1, 37)) + tuple(range(39, 85, 3)),
        hourly_through=36,
        bucket_reset_hours=12,
        off_cycle_bucket_reset_hours=3,
        lambert_orientation_deg=265.0,
        lambert_cone=math.sin(math.radians(25.0)),
        # On the 12.19 km grid the nearest gridpoint is within ~9 km.
        max_nearest_km=15.0,
        cloud_file_token="awip12",
    ),
}


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in PRODUCTS:
        raise SystemExit(f"usage: python -m windgram.builders.nam {{{' | '.join(PRODUCTS)}}}")
    build(PRODUCTS[sys.argv[1]])


def build(product: NamProduct) -> None:
    sites = load_sites()
    out_dir = output_directory(product.slug)
    run = _latest_complete_run(product)
    if run is None:
        print(f"No complete {product.label} run is available.")
        return
    date = run["date"]
    reference_time = f"{date[:4]}-{date[4:6]}-{date[6:]}T{run['hour']}:00:00Z"
    if published_reference_time(product.slug) == reference_time:
        print(f"{product.label} run {reference_time} is already published.")
        return

    print(f"Building {product.label} {reference_time} for {len(sites)} sites…")
    started_at = time.monotonic()
    stats = DownloadStats()
    result = _build_profiles(product, run, reference_time, sites, stats)

    sites_dir = out_dir / "sites"
    sites_dir.mkdir(parents=True, exist_ok=True)
    for profile in result["profiles"]:
        document = round_document(profile)
        write_json(sites_dir / f"{document['site']['id']}.json", document, compact=True)
        append_history(document, out_dir / "history")
    manifest = {
        "firstForecastHour": result["firstForecastHour"],
        "forecastHours": result["forecastHours"],
        "generatedAt": _instant(),
        "lastForecastHour": result["lastForecastHour"],
        "model": product.slug,
        "referenceTime": reference_time,
        "schemaVersion": SCHEMA_VERSION,
        "sites": [{"name": site["name"], "slug": site["slug"]} for site in sites],
        "stats": manifest_stats(stats, started_at),
    }
    write_json(out_dir / "manifest.json", manifest, compact=False)
    print(
        f"Published {len(result['profiles'])} {product.label} profiles for {reference_time} "
        f"({stats.requests} requests, {stats.response_bytes // (1024 * 1024)} MiB)."
    )


def _completion_urls(product: NamProduct, date: str, run_hour: str) -> list[str]:
    """A cycle is complete when its final forecast hour's indexes are on S3;
    the 12 km build also needs the awip12 companion through the horizon."""
    last = product.forecast_hours[-1]
    urls = [_file_url(product.file_token, date, run_hour, last) + ".idx"]
    if product.cloud_file_token:
        urls.append(_file_url(product.cloud_file_token, date, run_hour, last) + ".idx")
    return urls


def _latest_complete_run(product: NamProduct) -> dict | None:
    now = datetime.now(timezone.utc)
    for day_offset in (0, 1):
        date = (now - timedelta(days=day_offset)).strftime("%Y%m%d")
        for hour in RUN_HOURS:
            if day_offset == 0 and int(hour) > now.hour:
                continue
            if all(exists(url) for url in _completion_urls(product, date, hour)):
                return {"date": date, "hour": hour}
    return None


def _file_url(file_token: str, date: str, run_hour: str, forecast_hour: int) -> str:
    return f"{BASE_URL}/nam.{date}/nam.t{run_hour}z.{file_token}{forecast_hour:02d}.tm00.grib2"


def _build_profiles(
    product: NamProduct, run: dict, reference_time: str, sites: list[dict], stats: DownloadStats
):
    forecast_slots = [
        {"forecastHour": hour, "validAt": _valid_time(reference_time, hour)}
        for hour in product.forecast_hours
    ]
    forecast_slots = forecast_slots[: _max_steps()]
    first_forecast_hour = forecast_slots[0]["forecastHour"]

    records_by_hour: dict[int, list[IdxRecord]] = {}
    cloud_records_by_hour: dict[int, list[IdxRecord]] = {}

    def index_task(forecast_hour: int, file_token: str, store: dict[int, list[IdxRecord]]):
        def run_task() -> None:
            url = _file_url(file_token, run["date"], run["hour"], forecast_hour) + ".idx"
            store[forecast_hour] = fetch_index(url, stats)

        return run_task

    index_tasks = [
        index_task(slot["forecastHour"], product.file_token, records_by_hour)
        for slot in forecast_slots
    ]
    if product.cloud_file_token:
        index_tasks += [
            index_task(slot["forecastHour"], product.cloud_file_token, cloud_records_by_hour)
            for slot in forecast_slots
        ]
    _run_concurrent(index_tasks)

    def record_values(forecast_hour: int, variable: str, level: str, forecast: str | None = None):
        record = find_record(
            records_by_hour[forecast_hour],
            variable,
            level,
            forecast or f"{forecast_hour} hour fcst",
        )
        data = fetch_record(
            _file_url(product.file_token, run["date"], run["hour"], forecast_hour), record, stats
        )
        return sample_sites(data, sites, product.max_nearest_km)

    def wind_values(forecast_hour: int, level: str) -> dict[str, tuple[float, float] | None]:
        """Speed and true-north FROM direction per site, or None when the
        gridpoint is missing from either component."""
        forecast = f"{forecast_hour} hour fcst"
        records = records_by_hour[forecast_hour]
        u_record = find_record(records, "UGRD", level, forecast)
        v_record = find_record(records, "VGRD", level, forecast)
        url = _file_url(product.file_token, run["date"], run["hour"], forecast_hour)
        if u_record.offset == v_record.offset:
            # The pair is one two-submessage GRIB message: the idx lists both
            # components at the message offset, so one of the parsed records
            # spans zero bytes and the other spans the whole message. Fetch
            # the span once and decode both fields from it.
            data = fetch_record(url, _pair_span(u_record, v_record), stats)
            u, v = sample_sites_uv(data, sites, product.max_nearest_km)
        else:  # separately packed (not observed on NAM, but cheap to honour)
            u = sample_sites(fetch_record(url, u_record, stats), sites, product.max_nearest_km)
            v = sample_sites(fetch_record(url, v_record, stats), sites, product.max_nearest_km)
        winds: dict[str, tuple[float, float] | None] = {}
        for site in sites:
            slug = site["slug"]
            if u[slug].value is None or v[slug].value is None:
                winds[slug] = None
                continue
            u_earth, v_earth = _earth_wind(
                u[slug].value,
                v[slug].value,
                u[slug].longitude,
                product.lambert_orientation_deg,
                product.lambert_cone,
            )
            winds[slug] = wind_from_uv(u_earth, v_earth)
        return winds

    terrain = record_values(first_forecast_hour, "HGT", "surface")
    model_elevation_by_site = {
        site["slug"]: _required_value(terrain[site["slug"]].value, "model elevation", site)
        for site in sites
    }

    hours_by_site: dict[str, list[dict]] = {
        site["slug"]: [_empty_hour(slot["validAt"]) for slot in forecast_slots] for site in sites
    }

    def surface_task(hour_index: int, field_name: str, variable: str, level: str):
        def run_task() -> None:
            values = record_values(forecast_slots[hour_index]["forecastHour"], variable, level)
            for site in sites:
                hour = hours_by_site[site["slug"]][hour_index]
                hour[field_name] = _required_value(values[site["slug"]].value, field_name, site)

        return run_task

    def temperature_task(hour_index: int):
        def run_task() -> None:
            forecast_hour = forecast_slots[hour_index]["forecastHour"]
            temperature = record_values(forecast_hour, "TMP", "2 m above ground")
            dew_point = record_values(forecast_hour, "DPT", "2 m above ground")
            for site in sites:
                slug = site["slug"]
                t = _required_value(temperature[slug].value, "temperatureC", site)
                d = _required_value(dew_point[slug].value, "dewPointDepressionC", site)
                hour = hours_by_site[slug][hour_index]
                hour["temperatureC"] = t - KELVIN
                hour["dewPointDepressionC"] = t - d

        return run_task

    def surface_wind_task(hour_index: int):
        def run_task() -> None:
            winds = wind_values(forecast_slots[hour_index]["forecastHour"], "10 m above ground")
            for site in sites:
                slug = site["slug"]
                if winds[slug] is None:
                    raise RuntimeError(f"NOAA returned no 10 m wind for {site['name']}")
                hour = hours_by_site[slug][hour_index]
                hour["windSpeedMs"], hour["windDirectionDeg"] = winds[slug]

        return run_task

    def precipitation_task(hour_index: int):
        def run_task() -> None:
            forecast_hour = forecast_slots[hour_index]["forecastHour"]
            fetches, window_hours = _precip_fetches(product, run["hour"], forecast_hour)
            samples = [
                record_values(file_hour, "APCP", "surface", forecast)
                for file_hour, forecast in fetches
            ]
            for site in sites:
                slug = site["slug"]
                millimetres = _required_value(samples[0][slug].value, "precipitationMm", site)
                if len(samples) == 2:
                    millimetres -= _required_value(
                        samples[1][slug].value, "precipitationMm", site
                    )
                hour = hours_by_site[slug][hour_index]
                # mm over the window on the published schedule is mm/h once
                # divided by the window (1 h steps divide by 1).
                hour["precipitationMm"] = millimetres / window_hours

        return run_task

    def optional_surface_task(
        hour_index: int,
        field_name: str,
        variable: str,
        level: str,
        records: dict[int, list[IdxRecord]],
        file_token: str,
    ):
        def run_task() -> None:
            forecast_hour = forecast_slots[hour_index]["forecastHour"]
            try:
                record = find_record(
                    records[forecast_hour], variable, level, f"{forecast_hour} hour fcst"
                )
            except MissingRecordError:
                return  # optional field: absence stays out of the document
            data = fetch_record(
                _file_url(file_token, run["date"], run["hour"], forecast_hour), record, stats
            )
            values = sample_sites(data, sites, product.max_nearest_km)
            for site in sites:
                value = values[site["slug"]].value
                if value is not None:
                    hours_by_site[site["slug"]][hour_index][field_name] = value

        return run_task

    def pressure_task(hour_index: int, pressure_hpa: int):
        def run_task() -> None:
            forecast_hour = forecast_slots[hour_index]["forecastHour"]
            level = f"{pressure_hpa} mb"
            temperature = record_values(forecast_hour, "TMP", level)
            humidity = record_values(forecast_hour, "RH", level)
            height = record_values(forecast_hour, "HGT", level)
            winds = wind_values(forecast_hour, level)
            try:
                omega = record_values(forecast_hour, "VVEL", level)
            except MissingRecordError:
                omega = None
            for site in sites:
                slug = site["slug"]
                t = temperature[slug].value
                rh = humidity[slug].value
                h = height[slug].value
                wind = winds[slug]
                if t is None or rh is None or h is None or wind is None:
                    continue
                entry = {
                    "pressureHpa": pressure_hpa,
                    "heightM": h,
                    "temperatureC": t - KELVIN,
                    "dewPointDepressionC": dew_point_depression(t - KELVIN, rh),
                    "windDirectionDeg": wind[1],
                    "windSpeedMs": wind[0],
                }
                if omega is not None and omega[slug].value is not None:
                    entry["verticalVelocityPaS"] = omega[slug].value
                hours_by_site[slug][hour_index]["levels"][pressure_hpa] = entry

        return run_task

    cloud_records = cloud_records_by_hour if product.cloud_file_token else records_by_hour
    cloud_file_token = product.cloud_file_token or product.file_token

    def tasks_for_hour(hour_index: int) -> list:
        tasks = [
            temperature_task(hour_index),
            surface_wind_task(hour_index),
            precipitation_task(hour_index),
        ]
        tasks += [
            surface_task(hour_index, field_name, variable, level)
            for field_name, (variable, level) in SURFACE_FIELDS.items()
        ]
        tasks += [
            optional_surface_task(
                hour_index, field_name, variable, level, records_by_hour, product.file_token
            )
            for field_name, (variable, level) in OPTIONAL_SURFACE_FIELDS.items()
        ]
        tasks += [
            optional_surface_task(
                hour_index, field_name, variable, level, cloud_records, cloud_file_token
            )
            for field_name, (variable, level) in CLOUD_LAYER_FIELDS.items()
        ]
        tasks += [pressure_task(hour_index, level) for level in PRESSURE_LEVELS]
        return tasks

    _run_concurrent(
        [task for index in range(len(forecast_slots)) for task in tasks_for_hour(index)]
    )

    generated_at = _profile_instant()
    profiles = []
    for site in sites:
        source_hours = []
        for hour in hours_by_site[site["slug"]]:
            levels = sorted(
                (level for level in hour["levels"].values() if _is_complete_level(level)),
                key=lambda level: level["heightM"],
            )
            if len(levels) < 3:
                raise RuntimeError(f"NOAA returned too few pressure levels for {site['name']}")
            source_hours.append({**hour, "levels": levels})
        profiles.append(
            derive_windgram_profile(
                {
                    "generatedAt": generated_at,
                    "hours": source_hours,
                    "latitude": site["latitude"],
                    "longitude": site["longitude"],
                    "modelElevationM": model_elevation_by_site[site["slug"]],
                    "referenceTime": reference_time,
                    "siteAltitudeM": site["elevationM"],
                    "siteId": site["slug"],
                    "siteName": site["name"],
                    "siteTimeZone": site.get("timeZone"),
                    "siteWhat3words": site.get("what3words"),
                },
                model=product.slug,
                semantics=SEMANTICS,
            )
        )
    return {
        "firstForecastHour": first_forecast_hour,
        "forecastHours": len(forecast_slots),
        "lastForecastHour": forecast_slots[-1]["forecastHour"],
        "profiles": profiles,
    }


def _precip_fetches(
    product: NamProduct, run_hour: str, forecast_hour: int
) -> tuple[list[tuple[int, str]], int]:
    """The (file hour, idx forecast token) fetches recovering the step's
    precipitation, and the window hours dividing mm to mm/h.

    One fetch: the record itself is the step (the hour right after a bucket
    reset, or the tail's direct 3 h record). Two fetches: the running bucket
    at forecast_hour minus the same bucket one hour earlier. The bucket
    length depends on the cycle — the parent resets every 12 h on 00/12Z
    runs but every 3 h on 06/18Z. Selecting on the exact window token
    matters — at 00/12Z bucket boundaries two APCP records coexist in a
    parent file ("12-24" beside "21-24" at f24).
    """
    if forecast_hour > product.hourly_through:
        return [(forecast_hour, f"{forecast_hour - 3}-{forecast_hour} hour acc fcst")], 3
    if run_hour in ("00", "12"):
        reset = product.bucket_reset_hours
    else:
        reset = product.off_cycle_bucket_reset_hours
    start = (forecast_hour - 1) // reset * reset
    current = (forecast_hour, f"{start}-{forecast_hour} hour acc fcst")
    if forecast_hour - start == 1:
        return [current], 1
    return [current, (forecast_hour - 1, f"{start}-{forecast_hour - 1} hour acc fcst")], 1


def _pair_span(u_record: IdxRecord, v_record: IdxRecord) -> IdxRecord:
    """The record spanning a whole two-submessage wind message: of the two
    idx lines at the shared offset, parse_idx gives the first a zero length
    and the second the full message span (or None at end of file)."""
    if u_record.length is None or v_record.length is None:
        return u_record if u_record.length is None else v_record
    return u_record if u_record.length > v_record.length else v_record


def _grid_rotation_deg(longitude: float, orientation_deg: float, cone: float) -> float:
    """The angle from grid north to true north at a gridpoint's longitude.

    On a Lambert conformal grid the y-axis parallels the orientation
    meridian everywhere, so true north diverges from grid north by the cone
    constant times the longitude difference. Skipping this biases wind
    directions by ~12° (nest) or ~10° (parent) over the catalogued sites.
    """
    delta = (longitude - orientation_deg + 180) % 360 - 180
    return cone * delta


def _earth_wind(
    u_grid: float, v_grid: float, longitude: float, orientation_deg: float, cone: float
) -> tuple[float, float]:
    angle = math.radians(_grid_rotation_deg(longitude, orientation_deg, cone))
    u_earth = u_grid * math.cos(angle) + v_grid * math.sin(angle)
    v_earth = -u_grid * math.sin(angle) + v_grid * math.cos(angle)
    return u_earth, v_earth


def _empty_hour(valid_at: str) -> dict:
    return {
        "cloudCoverPercent": math.nan,
        "dewPointDepressionC": math.nan,
        "latentHeatFluxWm2": math.nan,
        "levels": {},
        "precipitationMm": math.nan,
        "pressurePa": math.nan,
        "sensibleHeatFluxWm2": math.nan,
        "temperatureC": math.nan,
        "validAt": valid_at,
        "windDirectionDeg": math.nan,
        "windSpeedMs": math.nan,
    }


_LEVEL_FIELDS = (
    "pressureHpa",
    "heightM",
    "temperatureC",
    "dewPointDepressionC",
    "windDirectionDeg",
    "windSpeedMs",
)


def _is_complete_level(level: dict) -> bool:
    return all(field in level for field in _LEVEL_FIELDS)


def _required_value(value: float | None, field_name: str, site: dict) -> float:
    if value is None or not math.isfinite(value):
        raise RuntimeError(f"NOAA returned no {field_name} for {site['name']}")
    return value


def _max_steps() -> int | None:
    raw = os.environ.get("WINDGRAM_MAX_STEPS")
    return int(raw) if raw else None


def _valid_time(reference_time: str, forecast_hour: int) -> str:
    instant = datetime.fromisoformat(reference_time.replace("Z", "+00:00")) + timedelta(
        hours=forecast_hour
    )
    return instant.strftime("%Y-%m-%dT%H:%M:%SZ")


def _instant() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _profile_instant() -> str:
    """run.generatedAt publishes whole seconds."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _run_concurrent(tasks: list) -> None:
    with ThreadPoolExecutor(max_workers=FETCH_CONCURRENCY) as executor:
        futures = [executor.submit(task) for task in tasks]
        try:
            for future in futures:
                future.result()
        except BaseException:
            executor.shutdown(cancel_futures=True)
            raise


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 — the workflow wants the message, not a trace
        print(error, file=sys.stderr)
        sys.exit(1)

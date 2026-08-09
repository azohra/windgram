"""Builds windgram profiles from NOAA's GFS global 0.25° model.

GFS publishes whole-globe GRIB2 files with .idx sidecars on a public S3
bucket, four cycles a day out to 384 h; a cycle whose f384 index exists is
complete (the full run lands roughly 5.5 h after cycle time). The build
walks every 3-hourly step to the horizon.

GFS quirks the other builds don't have: dewpoint exists only at 2 m, so
pressure-level dewpoint depression is derived from temperature and relative
humidity via the inverse Magnus formula; the 875 mb level does not exist in
pgrb2.0p25 and is simply omitted; and the surface heat fluxes and
precipitation publish only as growing-window averages/accumulations that
reset every 6 h, so steps on a 6-hour boundary difference a companion record
from the previous 3-hourly file to recover the 3-hour quantity. GFS grids
are regular lat-lon, so winds are earth-relative and need no rotation.

Set WINDGRAM_MAX_STEPS to cap the forecast steps fetched (used by smoke
tests).
"""

from __future__ import annotations

import json
import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ..config import output_directory
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
    wind_from_uv,
)
from ..publish import append_history, manifest_stats, round_document, write_json
from ..sites import load_sites

SLUG = "gfs"
BASE_URL = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
RUN_HOURS = ("18", "12", "06", "00")
STEP_HOURS = 3
LAST_FORECAST_HOUR = 384
# NOAA Open Data (NODD) S3 buckets document no per-client connection
# ceiling: access is anonymous S3, whose own design guidance is thousands
# of GETs per second per prefix. The cap is therefore self-imposed
# politeness, not a provider limit — 10 concurrent ranged GETs keeps one
# CI runner negligible against the bucket while cutting wall time versus
# the old 6. Each bucket is its own host and the workflow gives all NOAA
# builders one job running them sequentially, so no NOAA host ever sees
# more than FETCH_CONCURRENCY connections from this pipeline.
FETCH_CONCURRENCY = 10
# On the 0.25° grid the nearest gridpoint is within ~20 km; anything farther
# means ecCodes clamped an out-of-domain site to the grid boundary.
MAX_NEAREST_KM = 30.0

KELVIN = 273.15
# field → (GRIB variable, level). All instantaneous; the fluxes and
# precipitation are windowed products handled by their own tasks, and 2 m
# temperature/dewpoint and the winds need pairs of records.
SURFACE_FIELDS = {
    "cloudCoverPercent": ("TCDC", "entire atmosphere"),
    "pressurePa": ("PRMSL", "mean sea level"),
}
# Science fields, tolerated when a record goes missing. GUST is the
# instantaneous diagnostic gust (models.json declares gust: "instant" —
# no hour-max exists on NOAA feeds). CAPE/CIN are the surface-based
# variant, HPBL is metres AGL, and the L/M/H cloud layers use the
# INSTANTANEOUS records ("N hour fcst"), never the 6-h-bucket averages
# ("M-N hour ave fcst") that sit beside them in the index — the averages
# reset at synoptic hours and match no other field's valid-time semantics.
OPTIONAL_SURFACE_FIELDS = {
    "windGustMs": ("GUST", "surface"),
    "capeJkg": ("CAPE", "surface"),
    "cinJkg": ("CIN", "surface"),
    "pblHeightM": ("HPBL", "surface"),
    "lowCloudPercent": ("LCDC", "low cloud layer"),
    "midCloudPercent": ("MCDC", "middle cloud layer"),
    "highCloudPercent": ("HCDC", "high cloud layer"),
}
# 875 mb does not exist in pgrb2.0p25; the derivation tolerates a gap.
PRESSURE_LEVELS = (925, 900, 850, 800, 750, 700, 650, 600)
# pgrb2.0p25 carries VVEL (omega, Pa/s, instantaneous) at every curated
# level, out to f384 — no late-horizon thinning; models.json declares
# verticalVelocity: "omega" with these levels. The field is additive — a
# missing record leaves the level published without it, never incomplete.
OMEGA_LEVELS = PRESSURE_LEVELS

# The document's transport-semantics declaration (contract "semantics"):
# GUST is NOAA's instantaneous diagnostic gust at the valid time;
# precipitation is APCP — mm over the 3 h window, divided by the window
# into the mean mm/h rate.
SEMANTICS = {"gust": "instant", "precipitation": "windowMeanRate"}


def _out_dir() -> Path:
    return output_directory(SLUG)


def main() -> None:
    sites = load_sites()
    run = _latest_complete_run()
    if run is None:
        print("No complete GFS run is available.")
        return
    date = run["date"]
    reference_time = f"{date[:4]}-{date[4:6]}-{date[6:]}T{run['hour']}:00:00Z"
    if _published_reference_time() == reference_time:
        print(f"GFS run {reference_time} is already published.")
        return

    print(f"Building GFS {reference_time} for {len(sites)} sites…")
    started_at = time.monotonic()
    stats = DownloadStats()
    result = _build_profiles(run, reference_time, sites, stats)

    sites_dir = _out_dir() / "sites"
    sites_dir.mkdir(parents=True, exist_ok=True)
    for profile in result["profiles"]:
        document = round_document(profile)
        write_json(sites_dir / f"{document['site']['id']}.json", document, compact=True)
        append_history(document, _out_dir() / "history")
    manifest = {
        "firstForecastHour": result["firstForecastHour"],
        "forecastHours": result["forecastHours"],
        "generatedAt": _instant(),
        "lastForecastHour": result["lastForecastHour"],
        "model": SLUG,
        "referenceTime": reference_time,
        "schemaVersion": SCHEMA_VERSION,
        "sites": [{"name": site["name"], "slug": site["slug"]} for site in sites],
        "stats": manifest_stats(stats, started_at),
    }
    write_json(_out_dir() / "manifest.json", manifest, compact=False)
    print(
        f"Published {len(result['profiles'])} GFS profiles for {reference_time} "
        f"({stats.requests} requests, {stats.response_bytes // (1024 * 1024)} MiB)."
    )


def _latest_complete_run() -> dict | None:
    """A cycle is complete when its final forecast step's index is on S3."""
    now = datetime.now(timezone.utc)
    for day_offset in (0, 1):
        date = (now - timedelta(days=day_offset)).strftime("%Y%m%d")
        for hour in RUN_HOURS:
            if day_offset == 0 and int(hour) > now.hour:
                continue
            if exists(_file_url(date, hour, LAST_FORECAST_HOUR) + ".idx"):
                return {"date": date, "hour": hour}
    return None


def _file_url(date: str, run_hour: str, forecast_hour: int) -> str:
    return f"{BASE_URL}/gfs.{date}/{run_hour}/atmos/gfs.t{run_hour}z.pgrb2.0p25.f{forecast_hour:03d}"


def _published_reference_time() -> str | None:
    try:
        return json.loads((_out_dir() / "manifest.json").read_text())["referenceTime"]
    except (OSError, KeyError, ValueError):
        return None


def _build_profiles(run: dict, reference_time: str, sites: list[dict], stats: DownloadStats):
    forecast_slots = [
        {"forecastHour": hour, "validAt": _valid_time(reference_time, hour)}
        for hour in range(STEP_HOURS, LAST_FORECAST_HOUR + 1, STEP_HOURS)
    ]
    forecast_slots = forecast_slots[: _max_steps()]
    first_forecast_hour = forecast_slots[0]["forecastHour"]

    # Steps on a 6-hour window boundary also need the previous 3-hourly file
    # for the flux/precipitation companion records.
    index_hours = sorted(
        {slot["forecastHour"] for slot in forecast_slots}
        | {
            slot["forecastHour"] - STEP_HOURS
            for slot in forecast_slots
            if _window_start(slot["forecastHour"]) != slot["forecastHour"] - STEP_HOURS
        }
    )
    records_by_hour: dict[int, list[IdxRecord]] = {}

    def index_task(forecast_hour: int):
        def run_task() -> None:
            url = _file_url(run["date"], run["hour"], forecast_hour) + ".idx"
            records_by_hour[forecast_hour] = fetch_index(url, stats)

        return run_task

    _run_concurrent([index_task(hour) for hour in index_hours])

    def record_values(forecast_hour: int, variable: str, level: str, forecast: str | None = None):
        record = find_record(
            records_by_hour[forecast_hour],
            variable,
            level,
            forecast or f"{forecast_hour} hour fcst",
        )
        data = fetch_record(_file_url(run["date"], run["hour"], forecast_hour), record, stats)
        return sample_sites(data, sites, MAX_NEAREST_KM)

    def windowed_values(variable: str, kind: str, file_hour: int) -> dict[str, float | None]:
        """The growing-window average/accumulation record in f{file_hour},
        covering (window start, file_hour]."""
        forecast = f"{_window_start(file_hour)}-{file_hour} hour {kind} fcst"
        samples = record_values(file_hour, variable, "surface", forecast)
        return {slug: sample.value for slug, sample in samples.items()}

    def three_hour_values(variable: str, kind: str, target_hour: int) -> dict[str, float | None]:
        current = windowed_values(variable, kind, target_hour)
        if _window_start(target_hour) == target_hour - STEP_HOURS:
            return current
        companion = windowed_values(variable, kind, target_hour - STEP_HOURS)
        recover = _deaveraged if kind == "ave" else _differenced
        return {
            slug: (
                None
                if current[slug] is None or companion[slug] is None
                else recover(current[slug], companion[slug])
            )
            for slug in current
        }

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
            forecast_hour = forecast_slots[hour_index]["forecastHour"]
            u = record_values(forecast_hour, "UGRD", "10 m above ground")
            v = record_values(forecast_hour, "VGRD", "10 m above ground")
            for site in sites:
                slug = site["slug"]
                hour = hours_by_site[slug][hour_index]
                hour["windSpeedMs"], hour["windDirectionDeg"] = wind_from_uv(
                    _required_value(u[slug].value, "windSpeedMs", site),
                    _required_value(v[slug].value, "windSpeedMs", site),
                )

        return run_task

    def flux_task(hour_index: int):
        def run_task() -> None:
            forecast_hour = forecast_slots[hour_index]["forecastHour"]
            for field_name, variable in (
                ("latentHeatFluxWm2", "LHTFL"),
                ("sensibleHeatFluxWm2", "SHTFL"),
            ):
                means = three_hour_values(variable, "ave", forecast_hour)
                for site in sites:
                    hour = hours_by_site[site["slug"]][hour_index]
                    hour[field_name] = _required_value(means[site["slug"]], field_name, site)

        return run_task

    def precipitation_task(hour_index: int):
        def run_task() -> None:
            forecast_hour = forecast_slots[hour_index]["forecastHour"]
            accumulations = three_hour_values("APCP", "acc", forecast_hour)
            for site in sites:
                hour = hours_by_site[site["slug"]][hour_index]
                # APCP is mm over the 3 h window; the published field is a rate.
                hour["precipitationMm"] = (
                    _required_value(accumulations[site["slug"]], "precipitationMm", site) / 3.0
                )

        return run_task

    def optional_surface_task(hour_index: int, field_name: str, variable: str, level: str):
        def run_task() -> None:
            forecast_hour = forecast_slots[hour_index]["forecastHour"]
            try:
                values = record_values(forecast_hour, variable, level)
            except MissingRecordError:
                return  # optional field: absence stays out of the document
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
            u = record_values(forecast_hour, "UGRD", level)
            v = record_values(forecast_hour, "VGRD", level)
            # GFS is the only model with a per-level cloud profile: TCDC at
            # every curated isobaric level, instantaneous, published as the
            # optional cloudFractionPercent.
            try:
                cloud = record_values(forecast_hour, "TCDC", level)
            except MissingRecordError:
                cloud = None
            omega = None
            if pressure_hpa in OMEGA_LEVELS:
                try:
                    omega = record_values(forecast_hour, "VVEL", level)
                except MissingRecordError:
                    pass  # optional field: absence stays out of the document
            for site in sites:
                slug = site["slug"]
                t = temperature[slug].value
                rh = humidity[slug].value
                h = height[slug].value
                if None in (t, rh, h, u[slug].value, v[slug].value):
                    continue
                speed, direction = wind_from_uv(u[slug].value, v[slug].value)
                entry = {
                    "pressureHpa": pressure_hpa,
                    "heightM": h,
                    "temperatureC": t - KELVIN,
                    "dewPointDepressionC": dew_point_depression(t - KELVIN, rh),
                    "windDirectionDeg": direction,
                    "windSpeedMs": speed,
                }
                if cloud is not None and cloud[slug].value is not None:
                    entry["cloudFractionPercent"] = cloud[slug].value
                if omega is not None and omega[slug].value is not None:
                    entry["verticalVelocityPaS"] = omega[slug].value
                hours_by_site[slug][hour_index]["levels"][pressure_hpa] = entry

        return run_task

    def tasks_for_hour(hour_index: int) -> list:
        tasks = [
            temperature_task(hour_index),
            surface_wind_task(hour_index),
            flux_task(hour_index),
            precipitation_task(hour_index),
        ]
        tasks += [
            surface_task(hour_index, field_name, variable, level)
            for field_name, (variable, level) in SURFACE_FIELDS.items()
        ]
        tasks += [
            optional_surface_task(hour_index, field_name, variable, level)
            for field_name, (variable, level) in OPTIONAL_SURFACE_FIELDS.items()
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
                },
                model=SLUG,
                semantics=SEMANTICS,
            )
        )
    return {
        "firstForecastHour": first_forecast_hour,
        "forecastHours": len(forecast_slots),
        "lastForecastHour": forecast_slots[-1]["forecastHour"],
        "profiles": profiles,
    }


def _window_start(forecast_hour: int) -> int:
    """GFS averaging/accumulation windows reset every 6 h; the window holding
    forecast_hour starts at the last multiple of 6 strictly below it."""
    return (forecast_hour - STEP_HOURS) // 6 * 6


def _deaveraged(current: float, companion: float) -> float:
    """The mean over the last 3 h of a 6 h growing-window average, given the
    3 h companion average: ((h2−h0)·A(h2) − (h1−h0)·A(h1)) / (h2−h1)."""
    return 2 * current - companion


def _differenced(current: float, companion: float) -> float:
    """The last 3 h of a 6 h growing-window accumulation."""
    return current - companion


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

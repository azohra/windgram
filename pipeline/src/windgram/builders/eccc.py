"""Builds windgram profiles for every catalogued site from the latest run of
an ECCC deterministic model — HRDPS 2.5 km, RDPS 10 km, or GDPS 15 km — and
writes them under the model's output directory. Exits without touching the
output when the latest run is already published, so the workflow only
commits real updates.

Transport is Datamart GRIB2 (dd.weather.gc.ca), not GeoMet WCS: whole-domain
per-field files are downloaded one at a time, the catalogued launch points
sampled at the nearest gridpoint, and the bytes dropped before the next
fetch — nothing is written to disk, and at most FETCH_CONCURRENCY files are
in memory at once. GRIB gives these models what WCS never carried: omega
(vertical velocity, level-sparse), true 2 m dew point, and the full
low-atmosphere column of pressure levels.

All three grids' WDIR/WIND files are earth-relative (verified for HRDPS and
RDPS against rotated UGRD/VGRD; GDPS's regular lat-lon grid encodes
uvRelativeToGrid=0), so wind is consumed directly with no rotation anywhere.
Valid times come from the schedule, never from GRIB time keys — HRDPS
encodes forecastTime in minutes where RDPS/GDPS use hours, a trap this
builder never reads.

The CLI (`windgram build --model <slug>`) is the entry point for all three
models. Set WINDGRAM_MAX_STEPS to cap the forecast steps fetched (used by
smoke tests) and WINDGRAM_DATAMART_BASE to fetch from the hpfx mirror
instead of dd (see windgram.datamart).
"""

from __future__ import annotations

import math
import os
import sys
import threading
import time
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ..config import output_directory
from ..datamart import DownloadStats, NotFoundError, datamart_base, exists, fetch_bytes
from ..dataset import published_reference_time
from ..derive import SCHEMA_VERSION, derive_windgram_profile
from ..grib import GribField
from ..publish import append_history, manifest_stats, round_document, write_json
from ..sentinel import mask_sentinel
from ..sites import load_sites

# Per-host Datamart connection budget. MSC's usage policy (verified
# 2026-08-08) documents no HTTP connection ceiling — its limit is 86,400
# requests/day (~1 req/s averaged) per application, and the 500-connection
# cap applies to AMQP only. A worst-case day (every ECCC model landing a
# fresh run each tick) stays inside that budget, and the request count is
# fixed by the schedules — concurrency only shortens the fetch window. The
# aggregate rule holds by construction: the workflow gives each Datamart
# host (dd, hpfx, dd.alpha) exactly one job, builders inside a job run
# sequentially, so no host ever sees more than FETCH_CONCURRENCY
# connections from this pipeline.
FETCH_CONCURRENCY = 5
KELVIN = 273.15
# GRIB simple packing quantizes the two gust files independently; the
# Max >= instant assertion allows that much noise and nothing more.
_GUST_MAX_SLACK_MS = 0.1

# The curated column all three models publish: the spec's 1015–600 hPa band,
# denser low where boundary layers live. Descending pressure = ascending
# altitude, matching models.json.
PRESSURE_LEVELS = (1015, 1000, 985, 970, 950, 925, 900, 875, 850, 800, 750, 700, 650, 600)

# Source-hour field → Datamart variable prefix. HRDPS keeps the old GRIB
# tokens; RDPS and GDPS use MSC's English CamelCase names.
OLD_STYLE_PRESSURE_PREFIXES = {
    "dewPointDepressionC": "DEPR",
    "heightM": "HGT",
    "temperatureC": "TMP",
    "verticalVelocityPaS": "VVEL",
    "windDirectionDeg": "WDIR",
    "windSpeedMs": "WIND",
}
ENGLISH_PRESSURE_PREFIXES = {
    "dewPointDepressionC": "DewPointDepression",
    "heightM": "GeopotentialHeight",
    "temperatureC": "AirTemp",
    "verticalVelocityPaS": "VerticalVelocity",
    "windDirectionDeg": "WindDir",
    "windSpeedMs": "WindSpeed",
}

# The pressure-level fields every level must provide (omega is optional and
# level-sparse, so it is not here).
PRESSURE_FIELDS = (
    "temperatureC",
    "dewPointDepressionC",
    "heightM",
    "windDirectionDeg",
    "windSpeedMs",
)


def old_style_pressure_variable(field_name: str, pressure_hpa: int) -> str:
    return f"{OLD_STYLE_PRESSURE_PREFIXES[field_name]}_ISBL_{pressure_hpa:04d}"


def english_pressure_variable(field_name: str, pressure_hpa: int) -> str:
    return f"{ENGLISH_PRESSURE_PREFIXES[field_name]}_IsbL-{pressure_hpa:04d}"


def all_levels(forecast_hour: int) -> tuple[int, ...]:
    return PRESSURE_LEVELS


def all_hours(forecast_hour: int) -> bool:
    return True


# Past 168 h GDPS's intermediate 3-hourly steps carry a reduced level set;
# these are the curated levels that survive (500 hPa also exists there but
# sits outside the curated band). Steps on a 6-hour boundary stay complete.
GDPS_INTERMEDIATE_LEVELS = (1000, 925, 850, 700)


def gdps_levels(forecast_hour: int) -> tuple[int, ...]:
    if forecast_hour <= 168 or forecast_hour % 6 == 0:
        return PRESSURE_LEVELS
    return GDPS_INTERMEDIATE_LEVELS


# GDPS CAPE/CIN thin out one regime earlier than the other surface fields:
# 3-hourly to 168 h, then 6-hourly only — absent at the intermediate
# 3-hourly steps past 168 (verified live 2026-08-08: present 003/024/174/240,
# absent 001/171).
def gdps_cape_hours(forecast_hour: int) -> bool:
    return forecast_hour <= 168 or forecast_hour % 6 == 0


@dataclass(frozen=True)
class DatamartModel:
    """Everything model-specific a Datamart build needs: the dated-tree path,
    file-name tokens, variable names, schedules, and the sampling guard. The
    slug is the model's published identity and doubles as its data/ directory
    name."""

    slug: str
    path: str  # tree segment under the date, e.g. "model_hrdps/continental/2.5km"
    file_prefix: str  # "MSC_HRDPS"
    grid_token: str  # "RLatLon0.0225"
    run_hours: tuple[str, ...]  # probed newest-first
    forecast_hours: tuple[int, ...]
    surface_variables: dict[str, str]  # source-hour field → "<Var>_<Level>" token
    temperature_variable: str  # 2 m air temperature
    dew_point_variable: str  # 2 m dew point (true, not a depression)
    pressure_variable: Callable[[str, int], str]
    omega_levels: tuple[int, ...]  # curated levels that carry VVEL
    terrain_variable: str  # model elevation, fetched at PT000
    # A sample farther than this means ecCodes clamped an out-of-domain site
    # to the grid boundary; the cap scales with the grid spacing.
    max_nearest_km: float
    # Fixed-window accumulation over the trailing hour — mm over 1 h is mm/h
    # directly. None for models that difference the run total instead.
    precip_window_variable: str | None = None
    # Run-total accumulation, differenced between scheduled steps and divided
    # by the window hours to publish mm/h.
    precip_run_total_variable: str | None = None
    levels_for_hour: Callable[[int], tuple[int, ...]] = all_levels
    # Hour-max 10 m gust ("gusting to" over the hour ending at the valid
    # time) — what ECCC models publish as windGustMs. The instantaneous
    # companion is fetched purely to assert Max >= instant at the sampled
    # sites: the Max files' GRIB interval metadata is broken
    # (lengthOfTimeRange=0), so the hourly-window semantics rest on
    # empirical field comparisons and every build re-checks them.
    gust_max_variable: str | None = None
    gust_instant_variable: str | None = None
    # Surface-based CAPE/CIN with the family's "not computed" sentinel
    # (9999 for RDPS/GDPS, -1 for the HRDPS family); masked values are
    # omitted from the document. The HRDPS family has no CIN at all.
    cape_variable: str | None = None
    cin_variable: str | None = None
    cape_sentinel: float = 9999.0
    cape_for_hour: Callable[[int], bool] = all_hours
    # Model PBL depth, metres AGL (renderers add model elevation).
    pbl_variable: str | None = None

    @property
    def out_dir(self) -> Path:
        return output_directory(self.slug)


def model_semantics(model: DatamartModel) -> dict[str, str]:
    """The document's transport-semantics declaration (contract "semantics").

    Every gust published here is ECCC's hour-max "gusting to" (gust_task
    re-asserts that invariant each build), and both precipitation transports
    — the 1 h fixed-window accumulation and the differenced run total —
    publish the mean rate over the trailing window, never an instantaneous
    rate.
    """
    semantics = {"precipitation": "windowMeanRate"}
    if model.gust_max_variable:
        semantics = {"gust": "hourMax", **semantics}
    return semantics


HRDPS = DatamartModel(
    slug="hrdps-continental",
    path="model_hrdps/continental/2.5km",
    file_prefix="MSC_HRDPS",
    grid_token="RLatLon0.0225",
    run_hours=("18", "12", "06", "00"),
    forecast_hours=tuple(range(1, 49)),
    surface_variables={
        "cloudCoverPercent": "TCDC_Sfc",
        "latentHeatFluxWm2": "LHTFL_Sfc",
        "pressurePa": "PRMSL_MSL",
        "sensibleHeatFluxWm2": "SHTFL_Sfc",
        "windDirectionDeg": "WDIR_AGL-10m",
        "windSpeedMs": "WIND_AGL-10m",
    },
    temperature_variable="TMP_AGL-2m",
    dew_point_variable="DPT_AGL-2m",
    pressure_variable=old_style_pressure_variable,
    omega_levels=(1000, 850, 700),
    terrain_variable="HGT_Sfc",
    max_nearest_km=5.0,
    precip_window_variable="APCP-Accum1h_Sfc",
    gust_max_variable="GUST-Max_AGL-10m",
    gust_instant_variable="GUST_AGL-10m",
    cape_variable="CAPE_Sfc",
    cape_sentinel=-1.0,
    pbl_variable="HPBL_Sfc",
)

RDPS = DatamartModel(
    slug="rdps",
    path="model_rdps/10km",
    file_prefix="MSC_RDPS",
    grid_token="RLatLon0.09",
    run_hours=("18", "12", "06", "00"),
    forecast_hours=tuple(range(1, 85)),
    surface_variables={
        "cloudCoverPercent": "TotalCloudCover_Sfc",
        "latentHeatFluxWm2": "LatentHeatNetFlux_Sfc",
        "pressurePa": "Pressure_MSL",
        "sensibleHeatFluxWm2": "SensibleHeatNetFlux_Sfc",
        "windDirectionDeg": "WindDir_AGL-10m",
        "windSpeedMs": "WindSpeed_AGL-10m",
    },
    temperature_variable="AirTemp_AGL-2m",
    dew_point_variable="DewPoint_AGL-2m",
    pressure_variable=english_pressure_variable,
    omega_levels=(850, 700),
    terrain_variable="GeopotentialHeight_Sfc",
    max_nearest_km=15.0,
    precip_window_variable="Precip-Accum1h_Sfc",
    gust_max_variable="WindGust-Max_AGL-10m",
    gust_instant_variable="WindGust_AGL-10m",
    cape_variable="CAPE_Sfc",
    cin_variable="CIN_Sfc",
    cape_sentinel=9999.0,
    pbl_variable="PlanetaryBoundaryLayerHeight_Sfc",
)

GDPS = DatamartModel(
    slug="gdps",
    path="model_gdps/15km",
    file_prefix="MSC_GDPS",
    grid_token="LatLon0.15",
    run_hours=("12", "00"),
    # Surface fields are hourly to 168 h, but the column is 3-hourly, so the
    # published schedule is 3-hourly across the whole horizon; past 168 h the
    # intermediate steps just carry fewer levels (gdps_levels).
    forecast_hours=tuple(range(3, 241, 3)),
    surface_variables={
        "cloudCoverPercent": "TotalCloudCover_Sfc",
        "latentHeatFluxWm2": "LatentHeatNetFlux_Sfc",
        "pressurePa": "Pressure_MSL",
        "sensibleHeatFluxWm2": "SensibleHeatNetFlux_Sfc",
        "windDirectionDeg": "WindDir_AGL-10m",
        "windSpeedMs": "WindSpeed_AGL-10m",
    },
    temperature_variable="AirTemp_AGL-2m",
    dew_point_variable="DewPoint_AGL-2m",
    pressure_variable=english_pressure_variable,
    omega_levels=(850, 700, 600),
    terrain_variable="GeopotentialHeight_Sfc",
    max_nearest_km=25.0,
    # No fixed-window accumulation spans 240 h; difference the run total.
    precip_run_total_variable="Precip-Accum_Sfc",
    levels_for_hour=gdps_levels,
    gust_max_variable="WindGust-Max_AGL-10m",
    gust_instant_variable="WindGust_AGL-10m",
    cape_variable="CAPE_Sfc",
    cin_variable="CIN_Sfc",
    cape_sentinel=9999.0,
    cape_for_hour=gdps_cape_hours,
    pbl_variable="PlanetaryBoundaryLayerHeight_Sfc",
)


def _file_url(
    model: DatamartModel, date: str, run_hour: str, forecast_hour: int, variable: str
) -> str:
    name = (
        f"{date}T{run_hour}Z_{model.file_prefix}_{variable}_"
        f"{model.grid_token}_PT{forecast_hour:03d}H.grib2"
    )
    return f"{datamart_base()}/{date}/WXO-DD/{model.path}/{run_hour}/{forecast_hour:03d}/{name}"


def main(model: DatamartModel = HRDPS) -> None:
    sites = load_sites()
    run_id = _latest_complete_run(model)
    if run_id is None:
        print(f"No complete {model.slug} run is available.")
        return
    date = run_id["date"]
    reference_time = f"{date[:4]}-{date[4:6]}-{date[6:]}T{run_id['hour']}:00:00Z"
    if published_reference_time(model.slug) == reference_time:
        print(f"{model.slug} run {reference_time} is already published.")
        return

    print(f"Building {model.slug} {reference_time} for {len(sites)} sites…")
    started_at = time.monotonic()
    stats = DownloadStats()
    result = _build_profiles(model, run_id, reference_time, sites, stats)

    sites_dir = model.out_dir / "sites"
    sites_dir.mkdir(parents=True, exist_ok=True)
    for profile in result["profiles"]:
        document = round_document(profile)
        write_json(sites_dir / f"{document['site']['id']}.json", document, compact=True)
        append_history(document, model.out_dir / "history")
    manifest = {
        "firstForecastHour": result["firstForecastHour"],
        "forecastHours": result["forecastHours"],
        "generatedAt": _instant(),
        "lastForecastHour": result["lastForecastHour"],
        "model": model.slug,
        "referenceTime": reference_time,
        "schemaVersion": SCHEMA_VERSION,
        "sites": [{"name": site["name"], "slug": site["slug"]} for site in sites],
        "stats": manifest_stats(stats, started_at),
    }
    write_json(model.out_dir / "manifest.json", manifest, compact=False)
    print(
        f"Published {len(result['profiles'])} profiles for {reference_time} "
        f"({stats.requests} downloads, {stats.response_bytes // (1024 * 1024)} MiB)."
    )


def _latest_complete_run(model: DatamartModel) -> dict | None:
    """A run is complete when its final forecast hour is on the Datamart
    (files land in forecast-hour order over roughly an hour)."""
    now = datetime.now(timezone.utc)
    last_hour = model.forecast_hours[-1]
    for day_offset in (0, 1):
        date = (now - timedelta(days=day_offset)).strftime("%Y%m%d")
        for hour in model.run_hours:
            if day_offset == 0 and int(hour) > now.hour:
                continue
            probe = _file_url(model, date, hour, last_hour, model.temperature_variable)
            if exists(probe):
                return {"date": date, "hour": hour}
    return None


def _build_profiles(
    model: DatamartModel,
    run_id: dict,
    reference_time: str,
    sites: list[dict],
    stats: DownloadStats,
) -> dict:
    forecast_slots = [
        {"forecastHour": hour, "validAt": _valid_time(reference_time, hour)}
        for hour in model.forecast_hours
    ]
    forecast_slots = forecast_slots[: _max_steps()]

    def sample(variable: str, forecast_hour: int) -> dict[str, float | None]:
        """One whole-domain file: downloaded, sampled at the sites, and
        released before the caller moves on — never stored."""
        url = _file_url(model, run_id["date"], run_id["hour"], forecast_hour, variable)
        with GribField(fetch_bytes(url, stats)) as field:
            return {
                site["slug"]: field.value_at(
                    site["latitude"], site["longitude"], model.max_nearest_km
                )
                for site in sites
            }

    # Terrain publishes at PT000 only for RDPS/GDPS (HRDPS has it hourly, but
    # hour 0 always exists), so the model elevations always come from 000.
    terrain = sample(model.terrain_variable, 0)
    model_elevation_by_site = {
        site["slug"]: _required_value(terrain[site["slug"]], "model elevation", site)
        for site in sites
    }

    hours_by_site: dict[str, list[dict]] = {
        site["slug"]: [_empty_hour(slot["validAt"]) for slot in forecast_slots] for site in sites
    }

    def surface_task(hour_index: int, field_name: str, variable: str):
        def run_task() -> None:
            values = sample(variable, forecast_slots[hour_index]["forecastHour"])
            for site in sites:
                hour = hours_by_site[site["slug"]][hour_index]
                hour[field_name] = _required_value(values[site["slug"]], field_name, site)

        return run_task

    def temperature_task(hour_index: int):
        """2 m temperature and true dew point — the depression the derivation
        expects is T − Td, dodging the 30 K clamp ECCC applies to its
        published depressions at 2 m."""

        def run_task() -> None:
            forecast_hour = forecast_slots[hour_index]["forecastHour"]
            temperature = sample(model.temperature_variable, forecast_hour)
            dew_point = sample(model.dew_point_variable, forecast_hour)
            for site in sites:
                slug = site["slug"]
                t = _required_value(temperature[slug], "temperatureC", site)
                d = _required_value(dew_point[slug], "dewPointC", site)
                hour = hours_by_site[slug][hour_index]
                hour["temperatureC"] = t - KELVIN
                hour["dewPointDepressionC"] = t - d

        return run_task

    def precip_window_task(hour_index: int):
        def run_task() -> None:
            # mm over the trailing 1 h window on an hourly schedule is mm/h.
            values = sample(
                model.precip_window_variable, forecast_slots[hour_index]["forecastHour"]
            )
            for site in sites:
                hour = hours_by_site[site["slug"]][hour_index]
                hour["precipitationMm"] = _required_value(
                    values[site["slug"]], "precipitationMm", site
                )

        return run_task

    # Run-total precipitation accumulations by forecast hour, sampled at the
    # sites. Hour 0 is the start of the run: nothing has accumulated yet (and
    # the Datamart publishes no precipitation files there).
    accumulation_lock = threading.Lock()
    accumulated_by_hour: dict[int, dict[str, float]] = {
        0: {site["slug"]: 0.0 for site in sites}
    }

    def accumulated_precip(forecast_hour: int) -> dict[str, float]:
        with accumulation_lock:
            cached = accumulated_by_hour.get(forecast_hour)
        if cached is not None:
            return cached
        # Two tasks racing on the same hour fetch it twice; that is harmless.
        values = sample(model.precip_run_total_variable, forecast_hour)
        totals = {
            site["slug"]: _required_value(values[site["slug"]], "precipitationMm", site)
            for site in sites
        }
        with accumulation_lock:
            accumulated_by_hour[forecast_hour] = totals
        return totals

    def precip_total_task(hour_index: int):
        def run_task() -> None:
            forecast_hour = forecast_slots[hour_index]["forecastHour"]
            rates = _precip_rate_for_hour(
                accumulated_precip, model.forecast_hours, forecast_hour
            )
            for site in sites:
                hours_by_site[site["slug"]][hour_index]["precipitationMm"] = rates[site["slug"]]

        return run_task

    def gust_task(hour_index: int):
        """Hour-max gust published, instantaneous gust fetched as a witness.

        ECCC's GUST-Max interval metadata is broken upstream, so the
        hourly-window semantics were established empirically; every build
        re-asserts the cheap invariant Max >= instant at the sampled sites
        and fails loudly if the files ever stop meaning what they meant."""

        def run_task() -> None:
            forecast_hour = forecast_slots[hour_index]["forecastHour"]
            try:
                hour_max = sample(model.gust_max_variable, forecast_hour)
                instant = sample(model.gust_instant_variable, forecast_hour)
            except NotFoundError:
                return  # optional field: an absent file stays out of the document
            for site in sites:
                slug = site["slug"]
                max_value = hour_max[slug]
                if max_value is None:
                    continue
                instant_value = instant[slug]
                if instant_value is not None and max_value < instant_value - _GUST_MAX_SLACK_MS:
                    raise RuntimeError(
                        f"Gust semantics broke for {site['name']} at PT{forecast_hour:03d}: "
                        f"hour-max {max_value:.2f} m/s < instantaneous {instant_value:.2f} m/s"
                    )
                hours_by_site[slug][hour_index]["windGustMs"] = max_value

        return run_task

    def cape_task(hour_index: int):
        def run_task() -> None:
            forecast_hour = forecast_slots[hour_index]["forecastHour"]
            try:
                cape = sample(model.cape_variable, forecast_hour)
                cin = sample(model.cin_variable, forecast_hour) if model.cin_variable else None
            except NotFoundError:
                return
            for site in sites:
                slug = site["slug"]
                hour = hours_by_site[slug][hour_index]
                # Sentinels (9999 / -1, "not computed") mask to absence —
                # never a value — before anything reaches the document.
                if cape[slug] is not None:
                    value = mask_sentinel(cape[slug], model.cape_sentinel)
                    if value is not None:
                        hour["capeJkg"] = value
                if cin is not None and cin[slug] is not None:
                    value = mask_sentinel(cin[slug], model.cape_sentinel)
                    if value is not None:
                        hour["cinJkg"] = value

        return run_task

    def pbl_task(hour_index: int):
        def run_task() -> None:
            forecast_hour = forecast_slots[hour_index]["forecastHour"]
            try:
                values = sample(model.pbl_variable, forecast_hour)
            except NotFoundError:
                return
            for site in sites:
                value = values[site["slug"]]
                if value is not None:
                    hours_by_site[site["slug"]][hour_index]["pblHeightM"] = value

        return run_task

    def pressure_task(hour_index: int, field_name: str, pressure_hpa: int):
        def run_task() -> None:
            forecast_hour = forecast_slots[hour_index]["forecastHour"]
            try:
                values = sample(
                    model.pressure_variable(field_name, pressure_hpa), forecast_hour
                )
            except NotFoundError:
                # Levels the schedule predicts can still go missing upstream;
                # an absent level simply stays out of the column, exactly as
                # the WCS build tolerated.
                return
            convert = (lambda v: v - KELVIN) if field_name == "temperatureC" else (lambda v: v)
            for site in sites:
                value = values[site["slug"]]
                if value is None:
                    continue
                levels = hours_by_site[site["slug"]][hour_index]["levels"]
                levels.setdefault(pressure_hpa, {"pressureHpa": pressure_hpa})[field_name] = (
                    convert(value)
                )

        return run_task

    def tasks_for_hour(hour_index: int) -> list:
        forecast_hour = forecast_slots[hour_index]["forecastHour"]
        tasks = [temperature_task(hour_index)]
        tasks += [
            surface_task(hour_index, field_name, variable)
            for field_name, variable in model.surface_variables.items()
        ]
        if model.precip_window_variable:
            tasks.append(precip_window_task(hour_index))
        if model.precip_run_total_variable:
            tasks.append(precip_total_task(hour_index))
        if model.gust_max_variable:
            tasks.append(gust_task(hour_index))
        if model.cape_variable and model.cape_for_hour(forecast_hour):
            tasks.append(cape_task(hour_index))
        if model.pbl_variable:
            tasks.append(pbl_task(hour_index))
        for pressure_hpa in model.levels_for_hour(forecast_hour):
            for field_name in PRESSURE_FIELDS:
                tasks.append(pressure_task(hour_index, field_name, pressure_hpa))
            if pressure_hpa in model.omega_levels:
                tasks.append(pressure_task(hour_index, "verticalVelocityPaS", pressure_hpa))
        return tasks

    # The last hour first: a run the Datamart has only partially published
    # fails before ~4,000 downloads, not after.
    last_hour_index = len(forecast_slots) - 1
    _run_concurrent(tasks_for_hour(last_hour_index))
    _run_concurrent([task for index in range(last_hour_index) for task in tasks_for_hour(index)])

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
                raise RuntimeError(f"Datamart returned too few pressure levels for {site['name']}")
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
                model=model.slug,
                semantics=model_semantics(model),
            )
        )
    return {
        "firstForecastHour": forecast_slots[0]["forecastHour"],
        "forecastHours": len(forecast_slots),
        "lastForecastHour": forecast_slots[last_hour_index]["forecastHour"],
        "profiles": profiles,
    }


def _previous_scheduled_hour(schedule: Sequence[int], forecast_hour: int) -> int:
    """The schedule step before forecast_hour; 0 (run start) before the first."""
    index = schedule.index(forecast_hour)
    return schedule[index - 1] if index else 0


def _precip_rate_for_hour(
    accumulated: Callable[[int], dict[str, float]],
    schedule: Sequence[int],
    forecast_hour: int,
) -> dict[str, float]:
    """Precipitation rate over one schedule step, differenced from run totals.

    The spec publishes mm/h, so the step's accumulation is divided by its
    window hours (3 h on the GDPS schedule)."""
    previous_hour = _previous_scheduled_hour(schedule, forecast_hour)
    window_hours = forecast_hour - previous_hour
    current = accumulated(forecast_hour)
    previous = accumulated(previous_hour)
    return {
        slug: max(0.0, current[slug] - previous[slug]) / window_hours for slug in current
    }


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
        raise RuntimeError(f"Datamart returned no {field_name} for {site['name']}")
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


def run(model: DatamartModel) -> None:
    try:
        main(model)
    except Exception as error:  # noqa: BLE001 — the workflow wants the message, not a trace
        print(error, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    run(HRDPS)

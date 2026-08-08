"""Builds per-site ensemble JSON from ECCC's REPS 10 km ensemble.

Not a windgram: the output contextualizes the deterministic windgram with
per-hour percentiles of the quantities the profiles publish — usable-lift
top, boundary-layer top, thermal velocity, cloud base, the surface scalars,
and per-level ensemble soundings. The physics rule: every one of the 21
members is derived as its own atmosphere and the percentiles are taken
across the derived outputs — inputs are never averaged first, because the
mean of 21 atmospheres is not an atmosphere.

Schema semantics — the contract with consumers:
- Each scalar publishes {"members", "p10", "p25", "p50", "p75", "p90"}.
  Percentiles are conditional on the quantity being defined: a member with
  no boundary layer or no usable lift stays out of that scalar's ranking,
  not ranked at zero, and "members" says how many of the 21 contributed.
  At levels the same rule covers terrain: a level below a member's model
  surface is dropped from that member's column, so its blocks may count
  fewer than 21 members.
- boundaryLayerTopM and usableLiftTopM additionally publish
  "ceiledMembers": how many of the defined members were clamped at the top
  of their own column because the parcel was still buoyant at the highest
  level. When it is nonzero, the percentiles are lower bounds, not
  measurements.
- Renderer guidance: with fewer than about half the members defined, show
  the defined fraction rather than a band; with ceiledMembers nonzero,
  label the band a floor, never a ceiling.
- Wind direction is circular, so it never gets a percentile block: ranking
  bearings across the 0/360 wrap is meaningless (350° and 10° are 20°
  apart, not 340°). Directions publish a single consensus bearing — the
  circular median of the member bearings — as a plain number.

The column: REPS's fixed 9-level set intersected with the pilot band is
1000/925/850/700/500 hPa, and all five publish as sounding levels (there is
nothing between 700 and 500 to curate away, and 500 doubles as the
parcel-ceiling headroom the dry-parcel search needs above summer boundary
layers). 1000 hPa — and at mountain sites 925 — typically sits below REPS
model terrain and the derivation's own filter drops it per member.

Transport is Datamart GRIB2 only (the 2026-08-08 research doc; the GeoMet
WCS hybrid is gone). Every raw-variable file stacks all 21 members as GRIB
messages keyed by perturbationNumber, 0 the control. Levels carry TMP, RH,
HGT, UGRD, VGRD — no dew point in any form, so depressions are derived from
T + RH; no WDIR/WIND, and the rotated grid's components are grid-relative
(uvRelativeToGrid=1), so they are rotated to true east/north before the
wind convention is applied. Fluxes are instantaneous W/m²; precipitation is
a run-total accumulation, differenced between 3 h steps and divided by the
window into mm/h; hour 000 publishes no flux or precipitation files (and is
never fetched — the schedule starts at hour 3, and terrain's HGT_SFC, which
exists at PT000 only, is the sole hour-0 download). A run moves ~9.4 GiB,
so files stream: each is fetched into memory, sampled at the catalogued
sites for all 21 members, and dropped before the next — nothing touches
disk and peak residency is FETCH_CONCURRENCY files.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .datamart import DownloadStats, datamart_base, exists, fetch_bytes
from .grib import GribField, earth_wind, split_messages
from .moisture import dew_point_depression
from .noaa import wind_from_uv
from .publish import append_history, round_document, write_json
from .windgram import SCHEMA_VERSION, derive_windgram_profile

SLUG = "reps"
OUT_DIR = Path("data") / SLUG

MEMBER_COUNT = 21
PERTURBATION_NUMBERS = tuple(range(MEMBER_COUNT))
RUN_HOURS = ("18", "12", "06", "00")
STEP_HOURS = 3
LAST_FORECAST_HOUR = 72
FORECAST_HOURS = tuple(range(STEP_HOURS, LAST_FORECAST_HOUR + 1, STEP_HOURS))
# Per-host Datamart budget; the documented-limit arithmetic and the
# one-job-per-host rule live with FETCH_CONCURRENCY in windgram/build.py.
FETCH_CONCURRENCY = 5

KELVIN = 273.15
# Datamart <VAR>_<LEVEL> tokens → source-hour fields, with unit conversions
# (TMP K, RH %, PRMSL Pa, TCDC %, fluxes W/m²). One file carries 21 members.
SURFACE_FIELDS = {
    "cloudCoverPercent": ("TCDC_SFC", lambda v: v),
    "latentHeatFluxWm2": ("LHTFL_SFC", lambda v: v),
    "pressurePa": ("PRMSL_MSL", lambda v: v),
    "relativeHumidityPercent": ("RH_AGL-2m", lambda v: v),
    "sensibleHeatFluxWm2": ("SHTFL_SFC", lambda v: v),
    "temperatureC": ("TMP_AGL-2m", lambda v: v - KELVIN),
}
PRECIP_ACCUMULATION_VARIABLE = "APCP_SFC"
TERRAIN_VARIABLE = "HGT_SFC"
PRESSURE_FIELDS = {
    "heightM": ("HGT", lambda v: v),
    "relativeHumidityPercent": ("RH", lambda v: v),
    "temperatureC": ("TMP", lambda v: v - KELVIN),
}
PRESSURE_LEVELS = (1000, 925, 850, 700, 500)

# Wind files: UGRD/VGRD per level. Level token → pressureHpa (None marks the
# 10 m surface wind).
WIND_LEVEL_TOKENS = {"AGL-10m": None} | {
    f"ISBL-{level:04d}": level for level in PRESSURE_LEVELS
}

PERCENTILE_POINTS = (10, 25, 50, 75, 90)
# The per-hour surface positions the ensemble document publishes, in the
# published hour's own key order. Every position is a percentile block except wind
# direction, which is circular (see the module docstring).
SURFACE_SCALARS = (
    "pressurePa",
    "temperatureC",
    "dewPointC",
    "windSpeedMs",
    "windDirectionDeg",
    "cloudCoverPercent",
    "precipitationMmHr",
    "sensibleHeatFluxWm2",
    "latentHeatFluxWm2",
)
# Level positions in the published Level key order; pressureHpa identifies the
# level and stays plain, windDirectionDeg is circular and handled apart.
LEVEL_SCALARS = ("heightM", "temperatureC", "dewPointC", "windSpeedMs")
DERIVED_SCALARS = (
    "boundaryLayerTopM",
    "thermalVelocityMs",
    "cloudBaseM",
    "usableLiftTopM",
)
# Quantities the derivation clamps at the top of a member's column when the
# parcel is still buoyant at the highest level; their blocks carry a
# ceiledMembers count so consumers know when percentiles are lower bounds.
CENSORED_SCALARS = ("boundaryLayerTopM", "usableLiftTopM")
# Covers the float round-trip of elevation + (top − elevation).
CEILING_TOLERANCE_M = 0.5


def percentile(sorted_values: list[float], point: float) -> float:
    """Percentile by linear interpolation between closest ranks (the sorted
    values are trusted, not re-sorted). With 21 members every published point
    lands on an exact rank: p10→2, p25→5, p50→10, p75→15, p90→18."""
    if not sorted_values:
        raise ValueError("percentile of no values")
    rank = (len(sorted_values) - 1) * point / 100
    low = math.floor(rank)
    high = math.ceil(rank)
    if low == high:
        return sorted_values[low]
    return sorted_values[low] + (rank - low) * (sorted_values[high] - sorted_values[low])


def circular_median(bearings: list[float]) -> float:
    """The consensus wind bearing: bearings are unwrapped to within ±180° of
    their vector-mean bearing and the ordinary median of the unwrapped
    angles is taken. Robust to stray members, well-defined whenever the
    ensemble has any directional consensus (with none — vectors cancelling
    exactly — the mean's arbitrary bearing is as honest an anchor as any),
    and equal to the plain median when no member straddles the wrap."""
    if not bearings:
        raise ValueError("circular median of no bearings")
    east = sum(math.sin(math.radians(bearing)) for bearing in bearings)
    north = sum(math.cos(math.radians(bearing)) for bearing in bearings)
    anchor = math.degrees(math.atan2(east, north))
    unwrapped = sorted(
        anchor + (bearing - anchor + 180) % 360 - 180 for bearing in bearings
    )
    return percentile(unwrapped, 50) % 360


def main() -> None:
    arguments = _parse_arguments()
    sites = json.loads(Path("sites.json").read_text())
    if not sites:
        raise RuntimeError("sites.json is empty")

    if arguments.reference_time:
        reference_time = _canonical_instant(arguments.reference_time)
    else:
        reference_time = _latest_complete_run()
        if reference_time is None:
            print("No complete REPS run is available.")
            return
        if _published_reference_time() == reference_time:
            print(f"REPS run {reference_time} is already published.")
            return

    forecast_slots = [
        {"forecastHour": hour, "validAt": _valid_time(reference_time, hour)}
        for hour in _forecast_hours(arguments.steps)
    ]
    print(
        f"Building REPS ensemble {reference_time} for {len(sites)} sites "
        f"({len(forecast_slots)} steps × {MEMBER_COUNT} members)…"
    )
    started_at = time.monotonic()
    download_stats = DownloadStats()
    result = _build_documents(reference_time, forecast_slots, sites, download_stats)

    sites_dir = OUT_DIR / "sites"
    sites_dir.mkdir(parents=True, exist_ok=True)
    for document in result["documents"]:
        document = round_document(document)
        write_json(sites_dir / f"{document['site']['id']}.json", document, compact=True)
        append_history(document, OUT_DIR / "history")
    manifest = {
        "firstForecastHour": result["firstForecastHour"],
        "forecastHours": result["forecastHours"],
        "generatedAt": _instant(),
        "lastForecastHour": result["lastForecastHour"],
        "memberCount": MEMBER_COUNT,
        "model": SLUG,
        "referenceTime": reference_time,
        "schemaVersion": SCHEMA_VERSION,
        "sites": [{"name": site["name"], "slug": site["slug"]} for site in sites],
        "stats": {
            "downloadBytes": download_stats.response_bytes,
            "downloadRetries": download_stats.retries,
            "downloads": download_stats.requests,
            "durationMs": round((time.monotonic() - started_at) * 1000),
        },
    }
    write_json(OUT_DIR / "manifest.json", manifest, compact=False)
    print(
        f"Published {len(result['documents'])} ensemble documents for {reference_time} "
        f"({download_stats.requests} downloads, "
        f"{download_stats.response_bytes // (1024 * 1024)} MiB)."
    )


def _parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--reference-time",
        help="build this run (e.g. 2026-08-07T12:00:00Z) instead of probing for "
        "the newest complete one; skips the already-published check",
    )
    parser.add_argument(
        "--steps",
        help="comma-separated forecast hours to build (e.g. 18,21,24) instead of "
        "the full 3-hourly schedule",
    )
    return parser.parse_args()


def _forecast_hours(steps: str | None) -> tuple[int, ...]:
    if steps is None:
        return tuple(FORECAST_HOURS)
    hours = tuple(sorted(int(step) for step in steps.split(",")))
    for hour in hours:
        if hour not in FORECAST_HOURS:
            raise RuntimeError(f"forecast hour {hour} is not on the REPS 3-hourly schedule")
    return hours


def _latest_complete_run() -> str | None:
    """A run is complete when its final hour's 10 m wind is on the Datamart.
    The date directory is pre-created ahead of data, so only a HEAD of the
    file itself proves anything."""
    now = datetime.now(timezone.utc)
    for day_offset in (0, 1):
        date = (now - timedelta(days=day_offset)).strftime("%Y%m%d")
        for hour in RUN_HOURS:
            if day_offset == 0 and int(hour) > now.hour:
                continue
            if exists(_file_url("UGRD_AGL-10m", date, hour, LAST_FORECAST_HOUR)):
                return f"{date[:4]}-{date[4:6]}-{date[6:]}T{hour}:00:00Z"
    return None


def _file_url(variable_level: str, date: str, run_hour: str, forecast_hour: int) -> str:
    name = (
        f"{date}T{run_hour}Z_MSC_REPS_{variable_level}_"
        f"RLatLon0.09x0.09_PT{forecast_hour:03d}H.grib2"
    )
    return (
        f"{datamart_base()}/{date}/WXO-DD/ensemble/reps/10km/grib2/"
        f"{run_hour}/{forecast_hour:03d}/{name}"
    )


def _published_reference_time() -> str | None:
    try:
        return json.loads((OUT_DIR / "manifest.json").read_text())["referenceTime"]
    except (OSError, KeyError, ValueError):
        return None


def _build_documents(
    reference_time: str,
    forecast_slots: list[dict],
    sites: list[dict],
    download_stats: DownloadStats,
) -> dict:
    run_date = reference_time[:10].replace("-", "")
    run_hour = reference_time[11:13]

    def fetch_members(
        variable_level: str, forecast_hour: int, field: str
    ) -> dict[int, dict[str, float]]:
        """One all-members file, streamed: fetched, sampled at every site for
        every member, and released before the caller moves on."""
        data = fetch_bytes(
            _file_url(variable_level, run_date, run_hour, forecast_hour), download_stats
        )
        return _sample_scalar_members(data, sites, field)

    # Model terrain per member (HGT_SFC exists at PT000 only; every other
    # download is a forecast-hour file).
    terrain = fetch_members(TERRAIN_VARIABLE, 0, "model elevation")

    # hours[slug][member][hour_index] → a windgram source hour in the making.
    hours: dict[str, dict[int, list[dict]]] = {
        site["slug"]: {
            member: [_empty_hour(slot["validAt"]) for slot in forecast_slots]
            for member in PERTURBATION_NUMBERS
        }
        for site in sites
    }

    def store(hour_index: int, field: str, values: dict[int, dict[str, float]], convert):
        for member in PERTURBATION_NUMBERS:
            for site in sites:
                hours[site["slug"]][member][hour_index][field] = convert(
                    values[member][site["slug"]]
                )

    def surface_task(hour_index: int, field: str, variable_level: str, convert):
        def run_task() -> None:
            values = fetch_members(
                variable_level, forecast_slots[hour_index]["forecastHour"], field
            )
            store(hour_index, field, values, convert)

        return run_task

    def pressure_task(hour_index: int, field: str, variable: str, pressure_hpa: int, convert):
        def run_task() -> None:
            values = fetch_members(
                f"{variable}_ISBL-{pressure_hpa:04d}",
                forecast_slots[hour_index]["forecastHour"],
                f"{field}@{pressure_hpa}",
            )
            for member in PERTURBATION_NUMBERS:
                for site in sites:
                    levels = hours[site["slug"]][member][hour_index]["levels"]
                    levels.setdefault(pressure_hpa, {"pressureHpa": pressure_hpa})[field] = (
                        convert(values[member][site["slug"]])
                    )

        return run_task

    # Run-total precipitation, differenced between consecutive 3-hourly steps
    # and divided by the window: the surface block publishes mm/h (the
    # build_gfs idiom). Nothing has accumulated at hour 0 — hour 000 publishes
    # no APCP file at all — so the first step's baseline is seeded, not
    # fetched.
    accumulation_lock = threading.Lock()
    accumulated: dict[int, dict[int, dict[str, float]]] = {
        0: {
            member: {site["slug"]: 0.0 for site in sites}
            for member in PERTURBATION_NUMBERS
        }
    }

    def accumulated_precip(forecast_hour: int) -> dict[int, dict[str, float]]:
        with accumulation_lock:
            cached = accumulated.get(forecast_hour)
        if cached is not None:
            return cached
        values = fetch_members(PRECIP_ACCUMULATION_VARIABLE, forecast_hour, "precipitationMm")
        with accumulation_lock:
            accumulated[forecast_hour] = values
        return values

    def precip_task(hour_index: int):
        def run_task() -> None:
            forecast_hour = forecast_slots[hour_index]["forecastHour"]
            current = accumulated_precip(forecast_hour)
            previous = accumulated_precip(forecast_hour - STEP_HOURS)
            for member in PERTURBATION_NUMBERS:
                for site in sites:
                    slug = site["slug"]
                    hours[slug][member][hour_index]["precipitationMm"] = (
                        max(0.0, current[member][slug] - previous[member][slug]) / STEP_HOURS
                    )

        return run_task

    def wind_task(hour_index: int, level_token: str, pressure_hpa: int | None):
        def run_task() -> None:
            forecast_hour = forecast_slots[hour_index]["forecastHour"]
            u_members = _sample_wind_members(
                fetch_bytes(
                    _file_url(f"UGRD_{level_token}", run_date, run_hour, forecast_hour),
                    download_stats,
                ),
                sites,
            )
            v_members = _sample_wind_members(
                fetch_bytes(
                    _file_url(f"VGRD_{level_token}", run_date, run_hour, forecast_hour),
                    download_stats,
                ),
                sites,
            )
            for member in PERTURBATION_NUMBERS:
                for site in sites:
                    slug = site["slug"]
                    east, north = earth_wind(
                        u_members[member]["values"][slug],
                        v_members[member]["values"][slug],
                        site["latitude"],
                        site["longitude"],
                        u_members[member]["southPoleLatitude"],
                        u_members[member]["southPoleLongitude"],
                    )
                    speed, direction = wind_from_uv(east, north)
                    hour = hours[slug][member][hour_index]
                    if pressure_hpa is None:
                        hour["windSpeedMs"] = speed
                        hour["windDirectionDeg"] = direction
                    else:
                        level = hour["levels"].setdefault(
                            pressure_hpa, {"pressureHpa": pressure_hpa}
                        )
                        level["windSpeedMs"] = speed
                        level["windDirectionDeg"] = direction

        return run_task

    def tasks_for_hour(hour_index: int) -> list:
        tasks = [
            surface_task(hour_index, field, variable_level, convert)
            for field, (variable_level, convert) in SURFACE_FIELDS.items()
        ]
        tasks.append(precip_task(hour_index))
        for pressure_hpa in PRESSURE_LEVELS:
            for field, (variable, convert) in PRESSURE_FIELDS.items():
                tasks.append(pressure_task(hour_index, field, variable, pressure_hpa, convert))
        for level_token, pressure_hpa in WIND_LEVEL_TOKENS.items():
            tasks.append(wind_task(hour_index, level_token, pressure_hpa))
        return tasks

    # The last hour first: a run the Datamart has only partially published
    # fails before ~850 downloads, not after.
    last_hour_index = len(forecast_slots) - 1
    _run_concurrent(tasks_for_hour(last_hour_index))
    _run_concurrent([task for index in range(last_hour_index) for task in tasks_for_hour(index)])

    generated_at = _profile_instant()
    documents = []
    for site in sites:
        member_profiles = [
            _derive_member_profile(
                site,
                hours[site["slug"]][member],
                terrain[member][site["slug"]],
                reference_time,
                generated_at,
            )
            for member in PERTURBATION_NUMBERS
        ]
        documents.append(
            {
                "schemaVersion": SCHEMA_VERSION,
                "model": SLUG,
                "run": {
                    "referenceTime": reference_time,
                    "generatedAt": generated_at,
                },
                "site": {
                    "id": site["slug"],
                    "name": site["name"],
                    "latitude": site["latitude"],
                    "longitude": site["longitude"],
                    "altitudeM": site["elevationM"],
                    # The control member's terrain stands in for the ensemble.
                    "modelElevationM": terrain[0][site["slug"]],
                },
                "hours": _aggregate_hours(member_profiles),
            }
        )
    return {
        "firstForecastHour": forecast_slots[0]["forecastHour"],
        "forecastHours": len(forecast_slots),
        "lastForecastHour": forecast_slots[last_hour_index]["forecastHour"],
        "documents": documents,
    }


def _derive_member_profile(
    site: dict,
    member_hours: list[dict],
    model_elevation_m: float,
    reference_time: str,
    generated_at: str,
) -> dict:
    """One member's windgram profile, from its own column — the derivation
    runs 21 times per site, never on averaged inputs."""
    source_hours = []
    for hour in member_hours:
        levels = sorted(hour["levels"].values(), key=lambda level: level["pressureHpa"])
        incomplete = [
            level["pressureHpa"] for level in levels if not _is_complete_level(level)
        ]
        if len(levels) != len(PRESSURE_LEVELS) or incomplete:
            raise RuntimeError(
                f"REPS column for {site['name']} at {hour['validAt']} is missing "
                f"level data ({incomplete or 'whole levels'})"
            )
        hour = dict(hour)
        hour["dewPointDepressionC"] = dew_point_depression(
            hour["temperatureC"], hour.pop("relativeHumidityPercent")
        )
        source_hours.append(
            {
                **hour,
                "levels": [
                    _with_dew_point_depression(level)
                    for level in sorted(levels, key=lambda level: level["heightM"])
                ],
            }
        )
    return derive_windgram_profile(
        {
            "generatedAt": generated_at,
            "hours": source_hours,
            "latitude": site["latitude"],
            "longitude": site["longitude"],
            "modelElevationM": model_elevation_m,
            "referenceTime": reference_time,
            "siteAltitudeM": site["elevationM"],
            "siteId": site["slug"],
            "siteName": site["name"],
        },
        model=SLUG,
    )


def _with_dew_point_depression(level: dict) -> dict:
    level = dict(level)
    level["dewPointDepressionC"] = dew_point_depression(
        level["temperatureC"], level.pop("relativeHumidityPercent")
    )
    return level


def _aggregate_hours(member_profiles: list[dict]) -> list[dict]:
    """Percentiles across the members' derived hours, published in the
    contract's hour shape — surface, sounding levels, derived. A member whose scalar is
    null (no boundary layer, no usable lift) is left out of that scalar's
    ranking; the members count says how many contributed."""
    aggregated_hours = []
    for hour_index in range(len(member_profiles[0]["hours"])):
        member_hours = [profile["hours"][hour_index] for profile in member_profiles]
        aggregated_hours.append(
            {
                "validAt": member_hours[0]["validAt"],
                "surface": {
                    key: (
                        circular_median(
                            [hour["surface"][key] for hour in member_hours]
                        )
                        if key == "windDirectionDeg"
                        else _percentile_block(
                            [hour["surface"][key] for hour in member_hours]
                        )
                    )
                    for key in SURFACE_SCALARS
                },
                "levels": _aggregate_levels(member_hours),
                "derived": {
                    key: _derived_block(member_hours, key) for key in DERIVED_SCALARS
                },
            }
        )
    return aggregated_hours


def _aggregate_levels(member_hours: list[dict]) -> list[dict]:
    """The ensemble sounding: per pressure level, percentiles across the
    members whose filtered column kept it. A level below a member's model
    terrain is absent from that member's profile and stays out of the
    ranking — its blocks count the members that carried it — and a level no
    member kept is not published at all. Direction is the circular median,
    a plain number beside the percentile blocks."""
    by_pressure: dict[int, list[dict]] = {}
    for hour in member_hours:
        for level in hour["levels"]:
            by_pressure.setdefault(level["pressureHpa"], []).append(level)
    aggregated = []
    for pressure_hpa, levels in by_pressure.items():
        block: dict = {"pressureHpa": pressure_hpa}
        for key in LEVEL_SCALARS:
            block[key] = _percentile_block([level[key] for level in levels])
        block["windDirectionDeg"] = circular_median(
            [level["windDirectionDeg"] for level in levels]
        )
        aggregated.append(block)
    aggregated.sort(key=lambda level: level["heightM"]["p50"])
    return aggregated


def _derived_block(member_hours: list[dict], key: str) -> dict:
    block = _percentile_block([hour["derived"][key] for hour in member_hours])
    if key in CENSORED_SCALARS:
        return {"ceiledMembers": _ceiled_members(member_hours, key), **block}
    return block


def _ceiled_members(member_hours: list[dict], key: str) -> int:
    """How many defined members were censored at the top of their own column
    — the derivation clamps there when the parcel is still buoyant at the
    highest level, so the member's value is a floor, not a measurement."""
    count = 0
    for hour in member_hours:
        value = hour["derived"][key]
        levels = hour["levels"]
        if value is None or not levels:
            continue
        if value >= levels[-1]["heightM"] - CEILING_TOLERANCE_M:
            count += 1
    return count


def _percentile_block(values: list[float | None]) -> dict:
    present = sorted(value for value in values if value is not None)
    block: dict = {"members": len(present)}
    for point in PERCENTILE_POINTS:
        block[f"p{point}"] = percentile(present, point) if present else None
    return block


def _sample_scalar_members(
    data: bytes, sites: list[dict], field: str
) -> dict[int, dict[str, float]]:
    """Per-member site samples from an all-members Datamart file, keyed by
    GRIB perturbationNumber (0 is the control member)."""
    members: dict[int, dict[str, float]] = {}
    for message in split_messages(data):
        with GribField(message) as grib:
            if grib.metadata("gridType") != "rotated_ll":
                raise RuntimeError(f"REPS {field} file is not on the rotated grid")
            member = int(grib.metadata("perturbationNumber"))
            members[member] = {
                site["slug"]: _required_value(
                    grib.value_at(site["latitude"], site["longitude"]), field, site, member
                )
                for site in sites
            }
    _require_all_members(members, field)
    return members


def _sample_wind_members(data: bytes, sites: list[dict]) -> dict[int, dict]:
    """Like _sample_scalar_members, but for grid-relative UGRD/VGRD: the
    grid's rotation pole rides along so the caller can rotate the components
    to true east/north."""
    members: dict[int, dict] = {}
    for message in split_messages(data):
        with GribField(message) as field:
            if field.metadata("gridType") != "rotated_ll":
                raise RuntimeError("REPS wind file is not on the rotated grid")
            if float(field.metadata("angleOfRotationInDegrees")) != 0.0:
                raise RuntimeError("REPS wind grid has an unexpected rotation angle")
            if int(field.metadata("uvRelativeToGrid")) != 1:
                raise RuntimeError("REPS wind components are unexpectedly earth-relative")
            member = int(field.metadata("perturbationNumber"))
            members[member] = {
                "southPoleLatitude": float(
                    field.metadata("latitudeOfSouthernPoleInDegrees")
                ),
                "southPoleLongitude": float(
                    field.metadata("longitudeOfSouthernPoleInDegrees")
                ),
                "values": {
                    site["slug"]: _required_value(
                        field.value_at(site["latitude"], site["longitude"]),
                        "wind component",
                        site,
                        member,
                    )
                    for site in sites
                },
            }
    _require_all_members(members, "wind component")
    return members


def _require_all_members(members: dict[int, dict], field: str) -> None:
    if sorted(members) != list(PERTURBATION_NUMBERS):
        raise RuntimeError(
            f"REPS {field} file carries members {sorted(members)}, expected 0–20"
        )


def _empty_hour(valid_at: str) -> dict:
    return {
        "cloudCoverPercent": math.nan,
        "latentHeatFluxWm2": math.nan,
        "levels": {},
        "precipitationMm": math.nan,
        "pressurePa": math.nan,
        "relativeHumidityPercent": math.nan,
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
    "relativeHumidityPercent",
    "windDirectionDeg",
    "windSpeedMs",
)


def _is_complete_level(level: dict) -> bool:
    return all(field in level for field in _LEVEL_FIELDS)


def _required_value(value: float | None, field: str, site: dict, member: int) -> float:
    if value is None or not math.isfinite(value):
        raise RuntimeError(f"No {field} for {site['name']} (member {member})")
    return value


def _canonical_instant(value: str) -> str:
    instant = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return instant.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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

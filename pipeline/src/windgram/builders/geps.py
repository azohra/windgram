"""Builds per-site ensemble JSON from ECCC's GEPS 0.5° global ensemble.

The same product as the REPS build — per-hour percentiles of derived
quantities and per-level ensemble soundings, every one of the 21 members
derived as its own atmosphere before any ranking — extended to sixteen
days, plus the one thing REPS cannot supply: **per-member surface-based
CAPE and CIN**, published as percentile spread. Ensemble storm risk is the
marquee: how many members see convective fuel, and how hard the morning
cap holds, as distributions rather than one model's opinion.

Schema semantics match the REPS document (percentile blocks are
conditional on the quantity being defined, "members" counts contributors,
direction is a circular median, ceiledMembers marks column-top censoring).
capeJkg joins the conditional scalars: GEPS encodes "convection not
computed here" as an exact -1 inside the CAPE values (~42 % of the globe
on the verification day), and masked members stay out of the ranking —
absence, never zero, because "not computed" is not a claim of stability.
CIN carries no sentinel (verified: it is computed even where CAPE is
flagged, and its near--1 values are ordinary packing bins), so all 21
members rank; real CAPE near 9999 J/kg exists in this model and is never
confused with RDPS/GDPS's 9999 sentinel, which GEPS does not use.

Transport is Datamart GRIB2 (verified 2026-08-08): raw member files under
`YYYYMMDD/WXO-DD/ensemble/geps/grib2/raw/HH/hhh/` still use the old
`CMC_geps-raw_<VAR>_<LVL>_<level>_latlon0p5x0p5_YYYYMMDDHH_Phhh_allmbrs.grib2`
naming; every file stacks all 21 members keyed by perturbationNumber, 0
the control. The grid is a regular 0.5° global lat-lon (720 × 361,
uvRelativeToGrid=0), so components are earth-relative and nothing is
rotated — unlike REPS. Runs are 00Z and 12Z; the schedule is the feed's
own, 3-hourly to 192 h then 6-hourly to 384 (the occasional Thursday 00Z
extension past 384 is not fetched). The 6-hourly tail keeps every valid
hour of day in play, so late-horizon daytime steps at the catalogued sites
survive the thinning.

Unlike REPS's instantaneous fluxes, GEPS heat fluxes are time-INTEGRATED
from run start (paramId 146/147, J/m², stepRange 0-h): the mean W/m² over
a window is the difference of consecutive accumulations divided by the
window seconds, and the build publishes the mean over the window ending at
each valid time. Precipitation is likewise a run-total accumulation,
differenced per window into mm/h. Hour 000 publishes neither (nothing has
accumulated), so the first step's baseline is seeded at zero; terrain
(HGT_SFC, per member) exists at PT000 only, is the sole hour-0 download,
and arrives in decametres despite metadata claiming metres (verified
2026-08-08; see TERRAIN_DAM_TO_M) — the pressure-level heights are genuine
metres. Moisture is RH everywhere (no dew point in any form). A full
run moves ~14 GiB — the heaviest feed in the pipeline — so files stream:
fetched into memory, sampled for all 21 members, and dropped.
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

from ..config import output_directory
from ..datamart import DownloadStats, datamart_base, exists, fetch_bytes
from ..derive import SCHEMA_VERSION, derive_windgram_profile
from ..ensemble import aggregate_member_profiles
from ..grib import GribField, split_messages
from ..moisture import dew_point_depression
from ..noaa import wind_from_uv
from ..publish import append_history, manifest_stats, round_document, write_json
from ..sentinel import mask_sentinel
from ..sites import load_sites

SLUG = "geps"

# The document's transport-semantics declaration (contract "semantics"):
# precipitation is a run-total accumulation differenced per scheduled step
# into the mean mm/h rate over the window. No gust key — GEPS publishes no
# per-member gust (capabilities gust: false).
SEMANTICS = {"precipitation": "windowMeanRate"}

MEMBER_COUNT = 21
PERTURBATION_NUMBERS = tuple(range(MEMBER_COUNT))
RUN_HOURS = ("12", "00")
LAST_FORECAST_HOUR = 384
# The feed's own schedule: 3-hourly through 192 h, 6-hourly to 384.
FORECAST_HOURS = tuple(range(3, 193, 3)) + tuple(range(198, LAST_FORECAST_HOUR + 1, 6))


def _out_dir() -> Path:
    return output_directory(SLUG)


# Per-host Datamart budget; the documented-limit arithmetic and the
# one-job-per-host rule live with FETCH_CONCURRENCY in eccc.py.
FETCH_CONCURRENCY = 5

KELVIN = 273.15
# GEPS flags "convection not computed" with an exact -1 in CAPE — the HRDPS
# family's sentinel, not RDPS/GDPS's 9999 (real GEPS CAPE approaches 9999
# J/kg). CIN has no sentinel at all (verified 2026-08-08).
CAPE_SENTINEL = -1.0

# Datamart <VAR>_<LVLTYPE>_<level> tokens → instantaneous source-hour fields,
# with unit conversions (TMP K, RH %, PRMSL Pa, TCDC %). One file carries all
# 21 members.
SURFACE_FIELDS = {
    "cloudCoverPercent": ("TCDC_SFC_0", lambda v: v),
    "pressurePa": ("PRMSL_MSL_0", lambda v: v),
    "relativeHumidityPercent": ("RH_TGL_2m", lambda v: v),
    "temperatureC": ("TMP_TGL_2m", lambda v: v - KELVIN),
}
CAPE_VARIABLE = "CAPE_SFC_0"
CIN_VARIABLE = "CIN_SFC_0"
# Run-origin accumulations, differenced per scheduled window: fluxes J/m² →
# mean W/m² over the window; precipitation run-total mm → mm/h.
FLUX_ACCUMULATION_VARIABLES = {
    "sensibleHeatFluxWm2": "SHTFL_SFC_0",
    "latentHeatFluxWm2": "LHTFL_SFC_0",
}
PRECIP_ACCUMULATION_VARIABLE = "APCP_SFC_0"
TERRAIN_VARIABLE = "HGT_SFC_0"
# The legacy CMC_geps-raw surface orography arrives in DECAMETRES — CMC's GZ
# convention — even though its GRIB metadata claims metres (paramId 228002
# "orog", units "m", byte-identical metadata to REPS's genuinely-metric
# HGT_SFC). Decoded 2026-08-08: the global field tops out at 586.3 with the
# Himalaya at 579.8 and Dundee (1485 m site) at 153.6 — ×10 is smoothed 0.5°
# terrain everywhere, ×1 puts the whole planet below 600 m. The pressure-level
# HGT_ISBL files are genuine geopotential metres (850 hPa at Dundee: 1512);
# only the surface field carries decametres.
TERRAIN_DAM_TO_M = 10.0
# Sanity band for the published terrain datum against the catalogued site
# elevations. A 0.5° grid legitimately smooths a single summit site far above
# the model surface, so one low reading proves nothing — but EVERY site
# sitting more than a kilometre below its catalogued elevation is a units or
# indexing error, not smoothing (the decametre encoding read 153.6 m at a
# 1485 m site), and no Earth terrain reaches 9 km in any encoding.
TERRAIN_DEFICIT_LIMIT_M = 1000.0
TERRAIN_CEILING_M = 9000.0
PRESSURE_FIELDS = {
    "heightM": ("HGT", lambda v: v),
    "relativeHumidityPercent": ("RH", lambda v: v),
    "temperatureC": ("TMP", lambda v: v - KELVIN),
}
# The REPS pilot band, unchanged: 1000/925/850/700 for display and 500 as
# the parcel-ceiling headroom. GEPS publishes nothing between 700 and 500.
PRESSURE_LEVELS = (1000, 925, 850, 700, 500)

# Wind files: UGRD/VGRD per level, earth-relative (uvRelativeToGrid=0).
# Level token → pressureHpa (None marks the 10 m surface wind).
WIND_LEVEL_TOKENS = {"TGL_10m": None} | {
    f"ISBL_{level:04d}": level for level in PRESSURE_LEVELS
}

# The per-hour surface positions, in the published hour's own key order.
# Every position is a percentile block except wind direction (circular).
# capeJkg and cinJkg are the point of this feed: capeJkg is conditional on
# the member computing convection (sentinel-masked members stay out of the
# ranking), cinJkg ranks all members.
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
    "capeJkg",
    "cinJkg",
)


def previous_scheduled_hour(forecast_hour: int) -> int:
    """The feed's own step before this one — the accumulation window start:
    3 h apart through 192, 6 h apart beyond (198's predecessor is 192)."""
    return forecast_hour - 3 if forecast_hour <= 192 else forecast_hour - 6


def main() -> None:
    arguments = _parse_arguments()
    sites = load_sites()
    if arguments.reference_time:
        reference_time = _canonical_instant(arguments.reference_time)
    else:
        reference_time = _latest_complete_run()
        if reference_time is None:
            print("No complete GEPS run is available.")
            return
        if _published_reference_time() == reference_time:
            print(f"GEPS run {reference_time} is already published.")
            return

    forecast_slots = [
        {"forecastHour": hour, "validAt": _valid_time(reference_time, hour)}
        for hour in _forecast_hours(arguments.steps)
    ]
    print(
        f"Building GEPS ensemble {reference_time} for {len(sites)} sites "
        f"({len(forecast_slots)} steps × {MEMBER_COUNT} members)…"
    )
    started_at = time.monotonic()
    download_stats = DownloadStats()
    result = _build_documents(reference_time, forecast_slots, sites, download_stats)

    sites_dir = _out_dir() / "sites"
    sites_dir.mkdir(parents=True, exist_ok=True)
    for document in result["documents"]:
        document = round_document(document)
        write_json(sites_dir / f"{document['site']['id']}.json", document, compact=True)
        append_history(document, _out_dir() / "history")
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
        "stats": manifest_stats(download_stats, started_at),
    }
    write_json(_out_dir() / "manifest.json", manifest, compact=False)
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
        "the full schedule",
    )
    return parser.parse_args()


def _forecast_hours(steps: str | None) -> tuple[int, ...]:
    if steps is None:
        return FORECAST_HOURS
    hours = tuple(sorted(int(step) for step in steps.split(",")))
    for hour in hours:
        if hour not in FORECAST_HOURS:
            raise RuntimeError(
                f"forecast hour {hour} is not on the GEPS schedule "
                "(3-hourly to 192, 6-hourly to 384)"
            )
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
            if exists(_file_url("UGRD_TGL_10m", date, hour, LAST_FORECAST_HOUR)):
                return f"{date[:4]}-{date[4:6]}-{date[6:]}T{hour}:00:00Z"
    return None


def _file_url(variable_level: str, date: str, run_hour: str, forecast_hour: int) -> str:
    name = (
        f"CMC_geps-raw_{variable_level}_latlon0p5x0p5_"
        f"{date}{run_hour}_P{forecast_hour:03d}_allmbrs.grib2"
    )
    return (
        f"{datamart_base()}/{date}/WXO-DD/ensemble/geps/grib2/raw/"
        f"{run_hour}/{forecast_hour:03d}/{name}"
    )


def _published_reference_time() -> str | None:
    try:
        return json.loads((_out_dir() / "manifest.json").read_text())["referenceTime"]
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
    # download is a forecast-hour file). The raw file is decametres — see
    # TERRAIN_DAM_TO_M — scaled to metres here and then sanity-checked
    # against the catalogued site elevations, because every published height
    # derives from this datum.
    terrain = {
        member: {
            slug: value * TERRAIN_DAM_TO_M for slug, value in member_values.items()
        }
        for member, member_values in fetch_members(
            TERRAIN_VARIABLE, 0, "model elevation"
        ).items()
    }
    _require_plausible_model_elevation(terrain, sites)

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

    def cape_task(hour_index: int):
        """Surface-based CAPE with the exact -1 "not computed" sentinel masked
        to None per member — the masked member leaves that hour's capeJkg
        ranking rather than asserting stability it never computed."""

        def run_task() -> None:
            values = fetch_members(
                CAPE_VARIABLE, forecast_slots[hour_index]["forecastHour"], "capeJkg"
            )
            store(
                hour_index,
                "capeJkg",
                values,
                lambda value: mask_sentinel(value, CAPE_SENTINEL),
            )

        return run_task

    def pressure_task(hour_index: int, field: str, variable: str, pressure_hpa: int, convert):
        def run_task() -> None:
            values = fetch_members(
                f"{variable}_ISBL_{pressure_hpa:04d}",
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

    # Run-origin accumulations — heat fluxes (J/m² since hour 0) and
    # precipitation (run-total mm) — differenced between consecutive
    # *scheduled* steps and divided by the window: fluxes publish the mean
    # W/m² over the window ending at the valid time, precipitation mm/h.
    # Nothing has accumulated at hour 0 — hour 000 publishes no flux or
    # precipitation files at all — so the first window's baseline is seeded,
    # not fetched.
    accumulation_lock = threading.Lock()
    accumulated: dict[tuple[str, int], dict[int, dict[str, float]]] = {
        (variable, 0): {
            member: {site["slug"]: 0.0 for site in sites}
            for member in PERTURBATION_NUMBERS
        }
        for variable in (PRECIP_ACCUMULATION_VARIABLE, *FLUX_ACCUMULATION_VARIABLES.values())
    }

    def accumulated_members(variable: str, forecast_hour: int) -> dict[int, dict[str, float]]:
        with accumulation_lock:
            cached = accumulated.get((variable, forecast_hour))
        if cached is not None:
            return cached
        values = fetch_members(variable, forecast_hour, f"accumulated {variable}")
        with accumulation_lock:
            accumulated[(variable, forecast_hour)] = values
        return values

    def accumulation_task(hour_index: int, field: str, variable: str, rate):
        """rate(delta, window_hours) turns the accumulation difference over
        the window into the published quantity."""

        def run_task() -> None:
            forecast_hour = forecast_slots[hour_index]["forecastHour"]
            window_start = previous_scheduled_hour(forecast_hour)
            current = accumulated_members(variable, forecast_hour)
            previous = accumulated_members(variable, window_start)
            window_hours = forecast_hour - window_start
            for member in PERTURBATION_NUMBERS:
                for site in sites:
                    slug = site["slug"]
                    hours[slug][member][hour_index][field] = rate(
                        current[member][slug] - previous[member][slug], window_hours
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
                    # The regular lat-lon grid's components are already
                    # earth-relative — no rotation, unlike REPS.
                    speed, direction = wind_from_uv(
                        u_members[member][slug], v_members[member][slug]
                    )
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
        tasks.append(cape_task(hour_index))
        tasks.append(surface_task(hour_index, "cinJkg", CIN_VARIABLE, lambda v: v))
        tasks.append(
            accumulation_task(
                hour_index,
                "precipitationMm",
                PRECIP_ACCUMULATION_VARIABLE,
                lambda delta, window_hours: max(0.0, delta) / window_hours,
            )
        )
        for field, variable in FLUX_ACCUMULATION_VARIABLES.items():
            tasks.append(
                accumulation_task(
                    hour_index,
                    field,
                    variable,
                    lambda delta, window_hours: delta / (window_hours * 3600),
                )
            )
        for pressure_hpa in PRESSURE_LEVELS:
            for field, (variable, convert) in PRESSURE_FIELDS.items():
                tasks.append(pressure_task(hour_index, field, variable, pressure_hpa, convert))
        for level_token, pressure_hpa in WIND_LEVEL_TOKENS.items():
            tasks.append(wind_task(hour_index, level_token, pressure_hpa))
        return tasks

    # The last hour first: a run the Datamart has only partially published
    # fails before ~3,400 downloads, not after.
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
                    "members": MEMBER_COUNT,
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
                "semantics": SEMANTICS,
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
    runs 21 times per site, never on averaged inputs. A sentinel-masked CAPE
    (None) is omitted from the member's source hour — the contract's
    optional-field idiom; CIN has no sentinel and is always present."""
    source_hours = []
    for hour in member_hours:
        levels = sorted(hour["levels"].values(), key=lambda level: level["pressureHpa"])
        incomplete = [
            level["pressureHpa"] for level in levels if not _is_complete_level(level)
        ]
        if len(levels) != len(PRESSURE_LEVELS) or incomplete:
            raise RuntimeError(
                f"GEPS column for {site['name']} at {hour['validAt']} is missing "
                f"level data ({incomplete or 'whole levels'})"
            )
        hour = dict(hour)
        hour["dewPointDepressionC"] = dew_point_depression(
            hour["temperatureC"], hour.pop("relativeHumidityPercent")
        )
        if hour["capeJkg"] is None:
            del hour["capeJkg"]
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
            "siteTimeZone": site.get("timeZone"),
        },
        model=SLUG,
        semantics=SEMANTICS,
    )


def _with_dew_point_depression(level: dict) -> dict:
    level = dict(level)
    level["dewPointDepressionC"] = dew_point_depression(
        level["temperatureC"], level.pop("relativeHumidityPercent")
    )
    return level


def _aggregate_hours(member_profiles: list[dict]) -> list[dict]:
    """Aggregate independently derived GEPS member profiles."""
    return aggregate_member_profiles(
        member_profiles,
        surface_scalars=SURFACE_SCALARS,
        # Preserve GEPS's existing optional-field aggregation: a member may
        # omit a non-direction surface scalar and leave that scalar's rank.
        optional_surface_scalars=SURFACE_SCALARS,
    )


def _sample_scalar_members(
    data: bytes, sites: list[dict], field: str
) -> dict[int, dict[str, float]]:
    """Per-member site samples from an all-members Datamart file, keyed by
    GRIB perturbationNumber (0 is the control member)."""
    members: dict[int, dict[str, float]] = {}
    for message in split_messages(data):
        with GribField(message) as grib:
            if grib.metadata("gridType") != "regular_ll":
                raise RuntimeError(f"GEPS {field} file is not on the regular 0.5° grid")
            member = int(grib.metadata("perturbationNumber"))
            members[member] = {
                site["slug"]: _required_value(
                    grib.value_at(site["latitude"], site["longitude"]), field, site, member
                )
                for site in sites
            }
    _require_all_members(members, field)
    return members


def _sample_wind_members(data: bytes, sites: list[dict]) -> dict[int, dict[str, float]]:
    """Like _sample_scalar_members, but asserting the components are
    earth-relative — the regular grid promises uvRelativeToGrid=0, and a
    grid that starts rotating must fail loudly, not skew every bearing."""
    members: dict[int, dict[str, float]] = {}
    for message in split_messages(data):
        with GribField(message) as field:
            if field.metadata("gridType") != "regular_ll":
                raise RuntimeError("GEPS wind file is not on the regular 0.5° grid")
            if int(field.metadata("uvRelativeToGrid")) != 0:
                raise RuntimeError("GEPS wind components are unexpectedly grid-relative")
            member = int(field.metadata("perturbationNumber"))
            members[member] = {
                site["slug"]: _required_value(
                    field.value_at(site["latitude"], site["longitude"]),
                    "wind component",
                    site,
                    member,
                )
                for site in sites
            }
    _require_all_members(members, "wind component")
    return members


def _require_all_members(members: dict[int, dict], field: str) -> None:
    if sorted(members) != list(PERTURBATION_NUMBERS):
        raise RuntimeError(
            f"GEPS {field} file carries members {sorted(members)}, expected 0–20"
        )


def _require_plausible_model_elevation(
    terrain: dict[int, dict[str, float]], sites: list[dict]
) -> None:
    """Fails loudly when the control member's terrain cannot be terrain —
    the gust hour-max ≥ instantaneous assertion's idiom, applied to the
    datum every published height derives from. The published 153.6 m at a
    1485 m mountain site shipped for as long as nothing checked this."""
    control = terrain[0]
    for site in sites:
        elevation = control[site["slug"]]
        if elevation > TERRAIN_CEILING_M:
            raise RuntimeError(
                f"GEPS model elevation for {site['name']} is {elevation:.1f} m — "
                "higher than any Earth terrain; the surface-orography encoding "
                "has changed (see TERRAIN_DAM_TO_M)"
            )
    if all(
        control[site["slug"]] < site["elevationM"] - TERRAIN_DEFICIT_LIMIT_M
        for site in sites
    ):
        readings = ", ".join(
            f"{site['name']} {control[site['slug']]:.1f} m (site {site['elevationM']} m)"
            for site in sites
        )
        raise RuntimeError(
            f"GEPS model elevation sits over {TERRAIN_DEFICIT_LIMIT_M:.0f} m below "
            f"the catalogued elevation at every site — a units or indexing error, "
            f"not smoothing: {readings}"
        )


def _empty_hour(valid_at: str) -> dict:
    return {
        "capeJkg": math.nan,
        "cinJkg": math.nan,
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

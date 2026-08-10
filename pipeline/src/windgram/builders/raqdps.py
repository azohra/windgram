"""Builds per-site wildfire-smoke documents from ECCC's RAQDPS 10 km air
quality model — the first non-profile document kind this pipeline publishes.

RAQDPS (GEM-MACH) is a different model than the wind-profile feeds: HRDPS
and friends stay smoke-blind, and consumers join a site's smoke document to
its profiles by validAt. The Datamart folds the wildfire products into the
plain model_raqdps tree (verified 2026-08-09 — there is no model_raqdps-fw
directory): PM2.5-WildfireSmokePlume_Sfc / _EAtm alongside plain PM2.5,
grid RLatLon0.09, runs 00Z and 12Z, hourly steps to 72 h, one message per
file, served identically on the hpfx mirror.

Transport and politeness match the other ECCC builders (whole-file fetches,
nothing written to disk). Set WINDGRAM_MAX_STEPS to cap the forecast steps
fetched (used by smoke tests) and WINDGRAM_DATAMART_BASE to fetch from the
hpfx mirror instead of dd (see windgram.datamart).
"""

from __future__ import annotations

import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ..config import output_directory
from ..datamart import DownloadStats, datamart_base, exists, fetch_bytes
from ..dataset import published_reference_time
from ..derive import SCHEMA_VERSION
from ..grib import GribField
from ..publish import append_history, manifest_stats, round_document, write_json
from ..sites import load_sites

SLUG = "raqdps"
PATH = "model_raqdps/10km/grib2"
FILE_PREFIX = "MSC_RAQDPS"
GRID_TOKEN = "RLatLon0.09"
RUN_HOURS = ("12", "00")  # probed newest-first
FORECAST_HOURS = 72
FETCH_CONCURRENCY = 5  # same per-host Datamart budget as the other ECCC builders
# On the 10 km grid the nearest gridpoint is within ~7 km; anything farther
# means ecCodes clamped an out-of-domain site to the grid boundary.
MAX_NEAREST_KM = 15.0

# Document field → (Datamart variable token, conversion). The GRIB messages
# carry no units metadata, so the SI base units were established from live
# field statistics (verified 2026-08-09, 00Z run f001): surface fields max
# 1.4e-6 — kg/m³ (1445 µg/m³ inside that day's plume; a µg/m³ encoding
# would make the national maximum a femtogram); column max 1.2e-4 — kg/m²
# (123 mg/m², matching HRRR's COLMD magnitudes over the same event).
SMOKE_FIELDS = {
    "pm25Ugm3": ("PM2.5_Sfc", lambda v: v * 1e9),
    "smokePlumeSurfaceUgm3": ("PM2.5-WildfireSmokePlume_Sfc", lambda v: v * 1e9),
    "smokePlumeColumnMgm2": ("PM2.5-WildfireSmokePlume_EAtm", lambda v: v * 1e6),
}


def _out_dir() -> Path:
    return output_directory(SLUG)


def main() -> None:
    sites = load_sites()
    run = _latest_complete_run()
    if run is None:
        print("No complete RAQDPS run is available.")
        return
    date = run["date"]
    reference_time = f"{date[:4]}-{date[4:6]}-{date[6:]}T{run['hour']}:00:00Z"
    if published_reference_time(SLUG) == reference_time:
        print(f"RAQDPS run {reference_time} is already published.")
        return

    print(f"Building RAQDPS {reference_time} for {len(sites)} sites…")
    started_at = time.monotonic()
    stats = DownloadStats()
    result = _build_documents(run, reference_time, sites, stats)

    sites_dir = _out_dir() / "sites"
    sites_dir.mkdir(parents=True, exist_ok=True)
    for document in result["documents"]:
        rounded = round_document(document)
        write_json(sites_dir / f"{rounded['site']['id']}.json", rounded, compact=True)
        append_history(rounded, _out_dir() / "history")
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
        f"Published {len(result['documents'])} RAQDPS smoke documents for {reference_time} "
        f"({stats.requests} downloads, {stats.response_bytes // (1024 * 1024)} MiB)."
    )


def _latest_complete_run() -> dict | None:
    """A run is complete when its final forecast hour is on the Datamart."""
    now = datetime.now(timezone.utc)
    for day_offset in (0, 1):
        date = (now - timedelta(days=day_offset)).strftime("%Y%m%d")
        for hour in RUN_HOURS:
            if day_offset == 0 and int(hour) > now.hour:
                continue
            probe = _file_url(date, hour, FORECAST_HOURS, SMOKE_FIELDS["pm25Ugm3"][0])
            if exists(probe):
                return {"date": date, "hour": hour}
    return None


def _file_url(date: str, run_hour: str, forecast_hour: int, variable: str) -> str:
    name = f"{date}T{run_hour}Z_{FILE_PREFIX}_{variable}_{GRID_TOKEN}_PT{forecast_hour:03d}H.grib2"
    return f"{datamart_base()}/{date}/WXO-DD/{PATH}/{run_hour}/{forecast_hour:03d}/{name}"


def _build_documents(run: dict, reference_time: str, sites: list[dict], stats: DownloadStats):
    forecast_slots = [
        {"forecastHour": hour, "validAt": _valid_time(reference_time, hour)}
        for hour in range(1, FORECAST_HOURS + 1)
    ]
    forecast_slots = forecast_slots[: _max_steps()]

    def sample(variable: str, forecast_hour: int) -> dict[str, float | None]:
        """One whole-domain file: downloaded, sampled at the sites, and
        released before the caller moves on — never stored."""
        url = _file_url(run["date"], run["hour"], forecast_hour, variable)
        with GribField(fetch_bytes(url, stats)) as field:
            return {
                site["slug"]: field.value_at(site["latitude"], site["longitude"], MAX_NEAREST_KM)
                for site in sites
            }

    hours_by_site: dict[str, list[dict]] = {
        site["slug"]: [{"validAt": slot["validAt"]} for slot in forecast_slots] for site in sites
    }

    def field_task(hour_index: int, field_name: str, variable: str, convert):
        def run_task() -> None:
            values = sample(variable, forecast_slots[hour_index]["forecastHour"])
            for site in sites:
                value = values[site["slug"]]
                if value is None or not math.isfinite(value):
                    raise RuntimeError(f"Datamart returned no {field_name} for {site['name']}")
                # Concentrations are non-negative by definition; GRIB packing
                # noise can dip a clean field a hair below zero.
                hours_by_site[site["slug"]][hour_index][field_name] = max(0.0, convert(value))

        return run_task

    _run_concurrent(
        [
            field_task(hour_index, field_name, variable, convert)
            for hour_index in range(len(forecast_slots))
            for field_name, (variable, convert) in SMOKE_FIELDS.items()
        ]
    )

    generated_at = _document_instant()
    documents = [
        {
            "schemaVersion": SCHEMA_VERSION,
            "model": SLUG,
            "run": {"referenceTime": reference_time, "generatedAt": generated_at},
            "site": {
                "id": site["slug"],
                "name": site["name"],
                "latitude": site["latitude"],
                "longitude": site["longitude"],
                **({"timeZone": site["timeZone"]} if site.get("timeZone") else {}),
            },
            "hours": hours_by_site[site["slug"]],
        }
        for site in sites
    ]
    return {
        "firstForecastHour": forecast_slots[0]["forecastHour"],
        "forecastHours": len(forecast_slots),
        "lastForecastHour": forecast_slots[-1]["forecastHour"],
        "documents": documents,
    }


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


def _document_instant() -> str:
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

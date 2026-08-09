"""Generate one offline, model-shaped profile for the club publisher example."""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

from windgram.publish import round_document, write_json
from windgram.sites import load_sites
from windgram.windgram import derive_windgram_profile


MODEL = "synthetic-club-demo"
SEMANTICS = {"precipitation": "instantRate"}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate the provider-free club example as static JSON."
    )
    parser.add_argument("--sites", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser


def _forecast_hour(reference_time: str, valid_at: str) -> int:
    reference = datetime.fromisoformat(reference_time.replace("Z", "+00:00"))
    valid = datetime.fromisoformat(valid_at.replace("Z", "+00:00"))
    seconds = (valid - reference).total_seconds()
    if seconds < 0 or seconds % 3600:
        raise ValueError("synthetic validAt values must be whole hours after referenceTime")
    return int(seconds // 3600)


def main() -> int:
    arguments = _parser().parse_args()
    sites = load_sites(arguments.sites.resolve())
    if len(sites) != 1:
        raise ValueError("the club example requires exactly one configured launch")

    fixture = json.loads(arguments.source.resolve().read_text())
    if fixture.get("kind") != "synthetic":
        raise ValueError("the club example accepts only a source marked synthetic")
    if fixture.get("schemaVersion") != 1:
        raise ValueError("unsupported synthetic source schemaVersion")

    site = sites[0]
    source = {
        "referenceTime": fixture["referenceTime"],
        "generatedAt": fixture["generatedAt"],
        "siteId": site["slug"],
        "siteName": site["name"],
        "latitude": site["latitude"],
        "longitude": site["longitude"],
        "siteAltitudeM": site["elevationM"],
        "modelElevationM": fixture["modelElevationM"],
        "siteTimeZone": site["timeZone"],
        "hours": fixture["hours"],
    }
    profile = round_document(
        derive_windgram_profile(source, model=MODEL, semantics=SEMANTICS)
    )

    forecast_hours = [
        _forecast_hour(fixture["referenceTime"], hour["validAt"])
        for hour in fixture["hours"]
    ]
    model_directory = arguments.output.resolve() / MODEL
    sites_directory = model_directory / "sites"
    profile_path = sites_directory / f"{site['slug']}.json"
    manifest_path = model_directory / "manifest.json"
    sites_directory.mkdir(parents=True, exist_ok=True)
    write_json(profile_path, profile, compact=True)
    write_json(
        manifest_path,
        {
            "schemaVersion": 1,
            "model": MODEL,
            "referenceTime": fixture["referenceTime"],
            "generatedAt": fixture["generatedAt"],
            "firstForecastHour": forecast_hours[0],
            "lastForecastHour": forecast_hours[-1],
            "forecastHours": len(forecast_hours),
            "sites": [{"name": site["name"], "slug": site["slug"]}],
            "stats": {
                "downloads": 0,
                "downloadBytes": 0,
                "retries": 0,
                "durationMs": 0,
            },
        },
        compact=False,
    )
    print(f"generated {profile_path}")
    print(f"generated {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

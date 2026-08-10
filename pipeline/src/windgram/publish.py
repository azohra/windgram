"""Shared output writing: the contract's rounding table, profile JSON,
manifests, the cross-model run index, and gzipped run history."""

from __future__ import annotations

import gzip
import json
import time
from pathlib import Path

from .dataset import published_history, published_manifest

# The spec's rounding table, field name → decimal places, applied at the
# serialization edge so published JSON carries no float64 noise. Wind
# direction is handled separately (integer degrees, normalized 0–359);
# latitude/longitude are absent deliberately — they publish verbatim.
_FIELD_DECIMALS = {
    "altitudeM": 1,
    "aot": 3,
    "boundaryLayerTopM": 1,
    "capeJkg": 0,
    "cinJkg": 0,
    "cloudBaseM": 1,
    "cloudCoverPercent": 1,
    "cloudFractionPercent": 1,
    "columnMgm2": 1,
    "dewPointC": 2,
    "downwardShortwaveWm2": 1,
    "heightM": 1,
    "highCloudPercent": 1,
    "latentHeatFluxWm2": 1,
    "lowCloudPercent": 1,
    "midCloudPercent": 1,
    "modelElevationM": 1,
    "pblHeightM": 1,
    "pm25Ugm3": 1,
    "precipitationMmHr": 2,
    "pressurePa": 0,
    "sensibleHeatFluxWm2": 1,
    "smokePlumeColumnMgm2": 1,
    "smokePlumeSurfaceUgm3": 1,
    "surfaceUgm3": 1,
    "temperatureC": 2,
    "thermalVelocityMs": 2,
    "usableLiftTopM": 1,
    "verticalVelocityPaS": 3,
    "windGustMs": 2,
    "windSpeedMs": 2,
}


def round_document(value, decimals: int | None = None):
    """Rounds a published document per the rounding table, keyed by field name.

    A percentile object sitting in a scalar position inherits that position's
    precision for its p-values (members and ceiledMembers are integers and
    pass through untouched); unlisted fields publish verbatim.
    """
    if isinstance(value, dict):
        return {
            key: (
                _rounded_degrees(item)
                if key == "windDirectionDeg"
                else round_document(item, _FIELD_DECIMALS.get(key, decimals))
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [round_document(item, decimals) for item in value]
    if isinstance(value, float) and decimals is not None:
        return round(value, decimals) if decimals else round(value)
    return value


def _rounded_degrees(value: float | None):
    """Integer degrees in met convention, wrapped so 359.7 rounds to 0."""
    if value is None:
        return None
    return round(value) % 360


def append_history(profile: dict, history_dir: Path) -> None:
    """Archives the profile under <history_dir>/<slug>/<YYYY-MM>.jsonl.gz,
    the month taken from the run's referenceTime.

    The scratch output tree starts empty, so an archive's first touch in a
    build seeds it with the published month's bytes (an unpublished month —
    the site's first run of the month — seeds empty). Each run is then
    appended as an independent gzip member: existing bytes are never
    rewritten, and any gzip reader sees one JSON line per model run.
    """
    month = profile["run"]["referenceTime"][:7]
    directory = history_dir / profile["site"]["id"]
    directory.mkdir(parents=True, exist_ok=True)
    archive_path = directory / f"{month}.jsonl.gz"
    if not archive_path.exists():
        archive_path.write_bytes(
            published_history(profile["model"], profile["site"]["id"], month)
        )
    line = compact_json(profile) + "\n"
    with archive_path.open("ab") as archive:
        archive.write(gzip.compress(line.encode()))


def manifest_stats(download_stats, started_at_monotonic: float) -> dict:
    """The manifest's stats block: a stable four-key core shared by every
    builder — downloads, downloadBytes, retries, durationMs. Anything a
    builder publishes beyond these keys is unstable and may change."""
    return {
        "downloadBytes": download_stats.response_bytes,
        "downloads": download_stats.requests,
        "durationMs": round((time.monotonic() - started_at_monotonic) * 1000),
        "retries": download_stats.retries,
    }


def runs_index(model_slugs: list[str]) -> dict:
    """The cross-model run index runs.json: per published model, the
    manifest's (referenceTime, generatedAt) pair — regenerated wholesale
    from the published manifests, so the index is a pure function of the
    dataset it describes and concurrent upload lanes converge on whoever
    writes last. A model that has never published is simply absent."""
    runs = {}
    for slug in model_slugs:
        manifest = published_manifest(slug)
        if manifest is None:
            continue
        runs[manifest["model"]] = {
            "referenceTime": manifest["referenceTime"],
            "generatedAt": manifest["generatedAt"],
        }
    return {"schemaVersion": 1, "runs": runs}


def catalogued_model_slugs(models_path: Path = Path("models.json")) -> list[str]:
    """Every published dataset the catalogue declares, for the runs index:
    profile models plus the smoke and observation datasets — a freshness
    index that skipped the non-profile kinds would hide exactly the feeds
    whose staleness matters most (observations judge lateness against
    cadence, smoke against its runs)."""
    catalogue = json.loads(models_path.read_text())
    return [
        entry["slug"]
        for key in ("models", "smokeModels", "observationModels")
        for entry in catalogue.get(key, [])
    ]


def write_runs_index(
    path: Path = Path("data/runs.json"), models_path: Path = Path("models.json")
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    write_json(path, runs_index(catalogued_model_slugs(models_path)), compact=False)


def compact_json(value: dict) -> str:
    return json.dumps(_integral_floats_to_ints(value), allow_nan=False, separators=(",", ":"))


def write_json(path: Path, value: dict, *, compact: bool) -> None:
    if compact:
        text = compact_json(value)
    else:
        text = json.dumps(_integral_floats_to_ints(value), allow_nan=False, indent=2)
    path.write_text(text + "\n")


def _integral_floats_to_ints(value):
    """Matches the original serialisation: JavaScript prints 5.0 as 5."""
    if isinstance(value, float) and value.is_integer() and abs(value) < 2**53:
        return int(value)
    if isinstance(value, list):
        return [_integral_floats_to_ints(item) for item in value]
    if isinstance(value, dict):
        return {key: _integral_floats_to_ints(item) for key, item in value.items()}
    return value

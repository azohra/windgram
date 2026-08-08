"""Shared output writing: the contract's rounding table, profile JSON,
manifests, and gzipped run history."""

from __future__ import annotations

import gzip
import json
from pathlib import Path

# The spec's rounding table, field name → decimal places, applied at the
# serialization edge so published JSON carries no float64 noise. Wind
# direction is handled separately (integer degrees, normalized 0–359);
# latitude/longitude are absent deliberately — they publish verbatim.
_FIELD_DECIMALS = {
    "altitudeM": 1,
    "boundaryLayerTopM": 1,
    "capeJkg": 0,
    "cinJkg": 0,
    "cloudBaseM": 1,
    "cloudCoverPercent": 1,
    "cloudFractionPercent": 1,
    "dewPointC": 2,
    "heightM": 1,
    "highCloudPercent": 1,
    "latentHeatFluxWm2": 1,
    "lowCloudPercent": 1,
    "midCloudPercent": 1,
    "modelElevationM": 1,
    "pblHeightM": 1,
    "precipitationMmHr": 2,
    "pressurePa": 0,
    "sensibleHeatFluxWm2": 1,
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
    """Archives the profile under <history_dir>/<slug>/<year>.jsonl.gz.

    Each run is appended as an independent gzip member, so existing bytes are
    never rewritten and any gzip reader sees one JSON line per model run.
    """
    year = profile["run"]["referenceTime"][:4]
    directory = history_dir / profile["site"]["id"]
    directory.mkdir(parents=True, exist_ok=True)
    line = compact_json(profile) + "\n"
    with (directory / f"{year}.jsonl.gz").open("ab") as archive:
        archive.write(gzip.compress(line.encode()))


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

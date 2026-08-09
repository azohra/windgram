import json
import time
from pathlib import Path

from windgram.publish import (
    compact_json,
    manifest_stats,
    round_document,
    runs_index,
    write_runs_index,
)


def test_rounds_each_quantity_to_its_schema_precision():
    hour = {
        "validAt": "2026-08-08T21:00:00Z",
        "surface": {
            "pressurePa": 101071.4432,
            "temperatureC": 28.276543,
            "dewPointC": 4.716999,
            "windSpeedMs": 1.4712999,
            "windDirectionDeg": 245.5401,
            "cloudCoverPercent": 9.2299,
            "precipitationMmHr": 0.1234,
            "sensibleHeatFluxWm2": 310.4499,
            "latentHeatFluxWm2": 95.1111,
        },
        "levels": [{"heightM": 1252.4432, "verticalVelocityPaS": -0.31047}],
        "derived": {
            "boundaryLayerTopM": 3223.1258376951764,
            "thermalVelocityMs": 1.6349,
            "cloudBaseM": 4145.06,
            "usableLiftTopM": None,
        },
    }

    rounded = round_document(hour)

    assert rounded["validAt"] == "2026-08-08T21:00:00Z"
    assert rounded["surface"] == {
        "pressurePa": 101071,
        "temperatureC": 28.28,
        "dewPointC": 4.72,
        "windSpeedMs": 1.47,
        "windDirectionDeg": 246,
        "cloudCoverPercent": 9.2,
        "precipitationMmHr": 0.12,
        "sensibleHeatFluxWm2": 310.4,
        "latentHeatFluxWm2": 95.1,
    }
    assert rounded["levels"] == [{"heightM": 1252.4, "verticalVelocityPaS": -0.31}]
    assert rounded["derived"] == {
        "boundaryLayerTopM": 3223.1,
        "thermalVelocityMs": 1.63,
        "cloudBaseM": 4145.1,
        "usableLiftTopM": None,
    }


def test_science_fields_round_to_their_schema_precision():
    rounded = round_document(
        {
            "surface": {
                "windGustMs": 11.4372,
                "capeJkg": 851.4999,
                "cinJkg": -55.501,
                "pblHeightM": 1650.4444,
                "lowCloudPercent": 62.049,
                "midCloudPercent": 17.96,
                "highCloudPercent": 4.04,
            },
            "levels": [{"cloudFractionPercent": 84.9601}],
        }
    )

    assert rounded["surface"] == {
        "windGustMs": 11.44,
        "capeJkg": 851,  # whole J/kg
        "cinJkg": -56,
        "pblHeightM": 1650.4,
        "lowCloudPercent": 62.0,
        "midCloudPercent": 18.0,
        "highCloudPercent": 4.0,
    }
    assert rounded["levels"] == [{"cloudFractionPercent": 85.0}]


def test_wind_directions_round_to_integers_wrapped_at_north():
    assert round_document({"windDirectionDeg": 359.7}) == {"windDirectionDeg": 0}
    assert round_document({"windDirectionDeg": 0.2}) == {"windDirectionDeg": 0}
    assert round_document({"windDirectionDeg": None}) == {"windDirectionDeg": None}


def test_percentile_blocks_inherit_the_precision_of_their_position():
    document = {
        "derived": {
            "usableLiftTopM": {
                "ceiledMembers": 2,
                "members": 21,
                "p10": None,
                "p25": 3222.33333,
                "p50": 3585.0001,
                "p75": 3822.28,
                "p90": 4101.96,
            }
        }
    }

    rounded = round_document(document)

    assert rounded["derived"]["usableLiftTopM"] == {
        "ceiledMembers": 2,
        "members": 21,
        "p10": None,
        "p25": 3222.3,
        "p50": 3585.0,
        "p75": 3822.3,
        "p90": 4102.0,
    }


def test_coordinates_and_unlisted_fields_pass_through_verbatim():
    site = {
        "id": "dundee",
        "latitude": 49.291977,
        "longitude": -117.183569,
        "altitudeM": 1485.04,
    }

    assert round_document({"site": site}) == {"site": {**site, "altitudeM": 1485.0}}


def test_rounded_values_serialize_without_float_noise():
    document = {"derived": {"boundaryLayerTopM": 3223.1258376951764}}

    assert compact_json(round_document(document)) == '{"derived":{"boundaryLayerTopM":3223.1}}'


class FakeDownloadStats:
    requests = 421
    response_bytes = 9_000_000
    retries = 3


def test_manifest_stats_publishes_exactly_the_stable_core():
    stats = manifest_stats(FakeDownloadStats(), time.monotonic() - 1.0)

    assert list(stats) == ["downloadBytes", "downloads", "durationMs", "retries"]
    assert stats["downloadBytes"] == 9_000_000
    assert stats["downloads"] == 421
    assert stats["retries"] == 3
    assert stats["durationMs"] >= 1000


def test_every_builder_publishes_stats_through_the_shared_core():
    # The stable core is standardized by construction: each builder's
    # manifest goes through manifest_stats, and no builder keeps a private
    # spelling like the old downloadRetries.
    builders = (
        "eccc.py",
        "gfs.py",
        "geps.py",
        "hrdps_west.py",
        "hrrr.py",
        "nam.py",
        "reps.py",
    )
    for name in builders:
        source = (Path(__file__).resolve().parents[1] / "src" / "windgram" / "builders" / name).read_text()
        assert "manifest_stats(" in source, name
        assert "downloadRetries" not in source, name


def manifest(model: str, reference_time: str, generated_at: str) -> dict:
    return {
        "model": model,
        "referenceTime": reference_time,
        "generatedAt": generated_at,
        "schemaVersion": 1,
        "stats": {"downloads": 1},
    }


def test_runs_index_maps_each_on_disk_manifest_to_its_publication_identity(tmp_path):
    for model, reference_time, generated_at in (
        ("gfs", "2026-08-08T06:00:00Z", "2026-08-08T12:10:00Z"),
        ("hrdps-continental", "2026-08-08T12:00:00Z", "2026-08-08T16:40:00Z"),
    ):
        directory = tmp_path / model
        directory.mkdir()
        (directory / "manifest.json").write_text(
            json.dumps(manifest(model, reference_time, generated_at))
        )
    (tmp_path / "models.json").write_text("{}")  # not a manifest: ignored

    index = runs_index(tmp_path)

    assert index == {
        "schemaVersion": 1,
        "runs": {
            "gfs": {
                "referenceTime": "2026-08-08T06:00:00Z",
                "generatedAt": "2026-08-08T12:10:00Z",
            },
            "hrdps-continental": {
                "referenceTime": "2026-08-08T12:00:00Z",
                "generatedAt": "2026-08-08T16:40:00Z",
            },
        },
    }


def test_write_runs_index_regenerates_the_index_wholesale(tmp_path):
    directory = tmp_path / "reps"
    directory.mkdir()
    (directory / "manifest.json").write_text(
        json.dumps(manifest("reps", "2026-08-08T00:00:00Z", "2026-08-08T03:05:00Z"))
    )
    (tmp_path / "runs.json").write_text('{"schemaVersion":1,"runs":{"stale":{}}}')

    write_runs_index(tmp_path)

    index = json.loads((tmp_path / "runs.json").read_text())
    assert list(index["runs"]) == ["reps"]
    assert index["runs"]["reps"]["referenceTime"] == "2026-08-08T00:00:00Z"

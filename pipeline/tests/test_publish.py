import inspect
import json
import time

from windgram import publish
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


def manifest(model: str, reference_time: str, generated_at: str) -> dict:
    return {
        "model": model,
        "referenceTime": reference_time,
        "generatedAt": generated_at,
        "schemaVersion": 1,
        "stats": {"downloads": 1},
    }


def publish_manifests(monkeypatch, manifests: dict) -> None:
    monkeypatch.setattr(publish, "published_manifest", lambda slug: manifests.get(slug))


def test_runs_index_maps_each_published_manifest_to_its_publication_identity(monkeypatch):
    publish_manifests(
        monkeypatch,
        {
            "gfs": manifest("gfs", "2026-08-08T06:00:00Z", "2026-08-08T12:10:00Z"),
            "hrdps-continental": manifest(
                "hrdps-continental", "2026-08-08T12:00:00Z", "2026-08-08T16:40:00Z"
            ),
        },
    )

    # geps has never published: absent from the index, never an error.
    index = runs_index(["gfs", "hrdps-continental", "geps"])

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


def test_write_runs_index_regenerates_the_index_wholesale(tmp_path, monkeypatch):
    publish_manifests(
        monkeypatch,
        {"reps": manifest("reps", "2026-08-08T00:00:00Z", "2026-08-08T03:05:00Z")},
    )
    models = tmp_path / "models.json"
    models.write_text(json.dumps({"models": [{"slug": "reps"}, {"slug": "geps"}]}))
    path = tmp_path / "data" / "runs.json"

    write_runs_index(path, models)

    index = json.loads(path.read_text())
    assert list(index["runs"]) == ["reps"]
    assert index["runs"]["reps"]["referenceTime"] == "2026-08-08T00:00:00Z"


def test_write_runs_index_defaults_read_the_root_catalogue_and_write_the_scratch_tree():
    # The upload workflow calls write_runs_index() bare from the checkout
    # root; these defaults are that call's contract.
    signature = inspect.signature(write_runs_index)
    assert str(signature.parameters["path"].default) == "data/runs.json"
    assert str(signature.parameters["models_path"].default) == "models.json"

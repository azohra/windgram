import gzip
import json
from pathlib import Path

import numpy
import pytest
from jsonschema import Draft202012Validator

from windgram import publish
from windgram.builders import goes

# The probe-verified fixed-grid coordinate axes (2026-08-10, live granule):
# int16 scan angles scaled by ±5.6e-05 rad with offsets ∓0.151844, x
# ascending west→east, y descending north→south, 5424 points each — the
# identical grid on the DSRF and AODF granules (side-by-side dump).
GRID_STEP_RAD = 5.6e-05
GRID_OFFSET_RAD = 0.151844
GRID_POINTS = 5424


class _FakeVariable:
    """Stands in for a netCDF4 variable: attribute access plus slicing."""

    def __init__(self, values=None, **attributes):
        self._values = values
        for name, value in attributes.items():
            setattr(self, name, value)

    def __getitem__(self, item):
        return self._values[item]


class _FakeGranule:
    def __init__(self):
        x = -GRID_OFFSET_RAD + numpy.arange(GRID_POINTS) * GRID_STEP_RAD
        y = GRID_OFFSET_RAD - numpy.arange(GRID_POINTS) * GRID_STEP_RAD
        self._variables = {
            "x": _FakeVariable(values=x),
            "y": _FakeVariable(values=y),
            # The live granule's own projection attributes [verified 2026-08-10].
            "goes_imager_projection": _FakeVariable(
                perspective_point_height=35786023.0,
                semi_major_axis=6378137.0,
                semi_minor_axis=6356752.31414,
                longitude_of_projection_origin=-137.0,
            ),
        }

    def __getitem__(self, name):
        return self._variables[name]


# --------------------------------------------------------- product table


def test_models_json_matches_the_goes_builder_configuration():
    catalogue = json.loads(Path("models.json").read_text())
    entries = {entry["slug"]: entry for entry in catalogue["observationModels"]}

    # Catalogue and builder declare the same datasets, nothing more.
    assert set(entries) == set(goes.PRODUCTS) == {"goes18-dsr", "goes18-aod"}
    for slug, product in goes.PRODUCTS.items():
        entry = entries[slug]
        assert product.slug == slug
        assert entry["provider"] == "NOAA"
        # 10-minute full-disk cadence, verified live 2026-08-10 — six
        # granules per hour directory for BOTH products, not the hourly
        # cadence older DSR docs imply.
        assert entry["cadenceMinutes"] == 10
        # Effective at-site cell (~2.4 × 4.1 km at 49°N view angle), not
        # the 2 km nadir nominal; the AODF granule rides the same grid.
        assert entry["gridKm"] == 3
        assert entry["experimental"] is True

    assert goes.PRODUCTS["goes18-dsr"].prefix == "ABI-L2-DSRF"
    assert goes.PRODUCTS["goes18-dsr"].variable == "DSR"
    assert goes.PRODUCTS["goes18-dsr"].value_key == "downwardShortwaveWm2"
    # DSR: DQF must be exactly 0 (fill pixels carry DQF 0, so unmasked AND).
    assert goes.PRODUCTS["goes18-dsr"].max_quality == 0
    assert goes.PRODUCTS["goes18-aod"].prefix == "ABI-L2-AODF"
    assert goes.PRODUCTS["goes18-aod"].variable == "AOD"
    assert goes.PRODUCTS["goes18-aod"].value_key == "aot"
    # AOD: high + medium quality (Zhang, Kondragunta et al. 2020).
    assert goes.PRODUCTS["goes18-aod"].max_quality == 1


def test_the_published_aot_rounds_to_three_decimals_in_the_contract_table():
    assert publish._FIELD_DECIMALS["aot"] == 3


# -------------------------------------------------------- site navigation


def test_site_indices_match_the_live_probe():
    # Ground truth measured against a real granule on 2026-08-10: the PUG
    # forward equations put the founding sites on these exact pixels.
    granule = _FakeGranule()
    expected = {
        "dundee": (476, 3366, 49.291977, -117.183569),
        "erie": (479, 3360, 49.204789, -117.406951),
        "flagpole": (470, 3359, 49.507695, -117.310423),
        "red-mountain": (481, 3349, 49.091868, -117.820838),
    }
    for name, (y_index, x_index, latitude, longitude) in expected.items():
        site = {"name": name, "latitude": latitude, "longitude": longitude}
        assert goes._site_index(granule, site) == (y_index, x_index)


def test_site_index_refuses_points_off_the_disk():
    granule = _FakeGranule()
    with pytest.raises(RuntimeError, match="outside the GOES-18 full-disk grid"):
        # The antipode of the satellite longitude is behind the earth.
        goes._site_index(granule, {"name": "antipode", "latitude": 0.0, "longitude": 43.0})


def test_scan_key_stamps_parse_to_utc_instants():
    stamp = goes._KEY_STAMP.search(
        "ABI-L2-DSRF/2026/222/05/OR_ABI-L2-DSRF-M6_G18_s20262220500213_e20262220509522_c20262220515340.nc"
    )
    assert goes._stamp_to_datetime(stamp).isoformat() == "2026-08-10T05:00:21+00:00"
    # The AODF keys carry the identical stamp grammar (live listing).
    stamp = goes._KEY_STAMP.search(
        "ABI-L2-AODF/2026/222/06/OR_ABI-L2-AODF-M6_G18_s20262220600214_e20262220609522_c20262220612547.nc"
    )
    assert goes._stamp_to_datetime(stamp).isoformat() == "2026-08-10T06:00:21+00:00"


# ------------------------------------------------------ window and history


def test_merged_window_deduplicates_and_trims(monkeypatch):
    published = {
        "observations": [
            {"observedAt": "2026-08-05T20:00:21Z", "downwardShortwaveWm2": 500.0},
            {"observedAt": "2026-08-09T20:00:21Z", "downwardShortwaveWm2": 610.0},
            {"observedAt": "2026-08-09T20:10:21Z", "downwardShortwaveWm2": 600.0},
        ]
    }
    monkeypatch.setattr(goes, "fetch_published", lambda path: json.dumps(published).encode())

    merged, newly_added = goes._merged_window(
        goes.PRODUCTS["goes18-dsr"],
        "dundee",
        [
            # A re-fetched instant replaces its published twin, never doubles.
            {"observedAt": "2026-08-09T20:10:21Z", "downwardShortwaveWm2": 601.5},
            {"observedAt": "2026-08-09T22:00:21Z", "downwardShortwaveWm2": 580.0},
        ],
    )

    assert [entry["observedAt"] for entry in merged] == [
        # The 08-05 instant fell out of the 72 h window behind the newest.
        "2026-08-09T20:00:21Z",
        "2026-08-09T20:10:21Z",
        "2026-08-09T22:00:21Z",
    ]
    assert merged[1]["downwardShortwaveWm2"] == 601.5
    # The re-fetched instant is NOT new to the window — only 22:00 is.
    assert [entry["observedAt"] for entry in newly_added] == ["2026-08-09T22:00:21Z"]


def test_merged_window_starts_empty_for_a_new_site(monkeypatch):
    monkeypatch.setattr(goes, "fetch_published", lambda path: None)
    assert goes._merged_window(goes.PRODUCTS["goes18-dsr"], "dundee", []) == ([], [])


def _archived_lines(archive: Path) -> list[dict]:
    with gzip.open(archive, "rt") as handle:
        return [json.loads(line) for line in handle]


def test_history_archives_each_instant_exactly_once(tmp_path, monkeypatch):
    """A re-listed or backfilled batch must append nothing it already
    archived: the merge's newly-added set is the single source of truth."""
    monkeypatch.setattr(publish, "published_history", lambda model, site, month: b"")
    product = goes.PRODUCTS["goes18-aod"]
    published = {"observations": [{"observedAt": "2026-08-09T20:00:21Z", "aot": 1.934}]}
    monkeypatch.setattr(goes, "fetch_published", lambda path: json.dumps(published).encode())
    batch = [
        {"observedAt": "2026-08-09T20:00:21Z", "aot": 1.9336401224136353},  # re-listed
        {"observedAt": "2026-08-09T20:10:21Z", "aot": 2.9061758518218994},
    ]
    history_dir = tmp_path / "history"

    window, newly_added = goes._merged_window(product, "dundee", batch)
    goes._append_history(product, "dundee", newly_added, history_dir)

    archive = history_dir / "dundee" / "2026-08.jsonl.gz"
    # Only the genuinely new instant landed, rounded exactly as published.
    assert _archived_lines(archive) == [{"observedAt": "2026-08-09T20:10:21Z", "aot": 2.906}]

    # The next tick re-lists the same granules against the grown window:
    # nothing is new, and the archive's bytes do not move.
    published["observations"] = window
    before = archive.read_bytes()
    _, newly_added = goes._merged_window(product, "dundee", batch)
    assert newly_added == []
    goes._append_history(product, "dundee", newly_added, history_dir)
    assert archive.read_bytes() == before


def test_history_months_follow_the_observation_instant_not_the_run(tmp_path, monkeypatch):
    monkeypatch.setattr(publish, "published_history", lambda model, site, month: b"")
    monkeypatch.setattr(goes, "fetch_published", lambda path: None)
    product = goes.PRODUCTS["goes18-dsr"]
    batch = [
        {"observedAt": "2026-08-31T23:50:21Z", "downwardShortwaveWm2": 12.34},
        {"observedAt": "2026-09-01T00:00:21Z", "downwardShortwaveWm2": 11.06},
    ]
    history_dir = tmp_path / "history"

    _, newly_added = goes._merged_window(product, "dundee", batch)
    goes._append_history(product, "dundee", newly_added, history_dir)

    # One granule either side of midnight: each instant in its own month.
    assert _archived_lines(history_dir / "dundee" / "2026-08.jsonl.gz") == [
        {"observedAt": "2026-08-31T23:50:21Z", "downwardShortwaveWm2": 12.3}
    ]
    assert _archived_lines(history_dir / "dundee" / "2026-09.jsonl.gz") == [
        {"observedAt": "2026-09-01T00:00:21Z", "downwardShortwaveWm2": 11.1}
    ]


# ------------------------------------------------------- document contract


def _observation_validator() -> Draft202012Validator:
    return Draft202012Validator(
        json.loads(Path("toolkit/schema/observation.schema.json").read_text())
    )


def test_a_built_aod_document_validates_against_the_observation_schema():
    site = {
        "slug": "dundee",
        "name": "Dundee",
        "latitude": 49.291977,
        "longitude": -117.183569,
        "timeZone": "America/Vancouver",
    }
    observations = [
        {"observedAt": "2026-08-09T20:00:21Z", "aot": 1.9336401224136353},
        {"observedAt": "2026-08-09T20:10:21Z", "aot": 2.9061758518218994},
    ]
    document = goes._site_document(
        goes.PRODUCTS["goes18-aod"], site, observations, "2026-08-09T20:18:03Z"
    )

    validator = _observation_validator()
    validator.validate(document)
    # The contract's rounding table: aot publishes at 3 decimals.
    assert [entry["aot"] for entry in document["observations"]] == [1.934, 2.906]

    # Sensitivity: the observations[] union really constrains the value
    # key — a misnamed field is rejected, not waved through.
    wrong = json.loads(json.dumps(document))
    wrong["observations"][0] = {"observedAt": "2026-08-09T20:00:21Z", "aod": 1.934}
    assert not validator.is_valid(wrong)


def test_a_built_dsr_document_still_validates_against_the_observation_schema():
    site = {"slug": "erie", "name": "Erie", "latitude": 49.204789, "longitude": -117.406951}
    observations = [{"observedAt": "2026-08-09T20:00:21Z", "downwardShortwaveWm2": 611.13}]
    document = goes._site_document(
        goes.PRODUCTS["goes18-dsr"], site, observations, "2026-08-09T20:18:03Z"
    )

    validator = _observation_validator()
    validator.validate(document)
    assert document["observations"][0]["downwardShortwaveWm2"] == 611.1

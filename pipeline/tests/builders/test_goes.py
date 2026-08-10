import json
import re
from pathlib import Path

import numpy
import pytest

from windgram.builders import goes

# The probe-verified fixed-grid coordinate axes (2026-08-10, live granule):
# int16 scan angles scaled by ±5.6e-05 rad with offsets ∓0.151844, x
# ascending west→east, y descending north→south, 5424 points each.
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


def test_models_json_matches_the_goes_builder_configuration():
    catalogue = json.loads(Path("models.json").read_text())
    (entry,) = catalogue["observationModels"]

    assert entry["slug"] == goes.SLUG == "goes18-dsr"
    assert entry["provider"] == "NOAA"
    # 10-minute full-disk cadence, verified live 2026-08-10 — six granules
    # per hour directory, not the hourly cadence older DSR docs imply.
    assert entry["cadenceMinutes"] == 10
    # Effective at-site cell (~2.4 × 4.1 km at 49°N view angle), not the
    # 2 km nadir nominal.
    assert entry["gridKm"] == 3


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


def test_merged_window_deduplicates_and_trims(monkeypatch):
    published = {
        "observations": [
            {"observedAt": "2026-08-05T20:00:21Z", "downwardShortwaveWm2": 500.0},
            {"observedAt": "2026-08-09T20:00:21Z", "downwardShortwaveWm2": 610.0},
            {"observedAt": "2026-08-09T20:10:21Z", "downwardShortwaveWm2": 600.0},
        ]
    }
    monkeypatch.setattr(goes, "fetch_published", lambda path: json.dumps(published).encode())

    merged = goes._merged_window(
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


def test_merged_window_starts_empty_for_a_new_site(monkeypatch):
    monkeypatch.setattr(goes, "fetch_published", lambda path: None)
    assert goes._merged_window("dundee", []) == []

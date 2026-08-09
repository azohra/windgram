import json
from pathlib import Path

import pytest

from windgram.sites import load_sites

SITE = {
    "slug": "dundee",
    "name": "Dundee",
    "latitude": 49.291977,
    "longitude": -117.183569,
    "elevationM": 1485,
}


def test_loads_the_sites_out_of_the_versioned_envelope(tmp_path):
    path = tmp_path / "sites.json"
    path.write_text(json.dumps({"schemaVersion": 1, "sites": [SITE]}))

    assert load_sites(path) == [SITE]


def test_rejects_a_schema_version_this_pipeline_does_not_speak(tmp_path):
    path = tmp_path / "sites.json"
    path.write_text(json.dumps({"schemaVersion": 2, "sites": [SITE]}))

    with pytest.raises(RuntimeError, match="schemaVersion"):
        load_sites(path)


def test_rejects_the_old_bare_array_shape(tmp_path):
    path = tmp_path / "sites.json"
    path.write_text(json.dumps([SITE]))

    with pytest.raises(RuntimeError, match="schemaVersion"):
        load_sites(path)


def test_rejects_an_empty_catalogue(tmp_path):
    path = tmp_path / "sites.json"
    path.write_text(json.dumps({"schemaVersion": 1, "sites": []}))

    with pytest.raises(RuntimeError, match="no sites"):
        load_sites(path)


def test_the_repository_catalogue_loads_with_every_field_a_builder_samples():
    sites = load_sites(Path("sites.json"))

    assert sites, "the repository catalogue must list at least one site"
    for site in sites:
        assert {"slug", "name", "latitude", "longitude", "elevationM"} <= set(site)

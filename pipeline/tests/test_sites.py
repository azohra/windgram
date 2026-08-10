import json
from pathlib import Path

import pytest

from windgram.sites import load_sites

SITE = {
    "slug": "dundee",
    "name": "Dundee",
    "latitude": 49.291977,
    "longitude": -117.183569,
    "timeZone": "America/Vancouver",
}


def write_catalogue(tmp_path, sites, version=2):
    path = tmp_path / "sites.json"
    path.write_text(json.dumps({"schemaVersion": version, "sites": sites}))
    return path


def test_loads_the_sites_out_of_the_versioned_envelope(tmp_path):
    path = write_catalogue(tmp_path, [SITE])

    assert load_sites(path) == [SITE]


def test_rejects_a_schema_version_this_pipeline_does_not_speak(tmp_path):
    path = write_catalogue(tmp_path, [SITE], version=1)

    with pytest.raises(RuntimeError, match="schemaVersion"):
        load_sites(path)


def test_rejects_the_old_bare_array_shape(tmp_path):
    path = tmp_path / "sites.json"
    path.write_text(json.dumps([SITE]))

    with pytest.raises(RuntimeError, match="schemaVersion"):
        load_sites(path)


def test_rejects_an_empty_catalogue(tmp_path):
    path = write_catalogue(tmp_path, [])

    with pytest.raises(RuntimeError, match="no sites"):
        load_sites(path)


def test_rejects_a_typed_in_elevation_and_points_at_the_context(tmp_path):
    # An elevationM in the catalogue means someone hasn't absorbed the
    # launch decoupling: the message must direct them to the measured home,
    # not merely reject the field.
    path = write_catalogue(tmp_path, [{**SITE, "elevationM": 1485}])

    with pytest.raises(RuntimeError, match="site-context.json") as raised:
        load_sites(path)
    assert "windgram terrain" in str(raised.value)
    assert "'dundee'" in str(raised.value)


def test_rejects_a_site_missing_identity_fields(tmp_path):
    incomplete = {key: value for key, value in SITE.items() if key != "timeZone"}
    path = write_catalogue(tmp_path, [incomplete])

    with pytest.raises(RuntimeError, match="missing timeZone"):
        load_sites(path)


def test_rejects_fields_outside_the_identity_vocabulary(tmp_path):
    path = write_catalogue(tmp_path, [{**SITE, "what3words": "filled.count.soap"}])

    with pytest.raises(RuntimeError, match="unknown fields what3words"):
        load_sites(path)


def test_the_repository_catalogue_loads_with_every_field_a_builder_samples():
    sites = load_sites(Path("sites.json"))

    assert sites, "the repository catalogue must list at least one site"
    for site in sites:
        assert set(site) == {"slug", "name", "latitude", "longitude", "timeZone"}

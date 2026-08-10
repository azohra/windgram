import json
from pathlib import Path

import pytest

from windgram.sites import load_site_context, load_sites, load_sites_input

SITE = {
    "slug": "dundee",
    "name": "Dundee",
    "latitude": 49.291977,
    "longitude": -117.183569,
    "what3words": "filled.count.soap",
    "timeZone": "America/Vancouver",
}

CONTEXT = {
    "schemaVersion": 2,
    "generatedAt": "2026-08-10T08:00:00Z",
    "sources": [],
    "sites": {"dundee": {"elevation": {"source": "lidarbc", "elevationM": 1476.4}}},
}


def write_catalogue(tmp_path, site=SITE, context=CONTEXT) -> Path:
    path = tmp_path / "sites.json"
    path.write_text(json.dumps({"schemaVersion": 2, "sites": [site]}))
    (tmp_path / "site-context.json").write_text(json.dumps(context))
    return path


def test_join_gives_every_site_the_context_elevation(tmp_path):
    path = write_catalogue(tmp_path)

    sites = load_sites(path)

    # Identity verbatim — what3words included — plus the derived elevation.
    assert sites == [{**SITE, "elevationM": 1476.4}]


def test_what3words_stays_optional(tmp_path):
    site = {key: value for key, value in SITE.items() if key != "what3words"}
    path = write_catalogue(tmp_path, site=site)

    (loaded,) = load_sites(path)
    assert "what3words" not in loaded
    assert loaded["elevationM"] == 1476.4


def test_an_explicit_context_path_overrides_the_sibling_default(tmp_path):
    path = tmp_path / "sites.json"
    path.write_text(json.dumps({"schemaVersion": 2, "sites": [SITE]}))
    elsewhere = tmp_path / "derived" / "site-context.json"
    elsewhere.parent.mkdir()
    elsewhere.write_text(
        json.dumps(
            {
                **CONTEXT,
                "sites": {"dundee": {"elevation": {"source": "mrdem30", "elevationM": 1480.2}}},
            }
        )
    )

    (loaded,) = load_sites(path, context_path=elsewhere)
    assert loaded["elevationM"] == 1480.2


def test_rejects_a_schema_version_this_pipeline_does_not_speak(tmp_path):
    # v1 catalogues carried a hand-estimated elevationM; the version check
    # is what turns them away before any elevation could be trusted.
    path = tmp_path / "sites.json"
    path.write_text(
        json.dumps({"schemaVersion": 1, "sites": [{**SITE, "elevationM": 1485}]})
    )

    with pytest.raises(RuntimeError, match="schemaVersion"):
        load_sites(path)


def test_rejects_the_old_bare_array_shape(tmp_path):
    path = tmp_path / "sites.json"
    path.write_text(json.dumps([SITE]))

    with pytest.raises(RuntimeError, match="schemaVersion"):
        load_sites(path)


def test_rejects_an_empty_catalogue(tmp_path):
    path = tmp_path / "sites.json"
    path.write_text(json.dumps({"schemaVersion": 2, "sites": []}))

    with pytest.raises(RuntimeError, match="no sites"):
        load_sites(path)


@pytest.mark.parametrize("field", ["slug", "name", "latitude", "longitude", "timeZone"])
def test_rejects_a_site_missing_a_required_identity_field(tmp_path, field):
    site = {key: value for key, value in SITE.items() if key != field}
    path = tmp_path / "sites.json"
    path.write_text(json.dumps({"schemaVersion": 2, "sites": [site]}))

    with pytest.raises(RuntimeError, match=field):
        load_sites_input(path)


def test_a_missing_context_fails_loudly_and_names_the_fix(tmp_path):
    path = tmp_path / "sites.json"
    path.write_text(json.dumps({"schemaVersion": 2, "sites": [SITE]}))

    with pytest.raises(RuntimeError, match="windgram terrain"):
        load_sites(path)


def test_a_site_the_context_has_never_seen_fails_loudly(tmp_path):
    # Adding a site to sites.json without regenerating the context must
    # stop the build — the commit that adds a site carries its enrichment.
    new_site = {**SITE, "slug": "new-hill", "name": "New Hill"}
    path = tmp_path / "sites.json"
    path.write_text(json.dumps({"schemaVersion": 2, "sites": [SITE, new_site]}))
    (tmp_path / "site-context.json").write_text(json.dumps(CONTEXT))

    with pytest.raises(RuntimeError, match="new-hill.*windgram terrain"):
        load_sites(path)


def test_a_pre_elevation_context_version_fails_loudly(tmp_path):
    write_catalogue(tmp_path, context={**CONTEXT, "schemaVersion": 1})

    with pytest.raises(RuntimeError, match="schemaVersion.*windgram terrain"):
        load_site_context(tmp_path / "site-context.json")


def test_the_input_loader_never_needs_the_context(tmp_path):
    # `windgram terrain` GENERATES the context; its loader must read the
    # identity file alone or the first generation could never run.
    path = tmp_path / "sites.json"
    path.write_text(json.dumps({"schemaVersion": 2, "sites": [SITE]}))

    assert load_sites_input(path) == [SITE]


def test_the_repository_catalogue_loads_with_every_field_a_builder_samples():
    sites = load_sites(Path("sites.json"))

    assert sites, "the repository catalogue must list at least one site"
    for site in sites:
        assert {"slug", "name", "latitude", "longitude", "elevationM", "timeZone"} <= set(site)

import json
import math
import sys
from pathlib import Path

import numpy
import pytest
from jsonschema import Draft202012Validator

from windgram import cli, terrain
from windgram.config import resolve_path
from windgram.publish import round_document, write_json


# ------------------------------------------------------------- tile keys


def test_glo30_tile_urls_match_the_probe_verified_names():
    # dundee's tile, proven readable end-to-end [verified 2026-08-10].
    url = terrain.glo30_url(49.291977, -117.183569)
    assert url.endswith(
        "Copernicus_DSM_COG_10_N49_00_W118_00_DEM/"
        "Copernicus_DSM_COG_10_N49_00_W118_00_DEM.tif"
    )
    assert url.startswith("https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/")


def test_glo30_tile_keys_floor_both_axes_at_exact_integer_degrees():
    # A point exactly on a tile corner belongs to the tile whose SW
    # corner it is — floor on both axes, no ceil drift at the boundary.
    assert "N49_00_W117_00" in terrain.glo30_url(49.0, -117.0)
    assert "N49_00_W118_00" in terrain.glo30_url(49.5, -117.000001)
    # Positive longitudes keep the same SW-corner rule with an E prefix.
    assert "N46_00_E008_00" in terrain.glo30_url(46.5, 8.3)
    # Southern-hemisphere tiles are likewise named by their SW corner.
    assert "S34_00_E018_00" in terrain.glo30_url(-33.9, 18.4)


def test_worldcover_tile_urls_match_the_probe_verified_names():
    # All four founding sites read from N48W120 [verified 2026-08-10].
    url = terrain.worldcover_url(49.291977, -117.183569)
    assert url.endswith("v200/2021/map/ESA_WorldCover_10m_2021_v200_N48W120_Map.tif")

    assert "N48W120" in terrain.worldcover_url(48.0, -120.0)
    assert "N45W120" in terrain.worldcover_url(47.999999, -117.000001)
    assert "N45E006" in terrain.worldcover_url(46.5, 8.3)


# ------------------------------------------------------- slope and aspect


def _plane(east_gradient: float, north_gradient: float, res_m: float):
    """A 3×3 north-up window of z = base + gx·east + gy·north."""
    z = numpy.empty((3, 3))
    for row in range(3):
        for col in range(3):
            east = (col - 1) * res_m
            north = (1 - row) * res_m
            z[row, col] = 1000.0 + east_gradient * east + north_gradient * north
    return z


def test_horn_slope_and_aspect_on_synthetic_inclined_planes():
    # Rising to the east at 20 % — downslope faces west.
    slope, aspect = terrain.horn_slope_aspect(_plane(0.2, 0.0, 30.0), 30.0, 30.0)
    assert slope == pytest.approx(math.degrees(math.atan(0.2)))
    assert aspect == pytest.approx(270.0)

    # Rising to the north — downslope faces south.
    slope, aspect = terrain.horn_slope_aspect(_plane(0.0, 0.35, 30.0), 30.0, 30.0)
    assert slope == pytest.approx(math.degrees(math.atan(0.35)))
    assert aspect == pytest.approx(180.0)

    # Rising to the north-east — downslope faces south-west.
    slope, aspect = terrain.horn_slope_aspect(_plane(0.1, 0.1, 30.0), 30.0, 30.0)
    assert slope == pytest.approx(math.degrees(math.atan(math.hypot(0.1, 0.1))))
    assert aspect == pytest.approx(225.0)


def test_horn_slope_is_zero_on_a_flat_plane():
    slope, _ = terrain.horn_slope_aspect(_plane(0.0, 0.0, 30.0), 30.0, 30.0)
    assert slope == 0.0


def test_horn_uses_anisotropic_metre_spacings():
    # The same degree spacing is fewer metres east-west at high latitude;
    # feeding the true spacings must change the slope accordingly.
    z = _plane(0.2, 0.0, 30.0)
    steep, _ = terrain.horn_slope_aspect(z, 15.0, 30.0)
    shallow, _ = terrain.horn_slope_aspect(z, 30.0, 30.0)
    assert steep == pytest.approx(math.degrees(math.atan(0.4)))
    assert shallow == pytest.approx(math.degrees(math.atan(0.2)))


# ------------------------------------------------------ discs and ranking


def test_disc_membership_follows_the_pixel_centre_rule():
    # A grid of 0.001° spacing at the equator: ~111.3 m east-west,
    # ~111.1 m north-south. At 240 m radius the two-step diagonals
    # (~248.7 m) sit outside; the two-step axials (~222 m) inside.
    lats = 0.002 - numpy.arange(5) * 0.001
    lons = -0.002 + numpy.arange(5) * 0.001
    inside = terrain.disc_mask(lats, lons, 0.0, 0.0, 240.0)
    assert int(inside.sum()) == 13
    assert bool(inside[2, 2]) and bool(inside[2, 0]) and bool(inside[0, 2])
    assert not bool(inside[0, 0]) and not bool(inside[1, 4])


def test_percentile_rank_on_a_ramp():
    ramp = numpy.arange(101.0)
    # Mid-ramp: 50 strictly below, one tie — squarely mid-slope.
    assert terrain.percentile_below(ramp, 50.0) == pytest.approx(50.0)
    # Above everything: the launch IS the local summit.
    assert terrain.percentile_below(ramp, 200.0) == 100.0
    # Below everything.
    assert terrain.percentile_below(ramp, -5.0) == 0.0
    # A flat disc: all ties, half credit.
    assert terrain.percentile_below(numpy.full(40, 7.0), 7.0) == 50.0


def _ramp_window(spacing_deg=0.0005, size=61, latitude=49.0, longitude=-117.0):
    """A synthetic GLO-30-like window: elevation a pure ramp eastward,
    built with the same equirectangular scaling the analysis uses."""
    half = size // 2
    lats = latitude + (half - numpy.arange(size)) * spacing_deg
    lons = longitude + (numpy.arange(size) - half) * spacing_deg
    east_m = (lons - longitude) * terrain.m_per_deg_lon(latitude)
    arr = numpy.ma.masked_array(numpy.tile(1000.0 + 0.2 * east_m, (size, 1)))
    return arr, lats, lons


def test_terrain_from_window_analyses_a_synthetic_ramp():
    arr, lats, lons = _ramp_window()
    site = {"slug": "ramp", "latitude": 49.0, "longitude": -117.0}

    block = terrain.terrain_from_window(arr, lats, lons, site, radii_m=(500, 1000))

    assert block["source"] == "glo30"
    # The bilinear elevation of a linear ramp is exact.
    assert block["elevationM"] == pytest.approx(1000.0)
    assert block["slopeDeg"] == pytest.approx(math.degrees(math.atan(0.2)))
    assert block["aspectDeg"] == pytest.approx(270.0)
    assert [entry["radiusKm"] for entry in block["relief"]] == [0.5, 1.0]
    disc = block["relief"][0]
    assert disc["minM"] < 1000.0 < disc["maxM"]
    # The ramp is symmetric about the site, so it ranks mid-slope. Not
    # exactly 50: whether the centre column counts as ties or as "above"
    # hangs on float epsilon in the bilinear, worth a couple of percent
    # on a disc this small.
    assert disc["percentile"] == pytest.approx(50.0, abs=3.0)


def test_a_disc_truncated_by_the_window_edge_fails_loudly():
    # The window is clamped to its tile, so an edge inside a disc means
    # truncated relief statistics — refuse rather than publish them.
    # This window reaches ~1095 m east-west of the site.
    arr, lats, lons = _ramp_window()
    site = {"slug": "ramp", "latitude": 49.0, "longitude": -117.0}

    assert terrain.disc_is_covered(lats, lons, 49.0, -117.0, 1000.0)
    assert not terrain.disc_is_covered(lats, lons, 49.0, -117.0, 1200.0)
    with pytest.raises(RuntimeError, match="crosses the GLO-30 tile edge"):
        terrain.terrain_from_window(arr, lats, lons, site, radii_m=(1200,))


def test_terrain_from_window_fails_loudly_on_nodata_at_the_point():
    arr, lats, lons = _ramp_window()
    arr[29:32, 29:32] = numpy.ma.masked
    site = {"slug": "ramp", "latitude": 49.0, "longitude": -117.0}

    with pytest.raises(RuntimeError, match="GLO-30 returned nodata"):
        terrain.terrain_from_window(arr, lats, lons, site, radii_m=(500,))


# --------------------------------------------------------------- land cover


def test_class_fractions_sum_to_one_and_omit_absent_classes():
    values = numpy.array([10] * 97 + [30] * 2 + [60] * 1)

    fractions = terrain.class_fractions(values)

    assert fractions == {"treeCover": 0.97, "grassland": 0.02, "bareSparse": 0.01}
    assert sum(fractions.values()) == pytest.approx(1.0)
    # Dominant cover first, so the document reads without sorting.
    assert list(fractions) == ["treeCover", "grassland", "bareSparse"]


def test_class_fractions_omit_traces_that_would_publish_as_zero():
    # One water pixel in 10 000 rounds to 0.000 at the contract's three
    # decimals; an explicit zero says nothing an omission doesn't.
    values = numpy.array([10] * 9999 + [80])
    assert terrain.class_fractions(values) == {"treeCover": pytest.approx(0.9999)}

    # But an unknown trace code is still a taxonomy change — never
    # silently dropped with the rounding.
    with pytest.raises(RuntimeError, match="class code 42"):
        terrain.class_fractions(numpy.array([10] * 9999 + [42]))


def test_class_fractions_exclude_nodata_from_the_denominator():
    values = numpy.array([10, 10, 10, 0, 0, 80])
    assert terrain.class_fractions(values) == {"treeCover": 0.75, "water": 0.25}
    with pytest.raises(RuntimeError, match="only nodata"):
        terrain.class_fractions(numpy.zeros(9, dtype=int))


def test_an_unknown_land_cover_code_is_a_hard_failure():
    with pytest.raises(RuntimeError, match="class code 42"):
        terrain.class_fractions(numpy.array([10, 42]))
    with pytest.raises(RuntimeError, match="class code 255"):
        terrain.land_cover_name(255)


def test_land_cover_from_window_reads_the_launch_pixel_and_discs():
    size = 41
    lats = 49.0 + (size // 2 - numpy.arange(size)) * 0.0005
    lons = -117.0 + (numpy.arange(size) - size // 2) * 0.0005
    arr = numpy.full((size, size), 10, dtype=numpy.uint8)
    arr[size // 2, size // 2] = 30  # a grassy launch inside forest

    block = terrain.land_cover_from_window(
        arr, lats, lons, {"slug": "clearing", "latitude": 49.0, "longitude": -117.0},
        radii_m=(500,),
    )

    assert block["source"] == "worldcover2021"
    assert block["atLaunch"] == "grassland"
    by_class = block["fractions"][0]["byClass"]
    assert set(by_class) == {"treeCover", "grassland"}
    assert by_class["treeCover"] > 0.9


def test_land_cover_nodata_at_the_launch_is_a_hard_failure():
    lats = 49.0005 - numpy.arange(3) * 0.0005
    lons = -117.0005 + numpy.arange(3) * 0.0005
    arr = numpy.zeros((3, 3), dtype=numpy.uint8)

    with pytest.raises(RuntimeError, match="WorldCover returned nodata"):
        terrain.land_cover_from_window(
            arr, lats, lons, {"slug": "void", "latitude": 49.0, "longitude": -117.0},
            radii_m=(100,),
        )


# ----------------------------------------------------------- LidarBC index


# The FeatureServer response shape as served live [verified 2026-08-10]:
# layer 6 features carry flat attributes with `s3Url` and `year`; reflown
# BCGS tiles appear once per acquisition year.
LIDARBC_RESPONSE = {
    "objectIdFieldName": "OBJECTID",
    "features": [
        {
            "attributes": {
                "OBJECTID": 300,
                "filename": "bc_082f025_xli1m_utm11_2017.tif",
                "maptile": "082f025",
                "year": 2017,
                "projection": "utm11",
                "s3Url": "https://nrs.objectstore.gov.bc.ca/gdwuts/082/082f/2017/dem/bc_082f025_xli1m_utm11_2017.tif",
            }
        },
        {
            "attributes": {
                "OBJECTID": 301,
                "filename": "bc_082f025_xli1m_utm11_2022.tif",
                "maptile": "082f025",
                "year": 2022,
                "projection": "utm11",
                "s3Url": "https://nrs.objectstore.gov.bc.ca/gdwuts/082/082f/2022/dem/bc_082f025_xli1m_utm11_2022.tif",
            }
        },
    ],
}


def test_lidarbc_candidates_prefer_the_newest_acquisition():
    urls = terrain.lidarbc_candidates(LIDARBC_RESPONSE)
    assert [url.rsplit("/", 1)[1] for url in urls] == [
        "bc_082f025_xli1m_utm11_2022.tif",
        "bc_082f025_xli1m_utm11_2017.tif",
    ]


def test_lidarbc_candidates_tolerate_empty_and_incomplete_responses():
    assert terrain.lidarbc_candidates({"features": []}) == []
    assert terrain.lidarbc_candidates({}) == []
    # A feature without a download URL cannot be a candidate.
    assert terrain.lidarbc_candidates({"features": [{"attributes": {"year": 2020}}]}) == []


# ----------------------------------------------------------------- assembly


SITES = [
    {
        "slug": "dundee",
        "name": "Dundee",
        "latitude": 49.291977,
        "longitude": -117.183569,
        "timeZone": "America/Vancouver",
    },
    {
        "slug": "erie",
        "name": "Erie",
        "latitude": 49.204789,
        "longitude": -117.406951,
        "timeZone": "America/Vancouver",
    },
]


def _terrain_block(site):
    # Unrounded floats, aspect deliberately at the north wrap for dundee.
    aspect = 359.7 if site["slug"] == "dundee" else 236.4
    elevation = 1492.0666 if site["slug"] == "dundee" else 1254.0666
    return {
        "source": "glo30",
        "elevationM": elevation,
        "slopeDeg": 18.3399,
        "aspectDeg": aspect,
        "relief": [
            {"radiusKm": 1.0, "minM": 895.5, "maxM": 1665.9, "percentile": 80.4},
            {"radiusKm": 3.0, "minM": 713.4, "maxM": 1916.1, "percentile": 78.7},
        ],
    }


def _elevation_block(site):
    # No bare-earth model measures dundee here, forcing the loud GLO-30
    # last resort; erie gets the preferred LidarBC ground returns.
    if site["slug"] == "dundee":
        return None
    return {"source": "lidarbc", "elevationM": 1245.7789}


def _land_cover_block(site):
    return {
        "source": "worldcover2021",
        "atLaunch": "grassland",
        "fractions": [
            {
                "radiusKm": 1.0,
                "byClass": {"treeCover": 0.96994, "grassland": 0.0291, "bareSparse": 0.00096},
            }
        ],
    }


def _built_document():
    return terrain.build_document(
        SITES,
        terrain_of=_terrain_block,
        elevation_of=_elevation_block,
        land_cover_of=_land_cover_block,
        generated_at="2026-08-10T08:00:00Z",
    )


def test_document_round_trips_through_the_published_contract(tmp_path, capsys):
    path = tmp_path / "site-context.json"
    write_json(path, round_document(_built_document()), compact=False)
    document = json.loads(path.read_text())

    # The toolkit's JSON Schema artifact is the contract's authority.
    schema = json.loads(Path("toolkit/schema/site-context.schema.json").read_text())
    Draft202012Validator(schema).validate(document)

    assert document["schemaVersion"] == 2
    dundee = document["sites"]["dundee"]
    assert dundee["terrain"]["elevationM"] == 1492.1  # one decimal
    assert dundee["terrain"]["slopeDeg"] == 18.3
    assert dundee["terrain"]["aspectDeg"] == 0  # 359.7 wraps like wind
    assert isinstance(dundee["terrain"]["aspectDeg"], int)
    assert dundee["terrain"]["relief"][0] == {
        "radiusKm": 1,
        "minM": 896,
        "maxM": 1666,
        "percentile": 80,
    }
    assert dundee["landCover"]["fractions"][0]["byClass"] == {
        "treeCover": 0.97,
        "grassland": 0.029,
        "bareSparse": 0.001,
    }
    # The elevation pick is required at every site: with no bare-earth
    # coverage, dundee falls back to the GLO-30 surface elevation — loudly.
    assert dundee["elevation"] == {"source": "glo30", "elevationM": 1492.1}
    assert document["sites"]["erie"]["elevation"] == {
        "source": "lidarbc",
        "elevationM": 1245.8,
    }
    # v1's optional bareEarth block is gone: the pick IS the best bare-earth.
    assert "bareEarth" not in dundee and "bareEarth" not in document["sites"]["erie"]
    captured = capsys.readouterr()
    assert "WARN dundee" in captured.err
    assert "falls back to the GLO-30 surface model" in captured.err
    # A summary line per site as the build goes, naming each pick.
    assert "dundee: 1492.1 m (glo30)" in captured.out
    assert "erie: 1245.8 m (lidarbc)" in captured.out


def test_sources_list_exactly_the_referenced_sources():
    document = _built_document()

    # mrdem30 was never referenced by a site block, so its licence has no
    # values to travel with — it stays out.
    assert [source["id"] for source in document["sources"]] == [
        "glo30",
        "lidarbc",
        "worldcover2021",
    ]
    for source in document["sources"]:
        assert source == terrain.SOURCES[source["id"]]


def test_the_pick_prefers_lidarbc_then_mrdem_then_defers():
    lidarbc_urls = ["https://example.test/tile-2022.tif", "https://example.test/tile-2017.tif"]

    # The newest LidarBC tile that measures the point wins outright.
    pick = terrain.pick_elevation(lambda url: 1245.7 if url == lidarbc_urls[0] else None, lidarbc_urls)
    assert pick == {"source": "lidarbc", "elevationM": 1245.7}

    # A declining reflight hands the point to the older survey, not to MRDEM.
    pick = terrain.pick_elevation(lambda url: 1246.2 if url == lidarbc_urls[1] else None, lidarbc_urls)
    assert pick == {"source": "lidarbc", "elevationM": 1246.2}

    # No LidarBC coverage at all → the national DTM.
    pick = terrain.pick_elevation(
        lambda url: 1476.4 if url == terrain.MRDEM30_URL else None, lidarbc_urls
    )
    assert pick == {"source": "mrdem30", "elevationM": 1476.4}

    # Every DTM declines → None, deferring to the caller's GLO-30 last resort.
    assert terrain.pick_elevation(lambda url: None, lidarbc_urls) is None


def test_a_cross_source_disagreement_warns_but_does_not_fail(capsys):
    # LidarBC reads 985 m where GLO-30 reads ~1492 m: the catalogued pin
    # almost certainly hits different terrain in the two sources, but only
    # a human can say which record to fix, so the document still publishes.
    document = terrain.build_document(
        [SITES[0]],
        terrain_of=_terrain_block,
        elevation_of=lambda site: {"source": "lidarbc", "elevationM": 985.0},
        land_cover_of=_land_cover_block,
        generated_at="2026-08-10T08:00:00Z",
    )

    assert document["sites"]["dundee"]["elevation"]["elevationM"] == 985.0
    stderr = capsys.readouterr().err
    assert "WARN dundee" in stderr and "different terrain" in stderr


def test_a_close_cross_source_agreement_does_not_warn(capsys):
    # erie's LidarBC pick sits ~8 m under the GLO-30 surface — canopy
    # territory, not a coordinate mistake.
    terrain.build_document(
        [SITES[1]],
        terrain_of=_terrain_block,
        elevation_of=_elevation_block,
        land_cover_of=_land_cover_block,
        generated_at="2026-08-10T08:00:00Z",
    )
    assert capsys.readouterr().err == ""


# ---------------------------------------------------------------- plumbing


def test_missing_terrain_extra_names_the_install_command(monkeypatch):
    # A None entry in sys.modules makes `import rasterio` raise, which is
    # exactly what a default (extra-less) environment does.
    monkeypatch.setitem(sys.modules, "rasterio", None)
    with pytest.raises(RuntimeError, match="uv sync --project pipeline --extra terrain"):
        terrain._import_rasterio()


def test_cli_terrain_dispatches_resolved_paths(tmp_path, monkeypatch):
    sites_path = tmp_path / "sites.json"
    sites_path.write_text(json.dumps({"schemaVersion": 2, "sites": SITES}))
    output = tmp_path / "context" / "site-context.json"
    calls = []
    monkeypatch.setattr(
        terrain, "generate", lambda sites, path: calls.append((sites, path)) or 0
    )

    result = cli.main(
        ["terrain", "--sites", str(sites_path), "--output", str(output)]
    )

    assert result == 0
    assert calls == [(SITES, resolve_path(output))]


def test_cli_terrain_defaults_to_the_checkout_catalogue_files():
    # The command is run bare from the repository root; these defaults
    # are that call's contract.
    parser_defaults = cli._parser().parse_args(["terrain"])
    assert parser_defaults.sites == Path("sites.json")
    assert parser_defaults.output == Path("site-context.json")


def test_cli_terrain_rejects_a_missing_sites_file(tmp_path, capsys):
    result = cli.main(["terrain", "--sites", str(tmp_path / "absent.json")])
    assert result == 1
    assert "sites file does not exist" in capsys.readouterr().err

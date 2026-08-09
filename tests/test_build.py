"""The ECCC Datamart GRIB builder shared by HRDPS 2.5 km, RDPS, and GDPS.

Network-free: GRIB2 fixtures are synthesized in memory with ecCodes (a tiny
regular or rotated lat-lon grid around the catalogued sites), and the
end-to-end test feeds them through _build_profiles via a fake fetch keyed on
the exact Datamart URLs the builder constructs.
"""

import json
import math
from pathlib import Path

import eccodes
import pytest

from windgram import build
from windgram.build import (
    GDPS,
    GDPS_INTERMEDIATE_LEVELS,
    HRDPS,
    PRESSURE_LEVELS,
    RDPS,
    DatamartModel,
    _build_profiles,
    _file_url,
    _precip_rate_for_hour,
    _previous_scheduled_hour,
    english_pressure_variable,
    gdps_cape_hours,
    gdps_levels,
    model_semantics,
    old_style_pressure_variable,
)
from windgram.datamart import DownloadStats, NotFoundError
from windgram.grib import GribField
from windgram.windgram import derive_windgram_profile

DUNDEE = {
    "slug": "dundee",
    "name": "Dundee",
    "latitude": 49.291977,
    "longitude": -117.183569,
    "elevationM": 1485,
}
ERIE = {"slug": "erie", "latitude": 49.204789, "longitude": -117.406951}
FLAGPOLE = {"slug": "flagpole", "latitude": 49.507695, "longitude": -117.310423}
RED_MOUNTAIN = {"slug": "red-mountain", "latitude": 49.091868, "longitude": -117.820838}

# RDPS's rotated pole, from the research doc's decoded samples.
RDPS_POLE = (-31.758312, 267.597031)


def make_grib(
    value: float,
    *,
    rotated_pole: tuple[float, float] | None = None,
    first_lat: float = 49.6,
    first_lon: float = 242.0,
    missing_indexes: tuple[int, ...] = (),
) -> bytes:
    """One GRIB2 message on a small 11×8, 0.1° grid, every point `value`.

    The default geographic window covers the catalogued sites; a rotated
    variant places the same window in rotated coordinates so nearest-point
    lookups exercise ecCodes' rotation handling. `missing_indexes` masks
    gridpoints via a bitmap, the way real fields encode missing data.
    """
    gid = eccodes.codes_grib_new_from_samples("GRIB2")
    ni, nj = 11, 8
    if rotated_pole is not None:
        eccodes.codes_set(gid, "gridType", "rotated_ll")
        eccodes.codes_set(gid, "latitudeOfSouthernPoleInDegrees", rotated_pole[0])
        eccodes.codes_set(gid, "longitudeOfSouthernPoleInDegrees", rotated_pole[1])
    eccodes.codes_set(gid, "Ni", ni)
    eccodes.codes_set(gid, "Nj", nj)
    eccodes.codes_set(gid, "latitudeOfFirstGridPointInDegrees", first_lat)
    eccodes.codes_set(gid, "longitudeOfFirstGridPointInDegrees", first_lon)
    eccodes.codes_set(gid, "latitudeOfLastGridPointInDegrees", first_lat - (nj - 1) * 0.1)
    eccodes.codes_set(gid, "longitudeOfLastGridPointInDegrees", first_lon + (ni - 1) * 0.1)
    eccodes.codes_set(gid, "iDirectionIncrementInDegrees", 0.1)
    eccodes.codes_set(gid, "jDirectionIncrementInDegrees", 0.1)
    values = [float(value)] * (ni * nj)
    if missing_indexes:
        missing = eccodes.codes_get(gid, "missingValue")
        eccodes.codes_set(gid, "bitmapPresent", 1)
        for index in missing_indexes:
            values[index] = missing
    eccodes.codes_set_values(gid, values)
    message = eccodes.codes_get_message(gid)
    eccodes.codes_release(gid)
    return message


def grid_index_of(message: bytes, latitude: float, longitude: float) -> int:
    gid = eccodes.codes_new_from_message(message)
    try:
        return int(eccodes.codes_grib_find_nearest(gid, latitude, longitude)[0].index)
    finally:
        eccodes.codes_release(gid)


def test_file_urls_match_the_datamart_layout():
    # Each URL verified live (HEAD 200) on 2026-08-08.
    assert _file_url(HRDPS, "20260807", "00", 24, "TMP_ISBL_1015") == (
        "https://dd.weather.gc.ca/20260807/WXO-DD/model_hrdps/continental/2.5km/00/024/"
        "20260807T00Z_MSC_HRDPS_TMP_ISBL_1015_RLatLon0.0225_PT024H.grib2"
    )
    assert _file_url(RDPS, "20260807", "00", 84, "AirTemp_AGL-2m") == (
        "https://dd.weather.gc.ca/20260807/WXO-DD/model_rdps/10km/00/084/"
        "20260807T00Z_MSC_RDPS_AirTemp_AGL-2m_RLatLon0.09_PT084H.grib2"
    )
    assert _file_url(GDPS, "20260807", "12", 240, "Precip-Accum_Sfc") == (
        "https://dd.weather.gc.ca/20260807/WXO-DD/model_gdps/15km/12/240/"
        "20260807T12Z_MSC_GDPS_Precip-Accum_Sfc_LatLon0.15_PT240H.grib2"
    )
    # Terrain lives at PT000 only (RDPS/GDPS) — hour 0 must format cleanly.
    assert _file_url(GDPS, "20260807", "00", 0, "GeopotentialHeight_Sfc").endswith(
        "/000/20260807T00Z_MSC_GDPS_GeopotentialHeight_Sfc_LatLon0.15_PT000H.grib2"
    )


def test_file_urls_honour_the_datamart_base_override(monkeypatch):
    # hpfx serves the identical dated tree (verified 2026-08-08), so only
    # the host changes; a trailing slash in the override must not double up.
    monkeypatch.setenv("WINDGRAM_DATAMART_BASE", "https://hpfx.collab.science.gc.ca/")
    assert _file_url(HRDPS, "20260807", "00", 24, "TMP_ISBL_1015") == (
        "https://hpfx.collab.science.gc.ca/20260807/WXO-DD/model_hrdps/continental/2.5km/"
        "00/024/20260807T00Z_MSC_HRDPS_TMP_ISBL_1015_RLatLon0.0225_PT024H.grib2"
    )


def test_datamart_builders_share_the_per_host_connection_budget():
    # One workflow job per Datamart host and sequential builders inside a
    # job make this constant the per-host connection ceiling — keep every
    # ECCC builder on the same budget (see the comment in windgram/build.py).
    from windgram import build_1km, build_geps, build_reps

    assert build.FETCH_CONCURRENCY == 5
    assert build_1km.FETCH_CONCURRENCY == build.FETCH_CONCURRENCY
    assert build_reps.FETCH_CONCURRENCY == build.FETCH_CONCURRENCY
    assert build_geps.FETCH_CONCURRENCY == build.FETCH_CONCURRENCY


def test_pressure_variable_tokens_cover_both_naming_schemes():
    assert old_style_pressure_variable("temperatureC", 1015) == "TMP_ISBL_1015"
    assert old_style_pressure_variable("verticalVelocityPaS", 850) == "VVEL_ISBL_0850"
    assert english_pressure_variable("temperatureC", 850) == "AirTemp_IsbL-0850"
    assert english_pressure_variable("dewPointDepressionC", 985) == (
        "DewPointDepression_IsbL-0985"
    )
    assert english_pressure_variable("verticalVelocityPaS", 600) == (
        "VerticalVelocity_IsbL-0600"
    )


def test_model_schedules_cover_their_advertised_horizons():
    assert HRDPS.forecast_hours == tuple(range(1, 49))
    assert RDPS.forecast_hours == tuple(range(1, 85))
    assert GDPS.forecast_hours == tuple(range(3, 241, 3))


def test_slugs_double_as_the_models_output_directories():
    assert HRDPS.out_dir == Path("data/hrdps-continental")
    assert RDPS.out_dir == Path("data/rdps")
    assert GDPS.out_dir == Path("data/gdps")


def test_gdps_levels_thin_only_on_intermediate_steps_past_168():
    assert gdps_levels(24) == PRESSURE_LEVELS
    assert gdps_levels(168) == PRESSURE_LEVELS
    assert gdps_levels(171) == GDPS_INTERMEDIATE_LEVELS  # verified live: 1015 is 404 here
    assert gdps_levels(174) == PRESSURE_LEVELS
    assert gdps_levels(237) == GDPS_INTERMEDIATE_LEVELS
    assert gdps_levels(240) == PRESSURE_LEVELS
    assert HRDPS.levels_for_hour(48) == PRESSURE_LEVELS
    assert RDPS.levels_for_hour(84) == PRESSURE_LEVELS


def test_omega_levels_are_the_curated_intersections():
    assert HRDPS.omega_levels == (1000, 850, 700)
    assert RDPS.omega_levels == (850, 700)
    assert GDPS.omega_levels == (850, 700, 600)
    for model in (HRDPS, RDPS, GDPS):
        assert set(model.omega_levels) <= set(PRESSURE_LEVELS)
    # GDPS's reduced steps keep omega only where the level itself survives.
    assert set(GDPS.omega_levels) & set(gdps_levels(171)) == {850, 700}


def test_models_json_matches_the_builder_configurations():
    catalogue = json.loads(Path("data/models.json").read_text())
    entries = {entry["slug"]: entry for entry in catalogue["models"]}
    for model in (HRDPS, RDPS, GDPS):
        capabilities = entries[model.slug]["capabilities"]
        assert capabilities["pressureLevels"] == list(PRESSURE_LEVELS)
        # The ECCC deterministic trio publishes its own omega (Pa/s); the
        # capability is a provenance token, not a boolean.
        assert capabilities["verticalVelocity"] == "omega"
        assert capabilities["verticalVelocityLevels"] == list(model.omega_levels)
        # Science-wave capabilities mirror the builder configuration exactly:
        # ECCC gusts are hour-max, CAPE everywhere, CIN only where a CIN
        # variable exists (the HRDPS family has none), PBL everywhere.
        assert capabilities["gust"] == ("hourMax" if model.gust_max_variable else False)
        assert capabilities["cape"] == (model.cape_variable is not None)
        assert capabilities["cin"] == (model.cin_variable is not None)
        assert capabilities["pblHeight"] == (model.pbl_variable is not None)
        assert capabilities["cloudLayers"] is False  # ECCC has total cloud only
        assert capabilities["cloudProfile"] is False
        # The catalogue's precipitation token mirrors the transport the
        # builder actually uses — window quantities, never PRATE, here.
        assert capabilities["precipitation"] == "windowMeanRate"
        assert model_semantics(model) == {
            "gust": "hourMax",
            "precipitation": "windowMeanRate",
        }


def test_models_json_science_capabilities_match_the_research_matrix():
    # The full seven-model matrix from the 2026-08-08 field research; the
    # NOAA and REPS rows are asserted here because their builders have no
    # DatamartModel config to compare against.
    catalogue = json.loads(Path("data/models.json").read_text())
    entries = {entry["slug"]: entry["capabilities"] for entry in catalogue["models"]}

    def science(caps):
        return (
            caps["gust"],
            caps["cape"],
            caps["cin"],
            caps["pblHeight"],
            caps["cloudLayers"],
            caps["cloudProfile"],
        )

    assert science(entries["hrdps-continental"]) == ("hourMax", True, False, True, False, False)
    assert science(entries["hrdps-west"]) == ("hourMax", True, False, True, False, False)
    assert science(entries["rdps"]) == ("hourMax", True, True, True, False, False)
    assert science(entries["gdps"]) == ("hourMax", True, True, True, False, False)
    assert science(entries["hrrr-conus"]) == ("instant", True, True, True, True, False)
    assert science(entries["gfs"]) == ("instant", True, True, True, True, True)
    # REPS carries none of the four families per-member — the empty column.
    assert science(entries["reps"]) == (False, False, False, False, False, False)


def test_every_profile_semantics_declaration_mirrors_the_catalogue():
    # The same honesty pattern as gust: what a builder stamps into its
    # documents' "semantics" block must be exactly what data/models.json
    # declares — a gust token where the model publishes gusts, none where
    # it does not, and the precipitation token always.
    from windgram import build_1km, build_geps, build_gfs, build_hrrr, build_nam, build_reps

    declared = {
        "hrdps-continental": model_semantics(HRDPS),
        "rdps": model_semantics(RDPS),
        "gdps": model_semantics(GDPS),
        "hrdps-west": build_1km.SEMANTICS,
        "hrrr-conus": build_hrrr.SEMANTICS,
        "gfs": build_gfs.SEMANTICS,
        "nam": build_nam.SEMANTICS,
        "nam-conus-nest": build_nam.SEMANTICS,
        "reps": build_reps.SEMANTICS,
        "geps": build_geps.SEMANTICS,
    }
    catalogue = json.loads(Path("data/models.json").read_text())
    entries = {entry["slug"]: entry for entry in catalogue["models"]}

    assert set(declared) == set(entries), "every catalogued model has a builder"
    for slug, semantics in declared.items():
        capabilities = entries[slug]["capabilities"]
        assert semantics.get("gust", False) == capabilities["gust"], slug
        assert semantics["precipitation"] == capabilities["precipitation"], slug
        # PRATE feeds are the only instantaneous rates; everything else is
        # a window mean (fixed windows, buckets, or differenced run totals).
        expected_rate = "instantRate" if slug in ("hrdps-west", "hrrr-conus") else "windowMeanRate"
        assert semantics["precipitation"] == expected_rate, slug


def test_every_catalogue_entry_declares_cadence_and_precipitation():
    catalogue = json.loads(Path("data/models.json").read_text())
    for entry in catalogue["models"]:
        assert isinstance(entry["runIntervalHours"], int), entry["slug"]
        assert entry["runIntervalHours"] > 0, entry["slug"]
        assert entry["capabilities"]["precipitation"] in (
            "instantRate",
            "windowMeanRate",
        ), entry["slug"]


def test_precip_rates_difference_run_totals_and_divide_by_the_window():
    accumulations = {
        0: {"dundee": 0.0},
        3: {"dundee": 1.2},
        6: {"dundee": 4.2},
    }

    assert _precip_rate_for_hour(accumulations.get, GDPS.forecast_hours, 3)[
        "dundee"
    ] == pytest.approx(0.4)
    assert _precip_rate_for_hour(accumulations.get, GDPS.forecast_hours, 6)[
        "dundee"
    ] == pytest.approx(1.0)


def test_clamps_resampling_noise_to_non_negative_precipitation():
    accumulations = {3: {"erie": 5.0}, 6: {"erie": 4.9}}
    assert _precip_rate_for_hour(accumulations.get, GDPS.forecast_hours, 6) == {"erie": 0.0}


def test_first_scheduled_step_differences_against_the_run_start():
    assert _previous_scheduled_hour(GDPS.forecast_hours, 3) == 0
    assert _previous_scheduled_hour(GDPS.forecast_hours, 240) == 237
    assert _previous_scheduled_hour((1, 2, 3), 1) == 0


def test_grib_sampling_reads_the_nearest_gridpoint_within_the_guard():
    with GribField(make_grib(42.5)) as field:
        assert field.value_at(DUNDEE["latitude"], DUNDEE["longitude"], 15.0) == 42.5


def test_grib_sampling_rejects_gridpoints_beyond_the_distance_cap():
    with GribField(make_grib(42.5)) as field:
        with pytest.raises(RuntimeError, match="outside the model grid"):
            field.value_at(DUNDEE["latitude"], DUNDEE["longitude"], 0.5)


def test_grib_sampling_rejects_points_off_the_grid_entirely():
    with GribField(make_grib(42.5)) as field:
        with pytest.raises(RuntimeError, match="outside the model grid"):
            field.value_at(40.0, -100.0, 15.0)


def test_grib_sampling_decodes_the_field_once_for_many_sites(monkeypatch):
    # Datamart fields are JPEG2000-packed and ecCodes re-decodes the whole
    # field on every per-element read, so value_at must decode once per
    # message and serve every site from the cached array.
    decode_calls = {"values": 0}
    real_get_values = eccodes.codes_get_values

    def counting_get_values(gid):
        decode_calls["values"] += 1
        return real_get_values(gid)

    def forbidden_element(gid, key, index):
        raise AssertionError(
            "codes_get_double_element re-decodes the whole JPEG2000 field per call"
        )

    monkeypatch.setattr(eccodes, "codes_get_values", counting_get_values)
    monkeypatch.setattr(eccodes, "codes_get_double_element", forbidden_element)

    sites = [DUNDEE, ERIE, FLAGPOLE, RED_MOUNTAIN]
    with GribField(make_grib(42.5)) as field:
        for site in sites:
            assert field.value_at(site["latitude"], site["longitude"], 15.0) == 42.5
    assert decode_calls["values"] == 1

    # The cache lives with the message, not globally: a second message on
    # the same grid decodes its own values.
    with GribField(make_grib(7.0)) as field:
        assert field.value_at(DUNDEE["latitude"], DUNDEE["longitude"], 15.0) == 7.0
    assert decode_calls["values"] == 2


def test_grib_cached_values_match_the_per_element_path():
    message = make_grib(3.5)
    index = grid_index_of(message, DUNDEE["latitude"], DUNDEE["longitude"])
    gid = eccodes.codes_new_from_message(message)
    expected = eccodes.codes_get_double_element(gid, "values", index)
    eccodes.codes_release(gid)
    with GribField(message) as field:
        assert field.value_at(DUNDEE["latitude"], DUNDEE["longitude"], 15.0) == expected
        # And again, from the cache.
        assert field.value_at(DUNDEE["latitude"], DUNDEE["longitude"], 15.0) == expected


def test_grib_missing_values_stay_none_through_the_cache():
    plain = make_grib(5.0)
    dundee_index = grid_index_of(plain, DUNDEE["latitude"], DUNDEE["longitude"])
    erie_index = grid_index_of(plain, ERIE["latitude"], ERIE["longitude"])
    assert dundee_index != erie_index
    message = make_grib(5.0, missing_indexes=(dundee_index,))
    with GribField(message) as field:
        assert field.value_at(DUNDEE["latitude"], DUNDEE["longitude"], 15.0) is None
        assert field.value_at(ERIE["latitude"], ERIE["longitude"], 15.0) == 5.0


def test_grib_sampling_handles_a_rotated_grid_like_rdps():
    # The site window expressed in RDPS's rotated frame: Dundee sits near
    # (-6.0, -16.0) rotated, so a grid starting north-west of that covers it.
    message = make_grib(7.25, rotated_pole=RDPS_POLE, first_lat=-5.6, first_lon=343.5)
    with GribField(message) as field:
        assert field.value_at(DUNDEE["latitude"], DUNDEE["longitude"], 15.0) == 7.25


def test_derived_levels_carry_omega_only_where_the_source_has_it():
    source = {
        "generatedAt": "2026-08-08T04:47:14Z",
        "referenceTime": "2026-08-08T00:00:00Z",
        "siteId": "dundee",
        "siteName": "Dundee",
        "latitude": DUNDEE["latitude"],
        "longitude": DUNDEE["longitude"],
        "siteAltitudeM": 1485,
        "modelElevationM": 1000.0,
        "hours": [
            {
                "validAt": "2026-08-08T03:00:00Z",
                "pressurePa": 101300.0,
                "temperatureC": 20.0,
                "dewPointDepressionC": 10.0,
                "windSpeedMs": 1.5,
                "windDirectionDeg": 246.0,
                "cloudCoverPercent": 40.0,
                "precipitationMm": 0.0,
                "sensibleHeatFluxWm2": 200.0,
                "latentHeatFluxWm2": 50.0,
                "levels": [
                    {
                        "pressureHpa": 850,
                        "heightM": 2500.0,
                        "temperatureC": 10.0,
                        "dewPointDepressionC": 5.0,
                        "windDirectionDeg": 250.0,
                        "windSpeedMs": 8.0,
                        "verticalVelocityPaS": -0.42,
                    },
                    {
                        "pressureHpa": 700,
                        "heightM": 4500.0,
                        "temperatureC": -5.0,
                        "dewPointDepressionC": 5.0,
                        "windDirectionDeg": 250.0,
                        "windSpeedMs": 8.0,
                    },
                ],
            }
        ],
    }

    profile = derive_windgram_profile(
        source, model="rdps", semantics=model_semantics(RDPS)
    )
    levels = profile["hours"][0]["levels"]
    assert levels[0]["verticalVelocityPaS"] == -0.42
    assert "verticalVelocityPaS" not in levels[1]


# --- End-to-end: two forecast steps through _build_profiles with a fake
# Datamart serving synthetic GRIB messages keyed on the exact URLs. ---

TEST_MODEL = DatamartModel(
    slug="test-10km",
    path="model_test/10km",
    file_prefix="MSC_TEST",
    grid_token="RLatLon0.09",
    run_hours=("00",),
    forecast_hours=(3, 6),
    surface_variables={
        "cloudCoverPercent": "TotalCloudCover_Sfc",
        "latentHeatFluxWm2": "LatentHeatNetFlux_Sfc",
        "pressurePa": "Pressure_MSL",
        "sensibleHeatFluxWm2": "SensibleHeatNetFlux_Sfc",
        "windDirectionDeg": "WindDir_AGL-10m",
        "windSpeedMs": "WindSpeed_AGL-10m",
    },
    temperature_variable="AirTemp_AGL-2m",
    dew_point_variable="DewPoint_AGL-2m",
    pressure_variable=english_pressure_variable,
    omega_levels=(850,),
    terrain_variable="GeopotentialHeight_Sfc",
    max_nearest_km=15.0,
    precip_run_total_variable="Precip-Accum_Sfc",
    levels_for_hour=lambda hour: (925, 850, 700, 600),
    gust_max_variable="WindGust-Max_AGL-10m",
    gust_instant_variable="WindGust_AGL-10m",
    cape_variable="CAPE_Sfc",
    cin_variable="CIN_Sfc",
    cape_sentinel=9999.0,
    pbl_variable="PlanetaryBoundaryLayerHeight_Sfc",
)

LEVEL_HEIGHTS = {925: 1500.0, 850: 2500.0, 700: 4500.0, 600: 5500.0}
LEVEL_TEMPS_K = {925: 288.15, 850: 283.15, 700: 268.15, 600: 258.15}


def _fake_datamart(date: str) -> dict[str, bytes]:
    def url(variable: str, hour: int) -> str:
        return _file_url(TEST_MODEL, date, "00", hour, variable)

    store = {url("GeopotentialHeight_Sfc", 0): make_grib(1000.0)}
    surface = {
        "AirTemp_AGL-2m": lambda hour: 293.15 + hour,
        "DewPoint_AGL-2m": lambda hour: 283.15 + hour,
        "WindDir_AGL-10m": lambda hour: 246.0,
        "WindSpeed_AGL-10m": lambda hour: 1.5,
        "Pressure_MSL": lambda hour: 101300.0,
        "TotalCloudCover_Sfc": lambda hour: 40.0,
        "SensibleHeatNetFlux_Sfc": lambda hour: 200.0,
        "LatentHeatNetFlux_Sfc": lambda hour: 50.0,
        "Precip-Accum_Sfc": lambda hour: {3: 1.5, 6: 6.0}[hour],
        # Hour-max gust always >= the instantaneous diagnostic (asserted).
        "WindGust-Max_AGL-10m": lambda hour: 9.4,
        "WindGust_AGL-10m": lambda hour: 6.1,
        # Hour 6's CAPE and hour 3's CIN carry the 9999 "not computed"
        # sentinel — those positions must vanish, not publish.
        "CAPE_Sfc": lambda hour: {3: 850.0, 6: 9999.0}[hour],
        "CIN_Sfc": lambda hour: {3: 9999.0, 6: -55.0}[hour],
    }
    # PBL height exists at hour 3 only; the absent hour-6 file is a
    # tolerated 404, so hour 6 simply publishes no pblHeightM.
    store[url("PlanetaryBoundaryLayerHeight_Sfc", 3)] = make_grib(1650.0)
    for hour in TEST_MODEL.forecast_hours:
        for variable, value in surface.items():
            store[url(variable, hour)] = make_grib(value(hour))
        for level in (925, 850, 700, 600):
            if hour == 6 and level == 600:
                continue  # the level thins out upstream: five 404s, tolerated
            store[url(f"AirTemp_IsbL-{level:04d}", hour)] = make_grib(LEVEL_TEMPS_K[level])
            store[url(f"DewPointDepression_IsbL-{level:04d}", hour)] = make_grib(5.0)
            store[url(f"GeopotentialHeight_IsbL-{level:04d}", hour)] = make_grib(
                LEVEL_HEIGHTS[level]
            )
            store[url(f"WindDir_IsbL-{level:04d}", hour)] = make_grib(250.0)
            store[url(f"WindSpeed_IsbL-{level:04d}", hour)] = make_grib(8.0)
    # Omega exists at 850 only, and only at hour 3 — hour 6's absence must
    # publish the level without the optional field.
    store[url("VerticalVelocity_IsbL-0850", 3)] = make_grib(-0.42)
    return store


def test_build_profiles_end_to_end_against_a_fake_datamart(monkeypatch):
    date = "20260808"
    store = _fake_datamart(date)

    def fake_fetch(requested_url: str, stats=None) -> bytes:
        if requested_url not in store:
            raise NotFoundError(f"Datamart {requested_url} returned 404")
        return store[requested_url]

    monkeypatch.setattr(build, "fetch_bytes", fake_fetch)
    result = _build_profiles(
        TEST_MODEL,
        {"date": date, "hour": "00"},
        "2026-08-08T00:00:00Z",
        [DUNDEE],
        DownloadStats(),
    )

    assert result["firstForecastHour"] == 3
    assert result["lastForecastHour"] == 6
    assert result["forecastHours"] == 2
    (profile,) = result["profiles"]
    assert profile["model"] == "test-10km"
    assert profile["site"]["modelElevationM"] == 1000.0
    # The published document self-interprets its varying fields.
    assert profile["semantics"] == {"gust": "hourMax", "precipitation": "windowMeanRate"}

    # GRIB simple packing quantizes through float32, hence the tolerances.
    first, second = profile["hours"]
    assert first["validAt"] == "2026-08-08T03:00:00Z"
    assert first["surface"]["temperatureC"] == pytest.approx(23.0, abs=1e-3)
    assert first["surface"]["dewPointC"] == pytest.approx(13.0, abs=1e-3)
    assert first["surface"]["windDirectionDeg"] == 246.0
    assert first["surface"]["pressurePa"] == pytest.approx(101300.0, abs=0.5)
    # Run totals 1.5 mm by +3 and 6.0 mm by +6 → 0.5 and 1.5 mm/h.
    assert first["surface"]["precipitationMmHr"] == pytest.approx(0.5, abs=1e-3)
    assert second["surface"]["precipitationMmHr"] == pytest.approx(1.5, abs=1e-3)

    assert [level["pressureHpa"] for level in first["levels"]] == [925, 850, 700, 600]
    assert [level["pressureHpa"] for level in second["levels"]] == [925, 850, 700]
    for hour in (first, second):
        for level in hour["levels"]:
            assert level["heightM"] == LEVEL_HEIGHTS[level["pressureHpa"]]
            assert level["temperatureC"] == pytest.approx(
                LEVEL_TEMPS_K[level["pressureHpa"]] - 273.15, abs=1e-3
            )
            assert level["dewPointC"] == pytest.approx(level["temperatureC"] - 5.0, abs=1e-3)

    # Omega is level-sparse and step-sparse: present only where a file was.
    assert first["levels"][1]["verticalVelocityPaS"] == pytest.approx(-0.42, abs=1e-3)
    assert all("verticalVelocityPaS" not in level for level in second["levels"])
    assert all(
        "verticalVelocityPaS" not in level
        for level in first["levels"]
        if level["pressureHpa"] != 850
    )

    for hour in (first, second):
        assert all(
            math.isfinite(value)
            for key, value in hour["surface"].items()
            if isinstance(value, float)
        )

    # Science fields: hour-max gust published, sentinels masked to absence,
    # PBL only where the file existed.
    assert first["surface"]["windGustMs"] == pytest.approx(9.4, abs=1e-3)
    assert second["surface"]["windGustMs"] == pytest.approx(9.4, abs=1e-3)
    assert first["surface"]["capeJkg"] == pytest.approx(850.0, abs=1e-3)
    assert "cinJkg" not in first["surface"]  # 9999 sentinel masked
    assert "capeJkg" not in second["surface"]  # 9999 sentinel masked
    assert second["surface"]["cinJkg"] == pytest.approx(-55.0, abs=1e-3)
    assert first["surface"]["pblHeightM"] == pytest.approx(1650.0, abs=1e-3)
    assert "pblHeightM" not in second["surface"]  # tolerated 404


def test_build_fails_loudly_when_gust_semantics_break(monkeypatch):
    # The Max files' interval metadata is broken upstream, so the hourly
    # window semantics are re-asserted every build: Max < instant beyond
    # packing noise means the files no longer mean what was verified.
    date = "20260808"
    store = _fake_datamart(date)
    for hour in TEST_MODEL.forecast_hours:
        store[_file_url(TEST_MODEL, date, "00", hour, "WindGust-Max_AGL-10m")] = make_grib(3.0)

    def fake_fetch(requested_url: str, stats=None) -> bytes:
        if requested_url not in store:
            raise NotFoundError(f"Datamart {requested_url} returned 404")
        return store[requested_url]

    monkeypatch.setattr(build, "fetch_bytes", fake_fetch)
    with pytest.raises(RuntimeError, match="Gust semantics broke"):
        _build_profiles(
            TEST_MODEL,
            {"date": date, "hour": "00"},
            "2026-08-08T00:00:00Z",
            [DUNDEE],
            DownloadStats(),
        )


def test_gdps_cape_thins_one_regime_earlier_than_the_other_fields():
    # Verified live 2026-08-08: CAPE/CIN present at 003/024/174/240, absent
    # at 001 (hourly regime) and 171 (3-hourly non-6-hourly past 168).
    assert gdps_cape_hours(3)
    assert gdps_cape_hours(168)
    assert not gdps_cape_hours(171)
    assert gdps_cape_hours(174)
    assert gdps_cape_hours(240)
    # Gusts and PBL follow the broader schedule, not the CAPE one.
    assert GDPS.cape_for_hour is gdps_cape_hours
    assert HRDPS.cape_for_hour(47) and RDPS.cape_for_hour(84)

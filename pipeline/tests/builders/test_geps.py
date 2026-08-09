import math

import eccodes
import pytest

from windgram.builders.geps import (
    CAPE_SENTINEL,
    FORECAST_HOURS,
    MEMBER_COUNT,
    PERTURBATION_NUMBERS,
    PRESSURE_LEVELS,
    WIND_LEVEL_TOKENS,
    _aggregate_hours,
    _build_documents,
    _file_url,
    _forecast_hours,
    _require_plausible_model_elevation,
    _sample_scalar_members,
    _sample_wind_members,
    previous_scheduled_hour,
)
from windgram.datamart import DownloadStats
from windgram.ensemble import circular_median, percentile
from windgram.moisture import dew_point_depression
from windgram.publish import compact_json, round_document
from windgram.sentinel import mask_sentinel

DUNDEE = (49.291977, -117.183569)
SITE = {
    "slug": "dundee",
    "name": "Dundee",
    "latitude": DUNDEE[0],
    "longitude": DUNDEE[1],
    "elevationM": 1485,
}


# --- shared percentiles and circular consensus --------------------------------


def test_the_published_points_land_on_exact_ranks_for_21_members():
    values = sorted(float(v) for v in range(21))

    assert percentile(values, 10) == 2
    assert percentile(values, 25) == 5
    assert percentile(values, 50) == 10
    assert percentile(values, 75) == 15
    assert percentile(values, 90) == 18


def test_circular_median_crosses_the_wrap():
    assert circular_median([350.0, 355.0, 5.0, 10.0, 15.0]) == pytest.approx(5.0)
    assert circular_median([80.0, 90.0, 100.0]) == pytest.approx(90.0)


# --- Datamart URLs and schedule ------------------------------------------------


def test_datamart_urls_follow_the_old_cmc_naming_scheme():
    # GEPS raw never migrated to the new MSC filename scheme.
    assert _file_url("CAPE_SFC_0", "20260808", "00", 24) == (
        "https://dd.weather.gc.ca/20260808/WXO-DD/ensemble/geps/grib2/raw/00/024/"
        "CMC_geps-raw_CAPE_SFC_0_latlon0p5x0p5_2026080800_P024_allmbrs.grib2"
    )


def test_datamart_urls_honour_the_base_override(monkeypatch):
    monkeypatch.setenv("WINDGRAM_DATAMART_BASE", "https://hpfx.collab.science.gc.ca")
    assert _file_url("CAPE_SFC_0", "20260808", "00", 24).startswith(
        "https://hpfx.collab.science.gc.ca/20260808/WXO-DD/ensemble/geps/"
    )


def test_every_published_level_has_a_wind_file_token():
    assert WIND_LEVEL_TOKENS["ISBL_1000"] == 1000
    assert WIND_LEVEL_TOKENS["TGL_10m"] is None
    assert sorted(token for token in WIND_LEVEL_TOKENS if token != "TGL_10m") == sorted(
        f"ISBL_{level:04d}" for level in PRESSURE_LEVELS
    )


def test_the_schedule_is_three_hourly_to_192_then_six_hourly_to_384():
    assert FORECAST_HOURS[0] == 3  # hour 000 has no fluxes or precipitation
    assert 0 not in FORECAST_HOURS
    assert 192 in FORECAST_HOURS
    assert 195 not in FORECAST_HOURS  # the 3-hourly cadence ends at 192
    assert 198 in FORECAST_HOURS
    assert FORECAST_HOURS[-1] == 384
    assert len(FORECAST_HOURS) == 96


def test_explicit_steps_must_be_on_the_geps_schedule():
    assert _forecast_hours("24,18,21") == (18, 21, 24)
    with pytest.raises(RuntimeError, match="195"):
        _forecast_hours("195")
    with pytest.raises(RuntimeError, match="0"):
        _forecast_hours("0")


def test_the_accumulation_window_start_follows_the_cadence_change():
    assert previous_scheduled_hour(24) == 21
    assert previous_scheduled_hour(192) == 189
    assert previous_scheduled_hour(198) == 192  # 6-hourly window across the seam
    assert previous_scheduled_hour(384) == 378


# --- CAPE sentinel -------------------------------------------------------------
#
# GEPS flags "convection not computed" with an exact -1 in CAPE — the HRDPS
# family's sentinel — over ~42 % of the globe on the verification day
# (2026-08-08). It does NOT use RDPS/GDPS's 9999: real GEPS CAPE approaches
# 9999 J/kg (member max 9755 that day), so masking 9999 would erase genuine
# extreme instability. CIN has no sentinel at all.


def test_the_cape_sentinel_is_minus_one_masked_to_absence():
    assert mask_sentinel(-1.0, CAPE_SENTINEL) is None
    # GRIB packing can smear the sentinel; the shared tolerance covers it.
    assert mask_sentinel(-0.7, CAPE_SENTINEL) is None


def test_legitimate_cape_values_survive_the_mask():
    assert mask_sentinel(0.0, CAPE_SENTINEL) == 0.0  # zero CAPE is a measurement
    assert mask_sentinel(9399.0, CAPE_SENTINEL) == 9399.0  # observed member value
    assert mask_sentinel(9999.0, CAPE_SENTINEL) == 9999.0  # not a GEPS sentinel


# --- all-members GRIB sampling --------------------------------------------------
#
# Fixtures are synthesized with ecCodes itself: a 3×3 regular_ll grid around
# Dundee (GEPS's grid type — no rotation, unlike REPS), 21 messages with
# perturbationNumber 0–20 — byte-for-byte real GRIB2. Accumulated fields use
# PDT 11 with a run-origin stepRange, instantaneous fields PDT 1, matching
# the live files' encodings.


def ensemble_message(
    perturbation: int,
    value: float,
    *,
    regular: bool = True,
    uv_relative: int = 0,
    accum_hours: int | None = None,
) -> bytes:
    gid = eccodes.codes_grib_new_from_samples("GRIB2")
    try:
        if regular:
            eccodes.codes_set(gid, "gridType", "regular_ll")
            eccodes.codes_set(gid, "Ni", 3)
            eccodes.codes_set(gid, "Nj", 3)
            eccodes.codes_set(gid, "latitudeOfFirstGridPointInDegrees", 49.2)
            eccodes.codes_set(gid, "longitudeOfFirstGridPointInDegrees", 242.7)
            eccodes.codes_set(gid, "latitudeOfLastGridPointInDegrees", 49.4)
            eccodes.codes_set(gid, "longitudeOfLastGridPointInDegrees", 242.9)
            eccodes.codes_set(gid, "iDirectionIncrementInDegrees", 0.1)
            eccodes.codes_set(gid, "jDirectionIncrementInDegrees", 0.1)
            eccodes.codes_set(gid, "jScansPositively", 1)
            eccodes.codes_set(gid, "uvRelativeToGrid", uv_relative)
        else:
            eccodes.codes_set(gid, "gridType", "rotated_ll")
            eccodes.codes_set(gid, "latitudeOfSouthernPoleInDegrees", -25.6)
            eccodes.codes_set(gid, "longitudeOfSouthernPoleInDegrees", 269.6)
        if accum_hours is None:
            eccodes.codes_set(gid, "productDefinitionTemplateNumber", 1)
        else:
            eccodes.codes_set(gid, "productDefinitionTemplateNumber", 11)
            eccodes.codes_set(gid, "stepType", "accum")
            eccodes.codes_set(gid, "stepRange", f"0-{accum_hours}")
        eccodes.codes_set(gid, "perturbationNumber", perturbation)
        eccodes.codes_set(gid, "numberOfForecastsInEnsemble", MEMBER_COUNT)
        eccodes.codes_set(gid, "typeOfEnsembleForecast", 1 if perturbation == 0 else 4)
        eccodes.codes_set_values(gid, [value] * (9 if regular else 496))
        return eccodes.codes_get_message(gid)
    finally:
        eccodes.codes_release(gid)


def ensemble_file(
    value_for_member,
    members=PERTURBATION_NUMBERS,
    uv_relative: int = 0,
    accum_hours: int | None = None,
) -> bytes:
    return b"".join(
        ensemble_message(
            member,
            value_for_member(member),
            uv_relative=uv_relative,
            accum_hours=accum_hours,
        )
        for member in members
    )


def test_scalar_members_are_keyed_by_grib_perturbation_number():
    members = _sample_scalar_members(
        ensemble_file(lambda member: 100.0 + member), [SITE], "test field"
    )

    assert sorted(members) == list(PERTURBATION_NUMBERS)
    assert members[0]["dundee"] == pytest.approx(100.0)  # perturbationNumber 0 = control
    assert members[20]["dundee"] == pytest.approx(120.0)


def test_a_file_missing_a_member_fails_loudly():
    short = ensemble_file(lambda member: 1.0, members=[m for m in PERTURBATION_NUMBERS if m != 7])

    with pytest.raises(RuntimeError, match="expected 0–20"):
        _sample_scalar_members(short, [SITE], "test field")


def test_a_scalar_file_off_the_regular_grid_fails_loudly():
    with pytest.raises(RuntimeError, match="regular 0.5° grid"):
        _sample_scalar_members(ensemble_message(0, 1.0, regular=False), [SITE], "test field")


def test_wind_members_sample_without_any_rotation():
    members = _sample_wind_members(ensemble_file(lambda member: 2.0 + member), [SITE])

    assert members[3]["dundee"] == pytest.approx(5.0)


def test_grid_relative_wind_components_fail_loudly():
    # GEPS promises earth-relative components (uvRelativeToGrid=0); a grid
    # that starts rotating must not silently skew every bearing.
    with pytest.raises(RuntimeError, match="grid-relative"):
        _sample_wind_members(ensemble_file(lambda member: 1.0, uv_relative=1), [SITE])


# --- aggregation ----------------------------------------------------------------


def member_level(pressure_hpa: int = 850, height_m: float = 1521.0, **overrides) -> dict:
    level = {
        "pressureHpa": pressure_hpa,
        "heightM": height_m,
        "temperatureC": 10.0,
        "dewPointC": 2.0,
        "windSpeedMs": 5.0,
        "windDirectionDeg": 265.0,
    }
    level.update(overrides)
    return level


def member_hour(**overrides) -> dict:
    """A member-profile hour; overrides land in the block that owns the key
    (levels aside, keys are unambiguous between surface and derived). Passing
    capeJkg=None removes the key, the shape derive_windgram_profile gives a
    sentinel-masked member."""
    hour = {
        "validAt": "2026-08-07T21:00:00Z",
        "surface": {
            "pressurePa": 101000.0,
            "temperatureC": 20.0,
            "dewPointC": 8.0,
            "windSpeedMs": 10.0,
            "windDirectionDeg": 265.0,
            "cloudCoverPercent": 20.0,
            "precipitationMmHr": 0.0,
            "sensibleHeatFluxWm2": 300.0,
            "latentHeatFluxWm2": 100.0,
            "capeJkg": 500.0,
            "cinJkg": -25.0,
        },
        "levels": [
            member_level(),
            member_level(
                pressure_hpa=500,
                height_m=5720.0,
                temperatureC=-20.0,
                dewPointC=-38.0,
                windSpeedMs=15.0,
                windDirectionDeg=280.0,
            ),
        ],
        "derived": {
            "boundaryLayerTopM": 1500.0,
            "thermalVelocityMs": 2.0,
            "cloudBaseM": 2400.0,
            "usableLiftTopM": None,
        },
    }
    for key, value in overrides.items():
        if key == "levels":
            hour["levels"] = value
        elif key in hour["derived"]:
            hour["derived"][key] = value
        elif key == "capeJkg" and value is None:
            del hour["surface"]["capeJkg"]
        else:
            hour["surface"][key] = value
    return hour


def test_sentinel_masked_members_stay_out_of_the_cape_ranking_but_are_counted():
    profiles = [
        {"hours": [member_hour(capeJkg=None)]},  # sentinel-masked upstream
        {"hours": [member_hour(capeJkg=800.0)]},
    ]

    (hour,) = _aggregate_hours(profiles)

    assert hour["surface"]["capeJkg"]["members"] == 1
    assert hour["surface"]["capeJkg"]["p50"] == 800.0
    assert hour["surface"]["cinJkg"]["members"] == 2  # CIN has no sentinel


def test_an_hour_no_member_computed_publishes_null_cape_percentiles():
    profiles = [
        {"hours": [member_hour(capeJkg=None)]},
        {"hours": [member_hour(capeJkg=None)]},
    ]

    (hour,) = _aggregate_hours(profiles)

    assert hour["surface"]["capeJkg"] == {
        "members": 0,
        "p10": None,
        "p25": None,
        "p50": None,
        "p75": None,
        "p90": None,
    }


def test_wind_direction_publishes_the_circular_median_not_a_percentile_block():
    profiles = [
        {"hours": [member_hour(windDirectionDeg=350.0)]},
        {"hours": [member_hour(windDirectionDeg=10.0)]},
    ]

    (hour,) = _aggregate_hours(profiles)

    assert hour["surface"]["windDirectionDeg"] == pytest.approx(0.0)
    for level in hour["levels"]:
        assert isinstance(level["windDirectionDeg"], float)


def test_a_level_below_a_members_terrain_counts_only_the_members_that_kept_it():
    profiles = [
        {"hours": [member_hour()]},
        {
            "hours": [
                member_hour(levels=[member_level(pressure_hpa=500, height_m=5740.0)])
            ]
        },
    ]

    (hour,) = _aggregate_hours(profiles)

    lower, upper = hour["levels"]
    assert lower["pressureHpa"] == 850
    assert lower["heightM"]["members"] == 1
    assert upper["pressureHpa"] == 500
    assert upper["heightM"]["members"] == 2


def test_column_limited_scalars_carry_a_ceiled_count():
    profiles = [
        {"hours": [member_hour(boundaryLayerTopM=5720.0)]},  # at its column top
        {"hours": [member_hour(boundaryLayerTopM=2100.0)]},
    ]

    (hour,) = _aggregate_hours(profiles)

    assert hour["derived"]["boundaryLayerTopM"]["ceiledMembers"] == 1
    assert hour["derived"]["boundaryLayerTopM"]["members"] == 2
    assert "ceiledMembers" not in hour["derived"]["cloudBaseM"]


def test_a_small_document_serializes_deterministically():
    profiles = [
        {"hours": [member_hour(levels=[member_level(pressure_hpa=500, height_m=5720.0)])]},
        {
            "hours": [
                member_hour(
                    boundaryLayerTopM=2500.0,
                    capeJkg=900.0,
                    cinJkg=-5.0,
                    cloudBaseM=2600.0,
                    cloudCoverPercent=40.0,
                    dewPointC=10.0,
                    latentHeatFluxWm2=200.0,
                    levels=[
                        member_level(
                            pressure_hpa=500,
                            height_m=5740.0,
                            temperatureC=12.0,
                            dewPointC=4.0,
                            windSpeedMs=7.0,
                            windDirectionDeg=275.0,
                        )
                    ],
                    precipitationMmHr=1.0,
                    pressurePa=102000.0,
                    sensibleHeatFluxWm2=400.0,
                    temperatureC=22.0,
                    thermalVelocityMs=3.0,
                    usableLiftTopM=2200.0,
                    windDirectionDeg=275.0,
                    windSpeedMs=20.0,
                )
            ]
        },
    ]
    document = {
        "schemaVersion": 1,
        "model": "geps",
        "run": {
            "referenceTime": "2026-08-07T12:00:00Z",
            "generatedAt": "2026-08-07T22:00:00Z",
            "members": 21,
        },
        "site": {
            "id": "dundee",
            "name": "Dundee",
            "latitude": 49.291977,
            "longitude": -117.183569,
            "altitudeM": 1485,
            "modelElevationM": 1200.0,
        },
        "semantics": {"precipitation": "windowMeanRate"},
        "hours": _aggregate_hours(profiles),
    }

    assert compact_json(round_document(document)) == (
        '{"schemaVersion":1,"model":"geps",'
        '"run":{"referenceTime":"2026-08-07T12:00:00Z","generatedAt":"2026-08-07T22:00:00Z",'
        '"members":21},'
        '"site":{"id":"dundee","name":"Dundee","latitude":49.291977,"longitude":-117.183569,'
        '"altitudeM":1485,"modelElevationM":1200},'
        '"semantics":{"precipitation":"windowMeanRate"},'
        '"hours":[{"validAt":"2026-08-07T21:00:00Z",'
        '"surface":{'
        '"pressurePa":{"members":2,"p10":101100,"p25":101250,"p50":101500,"p75":101750,"p90":101900},'
        '"temperatureC":{"members":2,"p10":20.2,"p25":20.5,"p50":21,"p75":21.5,"p90":21.8},'
        '"dewPointC":{"members":2,"p10":8.2,"p25":8.5,"p50":9,"p75":9.5,"p90":9.8},'
        '"windSpeedMs":{"members":2,"p10":11,"p25":12.5,"p50":15,"p75":17.5,"p90":19},'
        '"windDirectionDeg":270,'
        '"cloudCoverPercent":{"members":2,"p10":22,"p25":25,"p50":30,"p75":35,"p90":38},'
        '"precipitationMmHr":{"members":2,"p10":0.1,"p25":0.25,"p50":0.5,"p75":0.75,"p90":0.9},'
        '"sensibleHeatFluxWm2":{"members":2,"p10":310,"p25":325,"p50":350,"p75":375,"p90":390},'
        '"latentHeatFluxWm2":{"members":2,"p10":110,"p25":125,"p50":150,"p75":175,"p90":190},'
        '"capeJkg":{"members":2,"p10":540,"p25":600,"p50":700,"p75":800,"p90":860},'
        '"cinJkg":{"members":2,"p10":-23,"p25":-20,"p50":-15,"p75":-10,"p90":-7}},'
        '"levels":[{"pressureHpa":500,'
        '"heightM":{"members":2,"p10":5722,"p25":5725,"p50":5730,"p75":5735,"p90":5738},'
        '"temperatureC":{"members":2,"p10":10.2,"p25":10.5,"p50":11,"p75":11.5,"p90":11.8},'
        '"dewPointC":{"members":2,"p10":2.2,"p25":2.5,"p50":3,"p75":3.5,"p90":3.8},'
        '"windSpeedMs":{"members":2,"p10":5.2,"p25":5.5,"p50":6,"p75":6.5,"p90":6.8},'
        '"windDirectionDeg":270}],'
        '"derived":{'
        '"boundaryLayerTopM":{"ceiledMembers":0,"members":2,"p10":1600,"p25":1750,"p50":2000,"p75":2250,"p90":2400},'
        '"thermalVelocityMs":{"members":2,"p10":2.1,"p25":2.25,"p50":2.5,"p75":2.75,"p90":2.9},'
        '"cloudBaseM":{"members":2,"p10":2420,"p25":2450,"p50":2500,"p75":2550,"p90":2580},'
        '"usableLiftTopM":{"ceiledMembers":0,"members":1,"p10":2200,"p25":2200,"p50":2200,"p75":2200,"p90":2200}}}]}'
    )


# --- end to end: Datamart files → ensemble document ------------------------------
#
# One forecast step, one site, 37 synthetic all-members files served through
# a fake fetch_bytes keyed by the exact URLs the builder must construct — a
# wrong URL is a KeyError, not a silent pass. Member m's values are linear in
# m, so every published percentile is the member at that exact rank.

E2E_HEIGHTS = {1000: 150.0, 925: 800.0, 850: 1500.0, 700: 3100.0, 500: 5700.0}
E2E_TEMPS_K = {1000: 292.65, 925: 286.15, 850: 279.15, 700: 265.15, 500: 242.15}
E2E_SURFACE = {
    # Model terrain, PT000 only, in DECAMETRES — the live file's encoding,
    # metadata notwithstanding — so the builder publishes 1450 m.
    "HGT_SFC_0": lambda m: 145.0,
    "TMP_TGL_2m": lambda m: 293.15 + 0.1 * m,
    "RH_TGL_2m": lambda m: 50.0,
    "PRMSL_MSL_0": lambda m: 101000.0 + 10.0 * m,
    "TCDC_SFC_0": lambda m: 20.0 + m,
    # Members 0–2 report the -1 "not computed" sentinel; 18 members rank.
    "CAPE_SFC_0": lambda m: -1.0 if m < 3 else 100.0 + 10.0 * m,
    # -1 J/kg is a legitimate weak cap in GEPS, never a sentinel.
    "CIN_SFC_0": lambda m: -1.0 - m,
    "UGRD_TGL_10m": lambda m: 3.0 + 0.1 * m,  # westerly: direction 270
    "VGRD_TGL_10m": lambda m: 0.0,
}
# Run-origin accumulations at hour 3 (baseline 0 — hour 000 publishes none):
# SHTFL J/m² → 500 + 10·m W/m² over the 3 h window; APCP mm → 1 + 0.1·m mm/h.
E2E_ACCUMULATED = {
    "SHTFL_SFC_0": lambda m: (500.0 + 10.0 * m) * 3 * 3600,
    "LHTFL_SFC_0": lambda m: (100.0 + m) * 3 * 3600,
    "APCP_SFC_0": lambda m: (1.0 + 0.1 * m) * 3,
}


def e2e_member_value(variable_level: str, member: int) -> float:
    if variable_level in E2E_SURFACE:
        return E2E_SURFACE[variable_level](member)
    if variable_level in E2E_ACCUMULATED:
        return E2E_ACCUMULATED[variable_level](member)
    variable, _, token = variable_level.partition("_ISBL_")
    level = int(token)
    if variable == "HGT":
        return E2E_HEIGHTS[level] + member
    if variable == "TMP":
        return E2E_TEMPS_K[level] + 0.1 * member
    if variable == "RH":
        return 50.0
    if variable == "UGRD":
        return 5.0 + 0.1 * member
    if variable == "VGRD":
        return 0.0
    raise AssertionError(f"unexpected field {variable_level}")


def e2e_file(name: str, forecast_hour: int) -> bytes:
    accum = name in E2E_ACCUMULATED
    return ensemble_file(
        lambda m, name=name: e2e_member_value(name, m),
        accum_hours=forecast_hour if accum else None,
    )


def e2e_hour_fields() -> list[str]:
    fields = [name for name in E2E_SURFACE if name != "HGT_SFC_0"]
    fields += list(E2E_ACCUMULATED)
    for level in PRESSURE_LEVELS:
        fields += [f"{prefix}_ISBL_{level:04d}" for prefix in ("HGT", "TMP", "RH", "UGRD", "VGRD")]
    return fields


def e2e_files(terrain=E2E_SURFACE["HGT_SFC_0"]) -> dict[str, bytes]:
    files = {_file_url("HGT_SFC_0", "20260807", "00", 0): ensemble_file(terrain)}
    for name in e2e_hour_fields():
        files[_file_url(name, "20260807", "00", 3)] = e2e_file(name, 3)
    return files


def test_a_forecast_step_flows_from_datamart_files_to_the_ensemble_document(monkeypatch):
    files = e2e_files()
    fetched: list[str] = []

    def fake_fetch(url, stats=None):
        fetched.append(url)
        return files[url]  # a wrong URL fails the test loudly

    monkeypatch.setattr("windgram.builders.geps.fetch_bytes", fake_fetch)

    result = _build_documents(
        "2026-08-07T00:00:00Z",
        [{"forecastHour": 3, "validAt": "2026-08-07T03:00:00Z"}],
        [SITE],
        DownloadStats(),
    )

    # Every file fetched exactly once; hour 000 — which has no flux or
    # precipitation files — is touched only for terrain.
    assert sorted(fetched) == sorted(files)
    assert [url for url in fetched if "_P000_" in url] == [
        _file_url("HGT_SFC_0", "20260807", "00", 0)
    ]

    (document,) = result["documents"]
    # 145.0 decametres in the file → 1450 m published.
    assert document["site"]["modelElevationM"] == pytest.approx(1450.0)
    # Ensemble envelope: the member count in run, the transport semantics
    # (no gust key — GEPS publishes none) between site and hours.
    assert document["run"]["members"] == 21
    assert document["semantics"] == {"precipitation": "windowMeanRate"}
    assert list(document) == ["schemaVersion", "model", "run", "site", "semantics", "hours"]
    (hour,) = document["hours"]

    surface = hour["surface"]
    assert surface["temperatureC"]["members"] == 21
    assert surface["temperatureC"]["p50"] == pytest.approx(21.0, abs=1e-3)
    assert surface["dewPointC"]["p50"] == pytest.approx(
        21.0 - dew_point_depression(21.0, 50.0), abs=1e-3
    )
    assert surface["pressurePa"]["p50"] == pytest.approx(101100.0, abs=1e-3)
    assert surface["cloudCoverPercent"]["p90"] == pytest.approx(38.0, abs=1e-3)
    assert surface["windSpeedMs"]["p50"] == pytest.approx(4.0, abs=1e-3)
    assert surface["windDirectionDeg"] == pytest.approx(270.0, abs=1e-6)

    # Run-origin accumulations, deaveraged over the first 3 h window against
    # a seeded zero baseline: W/m² and mm/h are linear in the member.
    assert surface["sensibleHeatFluxWm2"]["members"] == 21
    assert surface["sensibleHeatFluxWm2"]["p50"] == pytest.approx(600.0, abs=1e-6)
    assert surface["latentHeatFluxWm2"]["p50"] == pytest.approx(110.0, abs=1e-6)
    assert surface["precipitationMmHr"]["p50"] == pytest.approx(2.0, abs=1e-6)
    assert surface["precipitationMmHr"]["p10"] == pytest.approx(1.2, abs=1e-6)

    # The marquee: ensemble storm risk. Three sentinel members stay out of
    # the CAPE ranking (members honest at 18, percentiles over the defined
    # 130–300 J/kg spread); CIN ranks all 21, its exact -1 member included.
    cape = surface["capeJkg"]
    assert cape["members"] == 18
    assert cape["p10"] == pytest.approx(147.0, abs=1e-6)
    assert cape["p50"] == pytest.approx(215.0, abs=1e-6)
    assert cape["p90"] == pytest.approx(283.0, abs=1e-6)
    cin = surface["cinJkg"]
    assert cin["members"] == 21
    assert cin["p50"] == pytest.approx(-11.0, abs=1e-6)
    assert cin["p90"] == pytest.approx(-3.0, abs=1e-6)

    # The ensemble sounding: the levels above the model surface, ascending,
    # each field a percentile block across the 21 members, direction a
    # consensus. 1000 and 925 hPa sit below the 1450 m terrain — the live
    # behaviour at these mountain sites — and every member's filter drops
    # them, so they are not published at all.
    assert [level["pressureHpa"] for level in hour["levels"]] == [850, 700, 500]
    level_850 = hour["levels"][0]
    assert level_850["heightM"]["members"] == 21
    assert level_850["heightM"]["p50"] == pytest.approx(1510.0, abs=1e-3)
    assert level_850["temperatureC"]["p50"] == pytest.approx(7.0, abs=1e-3)
    assert level_850["windSpeedMs"]["p50"] == pytest.approx(6.0, abs=1e-3)
    assert level_850["windDirectionDeg"] == pytest.approx(270.0, abs=1e-6)

    # Derivations ran per member, 21 atmospheres deep, before any ranking.
    assert hour["derived"]["boundaryLayerTopM"]["members"] == 21
    assert hour["derived"]["thermalVelocityMs"]["p50"] is not None


def test_a_six_hourly_tail_step_differences_accumulations_across_its_own_window(monkeypatch):
    # Hour 198 is the first 6-hourly step; its accumulation window starts at
    # 192 — the previous *scheduled* hour, not 195 — and the deltas divide by
    # six hours, not three.
    baseline = {
        "SHTFL_SFC_0": lambda m: 1.0e6,
        "LHTFL_SFC_0": lambda m: 2.0e6,
        "APCP_SFC_0": lambda m: 5.0,
    }
    files = {
        _file_url("HGT_SFC_0", "20260807", "00", 0): ensemble_file(E2E_SURFACE["HGT_SFC_0"])
    }
    for name, accumulated in baseline.items():
        files[_file_url(name, "20260807", "00", 192)] = ensemble_file(
            accumulated, accum_hours=192
        )
    for name in e2e_hour_fields():
        if name in baseline:
            content = ensemble_file(
                lambda m, name=name: baseline[name](m)
                + (
                    (10.0 + m) * 6 * 3600  # → mean 10 + m W/m²
                    if name != "APCP_SFC_0"
                    else (0.5 + 0.1 * m) * 6  # → 0.5 + 0.1·m mm/h
                ),
                accum_hours=198,
            )
        else:
            content = e2e_file(name, 198)
        files[_file_url(name, "20260807", "00", 198)] = content
    fetched: list[str] = []

    def fake_fetch(url, stats=None):
        fetched.append(url)
        return files[url]

    monkeypatch.setattr("windgram.builders.geps.fetch_bytes", fake_fetch)

    result = _build_documents(
        "2026-08-07T00:00:00Z",
        [{"forecastHour": 198, "validAt": "2026-08-15T06:00:00Z"}],
        [SITE],
        DownloadStats(),
    )

    assert sorted(fetched) == sorted(files)  # exactly the window ends, once each

    (document,) = result["documents"]
    (hour,) = document["hours"]
    assert hour["surface"]["sensibleHeatFluxWm2"]["p50"] == pytest.approx(20.0, abs=1e-6)
    assert hour["surface"]["latentHeatFluxWm2"]["p50"] == pytest.approx(20.0, abs=1e-6)
    assert hour["surface"]["precipitationMmHr"]["p50"] == pytest.approx(1.5, abs=1e-6)


# --- terrain units and the model-elevation sanity guard ---------------------------
#
# The live CMC_geps-raw HGT_SFC file is encoded in decametres while its GRIB
# metadata claims metres (verified 2026-08-08: Dundee read 153.6 raw against
# its 1485 m site with a global field maximum of 586.3 — ×10 is smoothed 0.5°
# terrain everywhere, Himalaya 579.8 → 5798 m; ×1 puts the whole planet below
# 600 m). The builder scales the field to metres and then refuses a published
# datum that cannot be terrain — every published height derives from it.


def test_surface_orography_decametres_publish_as_metres(monkeypatch):
    # 153.6 is the live control-member reading at Dundee on 2026-08-08; the
    # pre-fix builder published it verbatim as 153.6 m.
    files = e2e_files(terrain=lambda m: 153.6)
    monkeypatch.setattr(
        "windgram.builders.geps.fetch_bytes", lambda url, stats=None: files[url]
    )

    result = _build_documents(
        "2026-08-07T00:00:00Z",
        [{"forecastHour": 3, "validAt": "2026-08-07T03:00:00Z"}],
        [SITE],
        DownloadStats(),
    )

    (document,) = result["documents"]
    assert document["site"]["modelElevationM"] == pytest.approx(1536.0)


def test_the_builder_refuses_a_terrain_datum_below_every_site(monkeypatch):
    # 15.36 dam → 153.6 m: the exact datum the decametre bug published, and
    # what the live file would yield again if the scaling were ever dropped.
    files = e2e_files(terrain=lambda m: 15.36)
    monkeypatch.setattr(
        "windgram.builders.geps.fetch_bytes", lambda url, stats=None: files[url]
    )

    with pytest.raises(RuntimeError, match="units or indexing error"):
        _build_documents(
            "2026-08-07T00:00:00Z",
            [{"forecastHour": 3, "validAt": "2026-08-07T03:00:00Z"}],
            [SITE],
            DownloadStats(),
        )


def test_the_guard_accepts_coarse_grid_smoothing():
    # The live datum after the fix: 1536 m against the 1485 m site.
    _require_plausible_model_elevation({0: {"dundee": 1536.0}}, [SITE])


def test_one_summit_site_towering_over_the_model_surface_is_not_an_error():
    # A 0.5° grid legitimately smooths a single summit site more than a
    # kilometre above the model surface; the guard needs EVERY site wildly
    # below before it calls the datum broken.
    summit = {**SITE, "slug": "summit", "name": "Summit", "elevationM": 3400}
    _require_plausible_model_elevation(
        {0: {"dundee": 1536.0, "summit": 1800.0}}, [SITE, summit]
    )


def test_a_datum_wildly_below_every_site_fails_loudly():
    with pytest.raises(RuntimeError, match="below the catalogued elevation at every site"):
        _require_plausible_model_elevation({0: {"dundee": 153.6}}, [SITE])


def test_a_datum_above_any_earth_terrain_fails_loudly():
    # The inverse regression: were ECCC to re-encode the file in genuine
    # metres, the ×10 scaling would publish a ~15 km surface.
    with pytest.raises(RuntimeError, match="higher than any Earth terrain"):
        _require_plausible_model_elevation({0: {"dundee": 15360.0}}, [SITE])

import math

import eccodes
import pytest

from windgram.build_reps import (
    FORECAST_HOURS,
    MEMBER_COUNT,
    PERTURBATION_NUMBERS,
    PRESSURE_LEVELS,
    STEP_HOURS,
    WIND_LEVEL_TOKENS,
    _aggregate_hours,
    _build_documents,
    _file_url,
    _forecast_hours,
    _sample_scalar_members,
    _sample_wind_members,
)
from windgram.datamart import DownloadStats
from windgram.ensemble import circular_median, percentile
from windgram.grib import earth_wind, split_messages
from windgram.moisture import dew_point_depression
from windgram.publish import compact_json, round_document

REPS_SOUTH_POLE = (-25.64728, 269.555534)
DUNDEE = (49.291977, -117.183569)
SITE = {
    "slug": "dundee",
    "name": "Dundee",
    "latitude": DUNDEE[0],
    "longitude": DUNDEE[1],
    "elevationM": 1485,
    "timeZone": "America/Vancouver",
}


# --- percentiles -----------------------------------------------------------


def test_the_published_points_land_on_exact_ranks_for_21_members():
    values = sorted(float(v) for v in range(21))

    assert percentile(values, 10) == 2
    assert percentile(values, 25) == 5
    assert percentile(values, 50) == 10
    assert percentile(values, 75) == 15
    assert percentile(values, 90) == 18


def test_percentiles_interpolate_linearly_between_ranks():
    # rank = 3 × 25/100 = 0.75, between 1 and 2.
    assert percentile([1.0, 2.0, 3.0, 4.0], 25) == 1.75


def test_ties_collapse_to_the_tied_value():
    assert percentile([5.0, 5.0, 5.0, 5.0, 9.0], 50) == 5.0


def test_a_single_value_is_every_percentile():
    for point in (10, 25, 50, 75, 90):
        assert percentile([7.5], point) == 7.5


def test_percentile_of_nothing_raises():
    with pytest.raises(ValueError):
        percentile([], 50)


# --- circular median ---------------------------------------------------------


def test_circular_median_is_the_plain_median_away_from_the_wrap():
    assert circular_median([80.0, 90.0, 100.0]) == pytest.approx(90.0)
    assert circular_median([272.5]) == pytest.approx(272.5)


def test_circular_median_crosses_the_wrap():
    # A rank across raw bearings would call this ~147°; the true consensus
    # of a cluster straddling north is 5°.
    assert circular_median([350.0, 355.0, 5.0, 10.0, 15.0]) == pytest.approx(5.0)


def test_two_bearings_bisect_their_short_arc():
    assert circular_median([350.0, 10.0]) == pytest.approx(0.0)
    assert circular_median([80.0, 100.0]) == pytest.approx(90.0)


def test_a_stray_member_cannot_drag_the_consensus_off_the_cluster():
    # The vector MEAN of this ensemble swings ~11° toward the outlier; the
    # median stays on the cluster.
    assert circular_median([355.0, 0.0, 5.0, 170.0]) == pytest.approx(2.5)


def test_circular_median_of_nothing_raises():
    with pytest.raises(ValueError):
        circular_median([])


# --- dew point depression (shared moisture module) ---------------------------


def test_dew_point_depression_matches_the_gfs_reference_values():
    assert dew_point_depression(20.0, 50.0) == pytest.approx(20.0 - 9.26, abs=0.01)
    assert dew_point_depression(15.0, 100.0) == pytest.approx(0.0, abs=1e-9)


# --- wind rotation ---------------------------------------------------------


def test_an_unrotated_grid_leaves_the_wind_alone():
    # A south pole at the true south pole is the identity rotation.
    east, north = earth_wind(3.0, 4.0, 49.3, -117.2, -90.0, 0.0)

    assert east == pytest.approx(3.0, abs=1e-12)
    assert north == pytest.approx(4.0, abs=1e-12)


def test_an_equatorial_pole_turns_the_wind_a_quarter_circle():
    # South pole of rotation on the equator at 0°E puts the rotated north
    # pole at (0°, 180°). At the geographic point (0°, 90°E) grid-north
    # points toward (0°, 180°) — due true east — and grid-east points at the
    # rotated south pole — due true south.
    east, north = earth_wind(1.0, 0.0, 0.0, 90.0, 0.0, 0.0)
    assert (east, north) == (pytest.approx(0.0, abs=1e-12), pytest.approx(-1.0, abs=1e-12))

    east, north = earth_wind(0.0, 1.0, 0.0, 90.0, 0.0, 0.0)
    assert (east, north) == (pytest.approx(1.0, abs=1e-12), pytest.approx(0.0, abs=1e-12))


def test_rotation_conserves_wind_speed_on_the_reps_grid():
    east, north = earth_wind(3.0, -4.0, *DUNDEE, *REPS_SOUTH_POLE)

    assert math.hypot(east, north) == pytest.approx(5.0, abs=1e-12)


def test_grid_north_points_along_the_bearing_to_the_rotated_pole():
    # Independent geometry: grid-north lies on the rotated meridian, so a
    # pure grid-north wind must point along the great-circle initial bearing
    # from the site to the rotated north pole.
    pole_latitude, pole_longitude = -REPS_SOUTH_POLE[0], REPS_SOUTH_POLE[1] - 180.0
    lat1, lon1 = map(math.radians, DUNDEE)
    lat2, lon2 = math.radians(pole_latitude), math.radians(pole_longitude)
    bearing = math.degrees(
        math.atan2(
            math.sin(lon2 - lon1) * math.cos(lat2),
            math.cos(lat1) * math.sin(lat2)
            - math.sin(lat1) * math.cos(lat2) * math.cos(lon2 - lon1),
        )
    ) % 360

    east, north = earth_wind(0.0, 1.0, *DUNDEE, *REPS_SOUTH_POLE)
    points_toward = math.degrees(math.atan2(east, north)) % 360

    assert points_toward == pytest.approx(bearing, abs=1e-9)


# --- GRIB message splitting -------------------------------------------------


def fake_message(payload: bytes) -> bytes:
    body = b"\x00\x00\x02\x02" + payload + b"7777"
    length = 4 + 4 + 8 + len(body)
    return b"GRIB" + b"\x00\x00\x02\x02" + length.to_bytes(8, "big") + body


def test_split_messages_returns_each_stacked_member():
    first, second = fake_message(b"member zero"), fake_message(b"one")

    assert split_messages(first + second) == [first, second]


def test_misaligned_bytes_fail_loudly():
    with pytest.raises(ValueError, match="misaligned"):
        split_messages(b"JUNK" + fake_message(b"x"))


def test_a_truncated_message_fails_loudly():
    with pytest.raises(ValueError, match="truncated"):
        split_messages(fake_message(b"x")[:-2])


# --- Datamart URLs and schedule ----------------------------------------------


def test_datamart_urls_follow_the_msc_naming_scheme():
    assert _file_url("TMP_ISBL-0850", "20260807", "12", 24) == (
        "https://dd.weather.gc.ca/20260807/WXO-DD/ensemble/reps/10km/grib2/12/024/"
        "20260807T12Z_MSC_REPS_TMP_ISBL-0850_RLatLon0.09x0.09_PT024H.grib2"
    )


def test_datamart_urls_honour_the_base_override(monkeypatch):
    monkeypatch.setenv("WINDGRAM_DATAMART_BASE", "https://hpfx.collab.science.gc.ca")
    assert _file_url("TMP_ISBL-0850", "20260807", "12", 24).startswith(
        "https://hpfx.collab.science.gc.ca/20260807/WXO-DD/ensemble/reps/"
    )


def test_every_published_level_has_a_wind_file_token():
    # 1000 hPa is its own four digits — the token is ISBL-1000, not ISBL-01000.
    assert WIND_LEVEL_TOKENS["ISBL-1000"] == 1000
    assert WIND_LEVEL_TOKENS["AGL-10m"] is None
    assert sorted(token for token in WIND_LEVEL_TOKENS if token != "AGL-10m") == sorted(
        f"ISBL-{level:04d}" for level in PRESSURE_LEVELS
    )


def test_the_schedule_starts_after_hour_zero_which_has_no_fluxes():
    assert FORECAST_HOURS[0] == STEP_HOURS
    assert 0 not in FORECAST_HOURS
    with pytest.raises(RuntimeError, match="0"):
        _forecast_hours("0")


def test_explicit_steps_must_be_on_the_three_hourly_schedule():
    assert _forecast_hours("24,18,21") == (18, 21, 24)
    with pytest.raises(RuntimeError, match="17"):
        _forecast_hours("17")


# --- all-members GRIB sampling ------------------------------------------------
#
# Fixtures are synthesized with ecCodes itself: a 3×3 rotated_ll grid around
# Dundee with the identity rotation (south pole at the true south pole), 21
# messages with perturbationNumber 0–20 — byte-for-byte real GRIB2, small
# enough to build per test, and the identity pole makes expected winds equal
# to the raw components.


def ensemble_message(
    perturbation: int, value: float, *, rotated: bool = True, uv_relative: int = 1
) -> bytes:
    gid = eccodes.codes_grib_new_from_samples("GRIB2")
    try:
        if rotated:
            eccodes.codes_set(gid, "gridType", "rotated_ll")
            eccodes.codes_set(gid, "Ni", 3)
            eccodes.codes_set(gid, "Nj", 3)
            eccodes.codes_set(gid, "latitudeOfFirstGridPointInDegrees", 49.2)
            eccodes.codes_set(gid, "longitudeOfFirstGridPointInDegrees", 242.7)
            eccodes.codes_set(gid, "latitudeOfLastGridPointInDegrees", 49.4)
            eccodes.codes_set(gid, "longitudeOfLastGridPointInDegrees", 242.9)
            eccodes.codes_set(gid, "iDirectionIncrementInDegrees", 0.1)
            eccodes.codes_set(gid, "jDirectionIncrementInDegrees", 0.1)
            eccodes.codes_set(gid, "jScansPositively", 1)
            eccodes.codes_set(gid, "latitudeOfSouthernPoleInDegrees", -90.0)
            eccodes.codes_set(gid, "longitudeOfSouthernPoleInDegrees", 0.0)
            eccodes.codes_set(gid, "angleOfRotationInDegrees", 0.0)
            eccodes.codes_set(gid, "uvRelativeToGrid", uv_relative)
        eccodes.codes_set(gid, "productDefinitionTemplateNumber", 1)
        eccodes.codes_set(gid, "perturbationNumber", perturbation)
        eccodes.codes_set(gid, "numberOfForecastsInEnsemble", MEMBER_COUNT)
        eccodes.codes_set(gid, "typeOfEnsembleForecast", 1 if perturbation == 0 else 4)
        eccodes.codes_set_values(gid, [value] * (9 if rotated else 496))
        return eccodes.codes_get_message(gid)
    finally:
        eccodes.codes_release(gid)


def ensemble_file(value_for_member, members=PERTURBATION_NUMBERS, uv_relative: int = 1) -> bytes:
    return b"".join(
        ensemble_message(member, value_for_member(member), uv_relative=uv_relative)
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


def test_a_scalar_file_off_the_rotated_grid_fails_loudly():
    with pytest.raises(RuntimeError, match="rotated grid"):
        _sample_scalar_members(ensemble_message(0, 1.0, rotated=False), [SITE], "test field")


def test_wind_members_carry_the_rotation_pole_alongside_the_components():
    members = _sample_wind_members(ensemble_file(lambda member: 2.0 + member), [SITE])

    assert members[3]["southPoleLatitude"] == pytest.approx(-90.0)
    assert members[3]["southPoleLongitude"] == pytest.approx(0.0)
    assert members[3]["values"]["dundee"] == pytest.approx(5.0)


def test_earth_relative_wind_components_fail_loudly():
    with pytest.raises(RuntimeError, match="earth-relative"):
        _sample_wind_members(ensemble_file(lambda member: 1.0, uv_relative=0), [SITE])


# --- aggregation and serialization ------------------------------------------


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
    """A member-profile hour; overrides land in the block that owns the
    key (levels aside, keys are unambiguous between surface and derived)."""
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
        else:
            hour["surface"][key] = value
    return hour


def test_null_members_stay_out_of_the_ranking_but_are_counted():
    profiles = [
        {"hours": [member_hour(usableLiftTopM=None)]},
        {"hours": [member_hour(usableLiftTopM=2200.0)]},
    ]

    (hour,) = _aggregate_hours(profiles)

    assert hour["derived"]["usableLiftTopM"]["members"] == 1
    assert hour["derived"]["usableLiftTopM"]["p50"] == 2200.0
    assert hour["derived"]["boundaryLayerTopM"]["members"] == 2


def test_all_null_scalars_publish_null_percentiles():
    profiles = [
        {"hours": [member_hour(boundaryLayerTopM=None, usableLiftTopM=None)]},
        {"hours": [member_hour(boundaryLayerTopM=None, usableLiftTopM=None)]},
    ]

    (hour,) = _aggregate_hours(profiles)

    assert hour["derived"]["boundaryLayerTopM"] == {
        "ceiledMembers": 0,
        "members": 0,
        "p10": None,
        "p25": None,
        "p50": None,
        "p75": None,
        "p90": None,
    }


def test_surface_dew_point_joins_the_percentile_scalars():
    profiles = [
        {"hours": [member_hour(dewPointC=8.0)]},
        {"hours": [member_hour(dewPointC=10.0)]},
    ]

    (hour,) = _aggregate_hours(profiles)

    assert hour["surface"]["dewPointC"]["members"] == 2
    assert hour["surface"]["dewPointC"]["p50"] == 9.0


def test_wind_direction_publishes_the_circular_median_not_a_percentile_block():
    profiles = [
        {"hours": [member_hour(windDirectionDeg=350.0)]},
        {"hours": [member_hour(windDirectionDeg=10.0)]},
    ]

    (hour,) = _aggregate_hours(profiles)

    assert hour["surface"]["windDirectionDeg"] == pytest.approx(0.0)
    for level in hour["levels"]:
        assert isinstance(level["windDirectionDeg"], float)


# --- ensemble sounding levels -------------------------------------------------


def test_levels_aggregate_into_percentile_blocks_per_pressure():
    profiles = [
        {"hours": [member_hour()]},
        {
            "hours": [
                member_hour(
                    levels=[
                        member_level(height_m=1541.0, temperatureC=12.0, windDirectionDeg=275.0),
                        member_level(pressure_hpa=500, height_m=5740.0, temperatureC=-18.0),
                    ]
                )
            ]
        },
    ]

    (hour,) = _aggregate_hours(profiles)

    lower, upper = hour["levels"]  # ascending height
    assert lower["pressureHpa"] == 850
    assert upper["pressureHpa"] == 500
    assert lower["heightM"] == {
        "members": 2,
        "p10": 1523.0,
        "p25": 1526.0,
        "p50": 1531.0,
        "p75": 1536.0,
        "p90": 1539.0,
    }
    assert lower["temperatureC"]["p50"] == 11.0
    assert lower["windDirectionDeg"] == pytest.approx(270.0)
    assert upper["temperatureC"]["p50"] == -19.0


def test_a_level_below_a_members_terrain_counts_only_the_members_that_kept_it():
    # Member B's filtered column dropped 850 hPa (below its model surface);
    # the level still publishes, with the membership honest about it.
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


def test_a_level_no_member_kept_is_not_published():
    profiles = [
        {"hours": [member_hour(levels=[member_level(pressure_hpa=500, height_m=5720.0)])]},
        {"hours": [member_hour(levels=[member_level(pressure_hpa=500, height_m=5740.0)])]},
    ]

    (hour,) = _aggregate_hours(profiles)

    assert [level["pressureHpa"] for level in hour["levels"]] == [500]


# --- ceiling censoring --------------------------------------------------------


def test_fully_ceiled_hours_count_every_member_and_keep_percentiles():
    # Both members clamped at the top of their own column — the percentiles
    # survive as lower bounds and ceiledMembers says they are censored.
    profiles = [
        {"hours": [member_hour(boundaryLayerTopM=5720.0)]},
        {
            "hours": [
                member_hour(
                    boundaryLayerTopM=5740.0,
                    levels=[member_level(pressure_hpa=500, height_m=5740.0)],
                )
            ]
        },
    ]

    (hour,) = _aggregate_hours(profiles)

    assert hour["derived"]["boundaryLayerTopM"]["ceiledMembers"] == 2
    assert hour["derived"]["boundaryLayerTopM"]["members"] == 2
    assert hour["derived"]["boundaryLayerTopM"]["p50"] == 5730.0


def test_partially_ceiled_hours_count_only_the_clamped_members():
    profiles = [
        {"hours": [member_hour(usableLiftTopM=5720.0)]},  # at its column top
        {"hours": [member_hour(usableLiftTopM=3400.0)]},  # measured below it
        {"hours": [member_hour(usableLiftTopM=None)]},  # no lift: in neither count
    ]

    (hour,) = _aggregate_hours(profiles)

    assert hour["derived"]["usableLiftTopM"]["ceiledMembers"] == 1
    assert hour["derived"]["usableLiftTopM"]["members"] == 2


def test_uncensored_hours_publish_zero_ceiled_members():
    profiles = [
        {"hours": [member_hour(boundaryLayerTopM=2100.0, usableLiftTopM=2500.0)]},
        {"hours": [member_hour(boundaryLayerTopM=2300.0, usableLiftTopM=2900.0)]},
    ]

    (hour,) = _aggregate_hours(profiles)

    assert hour["derived"]["boundaryLayerTopM"]["ceiledMembers"] == 0
    assert hour["derived"]["usableLiftTopM"]["ceiledMembers"] == 0


def test_the_ceiling_check_tolerates_the_float_round_trip():
    profiles = [
        {"hours": [member_hour(boundaryLayerTopM=5720.0 - 0.4)]},  # clamped, re-added
        {"hours": [member_hour(boundaryLayerTopM=5720.0 - 0.6)]},  # genuinely below
    ]

    (hour,) = _aggregate_hours(profiles)

    assert hour["derived"]["boundaryLayerTopM"]["ceiledMembers"] == 1


def test_only_column_limited_scalars_carry_a_ceiled_count():
    profiles = [{"hours": [member_hour()]}, {"hours": [member_hour()]}]

    (hour,) = _aggregate_hours(profiles)

    assert "ceiledMembers" in hour["derived"]["boundaryLayerTopM"]
    assert "ceiledMembers" in hour["derived"]["usableLiftTopM"]
    assert "ceiledMembers" not in hour["derived"]["cloudBaseM"]
    assert "ceiledMembers" not in hour["derived"]["thermalVelocityMs"]


def test_a_small_document_serializes_deterministically():
    profiles = [
        {"hours": [member_hour(levels=[member_level(pressure_hpa=500, height_m=5720.0)])]},
        {
            "hours": [
                member_hour(
                    boundaryLayerTopM=2500.0,
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
        "model": "reps",
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
        '{"schemaVersion":1,"model":"reps",'
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
        '"latentHeatFluxWm2":{"members":2,"p10":110,"p25":125,"p50":150,"p75":175,"p90":190}},'
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


# --- end to end: Datamart files → ensemble document ---------------------------
#
# One forecast step, one site, 35 synthetic all-members files served through
# a fake fetch_bytes keyed by the exact URLs the builder must construct — a
# wrong URL is a KeyError, not a silent pass. Member m's values are linear in
# m, so every published percentile is the member at that exact rank.

E2E_HEIGHTS = {1000: 150.0, 925: 800.0, 850: 1500.0, 700: 3100.0, 500: 5700.0}
E2E_TEMPS_K = {1000: 292.65, 925: 286.15, 850: 279.15, 700: 265.15, 500: 242.15}
E2E_SURFACE = {
    "HGT_SFC": lambda m: 100.0,  # model terrain, PT000 only
    "TMP_AGL-2m": lambda m: 293.15 + 0.1 * m,
    "RH_AGL-2m": lambda m: 50.0,
    "PRMSL_MSL": lambda m: 101000.0 + 10.0 * m,
    "TCDC_SFC": lambda m: 20.0 + m,
    "SHTFL_SFC": lambda m: 300.0 + m,
    "LHTFL_SFC": lambda m: 100.0 + m,
    "APCP_SFC": lambda m: 3.0 + 0.3 * m,  # run total; step delta ÷ 3 h → mm/h
    "UGRD_AGL-10m": lambda m: 3.0 + 0.1 * m,  # westerly: direction 270
    "VGRD_AGL-10m": lambda m: 0.0,
}


def e2e_member_value(variable_level: str, member: int) -> float:
    if variable_level in E2E_SURFACE:
        return E2E_SURFACE[variable_level](member)
    variable, _, token = variable_level.partition("_ISBL-")
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


def test_a_forecast_step_flows_from_datamart_files_to_the_ensemble_document(monkeypatch):
    files = {
        _file_url("HGT_SFC", "20260807", "00", 0): ensemble_file(E2E_SURFACE["HGT_SFC"])
    }
    hour_3_fields = [name for name in E2E_SURFACE if name != "HGT_SFC"]
    for level in PRESSURE_LEVELS:
        hour_3_fields += [f"{prefix}_ISBL-{level:04d}" for prefix in ("HGT", "TMP", "RH", "UGRD", "VGRD")]
    for name in hour_3_fields:
        files[_file_url(name, "20260807", "00", 3)] = ensemble_file(
            lambda m, name=name: e2e_member_value(name, m)
        )
    fetched: list[str] = []

    def fake_fetch(url, stats=None):
        fetched.append(url)
        return files[url]  # a wrong URL fails the test loudly

    monkeypatch.setattr("windgram.build_reps.fetch_bytes", fake_fetch)

    result = _build_documents(
        "2026-08-07T00:00:00Z",
        [{"forecastHour": 3, "validAt": "2026-08-07T03:00:00Z"}],
        [SITE],
        DownloadStats(),
    )

    # Every file fetched exactly once; hour 000 — which has no flux or
    # precipitation files — is touched only for terrain.
    assert sorted(fetched) == sorted(files)
    assert [url for url in fetched if "PT000H" in url] == [
        _file_url("HGT_SFC", "20260807", "00", 0)
    ]

    (document,) = result["documents"]
    assert document["site"]["modelElevationM"] == pytest.approx(100.0)
    # The catalogue's timezone echo rides on the ensemble document too.
    assert document["site"]["timeZone"] == "America/Vancouver"
    # Ensemble envelope: the member count in run, the transport semantics
    # (no gust key — REPS publishes none) between site and hours.
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
    # mm/h: the 3 h run-total delta (baseline 0, hour 000 publishes no APCP)
    # divided by the window.
    assert surface["precipitationMmHr"]["p50"] == pytest.approx(2.0, abs=1e-3)
    assert surface["precipitationMmHr"]["p10"] == pytest.approx(1.2, abs=1e-3)
    assert surface["windSpeedMs"]["p50"] == pytest.approx(4.0, abs=1e-3)
    assert surface["windDirectionDeg"] == pytest.approx(270.0, abs=1e-6)

    # The ensemble sounding: all five REPS pilot-band levels, ascending, each
    # field a percentile block across the 21 members, direction a consensus.
    assert [level["pressureHpa"] for level in hour["levels"]] == [1000, 925, 850, 700, 500]
    level_850 = hour["levels"][2]
    assert level_850["heightM"]["members"] == 21
    assert level_850["heightM"]["p50"] == pytest.approx(1510.0, abs=1e-3)
    assert level_850["temperatureC"]["p50"] == pytest.approx(7.0, abs=1e-3)
    assert level_850["dewPointC"]["p50"] == pytest.approx(
        7.0 - dew_point_depression(7.0, 50.0), abs=1e-3
    )
    assert level_850["windSpeedMs"]["p50"] == pytest.approx(6.0, abs=1e-3)
    assert level_850["windDirectionDeg"] == pytest.approx(270.0, abs=1e-6)

    # Derivations ran per member, 21 atmospheres deep, before any ranking.
    assert hour["derived"]["boundaryLayerTopM"]["members"] == 21
    assert hour["derived"]["thermalVelocityMs"]["p50"] is not None

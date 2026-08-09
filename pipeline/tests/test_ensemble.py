import pytest

from windgram.ensemble import (
    aggregate_member_profiles,
    circular_median,
    count_ceiled_members,
    percentile,
    percentile_block,
)


def level(pressure_hpa: int, height_m: float, **overrides) -> dict:
    return {
        "pressureHpa": pressure_hpa,
        "heightM": height_m,
        "temperatureC": 5.0,
        "dewPointC": 1.0,
        "windSpeedMs": 6.0,
        "windDirectionDeg": 270.0,
        **overrides,
    }


def member_hour(
    *,
    temperature_c: float,
    direction_deg: float,
    levels: list[dict],
    boundary_layer_top_m: float | None,
    cloud_base_m: float | None,
    cape_jkg: float | None = None,
) -> dict:
    surface = {
        "temperatureC": temperature_c,
        "windDirectionDeg": direction_deg,
    }
    if cape_jkg is not None:
        surface["capeJkg"] = cape_jkg
    return {
        "validAt": "2026-08-09T18:00:00Z",
        "surface": surface,
        "levels": levels,
        "derived": {
            "boundaryLayerTopM": boundary_layer_top_m,
            "cloudBaseM": cloud_base_m,
        },
    }


def aggregate(profiles: list[dict], *, optional_surface_scalars=()) -> list[dict]:
    return aggregate_member_profiles(
        profiles,
        surface_scalars=("temperatureC", "windDirectionDeg", "capeJkg"),
        level_scalars=("heightM", "temperatureC", "dewPointC", "windSpeedMs"),
        derived_scalars=("boundaryLayerTopM", "cloudBaseM"),
        censored_scalars=("boundaryLayerTopM",),
        optional_surface_scalars=optional_surface_scalars,
    )


def test_percentile_interpolates_sorted_values_and_rejects_an_empty_sample():
    assert percentile([1.0, 2.0, 3.0, 4.0], 25) == pytest.approx(1.75)
    with pytest.raises(ValueError, match="no values"):
        percentile([], 50)


def test_circular_median_uses_the_short_arc_across_north():
    assert circular_median([350.0, 355.0, 5.0, 10.0, 15.0]) == pytest.approx(5.0)
    with pytest.raises(ValueError, match="no bearings"):
        circular_median([])


def test_percentile_block_counts_only_defined_members():
    assert percentile_block([None, 10.0, 20.0]) == {
        "members": 2,
        "p10": 11.0,
        "p25": 12.5,
        "p50": 15.0,
        "p75": 17.5,
        "p90": 19.0,
    }
    assert percentile_block([None, None]) == {
        "members": 0,
        "p10": None,
        "p25": None,
        "p50": None,
        "p75": None,
        "p90": None,
    }


def test_whole_profiles_share_member_level_optional_and_censoring_semantics():
    profiles = [
        {
            "hours": [
                member_hour(
                    temperature_c=10.0,
                    direction_deg=350.0,
                    levels=[level(850, 1500.0), level(500, 5500.0)],
                    boundary_layer_top_m=5500.0,
                    cloud_base_m=None,
                )
            ]
        },
        {
            "hours": [
                member_hour(
                    temperature_c=20.0,
                    direction_deg=10.0,
                    levels=[level(500, 5600.0)],
                    boundary_layer_top_m=2000.0,
                    cloud_base_m=2500.0,
                    cape_jkg=800.0,
                )
            ]
        },
    ]

    (hour,) = aggregate(profiles, optional_surface_scalars=("capeJkg",))

    assert hour["validAt"] == "2026-08-09T18:00:00Z"
    assert hour["surface"]["temperatureC"]["members"] == 2
    assert hour["surface"]["temperatureC"]["p50"] == pytest.approx(15.0)
    assert hour["surface"]["windDirectionDeg"] == pytest.approx(0.0)
    assert hour["surface"]["capeJkg"]["members"] == 1
    assert hour["levels"][0]["pressureHpa"] == 850
    assert hour["levels"][0]["heightM"]["members"] == 1
    assert hour["levels"][1]["pressureHpa"] == 500
    assert hour["levels"][1]["heightM"]["members"] == 2
    assert hour["derived"]["boundaryLayerTopM"]["members"] == 2
    assert hour["derived"]["boundaryLayerTopM"]["ceiledMembers"] == 1
    assert hour["derived"]["cloudBaseM"]["members"] == 1
    assert "ceiledMembers" not in hour["derived"]["cloudBaseM"]


def test_only_explicitly_optional_surface_fields_may_be_absent():
    profiles = [
        {
            "hours": [
                member_hour(
                    temperature_c=10.0,
                    direction_deg=270.0,
                    levels=[level(500, 5500.0)],
                    boundary_layer_top_m=2000.0,
                    cloud_base_m=2500.0,
                )
            ]
        }
    ]

    with pytest.raises(KeyError, match="capeJkg"):
        aggregate(profiles)


def test_ceiling_tolerance_counts_float_round_trip_without_counting_nulls():
    member_hours = [
        member_hour(
            temperature_c=10.0,
            direction_deg=270.0,
            levels=[level(500, 5500.0)],
            boundary_layer_top_m=5499.6,
            cloud_base_m=None,
        ),
        member_hour(
            temperature_c=10.0,
            direction_deg=270.0,
            levels=[level(500, 5500.0)],
            boundary_layer_top_m=None,
            cloud_base_m=None,
        ),
    ]

    assert count_ceiled_members(member_hours, "boundaryLayerTopM") == 1

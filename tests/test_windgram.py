import pytest

from windgram.windgram import derive_windgram_profile

# Envelope filler for derivation tests; the per-builder truth of these
# tokens is asserted against the catalogue in test_build.py.
TEST_SEMANTICS = {"gust": "hourMax", "precipitation": "windowMeanRate"}


def source_profile() -> dict:
    return {
        "generatedAt": "2026-07-27T19:00:00Z",
        "latitude": 49.291977,
        "longitude": -117.183569,
        "modelElevationM": 1200,
        "referenceTime": "2026-07-27T18:00:00Z",
        "siteAltitudeM": 1485,
        "siteId": "dundee",
        "siteName": "Dundee",
        "siteTimeZone": "America/Vancouver",
        "hours": [
            {
                "cloudCoverPercent": 35,
                "dewPointDepressionC": 6,
                "latentHeatFluxWm2": 160,
                "precipitationMm": 0.2,
                "pressurePa": 101_200,
                "sensibleHeatFluxWm2": 320,
                "temperatureC": 24,
                "validAt": "2026-07-27T19:00:00Z",
                "windDirectionDeg": -20,
                "windSpeedMs": 5,
                "levels": [
                    {
                        "dewPointDepressionC": 5,
                        "heightM": 1500,
                        "pressureHpa": 850,
                        "temperatureC": 20,
                        "windDirectionDeg": 270,
                        "windSpeedMs": 6,
                    },
                    {
                        "dewPointDepressionC": 3,
                        "heightM": 2100,
                        "pressureHpa": 800,
                        "temperatureC": 14,
                        "windDirectionDeg": 280,
                        "windSpeedMs": 8,
                    },
                    {
                        "dewPointDepressionC": 0.4,
                        "heightM": 2700,
                        "pressureHpa": 750,
                        "temperatureC": 8,
                        "windDirectionDeg": 290,
                        "windSpeedMs": 10,
                    },
                ],
            }
        ],
    }


def test_publishes_the_contract_envelope_with_coordinates_verbatim():
    profile = derive_windgram_profile(source_profile(), model="hrdps-continental", semantics=TEST_SEMANTICS)

    assert profile["schemaVersion"] == 1
    assert profile["model"] == "hrdps-continental"
    assert profile["run"] == {
        "referenceTime": "2026-07-27T18:00:00Z",
        "generatedAt": "2026-07-27T19:00:00Z",
    }
    assert profile["site"] == {
        "id": "dundee",
        "name": "Dundee",
        "latitude": 49.291977,
        "longitude": -117.183569,
        "altitudeM": 1485,
        "modelElevationM": 1200,
        "timeZone": "America/Vancouver",
    }


def test_site_time_zone_is_omitted_when_the_source_declares_none():
    # A source without the catalogue echo (pre-timeZone catalogues, or the
    # GEPS builder until its concurrent fix lands) publishes no timeZone key
    # — absence, never null: the contract reads absence as "predates the
    # echo".
    source = source_profile()
    del source["siteTimeZone"]

    profile = derive_windgram_profile(source, model="hrdps-continental", semantics=TEST_SEMANTICS)

    assert "timeZone" not in profile["site"]

    source["siteTimeZone"] = None
    profile = derive_windgram_profile(source, model="hrdps-continental", semantics=TEST_SEMANTICS)

    assert "timeZone" not in profile["site"]


def test_semantics_publish_verbatim_between_site_and_hours():
    # The builder's transport-semantics declaration lands as the document's
    # own "semantics" block — profiles self-interpret gust and precipitation
    # without a trip to the catalogue — in contract position: after site,
    # before hours.
    semantics = {"gust": "instant", "precipitation": "instantRate"}

    profile = derive_windgram_profile(
        source_profile(), model="hrrr-conus", semantics=semantics
    )

    assert profile["semantics"] == semantics
    assert list(profile) == ["schemaVersion", "model", "run", "site", "semantics", "hours"]


def test_semantics_omit_the_gust_key_for_gustless_models():
    profile = derive_windgram_profile(
        source_profile(), model="reps", semantics={"precipitation": "windowMeanRate"}
    )

    assert profile["semantics"] == {"precipitation": "windowMeanRate"}


def test_nests_a_source_hour_into_si_surface_levels_and_derived_blocks():
    hour = derive_windgram_profile(source_profile(), model="hrdps-continental", semantics=TEST_SEMANTICS)["hours"][0]

    assert hour["surface"] == {
        "pressurePa": 101_200,
        "temperatureC": 24,
        "dewPointC": 18,
        "windSpeedMs": 5,
        "windDirectionDeg": 340,
        "cloudCoverPercent": 35,
        "precipitationMmHr": 0.2,
        "sensibleHeatFluxWm2": 320,
        "latentHeatFluxWm2": 160,
    }
    # Bolton (1980) eq. 15 by hand: T = 24 C = 297.15 K, Td = 18 C = 291.15 K.
    #   1/(291.15 - 56)          = 1/235.15    = 4.25260e-3
    #   ln(297.15/291.15)/800    = 0.0203988/800 = 2.54985e-5
    #   T_LCL = 1/(4.25260e-3 + 2.54985e-5) + 56 = 233.749 + 56 = 289.749 K
    #   climb = (297.15 - 289.749)/0.0098 = 755.3 m  ->  1200 + 755.3
    # The column's own first saturated height (depression reaches 0.5 C
    # between the 3 C level at 2100 m and the 0.4 C level at 2700 m) is
    # 2676.9 m, above the parcel LCL, so the parcel wins.
    assert hour["derived"]["cloudBaseM"] == pytest.approx(1955.26, abs=0.01)
    assert hour["derived"]["boundaryLayerTopM"] > 1200
    assert hour["derived"]["thermalVelocityMs"] > 0


def test_levels_publish_dew_point_and_si_wind_without_display_fields():
    hour = derive_windgram_profile(source_profile(), model="hrdps-continental", semantics=TEST_SEMANTICS)["hours"][0]

    assert hour["levels"][0] == {
        "pressureHpa": 850,
        "heightM": 1500,
        "temperatureC": 20,
        "dewPointC": 15,
        "windSpeedMs": 6,
        "windDirectionDeg": 270,
    }


def test_dew_point_is_temperature_minus_the_eccc_depression():
    source = source_profile()
    source["hours"][0]["dewPointDepressionC"] = 6.25
    source["hours"][0]["levels"][1]["dewPointDepressionC"] = -0.5  # supersaturated

    hour = derive_windgram_profile(source, model="hrdps-continental", semantics=TEST_SEMANTICS)["hours"][0]

    assert hour["surface"]["dewPointC"] == 17.75
    assert hour["levels"][1]["dewPointC"] == 14.5


def test_does_not_claim_usable_lift_when_surface_heating_is_absent():
    source = source_profile()
    source["hours"][0]["sensibleHeatFluxWm2"] = -20
    source["hours"][0]["latentHeatFluxWm2"] = 0

    derived = derive_windgram_profile(source, model="hrdps-continental", semantics=TEST_SEMANTICS)["hours"][0]["derived"]
    assert derived["thermalVelocityMs"] == 0
    assert derived["usableLiftTopM"] is None


def test_derived_heights_publish_unsmoothed_hour_by_hour():
    # The pipeline publishes the raw per-hour derivation so consumers can
    # recover the model's values; smoothing is a renderer option downstream.
    source = source_profile()
    base = source["hours"][0]
    times = ["2026-07-27T19:00:00Z", "2026-07-27T20:00:00Z", "2026-07-27T21:00:00Z"]
    depressions = [1, 10, 1]
    source["hours"] = [
        {
            **base,
            "dewPointDepressionC": depression,
            "levels": [dict(level) for level in base["levels"]],
            "validAt": valid_at,
        }
        for valid_at, depression in zip(times, depressions)
    ]

    hours = derive_windgram_profile(source, model="hrdps-continental", semantics=TEST_SEMANTICS)["hours"]

    assert [hour["derived"]["cloudBaseM"] for hour in hours] == pytest.approx(
        [1326.81, 2451.42, 1326.81], abs=0.01
    )


def test_cloud_base_drops_to_a_column_layer_saturated_below_the_parcel_lcl():
    source = source_profile()
    # Surface depression 10 C puts the parcel LCL at 1200 + 1251.4 = 2451.4 m
    # (Bolton, as above), but the column saturates lower: depression falls
    # from 4 C at 1500 m through the 0.5 C threshold to 0.2 C at 2100 m.
    # Crossing by hand: (4 - 0.5)/(4 - 0.2) = 0.92105 of the 600 m layer,
    # so 1500 + 552.6 = 2052.6 m — the model's own cloud, below the LCL.
    source["hours"][0]["dewPointDepressionC"] = 10
    depressions = [4, 0.2, 6]
    for level, depression in zip(source["hours"][0]["levels"], depressions):
        level["dewPointDepressionC"] = depression

    derived = derive_windgram_profile(source, model="hrdps-continental", semantics=TEST_SEMANTICS)["hours"][0]["derived"]

    assert derived["cloudBaseM"] == pytest.approx(2052.63, abs=0.01)


def test_dry_column_publishes_the_parcel_lcl_even_above_the_sounding_top():
    source = source_profile()
    # Depression 20 C: Bolton puts the LCL 2467.3 m above terrain — higher
    # than every retained level — and no level saturates, so the parcel
    # estimate stands on its own.
    source["hours"][0]["dewPointDepressionC"] = 20
    depressions = [12, 15, 14]
    for level, depression in zip(source["hours"][0]["levels"], depressions):
        level["dewPointDepressionC"] = depression

    derived = derive_windgram_profile(source, model="hrdps-continental", semantics=TEST_SEMANTICS)["hours"][0]["derived"]

    assert derived["cloudBaseM"] == pytest.approx(3667.27, abs=0.01)


def test_supersaturated_surface_puts_cloud_base_at_model_terrain():
    source = source_profile()
    source["hours"][0]["dewPointDepressionC"] = -1  # data noise: Td above T

    derived = derive_windgram_profile(source, model="hrdps-continental", semantics=TEST_SEMANTICS)["hours"][0]["derived"]

    assert derived["cloudBaseM"] == 1200


def test_publishes_every_source_hour_chronologically():
    # Every source hour is published; day windowing is a renderer concern.
    source = source_profile()
    base = source["hours"][0]
    times = [
        "2026-07-27T14:00:00Z",
        "2026-07-28T03:00:00Z",  # 20:00 and 03:00 previous-day Pacific
        "2026-07-28T09:00:00Z",
        "2026-07-28T14:00:00Z",
    ]
    source["hours"] = [
        {**base, "levels": [dict(level) for level in base["levels"]], "validAt": valid_at}
        for valid_at in times
    ]

    hours = derive_windgram_profile(source, model="hrdps-continental", semantics=TEST_SEMANTICS)["hours"]

    assert [hour["validAt"] for hour in hours] == times


def test_optional_science_fields_pass_through_in_contract_order():
    source = source_profile()
    source["hours"][0].update(
        {
            "windGustMs": 11.4,
            "capeJkg": 850.0,
            "cinJkg": -55.0,
            "pblHeightM": 1650.0,
            "lowCloudPercent": 62.0,
            "midCloudPercent": 18.0,
            "highCloudPercent": 4.0,
        }
    )

    surface = derive_windgram_profile(source, model="hrrr-conus", semantics=TEST_SEMANTICS)["hours"][0]["surface"]

    assert surface["windGustMs"] == 11.4
    assert surface["capeJkg"] == 850.0
    assert surface["cinJkg"] == -55.0
    assert surface["pblHeightM"] == 1650.0
    assert surface["lowCloudPercent"] == 62.0
    assert surface["midCloudPercent"] == 18.0
    assert surface["highCloudPercent"] == 4.0
    # Dict order is the published contract order, for clean diffs.
    assert list(surface)[-7:] == [
        "windGustMs",
        "capeJkg",
        "cinJkg",
        "pblHeightM",
        "lowCloudPercent",
        "midCloudPercent",
        "highCloudPercent",
    ]


def test_absent_science_fields_stay_absent_not_null():
    surface = derive_windgram_profile(source_profile(), model="hrdps-continental", semantics=TEST_SEMANTICS)["hours"][0][
        "surface"
    ]
    for field in ("windGustMs", "capeJkg", "cinJkg", "pblHeightM", "lowCloudPercent"):
        assert field not in surface


def test_science_fields_are_clamped_to_their_physical_signs():
    source = source_profile()
    # Resampling noise: slightly negative CAPE/gust/PBL, positive CIN,
    # cloud fraction past 100.
    source["hours"][0].update(
        {
            "windGustMs": -0.2,
            "capeJkg": -0.4,
            "cinJkg": 0.3,
            "pblHeightM": -1.0,
            "lowCloudPercent": 100.4,
        }
    )

    surface = derive_windgram_profile(source, model="gfs", semantics=TEST_SEMANTICS)["hours"][0]["surface"]

    assert surface["windGustMs"] == 0.0
    assert surface["capeJkg"] == 0.0
    assert surface["cinJkg"] == 0.0
    assert surface["pblHeightM"] == 0.0
    assert surface["lowCloudPercent"] == 100.0


def test_levels_carry_cloud_fraction_only_where_the_source_has_it():
    source = source_profile()
    source["hours"][0]["levels"][0]["cloudFractionPercent"] = 85.0

    levels = derive_windgram_profile(source, model="gfs", semantics=TEST_SEMANTICS)["hours"][0]["levels"]

    assert levels[0]["cloudFractionPercent"] == 85.0
    assert all("cloudFractionPercent" not in level for level in levels[1:])


def test_normalizes_wind_directions_including_negatives():
    source = source_profile()
    source["hours"][0]["windDirectionDeg"] = -370
    hour = derive_windgram_profile(source, model="hrdps-continental", semantics=TEST_SEMANTICS)["hours"][0]
    assert hour["surface"]["windDirectionDeg"] == 350

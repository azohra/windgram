import json
import re
from pathlib import Path

import pytest

from windgram import build_gfs
from windgram.build_gfs import (
    OMEGA_LEVELS,
    OPTIONAL_SURFACE_FIELDS,
    PRESSURE_LEVELS,
    _build_profiles,
    _deaveraged,
    _differenced,
    _window_start,
)
from windgram.moisture import dew_point_depression
from windgram.noaa import (
    DownloadStats,
    GridPointValue,
    IdxRecord,
    MissingRecordError,
    find_record,
    parse_idx,
)

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.mark.parametrize(
    ("forecast_hour", "start"),
    [(3, 0), (6, 0), (21, 18), (24, 18), (123, 120), (126, 120), (384, 378)],
)
def test_windows_reset_every_six_hours(forecast_hour, start):
    assert _window_start(forecast_hour) == start


def test_a_constant_flux_survives_deaveraging():
    # A(21) and A(24) both average a constant 130 W/m²; the (21, 24] mean is 130.
    assert _deaveraged(130.0, 130.0) == 130.0


def test_deaveraging_recovers_the_second_half_of_the_window():
    # 100 W/m² over (18, 21], 200 W/m² over (21, 24]: the 6 h average is 150.
    assert _deaveraged(150.0, 100.0) == 200.0


def test_differencing_recovers_the_second_half_of_an_accumulation():
    # 2 mm fell by f021, 5 mm by f024: 3 mm fell over (21, 24].
    assert _differenced(5.0, 2.0) == 3.0


def test_windowed_records_exist_under_their_exact_forecast_names():
    f021 = parse_idx((FIXTURES / "gfs.t12z.pgrb2.0p25.f021.excerpt.idx").read_text())
    f024 = parse_idx((FIXTURES / "gfs.t12z.pgrb2.0p25.f024.excerpt.idx").read_text())

    for records, window in ((f021, "18-21"), (f024, "18-24")):
        find_record(records, "LHTFL", "surface", f"{window} hour ave fcst")
        find_record(records, "SHTFL", "surface", f"{window} hour ave fcst")
        find_record(records, "APCP", "surface", f"{window} hour acc fcst")


def test_science_records_resolve_to_the_instantaneous_flavour():
    # GFS publishes the L/M/H cloud layers twice per step: instantaneous
    # ("24 hour fcst") and a 6-h-bucket average ("18-24 hour ave fcst").
    # The builder's default forecast token must land on the instant record.
    records = parse_idx((FIXTURES / "gfs.t12z.pgrb2.0p25.f024.excerpt.idx").read_text())

    for field_name, (variable, level) in OPTIONAL_SURFACE_FIELDS.items():
        record = find_record(records, variable, level, "24 hour fcst")
        assert record.forecast == "24 hour fcst", field_name
    # The average flavour exists right beside it — proof the disambiguation
    # is doing real work, not matching the only record there is.
    find_record(records, "LCDC", "low cloud layer", "18-24 hour ave fcst")


def test_gfs_carries_a_cloud_profile_at_every_curated_level():
    records = parse_idx((FIXTURES / "gfs.t12z.pgrb2.0p25.f024.excerpt.idx").read_text())
    for pressure_hpa in PRESSURE_LEVELS:
        find_record(records, "TCDC", f"{pressure_hpa} mb", "24 hour fcst")


def test_gfs_carries_omega_at_every_curated_level():
    # pgrb2.0p25 carries VVEL (Pa/s, instantaneous) at all eight curated
    # levels — verified against the live feed on 2026-08-08 at anl, f001,
    # f024, f240 and f384: no late-horizon thinning.
    records = parse_idx((FIXTURES / "gfs.t12z.pgrb2.0p25.f024.excerpt.idx").read_text())
    assert OMEGA_LEVELS == PRESSURE_LEVELS
    for pressure_hpa in OMEGA_LEVELS:
        find_record(records, "VVEL", f"{pressure_hpa} mb", "24 hour fcst")


def test_missing_records_raise_the_tolerable_error_type():
    records = parse_idx((FIXTURES / "gfs.t12z.pgrb2.0p25.f024.excerpt.idx").read_text())
    with pytest.raises(MissingRecordError):
        find_record(records, "TCDC", "875 mb", "24 hour fcst")  # not in pgrb2.0p25
    with pytest.raises(MissingRecordError):
        find_record(records, "VVEL", "875 mb", "24 hour fcst")  # ditto — tolerated
    assert issubclass(MissingRecordError, RuntimeError)


def test_models_json_matches_the_gfs_builder_configuration():
    catalogue = json.loads(Path("data/models.json").read_text())
    capabilities = next(
        entry for entry in catalogue["models"] if entry["slug"] == "gfs"
    )["capabilities"]
    assert capabilities["gust"] == "instant"  # NOAA has no hour-max gust
    # APCP mm over the 3 h window ÷ 3 → a window-mean rate, and the
    # documents' own semantics block says the same.
    assert capabilities["precipitation"] == "windowMeanRate"
    assert build_gfs.SEMANTICS == {"gust": "instant", "precipitation": "windowMeanRate"}
    assert capabilities["cape"] is True and capabilities["cin"] is True
    assert capabilities["pblHeight"] is True
    assert capabilities["cloudLayers"] is True
    assert capabilities["cloudProfile"] is True  # the only model with one
    assert {"windGustMs", "capeJkg", "cinJkg", "pblHeightM"} <= set(OPTIONAL_SURFACE_FIELDS)
    assert {"lowCloudPercent", "midCloudPercent", "highCloudPercent"} <= set(
        OPTIONAL_SURFACE_FIELDS
    )
    # GFS publishes its own omega (Pa/s, instantaneous) at every curated level.
    assert capabilities["verticalVelocity"] == "omega"
    assert capabilities["verticalVelocityLevels"] == list(OMEGA_LEVELS)


def test_inverse_magnus_matches_hand_checked_dewpoints():
    # 20 °C at 50 % RH dews at 9.26 °C; 5 °C at 80 % RH dews at 1.84 °C.
    assert dew_point_depression(20.0, 50.0) == pytest.approx(20.0 - 9.26, abs=0.01)
    assert dew_point_depression(5.0, 80.0) == pytest.approx(5.0 - 1.84, abs=0.01)


def test_saturated_air_has_no_depression():
    assert dew_point_depression(15.0, 100.0) == pytest.approx(0.0, abs=1e-9)


def test_relative_humidity_is_clamped_to_a_physical_range():
    assert dew_point_depression(20.0, 0.0) == dew_point_depression(20.0, 1.0)
    assert dew_point_depression(20.0, 105.0) == dew_point_depression(20.0, 100.0)


# --- End-to-end: two forecast steps through _build_profiles with the fetch
# layer faked at the .idx/record/sampling seam. ---

SITE = {
    "slug": "boulder",
    "name": "Boulder",
    "latitude": 40.0,
    "longitude": 255.0,
    "elevationM": 1600.0,
}
LEVEL_HEIGHTS = {
    925: 800.0,
    900: 1000.0,
    850: 1500.0,
    800: 2000.0,
    750: 2500.0,
    700: 3000.0,
    650: 3500.0,
    600: 4000.0,
}
OMEGA_PA_S = -0.421875  # exactly representable: proves verbatim value flow


def _fake_index(forecast_hour: int) -> list[IdxRecord]:
    forecast = f"{forecast_hour} hour fcst"
    window = f"{_window_start(forecast_hour)}-{forecast_hour} hour"
    rows = [
        ("TMP", "2 m above ground", forecast),
        ("DPT", "2 m above ground", forecast),
        ("UGRD", "10 m above ground", forecast),
        ("VGRD", "10 m above ground", forecast),
        ("HGT", "surface", forecast),
        ("TCDC", "entire atmosphere", forecast),
        ("PRMSL", "mean sea level", forecast),
        ("LHTFL", "surface", f"{window} ave fcst"),
        ("SHTFL", "surface", f"{window} ave fcst"),
        ("APCP", "surface", f"{window} acc fcst"),
    ]
    for level in PRESSURE_LEVELS:
        for variable in ("TMP", "RH", "HGT", "UGRD", "VGRD", "TCDC"):
            rows.append((variable, f"{level} mb", forecast))
        # Step 6's 700 mb VVEL is missing from the index: the level must
        # still publish, just without the optional field.
        if not (forecast_hour == 6 and level == 700):
            rows.append(("VVEL", f"{level} mb", forecast))
    return [
        IdxRecord(variable, level, token, index * 100, 100)
        for index, (variable, level, token) in enumerate(rows)
    ]


def _fake_value(variable: str, level: str, forecast: str) -> float:
    if variable == "VVEL":
        return OMEGA_PA_S
    if level == "2 m above ground":
        return 293.15 if variable == "TMP" else 283.15
    if variable == "HGT":
        return 100.0 if level == "surface" else LEVEL_HEIGHTS[int(level.split()[0])]
    if variable == "TMP":
        return 273.15
    if variable == "RH":
        return 50.0
    if variable in ("UGRD", "VGRD"):
        return 3.0
    if variable == "PRMSL":
        return 101300.0
    if variable == "APCP":
        return 1.5 if forecast.startswith("0-3") else 4.5
    return 25.0  # cloud covers and the fluxes


def test_build_profiles_publishes_omega_and_tolerates_its_absence(monkeypatch):
    monkeypatch.setenv("WINDGRAM_MAX_STEPS", "2")
    monkeypatch.setattr(
        build_gfs,
        "fetch_index",
        lambda url, stats=None: _fake_index(int(re.search(r"f(\d{3})\.idx", url).group(1))),
    )
    monkeypatch.setattr(build_gfs, "fetch_record", lambda url, record, stats=None: record)
    monkeypatch.setattr(
        build_gfs,
        "sample_sites",
        lambda record, sites, max_km: {
            site["slug"]: GridPointValue(
                _fake_value(record.variable, record.level, record.forecast),
                site["latitude"],
                site["longitude"],
                0.0,
            )
            for site in sites
        },
    )

    result = _build_profiles(
        {"date": "20260807", "hour": "12"}, "2026-08-07T12:00:00Z", [SITE], DownloadStats()
    )

    (profile,) = result["profiles"]
    assert profile["semantics"] == {"gust": "instant", "precipitation": "windowMeanRate"}
    first, second = profile["hours"]
    # Every curated level carries the sampled omega verbatim: Pa/s in,
    # Pa/s out, no unit conversion anywhere in the flow.
    assert [level["pressureHpa"] for level in first["levels"]] == sorted(
        PRESSURE_LEVELS, reverse=True
    )
    assert all(level["verticalVelocityPaS"] == OMEGA_PA_S for level in first["levels"])
    # The step whose 700 mb VVEL record is absent still publishes the level,
    # complete in its required fields, without the optional one.
    by_pressure = {level["pressureHpa"]: level for level in second["levels"]}
    assert set(by_pressure) == set(PRESSURE_LEVELS)
    assert "verticalVelocityPaS" not in by_pressure[700]
    assert all(
        by_pressure[level]["verticalVelocityPaS"] == OMEGA_PA_S
        for level in PRESSURE_LEVELS
        if level != 700
    )

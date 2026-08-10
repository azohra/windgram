import json
import math
import re
from pathlib import Path

import pytest

from windgram.builders import hrrr
from windgram.builders.hrrr import (
    OMEGA_LEVELS,
    OPTIONAL_SURFACE_FIELDS,
    PRESSURE_LEVELS,
    SMOKE_FIELDS,
    _build_profiles,
    _earth_wind,
    _grid_rotation_deg,
)
from windgram.noaa import (
    DownloadStats,
    GridPointValue,
    IdxRecord,
    find_record,
    parse_idx,
    wind_from_uv,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


def test_no_rotation_on_the_orientation_meridian():
    assert _grid_rotation_deg(262.5) == 0
    assert _earth_wind(3.0, 4.0, 262.5) == (3.0, 4.0)


def test_rotation_at_the_catalogued_sites_is_the_documented_bias():
    # −117.7°W is 242.3°E; sin(38.5°) × (242.3 − 262.5) ≈ −12.6°.
    assert _grid_rotation_deg(242.3) == pytest.approx(-12.575, abs=0.001)
    assert _grid_rotation_deg(-117.7) == pytest.approx(_grid_rotation_deg(242.3))


def test_rotation_preserves_speed_and_shifts_direction_by_the_local_angle():
    # A wind blowing along grid north at 242.3°E: grid north there points
    # 12.6° east of true north, so the wind comes FROM 180° − 12.6°.
    u_earth, v_earth = _earth_wind(0.0, 10.0, 242.3)
    speed, direction = wind_from_uv(u_earth, v_earth)

    assert speed == pytest.approx(10.0)
    assert direction == pytest.approx(180 + _grid_rotation_deg(242.3))


def test_rotation_matrix_is_orthogonal_for_an_arbitrary_wind():
    u_earth, v_earth = _earth_wind(-7.3, 2.1, 250.0)

    assert math.hypot(u_earth, v_earth) == pytest.approx(math.hypot(-7.3, 2.1))


def test_every_science_record_exists_in_the_wrfprs_index():
    # GUST, CAPE/CIN (surface-based), HPBL, and the three sigma-layer cloud
    # fractions all live in the one wrfprs file the builder already reads.
    records = parse_idx((FIXTURES / "hrrr.t12z.wrfprsf24.excerpt.idx").read_text())
    for field_name, (variable, level) in OPTIONAL_SURFACE_FIELDS.items():
        find_record(records, variable, level, "24 hour fcst")


def test_every_smoke_record_exists_in_the_wrfprs_index():
    # HRRRv4's prognostic smoke: MASSDEN (8 m AGL), COLMD and AOTK (entire
    # atmosphere) all live in the one wrfprs file the builder already reads —
    # verified against the live feed on 2026-08-09 (wrfprs and wrfsfc both).
    records = parse_idx((FIXTURES / "hrrr.t12z.wrfprsf24.excerpt.idx").read_text())
    for field_name, (variable, level, _convert) in SMOKE_FIELDS.items():
        find_record(records, variable, level, "24 hour fcst")


def test_vvel_exists_at_every_curated_level_in_the_wrfprs_index():
    # wrfprs carries omega (VVEL, Pa/s, instantaneous) at all nine curated
    # levels — verified against the live feed on 2026-08-08 at f00/f01/f24/f48.
    records = parse_idx((FIXTURES / "hrrr.t12z.wrfprsf24.excerpt.idx").read_text())
    assert OMEGA_LEVELS == PRESSURE_LEVELS
    for pressure_hpa in OMEGA_LEVELS:
        find_record(records, "VVEL", f"{pressure_hpa} mb", "24 hour fcst")


def test_models_json_matches_the_hrrr_builder_configuration():
    catalogue = json.loads(Path("models.json").read_text())
    capabilities = next(
        entry for entry in catalogue["models"] if entry["slug"] == "hrrr-conus"
    )["capabilities"]
    assert capabilities["gust"] == "instant"  # HRRR's GUST is a diagnostic instant
    # PRATE is an instantaneous rate at the valid time (×3600 → mm/h), and
    # the documents' own semantics block says the same.
    assert capabilities["precipitation"] == "instantRate"
    # HRRRv4's prognostic smoke attenuates its own shortwave (Dowell et al.
    # 2022, WAF, §2d), so the fluxes — and everything derived from them —
    # are already smoke-aware: the catalogue and the documents both say so.
    assert capabilities["smoke"] == "radiativelyCoupled"
    assert hrrr.SEMANTICS == {
        "gust": "instant",
        "precipitation": "instantRate",
        "smoke": "radiativelyCoupled",
    }
    assert capabilities["cape"] is True and capabilities["cin"] is True
    assert capabilities["pblHeight"] is True
    assert capabilities["cloudLayers"] is True
    assert capabilities["cloudProfile"] is False  # wrfprs has no per-level TCDC
    # HRRR publishes its own omega (Pa/s, instantaneous) at every curated level.
    assert capabilities["verticalVelocity"] == "omega"
    assert capabilities["verticalVelocityLevels"] == list(OMEGA_LEVELS)


# --- End-to-end: two forecast hours through _build_profiles with the fetch
# layer faked at the .idx/record/sampling seam. ---

SITE = {
    "slug": "boulder",
    "name": "Boulder",
    "latitude": 40.0,
    "longitude": 255.0,
    "elevationM": 1600.0,
    "timeZone": "America/Denver",
}
LEVEL_HEIGHTS = {
    925: 800.0,
    900: 1000.0,
    875: 1250.0,
    850: 1500.0,
    800: 2000.0,
    750: 2500.0,
    700: 3000.0,
    650: 3500.0,
    600: 4000.0,
}
OMEGA_PA_S = -0.421875  # exactly representable: proves verbatim value flow


def _fake_index(forecast_hour: int) -> list[IdxRecord]:
    rows = [
        ("TMP", "2 m above ground"),
        ("DPT", "2 m above ground"),
        ("UGRD", "10 m above ground"),
        ("VGRD", "10 m above ground"),
        ("HGT", "surface"),
        ("TCDC", "entire atmosphere"),
        ("LHTFL", "surface"),
        ("PRATE", "surface"),
        ("MSLMA", "mean sea level"),
        ("SHTFL", "surface"),
    ]
    rows.append(("MASSDEN", "8 m above ground"))
    rows.append(("COLMD", "entire atmosphere (considered as a single layer)"))
    # Hour 2's AOTK is missing from the index: the smoke block is
    # all-or-nothing, so that hour must publish no smoke at all.
    if forecast_hour != 2:
        rows.append(("AOTK", "entire atmosphere (considered as a single layer)"))
    for level in PRESSURE_LEVELS:
        for variable in ("TMP", "DPT", "HGT", "UGRD", "VGRD"):
            rows.append((variable, f"{level} mb"))
        # Hour 2's 700 mb VVEL is missing from the index: the level must
        # still publish, just without the optional field.
        if not (forecast_hour == 2 and level == 700):
            rows.append(("VVEL", f"{level} mb"))
    forecast = f"{forecast_hour} hour fcst"
    return [
        IdxRecord(variable, level, forecast, index * 100, 100)
        for index, (variable, level) in enumerate(rows)
    ]


def _fake_value(variable: str, level: str) -> float:
    if variable == "VVEL":
        return OMEGA_PA_S
    if variable == "MASSDEN":
        return 2.5e-8  # kg/m³ — the builder publishes µg/m³
    if variable == "COLMD":
        return 1.5e-4  # kg/m² — the builder publishes mg/m²
    if variable == "AOTK":
        return 0.75  # dimensionless, exactly representable: verbatim flow
    if level == "2 m above ground":
        return 293.15 if variable == "TMP" else 283.15
    if variable == "HGT":
        return 100.0 if level == "surface" else LEVEL_HEIGHTS[int(level.split()[0])]
    if variable == "TMP":
        return 273.15
    if variable == "DPT":
        return 268.15
    if variable in ("UGRD", "VGRD"):
        return 3.0
    if variable == "PRATE":
        return 0.0
    if variable == "MSLMA":
        return 101300.0
    return 25.0  # cloud cover and the fluxes


def test_build_profiles_publishes_omega_and_tolerates_its_absence(monkeypatch):
    monkeypatch.setenv("WINDGRAM_MAX_STEPS", "2")
    monkeypatch.setattr(
        hrrr,
        "fetch_index",
        lambda url, stats=None: _fake_index(int(re.search(r"wrfprsf(\d+)", url).group(1))),
    )
    monkeypatch.setattr(hrrr, "fetch_record", lambda url, record, stats=None: record)
    monkeypatch.setattr(
        hrrr,
        "sample_sites",
        lambda record, sites, max_km: {
            site["slug"]: GridPointValue(
                _fake_value(record.variable, record.level),
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
    assert profile["site"]["timeZone"] == "America/Denver"  # the catalogue echo
    assert profile["semantics"] == {
        "gust": "instant",
        "precipitation": "instantRate",
        "smoke": "radiativelyCoupled",
    }
    first, second = profile["hours"]
    # Hour 1 publishes the full smoke block in contract units; hour 2, whose
    # AOTK record is absent, publishes no block at all (all-or-nothing).
    assert first["smoke"]["surfaceUgm3"] == pytest.approx(25.0)  # 2.5e-8 kg/m³ → µg/m³
    assert first["smoke"]["columnMgm2"] == pytest.approx(150.0)  # 1.5e-4 kg/m² → mg/m²
    assert first["smoke"]["aot"] == 0.75
    assert "smoke" not in second
    # Every curated level carries the sampled omega verbatim: Pa/s in,
    # Pa/s out, no unit conversion anywhere in the flow.
    assert [level["pressureHpa"] for level in first["levels"]] == sorted(
        PRESSURE_LEVELS, reverse=True
    )
    assert all(level["verticalVelocityPaS"] == OMEGA_PA_S for level in first["levels"])
    # The hour whose 700 mb VVEL record is absent still publishes the level,
    # complete in its required fields, without the optional one.
    by_pressure = {level["pressureHpa"]: level for level in second["levels"]}
    assert set(by_pressure) == set(PRESSURE_LEVELS)
    assert "verticalVelocityPaS" not in by_pressure[700]
    assert all(
        by_pressure[level]["verticalVelocityPaS"] == OMEGA_PA_S
        for level in PRESSURE_LEVELS
        if level != 700
    )

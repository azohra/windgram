import json
import math
from pathlib import Path

import eccodes
import pytest

from windgram.builders.nam import (
    CLOUD_LAYER_FIELDS,
    OMEGA_LEVELS,
    OPTIONAL_SURFACE_FIELDS,
    PRESSURE_LEVELS,
    PRODUCTS,
    SEMANTICS,
    _completion_urls,
    _earth_wind,
    _grid_rotation_deg,
    _pair_span,
    _precip_fetches,
)
from windgram.noaa import MissingRecordError, find_record, parse_idx, sample_sites

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"

NEST = PRODUCTS["nam-conus-nest"]
PARENT = PRODUCTS["nam"]


def nest_records():
    return parse_idx((FIXTURES / "nam.t12z.conusnest.hiresf24.tm00.excerpt.idx").read_text())


def parent_records():
    return parse_idx((FIXTURES / "nam.t12z.awphys24.tm00.excerpt.idx").read_text())


# ------------------------------------------------------------------ schedule


def test_nest_schedule_is_hourly_to_60_skipping_the_analysis():
    assert NEST.forecast_hours == tuple(range(1, 61))


def test_parent_schedule_is_hourly_to_36_then_three_hourly_to_84():
    assert PARENT.forecast_hours[:36] == tuple(range(1, 37))
    assert PARENT.forecast_hours[36:] == tuple(range(39, 85, 3))
    assert PARENT.forecast_hours[-1] == 84


def test_completeness_gates_on_the_final_hour_of_every_needed_file():
    # The parent needs the awip12 cloud companion through the horizon too;
    # the nest's clouds live in its own file.
    bucket = "https://noaa-nam-pds.s3.amazonaws.com/nam.20260807"
    assert _completion_urls(PARENT, "20260807", "12") == [
        f"{bucket}/nam.t12z.awphys84.tm00.grib2.idx",
        f"{bucket}/nam.t12z.awip1284.tm00.grib2.idx",
    ]
    assert _completion_urls(NEST, "20260807", "06") == [
        f"{bucket}/nam.t06z.conusnest.hiresf60.tm00.grib2.idx",
    ]


# -------------------------------------------------------------- precipitation


@pytest.mark.parametrize("run_hour", ["00", "06", "12", "18"])
@pytest.mark.parametrize(
    ("forecast_hour", "fetches", "window_hours"),
    [
        # Right after a 3 h bucket reset the record is the step itself.
        (1, [(1, "0-1 hour acc fcst")], 1),
        (4, [(4, "3-4 hour acc fcst")], 1),
        (22, [(22, "21-22 hour acc fcst")], 1),
        # Inside the bucket, difference consecutive running records.
        (2, [(2, "0-2 hour acc fcst"), (1, "0-1 hour acc fcst")], 1),
        (24, [(24, "21-24 hour acc fcst"), (23, "21-23 hour acc fcst")], 1),
        (60, [(60, "57-60 hour acc fcst"), (59, "57-59 hour acc fcst")], 1),
    ],
)
def test_nest_precipitation_differences_three_hour_buckets_on_every_cycle(
    forecast_hour, fetches, window_hours, run_hour
):
    assert _precip_fetches(NEST, run_hour, forecast_hour) == (fetches, window_hours)


@pytest.mark.parametrize("run_hour", ["00", "12"])
@pytest.mark.parametrize(
    ("forecast_hour", "fetches", "window_hours"),
    [
        # 12 h buckets over the hourly phase.
        (1, [(1, "0-1 hour acc fcst")], 1),
        (12, [(12, "0-12 hour acc fcst"), (11, "0-11 hour acc fcst")], 1),
        (13, [(13, "12-13 hour acc fcst")], 1),
        (24, [(24, "12-24 hour acc fcst"), (23, "12-23 hour acc fcst")], 1),
        (36, [(36, "24-36 hour acc fcst"), (35, "24-35 hour acc fcst")], 1),
        # The 3-hourly tail publishes a direct (h−3)–h record — no
        # differencing, divided by 3 for mm/h. At f39 that record is the
        # running bucket "36-39", which IS the 3 h step.
        (39, [(39, "36-39 hour acc fcst")], 3),
        (42, [(42, "39-42 hour acc fcst")], 3),
        (84, [(84, "81-84 hour acc fcst")], 3),
    ],
)
def test_parent_precipitation_differences_twelve_hour_buckets_on_synoptic_cycles(
    forecast_hour, fetches, window_hours, run_hour
):
    assert _precip_fetches(PARENT, run_hour, forecast_hour) == (fetches, window_hours)


@pytest.mark.parametrize("run_hour", ["06", "18"])
@pytest.mark.parametrize(
    ("forecast_hour", "fetches", "window_hours"),
    [
        # On 06/18Z the parent's buckets reset every 3 h like the nest —
        # verified live 2026-08-08, where the 12 h assumption asked f04 for
        # "0-4 hour acc fcst" and the file carried only "3-4".
        (1, [(1, "0-1 hour acc fcst")], 1),
        (4, [(4, "3-4 hour acc fcst")], 1),
        (13, [(13, "12-13 hour acc fcst")], 1),
        (24, [(24, "21-24 hour acc fcst"), (23, "21-23 hour acc fcst")], 1),
        (36, [(36, "33-36 hour acc fcst"), (35, "33-35 hour acc fcst")], 1),
        # The 3-hourly tail is cycle-independent.
        (39, [(39, "36-39 hour acc fcst")], 3),
        (84, [(84, "81-84 hour acc fcst")], 3),
    ],
)
def test_parent_precipitation_differences_three_hour_buckets_off_cycle(
    forecast_hour, fetches, window_hours, run_hour
):
    assert _precip_fetches(PARENT, run_hour, forecast_hour) == (fetches, window_hours)


def test_boundary_hours_carry_two_apcp_records_and_selection_is_by_window():
    # At f24 of a 00/12Z run the parent file holds "12-24" (running bucket)
    # beside "21-24" (3 h sub-bucket). The builder must land on the exact
    # window it asks for — first-match-by-variable would be wrong half the
    # time.
    records = parent_records()
    running = find_record(records, "APCP", "surface", "12-24 hour acc fcst")
    sub_bucket = find_record(records, "APCP", "surface", "21-24 hour acc fcst")
    assert running.offset != sub_bucket.offset
    (fetch, _companion), _ = _precip_fetches(PARENT, "12", 24)
    assert fetch == (24, "12-24 hour acc fcst")


def test_the_tail_record_exists_and_the_running_bucket_sits_beside_it():
    records = parse_idx((FIXTURES / "nam.t12z.awphys42.tm00.excerpt.idx").read_text())
    direct = find_record(records, "APCP", "surface", "39-42 hour acc fcst")
    running = find_record(records, "APCP", "surface", "36-42 hour acc fcst")
    assert direct.offset != running.offset


# ------------------------------------------------------------- wind rotation


def test_no_rotation_on_each_products_own_orientation_meridian():
    assert _grid_rotation_deg(262.5, NEST.lambert_orientation_deg, NEST.lambert_cone) == 0
    assert _grid_rotation_deg(265.0, PARENT.lambert_orientation_deg, PARENT.lambert_cone) == 0


def test_nest_rotation_matches_hrrr_and_parent_differs():
    # The nest shares HRRR's projection: sin(38.5°) × (242.3 − 262.5) ≈ −12.6°.
    # The parent's cone is sin(25°) about LoV 265°: sin(25°) × (242.3 − 265) ≈ −9.6°.
    nest = _grid_rotation_deg(242.3, NEST.lambert_orientation_deg, NEST.lambert_cone)
    parent = _grid_rotation_deg(242.3, PARENT.lambert_orientation_deg, PARENT.lambert_cone)
    assert nest == pytest.approx(-12.575, abs=0.001)
    assert parent == pytest.approx(-9.593, abs=0.001)


def test_rotation_preserves_speed_and_shifts_direction_by_the_local_angle():
    from windgram.noaa import wind_from_uv

    u_earth, v_earth = _earth_wind(
        0.0, 10.0, 242.3, PARENT.lambert_orientation_deg, PARENT.lambert_cone
    )
    speed, direction = wind_from_uv(u_earth, v_earth)
    assert speed == pytest.approx(10.0)
    assert direction == pytest.approx(
        180 + _grid_rotation_deg(242.3, PARENT.lambert_orientation_deg, PARENT.lambert_cone)
    )


def test_rotation_matrix_is_orthogonal_for_an_arbitrary_wind():
    u_earth, v_earth = _earth_wind(
        -7.3, 2.1, 250.0, NEST.lambert_orientation_deg, NEST.lambert_cone
    )
    assert math.hypot(u_earth, v_earth) == pytest.approx(math.hypot(-7.3, 2.1))


# --------------------------------------------------------- paired U/V records


def test_paired_wind_idx_lines_share_an_offset_and_one_spans_the_message():
    # NCEP packs UGRD/VGRD as two submessages of one message; the idx lists
    # them as N.1/N.2 at the same offset, so parse_idx gives the first a
    # zero length and the second the span to the next record (ABSV here).
    records = nest_records()
    u = find_record(records, "UGRD", "850 mb", "24 hour fcst")
    v = find_record(records, "VGRD", "850 mb", "24 hour fcst")
    absv = find_record(records, "ABSV", "850 mb", "24 hour fcst")
    assert u.offset == v.offset
    assert u.length == 0
    assert v.length == absv.offset - v.offset

    span = _pair_span(u, v)
    assert span.offset == u.offset
    assert span.length == absv.offset - u.offset


def test_pair_span_handles_an_end_of_file_pair():
    from windgram.noaa import IdxRecord

    u = IdxRecord("UGRD", "10 m above ground", "24 hour fcst", 100, 0)
    v = IdxRecord("VGRD", "10 m above ground", "24 hour fcst", 100, None)
    assert _pair_span(u, v) is v
    assert _pair_span(v, u) is v


# ---------------------------------------------------------- record inventory


def test_every_surface_and_science_record_exists_in_both_products():
    for records in (nest_records(), parent_records()):
        find_record(records, "PRMSL", "mean sea level", "24 hour fcst")
        find_record(
            records, "TCDC", "entire atmosphere (considered as a single layer)", "24 hour fcst"
        )
        find_record(records, "HGT", "surface", "24 hour fcst")
        find_record(records, "TMP", "2 m above ground", "24 hour fcst")
        find_record(records, "DPT", "2 m above ground", "24 hour fcst")
        for field_name, (variable, level) in OPTIONAL_SURFACE_FIELDS.items():
            find_record(records, variable, level, "24 hour fcst"), field_name


def test_flux_records_resolve_to_the_instantaneous_flavour():
    # The nest publishes averaged twins ("21-24 hour ave fcst") beside the
    # instantaneous records; the builder's exact forecast token must land on
    # the instant ones. (Verified live: the un-suffixed records decode
    # PDT 0, stepType=instant.)
    records = nest_records()
    for variable in ("SHTFL", "LHTFL"):
        record = find_record(records, variable, "surface", "24 hour fcst")
        assert record.forecast == "24 hour fcst"
        find_record(records, variable, "surface", "21-24 hour ave fcst")  # the twin exists


def test_layered_cloud_is_in_file_for_the_nest_but_only_in_awip12_for_the_parent():
    nest = nest_records()
    parent = parent_records()
    awip12 = parse_idx((FIXTURES / "nam.t12z.awip1224.tm00.excerpt.idx").read_text())
    for field_name, (variable, level) in CLOUD_LAYER_FIELDS.items():
        find_record(nest, variable, level, "24 hour fcst")
        find_record(awip12, variable, level, "24 hour fcst")
        with pytest.raises(MissingRecordError):
            find_record(parent, variable, level, "24 hour fcst")
    assert NEST.cloud_file_token is None
    assert PARENT.cloud_file_token == "awip12"


def test_level_moisture_comes_from_rh_because_level_dewpoint_is_incomplete():
    # awphys has no level DPT at all; the nest has it only at 925/850/700.
    # RH is present at all nine curated levels on both.
    parent = parent_records()
    nest = nest_records()
    for pressure_hpa in PRESSURE_LEVELS:
        find_record(parent, "RH", f"{pressure_hpa} mb", "24 hour fcst")
        find_record(nest, "RH", f"{pressure_hpa} mb", "24 hour fcst")
    with pytest.raises(MissingRecordError):
        find_record(parent, "DPT", "600 mb", "24 hour fcst")


def test_omega_exists_at_every_curated_level_in_both_products():
    parent = parent_records()
    nest = nest_records()
    assert OMEGA_LEVELS == PRESSURE_LEVELS
    for pressure_hpa in OMEGA_LEVELS:
        find_record(parent, "VVEL", f"{pressure_hpa} mb", "24 hour fcst")
        find_record(nest, "VVEL", f"{pressure_hpa} mb", "24 hour fcst")


def test_missing_records_raise_the_tolerable_error_type():
    with pytest.raises(MissingRecordError):
        find_record(parent_records(), "GUST", "surface", "25 hour fcst")
    assert issubclass(MissingRecordError, RuntimeError)


# -------------------------------------------------------------- bitmap masking


def test_bitmap_masked_gridpoints_sample_as_absent_never_9999():
    # Nest fields carry a sparse bitmap that ecCodes surfaces as the in-band
    # missingValue (9999) from the values array; a masked gridpoint must
    # publish as absence, never as a value.
    gid = eccodes.codes_grib_new_from_samples("regular_ll_sfc_grib2")
    try:
        lat0 = eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees")
        lon0 = eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees")
        ni = eccodes.codes_get(gid, "Ni")
        di = eccodes.codes_get(gid, "iDirectionIncrementInDegrees")
        missing = eccodes.codes_get(gid, "missingValue")
        eccodes.codes_set(gid, "bitmapPresent", 1)
        values = [float(index % 7) for index in range(eccodes.codes_get(gid, "numberOfValues"))]
        values[0] = missing
        eccodes.codes_set_values(gid, values)
        message = eccodes.codes_get_message(gid)
    finally:
        eccodes.codes_release(gid)

    sites = [
        {"slug": "masked", "name": "Masked", "latitude": lat0, "longitude": lon0},
        {"slug": "live", "name": "Live", "latitude": lat0, "longitude": lon0 + di * (ni // 2)},
    ]
    samples = sample_sites(message, sites, max_distance_km=1e6)
    assert samples["masked"].value is None
    assert samples["live"].value is not None
    assert samples["live"].value != 9999.0


# ----------------------------------------------------------------- catalogue


@pytest.mark.parametrize("slug", ["nam", "nam-conus-nest"])
def test_models_json_matches_the_nam_builder_configuration(slug):
    catalogue = json.loads(Path("models.json").read_text())
    entry = next(entry for entry in catalogue["models"] if entry["slug"] == slug)
    product = PRODUCTS[slug]

    assert entry["horizonHours"] == product.forecast_hours[-1]
    assert entry["sunset"] == {"date": "2026-10-06", "successor": "rrfs"}

    capabilities = entry["capabilities"]
    assert capabilities["gust"] == "instant"  # NOAA has no hour-max gust
    # Bucketed APCP differenced per step ÷ window → a window-mean rate, and
    # the documents' own semantics block says the same for both products.
    assert capabilities["precipitation"] == "windowMeanRate"
    assert SEMANTICS == {"gust": "instant", "precipitation": "windowMeanRate"}
    assert capabilities["cape"] is True and capabilities["cin"] is True
    assert capabilities["pblHeight"] is True
    assert capabilities["cloudLayers"] is True  # via awip12 for the parent
    assert capabilities["cloudProfile"] is False  # no per-level TCDC
    assert capabilities["pressureLevels"] == list(PRESSURE_LEVELS)
    assert capabilities["verticalVelocity"] == "omega"
    assert capabilities["verticalVelocityLevels"] == list(OMEGA_LEVELS)
    assert {"windGustMs", "capeJkg", "cinJkg", "pblHeightM"} <= set(OPTIONAL_SURFACE_FIELDS)

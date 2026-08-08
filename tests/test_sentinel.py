"""ECCC's "not computed" CAPE/CIN sentinels must mask to absence before any
value reaches a document — 9999 on RDPS/GDPS, -1 on the HRDPS family — with
tolerance for GRIB packing noise but never enough to swallow a real value.
"""

from windgram.sentinel import SENTINEL_TOLERANCE, is_sentinel, mask_sentinel


def test_masks_the_rdps_gdps_9999_sentinel_and_its_packing_noise():
    assert mask_sentinel(9999.0, 9999.0) is None
    # 16-bit simple packing of a 0..9999 field lands within ~0.2.
    assert mask_sentinel(9998.8, 9999.0) is None
    assert mask_sentinel(9999.2, 9999.0) is None


def test_masks_the_hrdps_minus_one_sentinel():
    assert mask_sentinel(-1.0, -1.0) is None
    assert mask_sentinel(-0.9, -1.0) is None


def test_never_masks_a_legitimate_zero_cape():
    # CAPE 0 J/kg (a stable column) is a real value, 1.0 away from the
    # HRDPS sentinel — the tolerance must stay below that gap.
    assert SENTINEL_TOLERANCE < 1.0
    assert mask_sentinel(0.0, -1.0) == 0.0


def test_passes_real_values_through_untouched():
    assert mask_sentinel(850.0, 9999.0) == 850.0
    assert mask_sentinel(-120.0, 9999.0) == -120.0  # a real CIN
    assert mask_sentinel(6380.0, -1.0) == 6380.0


def test_is_sentinel_is_the_masking_predicate():
    assert is_sentinel(9999.0, 9999.0)
    assert not is_sentinel(9997.0, 9999.0)
